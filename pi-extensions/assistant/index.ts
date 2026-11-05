/**
 * sopho-pi v2.2 · pi 插件 —— 会话之间的工具。
 *
 * `session_set_title(title)` 给**本会话**起 / 改一个短标题（≤20 字）—— 会话树左栏显示的就是它。
 * 它走 `POST /sessions/{id}/title`（`{title}`）：扩展侧拿不到 pi 的「设会话名」API，
 * 所以由会话基底把它路由到**拥有这条会话的 owner worker**，由那里调 `session.setSessionName()`。
 * 标题的来源（seed / auto / manual，含「用户手动标题不被覆盖」）由服务端裁决。
 */
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	isToolCallEventType,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateImage, toolResultOf } from "./image-generate.mjs";
import { reclaimWorktree } from "./reclaim-worktree.mjs";
import { archiveWorktreeHint } from "./worktree-hint.mjs";

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused, self-contained prompt that:

1. Summarizes the relevant context from the conversation (decisions made, approaches taken, key findings, proper nouns and identifiers)
2. Lists the files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Can be understood without reading the old conversation

Output only the prompt itself, no preamble. This prompt is lossy: it is a summary, not the full history.`;

function baseUrl(): string {
	if (process.env.SOPHO_DELEGATION_URL) return process.env.SOPHO_DELEGATION_URL.replace(/\/$/, "");
	// 默认值 = 线上口径，与 bin/serve.sh / bin/serve-win.ps1 的默认 A 端口一致；显式 SOPHO_PORT 优先。
	const port = process.env.SOPHO_PORT || "7331";
	return `http://127.0.0.1:${port}`;
}

function currentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

async function request(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
	const response = await fetch(`${baseUrl()}${path}`, {
		method: options.method ?? "GET",
		signal: options.signal,
		headers: {
			accept: "application/json",
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const raw = await response.text();
	let value: any;
	try {
		value = raw ? JSON.parse(raw) : {};
	} catch {
		value = { message: raw };
	}
	if (!response.ok) {
		throw new Error(`${response.status} ${value.message || raw}\n${JSON.stringify(value, null, 2)}`);
	}
	return value;
}

async function requestRaw(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
	try {
		const response = await fetch(`${baseUrl()}${path}`, {
			method: options.method ?? "GET",
			signal: options.signal,
			headers: {
				accept: "application/json",
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const raw = await response.text();
		let value: any;
		try { value = raw ? JSON.parse(raw) : {}; } catch { value = { message: raw }; }
		return { statusCode: response.status, value };
	} catch (error) {
		return { statusCode: 0, value: { error: `连不上会话基底（${baseUrl()}）：${error instanceof Error ? error.message : String(error)}` } };
	}
}

// ─────────────────────── session_set_model（业主 2026-10-14 拍的选项②） ───────────────────────
// 默认改自己；显式 sessionId 只能是**自己的子会话**（判据：目标的 parentSession 解出来指向调用者 ——
// 宿主已解析的 `parentId`，或 `parentSessionPath` 逐字节等于自己的会话文件）。不是 ⇒ 如实拒绝并说明
// 理由，**绝不**静默改道成「改自己」。
// 实现规约（调研单 docs/plans/recon-2026-10-13-session-model-api.md §5.4/§6②，本单硬约束）：
// **只许转发** `POST /sessions/{id}/model` 这条 owner 路由 —— **绝不**调 ctx.setModel /
// session.setModel 之类进程内直写：pi 的 setModel 对在跑的回合**零守卫**，忙守卫全在逻辑层
// adapter.setModel（busyConflict ⇒ 409）。绕过路由会把「忙时如实拒绝」变成「悄悄生效」，
// 并绕开 owner 单写者那条纪律（历史上 model_change 双写分叉的口子，dbd5b20/cb2fd90 才堵上）。
// `persist` 固定 false（只改这一条会话；改全局默认是人的事，本工具不暴露那个参数）。
async function setSessionModel(
	ctx: ExtensionContext,
	params: { model?: string; sessionId?: string },
) {
	const caller = currentSessionId(ctx);
	const wanted = typeof params.model === "string" ? params.model.trim() : "";
	const target = typeof params.sessionId === "string" && params.sessionId.trim() !== "" ? params.sessionId.trim() : caller;
	const refused = (extra: Record<string, unknown>) => ({
		ok: false as const,
		statusCode: null as number | null,
		sessionId: target,
		requestedModel: wanted,
		changed: false,
		persist: false,
		...extra,
	});
	if (wanted === "") {
		return refused({ reason: "empty_model", note: "model 参数是必填（例如 litellm/deepseek-flash）；一个字没写 ⇒ 什么都没改。" });
	}

	// ① 目标裁定。显式目标先读它的会话事实，判「是不是自己的子会话」；读不出来就如实拒绝（不猜）。
	let detail: any = null;
	if (target !== caller) {
		const detailReply = await requestRaw(`/sessions/${encodeURIComponent(target)}`);
		detail = detailReply.value ?? {};
		if (detailReply.statusCode === 404) {
			return refused({ reason: "session_not_found", note: `没有这个会话（${target}）：核对完整 uuid 再试；什么都没改。` });
		}
		if (detailReply.statusCode !== 200) {
			return refused({ reason: detail.error ?? `HTTP ${detailReply.statusCode}`, message: detail.message ?? null, note: `读不到目标的会话事实（${detail.error ?? detail.message ?? "?"}），判不了「是不是你的子会话」⇒ 如实拒绝（不猜、也绝不静默改道成改自己）。` });
		}
		const ownFile: string | null = typeof (ctx.sessionManager as any)?.getSessionFile === "function" ? (ctx.sessionManager as any).getSessionFile() : null;
		const byId = typeof detail.parentId === "string" && detail.parentId.toLowerCase() === caller.toLowerCase();
		let byPath = false;
		if (!byId && typeof detail.parentSessionPath === "string" && ownFile) {
			byPath = path.resolve(detail.parentSessionPath).toLowerCase() === path.resolve(ownFile).toLowerCase();
		}
		if (!byId && !byPath) {
			return refused({
				parentId: detail.parentId ?? null,
				reason: "target_not_own_child",
				note: `没有改任何东西：${target} 不是你的子会话（它的 parentSession 解出来是 ${detail.parentId ?? "无"}，不是你 ${caller}）。`
					+ "这个工具只允许改自己和自己的子会话（业主 2026-10-14 的裁定）—— 不要把它当成改自己重试，也不要绕别的口子。",
			});
		}
	}

	// ② 先看可用清单：不在清单里 ⇒ 如实拒绝并**列出可用值**（不猜、不改）。
	const modelsReply = await requestRaw(`/sessions/${encodeURIComponent(target)}/models`);
	const modelsValue: any = modelsReply.value ?? {};
	if (modelsReply.statusCode !== 200) {
		return refused({ reason: modelsValue.error ?? `HTTP ${modelsReply.statusCode}`, message: modelsValue.message ?? null, note: `读不到目标的可用模型清单（${modelsValue.error ?? modelsValue.message ?? "?"}），改不了；什么都没改。` });
	}
	const available: any[] = Array.isArray(modelsValue.models) ? modelsValue.models : [];
	const refs: string[] = available.map((model) => `${model.provider}/${model.id}`);
	const refOf = (model: any) => `${model.provider}/${model.id}`;
	let selected: any = available.find((model) => refOf(model) === wanted) ?? null;
	let matchedBy: string | null = selected ? "provider/id" : null;
	const ambiguousRefusal = (candidates: string[]) => refused({ reason: "ambiguous_model", candidates, note: `「${wanted}」对上多条（${candidates.join(" / ")}）；请用完整的 provider/id 写法。什么都没改。` });
	if (!selected) {
		const byId = available.filter((model) => model.id === wanted);
		if (byId.length === 1) { selected = byId[0]; matchedBy = "id"; }
		else if (byId.length > 1) return ambiguousRefusal(byId.map(refOf));
	}
	if (!selected) {
		const lowered = wanted.toLowerCase();
		const insensitive = available.filter((model) => refOf(model).toLowerCase() === lowered || String(model.id).toLowerCase() === lowered);
		if (insensitive.length === 1) { selected = insensitive[0]; matchedBy = "case-insensitive"; }
		else if (insensitive.length > 1) return ambiguousRefusal(insensitive.map(refOf));
	}
	if (!selected) {
		return refused({ reason: "model_not_found", availableModels: refs, current: modelsValue.current ?? null, note: `可用清单里没有「${wanted}」：没有猜、没有改。可用值：${refs.join("、") || "（空）"}（当前是 ${modelsValue.current ?? "未知"}）。` });
	}

	// ③ 改之前的档位（pi 每次换模型都会随行重写思考档位 ⇒ 回执要能如实说「变没变」）。
	if (detail === null) {
		const detailReply = await requestRaw(`/sessions/${encodeURIComponent(caller)}`);
		detail = detailReply.statusCode === 200 ? (detailReply.value ?? {}) : null;
	}
	const thinkingLevelBefore = detail?.runtime?.thinkingLevel ?? null;

	// ④ 真正的写：**只走 owner 路由**。忙 ⇒ 409 原样透传（不排队、不重试、不静默、不假成功）。
	const reply = await requestRaw(`/sessions/${encodeURIComponent(target)}/model`, {
		method: "POST",
		body: { model: refOf(selected) },
	});
	const value: any = reply.value ?? {};
	if (reply.statusCode < 200 || reply.statusCode >= 300) {
		const busy = reply.statusCode === 409 && (value.error === "session_streaming" || value.error === "session_compacting");
		const note = busy
			? `目标正忙（${value.error}），**没有改**：这条 owner 路由对在跑/压缩中的会话就是 409 —— 不排队、不重试、不悄悄生效。`
				+ (target === caller ? "没传 sessionId ⇒ 目标是你自己；你自己的回合正在跑 ⇒ 你就是那个忙目标，这是路由的真实回答。" : "等目标空闲后再调一次。")
			: value.error === "model_not_found"
				? `路由侧说没有这个模型（清单可能刚变过）：没有改。重新核对 GET /sessions/{id}/models 的清单再试。`
				: `路由没有收（${value.error ?? `HTTP ${reply.statusCode}`}）：${value.message ?? ""} 没有改，如实上报，不要假装做过了。`;
		return refused({ statusCode: reply.statusCode, reason: value.error ?? null, message: value.message ?? null, note });
	}

	// ⑤ 改完回读一次：模型与思考档位的**当下事实**（而不是猜）。
	let after: any = null;
	const afterReply = await requestRaw(`/sessions/${encodeURIComponent(target)}`);
	if (afterReply.statusCode === 200) after = afterReply.value ?? {};
	const thinkingLevelAfter = after?.runtime?.thinkingLevel ?? null;
	const thinkingLevelChanged = thinkingLevelBefore !== null && thinkingLevelAfter !== null && thinkingLevelBefore !== thinkingLevelAfter;
	return {
		ok: true,
		statusCode: reply.statusCode,
		sessionId: target,
		targetRelation: target === caller ? "self" : "own-child",
		from: value.previous ?? null,
		to: value.model ?? refOf(selected),
		requestedModel: wanted,
		matchedBy: value.matchedBy ?? matchedBy,
		source: value.source ?? null,
		persist: false,
		thinkingLevelBefore,
		thinkingLevel: thinkingLevelAfter,
		thinkingLevelChanged,
		effective: "立即生效：这条会话的下一条消息/下一跳就用新模型（会话级；全局默认一字未动）。",
		note: `${target === caller ? "已把本会话" : `已把子会话 ${target}`}的模型从 ${value.previous ?? "?"} 换到 ${value.model ?? refOf(selected)}；persist=false，只改这一条。`
			+ (thinkingLevelChanged
				? `思考档位随换模型从 ${thinkingLevelBefore} 变到 ${thinkingLevelAfter}（pi 的随行行为，变了就报）。`
				: thinkingLevelAfter !== null ? `思考档位仍是 ${thinkingLevelAfter}（没变）。` : ""),
	};
}

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

// 委派路（宿主 `/spawn`）：task 省略时**只建会话、不起回合**（宿主侧同样按“非空 task 才投递”处理）。
// 回执的 `delivered` 只表示“任务投进去了”——没给 task 时它就是 false（没有任何东西被投递），
// 而 `ok` 仍表示会话建成了；两者不要混读。
async function spawnSession(
	ctx: ExtensionContext,
	params: { task?: string; name?: string; worktree?: "new"; share?: boolean; notify?: boolean },
	signal?: AbortSignal,
) {
	const task = typeof params.task === "string" && params.task.trim() !== "" ? params.task : undefined;
	const hasTask = task !== undefined;
	const requestSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
		: AbortSignal.timeout(35_000);
	const reply = await requestRaw(`/sessions/${currentSessionId(ctx)}/spawn`, {
		method: "POST",
		body: {
			...(hasTask ? { task } : {}),
			name: params.name,
			worktree: params.worktree,
			share: params.share,
			notify: params.notify,
		},
		signal: requestSignal,
	});
	const value: any = reply.value ?? {};
	const sessionId = value.childSessionId ?? value.sessionId ?? value.id ?? null;
	const created = reply.statusCode >= 200 && reply.statusCode < 300 && typeof sessionId === "string" && sessionId.length > 0;
	if (created) {
		return {
			...value,
			ok: true,
			delivered: hasTask,
			sessionId,
			statusCode: reply.statusCode,
			reason: hasTask ? (value.message ?? "task accepted") : "会话已建；没有 task ⇒ 没有起回合，也没有投递。",
		};
	}
	const reason = value.message ?? value.error ?? (reply.statusCode === 0 ? "会话基底不可达或请求超时" : "spawn 返回缺少 childSessionId");
	return {
		...value,
		ok: false,
		delivered: false,
		sessionId,
		sessionCreated: typeof sessionId === "string" && sessionId.length > 0,
		statusCode: reply.statusCode,
		reason,
		retryable: reply.statusCode === 0 || reply.statusCode === 408 || reply.statusCode === 409 || reply.statusCode >= 500,
		note: sessionId
			? `会话 ${sessionId} 已建，但任务没有投进去；不要把它当成已开始。可按 reason 判断是否重试或改用 session_send。`
			: "spawn 没有完成任务投递；没有可确认已创建的子会话。可按 reason 判断是否重试。",
	};
}

// 合并后的建会话工具（业主 2026-09-26：`spawn` 并入 `session_new`）。两条宿主路由各自的保证不同，
// 所以这里按参数选路，**不**把一条路的语义悄悄套到另一条上：
//   · 默认落点（不给 cwd）或要 worktree ⇒ 走委派路 `/spawn`：它按「父会话 cwd」建、**把父会话自己排除**在
//     工作区冲突之外、登记 notify、支持 worktree；task 可省（省了只建会话）。
//   · 显式 cwd ⇒ 走创建路 `/session-new`：它是唯一能落在**指定目录**的路，守卫更严（活会话 + 落盘投影），
//     但它**不**登记 notify（要唤醒那条子会话就用 session_send）。
// worktree 与 cwd 互斥：worktree 的目录由父仓库推出，给 cwd 没有落点。
const CREATE_REFUSAL_NOTE = "没有创建任何东西；如实上报，不要假装建过了。";

async function createSession(
	ctx: ExtensionContext,
	params: { task?: string; cwd?: string; name?: string; worktree?: "new"; share?: boolean; notify?: boolean },
	signal?: AbortSignal,
) {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const wantsWorktree = params.worktree === "new";
	const hasCwd = typeof params.cwd === "string" && params.cwd.trim() !== "";

	if (wantsWorktree && hasCwd) {
		return {
			ok: false,
			delivered: false,
			sessionId: null,
			statusCode: null,
			reason: "worktree:\"new\" 与 cwd 互斥：worktree 的目录由父仓库推出（<main-repo>/../.sopho-wt/<slug>），两者不能同时给。",
			note: CREATE_REFUSAL_NOTE,
		};
	}

	if (wantsWorktree || !hasCwd) {
		return spawnSession(ctx, {
			...(hasTask ? { task: params.task } : {}),
			name: params.name,
			worktree: params.worktree,
			share: params.share,
			notify: params.notify,
		}, signal);
	}

	const targetCwd = params.cwd as string;
	const reply = await requestRaw(`/sessions/${currentSessionId(ctx)}/session-new`, {
		method: "POST",
		body: {
			cwd: targetCwd,
			name: params.name,
			share: params.share,
			...(hasTask ? { firstMessage: params.task } : {}),
		},
	});
	const value: any = reply.value ?? {};
	const sessionId = value.childSessionId ?? value.sessionId ?? value.id ?? null;
	const created = reply.statusCode >= 200 && reply.statusCode < 300 && typeof sessionId === "string" && sessionId.length > 0;
	if (created) {
		return {
			...value,
			ok: true,
			delivered: hasTask,
			sessionId,
			statusCode: reply.statusCode,
			cwd: value.cwd ?? targetCwd,
			notifyRegistered: false,
			reason: hasTask ? (value.message ?? "task accepted") : "会话已建；没有 task ⇒ 没有起回合，也没有投递。",
			note: hasTask
				? `已在 ${value.cwd ?? targetCwd} 建好子会话并投出首条任务。这条路不登记 notify（要唤醒它就用 session_send）。`
				: `已在 ${value.cwd ?? targetCwd} 建好子会话，没有起回合。这条路不登记 notify。`,
		};
	}
	const reason = value.message ?? value.error ?? (reply.statusCode === 0 ? "会话基底不可达或请求超时" : "session-new 返回缺少 childSessionId");
	return {
		...value,
		ok: false,
		delivered: false,
		sessionId,
		sessionCreated: typeof sessionId === "string" && sessionId.length > 0,
		statusCode: reply.statusCode,
		cwd: value.cwd ?? targetCwd,
		reason,
		retryable: reply.statusCode === 0 || reply.statusCode === 408 || reply.statusCode === 409 || reply.statusCode >= 500,
		note: `${CREATE_REFUSAL_NOTE}（${reason}）`,
	};
}

function entryToHandoffMessage(entry: any): any | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

// Mirror pi's own handoff example: when the branch was compacted, keep the compaction
// summary plus the entries after firstKeptEntryId, otherwise the whole branch.
function handoffMessages(branch: any[]): any[] {
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index].type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) return branch.map(entryToHandoffMessage).filter((message) => message !== undefined);
	const compaction = branch[compactionIndex];
	const firstKeptIndex = compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compacted = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compacted.map(entryToHandoffMessage).filter((message) => message !== undefined);
}

// ctx.modelRegistry.complete() is usable inside a tool's execute (measured with a minimal
// probe, and exercised end-to-end by test/s4-handoff.mjs), so the summary is generated here
// in the plugin rather than in the logic layer.
async function generateHandoffSummary(ctx: ExtensionContext, goal: string, signal?: AbortSignal): Promise<string> {
	const messages = handoffMessages(ctx.sessionManager.getBranch() as any[]);
	if (messages.length === 0) throw new Error("没有可交接的对话内容");
	if (!ctx.model) throw new Error("当前没有选中的模型，无法生成摘要；可以显式传 summary 参数");
	const conversationText = serializeConversation(convertToLlm(messages));
	if (!conversationText.trim()) throw new Error("对话内容为空，无法生成摘要");
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for the New Thread\n\n${goal}` }],
		timestamp: Date.now(),
	};
	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
		{ signal, cacheRetention: "none" },
	);
	if (response.stopReason === "aborted") throw new Error("摘要生成被中止");
	if (response.stopReason === "error") throw new Error(`摘要生成失败：${response.errorMessage ?? "模型返回了错误"}`);
	const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	if (!text.trim()) throw new Error("摘要生成结果为空");
	return text;
}

// Shared by the handoff tool and the /handoff command: build (or accept) a summary, then
// ask the logic layer to create the sibling session and append to handoffs.jsonl.
async function runHandoff(
	ctx: ExtensionContext,
	params: { goal: string; to?: { cwd?: string; device?: string; sameCwd?: boolean }; compress?: "llm" | "session"; summary?: string; share?: boolean },
	signal?: AbortSignal,
) {
	const sessionId = currentSessionId(ctx);
	const compress = params.compress ?? "llm";
	const body: Record<string, unknown> = { goal: params.goal, compress };
	if (params.to) body.to = params.to;
	if (params.share !== undefined) body.share = params.share;
	if (compress === "llm") {
		let summary = typeof params.summary === "string" && params.summary.trim() !== "" ? params.summary : null;
		let summaryError: string | null = null;
		if (!summary) {
			try {
				summary = await generateHandoffSummary(ctx, params.goal, signal);
			} catch (error) {
				summaryError = error instanceof Error ? error.message : String(error);
			}
		}
		if (summary) body.summary = summary;
		if (summaryError) body.summaryError = summaryError;
	}
	const value: any = await request(`/sessions/${sessionId}/handoff`, { method: "POST", body });
	// Never let a caller think the full history travelled: the computed summary is lossy.
	return { ...value, lossyNotice: "传过去的是摘要，不是全文（有损）：新会话拿到的是自包含的一段上下文，不是源会话的全部历史。" };
}

// `/handoff` 的落点**必须显式**（2026-09-21 真事故：goal 写着 `~/Documents/godot`，而这条命令路径
// 连 `to` 都不构造 ⇒ 逻辑层静默沿用源会话的 cwd、新会话被绑进源仓，而它第一条任务书里写着 godot）。
// 这里只解析参数，**不替用户猜目录**：没给 `--cwd` / `--here` 就不发请求，只回一条用法 + 候选。
function splitCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const character of input) {
		if (quote !== null) {
			if (character === quote) quote = null;
			else current += character;
			continue;
		}
		if (character === "\"" || character === "'") { quote = character; continue; }
		if (character === " " || character === "\t" || character === "\n" || character === "\r") {
			if (current !== "") { tokens.push(current); current = ""; }
			continue;
		}
		current += character;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

type HandoffCommand =
	| { params: { goal: string; to?: { cwd?: string; device?: string; sameCwd?: boolean } } }
	| { error: string }
	| { needsDestination: true; goal: string };

// 允许带引号：「/handoff --cwd "C:\my dir" 目标」；其它一律按空白切。
function parseHandoffCommand(input: string): HandoffCommand {
	const tokens = splitCommandArgs(input.trim());
	if (tokens.length === 0) return { needsDestination: true, goal: "" };
	const to: { cwd?: string; device?: string; sameCwd?: boolean } = {};
	const goalTokens: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--here" || token === "--same-cwd" || token === "--samecwd") { to.sameCwd = true; continue; }
		if (token === "--cwd" || token === "--to") {
			const value = tokens[index + 1];
			if (value === undefined) return { error: `${token} 后面要跟一个**已存在**的目录，例如 /handoff --cwd /c/Users/me/proj 目标` };
			to.cwd = value;
			index += 1;
			continue;
		}
		if (token === "--device") {
			const value = tokens[index + 1];
			if (value === undefined) return { error: "--device 后面要跟 devices.json 里的设备名（跨设备还没做，会被如实拒绝）" };
			to.device = value;
			index += 1;
			continue;
		}
		goalTokens.push(token);
	}
	const goal = goalTokens.join(" ").trim();
	if (to.cwd !== undefined && to.sameCwd === true) return { error: "--cwd 与 --here 互相矛盾：要么给目标目录、要么明写沿用当前 cwd，不许两个都给。" };
	if (to.cwd === undefined && to.sameCwd !== true && to.device === undefined) return { needsDestination: true, goal };
	if (goal === "") return { error: "目标（goal）不能为空：用法 /handoff (--cwd <目录> | --here) <目标>" };
	return { params: { goal, ...(Object.keys(to).length > 0 ? { to } : {}) } };
}

function absoluteToken(token: string): string | null {
	// 只处理**绝对**形状（`~` / `X:\` / POSIX `/` / git-bash 的 `/c/...`）：相对路径没法在当前
	// 上下文里可靠解读（那会是 worker 的 cwd，不是会话的 cwd），宁可不说也不猜。
	const bashDrive = /^\/([A-Za-z])\//.exec(token);
	if (bashDrive) return `${bashDrive[1].toUpperCase()}:\\${token.slice(3).replace(/\//g, "\\")}`;
	if (token.startsWith("~")) return path.join(os.homedir(), token.slice(1));
	if (path.isAbsolute(token)) return token;
	return null;
}

// 只给**候选**、绝不替用户选：把 goal 里看起来像目录的绝对词拿去向 `/env` 问一次，
// 存在的就列出来（问不出来就什么都不说，不把探测失败当"不存在"）。
async function goalDirectoryCandidates(goal: string, limit = 3): Promise<string[]> {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const token of splitCommandArgs(goal)) {
		if (found.length >= limit) break;
		const absolute = absoluteToken(token);
		if (absolute === null) continue;
		const cwd = path.resolve(absolute);
		if (seen.has(cwd)) continue;
		seen.add(cwd);
		try {
			const environment: any = await request(`/env?${new URLSearchParams({ cwd })}`);
			if (environment?.isDirectory === true) found.push(`${environment.cwd ?? cwd}（你写的“${token}”）`);
		} catch {
			// 问不出来就不猜
		}
	}
	return found;
}

// ─────────────────────── 给内置 bash 补默认超时（v2.1 的安全网，v2.2 补回来） ───────────────────────
// 起因：pi 的 bash 工具 `timeout` 是**可选、无默认**（内置 schema 原文「no default timeout」）——
// 模型不传 `timeout`，那条命令就**没有上限**。v2.1 实际吃过两次：一条 `grep -r` 从整棵用户目录起搜
// 卡 14 分钟、一条 254 个文件的扫描卡 32 分钟以上 —— 会话卡在 `streaming:true`、界面不显示、
// 收不了新消息，人只能从外面按精确 pid 杀。诊断单 `docs/plans/diagnosis-2026-10-09-tool-timeout-interrupt.md`
// 的提案①把这条列为第一优先：判定是「中断逻辑今天有、超时逻辑今天没有」，而 v2.1 的这层没收进 v2.2。
//
// 做法：走 pi 官方的 `tool_call` 钩子 —— `event.input` 是**可变**的，官方保证「改它就会影响真正执行
// 的那次调用」（`docs/extensions.md` 的 `#### tool_call`）。内置 bash **仍是内置那份**：不注册同名工具、
// 不重写执行逻辑，只补一个缺省参数。只补**缺省**：模型显式传了 `timeout` 就一字不动（含 0 / 负数
// —— 那是显式意图，交给内置校验去报错）；别的工具（read / edit / …）一概不碰。
//
// 到点后的行为与今天**完全一致**（诊断单 §2.1/§2.3 实测）：走 pi 已有的那条终止路径 ——
// `killProcessTree` 真终止整棵进程树、**已收到的部分输出全部保留**、结果里如实写
// `Command timed out after N seconds`（而**不是** `Command aborted`，那是「用户主动打断」的归因）。
// 这一层**不自己写 kill**，也不把「用户按停止」当成超时。
//
// ⚠️ **诚实缺口**（v2.1 原文照搬）：这条改不了**模型看到的工具描述**（schema 里那句
// "no default timeout" 还在）⇒ 它只是「最坏情况有个上限」的安全网，不是协议变更。
//
// 取值理由 1800s（30 分钟）：本机真有十几分钟的长活（ARM64 引擎基线构建、真机性能采集）；
// 30 分钟 ≈ 那条天花板（~20 分钟）的 1.5 倍。两个前提：① 误杀代价高于卡久一点；
// ② 两次事故的命令都是**不会自己结束**的，任何有限上限都兜得住。上限的职责只是「不无限」。
const DEFAULT_BASH_TIMEOUT_S = 1800;

/** 读一次默认值：`SOPHO_BASH_TIMEOUT`（秒）> 内置 1800。
 *  `0` / `off` / `none` / `false` / `no` = **显式关掉**这层安全网（回到「没超时」的老行为）。
 *  坏值（非数字 / 负数）→ 退回内置默认，**绝不抛** —— 这个 handler 每次工具调用都跑，
 *  它一抛就变成「把该工具 fail-safe 拦下」（官方语义：`tool_call` 抛异常 = 拦下该调用）。 */
function bashTimeoutDefault(): number | null {
	const raw = process.env.SOPHO_BASH_TIMEOUT?.trim();
	if (!raw) return DEFAULT_BASH_TIMEOUT_S;
	if (/^(0|off|none|false|no)$/i.test(raw)) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_BASH_TIMEOUT_S;
}

// ─────────────── 「按名字 / 按模式杀进程」的形状闸（2026-10-14 事故的直接修法） ───────────────
// 起因（一手）：`docs/plans/diagnosis-2026-10-14-host-exit.md`。2026-10-14T13:42:51.380Z，一条子会话
// `2715e86a` 只想清它自己为压测起的 3 个满载 node，发了 `taskkill //F //IM node.exe //FI "PID ne $$"`；
// `//IM` 是**按镜像名**匹配，`TerminateProcess` 掉**整机所有 `node.exe`** —— 宿主 A（`base.mjs`，36296）、
// 应用 B（`app.mjs`，55924）、以及**它自己那条命令的调用者**一起没了（那条 `toolCall` 永远没有
// `toolResult`）；宿主日志**在半句话上干净切断**、无 SIGTERM、无 fault、无 OOM。
// 这正是 `AGENTS.md` 第 1 条「**绝不用 `pkill`** —— 模式常常出现在**你自己那条命令行**里，于是把自己
// 杀掉；一律按 pid 杀」的**同一形状**，只是整机尺度 ⇒ 纪律写了、闸没有，本段就是补那道闸。
//
// 判据（形状闸，**默认拒绝**并给出可行动的提示）：命中下面任一形状 ⇒ `tool_call` 返回
// `{ block: true, reason }`（官方语义：拦下该调用、模型看到 reason，能把命令**改成按 pid**）：
//   · `taskkill … /IM <名字>`（`/IM` `-IM` `//IM` `\IM` 都算）
//   · PowerShell `Stop-Process -Name <名字>`（含位置参数写法：`Stop-Process notepad`）
//   · `Get-Process … | Stop-Process`（把按名字查出来的进程直接喂给 Stop-Process）
//   · `pkill` / `killall`（任何参数 —— 纪律明令禁止的那条）
//   · `wmic process … delete` / `wmic process … call terminate`（按名字谓词、或无 where 的批量删）
// ⚠️ **必须放行**：`taskkill /F /PID <精确数字>`、`kill <pid>`、以及一切无关命令 ——
// 「按 pid 杀」是纪律要求的**正确做法**，闸不许误伤它。
//
// 只认形状、不做沙箱：它拦不住的至少见 `docs/ops/handoff.md` 的「这道闸拦不住什么」。

/** 取一个词的可执行名：去引号、去路径、去 `.exe`、小写。 */
function commandBaseName(token: string): string {
	const trimmed = token.replace(/^["']|["']$/g, "");
	const last = trimmed.split(/[\\/]/).pop() ?? trimmed;
	return last.replace(/\.exe$/i, "").toLowerCase();
}

// 会在真正命令前“包一层”的启动器：跳过它们（与它们自己的开关 / `VAR=value`）再看命令词，
// 这样 `sudo pkill`、`env FOO=1 pkill`、`xargs -r pkill` 都能认出来。
const KILL_LAUNCHERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "ionice", "setsid", "stdbuf", "xargs"]);

/** 一个命令片段里**真正执行**的那个命令词（跳过启动器与 `VAR=value`），认不出来返回 null。 */
function leadingCommandWord(segment: string): string | null {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length) {
		const raw = tokens[index];
		if (/^\w+=/.test(raw)) { index += 1; continue; }
		const base = commandBaseName(raw);
		if (KILL_LAUNCHERS.has(base)) {
			index += 1;
			// 跳过启动器自己的开关 / 赋值；`xargs` 的 `-I{}`、`-n1` 这类都一样跳。
			while (index < tokens.length && (/^-/.test(tokens[index]) || /^\w+=/.test(tokens[index]))) index += 1;
			continue;
		}
		return base;
	}
	return null;
}

/** `Stop-Process` 是否**按名字**杀：显式 `-Name`，或位置参数（PowerShell 的位置参数就是 `-Name`）。
 *  `Stop-Process -Id 1234` / `-Id $p.Id` 一律**不算**（那是按 pid，放行）。 */
function stopProcessByName(segment: string): boolean {
	const words = segment.split(/\s+/).filter(Boolean);
	for (let i = 0; i < words.length; i += 1) {
		const base = commandBaseName(words[i]);
		if (base !== "stop-process" && base !== "spps") continue;
		for (let j = i + 1; j < words.length; j += 1) {
			const arg = words[j].replace(/^["']|["']$/g, "");
			if (/^-(id|inputobject)$/i.test(arg)) {
				const value = words[j + 1];
				// `-Id (Get-Process node).Id` / `-Id $p.Id`：值是表达式，认不准就不拦（宁漏勿误伤按 pid）。
				if (value && /^[($@`]/.test(value)) return false;
				j += 1;
				continue;
			}
			if (/^-name/i.test(arg)) return true; // `-Name node` / `-Name:node` / `-Name=node`
			if (/^-/.test(arg)) continue; // 别的开关
			if (/^[($@`"']/.test(arg)) return false; // 表达式实参：认不准就不拦
			return true; // 裸词 = PowerShell 位置参数 `-Name`（含数字：位置参数是名字，不是 id）
		}
	}
	return false;
}

/** `wmic` 是不是在**按名字**删进程：`process … delete` / `call terminate`，且 where 谓词不是纯 pid。 */
function wmicDeletesByName(segment: string): boolean {
	if (!/\bwmic\b/i.test(segment)) return false;
	if (!/\bdelete\b/i.test(segment) && !/\bcall\s+terminate\b/i.test(segment)) return false;
	if (!/\bprocess\b/i.test(segment) && !/\bwin32_process\b/i.test(segment)) return false;
	// 纯 `processid=` 谓词、且没有按名字/命令行的谓词 ⇒ 是按 pid 的写法，放行。
	const pidAddressed = /\bprocessid\s*=/i.test(segment) && !/\b(name|commandline|imagename)\s*=/i.test(segment);
	return !pidAddressed;
}

/** `taskkill` 的 `/IM` 开关（`/IM` `-IM` `//IM` `\IM` 都算）。单独成常量：那串正则的反斜杠
 *  太密，反证臂的接缝串不去碰它。 */
const TASKKILL_IMAGE_SWITCH = /(?:^|\s)(?:\/\/|[\\/-])im(?=[\s"']|$)/i;

/** 命中按名字/按模式杀进程的形状就返回拒绝理由，否则 null。**默认拒绝**（没有逃生口，理由见注释）。 */
function nameKillRefusal(command: unknown): string | null {
	if (typeof command !== "string" || command.trim() === "") return null;
	// 按 `&&` `||` `;` `&` `|` 换行切成片段：每个片段独立判，避免把两条命令串成一条误判。
	const segments = command.split(/&&|\|\||[;&|\n]/).map((part) => part.trim()).filter(Boolean);
	const hits: string[] = [];

	// ① taskkill 按镜像名：/IM | -IM | //IM | \IM
	if (segments.some((segment) => /\btaskkill\b/i.test(segment) && TASKKILL_IMAGE_SWITCH.test(segment))) {
		hits.push("`taskkill … /IM <名字>`（按镜像名杀整机所有同名进程）");
	}
	// ② PowerShell Stop-Process 按名字
	if (segments.some((segment) => stopProcessByName(segment))) {
		hits.push("PowerShell `Stop-Process -Name <名字>`（含位置参数写法）");
	}
	// ③ pkill / killall（任何参数）
	for (const segment of segments) {
		const word = leadingCommandWord(segment);
		if (word === "pkill" || word === "killall") { hits.push(`\`${word}\`（按名字/模式杀进程）`); break; }
	}
	// ④ wmic 按名字删进程
	if (segments.some((segment) => wmicDeletesByName(segment))) {
		hits.push("`wmic process … delete` / `call terminate`（按名字谓词或无 where 的批量删）");
	}
	// ⑤ Get-Process … | Stop-Process
	if (/(?:get-process|\bgps\b)[^\n]*\|[^\n]*(?:stop-process|\bspps\b)/i.test(command)) {
		hits.push("`Get-Process … | Stop-Process`（把按名字查出来的进程直接杀）");
	}

	if (hits.length === 0) return null;
	return [
		`【工具层形状闸】按名字/按模式杀进程已被拦下 —— 命中：${hits.join("、")}。`,
		"",
		"为什么拦：这类写法按**名字/模式**匹配进程，会命中**整机所有同名进程** —— 不只你想清的那几个，",
		"还包括宿主 A（`node server/base.mjs`）、应用 B、以及**跑这条命令的你自己那条调用链**。",
		"2026-10-14T13:42:51.380Z 一条子会话只想清自己起的 3 个满载 node，发了 `taskkill /F /IM node.exe`，",
		"结果把整机所有 node.exe（含宿主与它自己）一起 TerminateProcess 掉，宿主日志在半句话上干净切断。",
		"这正是 AGENTS.md 第 1 条「绝不用 pkill —— 模式常常出现在你自己那条命令行里，于是把自己杀掉；",
		"一律按 pid 杀」的同一形状，只是整机尺度。",
		"",
		"怎么改才对（**按 pid 杀一律放行**）：",
		"  1) 先只读地拿到**精确 pid**：",
		"     · Windows：`tasklist /FI \"IMAGENAME eq node.exe\"`",
		"     · 更细（能看到命令行）：`Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Format-Table ProcessId,CommandLine`",
		"  2) 认准你要清的**那一个** pid，再 `taskkill /F /PID <精确 pid>`（不带 /IM）；POSIX 上 `kill <pid>`。",
		"  3) 要清自己刚起的一棵树：先记下它的 pid，按 pid 杀，别按名字批量杀。",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	// 给内置 bash 补缺省超时（事实与取值理由见上面 `bashTimeoutDefault`）。
	// 只补缺省：模型显式给了 timeout 就一字不动；别的工具不碰。
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.timeout != null) return;
		const t = bashTimeoutDefault();
		if (t != null) event.input.timeout = t;
	});

	// 「按名字/按模式杀进程」的形状闸（事实与取值理由见上面 `nameKillRefusal`）。
	// 命中 ⇒ 拦下该 bash 调用，reason 里写清「按名字会命中整机所有同名进程 ＋ 怎么改成按 pid」。
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const refusal = nameKillRefusal(event.input.command);
		if (refusal !== null) return { block: true, reason: refusal };
	});

	pi.registerTool({
		name: "session_new",
		label: "Create a session (optionally delegate a task)",
		description: [
			"Create a child of the current session. With task it immediately sends the task as the child's first user message; with task omitted it only creates the session and starts no turn.",
			"The receipt always says delivered:true/false, but delivered only means the task was handed over, so it is false when no task was given even though the session was created. A failed delivery includes sessionId when creation already happened, plus statusCode and reason so the caller can decide whether to retry.",
			"cwd defaults to this session's own cwd; it may name another existing local directory to create the child there. This creates a separate session; it does not move or retarget the current session.",
			"Hard workspace guard: if another session already uses the target cwd, nothing is created and the result lists each conflicting session (id, name, running state, and git dirty state), because two agents editing one tree can overwrite each other; this session's own occupancy is not counted against itself in the default cwd.",
			"Use worktree:\"new\" only inside a git repository to create an isolated sibling worktree/branch; non-git directories are explicitly rejected and never silently shared. worktree:\"new\" and cwd are mutually exclusive.",
			"Use share:true only when you knowingly accept concurrent edits in the same directory.",
			"notify defaults to true and wakes this parent only after the child has settled and then stayed quiet for the configured window (20s by default), not at every round end. It applies to a delegated task in the default cwd; targeting another cwd through cwd registers no notify, so use session_send for a wake-up there.",
		].join(" "),
		promptSnippet: "Create a child session (optionally delegating a task) with workspace-conflict protection",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "Task to send as the child's first user message" })),
			cwd: Type.Optional(Type.String({ description: "Existing local directory for the new session; defaults to this session's cwd" })),
			name: Type.Optional(Type.String({ description: "Display name for the child session" })),
			worktree: Type.Optional(StringEnum(["new"] as const, { description: "Create an isolated git worktree and branch" })),
			share: Type.Optional(Type.Boolean({ description: "Explicitly accept sharing the target cwd with other live sessions" })),
			notify: Type.Optional(Type.Boolean({ description: "Wake this parent after the child is truly quiet; default true" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(await createSession(ctx, params, signal));
		},
	});

	pi.registerTool({
		name: "cwd",
		label: "Show working directory",
		description: [
			"Read this session's working directory and stable facts needed to choose where to work: existence/writability, git repository root/branch/dirty state, AGENTS.md, worktree status, other live sessions in the directory, and recently used directories.",
			"This tool is read-only and cannot move or retarget the current session. pi binds runtime state and session storage to the cwd when the session is created.",
			"To work elsewhere, use session_new to create a separate child session in that directory.",
		].join(" "),
		promptSnippet: "Inspect this session's cwd, git facts, co-located sessions, and recent directories without changing anything",
		promptGuidelines: [
			"Use cwd when you need to know which directory this session works in. It is read-only; use session_new to work in another directory.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const query = new URLSearchParams({ cwd: ctx.cwd });
			const [environment, recentReply] = await Promise.all([
				request(`/env?${query}`, { signal }),
				requestRaw("/cwd-recents?limit=12", { signal }),
			]);
			const recentLedger: any = recentReply.value ?? {};
			const currentId = currentSessionId(ctx);
			const sessions = (environment.sessions ?? [])
				.filter((session: any) => session.id !== currentId && session.archived !== true)
				.map((session: any) => ({ id: session.id, name: session.name ?? null, status: session.status ?? null }));
			const recentDirectories = (recentReply.statusCode === 200 && Array.isArray(recentLedger.recents) ? recentLedger.recents : []).map((entry: any) => ({
				cwd: entry.cwd,
				at: entry.at,
			}));
			return toolResult({
				cwd: environment.cwd,
				exists: environment.exists === true,
				isDirectory: environment.isDirectory === true,
				writable: environment.writable === true,
				agentsMd: environment.agentsMd ?? null,
				git: {
					isRepository: environment.git?.isGit === true,
					root: environment.git?.root ?? null,
					mainRepository: environment.git?.mainRepo ?? null,
					branch: environment.git?.branch ?? null,
					dirty: environment.git?.dirty ?? null,
					worktree: environment.git?.worktree === true,
				},
				sessions,
				recentDirectories,
				recents: {
					exists: recentReply.statusCode === 200 ? recentLedger.exists === true : null,
					error: recentReply.statusCode === 200 ? (recentLedger.error ?? null) : (recentLedger.message ?? recentLedger.error ?? `HTTP ${recentReply.statusCode}`),
					limit: 12,
				},
				readOnly: true,
			});
		},
	});

	pi.registerTool({
		name: "session_send",
		label: "Send to session",
		description: "Send a typed delegation message to a full session UUID and wake it. notify defaults to true: the sender is woken only after the target later settles and remains quiet for the configured window, never merely at a round boundary.",
		promptSnippet: "Send a message to another session and wake it",
		parameters: Type.Object({
			id: Type.String({ description: "Target session's full UUID; prefixes are not accepted" }),
			text: Type.String({ description: "Message to deliver" }),
			notify: Type.Optional(Type.Boolean({ description: "Wake this sender after the target is truly quiet; default true" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(await request(`/sessions/${params.id}/send`, {
				method: "POST",
				body: { fromSessionId: currentSessionId(ctx), text: params.text, notify: params.notify },
			}));
		},
	});

	pi.registerTool({
		name: "session_read",
		label: "Read session status",
		description: "Read one session's honest runtime status and recent messages. The result measures the final assistant message's text-body length and explicitly marks a zero-length body, which can happen when all visible output went to reasoning/thinking.",
		promptSnippet: "Inspect another session's status and recent messages",
		parameters: Type.Object({
			id: Type.String({ description: "Session's full UUID; prefixes are not accepted" }),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Number of recent messages; default 4" })),
		}),
		async execute(_toolCallId, params) {
			const query = new URLSearchParams({ lines: String(params.lines ?? 4) });
			return toolResult(await request(`/sessions/${params.id}/session-read?${query}`));
		},
	});

	pi.registerTool({
		name: "session_push",
		label: "Push to parent",
		description: "Send a report to this session's parent and wake it. The parent is derived from this session file header's parentSession path; no separate parent ledger is used.",
		promptSnippet: "Report back to this session's parent and wake it",
		parameters: Type.Object({
			text: Type.String({ description: "Report to deliver to the parent" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(await request(`/sessions/${currentSessionId(ctx)}/push`, {
				method: "POST",
				body: { text: params.text },
			}));
		},
	});

	pi.registerTool({
		name: "question_ask",
		label: "Ask the user for a decision",
		description: [
			"Ask the user one thing that needs their decision, recorded as a durable entry in THIS session's own file (append-only custom entry `sopho.question`).",
			"The user CANNOT see your thinking, and the questions page shows only this entry. So the question must be self-contained: the facts the user needs go in `context`, each option's meaning/cost goes in `options`, and `text` is only the one-sentence question.",
			"It does NOT block this session: no prompt is queued, the streaming state is unchanged, and you are not required to wait for the answer.",
			"Dedupe: when an UNANSWERED question with the same normalized text already exists, this does not open a second one — it returns that existing id with deduped:true; force:true refreshes that same entry (context/text/options/priority) instead of being deduped into it.",
			"Update instead of re-asking: pass `questionId` (an id from question_list) and this UPDATES that one existing OPEN question in place (rewrite text/context/options/priority) instead of opening another — the asked-at/by and the open count stay unchanged, and only the fields you pass change. Already answered or closed questions are refused (409 question_not_open) — ask a new question instead. Omitting `questionId` behaves exactly as before.",
			"Only the human answers questions (in the webui); there is no answer_question tool. An answer arrives as a normal user message marked 〔回答#q-xxxxxxxx〕, so you will see it in the conversation and can continue from there.",
			"Use question_close for a question you no longer need answered.",
		].join(" "),
		promptSnippet: "Ask the user one thing that needs their decision (always with the facts in `context`)",
		promptGuidelines: [
			"问用户之前，**必须**把判断所需的事实写进 `context`：**用户看不到你的 thinking**，他只看这一条。写清为什么问、你已经查到的关键数字/结论、当前在做哪条工作线、每个候选各意味着什么代价 —— **不许**只给一句话加两个选项。缺 `context`（或不足 40 字）会被服务端 400 `question_needs_context` 拒掉，一个字都不落。",
			"每个候选都要自带含义与代价（例如「升到 3.5.1（最省事，只管读）」），不要写成光秃秃的标签（例如「Thorium」）。",
			"需要用户拍板的事用 question_ask 记一条，然后**继续干活**，不要停下来等 —— 回答会作为一条 〔回答#q-xxxxxxxx〕 用户消息回到这个会话。",
			"同一个问题不要反复问：同文再问会被去重（返回既有 id，deduped:true）。",
			"**事实变了就更新那一条，不要新开**：反复收到 subagent 结果时，同一个待确认事项的背景/选项会变 —— 把 question_list 给的 id 传给 `questionId`，改写 text/context/options/priority（只改你给的字段；问的时刻与未答数不变）。已答/已关的**不能改**（409），真需要就新开一条（去掉 `questionId`）。",
		],
		parameters: Type.Object({
			context: Type.String({
				description: "REQUIRED. The facts the user needs in order to decide - they cannot see your thinking or the conversation, only this entry. Write: why you are asking, the key numbers/conclusions you already established, which work line this is on, and what each option costs or means. At least 40 characters. A question with only `text` plus bare `options` is not answerable - this is where the answerability comes from.",
			}),
			text: Type.String({ description: "The question itself, one sentence. It is NOT the whole entry: the facts go in `context`, and each option's meaning/cost goes in `options`." }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Optional candidate answers shown as buttons. If given, each one must carry its own meaning and cost (e.g. \"升到 3.5.1（最省事，只管读）\"), not a bare label (e.g. \"Thorium\")." })),
			priority: Type.Optional(StringEnum(["normal", "high"] as const, { description: "normal (default) or high" })),
			force: Type.Optional(Type.Boolean({ description: "When the same unanswered question already exists: refresh that entry instead of being deduped into it" })),
			questionId: Type.Optional(Type.String({ description: "Id of an OPEN question to UPDATE in place (from question_list, like q-1a2b3c4d) instead of opening a new one. Only the fields you pass change; asked-at/by and the open count stay unchanged. Already answered/closed questions are refused (409 question_not_open) - ask a new question instead (omit this)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = currentSessionId(ctx);
			// 业主 2026-09-21 拍板：给了 `questionId` ⇒ **更新那一条**（不改历史、不新开），
			// 不给 ⇒ 逐字走今天的 ask 路（body 一字不变，`force` 语义不动）。
			const updateId = typeof params.questionId === "string" && params.questionId !== "" ? params.questionId : null;
			const reply = await requestRaw(`/sessions/${id}/questions`, {
				method: "POST",
				body: updateId === null
					? { context: params.context, text: params.text, options: params.options, priority: params.priority, force: params.force }
					: { op: "update", qid: updateId, text: params.text, context: params.context, options: params.options, priority: params.priority },
			});
			const value: any = reply.value ?? {};
			const ok = reply.statusCode >= 200 && reply.statusCode < 300;
			// 契约违反（问题没自带上下文事实）是**可纠正的**：模型看到服务端那份可执行的 message 后会带着
			// context 重问。所以这里按 pi 的规矩**抛错**（只有抛错才会把结果标成 isError:true 并如实报给模型；
			// 返回 ok:false 只是回执内容，不会置错位）—— 不静默降级、不假装问过了。
			// 其余失败（网络/404/别的 4xx）仍旧走既有的 ok:false 回执，形状不变。
			if (value.error === "question_needs_context") {
				throw new Error(
					`question_ask 没记下：这条问题缺少「判断所需的事实」（question_needs_context）。${value.message ?? ""} `
					+ "请把事实补进 `context` 后**再问一次**；不要放弃、不要假装问过了，也不要用一句话加两个选项凑。",
				);
			}
			// 更新路的两类**可纠正**失败：只有未答的能改，且那条必须真的存在 —— 把服务端原话端回去，
			// 让模型自己用 question_list 核对/改走“新开一条”，而不是静默地以为改成了。
			if (updateId !== null && (value.error === "question_not_open" || value.error === "question_not_found")) {
				throw new Error(
					`question_ask 没改成 ${updateId}（${value.error}）：${value.message ?? ""} `
					+ "请用 question_list 核对 id；**只有未答的问题能更新**，已答/已关的那条不要改 —— 真需要就新开一条（去掉 `questionId` 再调 question_ask）。",
				);
			}
			if (updateId !== null) {
				const changed: string[] = Array.isArray(value.changed) ? value.changed : [];
				return toolResult({
					ok,
					statusCode: reply.statusCode,
					id: value.id ?? updateId,
					updated: value.updated === true,
					changed,
					question: value.question ?? null,
					note: ok
						? value.updated === true
							? `已更新问题 ${value.id ?? updateId}（改了 ${changed.join("/") || "内容"}），没有新开一条，未答数不变。`
							: `问题 ${value.id ?? updateId} 的内容与现状相同（幂等），没有重复记。`
						: `没改成（${value.error ?? value.message ?? "?"}）；如实上报，不要假装改过了。`,
				});
			}
			return toolResult({
				ok,
				statusCode: reply.statusCode,
				id: value.id ?? null,
				deduped: value.deduped === true,
				created: value.created === true,
				question: value.question ?? null,
				note: ok
					? value.deduped
						? `这条已经在等你了（同 id ${value.id}），没有新开一条。不要重复问 —— 接着干别的，回答会作为一条 〔回答#${value.id}〕 消息回到会话里。`
						: `已记下问题 ${value.id}，在等用户拍板。这不阻塞你：不要停下来等，继续干活；回答会作为一条 〔回答#${value.id}〕 消息进这个会话。`
					: `没记下（${value.error ?? value.message ?? "?"}）；如实上报，不要假装问过了。`,
			});
		},
	});

	pi.registerTool({
		name: "question_list",
		label: "List questions",
		description: [
			"List this session's questions from its own session file.",
			"status 'open' (default) = still unanswered; 'answered' = everything that already has an answer or was closed (each item carries its own status); 'all' = both.",
			"counts always reports the full picture (open/answered/closed/total) regardless of the status filter.",
			"readOnly:true with readOnlyReason 'cwd-missing' means this session's working directory is gone — the questions are still readable, but nothing can be answered.",
		].join(" "),
		promptSnippet: "List this session's questions (open/answered two-way lookup)",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["open", "answered", "all"] as const, { description: "open (default) | answered | all" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum questions to return; default 50" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = currentSessionId(ctx);
			const query = new URLSearchParams();
			if (params.status !== undefined) query.set("status", params.status);
			if (params.limit !== undefined) query.set("limit", String(params.limit));
			const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
			const reply = await requestRaw(`/sessions/${id}/questions${suffix}`);
			const value: any = reply.value ?? {};
			const ok = reply.statusCode >= 200 && reply.statusCode < 300;
			return toolResult(ok
				? { ok: true, statusCode: reply.statusCode, ...value }
				: { ok: false, statusCode: reply.statusCode, note: `读不到问题清单（${value.error ?? value.message ?? "?"}）。`, value });
		},
	});

	pi.registerTool({
		name: "question_close",
		label: "Close a question",
		description: [
			"Close a question this agent no longer needs answered (it became moot, or was answered out of band). The entry keeps who/when/why.",
			"Only an OPEN question can be closed; an already answered or closed one returns 409 question_not_open.",
		].join(" "),
		promptSnippet: "Close a question you no longer need answered (recorded with reason)",
		parameters: Type.Object({
			id: Type.String({ description: "Question id like q-1a2b3c4d" }),
			reason: Type.String({ description: "Why this question is no longer needed (recorded verbatim)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = currentSessionId(ctx);
			// 契约（方案 §3，2026-09-20 定）：answer/close **不**用嵌套路径 —— 都是一个 POST 到
			// `/sessions/{id}/questions`，靠 body 里的 `op` 区分（宿主 SESSION_PATH 原样就能按 owner 转发）。
			const reply = await requestRaw(`/sessions/${sessionId}/questions`, {
				method: "POST",
				body: { op: "close", qid: params.id, reason: params.reason, by: "agent" },
			});
			const value: any = reply.value ?? {};
			const ok = reply.statusCode >= 200 && reply.statusCode < 300;
			return toolResult({
				ok,
				statusCode: reply.statusCode,
				id: value.id ?? params.id,
				closedBy: value.closedBy ?? null,
				question: value.question ?? null,
				note: ok
					? `已关闭 ${value.id ?? params.id}（by:agent，已留痕）。`
					: `没关成（${value.error ?? value.message ?? "?"}）；如实上报。`,
			});
		},
	});

	pi.registerTool({
		name: "session_archive",
		label: "Archive a session",
	description: [
			"Archive one session so it is treated as \"the human is no longer watching it\": an archived session is not woken or notified (annotation notifications to it are honestly skipped with reason session_archived), and /move or /handoff into it are refused.",
			"It does NOT delete anything: the session .jsonl stays on disk, nothing is removed, and the flag is reversible by calling this same tool with archived:false. Archiving is not the same step as cleaning up a worktree or a branch.",
			"It has exactly the same permission as the web UI's archive control: you may archive ANY session (there is no self/own-children restriction, no whitelist, and no extra rate limit here). This tool is a thin wrapper over POST /sessions/{id}/archive — whatever that route accepts, this tool accepts; whatever it refuses or reports, this tool reports verbatim (status/code/message).",
			"Consequences of that route's own behaviour (not extra limits this tool adds): a session that is currently running is refused honestly with 409 instead of being force-archived (that includes this very session while your own turn is still running — its 409 is the real answer, do not pretend it worked); archiving an already-archived session, or undoing an already-active one, succeeds with changed:false (idempotent, no pretend write); and the id must be a full UUID (a prefix or a missing id is refused honestly: 400 full_uuid_required / 404 session_not_found).",
			"The web UI already has its own archive control; this tool is the agent-facing wrapper over the same route and changes no frontend.",
			"On top of that route's own receipt, this tool adds one honest hint when the archived session's cwd is a registered git worktree of a repository: the receipt then names the worktree path, its branch, and - kept apart so the two cannot be confused - (1) the branch's own work: how many commits it is ahead of origin/master plus how many files/lines those own commits changed (the diff from its merge-base to its tip) and the merge-base sha/date, and (2) what merging it into origin/master would change as a whole (the two-tip diff, reported separately as vsMasterTwoDot); it also points at reclaim_worktree. It only hints — it never reclaims, deletes, or otherwise touches that worktree or branch (worktreeHint.state plus one sentence in note). A cwd that leaves no worktree behind gets no such line: that is the repository's main checkout, a path inside a repository that is not a registered worktree, or a path that is not inside any git repository at all (nothing left behind is a settled answer, not a failure). Only a probe that genuinely cannot tell is reported honestly as worktreeHint.state=\"unknown\" with the reason — git being unavailable, the probe exceeding its 2 s deadline, or the session file carrying no usable cwd — never guessed, and never acted on.",
		].join(" "),
		promptSnippet: "Archive (or un-archive) any session (same permission as the web control; nothing is deleted)",
		parameters: Type.Object({
			id: Type.String({ description: "Target session's full UUID; prefixes are not accepted" }),
			archived: Type.Optional(Type.Boolean({ description: "true (default) = archive; false = undo the archive" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const caller = currentSessionId(ctx);
			const archived = params.archived ?? true;
			// **薄封装（thin client）**：不做任何自己的校验 / 白名单 / 限流 —— 路由接受就接受，路由怎么报就照原样报。
			// 路径是**既有**的 `/sessions/{target}/archive`（宿主 SESSION_PATH 里已有 `archive` ⇒ 按 owner 路由，
			// 不会给 draining 代持有的目标冷开第二个 runtime）。`by` 只用于审计（落进条目的 by/at），不是权限。
			const reply = await requestRaw(`/sessions/${encodeURIComponent(params.id)}/archive`, {
				method: "POST",
				body: { archived, by: caller },
			});
			const value: any = reply.value ?? {};
			const ok = reply.statusCode >= 200 && reply.statusCode < 300;
			const code = value.error ?? null;
			const note = ok
				? value.changed === false
					? `目标已经是这个状态了（幂等）：没有重复写、也没有报错。${archived ? "它仍处于归档态（人不看了）。" : "它仍处于活跃态。"}`
					: archived
						? `已归档 ${value.id ?? params.id}（by ${caller}${value.at === null || value.at === undefined ? "" : `，at ${value.at}`}）：以后不会被唤醒/通知；什么也没删，可用 archived:false 撤销。`
						: `已取消归档 ${value.id ?? params.id}（by ${caller}）：它回到活跃树。`
				: code === "session_streaming" || code === "session_compacting"
					? `没归档：这条路由对在跑的目标就是这样报的（${code}）。${value.message ?? ""} 没有硬收 —— 等它跑完再归档。`
					: code === "full_uuid_required"
						? `没归档：这条路由只认**完整 uuid**（片段不接受）。${value.message ?? ""} 请传完整会话 uuid 再试。`
						: code === "session_not_found"
							? `没归档：没有这个会话（session_not_found）。核对完整 uuid 后重试。`
							: `没归档（${code ?? value.message ?? "?"}）；这条路由就是这么报的，如实上报，不要假装做过了。`;
			// 「归档那一刻是唯一还看得见它占着什么的时候」⇒ 归档成功后补一段**只提示、绝不回收**的话。
			// 判不出来（git 不在/不是仓库/超时）就如实写「查不到它的 worktree 归属」并给原因，绝不猜、绝不动手。
			const hint = ok && archived ? await archiveWorktreeHint(params.id) : null;
			return toolResult({
				ok,
				statusCode: reply.statusCode,
				id: value.id ?? params.id,
				archived: value.archived ?? null,
				changed: value.changed ?? null,
				by: caller,
				at: value.at ?? null,
				reason: code,
				message: value.message ?? null,
				note: hint?.note ? `${note} ${hint.note}` : note,
				...(hint === null ? {} : { worktreeHint: hint }),
			});
		},
	});

	pi.registerTool({
		name: "device_list",
		label: "List and probe devices",
		description: "List remote devices from devices.json and run one read-only probe for each configured device. A connection failure is returned for that named device; it is never rewritten as an empty device list.",
		promptSnippet: "List configured remote devices and their honest probe status",
		parameters: Type.Object({}),
		async execute() {
			const listed = await request("/devices");
			const probes = [];
			for (const device of listed.devices || []) {
				probes.push(await request(`/devices/${encodeURIComponent(device.name)}/probe`, {
					method: "POST",
					body: {},
				}));
			}
			return toolResult({ ...listed, probes });
		},
	});

	pi.registerTool({
		name: "device_probe",
		label: "Probe remote device",
		description: "Run a read-only SSH probe against one configured remote device. Returns uname plus git.repo, git.branch, and git.dirty, and names the device and SSH error honestly on failure.",
		promptSnippet: "Probe one configured remote device without changing it",
		parameters: Type.Object({
			name: Type.String({ description: "Device name from devices.json" }),
			path: Type.Optional(Type.String({ description: "Remote repository path; defaults to cwdRoot or the first repoHint" })),
		}),
		async execute(_toolCallId, params) {
			return toolResult(await request(`/devices/${encodeURIComponent(params.name)}/probe`, {
				method: "POST",
				body: { path: params.path },
			}));
		},
	});

	pi.registerTool({
		name: "device_run",
		label: "Run command on remote device",
		description: [
			"Run one command on a configured remote device over ssh.",
			"This is a remote shell: the command runs as that device's user, not locally, and it is not part of the local process tree, so the webui's interrupt / process-tree kill cannot reach it — only the local ssh client is killed (and only a timeout stops waiting).",
			"The ssh target comes from devices.json only; a host cannot be passed in.",
			"The receipt names the host it ran on, and reports a timeout or an output truncation explicitly instead of looking like success.",
			"cwd accepts a device path (~/... under a declared root) or a local path mapped through the device's cwdRoot/repoHints; an unmappable path is refused, never guessed.",
		].join(" "),
		promptSnippet: "Run a command on a configured remote device (remote shell, reported honestly)",
		parameters: Type.Object({
			name: Type.String({ description: "Device name from devices.json" }),
			command: Type.String({ description: "Shell command to run on the remote device" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the command: a device path (~/... under a declared root) or a local path mapped through the device's cwdRoot/repoHints; an unmappable path is refused instead of guessed" })),
		}),
		async execute(_toolCallId, params) {
			return toolResult(await request(`/devices/${encodeURIComponent(params.name)}/run`, {
				method: "POST",
				body: { command: params.command, cwd: params.cwd },
			}));
		},
	});

	// image_generate：真生图（业主 2026-10-26「继续推进让 gpt 6.1 sol 能直接生图」）。
	// 为什么是**函数工具**而不是 Responses 的原生生图：pi 0.85.1 的解析器不认 image_generation_call
	// （静默丢、不报错，见 67af4aa 的 F6/F7），所以这条路的唯一诚实形状是「工具自己拿回字节」。
	// 描述只承诺**实际能力**：配置缺失时它不宣称能生图，失败回执点名缺哪个键 —— 不许让模型据描述
	// 编一个「已生成」。
	pi.registerTool({
		name: "image_generate",
		label: "Generate an image",
		description: [
			"Generate ONE image from a text prompt through the image backend configured in $ASSIST_HOME/image-generation.json (endpoint + model).",
			"It returns a real image block in the tool result only when the backend really produced one; the receipt next to it reports the model, the requested size and the actual dimensions the backend returned, mimeType, bytes and sha256, and the image block is the only copy of the bytes (the receipt never repeats the base64).",
			"When that configuration is missing or incomplete the tool generates nothing: it fails with reason image_backend_not_configured and names the missing keys, so do not tell the user an image was created unless this tool result carries an image block.",
			"Fixed cost shape: at most one upstream request per call, asking for ONE image at the default 1024x1024 size (the responses-based backend takes no n field, so a multi-image answer is rejected instead of trimmed), and no retry - a timeout, abort, 4xx/5xx, invalid JSON, or an empty / non-image / oversized payload is reported as a failure instead of being replayed, and the prompt length is capped.",
			"Credentials are read from an existing pi provider (authProvider) or an existing environment variable (apiKeyEnv) named in that config; this tool never writes a secret anywhere and never prints one.",
			"If the backend answers with a URL instead of base64, the image is downloaded only when it is same-origin with the configured endpoint - no arbitrary URL fetching and no redirects followed.",
		].join(" "),
		promptSnippet: "Generate one image from a prompt through the configured image backend (size is a request; the receipt reports the actual dimensions)",
		parameters: Type.Object({
			prompt: Type.String({ description: "Text description of the image to generate (asks for one image at the default 1024x1024; the backend may return other dimensions - the receipt's dims are the authority; no batch or quality options)" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// 凭据只经 ctx.modelRegistry 读（只读、进程内、不落盘）；env 只按配置里**给出的变量名**读。
			const produced = await generateImage({
				prompt: params.prompt,
				signal,
				env: process.env,
				modelRegistry: ctx?.modelRegistry ?? null,
			});
			// 失败**必须抛**：pi 只认抛出来的错误（`pi-agent-core/dist/agent-loop.js:458-486` 会**忽略**
			// execute 返回里的 `isError`）—— 不抛就会让工具卡显示「成功」而回执写着 ok:false，那就是假成功。
			// 抛出物就是**结构化回执本身**（JSON 文本），所以模型与网页看到的仍是同一份 reason/缺失项，
			// 没有 image 块（这一支永远不会带上图）。
			if (produced.image === null) throw new Error(JSON.stringify(produced.receipt, null, 2));
			return toolResultOf(produced);
		},
	});

	pi.registerTool({
		name: "reclaim_worktree",
		label: "Reclaim the worktree of an archived session",
		description: [
			"Reclaim the git worktree that ONE archived session was working in: this is the single blessed path, and it exists because hand-rolled criteria already destroyed work once (2026-09-24: 'the branch is an ancestor of origin/master' sees only committed content, and the /tree cwd field was measured returning 0 live sessions while two were working there -> a live session's cwd with uncommitted changes was deleted, unrecoverably).",
			"It re-derives every fact from one-hand sources instead of a projection: session files' own header cwd under $ASSIST_HOME/sessions, git worktree list, git status, git diff. It never reads the /tree projection.",
			"The checks run in order and the FIRST failure refuses honestly with the measured values, changing nothing: (a) the target session exists and is archived (its latest sopho.archive entry); (b) its cwd is a worktree registered in this repository, has a branch, and is not the main checkout; (c) no session's cwd is equal to or inside that worktree (moved sessions, per placement.json claimedBy, no longer occupy their old cwd) AND the host's live session list contains no session whose file has not landed yet (cwd unknown - never guessed); (d) the branch is merged into origin/master (falling back to master) or has zero diff against it, and the work area is not dirty - uncommitted changes are exactly what that incident destroyed (this counts ignored content too, because a half-finished file can live under a .gitignore entry; the only exemption is the node_modules link to the main tree, which this repository uses by convention and which the removal step unlinks first); (e) only then git worktree remove, after unlinking a node_modules junction/symlink inside it first, so nothing is ever deleted through the link; the branch is deleted only when the content was safe.",
			"The receipt is verbatim per step: which session occupies the tree, how many files/lines the unmerged diff is, how many paths are dirty, what git printed. It is idempotent: when the directory and branch are already gone it reports alreadyReclaimed with changed:false instead of pretending or failing. An id that is not a full UUID, or unknown, is refused as such.",
			"force:true only relaxes the content checks (d) and the tooling failure where the live-session probe cannot be reached; it never relaxes (c), and the receipt then states verbatim what was discarded. The main checkout is refused unconditionally.",
			"Creation itself is done by the host's spawn route (server/base.mjs createWorktree, reached through the spawn tool); this tool is the reclaim half at the agent-tool layer because the plugin runtime already runs on the same machine and can reach git without a host restart.",
		].join(" "),
		promptSnippet: "Reclaim (delete) the worktree of an archived session through the one guarded path",
		parameters: Type.Object({
			id: Type.String({ description: "Target session's full UUID whose cwd is the worktree; prefixes are not accepted" }),
			force: Type.Optional(Type.Boolean({ description: "true = continue past unmerged differences / a dirty work area even though the receipt records what is discarded; never bypasses 'a live session is in that tree'" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const receipt: any = await reclaimWorktree({
				sessionId: params.id,
				force: params.force === true,
				callerCwd: ctx.cwd,
				baseUrl: baseUrl(),
			});
			if (receipt.note === null || receipt.note === undefined) receipt.note = `没做任何事（${receipt.reason ?? "?"}）；如实上报，不要假装收过了。`;
			return toolResult(receipt);
		},
	});

	pi.registerTool({
		name: "session_set_title",
		label: "Set session title",
		description: [
			"Give THIS session a short title (≤20 characters) — the session tree's left column shows exactly this, so people and the parent session can see at a glance what this session is doing.",
			"Use it once you understand what this session is for; change it again if the old title stopped being accurate.",
			"The title must be specific about the work (for example \"修插件热重载的陈旧判定\"), not a filler word like \"task\" or \"analysis\", and not a file name or path.",
			"Semantics are server-arbitrated and honest: an empty or whitespace-only title (including a bare command line such as \"/compact\") is refused; a title a human set is never overwritten, and the result says so instead of pretending it changed.",
			"It may be called during your own running turn — the session does not need to be idle.",
		].join(" "),
		promptSnippet: "session_set_title(title) — 给本会话起/改一个短标题（≤20 字，会话树上显示的就是它）",
		promptGuidelines: [
			"当你明白了这个会话要干什么之后，用 session_set_title 给自己起一个 ≤20 字的短标题（会话树上显示的就是它）；后来发现原来的标题不准，就再改一次。",
		],
		parameters: Type.Object({
			title: Type.String({ description: "短标题（≤20 字，具体说在做什么；服务端最长 24 字，超出会截断）" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = currentSessionId(ctx);
			const reply = await requestRaw(`/sessions/${id}/title`, { method: "POST", body: { title: params.title } });
			const value: any = reply.value ?? {};
			const ok = reply.statusCode === 200 && value.ok === true;
			return toolResult({
				id,
				ok,
				statusCode: reply.statusCode,
				title: value.name ?? null,
				source: value.source ?? null,
				applied: value.applied === true,
				previous: value.previous ?? null,
				reason: value.reason ?? null,
				...(ok
					? { note: value.applied ? "会话树上左栏现在显示的就是它。" : "跟原来一样，没变。" }
					: value.reason === "manual"
						? { note: "这个会话的标题是用户自己设的，模型一律不覆盖。接着干活就行 —— 已经告诉你了，不要反复重试 session_set_title。" }
						: value.reason === "empty-title"
							? { note: "标题为空（或整行是一条 / 命令）被拒绝。请给一个具体的短标题。" }
							: { note: `没设成（${value.reason ?? value.error ?? "?"}）；如实上报，不要假装成功。` }),
			});
		},
	});

	pi.registerTool({
		name: "session_set_model",
		label: "Set a session's model",
		description: [
			"Change the model of one session — THIS session by default; an explicit sessionId may only name your OWN child session.",
			"model is required, a ref like \"litellm/deepseek-flash\" (a bare model id works when unambiguous). The tool first reads GET /sessions/{id}/models; an unknown or ambiguous model is refused with the list of available refs — it never guesses and changes nothing in that case.",
			"Ownership boundary (owner decision 2026-10-14): the default target is yourself; an explicit sessionId is accepted only when that session's parentSession resolves to you (the host-resolved parentId, or the parent path equals your own session file). A sibling, your own parent, or any unrelated session is refused with the reason — never silently redirected to self.",
			"persist is NOT exposed and is fixed to false: only that one session changes; the global default model is never touched (changing it is a human action elsewhere, not this tool).",
			"Busy is an honest 409: if the target is mid-turn or compacting, the owner route refuses (session_streaming / session_compacting) and the receipt reports busy-not-changed — nothing is queued, retried, or silently applied; call again once it is idle. Consequence: calling this with no sessionId from inside your own running turn always hits that 409 (you are the busy target); switching an idle child session is the useful path.",
			"The tool is a thin forwarder over the owner route POST /sessions/{id}/model — it never calls pi's in-process setModel, which has no busy guard.",
			"On success the receipt states from→to, how the model string matched (matchedBy), that it takes effect immediately for that session's next request, and whether the thinking level moved with the switch (pi rewrites the thinking level on every switch).",
		].join(" "),
		promptSnippet: "session_set_model(model, sessionId?) — 切换一条会话的模型（默认自己；显式目标只能是自己的子会话；忙 ⇒ 如实 409 不重试）",
		promptGuidelines: [
			"想给别的会话换模型：只允许 session_new 建出来的自己的子会话（传 sessionId）；别的会话会被如实拒绝，不要改道去改自己。",
			"回执 409 session_streaming / session_compacting ⇒ 目标正忙、没有改：不要重试轰炸，等它闲下来（session_read 可看）再改一次。",
			"这个工具只动那一条会话（persist 固定 false）；要改全局默认模型请人来改，不要找这个工具。",
		],
		parameters: Type.Object({
			model: Type.String({ description: "Target model ref, e.g. \"litellm/deepseek-flash\"; a bare model id works when it is unambiguous in that session's available list" }),
			sessionId: Type.Optional(Type.String({ description: "Omit = change THIS session. Explicit target must be your own child session (its parentSession points at you); anything else is refused, never silently redirected" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(await setSessionModel(ctx, params));
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Hand off to a sibling session",
		description: [
			"Move this session's context to a new *sibling* session whose parentSession is this session's parent (not this session), so the tree gains a sibling, not a child.",
			"The context that travels is a lossy summary, not the full history; the new session also gets a pointer message naming the source session and its file, and whose first line always states the effective (read-back) cwd so a summary that names another directory is visible as a contradiction right there.",
			"The destination must be explicit: to.cwd is REQUIRED unless you pass to.sameCwd:true. Without either, the call is refused (400 handoff_cwd_required) instead of silently landing the new session in this session's own cwd — a goal that merely *mentions* a directory is not a destination, so pass it as to.cwd.",
			"to.cwd must be an existing local directory (missing/not a directory => 409 target_cwd_missing, never a silent fallback); to.device is checked against devices.json and then refused honestly, because cross-device handoff needs a remote session (S3-2, not built yet).",
			"After creating the session the logic layer reads its cwd back and compares it with the requested one; a mismatch is reported as ok:false (never a fake ok:true), and the receipt carries cwd/cwdSource/cwdVerified/cwdReadBack.",
			"Successful attempts append one line to $ASSIST_HOME/handoffs.jsonl (including cwdSource/requestedCwd/actualCwd/cwdVerified). Refusals at the validation step (a bad goal/to/compress/device, a missing target cwd, a source session that has no durable file on disk) are rejected before the ledger is reached and append NO line — the description must not promise a line that reality does not write. When the summary step fails, or when a new session was created at the wrong cwd, exactly one ok:false line is written; the source session is never modified by a failed handoff and no new session is created.",
			"The new session is handed the summary as its **first user message** and therefore **starts working immediately**: one model call right away, and it may begin acting (including writing files) without waiting for anyone. It does NOT wait for your next message — that is the difference from /move, which is lossless and stays silent until the user speaks again. Prefer /move when you want to keep this exact conversation and choose when work resumes.",
			"compress:\"llm\" (default) summarises with the current model; compress:\"session\" falls back to pi's own compaction in place (no new file, no cwd change, so it needs no destination). Pass summary to supply the text yourself.",
		].join(" "),
		promptSnippet: "Hand off this session's context (a lossy summary) to a new sibling session",
		parameters: Type.Object({
			goal: Type.String({ description: "What the new thread should do next; the summary is built around this goal" }),
			to: Type.Optional(Type.Object({
				cwd: Type.Optional(Type.String({ description: "Existing local directory for the new session. Required unless sameCwd:true — do not omit it and hope: the new session would land in this session's own cwd. If the goal names a directory, that directory is the value to pass here." })),
				sameCwd: Type.Optional(Type.Boolean({ description: "true = deliberately inherit this session's cwd as the new session's cwd; the receipt and handoffs.jsonl then say cwdSource:\"source\". Refused together with to.cwd." })),
				device: Type.Optional(Type.String({ description: "Device name from devices.json; cross-device handoff is not implemented yet and is refused honestly" })),
			}, { description: "Where the new session should live" })),
			compress: Type.Optional(StringEnum(["llm", "session"] as const, { description: "llm (default) = generated summary in a new session; session = pi's own compaction in place" })),
			summary: Type.Optional(Type.String({ description: "Supply the summary text yourself instead of asking the model to write one" })),
			share: Type.Optional(Type.Boolean({ description: "Explicitly accept sharing the target cwd with other live sessions" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toolResult(await runHandoff(ctx, params));
		},
	});

	pi.registerCommand("handoff", {
		description: "Hand this session's context to a new sibling session: /handoff (--cwd <dir> | --here) <goal>",
		handler: async (args, ctx) => {
			try {
				const parsed = parseHandoffCommand(args);
				if ("error" in parsed) {
					ctx.ui.notify(`handoff 没发出去：${parsed.error}`, "error");
					return;
				}
				if ("needsDestination" in parsed) {
					const [recents, devices] = await Promise.all([request("/cwd-recents"), request("/devices")]);
					const candidates = (recents.recents || []).map((entry: any) => entry.cwd).filter((value: string) => value !== ctx.cwd);
					const hinted = parsed.goal ? await goalDirectoryCandidates(parsed.goal) : [];
					ctx.ui.notify([
						`当前 cwd：${ctx.cwd}`,
						"落点必须显式给 —— 不给就拒，绝不静默沿用当前 cwd：",
						`· /handoff --cwd <已存在的目录> ${parsed.goal || "<目标>"}   （搬到那个目录）`,
						`· /handoff --here ${parsed.goal || "<目标>"}   （明写沿用当前 cwd）`,
						hinted.length > 0 ? `你写的目标里探得到的目录（只是候选，不会自动选）：${hinted.join(" · ")}` : null,
						candidates.length > 0 ? `候选目录（最近用过）：${candidates.join(" · ")}` : "候选目录：暂无最近记录",
						devices.exists ? `设备：${(devices.devices || []).map((device: any) => device.name).join(" · ") || "（空 devices.json）"}（跨设备 handoff 还没做，会被如实拒绝）` : "devices.json 不存在",
						"传过去的会是摘要，不是全文。",
					].filter((line): line is string => typeof line === "string").join("\n"), "info");
					return;
				}
				const value: any = await runHandoff(ctx, parsed.params);
				if (value?.ok === false) {
					if (value.mode === "llm" && typeof value.to === "string") {
						// 新会话**已经存在**，只是位置不对：不能说成"没建"，得把它交回去自己处置。
						ctx.ui.notify(`handoff 落地不对（新会话 ${value.to} 已经存在）：${value.message ?? value.notice}`, "error");
						return;
					}
					ctx.ui.notify(`handoff 失败：${value.message ?? value.notice ?? ""}；源会话一字未动，只记了一条 ok:false。`, "error");
					return;
				}
				if (value?.mode === "compaction") {
					ctx.ui.notify('已用 pi 自己的压缩原地压这条会话（compress:"session"）；没有新会话、没有换 cwd。', "info");
					return;
				}
				ctx.ui.notify(`已 handoff 到新会话 ${value.to}（落点 ${value.cwd ?? value.target?.cwd}，${value.cwdSource === "source" ? "明写沿用源 cwd" : "调用方给的 to.cwd"}，已回读核对）；传过去的是摘要，不是全文。`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("cwd", {
		description: "Show the current cwd and recent choices, or create a new session there: /cwd [directory]",
		handler: async (args, ctx) => {
			try {
				const cwd = args.trim();
				if (!cwd) {
					const listed = await request("/cwd-recents");
					const candidates = (listed.recents || []).map((entry: any) => entry.cwd).filter((value: string) => value !== ctx.cwd);
					ctx.ui.notify([
						`当前 cwd：${ctx.cwd}`,
						candidates.length > 0 ? `候选（最近用过）：${candidates.join(" · ")}` : "候选：暂无最近目录",
						"用 /cwd <目录> 会在那里新开一条会话；这不是搬家，当前会话不会改 cwd。",
					].join("\n"), "info");
					return;
				}
				const created = await request(`/sessions/${currentSessionId(ctx)}/session-new`, {
					method: "POST",
					body: { cwd },
				});
				ctx.ui.notify(`已在 ${created.cwd} 新开会话 ${created.childSessionId}；这是新会话，不是搬家，当前会话仍在 ${ctx.cwd}。`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("scratch", {
		description: "Create a new session in an honest temporary cwd",
		handler: async (_args, ctx) => {
			try {
				const created = await request("/sessions", { method: "POST", body: { scratch: true } });
				ctx.ui.notify(`已新开临时会话 ${created.id}；cwd=${created.cwd}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("move", {
		description: "Losslessly fork this settled session into an existing local directory: /move <directory>",
		handler: async (args, ctx) => {
			try {
				const cwd = args.trim();
				if (!cwd) {
					ctx.ui.notify("用法：/move <已存在的目录>。这会无损 fork 到一条新会话，并归档当前会话。", "warning");
					return;
				}
				const moved = await request(`/sessions/${currentSessionId(ctx)}/move`, {
					method: "POST",
					body: { cwd },
				});
				ctx.ui.notify(`已无损搬到 ${moved.cwd}：新会话 ${moved.toSessionId}。当前会话已标记 ${moved.movedMarker} 并归档，请在新会话继续。`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("device", {
		description: "List configured devices, or probe one device: /device [name]",
		handler: async (args, ctx) => {
			try {
				const name = args.trim();
				if (name) {
					const result = await request(`/devices/${encodeURIComponent(name)}/probe`, { method: "POST", body: {} });
					ctx.ui.notify(`${name}: ${result.ok ? "ok" : "failed"} · ${result.uname || result.error}`, result.ok ? "info" : "error");
					return;
				}
				const listed = await request("/devices");
				const summary = listed.exists
					? (listed.devices || []).map((device: any) => `${device.name}: ${device.lastProbe?.ok === true ? "ok" : device.lastProbe?.ok === false ? "failed" : "not probed"}`).join(" · ") || "devices.json is empty"
					: "devices.json does not exist";
				ctx.ui.notify(summary, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
