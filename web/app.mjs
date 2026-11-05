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
import { mountMentions } from "./mentions.mjs";

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
/** **扩展消息**（`GET /messages` 的 `extras`）—— 扩展/命令用 `pi.sendMessage` 写下的东西（如 `/cwd` 的输出）。
 *  ⚠️ 它们**不在** `messages` 里（服务端刻意不塞进去，见 `server/base-logic.mjs` 的 readMessages）：
 *  所以它们**没有**消息下标、也推不出插在哪两条消息之间 —— 只能单独一块、排到正文之后。
 *  这是刻意的：宁可“位置不精确”，也不让人把机器的话当成模型的话（也绝不为了摆放它们去动 `messages` 的下标）。 */
let extras = [];
let live = null; // { parts: [], running, error, cov } —— 见下面的 advanceCoverage：cov = 「开头这段已经交给历史画了」
let pendingUser = [];
/** pi 的**队列内容**（本轮还没投给模型的那几条）：`{ steering: [文本...], followUp: [文本...] }`。
 *  · 来源有两条：① SSE `hello` 带的一次**对账**（连上/重连时读队列）；② 宿主转发的
 *    `queue_update`（`{t:"queue"}`，入队/离队都会发）—— 稳态全靠它，不轮询。
 *  · **不是**乐观状态：它是从 pi 那边读回来的事实。`pendingUser` 里一条的文本在 steering/followUp 里
 *    ⇒ 就是「**排队中**」（还没进模型上下文）；不在里面 ⇒ 已经被注入（下一次 `reload` 就进正文）。 */
let queue = { steering: [], followUp: [] };
let windowSize = WINDOW;
let es = null;
let connected = false;
/** 会话**世代**：open() 每换一次会话 +1。响应回来先比它 —— 不匹配就是「先发的那一发后到」，
 *  丢掉。切会话的竞态（加载中点另一个会话，旧响应把新会话覆盖了）就靠这个数。 */
let gen = 0;
/** 当前世代在飞请求的闸：换会话时 abort 掉。晚到的响应靠 gen 拦，abort 是顺手把带宽省了。 */
let io = null;
/** 正文有一发在飞（去重用：一轮跑完常常连着来两三条信号）。 */
let histInFlight = false;
/** 飞的过程中又来了「正文可能变了」→ 落地后再补一发（不然那条理由被吞掉：它拿到的是之前的一份）。 */
let histAgain = false;
/** 上一次 /tree 里**当前会话**的活动时钟快照（`lastActivity|settledAt`）—— 见 load() 里的兜底信号。 */
let seenAct = null;
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
// ── 中断（= TUI 的 Esc / pi 的 session.abort）──
// 与压缩**刻意不同**：中断是个**紧急出口**，所以**不弹二次确认**（多点一下可能就错过了那个「出口」）；
// 有损（这一轮已产出的会停在半路）改为：按钮 title 说清 + 点下去后明确回执 + 正文里给中断标记。
let aborting = false; // 已发出中断请求、还没收到回包（自己点的 or SSE 报的）
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
	// 直播块与历史的**重叠**（同一轮不能画两遍）在这里推一次：它同时依赖两边的最新状态，
	// 而两边都由 mark() 走到这里 —— 放在渲染之前，任何一边变了都能立刻对上账。
	// 接管范围一变，**两块都要重画**（内容从直播块挪到了历史：只重画一边会两边都在/都不在）。
	if (dirty.hist || dirty.live) {
		const before = coverPart();
		advanceCoverage();
		if (coverPart() !== before) {
			dirty.hist = true;
			dirty.live = true;
		}
	}
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
// 会话 id **一律显示原始的完整 uuid** —— 这里原来有 `const tail8 = (id) => String(id).slice(-8)`，删了。
// 为什么：解析侧（server/base.mjs 的 resolveId）只按**前缀**匹配 → 尾巴**永远**解析不到
//（人类从界面上复制过三个尾巴给 AI：`cea39876` / `1a729d02` / `238413e5`，工具一律回「没有这个会话」）；
// 而前缀也不唯一（pi 的 uuid 前 8 位是时间戳，同毫秒/同秒建的两个会话前 8 位相同）→ 任何「派生短 id」都不能当标识。
// 视觉上靠 CSS 省略号（`.sess .nm` / `#head .sub` 本来就有 overflow:hidden + text-overflow:ellipsis），
// 但**选中/复制出来必须是完整 id** —— 所以 DOM 里放的字符串是完整 id，不是片段。

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
	const label = n.name || n.id; // 没有标题 → 显示**完整 id**（CSS 省略号只管视觉；复制出来是完整 id）
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
			title: `${n.name ?? "（无标题）"}\n${n.id}${n.cwd ? `\n${n.cwd}` : ""}${n.archived ? "\n（已存档 —— 发消息就会复活）" : ""}${n.titleSource ? `\n（标题：${TITLE_SRC[n.titleSource] ?? n.titleSource}）` : ""}`,
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
	b.title = `跳到最旧的未读：${unreadAgg.oldestName || unreadAgg.oldestId}${unreadAgg.oldestAt ? `（落定于 ${fmt(unreadAgg.oldestAt)}）` : ""}`;
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

/** 收到 pi 的**队列快照 / 事件**：只更新事实，然后重画。
 *  「排队中」那个态的**自动清掉**就在这里 —— 队列里没有那条了就自然不再画成排队中（
 *  不靠猜、不靠超时、也没有另外一份乐观状态会对不上）。 */
function applyQueue(q) {
	queue = {
		steering: Array.isArray(q?.steering) ? q.steering : [],
		followUp: Array.isArray(q?.followUp) ? q.followUp : [],
	};
	mark("hist", "chrome");
}

/** 乐观块：我发出的、还没进正文的那条用户消息。
 *  · 还在 pi 的队列里（steering / followUp）→ **如实**标「排队中」+ **什么时候**会被注入
 *    —— 对齐 TUI 的 `Steering:` / `Follow-up:` 待发项（TUI 也不把它画成已提交的消息）。
 *  · 已经离队（被注入了，只是下一次 `/messages` 对账还没到）→ 画成普通已发消息。
 *  · 队列里找不到（比如超长插话被宿主截过）→ **不冒充**“排队中”：宁可不说，也不说错。 */
function pendingUserEl(text) {
	const kind = queue.steering.includes(text) ? "steering" : queue.followUp.includes(text) ? "followUp" : null;
	if (!kind) return userEl(text);
	const when =
		kind === "steering"
			? "等这一轮的工具跑完、下次请求模型前注入"
			: "等这一轮真停下来（没有更多工具/插话）时才注入";
	return el(
		"div",
		{ class: "msg user queued", "data-queue": kind },
		el(
			"div",
			{ class: "qhead" },
			el("span", { class: "qbadge", text: `⏳ 排队中 · ${kind}` }),
			el("span", { class: "qwhen", text: ` —— ${when}；还没进模型上下文` }),
		),
		el("div", { class: "body" }, el("span", { class: "prompt", text: "你 › " }), el("span", { text })),
	);
}

/** **扩展消息**那一块：扩展/命令的输出（`GET /messages` 的 `extras`），**不是模型说的话**。
 *  样式与助手正文明显不同（左侧竖条 + 灰底 + 「⚙ 扩展消息」徽标 + 来源 customType），
 *  并**明写**「不是模型说的话」—— 混进正文会让人把机器的话当成模型的判断。
 *  位置：排在正文之后（它们没有消息下标，不假装知道插在哪两条之间）。 */
function extrasEl() {
	if (!extras.length) return null;
	const box = el("div", { class: "extras" });
	for (const x of extras)
		box.append(
			el(
				"div",
				{ class: "ext" },
				el(
					"div",
					{ class: "exthead" },
					el("span", { class: "extbadge", text: "⚙ 扩展消息" }),
					el("span", { class: "extsrc", text: `${x.customType ?? "extension"} · 不是模型说的话` }),
				),
				el("div", { class: "extbody", text: x.text }),
			),
		);
	return box;
}

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
			// 这一轮被中断了（GET /messages 给的 aborted = pi 的 stopReason:"aborted"）：
			// 如实标出来 —— 否则它看起来就是一条普通的（被截断的）回复，骗人。
			if (m.aborted) box.append(el("div", { class: "aborted", text: "⏹ 这一轮被中断了（点了停止）—— 上面是中断前已产出的部分。" }));
		}
	}
	for (const t of pendingUser) box.append(pendingUserEl(t));
	const ex = extrasEl(); // 扩展消息（命令输出）：单独一块、排在正文之后（见 extrasEl 的说明）
	if (ex) box.append(ex);
	if (!messages.length && !pendingUser.length && !live && !extras.length)
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
	if (live) {
		// 开头这一截**已经交给历史画了**（同一轮不画两遍，见 advanceCoverage）—— 直播块从它后面接着画。
		const parts = live.parts.slice(coverPart());
		if (parts.length || live.error) {
			box.append(el("div", { class: "who", text: "助手 ›" }));
			box.append(partsEl("assistant", parts, { cls: live.running ? "live" : "", plain: true }));
		}
		if (live.error) box.append(el("div", { class: "body err", text: `❌ ${live.error}` }));
		// 「思考中…」只在**真的什么都没得画**时说：历史里还有一张服务端标着 running 的工具卡时，
		// 屏幕上明明有东西在跑，再补一句「思考中」就是骗人（刷新后、或这一轮的卡刚被历史接管时）。
		if (!parts.length && !live.error && !histToolRunning()) box.append(el("div", { class: "think", text: "✻ 思考中…" }));
	}
	// 「停止」按钮 title 里的「杀不到的活」靠扫 live 里在跑的工具 —— live 一变就得重算。
	// （所以它在 renderLive 里也挂一次，不只跟着 chrome 走。）
	renderAbortBtn();
}

// ─────────── 直播块 vs 历史：同一轮不能被画两遍（重叠的那部分归历史） ───────────
/**
 * 问题（2026-09-16）：一轮还在飞的时候，pi 已经把这一轮的助手消息落盘了（比如一条带 toolCall 的、
 * 或已经写出来的正文）⇒ `GET /messages` 里有它、`live` 里也有它 ⇒ 历史块一张工具卡 + 直播块
 * 同一张工具卡（同一轮画了两遍）。事实与触发路径见报告 / 提交说明。
 *
 * 解法：**直播块不再画「历史已经在画的那部分」**。
 *   · `live.cov.part` = 直播块开头有多少个 part 已经被历史接管（历史在画，直播块从这里切掉）；
 *   · `live.cov.mi` / `live.cov.pi` = 历史里「对到哪一条消息的第几个 part 了」（**只前进**）。
 *
 * 判据是**逐 part 完全相等**：文字 / 思考全等；工具按「名字 + 参数」相等（**不看 running/result**
 * —— 状态本来就该由服务端那份说话）。对不上就**不接管**：宁可多画一份，也绝不因为对不齐而把内容吞掉。
 * 三条不能省的边界（都是「宁可多画」的方向）：
 *   · 页面在工具跑着时刷新 / SSE 重连：直播块里**没有**那张卡（`tool start` 事件已经错过）⇒
 *     直播块没什么可接管的，历史照画（服务端标着 running）—— 卡不消失、已经产出的正文也不消失；
 *   · 被中断的那一轮：`live` 为 null ⇒ 没有任何接管，历史照常画那一条（含「⏹ 这一轮被中断了」）；
 *   · 窗口 / 压缩边界：接管**不碰 messages**（历史照旧按窗口与世界画），所以计数与边界块不会错位。
 *
 * ⚠️ 覆盖游标挂在 **live 对象**上（`live.cov`）：换一块直播（新一轮 / 重连 / 出错）就等于换了一份
 *    part 表，游标必须跟着重来 —— 挂在 live 上就不会忘（见 startLive）。
 * ⚠️ **只前进、不回退**：两边都只会追加内容（历史追加消息、直播块追加 part），已对上的对齐永远还
 *    对得上；回退会让历史/直播来回翻转重画。
 */

/** 开始一块新的直播（新一轮 / 刚连上 / 出错）。parts 从空开始，覆盖游标钉在**当前**历史末尾：
 *  历史里**此刻**已有的东西都不属于这块直播。
 *  ⚠️ 必须**创建时就钉**：晚一点钉（比如等下一次 flush）就可能把「刚被重拉进来的那条在飞消息」
 *  错当成直播块自己的内容 —— 那是重复，甚至是丢内容。 */
function startLive(running = true, error = null) {
	live = { parts: [], running, error, cov: { mi: messages.length, pi: 0, part: 0 } };
	return live;
}

/** 直播块开头已被历史接管的 part 数（没有直播块 = 0）。 */
const coverPart = () => live?.cov?.part ?? 0;

/** 参数用**规范化** JSON 比：两边都出自同一份原始 JSON（键序本来就一致），规范化只是不靠这个巧合。 */
const canonArgs = (a) => {
	const o = a ?? {};
	return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
};

/** 一条历史 part 与一条直播 part 是「同一份内容」吗。
 *  工具只看名字 + 参数（不看 running/result：状态由服务端那份说话）；文字 / 思考要**全等**。 */
const samePart = (h, l) =>
	!!h && !!l && h.type === l.type && (h.type === "tool" ? h.name === l.name && canonArgs(h.args) === canonArgs(l.args) : h.text === l.text);

/** 把接管范围往前推：历史里新落盘的助手消息，若直播块已经原样攒着同一份内容，就交给历史画。
 *  **逐 part** 对（不是逐条）：对到头就吞一个 part，第一个对不上的就**停在那个 part**。
 *  停在半个消息里也是安全的：历史永远画**整条**消息（接管只告诉直播块「开头这截不用你画」），
 *  所以只会「多画一份」，不会少画。
 *  用户消息（含流式中的插话）**不占直播块的位置**（直播块里只有助手的东西）—— 跳过它继续对账；
 *  历史照旧把它画在它该在的位置上。 */
function advanceCoverage() {
	if (!live) return;
	const cov = (live.cov ??= { mi: messages.length, pi: 0, part: 0 });
	for (;;) {
		if (cov.mi >= messages.length) return;
		const m = messages[cov.mi];
		if (m.role !== "assistant") {
			cov.mi++;
			cov.pi = 0;
			continue;
		}
		const ps = m.parts ?? [];
		while (cov.pi < ps.length) {
			if (!samePart(ps[cov.pi], live.parts[cov.part])) return; // 对不上 ⇒ 停在这儿（不接管）
			cov.pi++;
			cov.part++;
		}
		cov.mi++;
		cov.pi = 0;
	}
}

/** 历史里还有**服务端标着在跑**的工具吗（那一轮的卡已经由历史在画）—— 有就不该说「思考中…」。 */
function histToolRunning() {
	for (const m of messages) for (const p of m.parts ?? []) if (p.type === "tool" && p.running) return true;
	return false;
}

function renderChrome() {
	const n = nodes.find((x) => x.id === activeId);
	// 先收成数组、滤掉假值再交出去：`replaceChildren(..., null, ...)` 会插一个
	// **字面量 "null" 文本节点**（DOM 把 null 当字符串）—— 头部本来就因此多一截 "null"。
	// 这里顺手管住（包括下面新加的「快照」槽）。
	const kids = [
		// 没有名字的会话：标题行也放**完整 id**（不放空、不放片段）。下面那行 sub 是同一个 id ——
		// 这重复是原来就有的（原来是 tail8 打两遍），不想重复就把这里改成 text: n?.name || "（无标题）"。
		el("span", { class: "title", text: n?.name || (activeId ? activeId : "会话") }),
		activeId ? el("span", { class: "sub mono", text: activeId }) : null,
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
	renderAbortBtn(); // 「停止」按钮的可见/可用状态跟着 busy() 走（不忙就藏起来）
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
	requestReload(); // 正文变了（旧的被摘要替掉）
}

$("#compact").addEventListener("click", () => askCompact(null));

// ─────────────────────── 中断（= TUI 的 Esc） ───────────────────────
// 会话层的中断入口：`session.abort()`（pi 的注释：'Abort current operation and wait for agent
// to become idle.'）。这是**两次事故**给的功能：一条 bash 卡了 14 分钟、一条卡了 32 分钟，
// 会话卡在 streaming:true 出不来、界面什么都不显示、新消息也插不进（409）—— 人只能从外面杀进程。
// **核心不是「慢」，是「没有出口」**：这个按钮就是那个出口。

/** 正在跑的命令看起来会不会「杀不到」—— 扫 live 里**还在跑**的工具参数。
 *  只报**明确指到别处**的（ssh / scp / docker|kubectl|podman exec / 远程 PowerShell / psexec /
 *  UNC 共享）；**不报 wsl**：本机实测 `wsl -e bash -c …` 前台命令会被连同 VM 里的进程一起停掉。
 *  这只是启发式，不是判决 —— 所以文案用「像是」，不把猜测说成事实。 */
function remoteRisk() {
	const pat =
		/\b(ssh|scp|psexec|docker\s+exec|kubectl\s+exec|podman\s+exec|Enter-PSSession|Invoke-Command|New-PSSession)\b|-ComputerName/i;
	for (const p of live?.parts ?? []) {
		if (p.type !== "tool" || !p.running) continue;
		const a = p.args ?? {};
		const text = [a.command, a.cmd, a.script, a.file_path, a.path, JSON.stringify(a)]
			.filter((x) => typeof x === "string")
			.join(" ");
		const m = pat.exec(text);
		if (m) return { tool: p.name, hit: m[0] };
	}
	return null;
}

/** 把一次中断的结果说成人话（HTTP 回执与 SSE 线报共用一份文案，两处不会说得不一样）。 */
function abortNotice(d) {
	const note = d?.boundary?.note ? ` ${d.boundary.note}` : "";
	if (d?.code === "still-running" || d?.streaming) {
		return "已经发了中断，但它还没停下来（这一轮可能卡在一个不认中断的工具里）。再点一次试试；实在不行只能从外面精确杀进程。" + note;
	}
	if (d?.code === "idle") return "这一轮已经停了（你点的时候它刚好跑完）—— 没有需要中断的。" + note;
	return "已中断这一轮 —— 它已产出的会停在半路（正文里会给中断标记）。" + note;
}

/** 「停止」按钮的可见/可用状态。
 *  **只在忙（在跑 / 在压）时出现** —— 不忙时摆一个永远点不动的按钮只是噪音，
 *  紧急出口应该**正好在你需要它的那一刻**出现（和「压缩」按钮同一个做法：没理由就不出现）。 */
function renderAbortBtn() {
	const b = $("#abort");
	const on = !!activeId && busy();
	b.hidden = !on;
	if (!on) {
		b.textContent = "■ 停止";
		b.title = "中断当前这一轮"; // 藏起来也别留着“中断中…/杀不到”的陈旧字样
		b.classList.remove("busy");
		b.disabled = false;
		return;
	}
	b.textContent = aborting ? "中断中…" : "■ 停止";
	b.classList.toggle("busy", aborting);
	b.disabled = aborting;
	const risk = remoteRisk();
	b.title =
		(aborting
			? "正在中断当前这一轮…（等它真的停下来）"
			: compacting && !live?.running
				? "中断这次压缩（= pi 的 abortCompaction）"
				: "中断当前这一轮（= TUI 的 Esc）。会掐掉这一轮、并杀掉它起的本地子进程；这一轮已产出的会停在半路（有损）。") +
		(risk ? ` ⚠️ 当前在跑的工具像是在别处干活（匹配到 ${risk.hit}）—— 那种活这个按钮杀不到。` : "");
}

/** 真去中断：POST /sessions/{id}/abort。**不弹二次确认**（紧急出口，多点一下可能就错过了出口）；
 *  有损 + 能力边界靠按钮 title 与点后回执说清（与「压缩」那种不可逆历史操作刻意分开）。 */
async function runAbort() {
	if (!activeId || aborting) return;
	const id = activeId;
	aborting = true;
	notice = "正在中断这一轮…";
	mark("chrome");
	let r;
	try {
		r = await api(`/sessions/${id}/abort`, { method: "POST" });
	} catch (e) {
		aborting = false;
		notice = `中断请求发不出去：${e?.message ?? e}`;
		mark("chrome");
		return;
	}
	const d = await r.json().catch(() => ({}));
	aborting = false;
	if (activeId !== id) return; // 等回包期间换了会话：结果属于旧会话，不往新会话界面上写
	if (!r.ok) {
		notice = d.error ?? `中断失败（HTTP ${r.status}）`;
		mark("chrome", "live");
		return;
	}
	// 成功：**立刻**反映（不等 5 秒轮询 —— 正文只在有理由时重拉，中断就是一个理由）。
	// 服务器给了权威的 streaming 事实：停了就把「忙」的本地快照也拉平
	// （run end 的 SSE 随后也会到；这里先动是为了不让按钮在回包之后还傻站着）。
	if (d.code === "aborted" || d.code === "idle") {
		live = null; // 把「正在跑」那块收掉
		if (d.streaming === false) cmdsStreaming = false;
	}
	notice = abortNotice(d);
	mark("chrome", "live");
	loadContext();
	requestReload();
}

$("#abort").addEventListener("click", () => runAbort());

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

/** 末尾那条的「形状指纹」：工具卡的**状态**一变（跑着→完成 / 跑着→中断）就得重画 ——
 *  光看 parts.length 看不见「结果落了地」（长度没变，只有 result / running 变了）。
 *  见 applyHistory：它拿它比「这一份和上一份是不是同一份」。 */
const tailSig = (m) =>
	(m?.parts ?? [])
		.map((p) =>
			p.type === "tool"
				? `t${p.running ? "r" : p.interrupted ? "i" : p.isError ? "x" : "d"}${String(p.result ?? "").length}`
				: `${p.type}${p.text?.length ?? 0}`,
		)
		.join(".");

const histSig = () =>
	`${messages.length}|${messages.at(-1)?.text?.length ?? 0}|${tailSig(messages.at(-1))}|${pendingUser.length}|${compaction?.atIndex ?? -1}|${compaction?.tokensBefore ?? -1}|${extras.length}:${extras.at(-1)?.text?.length ?? 0}`;

/** 开一个新的会话世代：在飞的请求一律作废（abort），晚到的响应靠 gen 丢掉。
 *  返回这一次打开自己的世代号 —— open() 拿它判自己有没有被后一次打开顶掉。 */
function beginSession() {
	io?.abort();
	io = new AbortController();
	histInFlight = false; // 旧世代那一发已经作废，别挡着新会话的第一次拉
	histAgain = false;
	seenAct = null; // 新会话的活动时钟要重新观察（第一次看到只记不打）
	queue = { steering: [], followUp: [] }; // 新会话：队列状态等它的 hello 再对账
	return ++gen;
}

/** 把一份 /messages 铺进界面。只有真的变了才重建 DOM（长会话里重建比请求还贵）。 */
function applyHistory(d) {
	const before = histSig();
	messages = d.messages ?? [];
	compaction = d.compaction ?? null; // 压缩边界（没压过 → null）
	extras = d.extras ?? []; // 扩展消息（不在 messages 里，单独画）
	pendingUser = pendingUser.filter((t) => !messages.some((m) => m.role === "user" && m.text === t));
	// 历史这边新落了东西 → 可能把「直播块与历史的重叠」往前推一截（同一轮不再画两遍）。
	// 这一推改的是**两块**的可见内容 ⇒ 变了就两块都重画。
	const coverBefore = coverPart();
	advanceCoverage();
	// 接管范围变了 ⇒ 两块都重画（内容从直播块挪到了历史），提前收工。
	if (coverPart() !== coverBefore) {
		mark("hist", "live");
		return;
	}
	if (histSig() !== before) mark("hist");
}

/** 工具结束的线报到了，但**历史那一份还没跟上**（服务端仍标它 running）时补拉几发。
 *  pi 是先发 `tool_execution_end` 事件、**紧接着**才把 toolResult 落盘
 *  （`pi-agent-core/dist/agent-loop.js:275-277`：emitToolExecutionEnd → emitToolResultMessage），
 *  所以收到这条事件时立刻拉 /messages **有可能赶在落盘之前**。
 *  上限 4 发 × 250ms：到点还没落盘就放弃（run end 那一发会兜住），**绝不无限重试**。 */
function reloadUntilToolSettled(name, left = 4) {
	reload().then(() => {
		if (left <= 0) return;
		const still = messages.some((m) => (m.parts ?? []).some((p) => p.type === "tool" && p.name === name && p.running));
		if (still) setTimeout(() => reloadUntilToolSettled(name, left - 1), 250);
	});
}

/** 拉一份正文。**只在有理由时调用** —— 理由清单见 requestReload()。
 *  这里只管两件事：去重（在飞时不让第二发白拉）、以及世代校验（晚到的旧会话响应丢掉）。 */
async function reload() {
	if (!activeId || histInFlight) return;
	histInFlight = true;
	const mine = gen;
	try {
		do {
			histAgain = false;
			const id = activeId;
			let d;
			try {
				d = await (await api(`/sessions/${id}/messages`, { signal: io?.signal })).json();
			} catch {
				return; // 被 abort（换会话了）或网络断了：这一发作废，不重试
			}
			// 先发的后到 → 丢掉，别覆盖后选的会话。（abort 只是省带宽，判据是这个世代号。）
			if (mine !== gen || id !== activeId) return;
			applyHistory(d);
		} while (histAgain);
	} finally {
		if (mine === gen) histInFlight = false; // 世代已换：旧世代的收尾不许动新世代的闸
	}
}

/** 「正文可能变了」—— **唯一**的拉取入口（除了 open() 自己那次首拉）。
 *
 *  为什么要有这道门：以前是 `setInterval(…reload()…, 5000)` 无条件拉全量。稳态下（没人动、
 *  也没新内容）拉回来的是同一份，纯属白花 —— 实测总出网 39.9GB 里 39.1GB（98%）就是这一条，
 *  31,902 次、平均每次 1.23MB。跨网切会话卡、本机也卡，代价不只是带宽，还有「解析 + 重建」的固定开销。
 *
 *  允许的理由（**没有别的**）：
 *   ① 打开会话 —— open() 的首拉；
 *   ② 会话级 SSE 报到这个会话有动静：`hello`（刚连上/重连：断开那段的补课）、
 *      `run` end（一轮跑完，正文多了一条）、`compact` end（旧的原文被摘要替了）；
 *   ③ 树里当前会话的「活动时钟 / 落定时刻」动了 —— SSE 兜不住的那些，见 load() 里的说明；
 *   ④ 从后台切回来（visibilitychange）—— 离开这段时间的事件没收到；
 *   ⑤ 自己发起的动作落了地（压缩回执）；
 *   ⑥ 一条工具**结束**了、而那一张卡正由历史在画（我们接管了它的开头）或它的 `start` 那次
 *      根本没收到（刷新/重连）—— 卡片状态与结果都只能从服务端那份拿（见 reloadUntilToolSettled）。
 */
function requestReload() {
	if (activeId) reload();
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
	const src = new EventSource(`/api/sessions/${id}/stream`);
	es = src;
	src.onmessage = (e) => {
		// 这条流属于哪个会话是这里记着的：切走之后才到的事件不属于现在这个界面。
		if (activeId !== id) return;
		let ev;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		handle(ev);
	};
	src.onopen = () => {
		connected = true;
		mark("tree");
	};
	src.onerror = () => {
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
			// 连上/重连：用 pi 那边读回来的**队列快照**对一次账（不是乐观状态）。
			if (ev.queue) applyQueue(ev.queue);
			else if (ev.status?.pendingMessageCount === 0) applyQueue({ steering: [], followUp: [] }); // 老宿主兑底
			// 已经在跑的：留着手里这块（它的 part 不能被抹）；本来没在跑（刚打开/刷新过）→ 新起一块。
			// 新起的那块**此刻**什么都还没接管 ⇒ 历史里那些（包括在飞那条的消息）照旧由历史画。
			if (ev.status?.streaming) {
				if (!live) startLive();
			} else live = null;
			cmdsStreaming = !!ev.status?.streaming;
			mark("live", "chrome");
			requestReload(); // 刚连上 / 重连：断开期间落下的正文在这里补回来
			break;
		case "queue":
			// pi 的 `queue_update`（宿主 `wireOf` 转发的 `{t:"queue"}`）—— 入队/离队都来。
			// 它一条就够：队列里没那条了 ⇔ 已经被注入（下一次 reload 就进正文）。
			applyQueue(ev);
			break;
		case "run":
			if (ev.phase === "start") {
				startLive();
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
			if (!live) startLive();
			const p = tailPart();
			// ⚠️ 只续写**没被历史接管**的尾巴：被接管那个 part 已经是**落过盘的完整消息**了，
			// 新 delta 属于下一条消息 —— 续上去会把两条并成一段（并与历史对不上）。
			if (p?.type === "text" && live.parts.indexOf(p) >= coverPart()) p.text += ev.d;
			else live.parts.push({ type: "text", text: ev.d });
			mark("live");
			break;
		}
		case "thinking": {
			if (!live) startLive();
			const p = tailPart();
			if (p?.type === "thinking" && live.parts.indexOf(p) >= coverPart()) p.text += ev.d;
			else live.parts.push({ type: "thinking", text: ev.d });
			mark("live");
			break;
		}
		case "tool": {
			if (!live) startLive();
			if (ev.phase === "start") live.parts.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args, running: true });
			else {
				const p = live.parts.find((x) => x.type === "tool" && x.id === ev.id && x.running);
				if (p) {
					p.running = false;
					p.result = ev.result;
					p.isError = ev.error;
					// 这张卡已经交给历史画了（某次重拉时被接管）⇒ 屏幕上那张来自服务端，
					// 得等它把那一条标成完成 —— 再拉一发（服务端的判据是「配到 result 没有」）。
					if (live.parts.indexOf(p) < coverPart()) reloadUntilToolSettled(ev.name);
				} else {
					// 没配到「正在跑的同一张卡」：`start` 那次没收到（页面在这张卡跑着时刷新 / SSE 断过），
					// 要么它已经跑完落盘了。**绝不趁机 push 一张新卡** —— 那张卡历史里已经有了，
					// push 就是「同一张卡画两遍」（而且它没有 args，信息更少）。
					reloadUntilToolSettled(ev.name);
				}
			}
			mark("live");
			break;
		}
		case "error":
			if (!live) startLive(false);
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
				requestReload();
			}
			mark("chrome");
			break;
		}
		case "abort": {
			// 中断的线报（base-logic 自己广播的 —— pi 没有官方 abort 事件到得了这里）。
			// 作用：**别的标签页也立刻反映**（不止发起请求的那一页），且状态收敛到一处。
			if (ev.phase === "start") {
				aborting = true;
				notice = "正在中断这一轮…";
			} else if (ev.phase === "error") {
				aborting = false;
				notice = `中断时报错：${ev.error ?? ""}`;
			} else {
				aborting = false;
				if (ev.code === "aborted" || ev.code === "idle") {
					live = null; // 收掉「正在跑」那块
					if (ev.streaming === false) cmdsStreaming = false;
				}
				notice = abortNotice(ev); // 与 HTTP 回执同一份文案
				loadContext();
				requestReload();
			}
			mark("chrome", "live");
			break;
		}
	}
}

async function open(id) {
	if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
	// 「打开时视口是不是贴着底」—— **必须在下面 forceBottom 之前**记下来：
	// 打开这个动作自己就会把视口拉到到底（follow 随即变 true），那就成了「打开即已读」。
	const wasFollowing = follow;
	const my = beginSession(); // 新世代：在飞的那些（上一个会话的）在这里全作废
	activeId = id;
	messages = [];
	live = null;
	pendingUser = [];
	extras = [];
	windowSize = WINDOW;
	forceBottom = true;
	$("#input").value = "";
	notice = null;
	cmdDismissed = "";
	closeCmds();
	mentions.close(); // @ 提及面板：换会话就收起来（草稿也清了，留着没意义）
	cmds = [];
	cmdsFor = null;
	cmdsError = null;
	cmdsStreaming = false;
	ctxUsage = null;
	ctxFor = null;
	compaction = null;
	compacting = false;
	aborting = false; // 新会话：上一会话的在飞中断作废（回包靠 activeId 比对丢弃）
	confirmAsk = null;
	models = [];
	modelsFor = null;
	modelsError = null;
	modelsLoading = false;
	mark("chrome", "hist", "live", "cmd");
	await reload();
	// 等这一份的路上用户又点了别的会话 → 我这次打开已经被顶掉了：
	// 后面的（开流、拉命令/用量、标已读）全都是旧会话的事，一件都不许做。
	if (my !== gen) return;
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
	// 压缩中：**普通消息也明确拒绝**。pi 在压缩期间拒收任何 prompt（`Cannot submit a prompt while
	// compaction is in progress`）—— 发出去只会被后端 409 回来（以前甚至回 202 却悄悄丢掉）。
	// 命令走上面的分支（各自有提示）；这里管的是普通消息。输入**保留**，等它跑完再发。
	if (compacting) {
		notice = "正在压缩上下文 —— 现在发不进去（pi 在压缩期间不收新消息）。输入给你留着，等它跑完再发。";
		mark("chrome");
		return;
	}
	// @ 提及：把草稿规范化成**给模型看的那份**（带完整 uuid）。歧义 / id 片段 / 找不到 → 拦住、
	// 输入**保留**、绝不放行 —— 正是「别把 id 片段当标识」那条坑的同源防线。命令走不到这里之外的路径
	// （/compact、/model 在上面各自的 via 分支里已经处理并 return）。
	const sent = mentions.resolveForSend(text);
	if (!sent.ok) {
		notice = sent.error;
		mark("chrome");
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
		body: JSON.stringify({ text: sent.text, behavior: cmd ? undefined : behavior }),
	});
	if (!r.ok) {
		const err = await r.json().catch(() => ({}));
		const msg = err.error ?? `HTTP ${r.status}`;
		// 命令被拒（前端可能慢一拍的竞态）→ 只用那行提示，别把正在跑的直播块冲掉
		if (r.status === 409 && cmd) notice = msg;
		else startLive(false, msg);
		mark("live", "chrome");
		return;
	}
	// 扩展命令（比如 `/cwd`）：服务端执行完才写下它的输出（`pi.sendMessage` → `/messages` 的 extras），
	// 而 HTTP 202 是**不等命令跑完**就回的（`fire()` 明确不 await 整轮）—— 所以补两发拉取
	// （近的一发接快命令，稍远的一发兜住“命令里还打了一次网络往返”的情形）。
	// ⚠️ 扩展命令**不会**变成一条 user 消息（pi 的 `_tryExecuteExtensionCommand` 直接把它消费掉了）
	// ⇒ **绝不 push 进 pendingUser**：那会留一个永远不消失的「你 /cwd」泡泡（它再也不会被正文里的
	// user 消息兑掉）。它的可见痕迹就是下面那两发拉回来的 extras 块。
	if (cmd?.source === "extension") {
		notice = null;
		for (const ms of [250, 1200]) setTimeout(() => { load(); requestReload(); }, ms);
		mark("chrome");
		return;
	}
	pendingUser.push(sent.text);
	// 【别改回无条件重置】流式中的插话/排队（steer/followUp）**绝不能清 live** —— 那一刻 live 里
	// 攒着的（thinking / 工具 / 正文）**还没落盘**（pi 在 message_end 才写文件），清它就是
	// 「发完消息、中间那段直播内容凭空消失」（webui 与 TUI 在这里不一致：TUI 只把它当待发项，
	// 正文照旧滚动 —— 这条踩过坑，内部的「坑表」里有记录）。
	// 判据：**只有「空闲 / 上一轮已收尾」才该清** —— 新一轮从干净块开始，别把上一轮残块留在屏幕上。
	// `running` 为假（含 live 为 null、或上一轮 run end 已把它收掉）→ 新起一块；
	// 正在跑（steer/followUp）→ 只确认「还在跑」，parts 一个不动。
	if (!live?.running) startLive();
	else live.running = true;
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
// ─────────────────────────── 新建会话（选目录） ───────────────────────────
// 以前这里发的是**空 body** ⇒ 只会在默认目录建会话（后端 `POST /sessions {cwd}` 早就支持，
// 只差一个能填/选目录的 UI）。现在：一个输入框 + 「最近用过」下拉，下拉读 `GET /cwd-recents`
// —— 与 agent 的 `cwd` 工具、`/cwd` 参数补全**同一份**服务端账（前端不自己另推一份）。
// ⚠️ 目录里**没有白名单**：任意目录都能开（B 零认证 ⇒ 与现状等价），这里不假装做了限制。
const newBox = $("#newbox");
const newCwd = $("#newcwd");
const newRecent = $("#newrecent");
const newHint = $("#newhint");

/** 拉一次 recents 铺进下拉。坏账 / 拿不到都**如实写进 hint**（不静默当空）。 */
async function fillRecents() {
	try {
		const r = await api("/cwd-recents");
		const d = await r.json().catch(() => ({}));
		const list = Array.isArray(d.recents) ? d.recents : [];
		newRecent.replaceChildren(new Option("最近用过…", ""));
		for (const x of list) newRecent.append(new Option(`${x.path}（用过 ${x.count} 次）`, x.path));
		newHint.textContent = d.error
			? `⚠️ 「最近用过」那份账读不了：${d.error}`
			: "留空 = 服务端默认目录。任意目录都能开 —— 这里没有白名单，别以为它替你挡住了什么。";
	} catch (e) {
		newRecent.replaceChildren(new Option("最近用过…", ""));
		newHint.textContent = `⚠️ 读不到「最近用过」：${e?.message ?? e}`;
	}
}

function openNewBox() {
	newBox.hidden = false;
	newCwd.value = "";
	newHint.textContent = "读取中…";
	void fillRecents();
	newCwd.focus();
	mark("chrome");
}

async function createSession() {
	const cwd = newCwd.value.trim();
	let r;
	try {
		r = await api("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(cwd ? { cwd } : {}),
		});
	} catch (e) {
		newHint.textContent = `建会话失败：${e?.message ?? e}`;
		return;
	}
	const d = await r.json().catch(() => ({}));
	if (!r.ok) {
		newHint.textContent = `建会话失败：${d.error ?? `HTTP ${r.status}`}`;
		return;
	}
	newBox.hidden = true;
	await load();
	await open(d.id);
}

newRecent.addEventListener("change", () => {
	if (newRecent.value) newCwd.value = newRecent.value;
});
$("#newcancel").addEventListener("click", () => {
	newBox.hidden = true;
	mark("chrome");
});
$("#newgo").addEventListener("click", () => void createSession());
newCwd.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		void createSession();
	} else if (e.key === "Escape") {
		newBox.hidden = true;
	}
});
$("#new").addEventListener("click", () => openNewBox());

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
	// 兜底信号：树里**当前这个会话**的「活动时钟 / 落定时刻」动了 → 正文可能变了。
	// 为什么 SSE 不够（还得再看一眼树）：会话流只转发 delta / tool / agent_*（见 server/base.mjs 的
	// wireOf），别的 pi 进程（比如你在 TUI 里动着同一个会话）写进那份会话文件的东西不会变成事件 ——
	// 但插件会把 agent_settled 上报回来，落定时刻就在这棵树里。
	// 这条**不花任何额外请求**：/tree 本来每 5 秒就在轮询（几十行，很小）。
	// 只在它**已经不在流式**时才补拉：流式期间正文有 SSE 在推，再拉一份全量是自抢带宽。
	const me = activeId ? nodes.find((x) => x.id === activeId) : null;
	const act = me ? `${me.lastActivity ?? ""}|${me.settledAt ?? ""}` : null;
	if (act !== null && seenAct !== null && act !== seenAct && !me.streaming) requestReload();
	if (me) seenAct = act;
	mark("chrome");
}

await load();
// @ 会话选择器（web/mentions.mjs）：自己挂 input / keydown（keydown 在父元素**捕获阶段**，
// 面板开着时先于 app 的 input 监听器接管方向键 / Enter / Esc），所以 app 的 keydown 一行都不用改。
// `/` 面板开着时用 isBlocked 让位（两边同一套手感、互不抢键）。
const mentions = mountMentions({
	input: $("#input"),
	getNodes: () => nodes,
	getActiveId: () => activeId,
	isBlocked: () => cmdQuery !== null,
	onInsert: () => grow(),
});
openTreeStream(); // 树级 SSE：标题一变，树上那一行不用刷新就变（A 的 GET /events）
const initial = decodeURIComponent(location.hash.slice(1));
if (initial && nodes.some((n) => n.id === initial)) await open(initial);
window.addEventListener("hashchange", () => {
	const h = decodeURIComponent(location.hash.slice(1));
	if (h && h !== activeId) open(h);
});
// 每 15 秒只刷**树**（几十行，很小）—— 正文**不在这里拉**：稳态下（没人动、也没新内容）
// 那份 1.2MB 的正文拉回来是同一份，白白吃掉 98% 的出网（见 requestReload 的说明）。
// 该在什么时候拉，只有 requestReload() 一处说了算。
//
// **为什么从 5 秒改成 15 秒**：这条轮询不是免费的 —— 它是一个**全量** `/tree`，
// 而 `/tree` 要碰**每一个会话文件**。实测：真机上用户开着 2 个页面 ⇒ **2 次 / 5 秒**；
// 在实测机上这就是 A 空闲 CPU 的 ~85%（修前 24 次 × 0.42 s = 10.1 s/分钟 ⇒ 单核 19.3%）。
// 而且服务端是**同步**文件读，它一跑，同时来的 `/messages`（= 你点会话）就得排队等它
// —— “切会话卡”的直接来源之一。
// （宿主的 `headerOf` 已经改成只读头 8 KB，/tree 本身快了很多；但剩下的部分仍随**会话数**线性长：
//  本地 238 会话的副本上，修完仍是 **32 ms/次**，其中约 2/3 是 `readTitles()` —— 每个节点都要把
//  titles.json 重读重解一遍。这是下一刀，不在本次范围内。会话越多、这条轮询越贵。）
//
// **代价（诚实地写在这里）**：这棵树里**除了标题以外的所有东西都只由这条轮询更新** ——
// 未读红点 / 树顶「N 个会话有新东西」/ 活动时钟 / 落定时刻 / hot/streaming 标记都是 `/tree` 给的
//（`/api/events` 那条树级 SSE **只发 `{t:"title"}`**，见 openTreeStream）。所以从 5 秒放宽到
// 15 秒，代价就是：
//   · 别人的会话刚跑完 → 红点/「N 个有新东西」最坏晚 **15 秒**才亮（原来≤5 秒）；
//   · 下面那条「别的 pi 进程（比如 TUI）写了当前会话」的兜底补拉，最坏也晚 15 秒。
// 下面用两个**不花额外代价的时机**把它补回来：页面回到前台（visibilitychange，已有）和窗口拿到焦点。
// 正文/流式本身不靠它：那是会话级 SSE 在推 + run/compact/abort 那几个事件。
//
// ⚠️ 降频降的是「没人动时的无谓全量轮询」，**不是“树不再更新”** —— 兜底轮询与事件驱动两样都在。
//    `web/test-scroll.mjs` 里盯这两件事的断言按新节拍同步改了（见 sleep 的注释）。
const TREE_POLL_MS = 15_000;
setInterval(load, TREE_POLL_MS);
// 从别的窗口/显示器点回这个页面：标签页可能一直“可见”，visibilitychange 不会触发 → 补一发。
window.addEventListener("focus", () => load());
// 从后台切回来：离开期间浏览器会把定时器/SSE 压下去，事件也接不到 → 补拉一次。
// （这是「没收到信号也得拉」的唯一场合：信号通道本身在你不在的时候是断的。）
document.addEventListener("visibilitychange", () => {
	if (document.hidden) return;
	load();
	requestReload();
});
