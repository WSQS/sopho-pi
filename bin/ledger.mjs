#!/usr/bin/env node
/**
 * a — 事项账本（S1 + S3）
 *
 * S1：捕获 + 总览。零 LLM、零网络、可离线，比你忘掉更便宜。
 * S3：捕获后**后台自动分诊**（这条描述清不清楚），结论写回账本；
 *     助手据此建议是否开一场讨论，由你确认。
 *
 * 设计约束（来自讨论中确定的东西）：
 *   - 捕获零必填字段：只存一段裸文本 + 时间
 *   - `a` 必须立刻返回：分诊是 detached 一次性进程，不是守护进程
 *   - 能推导的东西不存：spec 路径由 id + 标题算出，spec 是否存在由文件系统答
 *   - 字段只在有行为差异时才加
 *
 * 存储：~/.pi/profiles/assistant/ledger/items.jsonl
 * 记录：
 *   {"t":"capture","id":1,"ts":...,"text":"...","state":"open"}
 *   {"t":"update","id":1,"ts":...,"state":"done"}
 *   {"t":"update","id":1,"ts":...,"clarity":"vague","note":"缺范围与完成判据"}
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { LEDGER, SESSIONS, SPECS, TRIAGE_BIN, assetPath, readAsset } from "./paths.mjs";

// 路径与政策文本一律来自 paths.mjs：
//   数据（items.jsonl / specs）在 ASSIST_HOME
//   代码（本文件 / defaults/）在本仓库
//   criteria.md、prompt-*.md 走 overrides → defaults 查找

const TTY = process.stdout.isTTY;
const C = TTY
	? {
			dim: "\x1b[2m",
			b: "\x1b[1m",
			y: "\x1b[33m",
			r: "\x1b[31m",
			g: "\x1b[32m",
			cy: "\x1b[36m",
			x: "\x1b[0m",
		}
	: { dim: "", b: "", y: "", r: "", g: "", cy: "", x: "" };

const DAY = 86_400_000;
const ACTIVE_STATES = new Set(["open", "blocked_on_human", "waiting_external"]);
const CLOSED_STATES = new Set(["done", "dropped"]);

// ─────────────────────────── 存储 ───────────────────────────

function readRecords() {
	let raw;
	try {
		raw = fs.readFileSync(LEDGER, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	const out = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			// 坏行不致命：跳过继续。账本不能因为一行损坏就整个读不出来。
		}
	}
	return out;
}

function append(record) {
	fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
	fs.appendFileSync(LEDGER, JSON.stringify(record) + "\n");
}

/** 追加式日志折叠成当前状态。id 永不复用。 */
function fold(records) {
	const items = new Map();
	// 会话状态按文件全局存：closed = "这一局交回了"，UI 据此折叠。
	// 为什么不挂在 item.links 上：一场会话只属于一个事项，但 hand_back 不该
	// 为了标记而先查出自己属于哪个事项。
	const sessionStates = new Map();
	// 下属会话的回报（一行摘要）按会话文件存，最后挂到它所属的事项上。
	// 这是「回报义务」的留痕：投递可能失败、队列可能丢，但账本里这条一直在。
	const reportsBySession = new Map();
	let nextId = 1;
	for (const r of records) {
		if (r.t === "capture") {
			const id = r.id ?? nextId;
			items.set(id, {
				id,
				text: r.text,
				createdAt: r.ts,
				updatedAt: r.ts,
				state: r.state ?? "open",
				project: r.project,
				clarity: undefined,
				note: undefined,
				accepted: false,
				next: undefined,
				// 「下一步该不该自动续跑」的标记（#22）：auto = 可推断、服务器可自动开下一轮；
				// ask = 需要人/上级拍板。缺失当 ask（最保守：不自动往下跑）。
				nextKind: undefined,
				parent: r.parent,
				links: [],
				// 服务器/机器对这条事项留下的提醒（#29）。与 reports 不同：reports 挂
				// **会话**维度（谁回报了什么），notices 挂**事项**维度（机器说了什么）。
				notices: [],
			});
			nextId = Math.max(nextId, id + 1);
		} else if (r.t === "update") {
			const it = items.get(r.id);
			if (!it) continue;
			if (r.state) it.state = r.state;
			if (r.text !== undefined) it.text = r.text;
			if (r.project !== undefined) it.project = r.project;
			if (r.clarity !== undefined) it.clarity = r.clarity;
			if (r.note !== undefined) it.note = r.note;
			if (r.accepted !== undefined) it.accepted = r.accepted;
			if (r.next !== undefined) it.next = r.next;
			// null = 显式清空（--off 用）。undefined = 这条记录没提这事，保持原值。
			if (r.nextKind !== undefined) it.nextKind = r.nextKind ?? undefined;
			it.updatedAt = r.ts;
		} else if (r.t === "link") {
			// 「事项 ↔ 会话」的归属。存下来而不是从会话名解析 —— 名字改了就断。
			const it = items.get(r.id);
			if (!it) continue;
			it.links = it.links ?? [];
			// 同 kind 同 session 合并（不是跳过）—— 补登记时要把 parent 补进去
			const found = it.links.find((l) => l.session === r.session && l.kind === r.kind);
			if (found) {
				if (r.parent) found.parent = r.parent;
			} else {
				it.links.push({ kind: r.kind, session: r.session, ts: r.ts, parent: r.parent });
			}
			it.updatedAt = r.ts; // 开了一场会话 = 有事发生，停滞时钟重置
		} else if (r.t === "unlink") {
			// 撤掉一条关联。关联错了要能撤 —— 否则 append-only 就成了牢笼。
			const it = items.get(r.id);
			if (!it?.links) continue;
			it.links = it.links.filter((l) => !(l.session === r.session && l.kind === r.kind));
		} else if (r.t === "session-state") {
			// 会话的生命周期。事实推导不出来的东西（"交回了没有"是义务），存下来。
			sessionStates.set(path.resolve(r.session), { state: r.state, ts: r.ts });
		} else if (r.t === "report") {
			// 下属会话交回时留下的一行报告。只存原文 —— 它是写给人和上级看的，
			// 不需要在这里再加工。
			const key = path.resolve(r.session);
			const list = reportsBySession.get(key) ?? [];
			list.push({ session: key, text: r.text, ts: r.ts });
			reportsBySession.set(key, list);
		} else if (r.t === "notice") {
			// 服务器自动续跑刹车时留下的回问（#29）。投递可能失败、服务器可能不在，
			// 这条也必须在 —— 所以只存原文，按时间累积。
			// 刻意**不碰 updatedAt**：刹车 =「停下来等你」，不该让停滞时钟看起来更年轻。
			const it = items.get(r.id);
			if (!it) continue;
			it.notices.push({ text: r.text, ts: r.ts });
		}
	}

	// 把回报挂到它所属的事项上（归属靠 link 记录，不靠会话名）。
	for (const it of items.values()) {
		it.reports = (it.links ?? [])
			.flatMap((l) => (reportsBySession.get(path.resolve(l.session)) ?? []).map((rep) => ({ ...rep, kind: l.kind })))
			.sort((a, b) => a.ts - b.ts);
	}
	return { items: [...items.values()], nextId, sessionStates };
}

const loadLedger = () => fold(readRecords());

// ─────────────────────── 派生：spec 路径 ───────────────────────

function slugify(text, max = 32) {
	const s = text
		.normalize("NFKC")
		.replace(/[/\\:*?"<>|\s]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const t = s.slice(0, max).replace(/-+$/g, "");
	return t || "item";
}

/** 能推导的东西不存 —— spec 路径由 id + 标题算出。 */
const specPathFor = (item) => path.join(SPECS, `${item.id}-${slugify(item.text)}.md`);
const specExists = (item) => {
	try {
		return fs.statSync(specPathFor(item)).size > 0;
	} catch {
		return false;
	}
};

// ─────────────────────────── 展示 ───────────────────────────

const ageDays = (ts) => Math.floor((Date.now() - ts) / DAY);

/** 本地时间 月-日 时:分。账本里存时间戳，显示时转本地。 */
function fmtLocal(ts) {
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一场会话真正发生的时间 —— 从会话文件名里推导，不存。
 *
 * pi 的会话文件名是 `<ISO 时间>_<uuid>.jsonl`（UTC，冒号换成连字符）。
 * 为什么不用 link 记录的 ts：那是「何时登记关联」而不是「会话何时发生」——
 * 补登记历史会话时两者能差好几个小时。能推导的就不要存。
 */
function sessionTime(link) {
	const m = path.basename(link.session).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
	if (m) {
		const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
		if (!Number.isNaN(d.getTime())) return d.getTime();
	}
	return link.ts; // 解析不了就退回登记时间
}

/** CJK 在终端里占两列 —— 用 code unit 长度 padEnd 会错位。 */
const WIDE =
	/[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const dwidth = (s) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const padTo = (s, w) => s + " ".repeat(Math.max(0, w - dwidth(s)));

/** 先算纯文本再上色，否则 padTo 会把 ANSI 转义当成可见宽度。 */
function ageCell(days) {
	const color = days >= 14 ? C.r : days >= 7 ? C.y : days >= 3 ? "" : C.dim;
	return color + padTo(`${days}天`, 6) + C.x;
}

/**
 * 叶子节点的标签 —— 只有叶子才有"自己的"进度。
 *
 *   [待聊]             缺信息  → 你决定聊不聊
 *   [有方案·待推进]     有产出物 → 你发令推进
 *   [推进中]            已在动  → 不用你管，但别让它烂
 *   [分诊失败]          报错    → 你 a retriage
 *   （空白）            判为清楚，可以直接做
 */
function leafTag(item) {
	const hasSpec = specExists(item);
	// 有方案但还没发令 → 等你拍板
	if (hasSpec && !item.accepted) return { tag: "[有方案·待推进]", tone: "wait" };
	// 发过令且有当前动作 → 有人在动。
	// **不要求有方案** —— next 本身就是那个约束（必须具体），
	// 而短事项（改个页脚、开个端口）不该被迫先写一份方案文档。
	if (item.accepted && item.next) return { tag: "[推进中]", tone: "moving" };
	// 缺信息 → 等你决定聊不聊
	if (!hasSpec && item.clarity === "vague") return { tag: "[待聊]", tone: "wait" };
	if (item.clarity === "error") return { tag: "[分诊失败]", tone: "error" };
	return { tag: "", tone: "none" };
}

const isActive = (it) => ACTIVE_STATES.has(it.state);

/**
 * 给每个节点算好展示状态。**这是唯一的一份推导逻辑** —— CLI、服务器、
 * 前端都读它的结果（经 `--json`），不各自重算。
 *
 * 两条不变量：
 *
 * 1. **父节点是纯视图。** 它自己的 `clarity` / `accepted` / `next` 一律不参与，
 *    全部从子节点算。唯一例外是 `state`（done/dropped）—— 那是你对"结项"的
 *    拍板，不是进度。
 *
 * 2. **只有叶子能 go**（在 cmdGo 里强制）。
 *
 * 返回 { byId, kids }；同时把 tag/tone/shownNext/stall/isLeaf/children 烘进 item。
 */
function annotate(items) {
	const byId = new Map(items.map((i) => [i.id, i]));
	const kids = new Map(items.map((i) => [i.id, []]));
	for (const it of items) {
		const p = it.parent != null ? byId.get(it.parent) : null;
		if (p && p !== it) kids.get(p.id).push(it); // 自指当没有父
	}
	for (const list of kids.values()) list.sort((a, b) => a.id - b.id);

	const memo = new Map();
	const derive = (it, stack) => {
		if (memo.has(it.id)) return memo.get(it.id);
		const cyc = stack.has(it.id);
		stack.add(it.id);
		const mine = kids.get(it.id);
		const days = (x) => Math.floor((Date.now() - (x.updatedAt ?? x.createdAt)) / DAY);

		let d;
		if (mine.length === 0 || cyc) {
			// 叶子（cyc = 手工造出来的环，当叶子处理，不让递归炸掉）
			if (!isActive(it)) {
				// 已收工的叶子：不再有义务。但树里还看得见它 —— 标个静默的记号。
				d = {
					isLeaf: true,
					tag: it.state === "done" ? "[已结束]" : "[已丢弃]",
					tone: "none",
					shownNext: null,
					stall: days(it),
				};
			} else {
				const t = leafTag(it);
				d = { isLeaf: true, tag: t.tag, tone: t.tone, shownNext: it.next ?? null, stall: days(it) };
			}
		} else {
			for (const c of mine) derive(c, stack);
			const act = mine.filter(isActive);
			if (act.length === 0) {
				// 子项全收工了 → 该你拍板结项。停滞算"最后一项完成到现在"。
				d = {
					isLeaf: false,
					tag: "[待拍板]",
					tone: "wait",
					shownNext: null,
					stall: Math.min(...mine.map((c) => memo.get(c.id).stall)),
				};
			} else {
				const kd = act.map((c) => ({ c, d: memo.get(c.id) }));
				const wait = kd.some(({ d: k }) => k.tone === "wait" || k.tone === "error");
				// 父节点的"当前动作"是推出来的，而且**不重复子项的正文** ——
				// 只把那个子项标出来（isNext），因为子项就在下面一行。
				// 选谁：停滞最久的活跃子项（最可能拖着的那个）。
				const first = [...kd].sort((a, b) => b.d.stall - a.d.stall)[0];
				d = {
					isLeaf: false,
					tag: wait ? "[需要你]" : "[推进中]",
					tone: wait ? "wait" : "moving",
					shownNext: null,
					nextChildId: first.c.id,
					stall: Math.max(...kd.map(({ d: k }) => k.stall)),
				};
			}
		}
		memo.set(it.id, d);
		return d;
	};

	for (const it of items) derive(it, new Set());
	for (const it of items) {
		const d = memo.get(it.id);
		it.isLeaf = d.isLeaf;
		it.tag = d.tag;
		it.tone = d.tone;
		it.shownNext = d.shownNext ?? null;
		it.stall = d.stall;
		it.isNext = false; // 由下面根据父节点的 nextChildId 标出来
		it.children = kids.get(it.id).map((c) => c.id); // 只放 id，不放节点引用
	}
	// 父节点指的那个子项打个标（不重复正文，只标）
	for (const it of items) {
		const nid = memo.get(it.id)?.nextChildId;
		if (nid != null && byId.has(nid)) byId.get(nid).isNext = true;
	}
	return { byId, kids };
}

function tagCell(it) {
	const color = it.tone === "wait" ? C.y : it.tone === "moving" ? C.cy : it.tone === "error" ? C.r : C.dim;
	return color + padTo(it.tag, 17) + C.x;
}

function truncate(s, n) {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

function cmdList(asJson) {
	const { items, sessionStates } = loadLedger();
	const { byId, kids } = annotate(items);
	const active = items.filter(isActive);
	const closed = items.filter((i) => CLOSED_STATES.has(i.state));
	// 顶层节点：没父，或父不存在（父被删了不该让子项失踪）。停滞最久的排最前。
	const roots = active
		.filter((i) => i.parent == null || !byId.has(i.parent))
		.sort((a, b) => b.stall - a.stall || a.id - b.id);

	if (asJson) {
		console.log(
			JSON.stringify(
				{
					path: LEDGER,
					specs: SPECS,
					// 每个 item 已经带上了推导好的 tag/tone/shownNext/stall/isLeaf/children
					items: items.map((i) => ({ ...i, spec: specExists(i) ? specPathFor(i) : null })),
					active: active.length,
					// 会话文件 → { state: "open"|"closed", ts }。UI 用它折叠已交回的会话。
					sessionStates: Object.fromEntries(sessionStates),
				},
				null,
				2,
			),
		);
		return 0;
	}

	if (items.length === 0) {
		console.log(`${C.dim}账本是空的。${C.x}`);
		// 提示只在 TTY 里出现 —— 这些输出会进助手的上下文，别让例子文案变噪音
		if (TTY) console.log(`\n捕获一条：  ${C.b}a "想做的事"${C.x}`);
		return 0;
	}

	if (active.length === 0) {
		console.log(`${C.g}进行中的事项：0 条${C.x}`);
	} else {
		const width = Math.max(...active.map((i) => String(i.id).length));
		// 续行对齐：lead + id 列 + age 列(6) + 两个间隔
		const cont = (lead) => " ".repeat(dwidth(lead) + width + 12);

		const walk = (it, depth) => {
			const lead = "  " + "  ".repeat(depth);
			const mark = it.isNext ? `${C.cy}▸${C.x}` : " ";
			console.log(
				`${lead}${mark}${C.dim}${String(it.id).padStart(width)}${C.x}  ${ageCell(it.stall)}  ${tagCell(it)}${truncate(it.text, 62)}`,
			);
			// 只有**叶子**才有自己的当前动作。父节点的"下一个"靠子项上的 ▸ 标出来。
			if (it.shownNext) console.log(`${cont(lead)}${C.dim}└ ${truncate(it.shownNext, 70)}${C.x}`);
			if (it.links?.length) {
				const names = it.links
					.slice()
					.sort((a, b) => a.ts - b.ts)
					.map((l) => `${l.kind} ${fmtLocal(sessionTime(l))}`)
					.join(" · ");
				console.log(`${cont(lead)}${C.dim}⤷ ${names}${C.x}`);
			}
			// 最新一条回报 —— 事项留痕要看的就是它（全部都在 JSON 里）。
			const lastReport = it.reports?.[it.reports.length - 1];
			if (lastReport) {
				console.log(`${cont(lead)}${C.dim}↩ ${fmtLocal(lastReport.ts)} ${truncate(lastReport.text, 66)}${C.x}`);
			}
			// 最新一条提醒（#29：服务器刹车回问）。黄标 —— 它通常意味着「等你」。
			const lastNotice = it.notices?.[it.notices.length - 1];
			if (lastNotice) {
				console.log(`${cont(lead)}${C.y}! ${fmtLocal(lastNotice.ts)} ${truncate(lastNotice.text, 66)}${C.x}`);
			}
			for (const c of kids.get(it.id) ?? []) walk(c, depth + 1);
		};
		for (const r of roots) walk(r, 0);
	}

	const leaves = active.filter((i) => i.isLeaf);
	const oldest = active.length ? Math.max(...active.map((i) => i.stall)) : 0;
	const needYou = roots.filter((i) => i.tone === "wait").length;
	const moving = roots.filter((i) => i.tone === "moving").length;
	const pending = leaves.filter((i) => i.clarity === undefined).length;
	const parts = [`${active.length} 条进行中`];
	if (needYou) parts.push(`${needYou} 条需要你`);
	if (moving) parts.push(`${moving} 条推进中`);
	if (pending) parts.push(`${pending} 条未分诊`);
	if (closed.length) parts.push(`${closed.length} 条已结束`);
	if (active.length) parts.push(`最久 ${oldest} 天`);
	console.log(`\n${C.dim}${parts.join(" · ")}${C.x}`);
	if (TTY) {
		const hints = [];
		const talk = leaves.find((i) => i.tag === "[待聊]");
		const go = leaves.find((i) => i.tag === "[有方案·待推进]");
		if (talk) hints.push(`想聊： a discuss ${talk.id}`);
		if (go) hints.push(`要推进： a go ${go.id} --next "…"`);
		if (pending) hints.push(`未分诊： a retriage ${leaves.find((i) => i.clarity === undefined)?.id}`);
		if (hints.length) console.log(`${C.dim}${hints.join("    ")}${C.x}`);
	}
	return 0;
}

// ─────────────────────────── 分诊 ───────────────────────────

function spawnTriage(id) {
	try {
		const child = spawn(process.execPath, [TRIAGE_BIN, String(id)], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// ─────────────────────────── 命令 ───────────────────────────

function fail(msg) {
	console.error(`${C.r}${msg}${C.x}`);
	return 1;
}

function cmdCapture(text, parentId) {
	const clean = text.trim();
	if (!clean) return fail('内容为空。用法：a "想做的事"');
	const { items, nextId } = loadLedger();
	if (parentId != null && !items.some((i) => i.id === parentId)) {
		return fail(`没有 #${parentId} 这条，不能当父节点。`);
	}
	append({ t: "capture", id: nextId, ts: Date.now(), text: clean, state: "open", parent: parentId });
	const bg = spawnTriage(nextId);
	console.log(`${C.dim}记下了${C.x} ${C.b}#${nextId}${C.x}  ${truncate(clean, 62)}`);
	if (parentId != null) console.log(`${C.dim}挂在 #${parentId} 下面 —— 它因此成为「项目」${C.x}`);
	if (TTY) console.log(`${C.dim}${bg ? "后台正在判断清晰度" : "分诊启动失败（不影响记录）"}${C.x}`);
	return 0;
}

/** 建一个子事项。父节点是什么不重要 —— 有子节点它就成为「项目」。 */
function cmdSub(args) {
	const [parentArg, ...tail] = args;
	const parentId = Number.parseInt(parentArg ?? "", 10);
	if (!Number.isInteger(parentId)) return fail('用法：a sub <父id> "想做的事"');
	return cmdCapture(tail.join(" "), parentId);
}

function resolveId(arg) {
	const id = Number.parseInt(arg ?? "", 10);
	if (!Number.isInteger(id)) {
		fail(`需要一个数字 id，收到的是 "${arg ?? ""}"。`);
		console.error(`${C.dim}如果你是想记录这句话，用： a add ${JSON.stringify(arg ?? "")}${C.x}`);
		return null;
	}
	const item = loadLedger().items.find((i) => i.id === id);
	if (!item) {
		fail(`没有 #${id} 这条。用 a 看全部。`);
		return null;
	}
	return item;
}

function cmdTransition(arg, state) {
	const item = resolveId(arg);
	if (!item) return 1;
	append({ t: "update", id: item.id, ts: Date.now(), state });
	console.log(`${C.dim}已${state === "done" ? "完成" : "丢弃"}${C.x} ${C.b}#${item.id}${C.x}  ${truncate(item.text, 62)}`);
	return 0;
}

function cmdOk(arg) {
	const item = resolveId(arg);
	if (!item) return 1;
	append({ t: "update", id: item.id, ts: Date.now(), clarity: "clear", note: "由本人确认无需讨论" });
	console.log(`${C.dim}标记为清楚，不再提示${C.x} ${C.b}#${item.id}${C.x}  ${truncate(item.text, 62)}`);
	return 0;
}

/**
 * 发令推进。**必须给出「当前动作」** —— 否则 go 就只是把 [有方案·待推进] 抹掉，
 * 事项退回空白并从视野里消失（那正是“漏”的成因）。
 */
function cmdGo(args) {
	const off = args.includes("--off");
	const ni = args.indexOf("--next");
	const next = ni >= 0 ? args[ni + 1] : undefined;
	// #22 续跑标记：--kind auto|ask。不写就当 ask（最保守 = 不自动续跑）。
	const ki = args.indexOf("--kind");
	const kind = ki >= 0 ? args[ki + 1] : undefined;
	const idArg = args.find((a) => !a.startsWith("--"));
	const item = resolveId(idArg);
	if (!item) return 1;

	// 不变量：只有叶子能 go。父节点的推进 = 推进它的某个子项。
	const { kids } = annotate(loadLedger().items);
	if ((kids.get(item.id) ?? []).length > 0) {
		fail(`#${item.id} 有子事项，不能直接推进 —— 推进它的某个子项。`);
		console.log(
			`${C.dim}子项： ${(kids.get(item.id) ?? [])
				.map((c) => `#${c.id} ${truncate(c.text, 20)}`)
				.join("   ")}${C.x}`,
		);
		return 1;
	}

	if (off) {
		append({ t: "update", id: item.id, ts: Date.now(), accepted: false, next: "", nextKind: null });
		console.log(`${C.dim}已撤销发令（回到待推进）${C.x} ${C.b}#${item.id}${C.x}  ${truncate(item.text, 62)}`);
		return 0;
	}

	// 不再要求先有方案文档：next（当前动作）本身就是那个约束。
	// 方案是“聊过”的产物，不是“能推进”的前提 —— 短事项不该被它拦住。
	if (kind !== undefined && kind !== "auto" && kind !== "ask") {
		return fail(`--kind 只能是 auto 或 ask，收到的是 "${kind}"。`);
	}
	if (!next?.trim()) {
		fail("发令推进必须说明「当前动作」—— 具体现在做什么。");
		console.log(`${C.dim}例： a go ${item.id} --next "起一个最小 Godot 项目 + 一块能跑的落沙网格"${C.x}`);
		console.log(`${C.dim}没有具体动作就不允许推进：那样它只会从列表里消失，不会真的动起来。${C.x}`);
		return 1;
	}

	append({ t: "update", id: item.id, ts: Date.now(), accepted: true, next: next.trim(), nextKind: kind ?? "ask" });
	console.log(`${C.dim}已发令推进${C.x} ${C.b}#${item.id}${C.x}  ${truncate(item.text, 62)}`);
	console.log(`${C.dim}当前动作：${C.x}${next.trim()}`);
	console.log(`${C.dim}续跑标记：${C.x}${kind ?? "ask"}${(kind ?? "ask") === "ask" ? "（停下等你）" : "（可推断 → 服务器可在轮末续跑）"}`);
	console.log(`${C.dim}开执行会话： a exec ${item.id}${C.x}`);
	return 0;
}

/**
 * 登记「事项 ↔ 会话」关联。主要由扩展/服务器调用，不指望人手动敲。
 *
 * `--parent <file>` 记「这个会话从哪个会话派生」—— 血缘存账本，不依赖会话
 * 文件头里的 parentSession（那个是 pi 的事，而且历史会话根本没有）。
 * 有它才能在界面上把根会话画成树干。
 */
function cmdLink(args) {
	const pi = args.indexOf("--parent");
	const parent = pi >= 0 ? args[pi + 1] : undefined;
	const rest = pi >= 0 ? [...args.slice(0, pi), ...args.slice(pi + 2)] : args;
	const [idArg, kind, ...tail] = rest;
	const session = tail.join(" ").trim();
	const item = resolveId(idArg);
	if (!item) return 1;
	if (!kind || !session) return fail("用法：a link <id> <kind> <sessionFile> [--parent <file>]");
	// 只接受**会话根下**的文件。
	// 为什么卡在这里：我曾经把自己的开发会话（住在 ~/.pi/agent）挂进来，
	// 为了能读它，逼出了“跨 profile 多会话根”一整套特例。特例的根源就在这个入口，
	// 所以把它堵在写入端，而不是在读取端放宽。
	const under = (f) => path.resolve(f).startsWith(path.resolve(SESSIONS) + path.sep);
	if (!under(session)) {
		return fail(`只能关联会话根下的文件：\n  ${SESSIONS}\n收到的是：\n  ${session}`);
	}
	if (parent && !under(parent)) return fail(`--parent 也必须在会话根下：${parent}`);
	append({ t: "link", id: item.id, ts: Date.now(), kind, session, parent });
	console.log(
		`${C.dim}已关联${C.x} ${C.b}#${item.id}${C.x} ${kind} → ${path.basename(session)}${parent ? `${C.dim}（派生自 ${path.basename(parent)}）${C.x}` : ""}`,
	);
	return 0;
}

/**
 * 标记一场会话的状态。主要由 hand_back 写 closed —— "这一局交回了"是义务，
 * 必须落盘（跨重启）。服务端收到新消息时写回 open。
 *
 * 状态按文件全局存，所以不需要知道它属于哪个事项。
 */
function cmdSession(args) {
	const [file, state] = args;
	if (!file || (state !== "open" && state !== "closed")) {
		return fail("用法：a session <会话文件> <open|closed>");
	}
	const under = (f) => path.resolve(f).startsWith(path.resolve(SESSIONS) + path.sep);
	if (!under(file)) return fail(`只能标记会话根下的文件：\n  ${SESSIONS}\n收到的是：\n  ${file}`);
	append({ t: "session-state", session: path.resolve(file), state, ts: Date.now() });
	console.log(`${C.dim}会话已标记 ${state}${C.x} ${path.basename(file)}`);
	return 0;
}

/**
 * 记下一行回报 —— 下属会话交回时写。
 *
 * 这是 #12 里「写进账本（事项留痕，不丢）」那一半。另一半（叫醒上级）走服务器
 * 的投递队列。两者分开：投递可能失败，账本这条不会。
 */
function cmdReport(args) {
	const [file, ...tail] = args;
	const text = tail.join(" ").trim();
	if (!file || !text) return fail("用法：a report <会话文件> <一行摘要>");
	const under = (f) => path.resolve(f).startsWith(path.resolve(SESSIONS) + path.sep);
	if (!under(file)) return fail(`只能记会话根下的会话：\n  ${SESSIONS}\n收到的是：\n  ${file}`);
	append({ t: "report", session: path.resolve(file), text, ts: Date.now() });
	console.log(`${C.dim}已记下回报${C.x} ${path.basename(file)}  ${truncate(text, 70)}`);
	return 0;
}

/**
 * 记一条「提醒」到事项上（#29）—— 服务器自动续跑刹车回问时写。
 *
 * 与 `a report` 的分工：report 挂**会话**维度（谁回报了什么）；notice 挂
 * **事项**维度（机器/服务器对这条事项说了什么）。刹车回问恰恰是「会话开不
 * 下去」，没有会话可挂，所以必须用 item 维度。
 *
 * 这是 #12「双写」思路在刹车回问上的落地：投递叫醒上游是另一半，失败了没关系，
 * 账本这条一直在。
 */
function cmdNotice(args) {
	const [idArg, ...tail] = args;
	const text = tail.join(" ").trim();
	const item = resolveId(idArg);
	if (!item) return 1;
	if (!text) return fail('用法：a notice <id> "一行说明"');
	append({ t: "notice", id: item.id, ts: Date.now(), text });
	console.log(`${C.dim}已记下提醒${C.x} ${C.b}#${item.id}${C.x}  ${truncate(text, 70)}`);
	return 0;
}

/** 撤掉一条「事项 ↔ 会话」关联。 */
function cmdUnlink(args) {
	const [idArg, kind, ...tail] = args;
	const session = tail.join(" ").trim();
	const item = resolveId(idArg);
	if (!item) return 1;
	if (!kind || !session) return fail("用法：a unlink <id> <kind> <sessionFile>");
	append({ t: "unlink", id: item.id, ts: Date.now(), kind, session });
	console.log(`${C.dim}已解除关联${C.x} ${C.b}#${item.id}${C.x} ${kind} → ${path.basename(session)}`);
	return 0;
}

/** 开执行会话，去做那条事项的「当前动作」。 */
function cmdExec(args) {
	const dry = args.includes("--dry");
	const promptOnly = args.includes("--prompt");
	const jsonOut = args.includes("--json");
	const idArg = args.find((a) => !a.startsWith("--"));
	const item = resolveId(idArg);
	if (!item) return 1;
	if (!item.next) {
		if (jsonOut) {
			console.log(JSON.stringify({ error: `#${item.id} 还没有「当前动作」` }));
			return 1;
		}
		console.log(`${C.dim}#${item.id} 还没有「当前动作」。先发令：${C.x} ${C.b}a go ${item.id} --next "..."${C.x}`);
		return 0;
	}

	const tplAsset = readAsset("prompt-execute.md");
	if (!tplAsset) return fail(`读不到提示词模板 ${assetPath("prompt-execute.md")}`);
	const tpl = tplAsset.text;
	fs.mkdirSync(SPECS, { recursive: true });
	const prompt = tpl
		.replaceAll("{{id}}", String(item.id))
		.replaceAll("{{text}}", item.text)
		.replaceAll("{{spec}}", specPathFor(item))
		.replaceAll("{{next}}", item.next);
	const name = `推进：#${item.id} ${truncate(item.text, 18)}`;

	// 同 discuss：宿主只读这份结果，不自己拼模板。
	if (jsonOut) {
		console.log(JSON.stringify({ kind: "exec", id: item.id, name, spec: specPathFor(item), prompt }));
		return 0;
	}

	if (promptOnly) {
		process.stdout.write(prompt);
		return 0;
	}
	if (dry) {
		console.log(`${C.dim}会执行：${C.x} assistant --name ${JSON.stringify(name)} <下面的提示词>\n`);
		console.log(prompt);
		return 0;
	}

	console.log(`${C.dim}启动执行会话 …（退出后看： a spec ${item.id}）${C.x}\n`);
	const r = spawnSync("assistant", ["--name", name, prompt], { stdio: "inherit" });
	return r.status ?? 0;
}

function cmdRetriage(arg) {
	const item = resolveId(arg);
	if (!item) return 1;
	console.log(`${C.dim}重新分诊 #${item.id} …${C.x}`);
	spawnSync(process.execPath, [TRIAGE_BIN, String(item.id)], { stdio: "inherit", env: process.env });
	const after = loadLedger().items.find((i) => i.id === item.id);
	if (after) {
		const label =
			after.clarity === "vague"
				? `${C.y}要讨论${C.x}`
				: after.clarity === "clear"
					? `${C.g}清楚${C.x}`
					: `${C.r}${after.clarity ?? "未分诊"}${C.x}`;
		console.log(`  → ${label}${after.note ? `  ${C.dim}${after.note}${C.x}` : ""}`);
	}
	return 0;
}

function cmdSpec(arg) {
	const item = resolveId(arg);
	if (!item) return 1;
	const p = specPathFor(item);
	if (!specExists(item)) {
		console.log(`${C.dim}还没有方案。开一场讨论：${C.x}${C.b}a discuss ${item.id}${C.x}`);
		return 0;
	}
	console.log(`${C.dim}${p}${C.x}\n`);
	console.log(fs.readFileSync(p, "utf8"));
	return 0;
}

function cmdDiscuss(args) {
	const dry = args.includes("--dry");
	const cmdOnly = args.includes("--cmd");
	const promptOnly = args.includes("--prompt");
	const jsonOut = args.includes("--json");
	const idArg = args.find((a) => !a.startsWith("--"));
	const item = resolveId(idArg);
	if (!item) return 1;

	// 无论走哪条路径都要先建好产出目录 —— --prompt 路径不会走到下面的启动分支
	fs.mkdirSync(SPECS, { recursive: true });

	// 给 pi 扩展用：只要启动命令和产出路径，不要整套提示词。
	if (cmdOnly) {
		console.log(`a discuss ${item.id}`);
		console.log(specPathFor(item));
		return 0;
	}

	const tplAsset = readAsset("prompt-discuss.md");
	if (!tplAsset) return fail(`读不到提示词模板 ${assetPath("prompt-discuss.md")}`);
	const tpl = tplAsset.text;
	const spec = specPathFor(item);
	const prompt = tpl
		.replaceAll("{{id}}", String(item.id))
		.replaceAll("{{text}}", item.text)
		.replaceAll("{{spec}}", spec);
	const name = `方案：#${item.id} ${truncate(item.text, 24)}`;

	// 给服务器等宿主用：一次拿到提示词、会话名、产出路径。
	// 渲染只在这里一份（硬约束 #15）—— 宿主不许自己拼模板。
	if (jsonOut) {
		console.log(JSON.stringify({ kind: "discuss", id: item.id, name, spec, prompt }));
		return 0;
	}

	// 给 pi 扩展用：只要提示词本身，不要任何包装。
	if (promptOnly) {
		process.stdout.write(prompt);
		return 0;
	}

	if (dry) {
		console.log(`${C.dim}会执行：${C.x} assistant --name ${JSON.stringify(name)} <下面的提示词>\n`);
		console.log(`${C.dim}方案将写到：${C.x} ${spec}\n`);
		console.log(prompt);
		return 0;
	}

	fs.mkdirSync(SPECS, { recursive: true });
	console.log(`${C.dim}启动讨论会话 …（退出后看： a spec ${item.id}）${C.x}\n`);
	const r = spawnSync("assistant", ["--name", name, prompt], { stdio: "inherit" });
	return r.status ?? 0;
}

const HELP = `${C.b}a${C.x} — 事项账本

${C.b}捕获${C.x}
  a "想做的事"        捕获一条（唯一要求：一段文本），后台自动判断清晰度
  a sub <父id> "文本"  建一个子事项（父节点因此成为「项目」）
  a add "文本"        显式写法（文本以命令词开头时用）
  a add --parent <id> "文本"   同上，但挂在某个事项下面

${C.b}看${C.x}
  a                   总览：进行中的全部事项，最久的排最前
  a --json            机器可读输出

${C.b}分诊${C.x}
  a retriage <id>     重新判断这条清不清楚

${C.b}讨论${C.x}
  a discuss <id>      开一场专属讨论会话，产出 specs/<id>-*.md
  a discuss <id> --dry  只打印将要注入的提示词，不启动
  a spec <id>         看这场讨论产出的方案

${C.b}推进${C.x}
  a go <id> --next "当前动作"   发令推进（必须给出具体现在做什么）
  a go <id> --next "…" --kind auto|ask   标下一步的续跑种类（默认 ask）
  a exec <id>                  开执行会话去做那个动作
  a exec <id> --dry            只打印将要注入的提示词
  a go <id> --off              撤销发令，回到待推进

${C.b}关联${C.x}
  a link <id> <kind> <file> [--parent <file>]   把会话挂到事项下（只能挂会话根下的）
  a unlink <id> <kind> <file>                  解除关联
  a session <file> <open|closed>               标记会话状态（closed = 收起来）
  a report <file> "一行摘要"                   记下下属会话的回报（交回时写）
  a notice <id> "一行说明"                     记一条提醒到事项上（服务器刹车回问写）

${C.b}结束${C.x}
  a ok <id>           确认这条不用聊（消除 [待聊] 标记）
  a done <id>         标记完成
  a drop <id>         丢弃（不是所有事都值得做）

${C.dim}标签：[待聊] 缺信息 · [有方案·待推进] 等你发令 · [推进中] 已在动 · 空白 = 可以直接做
     [需要你] 父节点，某个子项在等你 · [待拍板] 子项全完成，等你结项
     （父节点是纯视图：它的标签/当前动作/停滞全部从子项推导）
账本：${LEDGER}
判据：${assetPath("criteria.md")}${C.x}`;

function main(argv) {
	const [first, ...rest] = argv;
	const restText = rest.join(" ");

	if (first === undefined) return cmdList(false);
	if (first === "--json") return cmdList(true);
	if (first === "ls" || first === "list") return cmdList(false);
	if (first === "help" || first === "--help" || first === "-h") {
		console.log(HELP);
		return 0;
	}
	if (first === "path") {
		console.log(LEDGER);
		return 0;
	}
	if (first === "done") return cmdTransition(rest[0], "done");
	if (first === "drop") return cmdTransition(rest[0], "dropped");
	if (first === "ok") return cmdOk(rest[0]);
	if (first === "go") return cmdGo(rest);
	if (first === "exec") return cmdExec(rest);
	if (first === "link") return cmdLink(rest);
	if (first === "unlink") return cmdUnlink(rest);
	if (first === "session") return cmdSession(rest);
	if (first === "report") return cmdReport(rest);
	if (first === "notice") return cmdNotice(rest);
	if (first === "retriage") return cmdRetriage(rest[0]);
	if (first === "discuss") return cmdDiscuss(rest);
	if (first === "spec") return cmdSpec(rest[0]);
	if (first === "add") {
		const pi = rest.indexOf("--parent");
		if (pi >= 0) {
			const pid = Number.parseInt(rest[pi + 1] ?? "", 10);
			const text = [...rest.slice(0, pi), ...rest.slice(pi + 2)].join(" ");
			return cmdCapture(text, Number.isInteger(pid) ? pid : undefined);
		}
		return cmdCapture(restText);
	}
	if (first === "sub") return cmdSub(rest);

	// 默认动作是捕获 —— 最常见的操作必须最短。
	return cmdCapture(argv.join(" "));
}

process.exit(main(process.argv.slice(2)));
