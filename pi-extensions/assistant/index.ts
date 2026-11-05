/**
 * sopho-pi v2 · pi 插件 —— 会话之间的工具 + 给会话起标题。
 *
 * 会话树里，**每个会话都能**：
 *   spawn  开一个子会话（可选：顺手把任务交给它）
 *           —— 默认共享工作目录；**同 cwd 上还有别人在干活时会被硬拦**，
 *              除非显式给 worktree:"new"（独立 git 工作树）或 "share"（明知共享）
 *   send   给某个会话发一条消息（会唤醒它；已存档的会被复活）
 *   session_read  看某个会话的状态 + 最近几条消息
 *   push   给**自己的父会话**发一条消息（会唤醒父 —— "我干完了/我卡住了"）
 *   set_title 给**自己**起/改一个短标题（**会话树上左栏显示的就是它**）：明白了这个会话要干什么
 *           之后起一个，后来发现不准再改一次。走 `POST /sessions/{id}/title`（扩展侧拿不到
 *           pi 的「设会话名」API → 只能上报给会话基底，由它调 session.setSessionName()）。
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

/** 拦的时候要**列出是谁**，否则模型不知道该选哪条。 */
const conflictLine = (s: EnvSession, dirty: number | null) => {
	const state = s.streaming ? "running" : "idle";
	const d = dirty == null ? "" : `; ${dirty} uncommitted file${dirty === 1 ? "" : "s"}`;
	return `${s.id.slice(0, 8)} 「${nameOfSession(s)}」 (${state}${d})`;
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
			id: Type.String({ description: "目标会话 id（8 位短 id 或完整 uuid）" }),
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
			return ok(`已发给 ${params.id}。${reg?.registered ? "已登记：它这一轮结束会唤醒我。" : "（未登记唤醒）"}`, {
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
			id: Type.String({ description: "目标会话 id（8 位短 id 或完整 uuid）" }),
			lines: Type.Optional(Type.Number({ description: "看最近几条消息（默认 4）" })),
		}),
		async execute(_id, params) {
			const id = expand(params.id);
			const st = await get(`/sessions/${id}`);
			if (st.error) return ok(String(st.error), { error: true });
			const ms = await get(`/sessions/${id}/messages`);
			const list = Array.isArray(ms.messages) ? (ms.messages as { role: string; text: string }[]) : [];
			const n = Math.max(1, Math.min(20, params.lines ?? 4));
			const tail = list.slice(-n).map((m) => `  [${m.role}] ${short(m.text, 200)}`);
			const stale = st.pluginStale === true;
			const staleLine = stale
				? `⚠️ pluginStale=true —— 这个会话跑的是**旧插件**（建 runtime 时加载的 hash=${st.pluginHashAtLoad ?? "?"}，磁盘上是 ${st.pluginNowHash ?? "?"}）。\n` +
					`   基底会**自动重载**插件：pi-extensions/ 的改动**提交**之后，空闲的会话立刻吃新版，正在跑的等它这一轮结束再吃。\n` +
					`   所以 stale=true 通常只在「刚提交、这轮还没跑完」或「有人手动把文件改成没提交的半成品」时出现。要立刻：**POST /sessions/${id}/reload**\n` +
					`   （或 bin/restart-base.sh）。注意**新建一条会话不一定够** —— pi 按 cwd 在进程内缓存扩展模块，同 cwd 的新会话会复用旧工厂。\n` +
					`   **POST /reload-code 只换 base-logic，不管插件这一层。**\n`
				: "";
			return ok(
				`#${id}  hot=${st.hot ?? false} streaming=${st.streaming ?? false} archived=${st.archived ?? "?"} 共 ${list.length} 条` +
					`  pluginStale=${st.pluginStale === true ? "true" : st.pluginStale === false ? "false" : "?"}\n` +
					staleLine +
					(tail.length ? tail.join("\n") : "  （还没有文本消息）"),
				{ id, hot: st.hot, streaming: st.streaming, pluginStale: st.pluginStale ?? null, pluginMtimeMs: st.pluginMtimeMs ?? null },
			);
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
}

/** 基底会按“唯一前缀”解析；这里只把 # 去掉、原样传。 */
function expand(id: string): string {
	const t = id.trim().replace(/^#/, "");
	if (t.length >= 36) return t;
	return t; // 短 id 由基底侧解析（它按前缀匹配）；这里先原样传
}
