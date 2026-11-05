/**
 * 会话运行时池 —— M2 的地基。
 *
 * ## 为什么是"池"而不是一个会话
 *
 * pi 的 `runtime.switchSession()` 会 `abort()` + `dispose()` 当前会话
 * （见 dist/core/agent-session-runtime.js 的 teardownCurrent）。所以**一个
 * runtime 只能服务一个会话** —— 这正是 pi TUI 里"切走就断"的根因。
 *
 * 解法（从 pi-web-ui 抄来，S0 spike 已实测通过）：**每个会话一个独立 runtime**。
 * N 个会话 = N 个 runtime，互不干扰。
 *
 * ## 关键性质：客户端断开不销毁 runtime
 *
 * 浏览器关掉标签页 / 切换会话 / SSE 断线，都只是从 `subscribers` 里移除。
 * runtime 继续跑 —— 这就是"切走还在跑"。只有进程退出才 dispose。
 *
 * ## 事件映射
 *
 * SDK 事件 → 一条窄的 wire 格式（前端只认这几种）。刻意不把 SDK 事件原样
 * 透给浏览器：那是内部形状，会随版本变。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { HOME, SESSIONS, readAsset } from "../bin/paths.mjs";
import { autoInfoFor } from "./auto-continue.mjs";

/** pi 的家目录（models.json / 扩展 / 技能都在这）。默认就是我们的 profile。 */
const AGENT_DIR = process.env.SOPHO_AGENT_DIR ?? HOME;
const DEFAULT_CWD = process.env.SOPHO_CWD ?? process.cwd();

const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd, agentDir: AGENT_DIR });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

/** 会话文件头里记着 cwd —— 会话应该在它当时的工作目录里继续。 */
function cwdOf(sessionFile) {
	try {
		const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
		if (typeof header?.cwd === "string" && fs.existsSync(header.cwd)) return header.cwd;
	} catch {
		// 读不出来就用默认 cwd，不值得为一个坏 header 卡住
	}
	return DEFAULT_CWD;
}

/** sessionFile 绝对路径 → entry。进程级单例。 */
const pool = new Map();

function makeEntry(file, cwd, runtime) {
	const entry = {
		file,
		cwd,
		runtime,
		subscribers: new Set(),
		lastActivity: Date.now(),
		unread: false,
		off: null,
	};
	entry.lastActivity = Date.now();
	entry.off = runtime.session.subscribe((ev) => {
		entry.lastActivity = Date.now();
		const wire = wireOf(ev);
		if (wire) broadcast(entry, wire);
		// agent_settled 才是「真的空闲了」（agent_end 时 isStreaming 仍为真）。
		// 有攒着等它空闲的回报，这一刻投出去。
		if (ev.type === "agent_settled") kickIfPending(entry.file);
	});
	return entry;
}

/** 打开已有会话（已在池里就直接返回）。 */
export async function acquire(sessionFile) {
	const key = path.resolve(sessionFile);
	const hit = pool.get(key);
	if (hit) return hit;
	if (!fs.existsSync(key)) throw new Error(`会话文件不存在: ${key}`);

	const cwd = cwdOf(key);
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: AGENT_DIR,
		sessionManager: SessionManager.open(key),
	});
	const entry = makeEntry(key, cwd, runtime);
	pool.set(key, entry);
	return entry;
}

/**
 * 把刚建好的会话**立刻落盘**。
 *
 * pi 的 SessionManager 是延迟落盘的：在第一条 assistant 消息出现之前，
 * `_persist()` 只把 `flushed` 置回 false 就返回，**不创建文件**（见
 * session-manager.js 的 no-assistant 分支）。而 Web UI 是按文件路径读会话
 * 摘要的（server/sessions-api.mjs 的 summarizeSession）—— 会话一旦 `link`
 * 到事项就会被列出来，此时文件还不存在，界面于是短暂显示「文件不见了」。
 *
 * 这里主动写出 `fileEntries`（header，以及已经 append 的 session_info 等），
 * 并把 `flushed` 置真：
 *   - 文件立刻存在，UI 不再扑空；
 *   - 之后 pi 首次落盘会走 append 分支（`flushed` 为真），不会再用 "wx"
 *     去打开一个已存在的文件而 EEXIST。
 * 这正是 pi 自己在 `_setSessionFile()` 处理“空文件”时的做法。
 *
 * `_rewriteFile` / `flushed` 是 SessionManager 的下划线成员，跨版本可能变；
 * 失败就吞掉，退回 pi 原本的延迟落盘 —— 不因为落盘失败而挡住建会话。
 */
function persistNow(sessionManager) {
	try {
		sessionManager._rewriteFile?.();
		sessionManager.flushed = true;
	} catch {
		// 落盘失败不致命：最坏就是回到「首次 assistant 才建文件」的行为
	}
}

/**
 * 开一个新会话。
 *
 * `opts.parent` 写进会话文件头的 parentSession（血缘）；`opts.name` 是显示名。
 * 事项会话两者都要：血缘让「根会话」分组成立，名字让会话列表一眼看懂。
 *
 * 不传 cwd 时：有 parent 就跟着 parent 的 cwd（新会话应该在它当时的工作目录里
 * 继续），否则用服务器默认 cwd。
 *
 * **关联事项不在这里做** —— 那是账本的事，由调用方（/api/item-session）调
 * `a link`。runtime 池只管会话本身。
 */
export async function createConversation(cwd, opts = {}) {
	const dir = cwd ?? (opts.parent ? cwdOf(opts.parent) : DEFAULT_CWD);
	fs.mkdirSync(SESSIONS, { recursive: true });
	const sessionManager = SessionManager.create(dir, SESSIONS, opts.parent ? { parentSession: opts.parent } : undefined);
	const runtime = await createAgentSessionRuntime(factory, {
		cwd: dir,
		agentDir: AGENT_DIR,
		sessionManager,
	});
	const file = runtime.session.sessionFile;
	if (!file) throw new Error("新会话没有拿到文件路径（SessionManager 没持久化？）");
	const entry = makeEntry(path.resolve(file), dir, runtime);
	if (opts.name) {
		try {
			runtime.session.setSessionName(opts.name);
		} catch {
			// 起名失败无所谓，不影响会话本身
		}
	}
	// 建完名字就落盘 —— 否则调用方一 link，UI 就会在文件出现前读到它
	persistNow(sessionManager);
	pool.set(entry.file, entry);
	return entry;
}

// ─────────────────────────── 事件 → wire ───────────────────────────

function wireOf(ev) {
	switch (ev.type) {
		case "message_update": {
			const a = ev.assistantMessageEvent;
			if (a?.type === "text_delta") return { t: "text", d: a.delta };
			if (a?.type === "thinking_delta") return { t: "thinking", d: a.delta };
			return null;
		}
		case "tool_execution_start":
			return { t: "tool", phase: "start", name: ev.toolName };
		case "tool_execution_end":
			return { t: "tool", phase: "end", name: ev.toolName, error: !!ev.isError };
		case "agent_start":
			return { t: "run", phase: "start" };
		case "agent_end":
			return { t: "run", phase: "end" };
		default:
			return null;
	}
}

function broadcast(entry, msg) {
	const line = `data: ${JSON.stringify(msg)}\n\n`;
	for (const res of entry.subscribers) {
		try {
			res.write(line);
		} catch {
			entry.subscribers.delete(res);
		}
	}
}

// ─────────────────────────── 对外操作 ───────────────────────────

/**
 * 发一条消息。
 * 流式中：默认 steer（当前回合工具结算后注入），"followUp" 则等全部做完。
 * 不 await 整轮完成 —— 进度走 SSE，HTTP 立刻返回。
 */
export function prompt(entry, text, behavior) {
	const session = entry.runtime.session;
	const opts = {};
	if (session.isStreaming) opts.streamingBehavior = behavior === "followUp" ? "followUp" : "steer";
	session.prompt(text, opts).catch((err) => {
		broadcast(entry, { t: "error", message: String(err?.message ?? err) });
	});
	return { streaming: session.isStreaming, behavior: opts.streamingBehavior ?? null };
}

export function status(entry) {
	const s = entry.runtime.session;
	return {
		file: entry.file,
		cwd: entry.cwd,
		streaming: s.isStreaming,
		model: s.model?.id ?? null,
		thinking: s.thinkingLevel ?? null,
		messages: s.messages.length,
		messageCount: s.messages.length,
		lastActivity: entry.lastActivity,
		// #22：这场是不是服务器自动开的？是的话带上第几轮 —— Web UI 据此标「⟳自动 N」。
		auto: autoInfoFor(entry.file),
	};
}

export function subscribe(entry, res) {
	entry.subscribers.add(res);
	return () => entry.subscribers.delete(res);
}

/** 池里所有活着的会话（界面用来标"正在跑"）。 */
export function live() {
	return [...pool.values()].map(status);
}

/**
 * 退出前先把正在跑的会话收尾。
 *
 * 为什么要 `await abort()`：pi 的 abort 会把这一轮**已经产生的工具结果落盘**
 * （见 dist/core/agent-session-runtime.js 里 teardownCurrent 的注释）。
 * 不 await 就 process.exit —— 当前那一轮刚写了一半的东西会丢。
 *
 * 注意：同进程的 runtime 注定被中断，这躲不掉。能保证的只是"不丢掉已产生的"。
 */
// ───────────────────── 回报投递队列（#12） ─────────────────────
//
// 下属会话结束时把一行回报送回**上级**（发起它的那个会话，通常就是总台）。
// 上级可能正忙，不能硬塞 —— 所以先攒进这个内存队列，等它空闲时再 steer 进去。
//
// 三条性质来自 #12 已定的决定：
//   1. 队列只在**进程内存**里，不持久化。"不丢"靠账本（a report）兜底。
//   2. 合并窗口内到达的多条回报并成**一条**投递，不给 N 条各跑一轮。
//   3. 上级不在池里（没在跑）→ **不投**：服务器若 acquire 它，会和 TUI 进程
//      并发写同一个会话文件、写出分叉（见 #12）。回报已在账本，不丢；只是不
//      主动叫醒。要真正实时叫醒，得先解决「TUI ↔ Web UI 同步」。
//
// 明确不做（#12 的范围）：失败重试、持久化、优先级、去重。

/** 合并窗口：这个窗口内到达的回报算"几乎同时"，合并成一条。 */
const MERGE_WINDOW_MS = 500;

/** 上级会话文件 → { lines: string[], timer } */
const outbox = new Map();

/**
 * 收下一条下属会话的回报，等上级空闲时投递。
 *
 * `line` 是**已经排好版的一行**（谁、什么事项、说了什么）—— 合并时只做拼接，
 * 不再各自渲染一遍，保证"N 条并成一条"是简单的。
 */
export function publishReport(targetFile, line) {
	const key = path.resolve(targetFile);
	let box = outbox.get(key);
	if (!box) {
		box = { lines: [], timer: null };
		outbox.set(key, box);
	}
	box.lines.push(line);
	armFlush(key, box);
}

/** 池里还有多少条待投递的回报（给状态/调试用）。 */
export function pendingReports() {
	let n = 0;
	for (const box of outbox.values()) n += box.lines.length;
	return n;
}

/** 安排一次投递。已经排了就不重复排。 */
function armFlush(key, box) {
	if (box.timer) return;
	box.timer = setTimeout(() => {
		box.timer = null;
		flush(key);
	}, MERGE_WINDOW_MS);
	box.timer.unref?.(); // 别为了等一个窗口而拖住进程退出
}

/**
 * 把攒着的回报投给上级。
 *
 * 上级还在跑（isStreaming）就**留着**，等它 agent_settled 时再由 kickIfPending 投。
 * 上级不在池里 = 没在跑 → acquire() 拉起它的 runtime 跑一轮（主动唤醒）。
 */
async function flush(key) {
	const box = outbox.get(key);
	if (!box || box.lines.length === 0) return;
	const entry = pool.get(key);
	if (!entry) {
		// 方向 2：上级不在服务器池里（典型：只在 pi TUI 里）就**不投**。
		// 服务器 acquire 它 = 两个进程并发写同一个会话文件 → 对话树分叉（#12）。
		// 回报已经在账本里（a report），不丢；这里只是不主动叫醒。
		outbox.delete(key);
		console.error(`[sopho-pi] 上级不在池里，回报只留账本：${path.basename(key)}`);
		return;
	}
	if (entry.runtime.session.isStreaming) return; // 忙 → 等它闲下来

	const lines = box.lines.splice(0); // 先取走 —— 投递过程中新来的回报另起一批
	outbox.delete(key);
	try {
		prompt(entry, renderReport(lines), "steer");
	} catch (err) {
		// 投递失败不重试（#12 明确不做失败重试）：账本里那条回报还在，不丢。
		console.error("[sopho-pi] 回报投递失败（账本里仍有）：", err?.message ?? err);
	}
}

/** 一轮真的结束了 —— 若有攒着等它空闲的回报，现在安排投递。 */
function kickIfPending(file) {
	const box = outbox.get(file);
	if (box?.lines.length) armFlush(file, box);
}

/** 用 defaults/prompt-report.md 渲染这条投递。改提示词不用改代码。 */
function renderReport(lines) {
	const body = lines.join("\n\n");
	const tpl = readAsset("prompt-report.md");
	if (!tpl) return `（收到下属会话回报，已合并）\n\n${body}`;
	return tpl.text.replaceAll("{{reports}}", body);
}

export async function shutdownAll() {
	await Promise.all(
		[...pool.values()].map(async (entry) => {
			try {
				entry.off?.();
				await entry.runtime.session.abort?.();
				entry.runtime.session.dispose?.();
			} catch {
				// 退出路径，尽力而为
			}
		}),
	);
	pool.clear();
}
