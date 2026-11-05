/**
 * sopho-pi 前端 —— M2
 *
 * 两栏：左栏「事项 → 会话」，右栏会话正文 + 输入框。
 *
 * 流式用浏览器的 EventSource（原生 SSE）：
 *   - 自带断线重连，比手写解析可靠
 *   - 重连后会再收一次 hello，我们据此重新对齐状态
 *     （断线期间错过的 run end 就靠这个自愈）
 *
 * vanilla ESM，无构建步骤：改完刷新即可。
 */

import { createOptimistic } from "./optimistic.mjs";

const $ = (sel) => document.querySelector(sel);
const treeEl = $("#tree");
const pathsEl = $("#paths");
const headEl = $("#right-head");
const msgsEl = $("#messages");
const inputEl = $("#input");
const sendEl = $("#send");
const hintEl = $("#composer-hint");

// 令牌（可选）：只有服务器设了 SOPHO_TOKEN 时才需要。
// 从 ?t=… 拿一次存进 sessionStorage，之后所有请求都带上。
const TOKEN =
	new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("sopho-token") ?? "";
if (TOKEN) sessionStorage.setItem("sopho-token", TOKEN);
const withToken = (url) =>
	TOKEN ? `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}` : url;
const api = (url, init) =>
	fetch(withToken(url), {
		...init,
		headers: { ...(init?.headers ?? {}), ...(TOKEN ? { "x-sopho-token": TOKEN } : {}) },
	});

let connected = false; // SSE 连着吗

let tree = null;
let liveFiles = new Set(); // 池子里 streaming 的会话文件
// #22 自动续跑：会话文件 → { itemId, turn, quota, status }；事项 id → 链条状态。
// 都来自 /api/live —— 服务器内存里的运行期状态（重启不恢复，所以不落账本）。
let autoByFile = new Map();
let autoChains = new Map();
let activeFile = null;
let activeMessages = []; // 从文件读的权威历史
let liveRun = null; // { text, tools[], running, error } —— 当前这一轮的实时状态
// 我发出去的、还没从文件里读到的消息。
// 为什么要它：prompt 被接受后，消息要等这一轮跑完我们重读文件才出现 ——
// 那你点完发送会看到输入框空了、却什么都没多出来。所以先乐观显示。
// 必须按会话文件隔离（修 #15）：否则在 A 发的话会串到随后打开的 B 里。
const pending = createOptimistic();
let es = null;

// ─────────────────────────── 小工具 ───────────────────────────

function el(tag, props = {}, ...kids) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === null || v === undefined) continue;
		if (k === "class") n.className = v;
		else if (k === "text") n.textContent = v;
		else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const kid of kids) if (kid) n.append(kid);
	return n;
}

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (ts) => {
	if (!ts) return "—";
	const d = new Date(ts);
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ageDays = (ts) => (ts ? Math.floor((Date.now() - ts) / 86_400_000) : null);

const KIND_LABEL = { discuss: "讨论", exec: "执行" };
const kindLabel = (k) => KIND_LABEL[k] ?? k ?? "会话";
/** #22 链条状态 → 给人看的话。 */
const CHAIN_STATUS = { running: "在跑", "waiting-upstream": "等上游确认", stopped: "已急停", error: "出错停了" };
/** 按 kind 数一下，给折叠摘要用：讨论 1 · 执行 1 */
function kindCounts(sessions) {
	const counts = new Map();
	for (const s of sessions) {
		const k = kindLabel(s.kind);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return [...counts].map(([k, n]) => `${k} ${n}`).join(" · ");
}
function sessionLabel(s) {
	if (s.label) return s.label;
	if (s.name) return s.name;
	return kindLabel(s.kind);
}

/** 文本 delta 来得很快 —— 合并到下一帧再渲染。 */
let rafPending = false;
function scheduleRender() {
	if (rafPending) return;
	rafPending = true;
	requestAnimationFrame(() => {
		rafPending = false;
		renderRight();
	});
}

// ─────────────────────────── 左栏 ───────────────────────────

const GROUPS = [
	{ tone: "wait", title: "需要你" },
	{ tone: "moving", title: "推进中" },
	{ tone: "error", title: "出错了" },
	{ tone: "none", title: "其它" },
];

function sessionRow(s) {
	const badges = [];
	if (liveFiles.has(s.file)) badges.push(el("span", { class: "live", text: "●" }));
	// #22：这场是服务器自动开的第几轮 —— 和手动开的会话一眼分得开。
	const a = autoByFile.get(s.file);
	if (a)
		badges.push(
			el("span", {
				class: "auto",
				text: `⟳自动 ${a.turn}`,
				title: `服务器自动开的第 ${a.turn} 轮（额度 ${a.quota}）`,
			}),
		);
	if (s.missing) badges.push(el("span", { class: "bad", text: "文件不见了" }));
	else {
		badges.push(el("span", { text: `${s.messages ?? 0} 条` }));
		if (s.toolCalls) badges.push(el("span", { text: `${s.toolCalls} 工具` }));
		badges.push(el("span", { text: fmtTime(s.createdAt) }));
	}
	return el(
		"div",
		{ class: `sess${activeFile === s.file ? " active" : ""}`, onclick: () => openSession(s.file), title: s.file },
		el("span", { class: "kind", text: sessionLabel(s) }),
		...badges,
	);
}

/**
 * 根会话卡片：它自己 + 它派生出来的会话。
 *
 * 标签按"它属于哪个事项"来，而不是固定的"主页" —— 因为我们有两类根：
 * 助手的主会话（不属于任何事项），和某个事项的主会话（比如 #2 的开发会话）。
 */
function hubCard(h) {
	const label = h.item
		? `⌂ #${h.item.id} ${h.item.text.slice(0, 14)}`
		: `⌂ ${h.name ?? "未关联"}`;
	const kids = [sessionRow({ ...h, label })];
	const children = h.children ?? [];
	const openKids = children.filter((c) => c.sessionState !== "closed");
	const closedKids = children.filter((c) => c.sessionState === "closed");
	if (openKids.length) {
		const sub = el("div", { class: "children" });
		for (const c of openKids) {
			const cl = c.item ? `${kindLabel(c.kind)} #${c.item.id}` : kindLabel(c.kind ?? "会话");
			sub.append(sessionRow({ ...c, label: cl }));
		}
		kids.push(sub);
	}
	if (closedKids.length) {
		kids.push(el("div", { class: "meta pruned", text: `… ${closedKids.length} 条派生会话已结束` }));
	}
	return el("div", { class: "item" }, ...kids);
}

/**
 * 把扁平的 items 建回树。
 *
 * 账本已经在每个 item 上算好了 parent / children / isLeaf / isNext / stall，
 * 所以这里只是把 id 关系接成节点关系 —— 不重新推导任何东西。
 * 父不存在的（父被删了）当顶层，不让子项失踪。
 */
function indexItems(items) {
	const byId = new Map(items.map((i) => [i.id, i]));
	const kids = new Map(items.map((i) => [i.id, []]));
	const roots = [];
	for (const it of items) {
		const p = it.parent != null ? byId.get(it.parent) : null;
		if (p && p !== it) kids.get(p.id).push(it);
		else roots.push(it);
	}
	return { byId, kids, roots };
}

/**
 * 一个节点「整棵子树都已结束」吗？
 *
 * 结束的子树在界面上收成一行摘要（见 itemCard）。为什么不直接按 state 过滤：
 * 已结束的父节点下面可能还挂着没结束的子项 —— 那种情况不能藏，否则会把
 * 还在动的东西一起埋掉。所以只有「自己结束 且 所有后代都结束」才收起来。
 * 记忆化，避免每个节点都重走一遍子树。
 */
function prunedIndex(kids) {
	const memo = new Map();
	const closed = (it) => it.state === "done" || it.state === "dropped";
	const fully = (it) => {
		if (memo.has(it.id)) return memo.get(it.id);
		const v = closed(it) && (kids.get(it.id) ?? []).every(fully);
		memo.set(it.id, v);
		return v;
	};
	return fully;
}

/** #22：一条 auto 链的状态行 —— 轮次 + 状态 + 急停按钮。 */
function chainRow(ch) {
	const live = ch.status === "running" || ch.status === "waiting-upstream";
	return el(
		"div",
		{ class: `meta chain chain-${ch.status}` },
		el("span", { class: "spin", text: `⟳ 自动续跑 ${ch.runs}/${ch.quota} · ${CHAIN_STATUS[ch.status] ?? ch.status}` }),
		live
			? el("button", {
					class: "stop",
					text: "急停",
					title: "不再自动开新轮（正在跑的那一轮不动）",
					onclick: (e) => {
						e.stopPropagation();
						doStopChain(ch.itemId);
					},
				})
			: null,
	);
}

/** 急停一条 auto 链：服务端不再自动开新轮。重新发动 = 手动再发一次令。 */
async function doStopChain(id) {
	try {
		await api("/api/auto-stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
	} finally {
		await load();
	}
}

function itemCard(it, kids, fully) {
	const age = it.stall ?? 0;
	const head = el(
		"div",
		{ class: "head" },
		it.isNext ? el("span", { class: "mark", text: "▸" }) : null,
		el("span", { class: "id", text: `#${it.id}` }),
		it.tag ? el("span", { class: "tag", text: it.tag }) : null,
		el("span", { class: "age" + (age >= 7 ? " stale" : ""), text: `${age}天` }),
	);
	const box = el("div", { class: `item tone-${it.tone}` }, head, el("div", { class: "text", text: it.text }));

	// #22：当前动作若标了 auto，在它前面挂一个可见标记（标记本身落账本，这里只渲染）。
	if (it.shownNext) {
		box.append(
			el(
				"div",
				{ class: "meta next" },
				it.nextKind === "auto"
					? el("span", { class: "spin", text: "⟳auto ", title: "可推断 → 服务器会在这轮结束后自动续跑" })
					: null,
				el("span", { text: it.shownNext }),
			),
		);
	}
	// #22：这条事项的自动链状态（第几轮 / 在跑还是刹车）。
	const ch = autoChains.get(it.id);
	if (ch) box.append(chainRow(ch));
	if (it.note) box.append(el("div", { class: "meta", text: it.note }));
	// 已交回的会话收成一行摘要（和事项的折叠同一套视觉）。
	const sess = it.sessions ?? [];
	const openSess = sess.filter((s) => s.sessionState !== "closed");
	const closedSess = sess.filter((s) => s.sessionState === "closed");
	for (const s of openSess) box.append(sessionRow(s));
	if (closedSess.length) {
		box.append(el("div", { class: "meta pruned", text: `… ${kindCounts(closedSess)} 已结束` }));
	}

	const cs = kids.get(it.id) ?? [];
	const shown = cs.filter((c) => !fully(c));
	const hidden = cs.filter(fully);
	if (shown.length) {
		const sub = el("div", { class: "children" });
		for (const c of shown) sub.append(itemCard(c, kids, fully));
		box.append(sub);
	}
	// 已结束的子项收成一行摘要，而不是完全消失 —— 否则父节点看起来像个叶子。
	if (hidden.length) {
		const done = hidden.filter((c) => c.state === "done").length;
		const dropped = hidden.length - done;
		const parts = [];
		if (done) parts.push(`已完成 ${done}`);
		if (dropped) parts.push(`已丢弃 ${dropped}`);
		box.append(el("div", { class: "meta pruned", text: `… ${parts.join(" · ")}` }));
	}
	return box;
}

function renderLeft() {
	const y = treeEl.scrollTop;
	treeEl.replaceChildren();
	const items = tree?.items ?? [];
	const { kids, roots } = indexItems(items);
	const fully = prunedIndex(kids);
	// 根也适用同一条规则：整棵子树结束才隐藏（已结束但还有活跃子项的根不能藏）。
	const activeRoots = roots.filter((r) => !fully(r));

	for (const g of GROUPS) {
		const list = activeRoots
			.filter((r) => (r.tone ?? "none") === g.tone)
			.sort((a, b) => (b.stall ?? 0) - (a.stall ?? 0) || a.id - b.id);
		if (!list.length) continue;
		const group = el("section", { class: `group ${g.tone}` }, el("h2", { text: `${g.title} · ${list.length}` }));
		for (const it of list) group.append(itemCard(it, kids, fully));
		treeEl.append(group);
	}

	const hubs = tree?.hubs ?? [];
	if (hubs.length) {
		const group = el("section", { class: "group hub" }, el("h2", { text: `根会话 · ${hubs.length}` }));
		for (const h of hubs) group.append(hubCard(h));
		treeEl.append(group);
	}

	// 根会话 = 没有父的会话。“未关联的会话”本来就是它的子集（没父、也没 link），
	// 所以不再单列一个分组 —— 标签里会写明它属于哪个事项，或者“未关联”。
	if (!items.length && !hubs.length) {
		treeEl.append(el("p", { class: "hint", text: '账本是空的。先在终端里 a "想做的事"。' }));
	}

	renderFooter();
	treeEl.scrollTop = y;
}
// ─────────────────────────── 右栏 ───────────────────────────

const ROLE = { user: "你", assistant: "助手" };

function messageEl(m) {
	const notes = [];
	if (m.calls) notes.push(`${m.calls} 次工具调用`);
	if (m.thinking) notes.push("思考");
	return el(
		"div",
		{ class: `msg ${m.role}` },
		el("div", { class: "who", text: ROLE[m.role] ?? m.role }),
		m.text ? el("div", { class: "body", text: m.text }) : null,
		notes.length ? el("div", { class: "tools", text: `（${notes.join(" · ")}）` }) : null,
	);
}

/** 正在跑的那一轮：累积的文本 + 工具事件。 */
function liveEl() {
	const kids = [el("div", { class: "who", text: "助手" })];
	if (liveRun.text) kids.push(el("div", { class: "body", text: liveRun.text }));
	for (const t of liveRun.tools) {
		kids.push(
			el("div", {
				class: `tool${t.error ? " bad" : ""}`,
				text: `▸ ${t.name}${t.phase === "end" ? (t.error ? " ❌" : " ✓") : " …"}`,
			}),
		);
	}
	if (liveRun.error) kids.push(el("div", { class: "tool bad", text: `❌ ${liveRun.error}` }));
	if (!liveRun.text && !liveRun.tools.length && !liveRun.error) {
		kids.push(el("div", { class: "tools", text: "（思考中…）" }));
	}
	return el("div", { class: "msg assistant live" }, ...kids);
}

function renderRight() {
	const all = [
		...(tree?.items ?? []).flatMap((i) => i.sessions ?? []),
		...(tree?.hubs ?? []),
		...(tree?.hubs ?? []).flatMap((h) => h.children ?? []),
	];
	const s = all.find((x) => x.file === activeFile);
	const activeAuto = autoByFile.get(activeFile);

	headEl.replaceChildren(
		el("span", { class: "title", text: s ? sessionLabel(s) : "会话" }),
		s?.messages !== undefined ? el("span", { class: "sub", text: `${s.messages} 条消息` }) : null,
		s?.toolCalls ? el("span", { class: "sub", text: `${s.toolCalls} 次工具调用` }) : null,
		s?.model ? el("span", { class: "sub", text: s.model }) : null,
		activeAuto
			? el("span", { class: "sub auto", text: `⟳ 自动第 ${activeAuto.turn} 轮 · ${CHAIN_STATUS[activeAuto.status] ?? activeAuto.status}` })
			: null,
		liveRun?.running ? el("span", { class: "sub running", text: "● 正在跑" }) : null,
		el("span", { class: "file", text: activeFile ? activeFile.split("/").pop() : "" }),
	);

	const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
	// 乐观层按当前会话取（修 #15）—— 不能无条件渲染全局列表，
	// 否则 A 里发的话会跑到 B 里。
	const optimistic = pending.for(activeFile);
	msgsEl.replaceChildren();
	for (const m of activeMessages) msgsEl.append(messageEl(m));
	for (const t of optimistic) msgsEl.append(messageEl({ role: "user", text: t }));
	if (liveRun) msgsEl.append(liveEl());
	if (!activeMessages.length && !optimistic.length && !liveRun) {
		msgsEl.append(el("div", { class: "empty", text: "这个会话还没有可显示的文本消息。" }));
	}
	renderComposer();
	if (nearBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
}

function renderComposer() {
	const enabled = !!activeFile;
	inputEl.disabled = !enabled;
	sendEl.disabled = !enabled || !inputEl.value.trim();
	if (!enabled) {
		hintEl.textContent = "先选一个会话";
		return;
	}
	if (liveRun?.running) {
		hintEl.textContent = "流式中 —— Enter 补充（当前回合后注入） · Alt+Enter 排队等它做完";
	} else {
		hintEl.textContent = "Enter 发送 · Shift+Enter 换行";
	}
}

// ─────────────────────────── 会话 ───────────────────────────

async function reloadHistory() {
	if (!activeFile) return;
	const file = activeFile; // 读的过程中用户可能切会话 —— 回来只认这一个
	try {
		const d = await (await api("/api/session?p=" + encodeURIComponent(file))).json();
		if (file !== activeFile) return; // 已经切走了，别把它的历史扣到当前会话上
		activeMessages = d.messages ?? [];
		// 文件里已经有了的那些就从乐观层里去掉 —— 否则会显示两遍。
		// 只清这一个会话的桶（修 #15）。
		pending.reconcile(file, activeMessages);
	} catch {
		// 读不到就保留现状，下次事件再试
	}
}

function openStream(file) {
	es?.close();
	es = new EventSource(withToken("/api/stream?p=" + encodeURIComponent(file)));
	es.onmessage = (e) => {
		let ev;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		handleEvent(ev);
	};
	// EventSource 自己会重连；重连后会再收一次 hello，由它对齐状态
	es.onopen = () => {
		connected = true;
		renderFooter();
	};
	es.onerror = () => {
		connected = false;
		renderFooter();
	};
}

function handleEvent(ev) {
	switch (ev.t) {
		case "hello":
			// 重连后的自愈：以服务器说的为准。
			// 无论哪种情况都重读一次历史 —— 断线期间的完整消息在文件里，
			// 实时层只负责"还没落盘的那部分"。
			if (ev.status.streaming) {
				liveRun = liveRun ?? { text: "", tools: [], running: true, error: null };
				liveRun.running = true;
			} else {
				liveRun = null;
			}
			reloadHistory().then(scheduleRender);
			break;
		case "run":
			if (ev.phase === "start") {
				liveRun = { text: "", tools: [], running: true, error: null };
			} else {
				if (liveRun) liveRun.running = false;
				reloadHistory().then(() => {
					liveRun = null;
					scheduleRender();
				});
			}
			scheduleRender();
			break;
		case "text":
			if (!liveRun) liveRun = { text: "", tools: [], running: true, error: null };
			liveRun.text += ev.d;
			scheduleRender();
			break;
		case "tool":
			if (!liveRun) liveRun = { text: "", tools: [], running: true, error: null };
			// 同一工具的 start/end 合成一行
			if (ev.phase === "start") liveRun.tools.push({ name: ev.name, phase: "start", error: false });
			else {
				const last = [...liveRun.tools].reverse().find((t) => t.name === ev.name && t.phase === "start");
				if (last) {
					last.phase = "end";
					last.error = ev.error;
				} else liveRun.tools.push({ name: ev.name, phase: "end", error: ev.error });
			}
			scheduleRender();
			break;
		case "error":
			if (!liveRun) liveRun = { text: "", tools: [], running: false, error: null };
			liveRun.error = ev.message;
			scheduleRender();
			break;
	}
}

async function openSession(file) {
	activeFile = file;
	activeMessages = [];
	liveRun = null;
	inputEl.value = "";
	renderRight();
	await reloadHistory();
	renderRight();
	openStream(file);
	inputEl.focus();
}

// ─────────────────────────── 发送 ───────────────────────────

async function send(behavior) {
	const text = inputEl.value.trim();
	if (!text || !activeFile) return;
	const file = activeFile; // POST 是异步的，回来时可能已经切走了
	inputEl.value = "";
	autoGrow();
	renderComposer();
	const r = await api("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ file, text, behavior }),
	});
	if (!r.ok) {
		const err = await r.json().catch(() => ({}));
		if (file !== activeFile) return; // 失败了也不该把错误扣到别的会话上
		liveRun = { text: "", tools: [], running: false, error: err.error ?? `HTTP ${r.status}` };
		scheduleRender();
		return;
	}
	// 乐观显示：你说的话立刻可见，不必等这一轮跑完、重读文件才出现。
	// 重读时若文件里已经有了，会从 pending 里去掉（见 reloadHistory）。
	pending.add(file, text);
	if (file === activeFile) liveRun = { text: "", tools: [], running: true, error: null };
	scheduleRender();
}

function autoGrow() {
	inputEl.style.height = "auto";
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
}

inputEl.addEventListener("input", () => {
	autoGrow();
	renderComposer();
});

inputEl.addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	if (e.shiftKey && !e.altKey) return; // Shift+Enter = 换行
	e.preventDefault();
	send(liveRun?.running ? (e.altKey ? "followUp" : "steer") : undefined);
});

sendEl.addEventListener("click", () => send(liveRun?.running ? "steer" : undefined));

// ─────────────────────────── 启动 ───────────────────────────

/** 页脚：SSE 连接状态 + 数据在哪（短形式）。全路径放 tooltip。 */
function renderFooter() {
	const where = tree?.paths?.homeLabel ?? "";
	const state = !es
		? null
		: connected
			? { cls: "live", text: "● 已连接" }
			: { cls: "bad", text: "○ 断线（会自动重连）" };
	pathsEl.replaceChildren(
		state ? el("span", { class: state.cls, text: state.text }) : null,
		el("span", { text: `${state ? "  ·  " : ""}${where}` }),
	);
	pathsEl.title = tree?.paths?.ledger ?? "";
}

async function load() {
	tree = await (await api("/api/tree")).json();
	autoByFile = new Map();
	autoChains = new Map();
	try {
		const l = await (await api("/api/live")).json();
		liveFiles = new Set((l.live ?? []).filter((x) => x.streaming).map((x) => x.file));
		for (const s of l.live ?? []) if (s.auto) autoByFile.set(s.file, s.auto);
		for (const ch of l.auto ?? []) autoChains.set(ch.itemId, ch);
	} catch {
		/* live 拿不到不影响主流程 */
	}
	renderLeft();
	if (activeFile) renderRight();
}

$("#refresh").addEventListener("click", () => load());

await load();
setInterval(() => load(), 5_000); // 左边 + 正在跑的标记
