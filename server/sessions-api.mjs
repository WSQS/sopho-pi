/**
 * 服务器侧的数据来源：账本 + 会话。
 *
 * ## 账本状态为什么走 CLI 的 --json 而不是 import
 *
 * 折叠逻辑（追加式日志 → 当前状态）只能有一份。放在 bin/ledger.mjs 里，
 * 服务器通过它的 --json 契约消费 —— 和 pi 扩展用的完全同一个接口。
 * 按 mtime 缓存，所以不是每个请求都 spawn。
 *
 * 代价：多一次 node 启动（~50ms，且只在账本变动后发生）。
 * 收益：不存在"两份折叠逻辑慢慢分叉"这种事。
 * TODO：如果以后请求频率上来了，把 bin/ledger.mjs 的存储/折叠部分抽成
 *       bin/ledger-core.mjs，两边都 import。
 *
 * ## 会话为什么按文件直接读
 *
 * 会话文件是 append-only JSONL，读它是纯解析，不需要经过 pi。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BIN, HOME, LEDGER, SESSIONS } from "../bin/paths.mjs";

const run = promisify(execFile);
const LEDGER_BIN = path.join(BIN, "ledger.mjs");

// ─────────────────────────── 账本 ───────────────────────────

let cache = { mtimeMs: -1, data: { items: [] } };

/** 账本的当前状态。按文件 mtime 缓存。 */
export async function ledgerState() {
	let mtimeMs;
	try {
		mtimeMs = fs.statSync(LEDGER).mtimeMs;
	} catch {
		return { items: [] }; // 账本还不存在 = 空库，不是错误
	}
	if (cache.mtimeMs === mtimeMs) return cache.data;
	const { stdout } = await run(process.execPath, [LEDGER_BIN, "--json"], { maxBuffer: 16 << 20 });
	cache = { mtimeMs, data: JSON.parse(stdout) };
	return cache.data;
}

/**
 * 为某个事项准备一场会话：提示词 / 显示名 / 产出路径。
 *
 * 渲染只在 bin/ledger.mjs 一份（硬约束 #15）—— 服务器只消费它的 `--json`，
 * 不拼模板。顺带在这里把「执行必须先有当前动作」这类前提挡掉。
 */
export async function planItemSession(id, kind) {
	const { items } = await ledgerState();
	const item = items.find((i) => i.id === id);
	if (!item) throw new Error(`账本里没有 #${id} 这条事项`);
	if (kind === "exec" && !item.next) throw new Error(`#${id} 还没有「当前动作」，先用 go 发令推进`);
	let stdout;
	try {
		({ stdout } = await run(process.execPath, [LEDGER_BIN, kind, String(id), "--json"]));
	} catch (err) {
		// CLI 非零退出时 stdout 里通常有一句人话，优先透出去
		throw new Error((err.stdout ?? "").trim() || err.message);
	}
	const plan = JSON.parse(stdout);
	if (plan.error) throw new Error(plan.error);
	return plan;
}

/** 写一条「事项 ↔ 会话」关联。走 CLI —— 写入格式与推导都只在一份。 */
export async function linkSession(id, kind, file, parent) {
	const argv = ["link", String(id), kind, file];
	if (parent) argv.push("--parent", parent);
	try {
		await run(process.execPath, [LEDGER_BIN, ...argv]);
	} catch (err) {
		throw new Error((err.stderr ?? "").trim() || err.message);
	}
}

/**
 * 记一条「提醒」到事项上（#29）—— 刹车回问的账本兜底。
 *
 * 走 CLI（同 linkSession）：写入格式与折叠只有 bin/ledger.mjs 一份。
 * **失败不抛** —— 它只是叫醒上游之外的第二条保险，不能反过来把刹车流程卡住。
 */
export async function noticeItem(id, text) {
	try {
		await run(process.execPath, [LEDGER_BIN, "notice", String(id), text]);
	} catch (err) {
		console.error("[sopho-pi] 回问落账本失败：", ((err.stderr ?? "") || err.message || err).toString().trim());
	}
}

/**
 * 有后续活动就把会话重开（写一条 open）。只在它确实是 closed 时才 spawn。
 * 失败不致命：重开标记不该挡住发消息。
 */
export async function reopenIfClosed(file) {
	const { sessionStates = {} } = await ledgerState();
	if (sessionStates[path.resolve(file)]?.state !== "closed") return;
	try {
		await run(process.execPath, [LEDGER_BIN, "session", file, "open"]);
	} catch {
		// 重开失败就当中没发生过
	}
}

// ─────────────────────────── 会话 ───────────────────────────

/**
 * 会话头里的 parentSession = 「发起它的那个会话」。
 *
 * 只读**第一行**（header）—— 会话文件可以很大，而 /api/report 只需要知道
 * 回报该送给谁。读不出来/不在会话根下 → null（调用方据此放弃投递）。
 */
export function sessionParent(file) {
	if (!allowed(file)) return null;
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(8 * 1024);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const line = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
		const header = JSON.parse(line);
		return typeof header?.parentSession === "string" && header.parentSession ? path.resolve(header.parentSession) : null;
	} catch {
		return null;
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} catch {
			// 关不掉无所谓
		}
	}
}

/**
 * 某个会话属于哪个事项（回报里要写清是谁的回）。
 * 归属只认账本的 link 记录；没有就返回 null（比如会话还没 link）。
 *
 * 顺带把该事项的「当前动作」、续跑标记（#22）和状态带出来 —— /api/report 收尾时
 * 要读它，决定这一轮结束后该不该自动开下一轮。
 */
export async function itemOfSession(file) {
	const { items } = await ledgerState();
	const key = path.resolve(file);
	for (const it of items) {
		for (const l of it.links ?? []) {
			if (path.resolve(l.session) === key)
				return {
					id: it.id,
					text: it.text,
					kind: l.kind,
					state: it.state ?? "open",
					next: it.next ?? null,
					nextKind: it.nextKind ?? null,
				};
		}
	}
	return null;
}

/** 只允许读会话根下的文件 —— 防路径穿越。单根（见 paths.mjs 里的说明）。 */
function allowed(file) {
	const p = path.resolve(file);
	return p.startsWith(path.resolve(SESSIONS) + path.sep) && p.endsWith(".jsonl");
}

/**
 * 会话的创建时间。pi 的文件名是 `<ISO 时间>_<uuid>.jsonl`（UTC）。
 * 用文件名而不是文件 mtime：mtime 是"最后一次活动"，会随你继续聊而变。
 */
function createdAt(file) {
	const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
	if (!m) return null;
	const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
	return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function* records(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			yield JSON.parse(t);
		} catch {
			// 坏行跳过 —— 会话文件不该因为一行损坏就整个读不出来
		}
	}
}

const tsOf = (r) => {
	if (typeof r.timestamp === "number") return r.timestamp;
	if (typeof r.timestamp === "string") {
		const t = Date.parse(r.timestamp);
		if (!Number.isNaN(t)) return t;
	}
	return null;
};

/** 会话摘要：给侧栏用。不稳的东西不读 —— 名字是可选的，可能根本没有。 */
export function summarizeSession(file) {
	if (!allowed(file)) return { file, missing: true, reason: "不在 sessions 目录内" };
	let messages = 0;
	let toolCalls = 0;
	let name = null;
	let model = null;
	let parent = null;
	let firstUser = null;
	let lastTs = null;
	let exists = false;

	for (const r of records(file)) {
		exists = true;
		const t = tsOf(r);
		if (t) lastTs = t;
		if (r.type === "session" && r.parentSession) parent = r.parentSession; // 会话头里的血缘
		if (r.type === "session_info" && r.name) name = r.name;
		if (r.type === "model_change" && r.modelId) model = r.modelId;
		if (r.type !== "message") continue;
		messages++;
		const content = r.message?.content;
		if (r.message?.role === "user" && !firstUser) {
			const part = Array.isArray(content) ? content.find((p) => p.type === "text") : null;
			if (part) firstUser = part.text.slice(0, 300);
		}
		if (Array.isArray(content)) for (const p of content) if (p.type === "toolCall") toolCalls++;
	}

	if (!exists) return { file, missing: true, reason: "文件不存在或不可读" };
	return { file, name, messages, toolCalls, model, parent, createdAt: createdAt(file), lastTs, firstUser };
}

/** 会话正文：给右侧用。M1 只显示用户/助手文本，工具调用折叠成计数。 */
export function readSession(file) {
	if (!allowed(file)) return null;
	const out = [];
	let other = 0;
	for (const r of records(file)) {
		if (r.type === "custom_message") {
			other++;
			continue;
		}
		if (r.type !== "message") continue;
		const role = r.message?.role;
		if (role !== "user" && role !== "assistant") {
			other++;
			continue;
		}
		const texts = [];
		let calls = 0;
		let thinking = 0;
		for (const p of r.message.content ?? []) {
			if (p.type === "text") texts.push(p.text);
			else if (p.type === "toolCall") calls++;
			else if (p.type === "thinking") thinking++;
		}
		const text = texts.join("\n").trim();
		if (!text && !calls && !thinking) {
			other++;
			continue;
		}
		out.push({ role, text, calls, thinking });
	}
	return { file, messages: out, hiddenRecords: other };
}

/** 会话根下所有会话文件（递归，因为 pi 按 cwd 分子目录）。 */
export function listAllSessions() {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(SESSIONS);
	return out;
}

// ─────────────────────────── 树 ───────────────────────────

/**
 * 事项 + 它们的会话 + 根会话 + 真正未关联的会话。
 *
 * 「根会话」是用**证据**定义的：被别的会话当作 `parent` 的那些。不是靠猜
 * “哪个看起来像主会话”。所以一个刚建、还没派生过任何东西的会话会落在
 * 「未关联」里 —— 那是诚实的，它确实还没和任何事项发生关系。
 */
export async function readTree() {
	const { items, sessionStates = {} } = await ledgerState();
	// 会话状态由账本给（closed = 这一局交回了）。缺失 = open。
	const stateOf = (f) => sessionStates[path.resolve(f)]?.state ?? "open";

	// 每个会话文件只解析一次 —— summarizeSession 要读完整个 JSONL，别重复读
	const sumCache = new Map();
	const sum = (f) => {
		const k = path.resolve(f);
		if (!sumCache.has(k)) sumCache.set(k, summarizeSession(k));
		return sumCache.get(k);
	};

	const linked = new Map(); // 会话文件 → { id, text, kind }（它属于哪个事项）
	const parentOf = new Map(); // 子会话 → 父会话

	const decorated = items.map((it) => {
		const sessions = (it.links ?? [])
			.map((l) => {
				const f = path.resolve(l.session);
				linked.set(f, { id: it.id, text: it.text, kind: l.kind });
				if (l.parent) parentOf.set(f, path.resolve(l.parent));
				return {
					kind: l.kind,
					linkedAt: l.ts,
					parent: l.parent ?? null,
					sessionState: stateOf(f),
					...sum(f),
				};
			})
			.sort((a, b) => (a.createdAt ?? a.linkedAt ?? 0) - (b.createdAt ?? b.linkedAt ?? 0));
		// 账本已经算好了一切（tag / tone / stall / isLeaf / isNext / children /
		// shownNext / parent）。这里只剥掉原始的 links —— sessions 已是它的加工版。
		const { links: _links, ...rest } = it;
		return { ...rest, sessions };
	});

	const all = listAllSessions();

	// 血缘的第二条来源：会话文件头里的 parentSession。
	// 两条都要 —— 历史会话建在"把 parent 记进账本"之前，文件头里也没有，
	// 那只能靠 link 记录；而别处拷来的会话可能只有文件头。
	for (const f of all) {
		const p = sum(f).parent;
		if (p && !parentOf.has(path.resolve(f))) parentOf.set(path.resolve(f), path.resolve(p));
	}

	const childrenOf = new Map();
	for (const [child, parent] of parentOf) {
		if (!childrenOf.has(parent)) childrenOf.set(parent, []);
		childrenOf.get(parent).push(child);
	}

	// 根会话 = **没有父的会话**。
	//
	// 之前这里是"被别的会话认作 parent 的会话" —— 那个定义会漏掉
	// "自己是根、但还没派生过任何东西"的会话（比如 #2 的 dev 会话）：
	// 它明明没有父，却不显示在根会话里，只在事项卡片下面出现。
	// 用结构定义（没有父）而不是证据定义（有人认它作父），就不会漏。
	// 根会话 = **没有父、且不属于任何事项的会话**。
	//
	// 之前是"没有父"就够 —— 那是错的。为一个事项新开的会话（比如 #2 的 dev
	// 会话）也没有父，却被 link 到事项，于是它既当根、又挂在事项下（重复且误导）。
	// 真正该当根的是"自由漂浮的对话"：没父、也没 link。一个刚开、还没 link 的
	// 会话是根；一旦挂到事项下就不是。
	const hubs = all
		.filter((f) => !parentOf.has(path.resolve(f)) && !linked.has(path.resolve(f)))
		.map((f) => ({
			sessionState: stateOf(f),
			...sum(f),
			item: linked.get(path.resolve(f)) ?? null,
			children: (childrenOf.get(path.resolve(f)) ?? [])
				.map((c) => ({
					file: c,
					item: linked.get(c) ?? null,
					kind: linked.get(c)?.kind ?? null,
					sessionState: stateOf(c),
					...sum(c),
				}))
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
		}))
		.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));

	return {
		items: decorated,
		hubs,
		paths: {
			ledger: LEDGER,
			sessions: SESSIONS,
			home: HOME,
			homeLabel: HOME.replace(os.homedir(), "~"), // 给人看的短形式，别把全路径铺到界面上
		},
	};
}
