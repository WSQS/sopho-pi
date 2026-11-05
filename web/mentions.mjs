/**
 * web/mentions.mjs —— 「用 @ 指定另一个 session」（第一期：模块 + 语义）
 *
 * 纯逻辑 + 一个能被 app.mjs 直接挂上去的选择器（vanilla ESM、无构建，跟 render.mjs 一个路数）。
 * 本文件**不碰 DOM**，直到你调用 mountMentions()（所以 node 里也能 import 来测纯函数）。
 *
 * ───────────────────────── 语义：为什么选 A（mention），不选 B（route） ─────────────────────────
 *
 * A 提及：`@` 只是把「我在说哪个会话」**明确地**写进消息 —— 消息还是发给**当前**会话；
 *         当前会话的模型看到那串引用后，自己决定 `session_send` / `session_read`。
 * B 路由：`@` 选中的会话就是**收件人** —— 按发送就把这条消息发给**那个**会话（当前会话只是你正在看的窗口）。
 *
 * 选 **A**。理由：
 *  1. **不重复已有的能力。** pi 的模型手上已经有 `session_send` / `session_read`（pi-extensions/assistant）——
 *     「跟另一个会话说话」是**工具层已经存在的事实**。B 会在 wrapper 层再造一条通往同一个会话的路，
 *     两条路语义还不一样（工具那条会通知/唤醒、带上下文；wrapper 那条是硬塞一条 user 消息）。
 *     工作约定第 5 条「一切推导只在 base-logic 一份，不在第二处重算」的精神就是不造第二套。
 *  2. **误发的代价差一个数量级。** A 最坏情况是「模型没看懂这串引用」—— 消息仍落在你正在看的会话里，
 *     模型可以当场 `session_read` / `session_send` 补救，人全程看得见。B 一旦选错/名字撞了，句子会被**静默塞进
 *     另一个会话的对话**里，两边都在跑，人还未必立刻发现 —— 正是最该避免的「悄悄发错人」。
 *  3. **行中出现天然成立。** 「帮我问 @B 那件事有结论没」这句里，B 只是**对象**，句子本身是对**当前**会话说的。
 *     在 A 下它原样成立；在 B 下整句话会被发去 B，语义就错了。`@` 本来就常出现在句子中间。
 *  4. **「点谁跟谁说话」这条需求已经有一条更直接的路**：左栏点节点。composer 里的 `@` 不是「切收件人」的
 *     自然位置 —— 它更像「引用」。B 等于把左栏点击重做一遍，还多一层猜。
 *  （第三种可能是「@=路由 + 同时在当前会话留一条回执」，那既没有 A 的简单，也没有 B 的直接，不取。）
 *
 * ───────────────────────── token 格式：给人看名字，给机器完整 uuid ─────────────────────────
 *
 * 硬规矩（docs/ops/handoff.md 坑表「别把 id 片段当标识」）：界面 / 日志 / 提示词 / 工具返回值**一律给完整 uuid**，
 * 片段一律拒绝（前缀不唯一、尾巴永远解析不到）。所以插进草稿、真正发出去的 token **必须含完整 uuid**。
 *
 * 本模块的取舍：**输入框里的字 == 发出去的字**（textarea 没有隐藏态），token 一个形状同时满足两端：
 *
 *     @#<完整 uuid>「<显示名>」
 *
 *  · `#<完整 uuid>` 是**仓库里已有的会话引用写法**（唤醒提示词 `#${childId}「${name}」`、冲突行
 *    `${id} 「${name}」` 都是它）—— 模型见过无数次，看到就知道这是会话 id，零歧义。
 *  · `@` 是用户语汇：一眼看出「这是个人在外面引的会话」，也用于前端解析（`@#...` = 已完成的提及）。
 *  · `「显示名」` 只为人读（可省略；名字为空/被改过都不影响 —— uuid 才是权威）。
 *  · 为什么不做「框里显示名字、发送时再翻译成 uuid」：那会让**框里的字 != 发出去的字**，复制出去就失效，
 *    正是「id 片段当标识」那类坑的同源问题。这里选 WYSIWYG：你能看见的，就是会发出去的。
 *
 * 模型看到的那份 = 上面这个 token（resolveDraft 会把用户手敲的松散 `@名字` 规范成这个形状）。
 * 于是正文里出现的是 `@#<uuid>「名字」`，模型可以直接把 `<uuid>` 复制进 `session_send` 的 id 参数。
 *
 * ───────────────────────── 解析规则（parseMentions / resolveDraft）─────────────────────────
 *
 *  · `@` 必须出现在**行首**或**空白/开括号/标点之后** —— `user@example.com` 不算提及（前导是 `a`）。
 *  · 一个草稿里可以有**多个**提及；连字符、引号、代码块**不做例外**（草稿不是源码，宁可显式拒绝也不静默放过）。
 *  · **名字含空格**：手敲的松散 `@foo bar` 只把 `foo` 当提及（空格截断了）。要引用带空格的名字：
 *    用选择器选（会插入完整 token），或手敲**完整 uuid**。这条在 resolveDraft 里会明确提示，不会猜。
 *  · 想写一个**字面量** `@`：`@@` 不是提及（第一个 `@` 后面不接名字、第二个前导是 `@`），
 *    或让 `@` 后面直接跟空白。
 *  · 松散提及的解析优先级：完整 uuid > 名字精确匹配 > 名字子串（唯一）—— 其余（歧义 / 像 id 片段 /
 *    找不到）一律**明确拒绝**，绝不静默产出一个用不了的 id。
 */

// ─────────────────────────── 常量 / 基础判定 ───────────────────────────

const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_BODY}$`, "i");
const CANON_AT_RE = new RegExp(`^@#(${UUID_BODY})(?:「([^」\\n]*)」)?`, "i");
// 光标前这串是不是「已经开始写的 canonical token（含只写了 uuid 没写名字）」
const CANON_PREFIX_RE = new RegExp(`^@#${UUID_BODY}`, "i");

/** 是不是一个**完整**的 uuid（36 字符，8-4-4-4-12）。片段一律 false。 */
export const isFullUuid = (s) => UUID_RE.test(String(s ?? "").trim());

/** 允许出现在提及前面的字符：行首 / 空白 / 开括号 / 常见标点。
 *  `@` 前面是字母数字（`a@b`）就不算提及 —— 邮箱、社交 handle 之类不该被吞。 */
const PRED_BEFORE = /[\s([{（【「"'，。、：:；;！？!?]/;
const predOk = (t, i) => i === 0 || PRED_BEFORE.test(t[i - 1]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(Number.isFinite(n) ? n : lo, hi));

/** 这个 session 的 canonical token：`@#<uuid>「<name>」`（名字可省）。 */
export function canonicalToken(session) {
	const id = String(session?.id ?? session?.uuid ?? "").trim().toLowerCase();
	if (!isFullUuid(id)) throw new Error("canonicalToken: session id 必须是完整 uuid");
	const name = String(session?.name ?? "")
		.replace(/[「」\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return `@#${id}${name ? `「${name}」` : ""}`;
}

// ─────────────────────────── 解析 ───────────────────────────

/**
 * 从草稿文本里认出所有提及。
 * @returns {Array<{start:number,end:number,raw:string,kind:"canonical"|"loose",uuid?:string,name?:string|null,query?:string}>}
 *   canonical = 已经带完整 uuid 的（选择器插进去的那种）；loose = 用户手敲的（send 前要 resolveDraft）。
 */
export function parseMentions(text) {
	const t = String(text ?? "");
	const out = [];
	for (let i = 0; i < t.length; i++) {
		if (t[i] !== "@" || !predOk(t, i)) continue;
		const rest = t.slice(i);
		const cm = CANON_AT_RE.exec(rest);
		if (cm) {
			out.push({ start: i, end: i + cm[0].length, raw: cm[0], kind: "canonical", uuid: cm[1].toLowerCase(), name: cm[2] ?? null });
			i += cm[0].length - 1;
			continue;
		}
		// 松散：`@` 后面一段非空白、且不含 @ 「 」（名字里的空格在这里天然截断 —— 见文件头）。
		const lm = /^@([^\s@「」]+)/.exec(rest);
		if (lm) {
			out.push({ start: i, end: i + lm[0].length, raw: lm[0], kind: "loose", query: lm[1] });
			i += lm[0].length - 1;
		}
	}
	return out;
}

/** 光标前正在敲的那个提及（选择器用）；没有就 null。
 *  已经是一个完整的 canonical token（或它的前缀）→ null —— 编辑名字时不该弹面板。 */
export function mentionAt(text, cursor) {
	const t = String(text ?? "");
	const c = clamp(cursor, 0, t.length);
	let at = -1;
	for (let i = c - 1; i >= 0; i--) {
		if (t[i] === "@") {
			at = i;
			break;
		}
		if (/\s/.test(t[i])) break; // 空白截断：光标前没有还没闭合的 @
	}
	if (at < 0 || !predOk(t, at)) return null;
	const soFar = t.slice(at, c);
	if (CANON_PREFIX_RE.test(soFar)) return null; // 已经在写带完整 uuid 的 token 了
	return { start: at, end: c, q: t.slice(at + 1, c) };
}

// ─────────────────────────── 插入 ───────────────────────────

/**
 * 在文本的「正在输入的那个提及」处插入 canonical token（没有就把光标当插入点）。
 * 纯函数：给定 text + cursor + 选中的 session → 新 text + 新 cursor。
 * @param {{start:number,end:number}} [range] 显式替换区间（选择器记住的那一段；鼠标点候选时比光标更准）。
 * @returns {{text:string,cursor:number,start:number,end:number}}
 */
export function insertMention(text, cursor, session, range) {
	const t = String(text ?? "");
	const c = clamp(cursor, 0, t.length);
	const m = range ?? mentionAt(t, c);
	const start = m ? m.start : c;
	const end = m ? m.end : c;
	const token = canonicalToken(session);
	const tail = /^\s/.test(t.slice(end)) ? "" : " "; // 后面已经有空白就不叠
	const text2 = t.slice(0, start) + token + tail + t.slice(end);
	const cursor2 = start + token.length + tail.length;
	return { text: text2, cursor: cursor2, start, end: cursor2 };
}

// ─────────────────────────── 候选 ───────────────────────────

/**
 * 从 /tree 的 nodes 里挑候选。**不需要新接口** —— nodes 每条已带完整 id / name / archived / hot /
 * streaming / unread / cwd。
 * 规则：
 *  · 查名字、也查**完整 id**（粘贴 uuid 也能搜到）。
 *  · **包含 /tree 的全部会话**：直接归档项与被归档祖先藏住的后代都能引用，不在前端另做收窄。
 *  · 当前会话保留（可以引用自己），打「当前」标签。
 *  · 顺序：活跃组在前、归档子树组在后；组内沿用 /tree 给的顺序，不另发明一套排序。
 */
export function candidates(nodes, q, { activeId = null } = {}) {
	const s = String(q ?? "")
		.replace(/^#/, "")
		.trim()
		.toLowerCase();
	const list = [];
	for (const n of nodes ?? []) {
		if (!n) continue;
		if (s) {
			const name = String(n.name ?? "").toLowerCase();
			const id = String(n.id ?? "").toLowerCase();
			if (!name.includes(s) && !id.includes(s)) continue;
		}
		list.push({ ...n, label: n.name || n.id, current: n.id === activeId, archivedGroup: Boolean(n.archived || n.hiddenByArchive) });
	}
	// 被归档祖先藏住的后代也属于归档子树；组内保持 /tree 顺序。
	return [...list.filter((n) => !n.archivedGroup), ...list.filter((n) => n.archivedGroup)];
}

// ─────────────────────────── 发送前规范化 ───────────────────────────

/** 像 id 片段吗（8+ 位十六进制，或 `xxxx-…` 这种带连字符的 hex）—— 这类必须显式拒绝。 */
const looksLikeIdFragment = (q) =>
	/^[0-9a-f]{8,}$/i.test(q) || /^[0-9a-f]{4,}-[0-9a-f-]*$/i.test(q);

const briefNode = (n) => `${String(n.id).toLowerCase()}${n.name ? `「${n.name}」` : ""}`;

function errorText(r, m) {
	const raw = m?.raw ?? "@";
	switch (r.code) {
		case "ambiguous-name": {
			// 撞车的可能很多（子串命中一大片）—— 只列前几个，其余给个数，别把提示刷成一面墙。
			const list = r.matches.slice(0, 5).join(" / ") + (r.matches.length > 5 ? ` …等 ${r.matches.length} 个` : "");
			return `${raw} 有多个会话匹配（${list}）—— 用 @ 从候选里选（会插入完整 uuid），别用会撞的名字。`;
		}
		case "id-fragment":
			return `${raw} 像 **id 片段**，不能用 —— 解析只认**完整 uuid**（前缀不唯一、尾巴永远解析不到）。用 @ 从候选里选，或粘贴完整 uuid。`;
		case "unknown":
			return `找不到会话「${r.q}」—— 用 @ 从候选里选（会插入完整 uuid）；想写普通的 @，就在它后面加个空格、或写 @@。`;
		default:
			return `${raw} 不是一个能用的会话引用。`;
	}
}

/** 解析一条松散提及（已经排除了 canonical）。 */
function resolveLoose(m, nodes) {
	const q = String(m.query ?? "").replace(/^#/, "").trim();
	if (!q) return { ok: false, reason: { code: "unknown", q } };
	// 与 candidates 同一口径：/tree 给出的全部会话都可解析，前端不再排除归档子树。
	const pool = (nodes ?? []).filter(Boolean);

	// 1) 完整 uuid：结构上永远是能用的（不必在 pool 里 —— 树可能是旧的；真不存在服务端会兜底报错）。
	if (isFullUuid(q)) {
		const hit = pool.find((n) => String(n.id).toLowerCase() === q.toLowerCase());
		return { ok: true, token: canonicalToken(hit ?? { id: q.toLowerCase() }), uuid: q.toLowerCase(), name: hit?.name ?? null, by: "uuid" };
	}

	// 2) 名字精确匹配（唯一才认）。
	const ql = q.toLowerCase();
	const named = pool.filter((n) => String(n.name ?? "").toLowerCase() === ql);
	if (named.length === 1) return { ok: true, token: canonicalToken(named[0]), uuid: named[0].id, name: named[0].name ?? null, by: "name" };
	if (named.length > 1) return { ok: false, reason: { code: "ambiguous-name", q, matches: named.map(briefNode) } };

	// 3) 像 id 片段 / 是某个 id 的前缀或尾巴 → 明确拒绝（这条正是「别把片段当标识」）。
	const prefix = pool.filter((n) => ql.length >= 4 && String(n.id).toLowerCase().startsWith(ql));
	const tail = pool.filter((n) => ql.length >= 4 && String(n.id).toLowerCase().endsWith(ql));
	if (looksLikeIdFragment(q) || prefix.length || tail.length) {
		return { ok: false, reason: { code: "id-fragment", q, prefixMatches: prefix.map(briefNode), tailMatches: tail.map(briefNode) } };
	}

	// 4) 名字子串（唯一才认，方便敲一半）。
	const sub = pool.filter((n) => String(n.name ?? "").toLowerCase().includes(ql));
	if (sub.length === 1) return { ok: true, token: canonicalToken(sub[0]), uuid: sub[0].id, name: sub[0].name ?? null, by: "name-sub" };
	if (sub.length > 1) return { ok: false, reason: { code: "ambiguous-name", q, matches: sub.map(briefNode) } };

	// 5) 找不到 → 明确拒绝（不静默把 @foo 当普通文本发出去）。
	return { ok: false, reason: { code: "unknown", q } };
}

/**
 * 发送前把草稿规范化成**给模型看的那份**：
 *  · canonical 提及原样留着；
 *  · 松散提及：完整 uuid / 唯一名字 → 换成 canonical（带完整 uuid）；歧义 / id 片段 / 找不到 → **拒绝**。
 * 返回 { ok:true, text } 或 { ok:false, error, errors, mentions }。`text` 才是应该 POST 出去的正文。
 */
export function resolveDraft(text, nodes) {
	const t = String(text ?? "");
	const ms = parseMentions(t);
	const mentions = [];
	const errors = [];
	for (const m of ms) {
		if (m.kind === "canonical") {
			mentions.push(m);
			continue;
		}
		const r = resolveLoose(m, nodes);
		if (!r.ok) errors.push({ mention: m, reason: r.reason });
		mentions.push({ ...m, ...r });
	}
	if (errors.length) {
		return { ok: false, error: errorText(errors[0].reason, errors[0].mention), errors, mentions };
	}
	// 从后往前替换（改长度不影响前面的下标）。
	let out = t;
	for (let i = mentions.length - 1; i >= 0; i--) {
		const m = mentions[i];
		if (m.kind === "canonical") continue;
		out = out.slice(0, m.start) + m.token + out.slice(m.end);
	}
	return { ok: true, text: out, errors: [], mentions };
}

// ─────────────────────────── 选择器状态（无 DOM，可单测）───────────────────────────

/**
 * `@` 面板的状态机 —— 和 app.mjs 里 `/` 命令面板同一套手感（上下选、Esc 关、过滤、在光标处插入），
 * 但把 DOM 隔离开，方便 `node test/mentions.mjs` 直接驱动。
 */
export function createMentionState({ getNodes = () => [], getActiveId = () => null, isBlocked = () => false } = {}) {
	let open = false;
	let start = 0;
	let q = "";
	let items = [];
	let index = 0;
	let dismissed = null; // Esc 关掉时的那段文本：同值不再弹，改了才重弹（与 app 的 cmdDismissed 一致）

	const rebuild = () => {
		items = candidates(getNodes(), q, { activeId: getActiveId() });
		if (index >= items.length) index = Math.max(0, items.length - 1);
	};
	const reset = () => {
		open = false;
		items = [];
		q = "";
	};

	return {
		get open() {
			return open;
		},
		get items() {
			return items;
		},
		get index() {
			return index;
		},
		get query() {
			return q;
		},
		current() {
			return items[index] ?? null;
		},
		/** 输入 / 光标变了：重算候选、决定开关。返回现在是否开着。 */
		sync(text, cursor) {
			if (isBlocked()) {
				reset();
				return false;
			}
			if (dismissed !== null && text === dismissed) return open; // Esc 关过且没改 → 不重开
			if (dismissed !== null && text !== dismissed) dismissed = null;
			const m = mentionAt(text, cursor);
			if (!m) {
				reset();
				return false;
			}
			const changed = !open || m.start !== start || m.q !== q;
			start = m.start;
			q = m.q;
			open = true;
			if (changed) index = 0;
			rebuild();
			return true;
		},
		move(d) {
			if (!open || !items.length) return;
			index = (index + d + items.length) % items.length;
		},
		selectIndex(i) {
			if (i >= 0 && i < items.length) index = i;
		},
		/** 选中 → 只改文本、不发送（跟 `/` 面板一样，留着让人接着写）。返回 {text,cursor} 或 null。 */
		commit(text, cursor) {
			if (!open) return null;
			const sel = items[index];
			if (!sel) return null;
			const c = clamp(cursor, 0, String(text ?? "").length);
			const r = insertMention(text, c, sel, { start, end: c });
			dismissed = null;
			reset();
			return r;
		},
		close() {
			reset();
			return false;
		},
		dismiss(text) {
			dismissed = String(text ?? "");
			reset();
			return false;
		},
	};
}

// ─────────────────────────── DOM 挂载 ───────────────────────────

/** 一行的状态标签（最多几个，说明它对不对得上 / 要不要复活）。 */
function badgesOf(candidate) {
	const badges = [];
	if (candidate.archivedGroup) badges.push({ text: "已存档", className: "archived" });
	if (candidate.current) badges.push({ text: "当前", className: "" });
	if (candidate.status === "working" || candidate.streaming) badges.push({ text: "运行中", className: "" });
	else if (candidate.unread) badges.push({ text: "未读", className: "" });
	if (!badges.length) badges.push({ text: "闲置", className: "" });
	return badges;
}

/**
 * 把选择器挂到 composer。选择只写回 textarea，不改变当前发送目标。
 * 键盘监听挂在 composer 的捕获阶段，所以面板打开时会先于发送与命令面板接管 ↑↓/Enter/Tab/Esc。
 */
export function mountMentions({ input, getNodes, getActiveId, isBlocked, onInsert, doc = document } = {}) {
	if (!input) throw new Error("mountMentions: 需要 input 元素（#prompt）");
	const box = doc.createElement("div");
	box.id = "mention-palette";
	box.setAttribute("role", "listbox");
	box.setAttribute("aria-label", "引用会话");
	box.hidden = true;
	input.parentElement?.insertBefore(box, input);

	const state = createMentionState({ getNodes, getActiveId, isBlocked });
	const element = (tag, className, text) => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	};

	const commit = () => {
		const result = state.commit(input.value, input.selectionStart ?? input.value.length);
		if (!result) return;
		input.value = result.text;
		input.setSelectionRange?.(result.cursor, result.cursor);
		render();
		onInsert?.(result);
	};

	const render = () => {
		box.hidden = !state.open;
		box.replaceChildren();
		if (!state.open) return;
		if (!state.items.length) {
			box.append(element("div", "mention-palette-note", state.query ? `没有匹配「${state.query.replace(/^#/, "")}」的会话。` : "还没有可引用的会话。"));
		} else {
			const archivedStart = state.items.findIndex((candidate) => candidate.archivedGroup);
			state.items.forEach((candidate, index) => {
				if (index === archivedStart && archivedStart > 0) {
					const separator = element("div", "mention-palette-separator", "归档");
					separator.setAttribute("role", "separator");
					box.append(separator);
				}
				const row = element("button", `mention-palette-item${index === state.index ? " selected" : ""}`);
				row.type = "button";
				row.dataset.sessionId = candidate.id;
				row.dataset.archived = String(candidate.archivedGroup);
				row.title = `${candidate.name ?? "（无标题）"}\n${candidate.id}${candidate.cwd ? `\n${candidate.cwd}` : ""}${candidate.archivedGroup ? "\n（归档）" : ""}`;
				row.append(element("span", "mention-name", candidate.label));
				for (const badge of badgesOf(candidate)) row.append(element("span", `mention-badge${badge.className ? ` ${badge.className}` : ""}`, badge.text));
				row.append(element("span", "mention-id", candidate.id));
				row.addEventListener("mousedown", (event) => event.preventDefault());
				row.addEventListener("click", () => {
					state.selectIndex(index);
					commit();
				});
				box.append(row);
			});
		}
		box.append(element("div", "mention-palette-note", "↑↓ 选择 · Tab/Enter 插入 · Esc 关闭"));
		box.querySelector(".mention-palette-item.selected")?.scrollIntoView({ block: "nearest" });
	};

	const onInput = () => {
		state.sync(input.value, input.selectionStart ?? input.value.length);
		render();
	};
	input.addEventListener("input", onInput);

	const keyHost = input.parentElement ?? doc;
	const onKey = (event) => {
		if (event.target !== input || !state.open) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			state.move(event.key === "ArrowDown" ? 1 : -1);
			render();
			return;
		}
		if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey)) {
			if (state.items.length) {
				event.preventDefault();
				event.stopPropagation();
				commit();
			} else if (event.key === "Tab") event.preventDefault();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			state.dismiss(input.value);
			render();
		}
	};
	keyHost.addEventListener("keydown", onKey, true);

	return {
		state,
		box,
		isOpen: () => state.open,
		sync: onInput,
		close: () => {
			state.close();
			render();
		},
		resolveForSend: (text) => resolveDraft(text, getNodes()),
		destroy: () => {
			input.removeEventListener("input", onInput);
			keyHost.removeEventListener("keydown", onKey, true);
			box.remove();
		},
	};
}
