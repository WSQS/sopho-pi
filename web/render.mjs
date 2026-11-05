/**
 * 正文渲染 —— 从 app.mjs 抽出来，方便单独测。
 * 规矩：只用 DOM API + textContent，绝不 innerHTML（内容来自模型，不能当代码执行）。
 */

export const el = (tag, props = {}, ...kids) => {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === null || v === undefined) continue;
		if (k === "class") n.className = v;
		else if (k === "text") n.textContent = v;
		else if (k === "style") n.setAttribute("style", v);
		else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const kid of kids) if (kid) n.append(kid);
	return n;
};

const frag = (...kids) => {
	const f = document.createDocumentFragment();
	for (const k of kids) if (k) f.append(k);
	return f;
};

// ─────────────────── 极简 markdown（够看，不求全） ───────────────────

/** 行内：行内代码 / 粗体 / 链接 / 斜体。返回 DocumentFragment。 */
export function inline(s) {
	const out = document.createDocumentFragment();
	const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\n]+\*)/g;
	let last = 0;
	let m;
	while ((m = re.exec(s))) {
		if (m.index > last) out.append(s.slice(last, m.index));
		const t = m[0];
		if (t[0] === "`") out.append(el("code", { text: t.slice(1, -1) }));
		else if (t.startsWith("**")) out.append(el("b", { text: t.slice(2, -2) }));
		else if (t[0] === "[") {
			const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t);
			out.append(el("a", { href: mm[2], target: "_blank", rel: "noreferrer", text: mm[1] }));
		} else out.append(el("em", { text: t.slice(1, -1) }));
		last = m.index + t.length;
	}
	if (last < s.length) out.append(s.slice(last));
	return out;
}

const isBlock = (l) => /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s)/.test(l);

/**
 * 块级：代码围栏 / 标题 / 列表 / 引用 / 段落。
 * 段落内部原样保留换行（.p 是 pre-wrap），空行 = 段间距。
 */
export function md(text) {
	const root = document.createDocumentFragment();
	const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith("```")) {
			const buf = [];
			for (i++; i < lines.length && !lines[i].startsWith("```"); i++) buf.push(lines[i]);
			i++;
			root.append(el("pre", { class: "code" }, el("code", { text: buf.join("\n") })));
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			root.append(el("div", { class: `h h${h[1].length}` }, inline(h[2])));
			i++;
			continue;
		}
		const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
		if (li) {
			root.append(
				el(
					"div",
					{ class: "li" },
					el("span", { class: "bullet", text: /^\d/.test(li[1]) ? li[1] : "•" }),
					el("span", { class: "litext" }, inline(li[2])),
				),
			);
			i++;
			continue;
		}
		const q = /^>\s?(.*)$/.exec(line);
		if (q) {
			root.append(el("div", { class: "quote" }, inline(q[1])));
			i++;
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		// 连续非空、非块级行 = 一个段落，内部换行原样保留
		const buf = [line];
		for (i++; i < lines.length && lines[i].trim() && !isBlock(lines[i]); i++) buf.push(lines[i]);
		root.append(el("div", { class: "p" }, inline(buf.join("\n"))));
	}
	return root;
}

// ─────────────────── 消息碎片 ───────────────────

/** 工具调用一行摘要 */
export function argSummary(args) {
	if (!args || typeof args !== "object") return "";
	if (typeof args.command === "string") return args.command.split("\n")[0].slice(0, 200);
	const p = args.path ?? args.filePath ?? args.file ?? args.pattern ?? args.query ?? args.id;
	if (typeof p === "string") return p;
	const s = JSON.stringify(args);
	return !s || s === "{}" ? "" : s.slice(0, 200);
}

/** 思考：内联展开、直接可见 —— 不再是一条要点开才看得到的折叠条。
 *  视觉从属交给 CSS（.think：暗色斜体 + 左侧细边），这里只管内容。
 *  plain=true 是流式直播块：每个 delta 都重建，绝不能跑 markdown（会越跑越卡）。 */
export function thinkingEl(text, plain = false) {
	return el("div", { class: "think" }, plain ? text : md(text));
}

export function toolEl(p) {
	const err = p.isError || p.error;
	const box = el("div", { class: `tool${err ? " bad" : ""}` });
	box.append(
		el(
			"div",
			{ class: "tcall" },
			el("span", { class: "tname", text: p.name }),
			el("span", { class: "targs", text: argSummary(p.args) }),
		),
	);
	const res = String(p.result ?? "").trim();
	if (p.running) box.append(el("div", { class: "tres dim", text: "⎿ 运行中…" }));
	else if (res) {
		const all = res.split("\n");
		const shown = all.slice(0, 6).join("\n");
		box.append(
			el("div", { class: "tres" }, el("span", { class: "tresbody", text: all.length > 6 ? `${shown}\n…（共 ${all.length} 行）` : shown })),
		);
	}
	return box;
}

/**
 * parts → DOM。
 * plain=true 用于「正在跑」的直播块：文字不跑 markdown，直接纯文本。
 * 因为流式每个 delta 都会重建这一块，而 markdown 是 O(整段长度)，长回答会越跑越卡。
 */
export function partsEl(role, parts, { cls = "", plain = false } = {}) {
	const wrap = el("div", { class: `msg ${role}${cls ? ` ${cls}` : ""}` });
	for (const p of parts ?? []) {
		if (p.type === "thinking") wrap.append(thinkingEl(p.text, plain));
		else if (p.type === "text") wrap.append(el("div", { class: "body" }, plain ? p.text : md(p.text)));
		else if (p.type === "tool") wrap.append(toolEl(p));
	}
	return wrap;
}

export function userEl(text) {
	return el(
		"div",
		{ class: "msg user" },
		el("div", { class: "body" }, el("span", { class: "prompt", text: "你 › " }), el("span", { text })),
	);
}
