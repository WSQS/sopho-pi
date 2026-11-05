/**
 * v2 前端 —— 左：会话树（用会话名字）；右：会话正文（贴近终端的样子）+ 输入框。
 *
 * 无构建、vanilla ESM。数据全走 /api/*（反代到会话基底）。正文渲染在 ./render.mjs。
 *
 * 渲染分块 + 脏标记，是这里最要紧的设计：
 *   打字只碰「输入区」，流式只碰「这一轮」，历史只在真的变了才重建。
 *   早先每次按键都整条重建消息列表（长会话上万次 DOM 操作），打字自然卡。
 */
import { el, partsEl, userEl } from "./render.mjs";

const $ = (s) => document.querySelector(s);
const api = (p, init) => fetch(`/api${p}`, init);

const WINDOW = 80; // 历史一次渲染多少条（更早的折叠成一个「显示更早」）

let nodes = [];
/** 树顶那行的汇总（GET /tree 的 unread，**只数树里看得见的**）。前端不另算一份 ——
 *  免得两处口径不一致（数字、最旧的那个都由 A 给）。 */
let unreadAgg = { count: 0, oldestId: null, oldestName: null, oldestAt: null };
/** 折叠是**每节点三态**，不是「一个『开着的』集合」：
 *  · 在 expanded = 用户**显式说过「开」**；在 collapsed = 显式说过「关」；都不在 = **没说过**（听祖先的）。
 *  · **生效状态 = 显式优先，否则继承祖先的掀开**（只沿归档节点继承，见 renderTree 的 effIf/walk）。
 *  标记画的是**生效状态**，点击写的是**显式**值（第一次点 = 把生效状态反过来）。这样才有那条不变式：
 *  「有标记 ⇔ 点它一定会改变可见性」—— 归档节点被祖先掀开时它是「生效=开」，标记就该是 ▾N，
 *  点它 = 显式关 = 压过祖先、真收起（不再是个点开点收都不动的空开关）。
 *  按分支独立，互不干扰 —— 归档发生在哪，展开就在哪（而不是一个全局开关把所有存档一起掀开）。 */
const expanded = new Set();
/** 显式说过「关」的那些 —— 用来压过祖先的掀开。和 expanded 互斥（每次都只进一个）。 */
const collapsed = new Set();
/** 上一次渲染算出的**生效**开合：id → true/false。点击时用它翻面：
 *  「当前生效是开」→ 写显式关。所以哪怕这节点是「被祖先掀开」的，一次点击也真的收得起来。 */
const effOpen = new Map();
/** 底部「存档 ▸ N」箱是否掀开。收的是**无父的**已归档会话 —— 它们没有父节点，
 *  折叠标记挂不上，只能靠这一行兜底（所以根节点不再享受「永不被折掉」的特例）。 */
let atticOpen = false;
let activeId = null;
let messages = [];
let compaction = null; // 最近一次压缩边界（GET /messages 的 compaction）：{atIndex, tokensBefore, summary}；null = 没压过
let live = null; // { parts: [], running, error }
let pendingUser = [];
let windowSize = WINDOW;
let es = null;
let connected = false;
let forceBottom = false; // 一次性：刚打开会话 / 刚发消息，这一帧直接到底
/** 是否跟着新内容走。默认跟，只有你自己滚开了才不跟 ——
 *  判据是「离底多远」，由 #messages 的 scroll 事件推导，不靠猜意图。 */
let follow = true;

// ── 斜杠命令面板（/ 开头）──
// 清单**不硬编码**：来自 GET /sessions/{id}/commands（= pi 运行时的事实）。
let cmds = []; // 当前会话的命令清单
let cmdsFor = null; // 这份清单属于哪个会话（换会话后作废）
let cmdsStreaming = false; // 拉清单那一刻后端报的 streaming（live 拿不到时的兜底）
let cmdsError = null; // 清单拉不到时的说明
let cmdQuery = null; // 正在输入的命令名（null = 面板关着）
let cmdMode = null; // 面板在选什么：{kind:"name",q} / {kind:"arg",name:"model",q}
let cmdItems = []; // 过滤后的候选
let cmdIndex = 0; // 当前高亮
let cmdDismissed = ""; // Esc 关掉时输入框里的值（同值不再弹，改了才弹）
let notice = null; // 输入框上方的提示（命令被流式拒绝等）
let ctxUsage = null; // 当前会话的上下文用量（GET /context 的 context；null = 冷会话/拿不到）
let ctxFor = null; // 这份用量属于哪个会话（换会话后作废）
// ── 压缩（= TUI 的 /compact）──
// 有损、不可撤。所以：入口有两个（上下文那行的「压缩」按钮 / 发 /compact），两条都**先二次确认**。
let compacting = false; // 正在压缩（自己发的请求 or SSE 报的）
let confirmAsk = null; // 二次确认（null = 不显示；{text, instructions} = 显示）
// ── 模型（= TUI 的 /model）──
// 候选来自 GET /sessions/{id}/models（pi 的 modelRuntime.getAvailableSnapshot()），不硬编码。
let models = [];
let modelsFor = null; // 这份清单属于哪个会话（换会话后作废）
let modelsError = null;
let modelsLoading = false;

// ─────────────────────── 渲染调度（分块脏标记） ───────────────────────

const dirty = { tree: false, hist: false, live: false, chrome: false, cmd: false };
let raf = 0;

function schedule() {
	if (!raf) raf = requestAnimationFrame(flush);
}
function mark(...keys) {
	for (const k of keys) dirty[k] = true;
	schedule();
}
function flush() {
	raf = 0;
	const mb = $("#messages");
	if (dirty.tree) {
		dirty.tree = false;
		renderTree();
	}
	if (dirty.hist) {
		dirty.hist = false;
		renderHistory();
	}
	if (dirty.live) {
		dirty.live = false;
		renderLive();
	}
	if (dirty.chrome) {
		dirty.chrome = false;
		renderChrome();
	}
	if (dirty.cmd) {
		dirty.cmd = false;
		renderCmds();
	}
	// 跟不跟随 = 你自己滚到哪（follow）+ 刚打开/刚发消息的一次性意图（forceBottom）。
	if (follow || forceBottom) mb.scrollTop = mb.scrollHeight;
	forceBottom = false;
}

// ─────────────────────── 跟不跟随（滚动意图） ───────────────────────

/** 在底（≤4px，容忍亚像素/取整）就跟，滚开就不跟。
 *  我们自己的程序化滚动永远落在底部，所以它自然把 follow 置回 true ——
 *  不需要去分辨「这次滚动是不是我自己触发的」那套花活。 */
function syncFollow() {
	const mb = $("#messages");
	const next = mb.scrollHeight - mb.scrollTop - mb.clientHeight <= 4;
	if (next === follow) return;
	follow = next;
	$("#jump").classList.toggle("show", !follow); // 只切 class：每帧重建按钮会跟流式打架
}
$("#messages").addEventListener("scroll", syncFollow);
$("#jump").addEventListener("click", () => {
	$("#messages").scrollTop = $("#messages").scrollHeight; // 落到底 → scroll 事件把 follow 置回 true
});

const pad = (n) => String(n).padStart(2, "0");
const fmt = (ts) => {
	if (!ts) return "";
	const d = new Date(ts);
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const tail8 = (id) => String(id).slice(-8);

// ─────────────────────────── 左栏 ───────────────────────────

function renderTree() {
	const t = $("#tree");
	t.replaceChildren();
	const byId = new Map(nodes.map((n) => [n.id, n]));
	// expanded / collapsed 都是内存 Set：节点消失（会话被删 / 换掉）后它的 id 会赖着不走。
	// 每次重画顺手把两个都剔一遍 —— 留着不但白占，哪天新会话撞上同一个 id
	// 还会凭空开合（那种「我没点过它，它自己动着」最难查）。
	// ⚠️ 三态化之后两个都得 prune：只清 expanded 的话，一个「显式关」的脏键会压住
	// 同名新节点的祖先掀开（比脏 expanded 更阴 —— 它是「点了没反应」那一侧）。
	for (const s of [expanded, collapsed]) for (const id of s) if (!byId.has(id)) s.delete(id);
	const kids = new Map(nodes.map((n) => [n.id, []]));
	const roots = [];
	for (const n of nodes) {
		const p = n.parent ? byId.get(n.parent) : null;
		if (p && p !== n) kids.get(p.id).push(n);
		else roots.push(n);
	}
	const sort = (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

	/** 显式值：true = 说过「开」，false = 说过「关」，undefined = 没说过（听祖先的）。 */
	const said = (n) => (expanded.has(n.id) ? true : collapsed.has(n.id) ? false : undefined);
	/** 生效状态 = 显式优先，否则继承祖先的掀开 —— 但**只沿归档节点**继承：
	 *  活节点本来就该可见，它的折叠态是它自己那个标记的事。
	 *  ⚠️ 上面这条「不沿活节点继承」是 ① 的语义（展开父不该连坐活子自己的那支），别坏。 */
	const effIf = (n, inherited) => said(n) ?? (n.archived ? inherited : false);

	// 自顶向下带上下文：每个节点的**生效**开合（标记画的就是它 —— 光看 expanded 会撒谎）。
	effOpen.clear();
	const effWalk = (n, inherited) => {
		const open = effIf(n, inherited);
		effOpen.set(n.id, open);
		for (const c of kids.get(n.id) ?? []) effWalk(c, open);
	};
	roots.forEach((n) => effWalk(n, false));

	// 标记上的 N = **在当前生效状态下，点它真能掀开/收起几行**
	//（= 「点了它的标记会跟着变可见性」的那些行；全是归档行）。
	// · 只沿**归档**节点往下数：活节点自己那支归它自己的标记管 —— 点父节点不会动它，
	//   所以父的账里也不能算它（① 改了级联之后，计数必须同一把尺子，否则 ▸N 又骗人）。
	// · 这是**状态相关**的数，所以不能纯自底向上：归档节点被祖先掀开时它自己那支已经露着，
	//   点它是**收起** —— N 说的是它真能收起来的行数（这时标记该是 ▾N）。
	//   按「它生效=开」这一个假设算：开时这些行在、点它变没；关时这些行不在、点它变有 ——
	//   两个方向都是同一批行，所以一套数就够。
	const memo = new Map();
	const markCount = (n) => {
		if (memo.has(n.id)) return memo.get(n.id);
		let c = 0;
		for (const k of kids.get(n.id) ?? []) {
			if (!k.archived) continue; // 活子那支归它自己的标记管
			c += 1 + (said(k) === false ? 0 : markCount(k)); // 显式关着的孩子：只算它自己这一行
		}
		memo.set(n.id, c);
		return c;
	};
	roots.forEach(markCount);

	/** 把一支渲染进 parent。inherited = 父节点的**生效**状态（归档节点靠它决定露不露：
	 *  祖先掀开了 → 它整支露出来）。attic=true 只给「存档箱」的根节点用：
	 *  它放行一个已归档的根（连同整支后代），普通树里没有这种放行。 */
	const walk = (parent, n, d, inherited, attic) => {
		if (n.archived && !inherited && !attic) return;
		const open = effOpen.get(n.id) ?? false;
		parent.append(row(n, d, markCount(n), open));
		for (const c of (kids.get(n.id) ?? []).sort(sort)) walk(parent, c, d + 1, open, false);
	};

	// 上面的树 = 在干活的东西。已归档的**根**不进树 —— 收进按钮下面的「存档箱」。
	roots.sort(sort).forEach((n) => walk(t, n, 0, false, false));

	if (!nodes.length) t.append(el("p", { class: "hint", text: "还没有会话。点右上角「＋ 新会话」。" }));
	renderAttic(roots.filter((n) => n.archived).sort(sort), walk);
	renderUnreadBar();
	$("#paths").replaceChildren(
		el("span", { class: connected ? "live" : "dim", text: connected ? "● 已连接" : "○ 未连接" }),
		el("span", { text: `  ·  ${nodes.length} 个会话` }),
	);
}

/** 掀开/收起某一支。按节点记，所以可以独立开关，也不会再出现
 *  「展开了就收不回去」那种全局标记错乱。
 *  写的是**显式**值（用户这次说了话），判据是**生效**状态：第一次点 = 把当前生效状态反过来。
 *  于是「被祖先掀开」的归档节点点一下会写「显式关」→ 压过祖先、真收起（空开关就这么没的）。 */
function toggleFold(id) {
	if (effOpen.get(id) ?? false) {
		expanded.delete(id);
		collapsed.add(id);
	} else {
		collapsed.delete(id);
		expanded.add(id);
	}
	renderTree();
}

/** 左栏底部那条「存档 ▸ N」，点开就在它**下面**铺开一箱存档。
 *  N = **无父的**已归档会话 —— 树里只有这一种挂不上折叠标记，收在这里才没有
 *  「归档后找不回来」的死角。有父的由它父节点上的 ▸N 负责，不重复计数。
 *  内容放在按钮下方（#atticList），所以 ▸/▾ 说的是实话：箭头朝下 = 内容就在下面。 */
function renderAttic(archRoots, walk) {
	const n = archRoots.length;
	const box = $("#attic");
	const list = $("#atticList");
	box.hidden = !n;
	if (!n) {
		list.hidden = true;
		list.replaceChildren();
		return;
	}
	box.classList.toggle("open", atticOpen);
	box.title = atticOpen ? `收起底部的 ${n} 个顶层存档会话` : `顶层有 ${n} 个已归档的会话 —— 点开，就在这条按钮下面铺开`;
	box.replaceChildren(el("span", { text: "存档" }), el("span", { class: "mark", text: `${atticOpen ? "▾" : "▸"} ${n}` }));

	list.hidden = !atticOpen;
	list.replaceChildren();
	if (!atticOpen) return;
	// 小标题 + 独立底色，一眼看出这段是「收起来的存档」，不是树的延续。
	list.append(el("div", { class: "attic-head", text: `存档箱 · 顶层 ${n} 个（不在上面的树里）` }));
	archRoots.forEach((r) => walk(list, r, 0, false, true));
}

$("#attic").addEventListener("click", () => {
	atticOpen = !atticOpen;
	renderTree(); // 树很小，直接重画（和 toggleFold 一致）
});

/** 标题来源的人话（A 的 /tree 每条带 titleSource）。只进 tooltip，不占树上的位置。 */
const TITLE_SRC = { seed: "第一句话种的（还没人改过）", auto: "模型自己起的", manual: "用户自己设的（模型不许覆盖）" };

/** foldedCount = 点它真能掀开/收起的行数，isOpen = **生效**开合（渲染时算好的，见 renderTree）。
 *  两者必须同出一源：有标记 ⇔ 点它一定改变可见性（N>0 才画标记）。 */
function row(n, d, foldedCount, isOpen) {
	const label = n.name || tail8(n.id);
	// 未读 = 它落定了、而我之后没看过（事实在 A 侧，前端只画）。
	// 它和「在跑」是两个不同的信号，但**一个时刻只画一个点**：未读（红）**优先于**在跑（脉冲环）。
	// 两个都成立时不再叠第二个点 —— 「它同时在跑」由那个红点的 title 说（信息不丢，只是不画两个点）。
	// ⚠️ 被归档祖先藏住的那一支整体静音（`hiddenByArchive`）—— 和树顶数字用的是同一对字段，
	// 所以「看得见的红点」和「数字」不可能对不上（藏起来的不亮、也不计数：别让你点到一个看不见的地方）。
	const unread = !!n.unread && !n.hiddenByArchive;
	// 折叠标记：这一支藏了 N 个。掀开后变 ▾。位置在名字左边（文件树的老位置）。
	const mark = foldedCount
		? el("span", {
				class: `fold${isOpen ? " open" : ""}`,
				text: `${isOpen ? "▾" : "▸"}${foldedCount}`,
				title: isOpen ? "收起这一支" : `这一支藏了 ${foldedCount} 个已存档的会话`,
				onclick: (e) => {
					e.stopPropagation(); // 别把点折叠当成点会话
					toggleFold(n.id);
				},
			})
		: el("span", { class: "fold none" });
	return el(
		"div",
		{
			class: `sess${activeId === n.id ? " active" : ""}${n.archived ? " arch" : ""}${unread ? " unread" : ""}`,
			style: `padding-left:${10 + d * 14}px`,
			onclick: () => open(n.id),
			title: `${label}\n${n.id}${n.cwd ? `\n${n.cwd}` : ""}${n.archived ? "\n（已存档 —— 发消息就会复活）" : ""}${n.titleSource ? `\n（标题：${TITLE_SRC[n.titleSource] ?? n.titleSource}）` : ""}`,
		},
		mark,
		// 两个信号只画一个：未读优先。红点拿了位置，脉冲环就不画（不叠两个点）。
		unread
			? el("span", {
					class: "u",
					title: `有新东西：你上次看它之后它又落定过${n.settledAt ? `（${fmt(n.settledAt)}）` : ""}${n.streaming ? " · 而且它正在跑" : ""}`,
				})
			: el("span", { class: `dot${n.streaming ? " on" : ""}`, title: n.streaming ? "正在跑" : null }),
		el("span", { class: "nm", text: label }),
		el("span", { class: "tm", text: fmt(n.lastActivity) }),
	);
}

/** 树顶那一行：`N 个会话有新东西 →`，点一下 → 跳到**最旧的**未读（A 按落定时间排好了）。
 *  数字和「最旧那个」都来自 A 的汇总（只数树里看得见的，被归档父藏住的不算）。
 *  没有未读 → 整条不显示。 */
function renderUnreadBar() {
	const b = $("#unread");
	if (!unreadAgg?.count || !unreadAgg.oldestId) {
		b.hidden = true;
		b.replaceChildren(); // 藏了就清空：别留一串旧文案在 DOM 里（读 textContent 的人会被骗）
		b.title = "";
		return;
	}
	b.hidden = false;
	b.replaceChildren(
		el("span", { class: "n", text: String(unreadAgg.count) }),
		el("span", { text: " 个会话有新东西" }),
		el("span", { class: "arrow", text: " →" }),
	);
	b.title = `跳到最旧的未读：${unreadAgg.oldestName || tail8(unreadAgg.oldestId)}${unreadAgg.oldestAt ? `（落定于 ${fmt(unreadAgg.oldestAt)}）` : ""}`;
}

$("#unread").addEventListener("click", () => {
	if (unreadAgg?.oldestId) open(unreadAgg.oldestId);
});

/** 「我看过了」→ 告诉服务端。判据是**视口贴着底**（你确实在看最新那部分）。
 *  ⚠️ 只在「未读 → 已读」这一次发（不是每帧都发）：节点一旦被 /tree 刷成已读，这里就直接返回。
 *  post 回来再 load() 一次 —— **服务端才是状态的家**（`$ASSIST_HOME/seen.json`），
 *  前端不自己记账：用户会换设备/换浏览器（局域网 / 手机），localStorage 一换就全忘。
 *  following：打开会话那一刻得传**点击前**的 follow，见 open() 里的说明。 */
const seenInFlight = new Set();
function markSeen(following = follow) {
	const id = activeId;
	if (!id || !following) return;
	const n = nodes.find((x) => x.id === id);
	if (!n?.unread || seenInFlight.has(id)) return;
	seenInFlight.add(id);
	api(`/sessions/${id}/seen`, { method: "POST" })
		.then(() => load()) // 以服务端为准：红点和树顶数字都从 /tree 重新来
		.catch(() => {})
		.finally(() => seenInFlight.delete(id));
}

// ─────────────────────── 右栏：历史 / 直播 / 输入区 ───────────────────────

function renderHistory() {
	const box = $("#hist");
	box.replaceChildren();
	const start = Math.max(0, messages.length - windowSize);
	if (messages.length > windowSize)
		box.append(
			el("div", {
				class: "more",
				text: `↑ 显示更早的 ${messages.length - windowSize} 条`,
				onclick: () => {
					windowSize = messages.length;
					mark("hist");
				},
			}),
		);
	// 压缩边界（GET /messages 给的 compaction.atIndex = 从这条起才还在模型上下文里）：
	// 边界在窗口之前 → 整窗都在边界之后 → 把块放最上面；否则插在那条之前。
	if (compaction && compaction.atIndex <= start) box.append(compactBlock());
	for (let i = start; i < messages.length; i++) {
		if (compaction && compaction.atIndex === i) box.append(compactBlock());
		const m = messages[i];
		if (m.role === "user") box.append(userEl(m.text));
		else {
			box.append(el("div", { class: "who", text: "助手 ›" }));
			box.append(partsEl("assistant", m.parts ?? [{ type: "text", text: m.text }]));
		}
	}
	for (const t of pendingUser) box.append(userEl(t));
	if (!messages.length && !pendingUser.length && !live)
		box.append(el("div", { class: "empty", text: activeId ? "这个会话还没有可显示的文本。" : "左边选一个会话，或新建一个。" }));
}

/** 正文里那道「✂ 压缩边界」：说清上面那些**已经不在模型上下文里了**，
 *  并把这之后真正进去的那段摘要摆出来（默认收起 —— 可能很长）。 */
function compactBlock() {
	const c = compaction;
	const det = el("details", { class: "cut" });
	det.append(
		el("summary", {
			text:
				`✂ 上下文压缩边界 —— 上面 ${c.atIndex} 条已不在模型上下文里` +
				(c.tokensBefore == null ? "" : `（压缩前 ${fmtNum(c.tokensBefore)} tokens）`) +
				" · 点开看摘要",
		}),
	);
	det.append(el("div", { class: "cutbody", text: c.summary || "（这段摘要没读到）" }));
	return det;
}

/** 正在跑的那一块。文字走纯文本（不跑 markdown）——它每个 delta 都会重建。 */
function renderLive() {
	const box = $("#liveBox");
	box.replaceChildren();
	if (!live) return;
	box.append(el("div", { class: "who", text: "助手 ›" }));
	box.append(partsEl("assistant", live.parts, { cls: live.running ? "live" : "", plain: true }));
	if (live.error) box.append(el("div", { class: "body err", text: `❌ ${live.error}` }));
	if (!live.parts.length && !live.error) box.append(el("div", { class: "think", text: "✻ 思考中…" }));
}

function renderChrome() {
	const n = nodes.find((x) => x.id === activeId);
	// 先收成数组、滤掉假值再交出去：`replaceChildren(..., null, ...)` 会插一个
	// **字面量 "null" 文本节点**（DOM 把 null 当字符串）—— 头部本来就因此多一截 "null"。
	// 这里顺手管住（包括下面新加的「快照」槽）。
	const kids = [
		el("span", { class: "title", text: n?.name || (activeId ? tail8(activeId) : "会话") }),
		activeId ? el("span", { class: "sub mono", text: tail8(activeId) }) : null,
		n?.cwd ? el("span", { class: "sub", text: n.cwd }) : null,
		live?.running ? el("span", { class: "sub running", text: "● 正在跑" }) : null,
		// 「快照」= 归档时自动导出的 pi 原生 HTML（GET /sessions/{id}/export）。
		// **独立导航打开**（新标签页），不内联进主页面 —— 它是自己源上的一份 HTML 文档。
		// 已归档、或已经有快照（刚取消存档但文件还在）时出现；过期与否由服务端定（会现导）。
		n && (n.archived || n.snapshot)
			? el("a", {
					class: "mini",
					href: `/api/sessions/${activeId}/export`,
					target: "_blank",
					rel: "noopener",
					text: "快照",
					title: "在新标签页打开 pi 渲染的 HTML 快照（归档时自动生成；会话文件更新过就现导一份）",
				})
			: null,
		n
			? el("button", {
					class: "mini",
					text: n.archived ? "取消存档" : "存档",
					onclick: async () => {
						await api(`/sessions/${activeId}/${n.archived ? "unarchive" : "archive"}`, { method: "POST" });
						await load();
						mark("chrome", "tree");
					},
				})
			: null,
	].filter(Boolean);
	$("#head").replaceChildren(...kids);
	const on = !!activeId;
	$("#input").disabled = !on;
	$("#send").disabled = !on || !$("#input").value.trim();
	$("#hint").textContent = !on
		? "先选一个会话"
		: cmdQuery !== null
			? (cmdMode?.kind === "arg" ? "模型候选 · ↑↓ 选择 · Tab/Enter 填入 · Esc 关闭" : "命令面板 · ↑↓ 选择 · Tab/Enter 填入 · Esc 关闭")
			: compacting
				? "正在压缩上下文…（可能要几十秒）"
				: live?.running
					? "流式中 —— Enter 插话 · Alt+Enter 排到队尾"
					: "Enter 发送 · Shift+Enter 换行";
	const nb = $("#notice");
	nb.hidden = !notice;
	nb.textContent = notice ?? "";
	renderConfirm();
	renderCtx();
}

// ─────────────────────── 上下文用量（输入框右侧常显） ───────────────────────
// 与 pi TUI 的 Footer 对齐：`60.4%/900k (auto)`；但多给一个**离自动压缩阈值还有多少** ——
// 那才是「快满了，该 compact 了」的真正判据（阈值 = 窗口 − 预留 tokens）。

const fmtTok = (n) => {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
};
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

/** 临界变色：开了自动压缩就按「距阈值」算（≥阈值=红，≥90%阈值=黄）；
 *  没开就退回窗口百分比（和 TUI footer 的 70/90 一致）。 */
function ctxLevel(c) {
	if (c.autoCompact && c.compactAt > 0 && c.tokens != null) {
		if (c.tokens >= c.compactAt) return "full";
		if (c.tokens >= c.compactAt * 0.9) return "warn";
		return "ok";
	}
	if (c.percent == null) return "ok";
	if (c.percent > 90) return "full";
	if (c.percent > 70) return "warn";
	return "ok";
}

/** 拉这个会话的上下文用量（不 await）。冷会话拿不到就显示 —，不编 0。 */
async function loadContext() {
	const id = activeId;
	ctxFor = id;
	ctxUsage = null;
	mark("chrome");
	try {
		const r = await api(`/sessions/${id}/context`);
		if (ctxFor !== id) return; // 会话换了
		if (r.ok) ctxUsage = (await r.json()).context ?? null;
	} catch {
		/* 拿不到就保持 null（—） */
	}
	if (ctxFor === id) mark("chrome");
}

function renderCtx() {
	renderCompactBtn(); // 用量那一行的「压缩」按钮跟同一份状态走（拿不到用量 → 不出现）
	const box = $("#ctx");
	box.className = "ctx";
	if (!activeId || ctxFor !== activeId || !ctxUsage) {
		box.classList.add("none");
		box.textContent = "上下文 —";
		box.title = activeId ? "拿不到上下文用量（冷会话 / 还没有 runtime）" : "先选一个会话";
		return;
	}
	const c = ctxUsage;
	const auto = c.autoCompact ? " (auto)" : "";
	// tokens 未知（刚压缩过、还没下一次 LLM 响应）：照实说 —，但仍把窗口在哪儿告诉你
	if (c.tokens == null || c.percent == null) {
		box.classList.add("none");
		box.textContent = `上下文 —/${fmtTok(c.contextWindow)}${auto}`;
		box.title = "刚压缩过 / 还没跑过 —— 下一次 LLM 响应之后才知道用量";
		return;
	}
	const free = c.freeTokens;
	box.textContent =
		`上下文 ${c.percent.toFixed(1)}%/${fmtTok(c.contextWindow)}${auto}` + (free == null ? "" : free >= 0 ? ` · 余 ${fmtTok(free)}` : ` · 超 ${fmtTok(-free)}`);
	box.classList.add(ctxLevel(c));
	box.title =
		`已用 ${c.tokens} tokens / 窗口 ${c.contextWindow}` +
		(c.autoCompact ? `；自动压缩阈值 ${c.compactAt}（窗口 − 预留 ${c.reserveTokens}）` : "；未开自动压缩") +
		(c.freeTokens == null ? "" : `；距阈值${c.freeTokens >= 0 ? "还有" : "已超出"} ${Math.abs(c.freeTokens)} tokens`);
}

// ─────────────────────── 压缩（= TUI 的 /compact） ───────────────────────
// 会话层的手动压缩入口：`session.compact(customInstructions?)`
//（pi 的注释原文：'the manual entry point used by /compact, RPC, and extensions'）。
// 它是**有损**的：旧消息被一段总结替掉，不可撤。所以入口只有两个，且两条都先确认：
//   ① 上下文用量那一行的「压缩」按钮（就挨着「余 340k」—— 那行本来就在说这件事）
//   ② 发 `/compact [额外指示]`

/** 「压缩」按钮的可见/可用状态。
 *  **拿不到用量（冷会话 / context=null / tokens 未知）→ 不出现** —— 那时候你不知道
 *  该不该压，按下去也只会得到「Nothing to compact」。 */
function renderCompactBtn() {
	const b = $("#compact");
	const has = !!(activeId && ctxFor === activeId && ctxUsage && ctxUsage.tokens != null);
	b.hidden = !has;
	if (!has) {
		b.textContent = "压缩"; // 藏起来也别留着“压缩中…”的陈旧字样
		return;
	}
	const blocked = busy();
	b.classList.toggle("blocked", blocked && !compacting); // 看着按不动，但点得下去 —— 点了会说明为什么不干
	b.classList.toggle("busy", compacting);
	b.textContent = compacting ? "压缩中…" : "压缩";
	b.title = compacting
		? "正在压缩上下文…"
		: blocked
			? "会话正在跑 —— 点一下会说明为什么现在不能压（不会硬来）"
			: "手动压缩上下文（= TUI 的 /compact）：旧消息换成一段总结，有损、不可撤 —— 会先确认";
}

/** 二次确认：必须带上**当前用量 + 预计释放量**，不然「有损」是句空话。 */
function askCompact(instructions) {
	const c = ctxUsage;
	if (!c || c.tokens == null) {
		notice = "不知道这个会话用了多少上下文（冷会话 / 刚压过）—— 发一条消息让它跑一轮再看。";
		mark("chrome");
		return;
	}
	if (busy()) {
		// 流式中**明确拒绝并说明**（后端也会再拦一道：pi 的手动压缩开头就 await abort()）
		notice = compacting
			? "正在压缩 —— 等这一次压完。"
			: "会话正在跑 —— pi 的手动压缩会先打断当前这一轮，所以这里不硬来：等这一轮跑完再压。";
		mark("chrome");
		return;
	}
	const keep = c.keepRecentTokens;
	const est = keep && c.tokens > keep ? c.tokens - keep : null;
	confirmAsk = {
		instructions,
		text:
			`压缩是**有损**的（旧消息换成一段总结，不可撤）。现在用了 ${fmtNum(c.tokens)} tokens（${c.percent == null ? "—" : c.percent.toFixed(1)}% 窗口），` +
			(est == null
				? "保留多少看 pi 的切点（这次没算出预计释放量）。"
				: `压缩后保留最近约 ${fmtTok(keep)} tokens，预计释放 ${fmtNum(est)} tokens（实际以 pi 的切点为准）。`) +
			(instructions ? ` 附带指示：${instructions}` : ""),
	};
	mark("chrome");
}

function renderConfirm() {
	const box = $("#confirm");
	if (!confirmAsk) {
		box.hidden = true;
		box.replaceChildren();
		return;
	}
	box.hidden = false;
	box.replaceChildren(
		el("span", { class: "ctext", text: confirmAsk.text }),
		el("button", {
			class: "yes",
			onclick: () => {
				const ask = confirmAsk;
				confirmAsk = null;
				runCompact(ask?.instructions);
			},
			text: "确认压缩",
		}),
		el("button", {
			onclick: () => {
				confirmAsk = null;
				mark("chrome");
			},
			text: "取消",
		}),
	);
}

/** 真去压：POST /sessions/{id}/compact。后端**同步等**到压完才回 —— 回执里就是真数字。 */
async function runCompact(instructions) {
	if (!activeId || compacting) return;
	const id = activeId;
	compacting = true;
	notice = "压缩中…（一次 LLM 调用，可能要几十秒）";
	mark("chrome");
	let r;
	try {
		r = await api(`/sessions/${id}/compact`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(instructions ? { instructions } : {}),
		});
	} catch (e) {
		compacting = false;
		notice = `压缩请求发不出去：${e?.message ?? e}`;
		mark("chrome");
		return;
	}
	const d = await r.json().catch(() => ({}));
	compacting = false;
	if (activeId !== id) return; // 等回包期间被换了会话：结果属于旧会话，不往新会话的界面上写
	if (r.ok) {
		notice =
			`已压缩：${fmtNum(d.tokensBefore)} → ${fmtNum(d.estimatedTokensAfter)} tokens` +
			(d.freed == null ? "" : `（释放 ${fmtNum(d.freed)}）`) +
			"。旧的原文已经换成摘要了。";
	} else {
		// 409 里既有「流式中」也有「无事可做」—— 后端已经给了人话，照说
		notice = d.error ?? `压缩失败（HTTP ${r.status}）`;
	}
	mark("chrome");
	loadContext(); // 压完用量变了（tokens 通常变成 null：等下一次 LLM 响应）
	reload(); // 正文变了（旧的被摘要替掉）
}

$("#compact").addEventListener("click", () => askCompact(null));

// ─────────────────────────── 斜杠命令面板 ───────────────────────────

const SOURCE_LABEL = { extension: "扩展", prompt: "模板", skill: "技能", builtin: "内置" };

/** 拉这个会话的命令清单。不 await —— 清单慢一点不该拖着正文出来。 */
async function loadCommands() {
	const id = activeId;
	cmdsFor = id;
	cmds = [];
	cmdsError = null;
	cmdsStreaming = false;
	mark("cmd");
	try {
		const r = await api(`/sessions/${id}/commands`);
		if (cmdsFor !== id) return; // 会话已经换了：这份清单作废
		if (!r.ok) {
			cmdsError = `命令清单拿不到（HTTP ${r.status}）`;
		} else {
			const d = await r.json();
			if (cmdsFor !== id) return;
			cmds = d.commands ?? [];
			cmdsStreaming = !!d.streaming;
		}
	} catch (e) {
		if (cmdsFor !== id) return;
		cmdsError = `命令清单拿不到：${e?.message ?? e}`;
	}
	if (cmdQuery !== null) cmdItems = cmdMode?.kind === "arg" ? filterModels(cmdQuery) : filterCmds(cmdQuery); // 面板已开：立刻补上候选
	mark("cmd", "chrome");
}

/** 输入框里在敲什么：
 *  · `name` —— `/` 开头还没敲到空格（在选命令）
 *  · `arg`  —— 某个命令后面在敲参数（目前只给 `/model` 候选，和 TUI 的 /model 补全同源）
 *  只认**开头的** `/` —— 正文中间、路径里的斜杠是普通文本。 */
function cmdInput() {
	const v = $("#input").value;
	const m = /^\/(\S*)$/.exec(v);
	if (m) return { kind: "name", q: m[1] };
	const a = /^\/model\s(\S*)$/.exec(v);
	if (a) return { kind: "arg", name: "model", q: a[1] };
	return null;
}

const filterCmds = (q) => {
	const s = q.toLowerCase();
	if (!s) return cmds;
	return cmds.filter((c) => c.name.toLowerCase().includes(s) || (c.description ?? "").toLowerCase().includes(s));
};

/** `/model` 的参数候选（当前那个排最前 —— 多半是从它附近挑）。 */
const filterModels = (q) => {
	const s = q.toLowerCase();
	const hit = s
		? models.filter((m) => m.ref.toLowerCase().includes(s) || (m.name ?? "").toLowerCase().includes(s) || m.id.toLowerCase().includes(s))
		: models;
	return [...hit].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
};

/** 输入变了：重算候选/开关面板。 */
function syncCmds() {
	const inp = cmdInput();
	if (inp === null || $("#input").value === cmdDismissed) return closeCmds();
	if (inp.kind === "arg") loadModels(); // 懒拉（内部去重，不会每键一发）
	const changed = inp.q !== cmdQuery || inp.kind !== cmdMode?.kind;
	cmdQuery = inp.q;
	cmdMode = inp;
	cmdItems = inp.kind === "arg" ? filterModels(inp.q) : filterCmds(inp.q);
	if (changed) cmdIndex = 0;
	else if (cmdIndex >= cmdItems.length) cmdIndex = Math.max(0, cmdItems.length - 1);
	mark("cmd");
}

function closeCmds() {
	if (cmdQuery === null && !cmdItems.length && cmdMode === null) return;
	cmdQuery = null;
	cmdMode = null;
	cmdItems = [];
	mark("cmd");
}

/** 选中 → **只填入输入框**（不直接发）：留着改参数、或再按 Esc/清空取消。
 *  尾巴带一个空格 —— 面板让位（已经到参数了），下一次 Enter 才是发送。
 *  ⚠️ 这里不能执行的命令**不填**（填了等于告诉用户能跑）—— 解释一句，输入保留。 */
function fillCmd(c) {
	if (cmdMode?.kind === "arg") {
		$("#input").value = `/model ${c.ref} `;
	} else if (c.runnable === false) {
		notice = `「/${c.name}」在 webui 里不能执行：${c.reason ?? "TUI 专用"}`;
		closeCmds();
		mark("chrome");
		return;
	} else {
		$("#input").value = `/${c.name} `;
	}
	cmdDismissed = "";
	// 填完重新算一遍面板：
	//  · `/compact `（无参数）→ 收起来（下一次 Enter 就是发）
	//  · `/model ` → 直接换成**参数候选**（= TUI 里 /model 后面弹模型列表的行为，少按一次 Enter）
	//  · 其他 → 已经到参数了（带空格）→ 收起
	syncCmds();
	grow();
	$("#input").focus();
	mark("chrome");
}

function renderCmds() {
	const box = $("#cmds");
	if (cmdQuery === null) {
		box.hidden = true;
		box.replaceChildren();
		return;
	}
	box.hidden = false;
	box.replaceChildren();
	const note = (t) => box.append(el("div", { class: "cmdhint", text: t }));
	if (cmdMode?.kind === "arg") {
		// 参数候选（模型）：空的时候要说清是「还在读」还是「真没有」
		if (modelsError) return note(modelsError);
		if (!models.length) return note(modelsLoading ? "模型清单读取中…" : "没读到可选模型。");
		if (!cmdItems.length) return note(`没有匹配「${cmdQuery}」的模型。`);
		cmdItems.forEach((m, i) => {
			box.append(
				el(
					"div",
					{
						class: `cmd${i === cmdIndex ? " sel" : ""}`,
						"data-name": m.ref,
						title: `${m.ref}${m.name ? ` · ${m.name}` : ""}${m.contextWindow ? ` · 窗口 ${fmtTok(m.contextWindow)}` : ""}`,
						onmousedown: (e) => {
							e.preventDefault();
							fillCmd(m);
						},
					},
					el("span", { class: "cname", text: m.ref }),
					el("span", { class: "csrc", text: m.current ? "当前" : "可选" }),
					el("span", { class: "cdesc", text: m.name ?? "" }),
				),
			);
		});
	} else {
		if (cmdsError) return note(cmdsError);
		if (!cmds.length) return note("这个会话没有可用的 / 命令。");
		if (!cmdItems.length) return note(`没有匹配「${cmdQuery}」的命令。`);
		cmdItems.forEach((c, i) => {
			const dead = c.runnable === false;
			box.append(
				el(
					"div",
					{
						class: `cmd${i === cmdIndex ? " sel" : ""}${dead ? " dead" : ""}`,
						"data-name": c.name,
						"data-runnable": dead ? "false" : "true",
						title: dead ? `这里不能执行：${c.reason ?? "TUI 专用"}` : (c.hint ?? ""),
						// mousedown（不是 click）：别让输入框先生失焦
						onmousedown: (e) => {
							e.preventDefault();
							fillCmd(c);
						},
					},
					el("span", { class: "cname", text: `/${c.name}` }),
					el("span", { class: "csrc", text: SOURCE_LABEL[c.source] ?? c.source }),
					c.argumentHint ? el("span", { class: "carg", text: c.argumentHint }) : null,
					el("span", { class: "cdesc", text: c.description ?? "" }),
					// 尾巴写明为什么不行（不能执行的绝不装成能用）
					dead ? el("span", { class: "cdead", text: c.tag ?? "TUI 专用" }) : null,
				),
			);
		});
	}
	box.append(el("div", { class: "cmdkeys", text: "↑↓ 选择 · Tab/Enter 填入 · Esc 关闭" }));
	box.querySelector(".cmd.sel")?.scrollIntoView({ block: "nearest" });
}

/** 这个会话现在在跑吗。live 来自 SSE（实时）；live 还没建时退回拉清单那一刻后端报的
 *  streaming —— 能不能跑命令是后端告诉我们的事实，不自己另推一套。
 *  压缩中也算「忙」（压缩期间 pi 自己就不让并发 prompt）。 */
const busy = () => compacting || (live ? !!live.running : cmdsStreaming);

/** 拉这个会话能选的模型（GET /sessions/{id}/models ⇐ pi 的 getAvailableSnapshot）。
 *  只在真的要看候选时拉（`/model ` 面板开了），且每个会话只拉一次。 */
async function loadModels() {
	const id = activeId;
	if (!id || modelsFor === id || modelsLoading) return;
	modelsLoading = true;
	modelsFor = id;
	models = [];
	modelsError = null;
	try {
		const r = await api(`/sessions/${id}/models`);
		const d = await r.json();
		if (modelsFor === id) {
			if (!r.ok) modelsError = `模型清单拿不到（HTTP ${r.status}）`;
			else {
				models = d.models ?? [];
				if (!models.length) modelsError = d.source === "none" ? "这个 pi 没给 modelRuntime —— 只能按名字设置" : "这个会话还没醒（冷会话）—— 先发一条消息";
			}
		}
	} catch (e) {
		if (modelsFor === id) modelsError = `模型清单拿不到：${e?.message ?? e}`;
	} finally {
		modelsLoading = false;
	}
	if (modelsFor === id && cmdMode?.kind === "arg") {
		cmdItems = filterModels(cmdQuery ?? "");
		mark("cmd");
	}
}

/** 文本是不是一条**清单里的**命令（只认开头、到第一个空格为止）。 */
function commandIn(text) {
	if (cmdsFor !== activeId || !text.startsWith("/")) return null;
	const sp = text.indexOf(" ");
	const name = text.slice(1, sp === -1 ? undefined : sp);
	return (name && cmds.find((c) => c.name === name)) || null;
}

// ─────────────────────────── 会话 ───────────────────────────

const histSig = () =>
	`${messages.length}|${messages.at(-1)?.text?.length ?? 0}|${messages.at(-1)?.parts?.length ?? 0}|${pendingUser.length}|${compaction?.atIndex ?? -1}|${compaction?.tokensBefore ?? -1}`;

/** 拉正文。只有真的变了才重建（否则每 5 秒白重建一次，长会话更明显）。 */
async function reload() {
	if (!activeId) return;
	let d;
	try {
		d = await (await api(`/sessions/${activeId}/messages`)).json();
	} catch {
		return;
	}
	const before = histSig();
	messages = d.messages ?? [];
	compaction = d.compaction ?? null; // 压缩边界（没压过 → null）
	pendingUser = pendingUser.filter((t) => !messages.some((m) => m.role === "user" && m.text === t));
	if (histSig() !== before) mark("hist");
}

/** 标题变了（A 的树级 SSE 报的：我们自己设的、用户 TUI 改的、L0 种子 —— 都走这条路）。
 *  **不发 /tree**：新名字就在事件里 —— 立刻换掉本地那一条，树上这一帧就变了（下一次 5 秒轮询会与服务端对齐）。
 *  事件里是个树上还没有的会话（不常见：别的会话刚被种了名）→ 拉一次树把它请进来。 */
function applyTitle(id, name, source) {
	const n = nodes.find((x) => x.id === id);
	if (!n) {
		load();
		return;
	}
	n.name = name ?? null;
	n.titleSource = source ?? null;
	if (id === activeId) mark("chrome"); // 顶部那一行也显示名字
	mark("tree");
}

/** 树级事件流（A 的 `GET /events`）：**不刷新页面**，树上的名字就跟着变。
 *  为什么不复用 openStream 那条：那是**单个会话**的流（打开哪个会话才开哪条），而树是全体的 ——
 *  别的会话改了标题，你正开着的那个会话那条流不会知道。 */
let treeEs = null;
function openTreeStream() {
	treeEs?.close();
	treeEs = new EventSource("/api/events");
	treeEs.onmessage = (e) => {
		let ev;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		if (ev.t === "title" && ev.id) applyTitle(ev.id, ev.name, ev.source);
	};
}

function openStream(id) {
	es?.close();
	es = new EventSource(`/api/sessions/${id}/stream`);
	es.onmessage = (e) => {
		let ev;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		handle(ev);
	};
	es.onopen = () => {
		connected = true;
		mark("tree");
	};
	es.onerror = () => {
		connected = false;
		mark("tree");
	};
}

/** delta 只能续写**紧挨着的上一个 part**（不是「该类型的最后一个」）。
 *  否则一次工具调用之后到来的新思考会被并回上一段 thinking（两段并成一段，
 *  工具全堆在后面），text 同理 —— 交错的 parts 就被拍平了。 */
const tailPart = () => (live?.parts ?? []).at(-1);

function handle(ev) {
	switch (ev.t) {
		case "hello":
			live = ev.status?.streaming ? (live ?? { parts: [], running: true, error: null }) : null;
			cmdsStreaming = !!ev.status?.streaming;
			mark("live", "chrome");
			reload();
			break;
		case "run":
			if (ev.phase === "start") {
				live = { parts: [], running: true, error: null };
				cmdsStreaming = true; // 跟着 SSE 走：拉清单那一刻的快照会发霉（开了会话才发现它在跑）
				mark("live", "chrome");
			} else {
				cmdsStreaming = false;
				mark("chrome");
				loadContext(); // 这一轮结束了 → 上下文用量变了（不轮询，就这个时点刷）
				reload().then(() => {
					live = null;
					mark("live");
				});
				// 这一轮结束了 = 插件同一刻上报的「落定」刚被记上 → 顺手刷一次树（红点立刻出现，
				// 不等 5 秒轮询）；然后按下「我在看 + 贴着底」判一次已读。
				// （我盯着的会话跑完 → 不该亮红点：那就是「我看着它落定的」。）
				load().then(() => markSeen());
			}
			break;
		case "text": {
			if (!live) live = { parts: [], running: true, error: null };
			const p = tailPart();
			if (p?.type === "text") p.text += ev.d;
			else live.parts.push({ type: "text", text: ev.d });
			mark("live");
			break;
		}
		case "thinking": {
			if (!live) live = { parts: [], running: true, error: null };
			const p = tailPart();
			if (p?.type === "thinking") p.text += ev.d;
			else live.parts.push({ type: "thinking", text: ev.d });
			mark("live");
			break;
		}
		case "tool": {
			if (!live) live = { parts: [], running: true, error: null };
			if (ev.phase === "start") live.parts.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args, running: true });
			else {
				const p = live.parts.find((x) => x.type === "tool" && x.id === ev.id && x.running);
				if (p) {
					p.running = false;
					p.result = ev.result;
					p.isError = ev.error;
				} else live.parts.push({ type: "tool", id: ev.id, name: ev.name, result: ev.result, isError: ev.error });
			}
			mark("live");
			break;
		}
		case "error":
			if (!live) live = { parts: [], running: false, error: null };
			live.error = ev.message;
			mark("live", "chrome");
			break;
		case "compact": {
			// 手动压缩的线报。**为什么要有**：pi 自己的 compaction_start/end 事件到不了这里
			//（宿主的扇出 wireOf 只转发 text/thinking/tool/agent_*），所以是 base-logic
			// 自己往 SSE 上广播的。自己发起的那次也走这里 —— 状态收敛到一处。
			// 这里**不写 notice**（话由发起方 / 后端给）；只维护「在压」这个事实 + 压完刷新。
			if (ev.phase === "start") {
				compacting = true;
			} else {
				compacting = false;
				loadContext();
				reload();
			}
			mark("chrome");
			break;
		}
	}
}

async function open(id) {
	if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
	// 「打开时视口是不是贴着底」—— **必须在下面 forceBottom 之前**记下来：
	// 打开这个动作自己就会把视口拉到到底（follow 随即变 true），那就成了「打开即已读」。
	const wasFollowing = follow;
	activeId = id;
	messages = [];
	live = null;
	pendingUser = [];
	windowSize = WINDOW;
	forceBottom = true;
	$("#input").value = "";
	notice = null;
	cmdDismissed = "";
	closeCmds();
	cmds = [];
	cmdsFor = null;
	cmdsError = null;
	cmdsStreaming = false;
	ctxUsage = null;
	ctxFor = null;
	compaction = null;
	compacting = false;
	confirmAsk = null;
	models = [];
	modelsFor = null;
	modelsError = null;
	modelsLoading = false;
	mark("chrome", "hist", "live", "cmd");
	await reload();
	mark("chrome");
	openStream(id);
	$("#input").focus();
	loadCommands().then(() => {
		// 命令清单那条路会 **ensure**（冷会话被唤醒）—— 唤醒之后再问一次用量才有数。
		// （用法那行/压缩按钮都靠它；上面那次 loadContext 是给已经热着的会话抢时间的。）
		if (activeId === id) loadContext();
	});
	loadContext(); // 不 await
	// 打开它、而且我当时贴着底（在看最新）→ 「我看过了」。
	// ⚠️ 这里用 wasFollowing（点开那一刻的状态）：滚上去读历史时点开一个会话，
	// 不该算「我看过最新那部分」。代价是那一次红点不会立刻消（再点一下、
	// 或它下轮跑完就清了）—— 判据宁紧勿松。
	markSeen(wasFollowing);
}

// ─────────────────────────── 发送 ───────────────────────────

async function send(behavior) {
	const text = $("#input").value.trim();
	if (!text || !activeId) return;
	const cmd = commandIn(text);
	// 命令在流式中**明确拒绝**：不插话、不排队（steer/followUp 对命令要么立即执行、要么报错，
	// 都不是「等这轮跑完」的语义）。输入**保留**，用户能直接改。
	if (cmd && busy()) {
		const why = compacting ? "正在压缩" : "会话正在跑";
		notice = `${why} —— 命令「/${cmd.name}」不能插话也不能排队，等这一轮跑完再发。`;
		mark("chrome");
		return;
	}
	// 清单里但**这里不能执行**的（内置命令、TUI 专用）：绝不静默，解释一句为什么不干。
	if (cmd && cmd.runnable === false) {
		notice = `「/${cmd.name}」在 webui 里不能执行：${cmd.reason ?? "TUI 专用"}`;
		mark("chrome");
		return;
	}
	// 内置命令得走**自己的路由** —— `session.prompt("/compact")` 只当普通文本（pi 的内置命令只在 TUI 层执行）。
	if (cmd?.via === "compact") {
		const extra = text.slice(cmd.name.length + 1).trim(); // /compact 后面的额外指示
		$("#input").value = "";
		cmdDismissed = "";
		closeCmds();
		notice = null;
		grow();
		askCompact(extra || null); // 有损操作 → 先确认，不直接发
		return;
	}
	if (cmd?.via === "model") {
		const want = text.slice(cmd.name.length + 1).trim();
		$("#input").value = "";
		cmdDismissed = "";
		closeCmds();
		if (!want) {
			// 只写了 `/model` → 直接把候选面板递到眼前（省得去猜 provider/id）
			$("#input").value = "/model ";
			syncCmds();
			$("#input").focus();
			notice = "要切哪个模型？从下面挑（Tab/Enter 填入），或直接写 provider/id。";
			mark("chrome");
			return;
		}
		await setModel(want);
		return;
	}
	$("#input").value = "";
	cmdDismissed = "";
	closeCmds();
	notice = null;
	grow();
	const r = await api(`/sessions/${activeId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// 命令作为**普通 prompt** 发（不带 behavior，也就不会走 steer/followUp）；
		// 普通消息保持原来的「流式中 Enter 插话 / Alt+Enter 排队」语义。
		body: JSON.stringify({ text, behavior: cmd ? undefined : behavior }),
	});
	if (!r.ok) {
		const err = await r.json().catch(() => ({}));
		const msg = err.error ?? `HTTP ${r.status}`;
		// 命令被拒（前端可能慢一拍的竞态）→ 只用那行提示，别把正在跑的直播块冲掉
		if (r.status === 409 && cmd) notice = msg;
		else live = { parts: [], running: false, error: msg };
		mark("live", "chrome");
		return;
	}
	pendingUser.push(text);
	live = { parts: [], running: true, error: null };
	forceBottom = true;
	mark("hist", "live", "chrome");
}

function grow() {
	const i = $("#input");
	i.style.height = "auto";
	i.style.height = `${Math.min(i.scrollHeight, 200)}px`;
}

/** 切模型（= TUI 的 `/model <provider/id>`）：POST /sessions/{id}/model。
 *  默认**只对这条会话生效**（pi 的 ModelMutationOptions.persist 默认 false）—— 不动全局默认模型。 */
async function setModel(want) {
	const id = activeId;
	notice = `切模型：${want} …`;
	mark("chrome");
	let r;
	try {
		r = await api(`/sessions/${id}/model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: want }),
		});
	} catch (e) {
		notice = `切模型的请求发不出去：${e?.message ?? e}`;
		mark("chrome");
		return;
	}
	const d = await r.json().catch(() => ({}));
	if (activeId !== id) return;
	if (r.ok) {
		notice = `模型已切到 ${d.model}（只对这条会话生效，没改全局默认）。`;
		modelsFor = null; // 重新拉清单，让「当前」标记跟上
		loadModels();
		loadContext(); // 窗口大小/阈值跟着模型变
	} else {
		notice = `${d.error ?? `切模型失败（HTTP ${r.status}）`}${d.candidates?.length ? " " + d.candidates.join(" / ") : ""}`;
	}
	mark("chrome");
}

// 打字：重算命令面板 + 只重画输入区（不碰消息列表）
$("#input").addEventListener("input", () => {
	notice = null; // 改了输入就撕掉上次的提示
	syncCmds();
	grow();
	mark("chrome");
});
$("#input").addEventListener("keydown", (e) => {
	if (cmdQuery !== null) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (cmdItems.length) {
				cmdIndex = (cmdIndex + (e.key === "ArrowDown" ? 1 : -1) + cmdItems.length) % cmdItems.length;
				mark("cmd");
			}
			return;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey)) {
			if (cmdItems.length) {
				e.preventDefault();
				fillCmd(cmdItems[cmdIndex]);
				return;
			}
			// 没有候选：Tab 什么也不做；Enter 落到下面当普通消息发
			if (e.key === "Tab") {
				e.preventDefault();
				return;
			}
		}
		if (e.key === "Escape") {
			e.preventDefault();
			cmdDismissed = $("#input").value; // 同值不再弹；改了输入才重新弹
			closeCmds();
			mark("chrome");
			return;
		}
	}
	if (e.key !== "Enter") return;
	if (e.shiftKey && !e.altKey) return; // Shift+Enter = 换行
	e.preventDefault();
	send(live?.running ? (e.altKey ? "followUp" : "steer") : undefined);
});
$("#send").addEventListener("click", () => send(live?.running ? "steer" : undefined));
$("#new").addEventListener("click", async () => {
	const r = await api("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	if (!r.ok) return;
	const d = await r.json();
	await load();
	await open(d.id);
});

// ─────────────────────────── 启动 ───────────────────────────

async function load() {
	let d;
	try {
		d = await (await api("/tree")).json();
	} catch {
		return;
	}
	nodes = d.nodes ?? [];
	// 「N 个会话有新东西」的汇总（A 给的：只数树里看得见的）—— 树顶那一行和它一起刷。
	unreadAgg = d.unread ?? { count: 0, oldestId: null, oldestName: null, oldestAt: null };
	renderTree(); // 树很小（几十行），直接重画
	mark("chrome");
}

await load();
openTreeStream(); // 树级 SSE：标题一变，树上那一行不用刷新就变（A 的 GET /events）
const initial = decodeURIComponent(location.hash.slice(1));
if (initial && nodes.some((n) => n.id === initial)) await open(initial);
window.addEventListener("hashchange", () => {
	const h = decodeURIComponent(location.hash.slice(1));
	if (h && h !== activeId) open(h);
});
setInterval(() => {
	load();
	reload(); // 内部有签名比较，没变就不重建
}, 5_000);
