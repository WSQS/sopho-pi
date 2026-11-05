/**
 * assistant profile — 事项账本（S1 捕获 + S3 分诊与讨论）
 *
 * 和 `a` 这个 CLI 共用同一份账本。
 *
 * 三条入口，都归到同一份数据：
 *   1. shell:  a "..."           捕获（零 LLM）+ 后台分诊
 *   2. 聊天里: a "..."           同样有效 —— input 事件拦截，不惊动模型
 *   3. 助手自己: /discuss <id>    让服务器开专属会话（不切 TUI），不需要你碰终端
 *
 * 分工：
 *   - CLI     = 捕获 / 分诊 / 总览，零成本、可离线
 *   - 本扩展  = 助手建议 + 自己开会话 + 把账本暴露成工具
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as os from "node:os";
import * as path from "node:path";

const LEDGER_BIN =
	process.env.ASSIST_LEDGER_BIN ?? path.join(os.homedir(), "code/ai/sopho-pi/bin/ledger.mjs");

type ExecResult = { stdout: string; stderr: string; code: number | null };

async function runLedger(pi: ExtensionAPI, args: string[]): Promise<ExecResult> {
	const r = await pi.exec("node", [LEDGER_BIN, ...args], { timeout: 20_000 });
	return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), code: r.code ?? null };
}

const joined = (r: ExecResult) => [r.stdout, r.stderr].filter(Boolean).join("\n") || "(无输出)";

type Item = {
	id: number;
	text: string;
	createdAt: number;
	state: string;
	clarity?: string;
	note?: string;
	accepted?: boolean;
	next?: string;
	updatedAt?: number;
	spec: string | null;
	// 账本算好的展示状态。**扩展不许自己重算** —— 硬约束 #15：
	// 一切推导只在 bin/ledger.mjs 一份，否则两边会分叉。
	tag?: string;
	tone?: string;
	stall?: number;
	isLeaf?: boolean;
	children?: number[];
};

/** 上一个会话的文件路径（讨论会话里 = 助手会话）。用于 /back 回去。 */
let parentSessionFile: string | undefined;

/** 只读快照。失败一律静默降级 —— 账本的问题绝不该挡住会话。 */
async function snapshot(pi: ExtensionAPI): Promise<{ items: Item[] } | null> {
	try {
		const r = await runLedger(pi, ["--json"]);
		if (r.code !== 0) return null;
		return JSON.parse(r.stdout) as { items: Item[] };
	} catch {
		return null;
	}
}

async function getItem(pi: ExtensionAPI, id: number): Promise<Item | null> {
	const s = await snapshot(pi);
	return s?.items.find((i) => i.id === id) ?? null;
}

/** sopho-pi 服务器地址：下属会话在服务器 runtime 池里开，不在 TUI 里切。 */
const SOPHO_BASE = process.env.SOPHO_BASE ?? `http://127.0.0.1:${process.env.SOPHO_PORT ?? 7321}`;
const SOPHO_TOKEN = process.env.SOPHO_TOKEN ?? "";

/**
 * 让服务器为某事项开一场会话（讨论 / 执行）。
 *
 * 为什么走服务器而不是 `ctx.newSession()`：后者会 abort + dispose 当前 runtime、
 * 把 TUI 切到新会话 —— 而我们要的是「下属会话在服务器里跑，只出现在 Web UI 的
 * 会话列表」。runtime 池在服务器进程里，所以“为事项开会话”必须交给它。
 *
 * 提示词渲染、会话命名、写 `a link` 关联全部在服务器侧完成（硬约束 #15：
 * 渲染只有 bin/ledger.mjs 一份）。这里只发起请求，并把人话带回来。
 */
async function openItemSessionOnServer(
	id: number,
	kind: "discuss" | "exec",
	parent?: string,
): Promise<{ file: string; name?: string }> {
	let res: Response;
	try {
		res = await fetch(`${SOPHO_BASE}/api/item-session`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(SOPHO_TOKEN ? { "x-sopho-token": SOPHO_TOKEN } : {}),
			},
			body: JSON.stringify({ id, kind, parent }),
		});
	} catch (err) {
		throw new Error(`连不上 sopho-pi 服务器（${SOPHO_BASE}）：${(err as Error)?.message ?? err}`);
	}
	const data = (await res.json().catch(() => ({}))) as { error?: string; file?: string; name?: string };
	if (!res.ok || !data.file) throw new Error(data.error ?? `服务器返回 HTTP ${res.status}`);
	return { file: data.file, name: data.name };
}

const DISCUSS_KICKOFF =
	"我从那场讨论回来了。请读一下刚写好的那份方案，然后：\n" +
	"1. 给我三行以内的摘要\n" +
	"2. 列出会影响下一步的未决问题（挑最重要的几条）\n" +
	"3. 问我要不要发令推进\n" +
	"不要自己开始写代码。";

const EXEC_KICKOFF =
	"我刚从执行会话回来。请读一下方案文档和它改动过的东西，然后：\n" +
	"1. 三行以内：到底做出了什么（有文件就说路径）\n" +
	"2. 列出执行者做了哪些假设（这些是我要审的）\n" +
	"3. 列出还没做完的，以及下一个可选动作\n" +
	"4. 问我下一步怎么办\n" +
	"不要自己继续往下做。";

/**
 * 把一行回报送进服务器，由它投递给上级（#12）。
 *
 * 双写里的另一半（账本）由调用方先写。这里只负责「叫醒上级」——
 * 所以**失败不致命**：服务器不在 / 投递失败都只当没发生，账本那条还在。
 */
async function sendReportToServer(file: string, text: string): Promise<void> {
	try {
		await fetch(`${SOPHO_BASE}/api/report`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(SOPHO_TOKEN ? { "x-sopho-token": SOPHO_TOKEN } : {}),
			},
			body: JSON.stringify({ file, text }),
		});
	} catch {
		// 回报不能把「交回」这个动作卡住。投递失败时账本里仍然有这条。
	}
}

export default function (pi: ExtensionAPI) {
	// ── ① 你直接敲 /discuss <id>：助手替你开会话，不用碰终端 ──────────
	// 会话开在服务器 runtime 池里（POST /api/item-session），不切当前 TUI。
	pi.registerCommand("discuss", {
		description: "开一个专属会话，把某条事项聊清楚，产出方案文档",
		handler: async (args, ctx) => {
			const id = Number.parseInt(args.trim(), 10);
			if (!Number.isInteger(id)) {
				ctx.ui.notify("用法：/discuss <id>", "error");
				return;
			}
			const item = await getItem(pi, id);
			if (!item) {
				ctx.ui.notify(`账本里没有 #${id}`, "error");
				return;
			}
			try {
				const { file } = await openItemSessionOnServer(id, "discuss", ctx.sessionManager?.getSessionFile?.());
				ctx.ui.notify(`已为 #${id} 开讨论会话（Web UI）：${path.basename(file)}`, "info");
			} catch (err) {
				ctx.ui.notify(String((err as Error)?.message ?? err), "error");
			}
		},
	});

	// ── ①b 你敲 /exec <id>：开执行会话，去做那条事项的「当前动作」─────
	pi.registerCommand("exec", {
		description: "开一个执行会话，去做某条事项的「当前动作」",
		handler: async (args, ctx) => {
			const id = Number.parseInt(args.trim(), 10);
			if (!Number.isInteger(id)) {
				ctx.ui.notify("用法：/exec <id>", "error");
				return;
			}
			const item = await getItem(pi, id);
			if (!item) {
				ctx.ui.notify(`账本里没有 #${id}`, "error");
				return;
			}
			if (!item.next) {
				ctx.ui.notify(`#${id} 还没有「当前动作」，先用 ledger 的 go 动作发令`, "error");
				return;
			}
			try {
				const { file } = await openItemSessionOnServer(id, "exec", ctx.sessionManager?.getSessionFile?.());
				ctx.ui.notify(`已为 #${id} 开执行会话（Web UI）：${path.basename(file)}`, "info");
			} catch (err) {
				ctx.ui.notify(String((err as Error)?.message ?? err), "error");
			}
		},
	});

	// ── ①c /back：从讨论/执行会话回到助手会话 ────────────────────
	pi.registerCommand("back", {
		description: "回到上一个会话（讨论结束后回到助手）",
		handler: async (_args, ctx) => {
			const target = parentSessionFile;
			if (!target) {
				ctx.ui.notify("没有上一个会话可回（这个会话不是从别的会话开出来的）", "error");
				return;
			}
			// 在切换前就取名字 —— 切换后旧 `pi` 失效，且在 `withSession` 里不能再用。
			// 讨论会话回来 → 汇报方案；执行会话回来 → 汇报做了什么
			const kickoff = (pi.getSessionName() ?? "").startsWith("推进：") ? EXEC_KICKOFF : DISCUSS_KICKOFF;
			await ctx.switchSession(target, {
				withSession: async (c) => {
					await c.sendUserMessage(kickoff);
				},
			});
		},
	});

	// ── ② 聊天里敲 `a "..."`，和 shell 里等价（不惊动模型）──────────
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = (event.text ?? "").trim();

		const bare = text === "a";
		const quoted = text.match(/^a\s+["'“]([\s\S]*)["'”]\s*$/);
		const sub = text.match(/^a\s+(ls|list|done|drop|ok|spec|retriage|add|path|help)(\s+[\s\S]*)?$/);
		// 严格匹配：只拦 `a` / `a "带引号的内容"` / `a <子命令>`，
		// 不拦任何以 a 开头的正常句子。
		if (!bare && !quoted && !sub) return { action: "continue" };

		const verb = quoted ? "add" : sub ? sub[1] : "";
		if (verb === "discuss") {
			// 在聊天里 `a discuss 1` 走助手的开会话路径，而不是 CLI 的启动路径
			const id = Number.parseInt((sub?.[2] ?? "").trim(), 10);
			if (Number.isInteger(id)) {
				openItemSessionOnServer(id, "discuss", ctx.sessionManager?.getSessionFile?.()).then(
					({ file }) => ctx.ui.notify(`已为 #${id} 开讨论会话（Web UI）：${path.basename(file)}`, "info"),
					(err) => ctx.ui.notify(String((err as Error)?.message ?? err), "error"),
				);
			} else ctx.ui.notify("用法：a discuss <id>", "error");
			return { action: "handled" };
		}

		const argv = quoted ? ["add", quoted[1]] : sub ? [sub[1], ...(sub[2] ?? "").trim().split(/\s+/).filter(Boolean)] : [];
		const r = await runLedger(pi, argv);
		pi.sendMessage({ customType: "ledger", content: joined(r), display: true });
		ctx.ui.notify(quoted ? "已记入账本" : "账本已更新", r.code === 0 ? "info" : "error");
		return { action: "handled" };
	});

	// ── ③ 开场建议：报出需要你决策的事，但不替你决定 ──────────────
	pi.on("session_start", async (event, ctx) => {
		parentSessionFile = event.previousSessionFile;
		const s = await snapshot(pi);
		if (!s) return;
		const openStates = new Set(["open", "blocked_on_human", "waiting_external"]);
		const active = s.items.filter((i) => openStates.has(i.state));
		if (active.length === 0) return;

		// 标签一律读账本算好的（--json 里的 tag / tone / stall）—— **不自己重算**。
		// 曾经这里自己判 spec/clarity/accepted，结果和账本分叉了：
		// #6 已经 a go 过、账本说 [推进中]，扩展还在报“缺信息需要聊”。
		const needTalk = active.filter((i) => i.tag === "[待聊]");
		const needGo = active.filter((i) => i.tag === "[有方案·待推进]");
		const needDecide = active.filter((i) => i.tag === "[待拍板]");
		const oldestDays = Math.max(0, ...active.map((i) => i.stall ?? 0));
		const line = [
			`账本 ${active.length} 条进行中`,
			needTalk.length ? `${needTalk.length} 条待聊` : "",
			needGo.length ? `${needGo.length} 条待推进` : "",
			needDecide.length ? `${needDecide.length} 条待拍板` : "",
			oldestDays >= 7 ? `最久 ${oldestDays} 天` : "",
		]
			.filter(Boolean)
			.join(" · ");
		ctx.ui.notify(
			line,
			needTalk.length || needGo.length || needDecide.length || oldestDays >= 7 ? "warning" : "info",
		);

		if (needTalk.length || needGo.length || needDecide.length) {
			const lines: string[] = [];
			if (needTalk.length) {
				lines.push(`有 ${needTalk.length} 条缺信息，需要先聊清楚：`, "");
				for (const it of needTalk) {
					lines.push(`  #${it.id}  ${it.text}`);
					if (it.note) lines.push(`       ${it.note}`);
				}
				lines.push("");
			}
			if (needGo.length) {
				lines.push(`有 ${needGo.length} 条方案已就绪，等你发令推进：`, "");
				for (const it of needGo) lines.push(`  #${it.id}  ${it.text}`);
				lines.push("");
			}
			if (needDecide.length) {
				lines.push(`有 ${needDecide.length} 条子项全部完成，等你拍板结项：`, "");
				for (const it of needDecide) lines.push(`  #${it.id}  ${it.text}`);
				lines.push("");
			}
			// 推进中但一周没消息的：不提醒就会烂掉（这正是“漏”的主要来源）
			// 推进中但一周没消息的：不提醒就会烂掉（这正是“漏”的主要来源）。
			// stall 也是账本算的 —— 父节点的 stall 是“它最久没动的那个子项”。
			const stalled = active.filter((i) => i.tone === "moving" && (i.stall ?? 0) >= 7);
			if (stalled.length) {
				lines.push(`有 ${stalled.length} 条推进中但一周没动：`, "");
				for (const it of stalled) {
					lines.push(`  #${it.id}  ${it.text}（${it.stall} 天没动）`);
					if (it.next) lines.push(`       └ ${it.next}`);
				}
				lines.push("");
			}
			lines.push("  想聊的说一声，我直接开专属会话；要推进的说一声，我标成推进中。");
			lines.push("");
			lines.push(
				"（给助手：用户同意聊某条时，必须调用 ledger 的 discuss 动作开会话 —— " +
					"不要在当前会话里直接开始澄清讨论。讨论需要在独立会话里跑，结果才会落到 specs/ 里。）",
			);
			pi.sendMessage(
				{ customType: "ledger-suggestion", content: lines.join("\n"), display: true },
			);
		}
	});

	pi.registerCommand("ledger", {
		description: "显示事项账本",
		handler: async () => {
			const r = await runLedger(pi, []);
			pi.sendMessage({ customType: "ledger", content: joined(r), display: true });
			return;
		},
	});

	pi.registerTool({
		name: "hand_back",
		label: "Hand Back",
		description:
			"把控制权交回上级会话，并附上一行回报。在你判断这一轮讨论/执行已经做完时调用；" +
			"没做完就不要调。report 是写给上级和用户看的**一行摘要**：做了什么、产物在哪" +
			"（有文件就给路径）。长内容不要塞在这里 —— 它应该落在方案文档/代码里，这里只指路。",
		parameters: Type.Object({
			report: Type.String({
				description: "一行以内的回报：这一轮到底做成了什么、产物在哪。上级会据此叫醒用户。",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 交回 = 这一局结束。普通会话写一条 closed，UI 据此把它折起来；
			// 失败不致命：交回本身不能被“标记”这个动作挡住。
			//
			// #12：交回的同时产出一行**回报**，双写 ——
			//   a report  → 账本留痕（投递失败/服务器重启也不丢）
			//   /api/report → 送进服务器投递队列，叫醒上级
			//
			// 现在下属会话开在服务器 runtime 池里（见 /api/item-session），不是 TUI
			// 切出来的，所以 parentSessionFile 通常为空 —— 没有“上一个 TUI 会话”可切。
			//
			// A′（#36）：**执行会话不写 closed**。长程任务的执行是一个持续的东西 ——
			// 服务器会把下一轮发回**同一个会话**（见 server/index.mjs 的 continueChain），
			// 所以它不该被当成“一局结束、折叠起来”的短会话。discuss 会话仍是一次性的，
			// 照旧写 closed。判定靠会话名（`推进：` = 执行 / `方案：` = 讨论）——
			// 和 /back 用的是同一个约定。
			const file = ctx?.sessionManager?.getSessionFile?.();
			const report = (params.report ?? "").trim();
			const isExec = (pi.getSessionName() ?? "").startsWith("推进：");
			if (file) {
				if (!isExec) await runLedger(pi, ["session", file, "closed"]);
				if (report) {
					await runLedger(pi, ["report", file, report]);
					await sendReportToServer(file, report);
				}
			}
			if (!parentSessionFile) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								(isExec
									? "这一局已结束：执行会话保持存活（不写 closed），下一轮会发回同一个会话"
									: "这一局已结束：会话标记为 closed") +
								(report ? "，并已把一行回报送回上级" : "") +
								"。",
						},
					],
					details: {},
				};
			}
			pi.sendUserMessage("/back", { deliverAs: "followUp", expandPromptTemplates: true });
			return { content: [{ type: "text" as const, text: "已把控制权交回助手会话。" }], details: {} };
		},
	});

	pi.registerTool({
		name: "ledger",
		label: "Task Ledger",
		description:
			"读写用户的事项账本（进行中的工作清单）。list 列出全部；add 捕获；complete/drop 结束；" +
			"confirm_clear 表示这条不用讨论；retriage 重判清晰度；read_spec 读方案；" +
			"discuss 专用于「需要和用户澄清某条事项」—— 它会开一个独立的专属会话并把澄清提示词放进去。" +
			"不要在普通会话里自己开始澄清讨论。",
		promptSnippet: "Read or update the user's task ledger of in-progress items",
		promptGuidelines: [
			"Use ledger with action \"list\" before asking the user what they are working on.",
			"Use ledger with action \"add\" when the user mentions something they intend to do, so it is not lost.",
			"Use ledger with action \"confirm_clear\" when the user says an item does not need a discussion.",
			"When the user agrees to discuss or clarify an item, you MUST call ledger with action \"discuss\". Do NOT start the clarifying conversation yourself in the current session — the dedicated session is where the discussion belongs, and only it writes the spec to specs/.",
			"Use ledger with action \"go\" when the user says an item's plan is good and they want to move forward. The go action REQUIRES a concrete current action (the next parameter) — confirm with the user what that is first, never invent one silently.",
			"Use ledger with action \"set_next\" (not \"go\") when you only need to update an item's current action from inside a sub-session — \"go\" also opens an execution session, which would spawn another execution.",
			"When calling set_next at the end of an execution, also pass next_kind: \"auto\" when the next action is inferable and can continue unattended, \"ask\" when it needs the user/upstream to decide. Omit = ask (the safe default).",
		],
		parameters: Type.Object({
			action: StringEnum(
				["list", "add", "complete", "drop", "confirm_clear", "retriage", "discuss", "go", "set_next", "read_spec"] as const,
				{ description: "要执行的动作" },
			),
			text: Type.Optional(Type.String({ description: "要捕获的原文，action=add 时必填" })),
			id: Type.Optional(Type.Number({ description: "事项 id，除 add/list 外均必填" })),
			next: Type.Optional(
				Type.String({ description: "当前动作：一句话说明现在具体做什么。action=go / set_next 时必填" }),
			),
			next_kind: Type.Optional(
				StringEnum(["auto", "ask"] as const, {
					description:
						"下一步的续跑种类：auto = 可推断、服务器可在这一轮结束后自动续跑；ask = 需要人拍板。不传 = ask。",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, id } = params;

			// set_next：只更新「当前动作」，**不**开会话。下属会话收尾用它 ——
			// 否则执行会话自己调 go 会再开一个执行，无限自环（踩过，链了 8 个）。
			if (action === "set_next") {
				if (id === undefined || !params.next?.trim()) {
					return {
						content: [{ type: "text" as const, text: "action=set_next 需要 id 和 next（当前动作）。" }],
						details: {},
					};
				}
				const r = await runLedger(pi, [
					"go",
					String(id),
					"--next",
					params.next,
					...(params.next_kind ? ["--kind", params.next_kind] : []),
				]);
				return { content: [{ type: "text" as const, text: joined(r) }], details: { action, id, code: r.code } };
			}

			// go 特殊：必须带「当前动作」，然后顺带把执行会话开起来。
			// 没有具体动作就不允许推进 —— 那只会让事项从列表里消失。
			if (action === "go") {
				if (id === undefined || !params.next?.trim()) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"action=go 需要 id 和 next（当前动作）两个参数。" +
									"先和用户确认「现在具体做什么」，再调这个动作。",
							},
						],
						details: {},
					};
				}
				const r = await runLedger(pi, ["go", String(id), "--next", params.next]);
				if (r.code !== 0) {
					return { content: [{ type: "text" as const, text: joined(r) }], details: { action, code: r.code } };
				}
				try {
					const { file } = await openItemSessionOnServer(id, "exec", ctx?.sessionManager?.getSessionFile?.());
					return {
						content: [
							{
								type: "text" as const,
								text: `${joined(r)}\n\n已在服务器开执行会话：${path.basename(file)}（只出现在 Web UI，不切当前会话）。`,
							},
						],
						details: { action, id, file },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${joined(r)}\n\n发令成功，但开执行会话失败：${(err as Error)?.message ?? err}`,
							},
						],
						details: { action, id },
					};
				}
			}

			// discuss 特殊：它要开一个新会话。现在会话开在服务器 runtime 池里
			// （POST /api/item-session），不再用 ctx.newSession() —— 所以这里直接调，
			// 不需要排 follow-up 命令。
			if (action === "discuss") {
				if (id === undefined) {
					return { content: [{ type: "text" as const, text: "action=discuss 需要 id 参数。" }], details: {} };
				}
				const item = await getItem(pi, id);
				if (!item) {
					return { content: [{ type: "text" as const, text: `账本里没有 #${id}` }], details: {} };
				}
				try {
					const { file } = await openItemSessionOnServer(id, "discuss", ctx?.sessionManager?.getSessionFile?.());
					return {
						content: [
							{
								type: "text" as const,
								text: `已在服务器开讨论会话 #${id}（${item.text}）：${path.basename(file)}。它只出现在 Web UI 的会话列表里，不切当前会话。`,
							},
						],
						details: { action, id, file },
					};
				} catch (err) {
					return {
						content: [{ type: "text" as const, text: `开会话失败：${(err as Error)?.message ?? err}` }],
						details: { action, id },
					};
				}
			}

			if (action === "add") {
				if (!params.text?.trim()) {
					return { content: [{ type: "text" as const, text: "action=add 需要 text 参数。" }], details: {} };
				}
				const r = await runLedger(pi, ["add", params.text]);
				return { content: [{ type: "text" as const, text: joined(r) }], details: { action, code: r.code } };
			}

			if (action === "list") {
				const r = await runLedger(pi, []);
				return { content: [{ type: "text" as const, text: joined(r) }], details: { action, code: r.code } };
			}

			if (id === undefined) {
				return { content: [{ type: "text" as const, text: `action=${action} 需要 id 参数。` }], details: {} };
			}
			const map: Record<string, string[]> = {
				complete: ["done", String(id)],
				drop: ["drop", String(id)],
				confirm_clear: ["ok", String(id)],
				retriage: ["retriage", String(id)],
				go: ["go", String(id)],
				read_spec: ["spec", String(id)],
			};
			const r = await runLedger(pi, map[action] ?? []);
			return { content: [{ type: "text" as const, text: joined(r) }], details: { action, code: r.code } };
		},
	});
}
