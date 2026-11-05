/**
 * sopho-pi v2 · pi 插件 —— 会话之间的工具 + 给会话起标题。
 *
 * 会话树里，**每个会话都能**：
 *   spawn  开一个子会话（可选：顺手把任务交给它）
 *           —— 默认共享工作目录；**同 cwd 上还有别人在干活时会被硬拦**，
 *              除非显式给 worktree:"new"（独立 git 工作树）或 "share"（明知共享）
 *   session_new  在**指定工作目录**新开一条会话（父 = 自己）—— 「去那个目录干活」的正路。
 *           spawn 没有 cwd 参数；要换目录就用这个（宿主 `POST /sessions {parent,cwd,name}` 支持）。
 *           ⚠️ **与 spawn 同一条硬规则**：目标 cwd 已有**别的活会话** ⇒ 拒绝（除非 `share:true`）；
 *              没这道守卫，session_new 就是通向 `POST /sessions` 的第二条路、能把 spawn 的拦绕过。
 *   cwd  看**本会话的工作目录** + 那个目录的事实（git / AGENTS.md / worktree / 可写性 / 最近用过）。
 *           **只读**：pi 做不到就地改一条会话的 cwd（换目录 = 另立一条会话）——工具描述里写清了。
 *   send   给某个会话发一条消息（会唤醒它；已存档的会被复活）
 *   session_read  看某个会话的状态 + 最近几条消息
 *   push   给**自己的父会话**发一条消息（会唤醒父 —— "我干完了/我卡住了"）
 *   set_title 给**自己**起/改一个短标题（**会话树上左栏显示的就是它**）：明白了这个会话要干什么
 *           之后起一个，后来发现不准再改一次。走 `POST /sessions/{id}/title`（扩展侧拿不到
 *           pi 的「设会话名」API → 只能上报给会话基底，由它调 session.setSessionName()）。
 *
 * 还有一条**命令**：
 *   /cwd  人（TUI / 网页）看 / 换目录：无参 → 当前 cwd + 最近用过；`/cwd <path>` → 在 path **新开一条会话**。
 *         它的输出走 `pi.sendMessage` → 会话基底把它当 `extras` 吐给网页（见 base-logic 的 readMessages）。
 *
 * 开场告知（**就这一处**：promptGuidelines + 工具描述，每个会话的系统提示词里都有）：
 *   「明白了这个会话要干什么 → 用 set_title 给自己起个 ≤20 字的短标题；不准了就再改一次。」
 *   —— 别去找什么 prompts/ 文件（v1 的 defaults/*.md 已经删了）。工具常驻，所以这句话对**每个**
 *   会话都生效（包括用户自己在前端开的新会话，不只是 spawn 出来的孩子）。
 *
 * 插件只跟**会话基底**（进程 A）说话，不碰数据文件。
 * 基底地址：SOPHO_BASE_URL 或 http://127.0.0.1:${SOPHO_BASE_PORT:-7331}
 *
 * **改完这个文件不用手动让会话吃新版**：基底盯着它 —— 内容变了**且相对 git 干净（= 已提交）**
 * 就自动 reload 池里的会话（空闲的立刻；正在跑的等它这一轮结束，绝不打断）。
 * 观测：`GET /plugin-watch`。实现：server/base-logic.mjs 的「插件改动自动生效」。
 * 反过来也成立：**没提交的半成品永远不会生效**；就算提交了一份加载不了的（语法错 / 坏 import），
 * 基底会先预检 —— 失败就一个会话都不动、旧版照跑，这一版也不再重试（等文件再变）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASE = (process.env.SOPHO_BASE_URL ?? `http://127.0.0.1:${process.env.SOPHO_BASE_PORT ?? 7331}`).replace(/\/+$/, "");

const post = async (p: string, body?: unknown) => {
	try {
		const r = await fetch(BASE + p, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return (await r.json().catch(() => ({}))) as Record<string, unknown>;
	} catch (e) {
		return { error: `连不上会话基底（${BASE}）：${(e as Error)?.message ?? e}` };
	}
};
const get = async (p: string) => {
	try {
		const r = await fetch(BASE + p);
		return (await r.json().catch(() => ({}))) as Record<string, unknown>;
	} catch (e) {
		return { error: `连不上会话基底（${BASE}）：${(e as Error)?.message ?? e}` };
	}
};

/** 会话文件名 → uuid（会话 id）。 */
const idOf = (file?: string) => file?.match(/_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1] ?? null;

/** 只读会话文件头，拿 parentSession（我的父会话文件）。 */
function parentFile(file: string): string | null {
	try {
		const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
		const h = JSON.parse(first);
		return typeof h?.parentSession === "string" && h.parentSession ? h.parentSession : null;
	} catch {
		return null;
	}
}

// ─────────────────────── 内置 bash 的默认超时（**安全网**，不是协议变更） ───────────────────────
// 起因：pi 的 bash 工具**默认没有超时**（内置描述原文「no default timeout」）。模型不传 `timeout`
// 那条命令就永远不设上限 —— 实际吃过两次：一条 `grep -r` 从整棵用户目录开始搜、一条 254 个文件
// 每个起一个进程的质量扫描，分别卡了 14 分钟和 32 分钟以上，会话在 `streaming: true` 里出不来、
// 界面不显示、收不了新消息，人只能从外面精确杀进程。
//
// 做法：走 pi 官方的 `tool_call` 钩子 —— `event.input` 是**可变**的，官方保证「改它就会影响
// 真正执行的那次调用」（pi 自己的 `docs/extensions.md` 里 `#### tool_call` 节）。内置 bash **仍然是内置那份**
// （不覆盖、不重写执行逻辑 —— 我们只补一个缺省参数）；`bash` 也没进 `registerTool` 的表里。
//
// ⚠️ **诚实缺口**：这条改不了**模型看到的工具描述**（内置 schema 里那句「optional, no default
// timeout」还在）。所以模型可能仍以为「没超时」，也可能因此不给显式 timeout。默认值只是
// 「最坏情况有个上限」的安全网，别把它当成「协议上已经声明了超时」。
//
// 取值理由 1800s（30 分钟）：
//  · 上面的「误杀」代价高于「卡久一点」—— 这台机器上真有十几分钟的长活（ARM64 引擎基线构建、
//    真机性能采集）。30 分钟 ≈ 那条天花板（~20 分钟）的 1.5 倍，留出余量。
//  · 两次事故的命令都是**不会自己结束**的（人是等不下去才杀的），所以任何有限上限都能兜住它们。
//  · 于是上限的职责只是「不无限」，不是「快速失败」；要快速失败得靠模型自己按命令性质传 timeout。
const DEFAULT_BASH_TIMEOUT_S = 1800;

/** 读一次默认值：`SOPHO_BASH_TIMEOUT`（秒）> 内置 1800。
 *  `0` / `off` / `none` / `false` = **显式关掉**这个安全网（回到今天「没超时」的行为）。
 *  坏值（非数字 / 负数）→ 退回内置默认，**绝不抛** —— 这个 handler 每次工具调用都跑，
 *  它一抛就成了「把该工具 block 掉」（官方语义：tool_call 的异常 = fail-safe 拦下该调用）。 */
function bashTimeoutDefault(): number | null {
	const raw = process.env.SOPHO_BASH_TIMEOUT?.trim();
	if (!raw) return DEFAULT_BASH_TIMEOUT_S;
	if (/^(0|off|none|false|no)$/i.test(raw)) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_BASH_TIMEOUT_S;
}

const selfFile = (ctx?: ExtensionContext) => ctx?.sessionManager?.getSessionFile?.() ?? null;
const selfId = (ctx?: ExtensionContext) => idOf(selfFile(ctx) ?? undefined);

const ok = (text: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text }],
	details,
});
const short = (s: unknown, n: number) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length <= n ? t : t.slice(0, n - 1) + "…";
};

// ─────────────────────── 工作区（spawn 的默认共享 + 硬拦） ───────────────────────
// 事实从基底 GET /env 拿（那个 cwd 的 git 状态 + 还有哪些会话住在这里）。
// 这里只做**策略**：排除自己/已归档的，然后拦或放行。

type EnvSession = {
	id: string;
	name: string | null;
	streaming: boolean;
	cwd: string;
	archived: boolean;
	hot: boolean;
	file: string;
	lastActivity: number | null;
};
type Env = {
	cwd: string;
	git: null | { repo: string; branch: string | null; dirty: number; head: string | null; recent: unknown[] };
	sessions: EnvSession[];
};

/** 独占一个工作树的义务**推不出来**（路径能推、脏不脏能从 git 推），所以落一份 sidecar。 */
const ASSIST_HOME = process.env.ASSIST_HOME ?? path.join(os.homedir(), ".pi/profiles/assistant");
const WS_FILE = path.join(ASSIST_HOME, "workspaces.json");
function recordWorkspace(wtPath: string, rec: Record<string, unknown>) {
	let all: Record<string, unknown> = {};
	try {
		all = JSON.parse(fs.readFileSync(WS_FILE, "utf8"));
	} catch {
		all = {};
	}
	all[wtPath] = rec;
	try {
		fs.mkdirSync(ASSIST_HOME, { recursive: true });
		fs.writeFileSync(WS_FILE, JSON.stringify(all, null, 1));
	} catch {
		/* sidecar 写不进去不影响干活 */
	}
}

// ─────────────────────── cwd：「最近用过哪些目录」= 服务端那一本账 ───────────────────────
// 账只有一处、一个写者：`$ASSIST_HOME/cwd-recents.json`，由**会话基底**（`server/base-logic.mjs`）
// 在建会话时（`POST /sessions {cwd}`）原子写入。这里**不自己读写那个文件** —— 走 `GET /cwd-recents`，
// 这样 agent（本插件的 `cwd` 工具 / `/cwd` 补全）与网页（新建会话下拉）看到的是**同一份**事实。
// 为什么不直接读文件：前端（浏览器）读不到文件（B 只做静态 + 反代），API 是两边都能走的那一条；
// 插件跟着走 API，就不会出现「两套推法、结果不一致」。
async function recentsOf(limit = 12): Promise<{ list: Array<{ path: string; count: number; at: number }>; error: string | null }> {
	const r = (await get(`/cwd-recents`)) as { recents?: Array<{ path?: string; count?: number; at?: number }>; error?: string };
	if (r?.error) return { list: [], error: String(r.error) };
	const list = Array.isArray(r?.recents)
		? r.recents
				.map((x) => ({ path: String(x?.path ?? ""), count: Number(x?.count ?? 0) || 0, at: Number(x?.at ?? 0) || 0 }))
				.filter((x) => x.path)
				.slice(0, limit)
		: [];
	return { list, error: null };
}

/** 用户/模型给的目录串 → 绝对路径：支持 `~`、相对路径（相对 base）。 */
function resolveCwd(input: string, base: string): string {
	let s = String(input ?? "").trim();
	if (!s) return "";
	if (s === "~") s = os.homedir();
	else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
	return path.resolve(base, s);
}

/** 一个目录的**事实**（`cwd` 工具与 `/cwd` 命令共用同一份推导 —— 不各写一套）。
 *  只读、不抛：拿不到的项如实标 null/error，绝不猜。 */
function dirFacts(dir: string) {
	const out: {
		path: string;
		exists: boolean;
		isDir: boolean;
		writable: boolean;
		git: null | { repo: string; branch: string; dirty: number };
		agentsMd: string | null;
		worktree: null | { gitDir: string; commonDir: string; repo: string; root: string };
		error: string | null;
	} = { path: dir, exists: false, isDir: false, writable: false, git: null, agentsMd: null, worktree: null, error: null };
	let st: fs.Stats;
	try {
		st = fs.statSync(dir);
	} catch (e) {
		out.error = errMsg(e);
		return out;
	}
	out.exists = true;
	out.isDir = st.isDirectory();
	if (!out.isDir) return out;
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		out.writable = true;
	} catch {
		out.writable = false;
	}
	const agents = path.join(dir, "AGENTS.md");
	if (fs.existsSync(agents)) out.agentsMd = agents;
	try {
		const repo = gitRun(dir, ["rev-parse", "--show-toplevel"]).trim();
		const branch = gitRun(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		const dirty = gitRun(dir, ["status", "--porcelain"])
			.split("\n")
			.filter((l) => l.trim()).length;
		out.git = { repo, branch, dirty };
		// worktree 的判据：`--git-dir` ≠ `--git-common-dir`（主树里两者相同；worktree 的 git-dir 指向
		// `.git/worktrees/<n>`）。用 realpath 比，避免相对路径 / 软链造成的假阳性。
		try {
			const gd = path.resolve(dir, gitRun(dir, ["rev-parse", "--git-dir"]).trim());
			const cd = path.resolve(dir, gitRun(dir, ["rev-parse", "--git-common-dir"]).trim());
			if (fs.realpathSync(gd) !== fs.realpathSync(cd)) {
				// `git rev-parse --show-toplevel` 在 worktree 里给的是 **worktree 自己**的根（不是主仓库）；
				// 主仓库要从 `--git-common-dir` 推（那就是主仓库的 `.git`）—— 别把两者混成一个字段骗人。
				out.worktree = { gitDir: gd, commonDir: cd, repo: path.dirname(cd), root: repo };
			}
		} catch {
			/* 判不出来就不说（不是“不是 worktree”，是“不知道”） */
		}
	} catch {
		out.git = null; // 不是 git 仓库（git 自己会以非 0 退出）
	}
	return out;
}

/** 把 `dirFacts` 说成人话（`cwd` 工具与 `/cwd` 命令共用）。 */
function factsText(f: ReturnType<typeof dirFacts>): string {
	const L: string[] = [];
	if (!f.exists) return `  · 不存在（${f.error ?? "stat 失败"}）`;
	if (!f.isDir) return "  · 存在，但**不是目录**（是个文件）";
	L.push(`  · 存在：是（目录）    可写：${f.writable ? "是" : "**否**"}`);
	L.push(
		f.git
			? `  · git 仓库：是（repo=${f.git.repo}  branch=${f.git.branch}  未提交=${f.git.dirty}）`
			: "  · git 仓库：否（不在任何 git 工作树里）",
	);
	L.push(f.agentsMd ? `  · AGENTS.md：有（${f.agentsMd}）` : "  · AGENTS.md：无");
	L.push(f.worktree ? `  · worktree：是（主仓库=${f.worktree.repo}，worktree 根=${f.worktree.root}，git-dir=${f.worktree.gitDir}）` : "  · worktree：否（就是主工作树，或不是 git 仓库）");
	return L.join("\n");
}

/** 名字/任务 → 适合做目录名和分支名的 slug（中文等非 ASCII 会被压掉，补随机后缀保证唯一）。 */
const slugify = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24) || "worktree";

/** 只跑 git（同步、短命）；失败把 stderr 末尾带出来。 */
function gitRun(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const errMsg = (e: unknown) => {
	const x = e as { stderr?: string; message?: string };
	return String(x?.stderr ?? x?.message ?? e)
		.trim()
		.split("\n")
		.filter(Boolean)
		.slice(-2)
		.join(" | ");
};

const nameOfSession = (s: EnvSession) => short(s.name ?? "(unnamed)", 40);

/** 拦的时候要**列出是谁**，否则模型不知道该选哪条。
 *  ⚠️ id 给**完整 uuid**（原来给前 8 位）：这句是给模型读的，模型可能照着它去 `send` /
 *  `session_read` —— 而前 8 位**不保证唯一**（实测两个会话前 8 位相同）→ 模型会拿到「没有这个会话」。 */
const conflictLine = (s: EnvSession, dirty: number | null) => {
	const state = s.streaming ? "running" : "idle";
	const d = dirty == null ? "" : `; ${dirty} uncommitted file${dirty === 1 ? "" : "s"}`;
	return `${s.id} 「${nameOfSession(s)}」 (${state}${d})`;
};

/** 开场告知：由 spawn 直接拼进子会话**第一条 task 文本**（不新增机制）。 */
const openingForWorktree = (wtPath: string, repo: string, branch: string) =>
	`【工作区告知】你在**独立的工作树** \`${wtPath}\`（分支 \`${branch}\`）；主树（仓库）是 \`${repo}\`。\n` +
	`**别去动主树** —— 主树可能有别的会话正在改。你的读写都只在这个工作树里做。\n` +
	`干完用 push 回报父会话（合并由父会话做）。`;

const openingForShared = (cwd: string) =>
	`【工作区告知】你和别的会话**共用同一个目录** \`${cwd}\`（共享工作树）。\n` +
	`改文件前先确认那不是别人正在动的；有冲突就停下来用 push 问父会话。\n` +
	`干完用 push 回报父会话。`;

export default function (pi: ExtensionAPI) {
	// 这个 runtime（= 这条会话）的工作目录。命令的 `getArgumentCompletions` **拿不到 ctx**
	//（pi 的签名就是 `(argumentPrefix) => …`），所以只能用这个缓存；在 session_start /
	// before_agent_start 里从 ctx.cwd 刷新。**闭包变量**（不是模块级）：同一份插件模块可能被同 cwd 的
	// 多条会话复用，模块级状态会串会话。
	let myCwd = process.cwd();

	// ─────────────────────── 只报事实：我这一轮落定了 ───────────────────────
	// `agent_settled` 是 pi 官方的「这一轮不会再自己跑下去了」（docs：Use agent_settled for status
	// integrations that need to know Pi will not continue running automatically）—— 精确、零延迟。
	// 插件**不做任何判定**：不读登记表、不判该不该唤醒、不管一次性 —— 只把自己 settle 了这个事实
	// POST 给 A（会话基底），剩下全是 A 逻辑层的策略（server/base-logic.mjs 的登记表）。
	// 事实来自 runtime，策略放能热重载的层。
	// 不 await：A 慢/挂了都不该拖住孩子的收尾；post() 自己吞错，不会抛。
	pi.on("agent_settled", (_ev, ctx) => {
		const id = selfId(ctx);
		if (id) void post(`/sessions/${id}/settled`, { source: "agent_settled" });
	});

	// ─────────────────────── 只报事实：我这个会话的名字被改了 ───────────────────────
	// `session_info_changed` 是 pi 官方的「显示名刚变了」（TUI 的 `/name`、我们自己的
	// `setSessionName()`、以后的 RPC 都走它）。插件**不做任何判定** —— 只上报。
	// A 那边拿它做两件事：对账（名字跟它账上那条不一致 = **用户手动改的** → 记 manual，此后不覆盖）
	// + 广播（前端树上**不刷新页面**就跟着变）。
	// ⚠️ 我们自己调 setSessionName 时它也会走这里：A 对账时看到名字跟账上**一致** → 不会误判。
	pi.on("session_info_changed", (ev, ctx) => {
		const id = selfId(ctx);
		if (id) void post(`/sessions/${id}/title-changed`, { name: ev.name ?? null });
	});

	// ─────────────────────── 给内置 bash 补默认超时 ───────────────────────
	// 事实/取值的理由全在上面那段注释里。只补**缺省**：模型显式传了 timeout 就一字不动
	// （含 0 / 负数 —— 那是显式意图，交给内置校验去报错）。别的工具（read / edit / …）不碰。
	// powershell **也不碰**：本部署的会话工具表里根本没有它（见提交信息），扩大范围没收益。
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.timeout != null) return; // 模型自己给的 —— 尊重它
		const t = bashTimeoutDefault();
		if (t != null) event.input.timeout = t;
	});

	pi.registerTool({
		name: "spawn",
		label: "Spawn Session",
		description:
			"Spawn a child session that works in parallel (and can spawn further). Parent is recorded as you. " +
			"Pass task to hand it work now, or omit it and send later; returns the child id. " +
			"Working directory: the child shares YOUR cwd by default. If ANOTHER live session is already working in that " +
			"same cwd, spawn is HARD-BLOCKED (nothing is created; you get a workspace-conflict error listing who is there), " +
			"because two agents editing one tree overwrite each other. To get past the block, pass worktree: " +
			"'new' = run the child in an isolated git worktree with its own branch under <repo>/../.sopho-wt/ " +
			"(only when your cwd is a git repo), or 'share' = run it in your cwd anyway and accept the shared tree. " +
			"Omit worktree only when nobody else is in your cwd. " +
			"notify (default true): register 'tell me when this child has really STOPPED' with the session base — " +
			"the framework wakes YOU once the child has settled AND then stayed quiet (default 20s with no further runs), " +
			"not merely when one turn ends (a multi-turn child settles after every turn, so turn-end would wake you far too early). " +
			"Set notify:false for exploratory / fire-and-forget children.",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "Task/prompt for the child; omit to just create it" })),
			name: Type.Optional(Type.String({ description: "Display name for the child session (optional)" })),
			worktree: Type.Optional(
				Type.Union([Type.Literal("share"), Type.Literal("new")], {
					description:
						"'new' = isolated git worktree (own branch) under <repo>/../.sopho-wt/, child runs there and is told not to touch the main tree; " +
						"'share' = run the child in your cwd anyway. Omit only when no other session is working in your cwd (otherwise spawn is blocked).",
				}),
			),
			notify: Type.Optional(
				Type.Boolean({
					description:
						"默认 true：把这个子会话登记到会话基底的「它**真的停下来了**」表里 —— 它最后落定之后" +
						"**持续静默一段时间（默认 20s）都没再开跑**，框架才唤醒你（不依赖它主动 push）。" +
						"**不是**每跑完一轮就叫：多轮的孩子每轮都落定一次，拿轮末当「结束了」会在它刚开干时就把你拉醒。" +
						"false = 不登记（探索性 / fire-and-forget）。",
				}),
			),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const me = selfId(ctx);
			const myFile = selfFile(ctx) ?? undefined;
			const myCwd = ctx?.cwd ?? process.cwd();
			const wt = params.worktree;
			const notify = params.notify !== false; // 默认登记

			// ── worktree:"new" —— 只在 git repo 里可用；**不静默降级成 share** ──
			if (wt === "new") {
				const env = (await get(`/env?cwd=${encodeURIComponent(myCwd)}`)) as unknown as Env & { error?: unknown };
				if (env?.error) return ok(String(env.error), { error: env.error });
				const repo = env?.git?.repo;
				if (!repo) {
					const detail = `${myCwd} is not a git repository, so worktree: 'new' is unavailable. It was NOT downgraded to a shared tree; nothing was created. Use worktree: 'share' if you accept sharing ${myCwd}, or run the child in a repo.`;
					return ok(`No worktree created (not-a-repo): ${detail}`, {
						error: { code: "not-a-repo" },
						status: 400,
						detail,
					});
				}

				const slug = `${slugify(params.name ?? params.task ?? "worktree")}-${Math.random().toString(36).slice(2, 6)}`;
				const branch = `wt/${slug}`;
				const wtPath = path.resolve(repo, "..", ".sopho-wt", slug);
				try {
					fs.mkdirSync(path.dirname(wtPath), { recursive: true });
					gitRun(repo, ["worktree", "add", wtPath, "-b", branch]);
				} catch (e) {
					const detail = `git worktree add failed for ${wtPath} (branch ${branch}): ${errMsg(e)}`;
					return ok(`No worktree created: ${detail}`, { error: { code: "worktree-failed" }, status: 500, detail });
				}

				const child = await post("/sessions", { parent: me ?? undefined, cwd: wtPath, name: params.name, notify });
				if (child.error) {
					// 会话没建成就把工作树收掉，别留垃圾
					try {
						gitRun(repo, ["worktree", "remove", "--force", wtPath]);
					} catch {
						/* 尽力而为 */
					}
					try {
						gitRun(repo, ["branch", "-D", branch]);
					} catch {
						/* 尽力而为 */
					}
					return ok(String(child.error), { error: child.error });
				}
				const cid = String(child.id ?? "");
				recordWorkspace(wtPath, { repo, branch, for: cid, createdAt: Date.now() });

				const opening = openingForWorktree(wtPath, repo, branch);
				await post(`/sessions/${cid}/message`, {
					text: params.task?.trim() ? `${opening}\n\n${params.task}` : opening,
					notify,
					notifyTo: me ?? undefined,
				});

				const text =
					`Spawned ${cid} in a new git worktree. workspace.kind=worktree cwd=${wtPath} branch=${branch} repo=${repo}. ` +
					`The child was told it owns that tree and must not touch the main tree, and to report back via push (you do the merge).`;
				return ok(text, { id: cid, workspace: { kind: "worktree", cwd: wtPath, repo, branch } });
			}

			// ── 默认（没给 worktree）—— 先问环境；同 cwd 有别人就**硬拦** ──
			if (wt !== "share") {
				const env = (await get(`/env?cwd=${encodeURIComponent(myCwd)}`)) as unknown as Env;
				if (env && !env.error) {
					const others = (env.sessions ?? []).filter((s) => s.id !== me && s.file !== myFile && !s.archived);
					if (others.length) {
						const dirty = env.git ? env.git.dirty : null;
						const lines = others.map((s) => `  · ${conflictLine(s, dirty)}`);
						const detail = `another session is already working in ${myCwd}: ${others.map((s) => conflictLine(s, dirty)).join("; ")}`;
						const options = [{ worktree: "new" }, { worktree: "share" }];
						const text =
							`Blocked by the workspace guard (workspace-conflict): another session is already working in ${myCwd}.\n` +
							`${lines.join("\n")}\n` +
							`Two agents editing one tree overwrite each other, so spawn created NOTHING. Call spawn again with one of:\n` +
							`  · worktree: 'new'   -> isolated git worktree + own branch under ${env.git ? `${env.git.repo}/../.sopho-wt/` : "<repo>/../.sopho-wt/"} (git repo only)\n` +
							`  · worktree: 'share' -> run in ${myCwd} anyway and accept the shared tree`;
						return ok(text, { error: { code: "workspace-conflict" }, status: 409, detail, options });
					}
				}
			}

			// ── 放行：默认 / share ──
			const child = await post("/sessions", { parent: me ?? undefined, cwd: wt === "share" ? myCwd : undefined, name: params.name, notify });
			if (child.error) return ok(String(child.error), { error: child.error });
			const cid = String(child.id ?? "");
			const opening = wt === "share" ? openingForShared(myCwd) : "";
			if (params.task?.trim() || opening) {
				const body = [opening, params.task].filter((x) => x && String(x).trim()).join("\n\n");
				await post(`/sessions/${cid}/message`, { text: body, notify, notifyTo: me ?? undefined });
			}
			const text =
				wt === "share"
					? `Spawned ${cid} in the shared tree ${myCwd}. workspace.kind=shared — the child was told it shares this directory with other sessions.`
					: `Spawned ${cid} in ${myCwd}${params.task ? " and the task was sent" : ""}.`;
			return ok(text, { id: cid, workspace: { kind: "shared", cwd: myCwd } });
		},
	});

	pi.registerTool({
		name: "send",
		label: "Send To Session",
		description:
			"给某个会话发一条消息（会话 id 见左栏 / spawn 的返回）。**会唤醒它**；" +
			"如果它已存档，会被复活。与 push 的区别：send 要显式给 id，push 是发给自己的父。" +
			"notify（默认 true）：登记「它**真的停下来了**叫我」—— 它最后落定后**持续静默一段时间" +
			"（默认 20s）没再开跑**，框架才唤醒你（不依赖它主动 push）；**不是**每跑完一轮就叫。" +
			"探索性的一次性消息可以 notify:false。",
		parameters: Type.Object({
			id: Type.String({
				description:
					"目标会话的**完整 id**（36 字符 uuid —— 直接从 spawn / session_read / push 的返回值里复制那一串，或从会话树上拿）。" +
					"**别只给片段**：前缀**不保证唯一**（pi 的 uuid 前 8 位是时间戳，同一毫秒建的两个会话前 8 位会完全相同），" +
					"末 8 位更是**永远**解析不到（解析只看前缀）。给片段的结果就是「没有这个会话」。",
			}),
			text: Type.String({ description: "要发的内容" }),
			notify: Type.Optional(
				Type.Boolean({
					description:
						"默认 true：登记「它真的停下来了叫我」（落定后静默一段没再动才算停；框架保证唤醒你，不依赖它 push）。" +
						"false = 不登记。",
				}),
			),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const me = selfId(ctx);
			const notify = params.notify !== false; // 默认登记
			const r = await post(`/sessions/${expand(params.id)}/message`, {
				text: params.text,
				notify,
				notifyTo: me ?? undefined,
			});
			if (r.error) return ok(String(r.error), { error: true });
			const reg = r.notify as { registered?: boolean } | undefined;
			// 回显**基底解析后的完整 id**（不是调用方给的串）：调用方（模型）会把这个回显当成以后要用的 id。
			const rid = String((r.status as { id?: string } | undefined)?.id ?? (r.id as string | undefined) ?? expand(params.id));
			return ok(`已发给 ${rid}。${reg?.registered ? "已登记：它这一轮结束会唤醒我。" : "（未登记唤醒）"}`, {
				id: rid,
				status: r.status,
				notify: reg ?? null,
			});
		},
	});

	pi.registerTool({
		name: "session_read",
		label: "Read Session",
		description:
			"看某个会话的状态（在跑吗 / 冷不冷）和最近几条消息。用来查子会话干到哪了。" +
			"状态里带 pluginStale —— **true 就是「这个会话还在跑改之前的旧插件」**（扩展是建 runtime 时" +
			"从磁盘加载的）：那就别拿它的行为当新版的证据 —— 它多半正在等自己这一轮跑完再吃新版" +
			"（基底会自动重载插件，见 GET /plugin-watch）。",
		parameters: Type.Object({
			id: Type.String({
				description:
					"目标会话的**完整 id**（36 字符 uuid —— 从 spawn / push / 唤醒提示里的 `#id` 复制那一整串）。" +
					"**别只给片段**：前缀**不保证唯一**（同毫秒建的两个会话前 8 位会相同），末 8 位**永远**解析不到。",
			}),
			lines: Type.Optional(Type.Number({ description: "看最近几条消息（默认 4）" })),
		}),
		async execute(_id, params) {
			const id = expand(params.id);
			const st = await get(`/sessions/${id}`);
			if (st.error) return ok(String(st.error), { error: true });
			// 基底回的是**它解析后的完整 id** → 后面一律用它。返回值里绝不出现「调用方给的片段」：
			// 调用方（模型）会把回显当成下一次要用的 id，回显片段等于把片段传下去。
			const rid = String(st.id ?? id);
			const ms = await get(`/sessions/${rid}/messages`);
			const list = Array.isArray(ms.messages) ? (ms.messages as { role: string; text: string }[]) : [];
			const n = Math.max(1, Math.min(20, params.lines ?? 4));
			const tail = list.slice(-n).map((m) => `  [${m.role}] ${short(m.text, 200)}`);
			const stale = st.pluginStale === true;
			const staleLine = stale
				? `⚠️ pluginStale=true —— 这个会话跑的是**旧插件**（建 runtime 时加载的 hash=${st.pluginHashAtLoad ?? "?"}，磁盘上是 ${st.pluginNowHash ?? "?"}）。\n` +
					`   基底会**自动重载**插件：pi-extensions/ 的改动**提交**之后，空闲的会话立刻吃新版，正在跑的等它这一轮结束再吃。\n` +
					`   所以 stale=true 通常只在「刚提交、这轮还没跑完」或「有人手动把文件改成没提交的半成品」时出现。要立刻：**POST /sessions/${rid}/reload**\n` +
					`   （或 bin/restart-base.sh）。注意**新建一条会话不一定够** —— pi 按 cwd 在进程内缓存扩展模块，同 cwd 的新会话会复用旧工厂。\n` +
					`   **POST /reload-code 只换 base-logic，不管插件这一层。**\n`
				: "";
			return ok(
				`#${rid}  hot=${st.hot ?? false} streaming=${st.streaming ?? false} archived=${st.archived ?? "?"} 共 ${list.length} 条` +
					`  pluginStale=${st.pluginStale === true ? "true" : st.pluginStale === false ? "false" : "?"}\n` +
					staleLine +
					(tail.length ? tail.join("\n") : "  （还没有文本消息）"),
				{ id: rid, hot: st.hot, streaming: st.streaming, pluginStale: st.pluginStale ?? null, pluginMtimeMs: st.pluginMtimeMs ?? null },
			);
		},
	});

	// ─────────────────────── cwd（**只读**）：我在哪个目录、那个目录是什么 ───────────────────────
	// 人类原话：「让用户和 agent 都能看/操作 cwd」。这是「看」的那一半（agent 侧）。
	// **它不给「改 cwd」** —— pi 做不到就地改一条会话的 cwd（SDK 的口径：换 cwd = 替换当前会话、
	// 重建 cwd 绑定的 runtime 状态，见 pi 的 `docs/sdk.md:118`；而且 pi 按 cwd 分目录存会话）。所以
	// 工具描述里**明说做不到**，免得模型以为它能给这条会话搬家；要换目录就用 `session_new`。
	pi.registerTool({
		name: "cwd",
		label: "Show Working Directory",
		description:
			"看**本会话的工作目录**（cwd）以及这个目录的事实：是否存在/可写、是不是 git 仓库（分支 / 未提交数）、" +
			"有没有 AGENTS.md、是不是一个 git worktree、这个目录里还有哪些活会话，以及**最近用过 / 绑定过的目录**。\n" +
			"⚠️ **这个工具只读** —— 它**不能改**本会话的 cwd。pi 不支持就地改一条会话的工作目录：换目录等于" +
			"**另起一条会话**（会话文件按 cwd 分目录存放、runtime 的 cwd 绑定在建立那一刻就定了）。\n" +
			"想在别的目录干活：用 `session_new`（在指定目录新开一条会话，自己当父）。",
		promptSnippet: "看本会话的工作目录（cwd）+ 它在哪 / 是不是 git / 有没有 AGENTS.md / 最近用过哪些目录（只读）",
		promptGuidelines: [
			"Use cwd when you need to know which directory this session works in (or which directories were used recently). It is read-only: it cannot change this session's cwd — to work in another directory, use session_new.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, _sig, _upd, ctx) {
			const me = selfId(ctx);
			const here = ctx?.cwd ?? process.cwd();
			const f = dirFacts(here);
			const env = (await get(`/env?cwd=${encodeURIComponent(here)}`)) as unknown as Env & { error?: unknown };
			const others = (env && !env.error ? (env.sessions ?? []) : []).filter((s) => s.id !== me && !s.archived);
			const hereSessions = others.length
				? others.map((s) => `    · ${s.id} 「${nameOfSession(s)}」 ${s.streaming ? "running" : "idle"}`).join("\n")
				: "    · （只看到本会话）";
			const rec = await recentsOf(12);
			const recText = rec.error
				? `  ⚠️ 账读不了：${rec.error}`
				: rec.list.length
					? rec.list.map((r) => `  · ${r.path}（用过 ${r.count} 次${r.path === here ? "，就是当前目录" : ""}）`).join("\n")
					: "  （还没有记账 —— 账在 `$ASSIST_HOME/cwd-recents.json`，建会话时由基底原子写入）";
			const text =
				`本会话的工作目录（cwd）：${here}\n` +
				factsText(f) +
				`\n  · 这个目录里的活会话：\n${hereSessions}\n` +
				`最近用过 / 绑定过的目录（GET /cwd-recents）：\n${recText}\n\n` +
				`⚠️ **这不给你改 cwd 的能力** —— pi 不支持就地改一条会话的工作目录（换目录 = 另起一条会话；` +
				`会话文件按 cwd 分目录存、runtime 建立时就绑定了 cwd）。要换目录用 \`session_new\`（或人用 \`/cwd <path>\`）。`;
			return ok(text, { cwd: here, facts: f, recent: rec.list, recentError: rec.error, sessions: others.map((s) => s.id) });
		},
	});

	// ─────────────────────── session_new：去别的目录干活 = 新开一条会话 ───────────────────────
	// 这是「操作 cwd」的那一半（agent 侧）：宿主 `POST /sessions {parent, cwd, name}` 早就支持
	// （`create({parent, cwd, name})`，spawn 就走它），只是以前没有一个**带 cwd 的工具**够得着 ——
	// spawn 的参数只有 task / name / worktree / notify，所以想换目录起会话只能手搓 HTTP
	// （内部分析也点了这条）。
	//
	// ⚠️ **与 spawn 同一条硬规则**：目标目录里已经有**别的活会话** ⇒ **拒绝**，除非 `share:true`。
	// 理由就是 spawn 那条（踩过血的）：两个 agent 编辑同一棵树会互相覆盖。spawn 一直有这个守卫，
	// 而 session_new 是通向同一个 `POST /sessions` 的第二条路 —— 没有守卫就能把它绕过去。
	// 判据与 spawn 完全一致：`/env?cwd=` 回的那批里，排除自己（id / 会话文件两重比对）与已归档的。
	// ⚠️ **只管 agent 这条路**：人从网页「＋ 新会话」建会话不经过这里（那是人的显式动作，既有行为，不动）。
	pi.registerTool({
		name: "session_new",
		label: "New Session In Directory",
		description:
			"在**指定的工作目录**新开一条会话，**把当前会话记为它的父**。这是「去那个目录干活」的正路。\n" +
			"⚠️ 这**不是**给当前会话搬家 —— 当前会话的 cwd 一字不变；新会话是**独立的另一条**" +
			"（自己的工作目录、自己的 runtime），父子关系只用来让它能用 `push` 回报你、你也能 `send` 它。\n" +
			"⚠️ **工作区守卫（与 spawn 同一条硬规则）**：目标 cwd 里已经有**别的活会话**时，本工具**拒绝、什么都不建**" +
			"（两个 agent 编辑同一棵树会互相覆盖），返回值里会列出是谁。明知要共享同一棵树时才传 `share:true` 放行；" +
			"否则换一个目录，或用 `spawn` 的 `worktree:\"new\"` 开一棵独立工作树。\n" +
			"cwd 支持绝对路径 / 相对当前目录 / `~`。给了 firstMessage 就立刻发过去（并登记「它停下来叫我」）。",
		parameters: Type.Object({
			cwd: Type.String({ description: "新会话的工作目录（绝对路径 / 相对当前目录 / ~ 开头）" }),
			name: Type.Optional(Type.String({ description: "新会话的显示名（可选）" })),
			firstMessage: Type.Optional(Type.String({ description: "建好就立刻发过去的第一条消息（可选）" })),
			share: Type.Optional(
				Type.Boolean({
					description:
						"默认 false。目标 cwd 已有别的活会话时，守卫会拒绝；显式 true = 明知会共享同一棵树、接受两个 agent 并行编辑它（仍有互相覆盖的风险）。",
				}),
			),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const me = selfId(ctx);
			const myFile = selfFile(ctx) ?? undefined;
			const base = ctx?.cwd ?? process.cwd();
			const abs = resolveCwd(params.cwd, base);
			if (!abs) return ok("cwd 不能为空。", { error: { code: "bad-cwd" }, status: 400 });
			const f = dirFacts(abs);
			if (!f.exists || !f.isDir) {
				const why = f.exists ? "存在，但**不是目录**（是个文件）" : `不存在（${f.error ?? "stat 失败"}）`;
				return ok(
					`**没建会话**：${abs} ${why}。\n换个存在的目录；这个工具**不会**替你 mkdir（建目录是另一件事，别偷偷做）。`,
					{ error: { code: "no-such-dir" }, status: 400, cwd: abs },
				);
			}

			// ── 工作区守卫（与 spawn 同一条规则）──
			if (params.share !== true) {
				const env = (await get(`/env?cwd=${encodeURIComponent(abs)}`)) as unknown as Env & { error?: unknown };
				if (env && !env.error) {
					const others = (env.sessions ?? []).filter((s) => s.id !== me && s.file !== myFile && !s.archived);
					if (others.length) {
						const dirty = env.git ? env.git.dirty : null;
						const lines = others.map((s) => `  · ${conflictLine(s, dirty)}`);
						const detail = `another session is already working in ${abs}: ${others.map((s) => conflictLine(s, dirty)).join("; ")}`;
						const text =
							`Blocked by the workspace guard (workspace-conflict): another session is already working in ${abs}.\n` +
							`${lines.join("\n")}\n` +
							`Two agents editing one tree overwrite each other, so session_new created NOTHING.\n` +
							`要继续，三选一：\n` +
							`  · 明知要共享同一棵树：再调一次并传 \`share: true\`（接受两个 agent 并行编辑 ${abs}）\n` +
							`  · 换一个目录（另一个 cwd）\n` +
							`  · 要独立工作树：用 \`spawn\` 的 \`worktree: "new"\`（仅 git 仓库，给你自己的分支）`;
						return ok(text, {
							error: { code: "workspace-conflict" },
							status: 409,
							detail,
							cwd: abs,
							conflict: others.map((s) => s.id),
							options: [{ share: true }, { cwd: "<另一个目录>" }, { spawn: { worktree: "new" } }],
						});
					}
				}
			}

			const created = await post("/sessions", { parent: me ?? undefined, cwd: abs, name: params.name });
			if (created.error) return ok(String(created.error), { error: created.error });
			const cid = String(created.id ?? "");
			// 不用在这里记 recents：基底在 `POST /sessions {cwd}` 时就原子写账了（一个写者）。
			let sent = false;
			if (params.firstMessage?.trim()) {
				const r = await post(`/sessions/${cid}/message`, { text: params.firstMessage, notify: true, notifyTo: me ?? undefined });
				sent = !r.error;
			}
			const text =
				`已在 \`${abs}\` 新开一条会话：${cid}${params.name ? `（名字「${params.name}」）` : ""}（父 = 本会话 ${me ?? "?"}）。\n` +
				`⚠️ 这**不是**搬家 —— 本会话的 cwd 还是 ${base}；新会话是独立的一条。\n` +
				`要跟它说话：send（id = "${cid}"，text = "…"）；它干完会用 push 回报你。` +
				(params.firstMessage?.trim() ? (sent ? `\nfirstMessage 已经发过去了。` : `\n⚠️ firstMessage **没发成功**（会话建好了，消息没进）。`) : "");
			return ok(text, { id: cid, cwd: abs, sent });
		},
	});

	pi.registerTool({
		name: "set_title",
		label: "Set Session Title",
		description:
			"给**自己这个会话**起 / 改一个**短标题**（≤20 字）—— **会话树的左栏显示的就是它**（人和父会话靠它一眼看出你在干什么）。" +
			"当你明白了这个会话到底要干什么之后就用一次；后来发现原来的标题不准了，就再改一次（别只在心里想）。" +
			"标题要具体、说「在做什么」（如「修插件热重载的陈旧判定」），不要写「任务」「分析」这种什么都没说的词，也别写文件名/路径。" +
			"**用户自己改过的标题不会被覆盖**：那种情况下工具会告诉你「没改」，你就接着干活、不要反复重试。",
		// 开场告知（每个会话的系统提示词里都有这两句 —— 见文件头那段）
		promptSnippet: "set_title(title) — 给本会话起/改一个短标题（≤20 字，会话树上显示的就是它）",
		promptGuidelines: [
			"当你明白了这个会话要干什么之后，用 set_title 给自己起一个 ≤20 字的短标题（会话树上显示的就是它）；后来发现原来的标题不准，就再改一次。",
		],
		parameters: Type.Object({
			title: Type.String({ description: "短标题（≤20 字，具体说在做什么）" }),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const me = selfId(ctx);
			if (!me) return ok("拿不到本会话的 id（会话文件还没落盘？）—— 没设标题。", { error: true });
			const r = await post(`/sessions/${me}/title`, { title: params.title });
			if (r.error) return ok(String(r.error), { error: true });
			if (r.ok) {
				return ok(
					`本会话标题 = 「${r.name}」（${r.source === "auto" ? "模型自己起的" : String(r.source ?? "")}）。` +
						`${r.applied ? "" : "（跟原来一样，没变。）"}会话树上左栏现在显示的就是它` +
						`${r.previous && r.previous !== r.name ? `（原来是「${r.previous}」）` : ""}。`,
					{ id: me, title: r.name ?? null, source: r.source ?? null, applied: !!r.applied },
				);
			}
			if (r.reason === "manual")
				return ok(
					`**没改**：这个会话的标题「${r.name ?? "（空）"}」是**用户自己设的**，模型一律不覆盖。` +
						"接着干活就行 —— 已经告诉你了，不要反复重试 set_title。",
					{ id: me, applied: false, reason: "manual" },
				);
			return ok(`没设成（${String(r.reason ?? "?")}）${r.error ? `：${r.error}` : ""}`, { id: me, applied: false, reason: r.reason ?? null });
		},
	});

	pi.registerTool({
		name: "push",
		label: "Push To Parent",
		description:
			"给**自己的父会话**发一条消息（「我干完了」/「我卡住了，需要你定」）。" +
			"**会唤醒它** —— 父不在跑也会被拉起来看你这条。没有父会话（根会话）时直接告诉你。",
		parameters: Type.Object({
			text: Type.String({ description: "要回报给上级的内容：一句话结论 + 产物在哪（有文件就给路径）" }),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const sf = selfFile(ctx);
			const pf = sf ? parentFile(sf) : null;
			const pid = pf ? idOf(pf) : null;
			if (!pid) return ok("这是根会话，没有父可推。（想留痕就写在回复里，或 send 给别的会话。）");
			const r = await post(`/sessions/${pid}/message`, { text: params.text });
			if (r.error) return ok(String(r.error), { error: true });
			return ok(`已推给父会话 ${pid}。`, { id: pid });
		},
	});
	// ─────────────────────── `/cwd` 命令：人（TUI / 网页）看和换目录 ───────────────────────
	// 人类原话：「添加一个 tool 和 / 命令支持用户和 agent 进行 cwd」。
	// 事实（已核）：网页会从 runtime 取命令清单（`GET /sessions/{id}/commands`），插件
	// `pi.registerCommand` 注册的命令**网页里就能敲** —— 它作为普通文本进 `session.prompt()`，
	// pi 的 `_tryExecuteExtensionCommand` 直接执行 handler（`agent-session.js:954`）。
	//
	// ⚠️ **输出怎么让人看见**：扩展命令只有两条可见通路 —— `ctx.ui.notify`（TUI 弹条）与
	// `pi.sendMessage`（落成会话里的一条 `custom_message`）。后者由**会话基底**当独立字段
	// （`GET /sessions/{id}/messages` 的 `extras`）吐给网页，前端用**不同样式**单独画一块
	//（不伪装成助手正文）。见本轮报告里「为什么选独立字段」那段。
	const say = (text: string, ctx?: ExtensionContext) => {
		try {
			ctx?.ui?.notify?.(text, "info");
		} catch {
			/* 没有 UI（比如非交互模式）就算了 */
		}
		try {
			pi.sendMessage({ customType: "sopho-cwd", content: text, display: true });
		} catch {
			/* 发不出去也别把命令弄抛 */
		}
	};

	pi.registerCommand("cwd", {
		description:
			"看 / 换工作目录：`/cwd` 显示当前目录与最近用过；`/cwd <path>` 在 <path> **新开一条会话**（父 = 当前会话）。" +
			"⚠️ 不是给本会话搬家 —— pi 不支持就地改 cwd，换目录 = 另一条会话。",
		getArgumentCompletions: async (prefix) => {
			try {
				const base = myCwd;
				const p = String(prefix ?? "");
				// ① 「你正在输入的那个目录」的子目录；② 最近用过的目录（读 `GET /cwd-recents`，
				// 与 `cwd` 工具/网页下拉同一份事实）。
				let dir = base;
				let partial = "";
				if (p) {
					if (p.endsWith("/")) {
						dir = resolveCwd(p, base);
					} else if (p.includes("/") || p.startsWith("~")) {
						const probe = resolveCwd(p, base);
						dir = path.dirname(probe);
						partial = path.basename(probe);
					} else {
						dir = base;
						partial = p;
					}
				}
				const out: Array<{ value: string; label: string; description?: string }> = [];
				const seen = new Set<string>();
				const push = (v: string, label: string, description?: string) => {
					if (!v || seen.has(v)) return;
					seen.add(v);
					out.push(description ? { value: v, label, description } : { value: v, label });
				};
				try {
					for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
						if (e.name.startsWith(".") && !partial.startsWith(".")) continue; // 隐藏目录：除非你在敲它
						if (partial && !e.name.startsWith(partial)) continue;
						let isDir = e.isDirectory();
						if (!isDir && e.isSymbolicLink()) {
							try {
								isDir = fs.statSync(path.join(dir, e.name)).isDirectory();
							} catch {
								isDir = false;
							}
						}
						if (!isDir) continue;
						const full = path.join(dir, e.name);
						push(full, `${e.name}/`, full === base ? "当前目录" : undefined);
					}
				} catch {
					/* 目录读不了（不存在/没权限）→ 只给 recents */
				}
				const rec = await recentsOf(20);
				for (const r of rec.list) {
					if (p && !r.path.includes(p) && !r.path.startsWith(resolveCwd(p, base))) continue;
					push(r.path, r.path, `用过 ${r.count} 次`);
				}
				return out.length ? out : null;
			} catch {
				return null; // 补全永远不能把命令弄挂
			}
		},
		handler: async (args, ctx) => {
			const base = ctx?.cwd ?? myCwd;
			const raw = String(args ?? "").trim();
			if (!raw) {
				const f = dirFacts(base);
				const rec = await recentsOf(12);
				const recText = rec.error
					? `  ⚠️ 账读不了：${rec.error}`
					: rec.list.length
						? rec.list.map((r) => `  · ${r.path}（用过 ${r.count} 次）`).join("\n")
						: "  （还没有记账 —— 账在 `$ASSIST_HOME/cwd-recents.json`，建会话时由基底原子写入）";
				say(
					`【/cwd】当前工作目录（本会话的 cwd）：${base}\n` +
						factsText(f) +
						`\n最近用过 / 绑定过的目录：\n${recText}\n\n` +
						`想在别的目录干活：\`/cwd <path>\` —— 那会**新开一条会话**（父 = 本会话），` +
						`**不是**给这条会话搬家：pi 不支持就地改一条会话的 cwd（换目录 = 另一条会话、另一份 runtime 状态）。`,
					ctx,
				);
				return;
			}
			const abs = resolveCwd(raw, base);
			const f = dirFacts(abs);
			if (!f.exists || !f.isDir) {
				say(`【/cwd】**没建会话**：${abs} ${f.exists ? "不是目录（是个文件）" : `不存在（${f.error ?? "stat 失败"}）`}。换个存在的目录。`, ctx);
				return;
			}
			const me = selfId(ctx);
			const created = await post("/sessions", { parent: me ?? undefined, cwd: abs });
			if (created.error) {
				say(`【/cwd】建会话失败：${String(created.error)}`, ctx);
				return;
			}
			const cid = String(created.id ?? "");
			say(
				`【/cwd】已在 \`${abs}\` **新开一条会话**：${cid}\n` +
					`⚠️ 这**不是**把当前会话（${me ?? "?"}）搬家 —— pi 做不到就地改一条会话的 cwd；\n` +
					`这是**独立的一条新会话**（父 = 本会话），它的工作目录就是 ${abs}。\n` +
					`要跟它说话：send（id = "${cid}"，text = "…"）；它干完会用 push 回报你。`,
				ctx,
			);
		},
	});

	// ═══════════════════ 阅读页工具（阅读/学习助手这条线）═══════════════════
	//
	// **为什么要有这些工具**（人类的原话）：
	//   「让 agent **不用去读/写那份 md**，而是给它提供工具；它对外部应该只需要**自己去读 epub**。」
	// 我把它收了一格（跟人类确认过）：**不是"让它读 epub"，而是"原文与查书也走工具"** ——
	// 因为**原文必须与文件里的 `sha256`/`srcId` 严格一致**（那是协议的地基）。让它自己解 zip、自己切段，
	// 就会出现"它引用的原文 ≠ 文件里那段"这种**最难发现的错**。
	//
	// 后来人类又裁定：工具仍是首选（它们过锚点解析 + 指纹门 + 锁），但工具做不到或连续失败时，
	// **允许**用 read/bash/edit/write 直接读写阅读笔记与 epub 兜底，不能因为工具失败卡住。直写不过闸，
	// 所以写前必须读回当前页，写后必须再读回并用 GET /pages 核对；坏了就停下并如实报告。
	//
	// **三条设计判据**（人类给的）：
	//   1. **参数里绝不出现行号/区间** —— 模型只说"哪一段/哪道题"，锚点由服务端按 srcId/指纹解析；
	//   2. 工具是**写回**动作，不是"思考容器" —— 它想留给自己看的东西就别写回（可见性分层）；
	//   3. 工具优先；直接 I/O 是带"写前读回 + 写后自检 + 出错即停"义务的兜底，不是另一条无闸正路。
	//
	// **只在阅读会话里启用**（核过 pi 的 `docs/extensions.md`：`pi.setActiveTools()` 是 per-runtime 的，
	// 每个会话一个 ExtensionAPI 实例 ⇒ 可以只给某些会话激活）。判据 = 这个会话 id 在
	// `$ASSIST_HOME/reading-pages.json` 里有绑定。非阅读会话里它们**不激活**（也不占系统提示词）。
	// 兜底：每个工具自己也再核一次绑定（万一 gating 没生效，也给一句人话而不是乱写）。

	const READING_TOOLS = ["page_read", "page_ask", "page_note", "page_progress", "page_source", "epub_outline", "epub_search"] as const;
	const DIRECT_IO_FALLBACK =
		"工具仍是首选：page_read / page_ask / page_note / page_progress / page_source / epub_outline / epub_search 会经过指纹门与锚点解析。" +
		"只有工具做不到或连续失败时，才用 read / bash / edit / write 直接读写那份阅读笔记或 epub 兜底；不许因为工具失败卡住。" +
		"直写不过闸：真要写时，先读回当前页；写完再读回，并请求 GET /pages 核对解析错误与指纹/原文一致性。发现页面坏了就停下，如实报告，不要接着改。";
	const DIRECT_IO_GUIDELINE =
		"Prefer the page_* and epub_* tools. If they cannot do the job or repeatedly fail, direct read/bash/edit/write access to the reading note or epub is allowed as a fallback. " +
		"Before a direct write, read the current page; afterward read it again and check GET /pages. Stop and report any parse or fingerprint error.";
	const READING_PAGES_FILE = path.join(ASSIST_HOME, "reading-pages.json");

	type PageBinding = { path: string; sessionId?: string; boundBy?: string; epub?: string | null; file?: string | null; epubId?: string | null };
	const readBindings = (): Record<string, PageBinding> => {
		try {
			return JSON.parse(fs.readFileSync(READING_PAGES_FILE, "utf8")) as Record<string, PageBinding>;
		} catch {
			return {};
		}
	};
	/** 这个会话绑了哪些页。**按会话过滤**：一个会话可能绑多页（一个现场一页的例外情况）。 */
	const boundPages = (ctx?: ExtensionContext): PageBinding[] => {
		const id = selfId(ctx);
		if (!id) return [];
		return Object.entries(readBindings())
			.filter(([, b]) => b?.sessionId === id)
			.map(([p, b]) => ({ ...b, path: p }));
	};

	const PAGE_NOT_BOUND =
		"这个会话没有绑定任何阅读页（`$ASSIST_HOME/reading-pages.json` 里查不到）。\n" +
		"阅读页工具只在**阅读会话**里可用 —— 可以先在阅读页上按「发送」（那会建/绑一条会话）。\n" +
		"如果这确实是阅读任务，而且消息里已经给了阅读笔记或 epub 路径，不要卡住：允许用 read / bash / edit / write 直接读写兜底。\n" +
		"⚠️ 直写不过指纹门与锚点解析：写前先读回当前页；写后再读回并请求 GET /pages 核对。发现解析错误或指纹不符就停下并如实报告，不要继续改。";

	/** 取"这一页"。`path` 省略时用这个会话绑的那一页（绑了多页就必须明说是哪一页）。 */
	const loadPage = async (ctx: ExtensionContext | undefined, want?: string) => {
		const mine = boundPages(ctx);
		if (!mine.length) return { error: PAGE_NOT_BOUND };
		const hit = want
			? mine.find((b) => b.path === want || b.path.endsWith("/" + want) || path.basename(b.path) === want)
			: mine.length === 1
				? mine[0]
				: null;
		if (!hit) {
			return {
				error: `要哪一页？这个会话绑了 ${mine.length} 页，请用 path 指定其中一页（或给个能唯一匹配的后缀）：\n` + mine.map((b) => `  · ${b.path}`).join("\n"),
			};
		}
		const page = await get(`/pages?path=${encodeURIComponent(hit.path)}`);
		if ((page as { error?: string }).error) return { error: `读不到这一页（${hit.path}）：${String((page as { error?: string }).error)}` };
		return { binding: hit, page: page as Record<string, unknown> };
	};

	/** 这一页用的是哪本 epub / 哪份 xhtml（从已有的原文块 srcId 推；没有就问绑定 sidecar）。
	 *  ⚠️ 只推"哪本书"，**不自作主张切段** —— 段号永远来自 srcId 或调用方。 */
	const bookOf = (binding: PageBinding, page: Record<string, unknown>) => {
		const sources = (page.sources ?? []) as Array<{ srcId?: string }>;
		const first = sources.map((x) => x.srcId).find(Boolean);
		if (first) {
			const m = /^([^!]+)!(.+)#p\d+$/.exec(first);
			if (m) return { epubId: m[1], file: m[2], epub: binding.epub ?? null };
		}
		return { epubId: binding.epubId ?? null, file: binding.file ?? null, epub: binding.epub ?? null };
	};

	/** 把 epub 的根内相对路径找出来（绑定里没有时）。 */
	const findEpub = async (name: string) => {
		const r = (await post("/pages", { op: "find-epub", name })) as { found?: string[]; error?: string };
		return r.found ?? [];
	};

	const needBook = async (binding: PageBinding, page: Record<string, unknown>, epubArg?: string) => {
		const b = bookOf(binding, page);
		if (epubArg) return { epub: epubArg, ...b };
		if (b.epub) return b;
		if (b.epubId) {
			const found = await findEpub(b.epubId);
			if (found.length === 1) return { ...b, epub: found[0] };
			if (found.length > 1) return { error: `根下有多份叫「${b.epubId}」的文件：\n` + found.map((f) => `  · ${f}`).join("\n") + "\n请用 epub 参数指定。" };
		}
		return {
			error:
				"不知道是哪本 epub" +
				(b.epubId ? `（从原文块的 srcId 看到 ${b.epubId}，但在 SOPHO_EPUB_ROOT 下找不到唯一的一份）` : "（这一页还没有任何原文块）") +
				"，请给 epub 参数（相对 SOPHO_EPUB_ROOT 的路径）。",
		};
	};

	/** 段号/srcId 的入口归一：接受 `5` / `p5` / `#p5` / `part0004.xhtml#p5` / 完整 srcId。 */
	const asSrcId = (at: unknown, book: { epubId?: string | null; file?: string | null }) => {
		const raw = String(at ?? "").trim();
		if (!raw) return null;
		if (raw.includes("!")) return raw; // 已经是完整 srcId
		const m = /(?:^|[#/])(?:p)?(\d+)$/.exec(raw);
		if (!m) return null;
		const n = Number(m[1]);
		if (!Number.isInteger(n) || n < 1) return null;
		const file = raw.includes("#") ? raw.split("#")[0] : (book.file ?? null);
		if (!file || !book.epubId) return null;
		return `${book.epubId}!${file}#p${n}`;
	};

	/** 组装给人/模型看的**结构化**页面（不是整页裸 dump）。 */
	const shapePage = (page: Record<string, unknown>, opts: { unit?: string; question?: string; srcHead?: number }) => {
		const blocks = (page.blocks ?? []) as Array<Record<string, any>>;
		const L: string[] = [];
		let unit = opts.unit ? null : "（整页）";
		let inUnit = !opts.unit;
		const head = opts.srcHead ?? 70;
		for (const b of blocks) {
			if (b.kind === "heading" && b.level === 2) {
				unit = b.text;
				inUnit = !opts.unit || String(b.text).includes(String(opts.unit));
				if (inUnit) L.push(`\n## ${b.text}`);
				continue;
			}
			if (!inUnit) continue;
			if (b.kind === "heading") L.push(`\n### ${b.text}`);
			else if (b.kind === "field") L.push(`\n【字段·${b.name}】\n${b.text}`);
			else if (b.kind === "source") L.push(`\n【原文 ${b.srcId}${b.markerAttrs?.stripped ? ` 剥掉:${b.markerAttrs.stripped}` : ""}】\n${short(b.text, head)}`);
			else if (b.kind === "question") {
				if (opts.question && !String(b.label).includes(String(opts.question))) continue;
				L.push(`\n${b.label}: ${b.text.replace(/^Q\d+\s*[:：]\s*/, "")}`);
			} else if (b.kind === "answer") L.push(`  读者答：${/^A\s*[:：]\s*$/.test(String(b.text).trim()) ? "（空）" : b.text.replace(/^A\s*[:：]\s*/, "")}`);
			else if (b.kind === "assistant") L.push(`  [助手${b.dataKind}] ${short(b.text, 240)}`);
			else if (b.kind === "reader") L.push(`  [读者段落] ${short(b.text, 240)}`);
		}
		return L.join("\n").trim();
	};

	const pageHint =
		"（页面内容已经按结构给你了，后续仍优先用 page_* / epub_*；工具做不到或连续失败时可以直接读写兜底。" +
		"直写不过指纹门与锚点解析：写前先读回当前页，写后再读回并请求 GET /pages 核对；发现坏页就停下并如实报告。）";

	// ── ① page_read：看这一页（结构化）──────────────────────────────────
	pi.registerTool({
		name: "page_read",
		label: "Read Reading Page",
		description:
			"读**当前阅读页**的结构化内容：原文段落（带 srcId，正文按长度截断）、问题、**读者写下的答案**、助手块、进度字段。\n" +
			"**这是获取「读者现在读到哪、写了什么」的首选路径。**\n" +
			"参数都可选：unit 只看某个学习单元，question 只看某道题（连同它的答案），path 指定哪一页（只绑了一页时可以不给）。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "读当前阅读页（原文/问题/读者答案/进度）",
		promptGuidelines: [DIRECT_IO_GUIDELINE],
		parameters: Type.Object({
			unit: Type.Optional(Type.String({ description: "只看这个学习单元（给单元标题里的一段文字即可）" })),
			question: Type.Optional(Type.String({ description: "只看这道题的编号（如 Q2）" })),
			path: Type.Optional(Type.String({ description: "哪一页（相对 SOPHO_PAGE_ROOT；只绑一页时可省略）" })),
			sourceChars: Type.Optional(Type.Number({ description: "每段原文截断到多少字（默认 70；想读全就用 page_source）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const page = r.page!;
			const shaped = shapePage(page, { unit: params.unit, question: params.question, srcHead: params.sourceChars });
			return ok(
				`阅读页：${page.path}\n整页指纹：${page.pageFingerprint}\n绑定会话：${(r.binding as PageBinding).sessionId}\n${pageHint}\n\n` +
					(shaped || "（按你给的条件没找到内容）"),
				{ path: page.path, pageFingerprint: page.pageFingerprint, errors: page.errors },
			);
		},
	});

	// ── ② page_ask：把问题挂到段末（写回）────────────────────────────────
	pi.registerTool({
		name: "page_ask",
		label: "Ask On Reading Page",
		description:
			"在阅读页上**提出一个问题**，它会挂到**那一段原文的段末**（Q 编号自动取本单元的下一个，答案位留空由读者填）。\n" +
			"at 只说「哪一段」：给段号（如 5）或 srcId（如 自我与本我.epub!part0004.xhtml#p5）—— **不许给行号或区间**，锚点由服务端按 srcId 解析。\n" +
			"⚠️ 这是**写回文件**的动作：只写「需要读者回应的问题」。你自己推演、备忘、过程性内容**不要**写回（留在你的上下文里）。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "在阅读页某一段末尾写一个问题（挂段末）",
		promptGuidelines: [
			"Use page_ask to put a question onto the reading page at the end of a paragraph.",
			"Use page_ask only for things the reader must respond to; keep your own reasoning in your own context.",
			DIRECT_IO_GUIDELINE,
		],
		parameters: Type.Object({
			at: Type.Union([Type.String(), Type.Number()], { description: "哪一段：段号或 srcId（不要给行号/区间）" }),
			text: Type.String({ description: "问题本身（别带 Q 编号，编号会自动加）" }),
			section: Type.Optional(Type.String({ description: "本单元的标题（用来算下一个 Q 编号；默认当前最后一个单元）" })),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const page = r.page!;
			const book = bookOf(r.binding as PageBinding, page);
			const srcId = asSrcId(params.at, book);
			if (!srcId) {
				// 段号要靠"哪本书 + 哪份 xhtml"才拼得出 srcId；拼不出就说清**差什么、怎么补**。
				const why = !book.epubId
					? "这一页**还没有任何原文块**，所以我算不出「第 5 段」是哪本书的哪一段 —— 先用 page_source（materialize:true + epub + section）把要讨论的那几段材料化进来，再挂问题"
					: `at 得是段号或 srcId（例如 5 / p5 / ${book.epubId}!${book.file ?? "part0004.xhtml"}#p5）`;
				return ok(`${why}。行号与区间一律不收 —— 锚点由服务端按 srcId/指纹解析（那样别人的编辑不会让它错位）。`, { error: true });
			}
			const blocks = (page.blocks ?? []) as Array<Record<string, any>>;
			// 下一个 Q 编号 —— **跟着"你要挂的那一段"所在的学习单元走**，不跟着参数走：
			// 一次阅读里每个单元都有自己的 Q1/Q2/Q3，所以"下一个编号"只对**那一段所属的单元**有意义。
			// （踩过：拿一个对不上的 section 去筛 ⇒ 一个 Q 都没数到 ⇒ 写出**重复的 Q1**。
			//  这种"看着成功、其实重号"的错最难发现，所以这里一律以锚点所在单元为准。）
			const srcBlock = blocks.find((b) => b.kind === "source" && b.srcId === srcId);
			let unitOfAnchor = null as string | null;
			if (srcBlock) {
				for (const b of blocks) {
					if (b.range[0] > srcBlock.range[0]) break;
					if (b.kind === "heading" && b.level === 2) unitOfAnchor = b.text;
				}
			}
			if (params.section) {
				const units = blocks.filter((b) => b.kind === "heading" && b.level === 2).map((b) => String(b.text));
				if (!units.some((u) => u.includes(String(params.section)))) {
					return ok(`页面上没有标题含「${params.section}」的学习单元。现有单元：\n` + units.map((u) => `  · ${u}`).join("\n"), { error: true });
				}
			}
			const wantUnit = params.section ? String(params.section) : unitOfAnchor;
			let unit = null as string | null;
			let maxQ = 0;
			for (const b of blocks) {
				if (b.kind === "heading" && b.level === 2) unit = b.text;
				if (b.kind !== "question") continue;
				if (wantUnit && !String(unit ?? "").includes(String(wantUnit))) continue;
				const n = Number(String(b.label ?? "").replace(/[^0-9]/g, ""));
				if (Number.isFinite(n)) maxQ = Math.max(maxQ, n);
			}
			const label = `Q${maxQ + 1}`;
			const res = (await post("/pages", {
				op: "insert-block",
				path: page.path,
				anchorKind: "source",
				sourceId: srcId,
				block: { kind: "问题", text: `${label}: ${params.text}` },
			})) as Record<string, any>;
			if (res.error) return ok(`没写进去（${res.error}）${res.hint ? `：${res.hint}` : ""}`, { error: true, ...res });
			return ok(`已在 ${srcId} 的段末挂上「${label}」，答案位留空。（页面：${page.path}）`, { srcId, label, path: page.path, bytes: res.bytes });
		},
	});

	// ── ③ page_note：追加助手块（写回）──────────────────────────────────
	pi.registerTool({
		name: "page_note",
		label: "Add Assistant Note To Page",
		description:
			"在阅读页上追加一块**你自己的**内容（带 data-author=\「assistant\」，读者一眼能看出那是你写的）。\n" +
			"kind 决定它是追问 / 整理 / 补充资料 / 回顾；after 说挂在哪：after.question=某道题之后（连同它的答卷），或 after.at=某一段之后（段号/srcId）。\n" +
			"⚠️ **只在它真的改变了理解、记录了一个有用的区分、提供了需要的出处、或者造出了一条值得带下去的问题时才写回。**\n" +
			"过程性的东西（你的推理、你的备忘、你的犹豫）**不要**写回文件 —— 那是你的上下文该待的地方。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "在阅读页追加一块助手内容（追问/整理/补充资料/回顾）",
		promptGuidelines: [
			"Use page_note only when your note changes the interpretation, supplies a needed source, or creates a question worth carrying forward — not for routine replies.",
			DIRECT_IO_GUIDELINE,
		],
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("助手追问"), Type.Literal("助手整理"), Type.Literal("补充资料"), Type.Literal("回顾")], { description: "这块是什么" }),
			text: Type.String({ description: "正文（一行；不要带 HTML/span）" }),
			after: Type.Optional(
				Type.Object({
					question: Type.Optional(Type.String({ description: "挂在这道题之后（连同它的答卷），如 Q2" })),
					at: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "挂在这一段之后：段号或 srcId" })),
					section: Type.Optional(Type.String({ description: "配合 question：这道题属于哪个单元（同名的题会歧义）" })),
				}),
			),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const page = r.page!;
			const book = bookOf(r.binding as PageBinding, page);
			const a = params.after ?? {};
			const anchor = a.question
				? { question: a.question, section: a.section }
				: a.at !== undefined
					? { sourceId: asSrcId(a.at, book) }
					: null;
			if (!anchor || (anchor as { sourceId?: string | null }).sourceId === null) {
				return ok("after 得给 question（题号，可选 section）或 at（段号 / srcId）；两样都没给我不知道挂哪。", { error: true });
			}
			const prefix = params.kind === "补充资料" ? "补充资料" : params.kind === "回顾" ? "讨论后回顾" : params.kind === "助手整理" ? "助手整理" : "助手追问";
			const res = (await post("/pages", {
				op: "insert-block",
				path: page.path,
				...anchor,
				block: { kind: params.kind, text: `${prefix}：${params.text}`, id: `asst-${params.kind}-${Date.now().toString(36)}` },
			})) as Record<string, any>;
			if (res.error) return ok(`没写进去（${res.error}）${res.hint ? `：${res.hint}` : ""}`, { error: true, ...res });
			return ok(`已写入一块「${params.kind}」。（页面：${page.path}）`, { kind: params.kind, path: page.path });
		},
	});

	// ── ④ page_progress：改进度字段（写回）──────────────────────────────
	pi.registerTool({
		name: "page_progress",
		label: "Update Reading Progress",
		description:
			"更新阅读页的「阅读位置」里的 `- 当前状态：` 那一行（**只动这一行**）。\n" +
			"status 写成一句事实性的状态（读者读到哪、哪个单元做完了、下一步是什么），**不要**写成鼓励或总结陈词。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "更新阅读页的进度字段（阅读位置）",
		parameters: Type.Object({
			status: Type.String({ description: "新的当前状态（一行）" }),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const page = r.page!;
			const field = ((page.fields ?? []) as Array<Record<string, any>>).find((f) => String(f.heading ?? "").includes("阅读位置"));
			if (!field) return ok(`这一页没有「阅读位置」字段（有的字段：${((page.fields ?? []) as Array<any>).map((f) => f.heading).join(" / ") || "无"}）。`, { error: true });
			const res = (await post("/pages", {
				op: "replace-field-line",
				path: page.path,
				address: { section: field.section ?? null, heading: field.heading },
				match: "- 当前状态：",
				line: `- 当前状态：${params.status}`,
				expectedFingerprint: field.fingerprint,
			})) as Record<string, any>;
			if (res.error) return ok(`没改成（${res.error}）${res.detail ? `：${res.detail}` : ""}（多半是那一行不叫「- 当前状态：」，或者你读完之后它被人改过）`, { error: true, ...res });
			return ok(`已更新「当前状态」。（页面：${page.path}）`, { path: page.path });
		},
	});

	// ── ⑤ page_source：拿原文（材料化用）────────────────────────────────
	pi.registerTool({
		name: "page_source",
		label: "Get Source Paragraph",
		description:
			"取 epub 里某一段的原文 —— **返回的字与页面里那份哈希天然一致**（同一个抽取器、同一套规范化）。\n" +
			"给 at（段号或 srcId）就只取回来看看；再加 materialize:true + section 就把它**写进页面**（幂等：已在页面里且正文一致时不会写第二遍）。\n" +
			"优先用本工具而不是自己解 epub / 自己切段；后者更容易让引用的原文与文件里的 sha256 对不上。\n" +
			"想先看看整本书有哪些章 / 某句话在哪一段，用 epub_outline / epub_search。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "取 epub 里某一段原文（与页面哈希一致），可顺带材料化进页面",
		promptGuidelines: [DIRECT_IO_GUIDELINE],
		parameters: Type.Object({
			at: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "段号或 srcId" })),
			epub: Type.Optional(Type.String({ description: "epub 路径（相对 SOPHO_EPUB_ROOT；默认从页面的原文块推）" })),
			materialize: Type.Optional(Type.Boolean({ description: "true = 写进页面（需要 section）" })),
			section: Type.Optional(Type.String({ description: "materialize 时挂到哪个标题节的末尾（那节的标题文字）" })),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const page = r.page!;
			const book = await needBook(r.binding as PageBinding, page, params.epub);
			if ((book as { error?: string }).error) return ok(String((book as { error?: string }).error), { error: true });
			const srcId = asSrcId(params.at, book as { epubId?: string; file?: string });
			if (!srcId) return ok("at 得是段号或 srcId（例如 5 / p5 / 书.epub!part0004.xhtml#p5）。", { error: true });
			const m = /^([^!]+)!(.+)#p(\d+)$/.exec(srcId)!;
			const ex = (await post("/pages", { op: "extract", epub: (book as { epub: string }).epub, file: m[2], paragraph: Number(m[3]), epubId: m[1] })) as Record<string, any>;
			if (ex.error) return ok(`抽不到：${ex.error}`, { error: true, ...ex });
			let note = `原文 ${ex.srcId}（${ex.paragraph}/${ex.paragraphCount} 段，class=${ex.cls}）\n哈希 ${ex.fingerprint}\n剥离痕迹：${ex.stripped ?? "（无）"}${ex.warnings?.length ? `\n⚠️ ${ex.warnings.join("；")}` : ""}\n\n${ex.text}`;
			if (params.materialize) {
				if (!params.section) return ok(note + "\n\n（materialize 需要 section：要挂到哪个标题节的末尾）", { error: true });
				const blocks = (page.blocks ?? []) as Array<Record<string, any>>;
				const h = blocks.find((b) => (b.kind === "heading" || b.kind === "field") && String(b.text ?? b.name ?? "").includes(String(params.section)));
				if (!h) return ok(`${note}\n\n（页面上找不到标题里含「${params.section}」的节；现有标题：${blocks.filter((b) => b.kind === "heading").map((b) => b.text).join(" / ")}）`, { error: true });
				const res = (await post("/pages", {
					op: "materialize-source",
					path: page.path,
					epub: (book as { epub: string }).epub,
					file: m[2],
					paragraphs: [Number(m[3])],
					epubId: m[1],
					section: { level: h.level ?? 3, heading: h.text ?? h.name },
				})) as Record<string, any>;
				if (res.error) return ok(`${note}\n\n（写进页面失败：${res.error}）`, { error: true, ...res });
				note += res.wrote ? `\n\n⇒ 已写进页面：${page.path}` : `\n\n⇒ 页面里已经有这一段且正文一致，**没有重复写**。`;
			}
			return ok(note, { srcId: ex.srcId, fingerprint: ex.fingerprint, path: page.path });
		},
	});

	// ── ⑥ epub_outline：章节树 ─────────────────────────────────────────
	pi.registerTool({
		name: "epub_outline",
		label: "Epub Outline",
		description:
			"看这本书的**章节树**（spine 顺序 + 每份 xhtml 里看着像标题的段落，带段号）。\n" +
			"真实陪读里经常要**向前引用**（「这个说法要到第十章才展开」）—— 用这个先确认「第几段/哪一章」，\n" +
			"再用 page_source 取那一段的原文（这样引用的字一定与页面哈希一致）。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "看 epub 的章节树（哪一章在哪一段）",
		parameters: Type.Object({
			chapter: Type.Optional(Type.String({ description: "只看标题里含这段文字的章节" })),
			epub: Type.Optional(Type.String({ description: "epub 路径（默认从当前页推）" })),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const book = await needBook(r.binding as PageBinding, r.page!, params.epub);
			if ((book as { error?: string }).error) return ok(String((book as { error?: string }).error), { error: true });
			const o = (await post("/pages", { op: "outline", epub: (book as { epub: string }).epub, epubId: (book as { epubId?: string }).epubId })) as Record<string, any>;
			if (o.error) return ok(`读不到章节树：${o.error}`, { error: true, ...o });
			let ch = (o.chapters ?? []) as Array<Record<string, any>>;
			if (params.chapter) ch = ch.filter((c) => String(c.text).includes(String(params.chapter)) || String(c.file).includes(String(params.chapter)));
			return ok(
				`${o.epub}（${o.files?.length ?? 0} 份 xhtml，共 ${o.chapterCount} 个"看着像标题"的段落）\n` +
					`文件：${(o.files ?? []).map((f: Record<string, any>) => `${f.file}(${f.paragraphs}段)`).join(" · ")}\n\n` +
					(ch.length ? ch.map((c) => `· ${c.file}#p${c.paragraph}  ${c.text}`).join("\n") : "（按你给的条件没匹配到章节）"),
				{ epub: o.epub, chapters: ch.length },
			);
		},
	});

	// ── ⑦ epub_search：按关键词找段 ────────────────────────────────────
	pi.registerTool({
		name: "epub_search",
		label: "Search Epub Text",
		description:
			"在整本书里**按关键词找段落**（逐段子串匹配，返回段号 + srcId + 开头一截）。\n" +
			"典型用法：想知道「某个说法第一次出现在哪」→ 搜到段号 → page_source 取那一整段（这样引用的原文一定与页面哈希一致）。\n" +
			DIRECT_IO_FALLBACK,
		promptSnippet: "在 epub 里按关键词找段落（返回段号）",
		parameters: Type.Object({
			q: Type.String({ description: "要搜的词（原样子串匹配）" }),
			limit: Type.Optional(Type.Number({ description: "最多返回几条（默认 20）" })),
			epub: Type.Optional(Type.String({ description: "epub 路径（默认从当前页推）" })),
			path: Type.Optional(Type.String({ description: "哪一页（只绑一页时可省略）" })),
		}),
		async execute(_id, params, _sig, _upd, ctx) {
			const r = await loadPage(ctx, params.path);
			if (r.error) return ok(r.error, { error: true });
			const book = await needBook(r.binding as PageBinding, r.page!, params.epub);
			if ((book as { error?: string }).error) return ok(String((book as { error?: string }).error), { error: true });
			const o = (await post("/pages", { op: "search", epub: (book as { epub: string }).epub, q: params.q, limit: params.limit, epubId: (book as { epubId?: string }).epubId })) as Record<string, any>;
			if (o.error) return ok(`搜不了：${o.error}`, { error: true, ...o });
			const hits = (o.hits ?? []) as Array<Record<string, any>>;
			return ok(
				`"${o.q}" 在《${o.epub}》里命中 ${o.count} 段${o.truncated ? "（已截断）" : ""}：\n\n` +
					(hits.length ? hits.map((h) => `· ${h.srcId}  [${h.cls}]  …${h.text.slice(Math.max(0, h.at - 20), h.at + 60)}…`).join("\n") : "（没找到）"),
				{ q: o.q, count: o.count },
			);
		},
	});

	// ── gating：这些工具**只在阅读会话里**激活 ──────────────────────────
	const syncReadingTools = (ctx?: ExtensionContext) => {
		try {
			const want = boundPages(ctx).length > 0;
			const active = pi.getActiveTools();
			const on = READING_TOOLS.every((t) => active.includes(t));
			if (want === on) return; // 只在需要变的时候动（改系统提示词有代价）
			const next = want ? [...new Set([...active, ...READING_TOOLS])] : active.filter((t) => !(READING_TOOLS as readonly string[]).includes(t));
			pi.setActiveTools(next);
		} catch {
			/* 拿不到工具表/设不上就算了：工具自己还会再核一次绑定 */
		}
	};
	pi.on("session_start", (_ev, ctx) => {
		if (ctx?.cwd) myCwd = ctx.cwd; // 命令的补全拿不到 ctx —— 靠这里续上
		syncReadingTools(ctx);
	});
	// 绑定可能是**之后**才出现的（比如人把一个已有会话绑到某一页）⇒ 每一轮开始前再对一次账。
	// 状态没变时 syncReadingTools 什么都不做（不会白白重建系统提示词、也就不会把缓存打掉）。
	pi.on("before_agent_start", (_ev, ctx) => {
		if (ctx?.cwd) myCwd = ctx.cwd;
		syncReadingTools(ctx);
	});
}


/** 会话 id 的入口归一：去掉 `#` 前缀后**原样传给基底**。
 *  这里**不解析**（不猜、不截不拼）—— 解析只在基底（server/base.mjs 的 resolveId）。
 *  ⚠️ 工具的 `id` 参数描述里已经写清「传**完整 uuid**」：因为前缀**不保证唯一**
 *  （实测两个会话前 8 位相同），而**末 8 位（界面上旧版的尾巴显示）永远解析不到** ——
 *  两个真实事故都是「人把界面上的 8 位尾巴复制给模型」→ 一律回「没有这个会话」。
 *  前缀到底还要不要收（现在 `resolveId` 收「唯一前缀」、歧义时**静默原样返回**）= 待人类拍板，
 *  见本轮回报里的方案；真要收紧，改的**不是这里**，而是 server/base.mjs 的 resolveId。 */
function expand(id: string): string {
	return id.trim().replace(/^#/, "");
}
