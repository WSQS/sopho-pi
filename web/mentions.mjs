/**
 * web/mentions.mjs —— 「用 @ 指定另一个 session」（第一期：模块 + 语义）
 *
 * 纯逻辑 + 一个能被 app.mjs 直接挂上去的选择器（vanilla ESM、无构建，跟 render.mjs 一个路数）。
 * 本文件**不碰 DOM**，直到你调用 mountMentions()（所以 node 里也能 import 来测纯函数）。
 *
 * ───────────────────────── 语义：为什么选 A（mention），不选 B（route） ─────────────────────────
 *
 * A 提及：`@` 只是把「我在说哪个会话」**明确地**写进消息 —— 消息还是发给**当前**会话；
 *         当前会话的模型看到那串引用后，自己决定 `send` / `session_read`。
 * B 路由：`@` 选中的会话就是**收件人** —— 按发送就把这条消息发给**那个**会话（当前会话只是你正在看的窗口）。
 *
 * 选 **A**。理由：
 *  1. **不重复已有的能力。** pi 的模型手上已经有 `send` / `session_read`（pi-extensions/assistant）——
 *     「跟另一个会话说话」是**工具层已经存在的事实**。B 会在 wrapper 层再造一条通往同一个会话的路，
 *     两条路语义还不一样（工具那条会通知/唤醒、带上下文；wrapper 那条是硬塞一条 user 消息）。
 *     工作约定第 5 条「一切推导只在 base-logic 一份，不在第二处重算」的精神就是不造第二套。
 *  2. **误发的代价差一个数量级。** A 最坏情况是「模型没看懂这串引用」—— 消息仍落在你正在看的会话里，
 *     模型可以当场 `session_read` / `send` 补救，人全程看得见。B 一旦选错/名字撞了，句子会被**静默塞进
 *     另一个会话的对话**里，两边都在跑，人还未必立刻发现 —— 正是最该避免的「悄悄发错人」。
 *  3. **行中出现天然成立。** 「帮我问 @B 那件事有结论没」这句里，B 只是**对象**，句子本身是对**当前**会话说的。
 *     在 A 下它原样成立；在 B 下整句话会被发去 B，语义就错了。`@` 本来就常出现在句子中间。
 *  4. **「点谁跟谁说话」这条需求已经有一条更直接的路**：左栏点节点。composer 里的 `@` 不是「切收件人」的
 *     自然位置 —— 它更像「引用」。B 等于把左栏点击重做一遍，还多一层猜。
 *  （第三种可能是「@=路由 + 同时在当前会话留一条回执」，那既没有 A 的简单，也没有 B 的直接，不取。）
 *
 * ───────────────────────── token 格式：给人看名字，给机器完整 uuid ─────────────────────────
 *
 * 硬规矩（踩过的坑，名字叫「别把 id 片段当标识」）：界面 / 日志 / 提示词 / 工具返回值**一律给完整 uuid**，
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
 * 于是正文里出现的是 `@#<uuid>「名字」`，模型可以直接把 `<uuid>` 复制进 `send` 的 id 参数。
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
	const id = String(session?.id ?? session?.uuid ?? "").trim();
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
 *  · **排除 hiddenByArchive**（被归档祖先藏住的那支）：和左栏树保持一致 —— 别让人点到一个树上看不见的地方。
 *  · **包含**直接归档的会话（它们在存档箱里看得见；对它 send 会复活它）→ 排到最后并打「已存档」标签。
 *  · 当前会话保留（可以引用自己），打「当前」标签。
 *  · 顺序：沿用 /tree 给的顺序（= 左栏顺序），不另发明一套排序。
 */
export function candidates(nodes, q, { activeId = null } = {}) {
	const s = String(q ?? "")
		.replace(/^#/, "")
		.trim()
		.toLowerCase();
	const list = [];
	for (const n of nodes ?? []) {
		if (!n || n.hiddenByArchive) continue;
		if (s) {
			const name = String(n.name ?? "").toLowerCase();
			const id = String(n.id ?? "").toLowerCase();
			if (!name.includes(s) && !id.includes(s)) continue;
		}
		list.push({ ...n, label: n.name || n.id, current: n.id === activeId });
	}
	// 归档的沉底（分组感），组内保持 /tree 顺序。
	return [...list.filter((n) => !n.archived), ...list.filter((n) => n.archived)];
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
	// 只认**看得见的**会话：与 candidates 同一口径（被归档祖先藏住的那支既不在候选里，也不该被名字解析到）。
	const pool = (nodes ?? []).filter((n) => n && !n.hiddenByArchive);

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

const CSS = `
#mentions{max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:5px;background:var(--bg-elev);margin-bottom:5px}
#mentions[hidden]{display:none}
#mentions .cmd{display:flex;gap:8px;align-items:baseline;padding:4px 10px;cursor:pointer;min-width:0}
#mentions .cmd.sel{background:var(--bg-elev2);box-shadow:inset 2px 0 0 var(--accent)}
#mentions .cname{color:var(--accent);font-weight:600;flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mentions .csrc{flex:none;font-size:10px;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0 4px}
#mentions .csrc.arch{color:var(--warn);border-color:var(--warn)}
#mentions .cdesc{color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#mentions .cmdkeys,#mentions .cmdhint{padding:5px 10px;font-size:11px;color:var(--dim)}
`;

function injectStyles(doc) {
	if (!doc || doc.getElementById("mentions-style")) return;
	const s = doc.createElement("style");
	s.id = "mentions-style";
	s.textContent = CSS;
	(doc.head ?? doc.documentElement)?.append(s);
}

/** 一行的状态标签（最多几个，说明它对不对得上 / 要不要复活）。 */
function badgesOf(c) {
	const b = [];
	if (c.archived) b.push({ t: "已存档", cls: "arch" });
	if (c.current) b.push({ t: "当前", cls: "" });
	if (c.streaming) b.push({ t: "运行中", cls: "" });
	else if (c.unread) b.push({ t: "未读", cls: "" });
	if (!b.length) b.push({ t: "闲置", cls: "" });
	return b;
}

/**
 * 把选择器挂到真实 DOM 上，返回给 app.mjs 用的句柄。
 * app 侧只需要三处（详见本模块尾注 / commit message）：
 *   1. mount 一次；
 *   2. send() 里先 `const r = mentions.resolveForSend(text); if(!r.ok){ notice=r.error; return; }` 再用 `r.text`；
 *   3. 切会话时 `mentions.close()`。
 * input / keydown 监听本模块**自己挂**（keydown 挂在父元素**捕获阶段**，先于 app 的 input 监听器执行，
 * 面板开着时 stopPropagation 掉，避免和 `/` 面板抢键）——所以 app 不必改自己的 keydown。
 * `isBlocked()` 让位给 `/` 命令面板（它开着时 `@` 面板不开）。`onInsert` 用于插入后重算输入框高度。
 */
export function mountMentions({ input, getNodes, getActiveId, isBlocked, onInsert, doc = document } = {}) {
	if (!input) throw new Error("mountMentions: 需要 input 元素（#input）");
	injectStyles(doc);
	const box = doc.createElement("div");
	box.id = "mentions";
	box.hidden = true;
	input.parentElement?.insertBefore(box, input);

	const state = createMentionState({ getNodes, getActiveId, isBlocked });

	const render = () => {
		box.hidden = !state.open;
		box.replaceChildren();
		if (!state.open) return;
		const el = (tag, cls, text) => {
			const n = doc.createElement(tag);
			if (cls) n.className = cls;
			if (text != null) n.textContent = text;
			return n;
		};
		if (!state.items.length) {
			const hint = el("div", "cmdhint", state.query ? `没有匹配「${state.query.replace(/^#/, "")}」的会话。` : "还没有别的会话。");
			box.append(hint);
		} else {
			state.items.forEach((c, i) => {
				const row = el("div", `cmd${i === state.index ? " sel" : ""}`);
				row.title = `${c.name ?? "（无标题）"}\n${c.id}${c.cwd ? `\n${c.cwd}` : ""}${c.archived ? "\n（已存档 —— 发消息就会复活）" : ""}`;
				row.append(el("span", "cname", c.label));
				for (const b of badgesOf(c)) row.append(el("span", `csrc${b.cls ? ` ${b.cls}` : ""}`, b.t));
				row.append(el("span", "cdesc", c.id)); // 完整 uuid：候选里也不给片段
				row.addEventListener("mousedown", (e) => {
					e.preventDefault(); // 别让输入框先失焦
					state.selectIndex(i);
					commit();
				});
				box.append(row);
			});
		}
		box.append(el("div", "cmdkeys", "↑↓ 选择 · Tab/Enter 插入 · Esc 关闭"));
		box.querySelector(".cmd.sel")?.scrollIntoView({ block: "nearest" });
	};

	const commit = () => {
		const r = state.commit(input.value, input.selectionStart ?? input.value.length);
		if (!r) return;
		input.value = r.text;
		try {
			input.setSelectionRange(r.cursor, r.cursor);
		} catch {
			/* 非 textarea 也别炸 */
		}
		render();
		onInsert?.(r);
	};

	const onInput = () => {
		state.sync(input.value, input.selectionStart ?? input.value.length);
		render();
	};
	input.addEventListener("input", onInput);

	// keydown 挂在父元素**捕获阶段**：先于 app 挂在自己 input 上的监听器跑，面板开着就接管这些键。
	const keyHost = input.parentElement ?? doc;
	const onKey = (e) => {
		if (e.target !== input || !state.open) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			e.stopPropagation();
			state.move(e.key === "ArrowDown" ? 1 : -1);
			render();
			return;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey)) {
			if (state.items.length) {
				e.preventDefault();
				e.stopPropagation();
				commit();
			}
			// 没候选：Tab 什么也不做；Enter 落到下面当普通消息发（跟 / 面板一致）
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			state.dismiss(input.value);
			render();
		}
	};
	keyHost.addEventListener("keydown", onKey, true);

	return {
		state,
		box,
		isOpen: () => state.open,
		/** 输入 / 光标外力变了（例如程序改过 value）后手动同步一次。 */
		sync: onInput,
		close: () => {
			state.close();
			render();
		},
		/** send() 用：把草稿规范化成给模型看的那份（并拦下歧义 / 片段 / 找不到的提及）。 */
		resolveForSend: (text) => resolveDraft(text, getNodes()),
		destroy: () => {
			input.removeEventListener("input", onInput);
			keyHost.removeEventListener("keydown", onKey, true);
			box.remove();
		},
	};
}
