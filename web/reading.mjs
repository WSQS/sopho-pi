/**
 * 阅读页前端（`web/reading.html`）。
 *
 * ── 它**不是**聊天的另一面 ────────────────────────────────────────────────
 * 这一屏 = **页面的渲染 + 一个发送按钮**。刻意**不做聊天面板** —— 人类要的是
 * 「对话**不再是主体**」：过程与机器事实住这里那个**默认收起的调试面板**，
 * 而不是再造一个只会把页面压下去的对话流。
 *
 * ── 一次动作 = 一个按钮：保存 + 把它交给 agent（人类定的语义）───────────────
 * 按下去 = `POST /api/pages/press`：
 *   ① 服务端**先落盘**（走 `/pages` 那条落盘路，要么全写要么一个字节不写）；
 *   ② **再投递**给这一页绑的会话（走已有的发消息路）。
 * 任何一步失败都由**服务端如实回**（502 = 「字存了但没发出去」），这里只如实显示 ——
 * 绝不在这层把失败粉饰成成功。
 *
 * ── 谁写什么（与协议一致）──────────────────────────────────────────────
 * 这一页里**可编辑的只有两样**：`A:` 答案、读者段落（笔记）。其余（原文 / 问题 /
 * 助手块 / 字段 / 注释）一律只读。每一次提交都带**那一块的指纹**，服务端会重读复核 ——
 * 所以你读完之后别人又改了它，这次提交会被**拒绝**而不是覆盖。
 */
const $ = (s) => document.querySelector(s);
const api = (p, init) => fetch(`/api${p}`, init);

let state = {
	rel: null,
	page: null, // GET /pages?path= 的响应
	/** 有改动的块：`"s..e"` → `{range, text, fileText, expectedFingerprint, keepPrefix, kind?, draft?}`。
	 *  `fileText` = **文件里那一块的原文**，用来在重读之后把这一处改动**重新挂回它原来那一块**
	 *  （也是草稿在 localStorage 里的**锚点**，见下面 `readDrafts`）。
	 *  `draft:true` = 这一份是**上次没发送的草稿**（从 localStorage 恢复回来的），不是文件里的内容。 */
	dirty: new Map(),
	/** 认不回**原来那一块**的草稿：`"draft:<原文>"` → 那份草稿（内容原样留着，绝不静默丢）。 */
	orphanDrafts: new Map(),
	/** 每块的发送状态：`"s..e"` → `{status: "sending"|"queued"|"sent"|"failed", message, at}` */
	block: new Map(),
	/** 每块的 DOM 句柄（要就地更新那一块的按钮/回执，**不能整页重画** —— 那会把光标弄丢）。 */
	nodes: new Map(),
	/** 正在发的块 key（串行：一次只发一块）+ 排队等着的。 */
	sending: null,
	queue: [],
	busy: false,
	/** 每一次 `open()` 的世代号 —— 只有**最后开始的那一次**才有权落地。
	 *  为什么要它：一次写入（发送）会同时触发两条重读（自己的 `reloadKeepingScroll` + A 广播的
	 *  `{t:page}`）；先开始那条的快照是**发送之前**拍的，它晚回来就会把已经发出去的草稿**又挂回来**
	 *  （真 A／真浏览器实测踩到：发送成功后 localStorage 里那份草稿复活成“认不回原位”的草稿）。 */
	openSeq: 0,
	last: null, // 上次 press/preview 的 { status, body, at }
	notice: null,
};

const keyOf = (range) => `${range[0]}..${range[1]}`;
const rangeOf = (key) => key.split("..").map(Number);
const EDITABLE = new Set(["answer", "reader"]);
const bodyTextOf = (item) => (item.kind === "answer" ? askText(item).body : (item.text ?? ""));

// ── 草稿（未发送的改动）的持久化 ──────────────────────────────────────────
//
// 人类在自己的方向书里把这一条列为**当前唯一的功能缺口**（内部方向书里的原话：
// 「未发送的改动刷新之后不保存，切换会话之后回来也不保存」）—— 草稿原先只在内存的
// `state.dirty` 里，`open()` 一清就没了。
//
// 判据与 `rebaseMaps()` 是**同一套**：每份草稿的锚点是**那一块在文件里的原文**
// （`fileText`）—— 行号 / range 会因为别人在前面插几行而整体平移，拿它认块一定会认错。
// 键里含**页面相对路径**（一页一份账，别的页面不会把这一页的草稿顶掉）。
//
// 三条清理规则（缺一条就会积垃圾或者骗人）：
//   · 那一块**真的发送成功**（服务端 `saved.applied` 里点名写了它）⇒ 清掉这份草稿；
//   · 用户把内容**改回与文件一致**（`input` 里 `now === 文件里那一块的正文`）⇒ 清掉；
//   · 一条都没匹配上（认不回原来那一块）⇒ **不静默丢**：摊在页尾让人自己复制。
const LS_PREFIX = "sopho.reading.drafts.v1:";
const lsKey = (rel) => LS_PREFIX + rel;

/** 读这一页的草稿。存坏了 / 不许用 localStorage（隐私模式）⇒ 当成没有草稿，**不崩**。 */
function readDrafts(rel) {
	try {
		const raw = localStorage.getItem(lsKey(rel));
		if (!raw) return [];
		const list = JSON.parse(raw)?.drafts;
		if (!Array.isArray(list)) return [];
		return list.filter((d) => d && typeof d.text === "string" && typeof d.fileText === "string");
	} catch {
		return [];
	}
}

/** 写这一页的草稿（空 = 把这条键删掉，别留一堆空账）。 */
function writeDrafts(rel, drafts) {
	try {
		if (!drafts.length) localStorage.removeItem(lsKey(rel));
		else localStorage.setItem(lsKey(rel), JSON.stringify({ v: 1, at: Date.now(), drafts }));
	} catch {
		/* 存不下也不该影响编辑（配额满 / 隐私模式）—— 内存里那份照旧能用 */
	}
}

/** 把**内存里**的未发送改动落成这一页的草稿。每次改动、每次清理都调一次 ——
 *  这样刷新 / 切页 / 关标签页之后都还认得回来（不指望 `beforeunload` 那一下）。 */
function persistDrafts() {
	if (!state.rel || !state.page) return;
	const drafts = [...state.dirty.values()].map((d) => ({
		fileText: d.fileText,
		text: d.text,
		keepPrefix: !!d.keepPrefix,
		kind: d.kind ?? null,
		range: Array.isArray(d.range) ? d.range : null, // 只是给人看的提示（认回原位靠 fileText）
		at: Date.now(),
	}));
	// 认不回原位的那些也必须**留账**（否则下一次读这一页它就凭空不见了 = 静默丢）
	for (const o of state.orphanDrafts.values()) drafts.push({ fileText: o.fileText, text: o.text, keepPrefix: !!o.keepPrefix, kind: o.kind ?? null, range: o.range ?? null, at: o.at ?? Date.now() });
	writeDrafts(state.rel, drafts);
}

/** 打开一页时把草稿放回**对应块**（锚点 = 那一块在文件里的原文）；认不回来的进 `orphanDrafts`。
 *  ⚠️ 恢复只**放回输入框**、把这一块标成「上次没发送的草稿」—— **绝不自动发送**。 */
function restoreDrafts() {
	const byFileText = new Map();
	for (const b of state.page?.blocks ?? []) if (EDITABLE.has(b.kind)) byFileText.set(b.text ?? "", b);
	for (const dr of readDrafts(state.rel)) {
		// 内存里已经有一份（同一次会话里刚写的 / rebase 刚挂回来的）⇒ 以它为准，别拿旧的覆盖
		if ([...state.dirty.values()].some((d) => d.fileText === dr.fileText)) continue;
		const hit = byFileText.get(dr.fileText);
		if (!hit) {
			state.orphanDrafts.set(`draft:${dr.fileText}`, dr);
			continue;
		}
		// 与文件一致 ⇒ 本来就不算改动（顺手把它从账上清掉，别挂一个空的「未发送」在上面）
		if (dr.text === bodyTextOf(hit)) continue;
		state.dirty.set(keyOf(hit.range), {
			range: hit.range,
			text: dr.text,
			fileText: dr.fileText,
			expectedFingerprint: hit.fingerprint,
			keepPrefix: !!dr.keepPrefix,
			kind: hit.kind,
			draft: true,
			draftAt: dr.at ?? null,
		});
	}
}

/** 服务端确认**写进去了**的那几块（`saved.applied` 里点名了它们的 range）⇒ 它们那份草稿才算
 *  「真的发送成功」，清掉（内存 + localStorage 一起）。没被点名的一律不动。 */
function clearSentDrafts(applied) {
	for (const a of applied ?? []) {
		if (!Array.isArray(a?.range)) continue;
		state.dirty.delete(keyOf(a.range));
	}
	persistDrafts();
}

/** 发送之后，把那一块的回执（已发送 ✓ / 发送失败）按**服务端写进去的那段字**钉回重读后的那一块。
 *  为什么需要：重读之后那一块在文件里的原文**已经变了**（就是刚写进去的那段字本身），
 *  按旧原文认不回来 ⇒ 回执会掉。但服务端回的 `applied[].text` 就是新原文，拿它对得上。
 *  ⚠️ `status` 由调用方按服务端真话给（存住了但没发出去 = failed）—— 这里只负责“挂到哪一块”。 */
function pinReceipts(applied, { status = "sent", message = "" } = {}) {
	for (const a of applied ?? []) {
		const want = String(a?.text ?? "");
		if (!want) continue; // 把一块清空也合法，但空字对不上具体哪一块 ⇒ 不猜
		const hit = (state.page?.blocks ?? []).find((b) => EDITABLE.has(b.kind) && bodyTextOf(b) === want);
		if (!hit) continue;
		const k = keyOf(hit.range);
		state.block.set(k, { status, message, at: Date.now() });
		renderBlockTools(k); // 就地刷那一块的回执（不整页重画）
	}
}

// ── 渲染 ────────────────────────────────────────────────────────────────

const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text; // **一律 textContent**：页面里就算有 HTML 也只当字看
	return n;
};

const shortFp = (fp) => String(fp ?? "").replace(/^sha256:/, "").slice(0, 12);

function metaEl() {
	const box = $("#rpMeta");
	box.replaceChildren();
	if (!state.page) return;
	const add = (k, v) => {
		const line = el("div");
		line.append(el("span", "k", `${k}：`), el("b", null, v));
		box.append(line);
	};
	add("路径", state.page.path);
	add("整页指纹", shortFp(state.page.pageFingerprint));
	add("块", `${state.page.blocks.length}（${Object.entries(state.page.stats?.byKind ?? {}).map(([k, v]) => `${k}×${v}`).join(" · ")}）`);
	const b = state.page.binding;
	add("绑定的会话", b?.sessionId ? `${b.sessionId.slice(0, 8)}…（${b.boundBy}）` : "（还没有 —— 第一次按会建一条）");
	if (state.page.errors?.length) add("解析错误", state.page.errors.map((e) => e.code).join(","));
}

function askText(item) {
	// `A: xxx` → { prefix:"A:", body:"xxx" }；空答案 → { prefix:"A:", body:"" }
	const m = /^(A\s*[:：])\s*([\s\S]*)$/.exec(item.text ?? "");
	if (!m) return { prefix: "A:", body: "" };
	return { prefix: m[1], body: m[2] };
}

function wireEditable(node, item, { keepPrefix }) {
	const key = keyOf(item.range);
	const original = bodyTextOf(item);
	// 重读之后这一块又出现了 ⇒ 沿用之前那一处的改动（text 从脏集合里来），而不是文件里的旧字
	const carried = state.dirty.get(key);
	// 从 localStorage 恢复回来的草稿也在脏集合里，走的是同一条 —— 这里只把它放回输入框
	if (carried) node.value = carried.text;
	node.addEventListener("input", () => {
		const now = node.value;
		// 改回与文件一致 ⇒ 这一份草稿**清掉**（连 localStorage 里那份一起）
		if (now === original) state.dirty.delete(key);
		else state.dirty.set(key, { range: item.range, text: now, fileText: item.text ?? "", expectedFingerprint: item.fingerprint, keepPrefix, kind: item.kind });
		persistDrafts();
		renderBlockTools(key);
		renderPress();
	});
	// **键盘等价**：框内 Ctrl/Cmd+Enter = 按这一块自己的发送按钮（人类要求"按一下 = 发送，键盘上也要等价"）
	node.addEventListener("keydown", (ev) => {
		if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
			ev.preventDefault();
			void pressBlock(key);
		}
	});
	return key;
}

function renderBody() {
	const box = $("#rpBody");
	box.replaceChildren();
	const page = state.page;
	if (!page) {
		box.append(el("p", "hint", "左边选一个页面（现场）"));
		return;
	}
	if (!page.blocks.length) {
		box.append(el("p", "hint", "这一页没有可显示的块"));
		return;
	}
	const stamp = (node, item) => {
		// 每一块都带上"我是哪一块"（行区间 + 类型）：**回流后按它恢复滚动位置**，测试也用它定位。
		node.dataset.range = `${item.range[0]}-${item.range[1]}`;
		node.dataset.kind = item.kind;
		return node;
	};
	for (const item of page.blocks) {
		if (item.kind === "heading") {
			box.append(stamp(el(`h${Math.min(6, Math.max(2, item.level))}`, "rp-h rp-blk", item.text), item));
		} else if (item.kind === "source") {
			const wrap = el("div", "rp-blk");
			const tag = el("span", "rp-srctag", `⟪原文 ${item.srcId.split("!").pop()}${item.markerAttrs?.stripped ? ` · 剥掉 ${item.markerAttrs.stripped}` : ""}⟫`);
			wrap.append(tag, el("div", "rp-src", item.text));
			box.append(stamp(wrap, item));
		} else if (item.kind === "question") {
			box.append(stamp(el("p", "rp-q rp-blk", item.text), item));
		} else if (item.kind === "answer" || item.kind === "reader") {
			box.append(stamp(editableBlock(item), item));
		} else if (item.kind === "assistant") {
			const wrap = el("div", "rp-asst rp-blk");
			if (item.dataKind) wrap.append(el("span", "rp-assttag", `助手${item.dataKind}`));
			wrap.append(el("div", null, item.text));
			box.append(stamp(wrap, item));
		} else if (item.kind === "field") {
			const wrap = el("div", "rp-field rp-blk");
			wrap.append(el("span", "rp-fieldtag", `${item.name}${item.writable ? "（助手字段·只读）" : "（只读）"}\n`));
			wrap.append(el("div", null, item.text));
			box.append(stamp(wrap, item));
		} else if (item.kind === "comment") {
			const d = el("details", "rp-cmt rp-blk");
			d.append(el("summary", null, `设计理由（注释 ${item.range[0] + 1}-${item.range[1] + 1} 行）`), el("pre", null, item.raw));
			box.append(stamp(d, item));
		} else if (item.kind === "divider") {
			box.append(stamp(el("hr", "rp-hr"), item));
		}
	}
	// 重读之后**认不回原来那一块**的改动：不静默吞，摊在页尾让人自己复制（发送会被服务端拒绝，也如实显示）
	const orphans = [...state.dirty.keys()].filter((k) => !state.nodes.has(k));
	if (orphans.length) {
		const sec = el("div", "rp-orphans rp-blk");
		sec.append(el("div", "rp-orphanhead", `⚠ 下面 ${orphans.length} 处是你写的、但重读后**定位不到原来那一块**了（它被并掉/改掉了）—— 内容给你留在下面，请自己复制：`));
		for (const k of orphans) {
			const d = state.dirty.get(k);
			const ta = el("textarea", "rp-note rp-orphan");
			ta.value = d.text;
			ta.readOnly = true;
			ta.dataset.orphan = k;
			sec.append(el("div", "rp-orphantag", `原来在第 ${d.range[0] + 1}-${d.range[1] + 1} 行`), ta);
			state.nodes.set(k, { wrap: sec, chip: el("span"), btn: el("button"), tag: el("span") }); // 让那一块的状态有地方挂
		}
		box.append(sec);
	}
	// ② **上次留下的草稿认不回原来那一块**（那一块在文件里被改掉 / 没了）——
	//    同样不静默丢：摊在页尾、明说它认不回原位，让人自己复制（它不会自动发出去）。
	if (state.orphanDrafts.size) {
		const sec = el("div", "rp-orphans rp-draftorphans rp-blk");
		sec.append(el("div", "rp-orphanhead", `⚠ 下面 ${state.orphanDrafts.size} 处是**上次没发送的草稿**，但读这一页时**认不回原来那一块**了（那一块在文件里被改掉 / 没了）—— 内容给你留在下面，请自己复制：`));
		for (const [k, o] of state.orphanDrafts) {
			const head = el("div", "rp-orphanrow");
			head.append(el("span", "rp-orphantag", o.range ? `上次在第 ${o.range[0] + 1}-${o.range[1] + 1} 行` : "（位置未知）"));
			if (o.at) head.append(el("span", "rp-orphantag", ` · 存于 ${new Date(o.at).toLocaleString()}`));
			const drop = el("button", "mini rp-dismiss", "丢掉这一份草稿");
			drop.type = "button";
			drop.title = "确认这份草稿你不要了 —— 只是从草稿账上清掉，**不改文件**";
			drop.addEventListener("click", () => {
				state.orphanDrafts.delete(k);
				persistDrafts();
				render();
			});
			head.append(drop);
			const ta = el("textarea", "rp-note rp-orphan");
			ta.value = o.text;
			ta.readOnly = true;
			ta.dataset.draftOrphan = k;
			sec.append(head, ta);
		}
		box.append(sec);
	}
}

/** 一个可编辑块：输入框 + **贴着它的**发送按钮 + 那一块自己的状态回执。
 *  （人类原话：「我觉得应该**所有输入框都提供一个发送按钮**，而不是只在页面底部提供一个按钮」） */
function editableBlock(item) {
	const isAnswer = item.kind === "answer";
	const key = keyOf(item.range);
	const wrap = el("div", "rp-edit rp-blk");
	const ta = el("textarea", isAnswer ? "rp-a" : "rp-note");
	if (isAnswer) {
		ta.rows = 2;
		ta.placeholder = "在这里写你的回答……";
	} else {
		ta.rows = Math.min(10, Math.max(1, (item.text ?? "").split("\n").length));
		ta.placeholder = "笔记……";
	}
	ta.value = isAnswer ? askText(item).body : (item.text ?? "");
	ta.dataset.range = `${item.range[0]}-${item.range[1]}`;
	wireEditable(ta, item, { keepPrefix: isAnswer });

	// 这一块的字**不是文件里的内容**时如实标出来（人类点名：别让人以为它是已保存的）。
	// ⚠️ 它放在**已有的工具行**里（那个行高本来就由按钮决定）—— 这样“草稿标记消失/出现”
	//    不会改变这一块的高度，也就不会把**下面**的滚动位置推一下（发送后 scrollTop 差 0）。
	const tag = el("span", "rp-drafttag", "⚠ 上次没发送的草稿（还没存进文件）");
	tag.hidden = true;
	tag.dataset.for = key;
	tag.title = "这是上次没发送的草稿 —— 从本地存下来的，**不在文件里**；发送这一块才会写进去";

	const tools = el("div", "rp-tools");
	const chip = el("span", "rp-chip");
	chip.dataset.state = "clean";
	chip.dataset.for = key;
	const btn = el("button", "mini rp-send");
	btn.type = "button";
	btn.dataset.for = key;
	btn.textContent = "发送这一块";
	btn.title = "只把**这一块**存盘并交给这个页面的会话（Ctrl/Cmd+Enter 同效）";
	btn.addEventListener("click", () => void pressBlock(key));
	tools.append(tag, chip, btn);
	wrap.append(ta, tools);
	state.nodes.set(key, { wrap, chip, btn, tag });
	renderBlockTools(key); // 按**当前**状态刷一次（重读之后恢复的改动也要显示「有改动未发送」）
	return wrap;
}

/** 就地把**这一块**的按钮/回执刷新一遍（不整页重画 —— 那会把光标和滚动都弄丢）。 */
function renderBlockTools(key) {
	const n = state.nodes.get(key);
	if (!n) return;
	const d = state.dirty.get(key);
	const st = state.block.get(key);
	const why = d ? blockingReasonFor(d) : null;
	n.btn.disabled = !d || !!why || ["sending", "queued"].includes(st?.status ?? "");
	n.btn.textContent = st?.status === "sending" ? "发送中…" : st?.status === "queued" ? "排队中…" : "发送这一块";
	n.wrap.classList.toggle("rp-dirty", !!d);      // 未保存改动：左边一条细色条（人类要的"看得见"）
	n.wrap.classList.toggle("rp-busy", ["sending", "queued"].includes(st?.status ?? ""));
	n.wrap.classList.toggle("rp-failed", st?.status === "failed");
	n.wrap.classList.toggle("rp-sent", st?.status === "sent" && !d);
	n.wrap.classList.toggle("rp-blocked", !!why);
	n.wrap.classList.toggle("rp-draft", !!d?.draft); // 这一块里是**上次没发送的草稿**
	n.tag.hidden = !d?.draft;
	n.chip.textContent =
		st?.status === "sending" ? "发送中…"
		: st?.status === "queued" ? "排队中…"
		: st?.status === "failed" ? `发送失败：${st.message ?? ""}`
		: d ? "有改动未发送"
		: st?.status === "sent" ? "已发送 ✓"
		: "";
	n.chip.dataset.state = st?.status ?? (d ? "dirty" : "clean");
}

/** 这一块自己有没有"发不出去"的毛病（目前只有一条：块里出现空行 ⇒ 会把一块劈成两块）。 */
function blockingReasonFor(d) {
	return /\n[ \t]*\n/.test(d.text) ? "块里不能有空行" : null;
}

function blockingReason() {
	for (const [key, d] of state.dirty) {
		if (/\n[ \t]*\n/.test(d.text)) return `有一个块里有空行（第 ${d.range[0] + 1} 行那块）—— 一个块里不能有空行`;
	}
	return null;
}

function renderPress() {
	const btn = $("#press");
	const reason = blockingReason();
	const n = state.dirty.size;
	// 主路是**每块自己的按钮**；底部这个只在"确实有多处未发送"时可用 ——
	// 免得它跟按块发送的语义含混（人类点名的第 5 条）。
	btn.disabled = state.busy || n < 2 || !!reason || !state.page;
	btn.textContent = n >= 2 ? `发送全部（${n} 块）` : "发送全部未发送的改动";
	$("#rpHint").textContent = state.busy
		? "正在保存并投递……"
		: reason
			? reason
			: n >= 2
				? `有 ${n} 块没发送 —— 一次性交出去（也可以各自用自己那个按钮）`
				: n === 1
					? "只有 1 块有改动 —— 用它自己那个「发送这一块」就行"
					: "改哪一块，就按那一块自己的「发送这一块」（Ctrl/Cmd+Enter 同效）";
	$("#rpNotice").hidden = !state.notice;
	if (state.notice) $("#rpNotice").textContent = state.notice;
}

function renderDebug() {
	const box = $("#rpDebugBody");
	box.replaceChildren();
	const kv = (k, v) => {
		const line = el("div");
		line.append(el("span", "k", `${k}：`), el("span", "v", String(v)));
		box.append(line);
	};
	kv("页面", state.rel ?? "（未选）");
	kv("整页指纹", state.page?.pageFingerprint ?? "—");
	kv("绝对路径", state.page?.abs ?? "—");
	kv("根", state.page?.root ?? "—");
	kv("待发", state.dirty.size ? `${state.dirty.size} 处改动` : "（没有改动）");
	for (const [, d] of state.dirty) kv(`  · 第 ${d.range[0] + 1} 行${d.draft ? "（上次的草稿）" : ""}`, JSON.stringify(d.text.slice(0, 60)));
	kv("草稿（localStorage）", `${state.dirty.size} 份挂在块上${state.orphanDrafts.size ? ` · ${state.orphanDrafts.size} 份认不回原位（见页尾）` : ""}`);
	const preview = el("button", "mini");
	preview.id = "rpPreview";
	preview.textContent = "预览要发给 agent 的字（dryRun）";
	preview.disabled = state.busy || !state.page;
	preview.addEventListener("click", () => void press({ dryRun: true }));
	box.append(preview);
	kv("上次调用", state.last ? `HTTP ${state.last.status} @ ${new Date(state.last.at).toLocaleTimeString()}` : "（还没调过）");
	if (state.last) {
		const pre = el("pre", null, JSON.stringify(state.last.body, null, 1));
		pre.style.maxHeight = "26vh";
		pre.style.overflow = "auto";
		box.append(pre);
	}
}

function render() {
	metaEl();
	renderBody();
	renderPress();
	renderDebug();
}

// ── 数据 ────────────────────────────────────────────────────────────────

async function loadList() {
	const r = await api("/pages");
	const j = await r.json();
	if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
	state.root = j.root;
	const sel = $("#rpList");
	sel.replaceChildren();
	if (!j.pages.length) {
		const o = el("option", null, "（根下没有 .md）");
		o.disabled = true;
		sel.append(o);
		return j;
	}
	for (const p of j.pages) {
		const o = el("option", null, `${p.path}${p.binding?.sessionId ? " ●" : ""}`);
		o.value = p.path;
		sel.append(o);
	}
	if (state.rel) sel.value = state.rel;
	return j;
}

/**
 * 重读这一页，但**不许把读者的位置弄丢**。
 *
 * 为什么专门做：回流（工具写回 → SSE 推 → 这里重读）如果直接把 DOM 换掉，
 * `#rpBody.scrollTop` 会被重置成 0 —— 人正在读第三章，agent 在第八章插了一条追问，
 * 屏幕却跳回开头。所以：**先记住"视口顶部那一块是谁、它偏了多少"，重画完再按它把位置摆回去**；
 * 那一块要是没了（被删/被并），退回到原来的 scrollTop（夹在合法范围里）。
 */
async function reloadKeepingScroll({ reason } = {}) {
	if (!state.rel) return;
	const keep = state.notice;
	const list = $("#rpList").value;
	// **有没发送的改动也照样重读**，但那些改动会被 `rebase` 重新挂回它原来那一块
	// （所以"你正在写的字"不会丢）；认不回来的会在页尾摊出来 + 明确报。
	const { lost } = await open(state.rel, { keepNotice: true, rebase: true });
	$("#rpList").value = list;
	state.notice = keep ?? (lost ? `页面已更新（${reason ?? "别处"}）—— 但有一处改动定位不到了（见页尾）。` : `页面已更新（${reason ?? "别处"}）—— 你的阅读位置保持在原处。`);
	renderPress();
}

/**
 * 把"每块的改动 + 每块的发送状态"从旧页面**重新挂回新页面**上。
 *
 * 为什么需要：发送一块之后要重读（指纹变了），但**别处还有没发送的字** ——
 * 直接清掉就是把读者正在写的东西吞了。判据用的是**那一块在文件里的原文**（`fileText`）：
 * 它在两边都稳定，而**行区间会因为别人在前面插了几行而整体平移**。
 * 认不回来的（那一块被工具并掉/删掉了）**不清掉、不静默丢**：留在脏集合里标成"定位不到"，
 * 并在页尾把内容原样摊出来让人自己复制（发送会被服务端拒绝 —— 那也如实显示）。
 */
function rebaseMaps(snapshot) {
	const byFileText = new Map();
	for (const b of state.page?.blocks ?? []) if (EDITABLE.has(b.kind)) byFileText.set(b.text ?? "", b);
	const lost = [];
	state.dirty.clear();
	state.block.clear();
	state.nodes.clear();
	for (const s of snapshot) {
		const hit = byFileText.get(s.fileText);
		if (!hit) {
			if (s.dirty) state.dirty.set(s.key, s.dirty);
			if (s.block) state.block.set(s.key, s.block);
			lost.push(s);
			continue;
		}
		const nk = keyOf(hit.range);
		if (s.dirty) state.dirty.set(nk, { ...s.dirty, range: hit.range, expectedFingerprint: hit.fingerprint });
		if (s.block) state.block.set(nk, s.block);
	}
	return lost;
}

function snapshotMaps() {
	const keys = new Set([...state.dirty.keys(), ...state.block.keys()]);
	return [...keys].map((k) => {
		const d = state.dirty.get(k) ?? null;
		const b = state.block.get(k) ?? null;
		return { key: k, fileText: d?.fileText ?? state.page?.blocks?.find((x) => keyOf(x.range) === k)?.text ?? "", dirty: d, block: b };
	});
}

async function open(rel, { keepNotice = false, rebase = false } = {}) {
	const seq = ++state.openSeq;
	const snap = rebase ? snapshotMaps() : null;
	const anchor = rebase ? scrollAnchor() : null;
	// **切页 / 切会话**（不带 rebase 的这一次）：先把手上的未发送改动落成草稿、把「读到哪儿了」记下来，再清内存 ——
	// 原先就是这一行 `clear()` 造成「切页 / 切会话就丢」，现在草稿在 localStorage 里等着被恢复。
	if (!rebase) {
		persistDrafts();
		saveScrollAnchor();
		state.dirty.clear();
		state.block.clear();
		state.nodes.clear();
	}
	state.rel = rel;
	state.orphanDrafts.clear();
	if (!keepNotice) state.notice = null;
	const r = await api(`/pages?path=${encodeURIComponent(rel)}`);
	const j = await r.json();
	// 有更新的一次 open 已经在跑 ⇒ 这一次的结果作废（否则会把旧快照 / 旧草稿又挂回去）
	if (seq !== state.openSeq) return { lost: 0, stale: true };
	if (!r.ok) {
		state.page = null;
		state.notice = `读不到这一页：${j.error ?? r.status}`;
		render();
		return;
	}
	state.page = j;
	$("#head").replaceChildren(el("span", "hint", rel));
	const lost = snap ? rebaseMaps(snap) : [];
	restoreDrafts(); // 草稿放回对应块（含「刷新之后」这一条）—— 只放回输入框，**绝不自动发送**
	persistDrafts(); // 认不回原位的那些也要留账（下一句 render 会把它们摊在页尾）
	render();
	if (lost.length) {
		state.notice = `⚠ 有 ${lost.length} 处你写的改动**在重读后定位不到了**（那一块被并掉/改掉了）—— 内容在页面末尾摊着，请自己复制。`;
		renderPress();
	}
	if (anchor) restoreScroll(anchor);
	// 真刷新（新文档、没有内存里的锚点）⇒ 按 sessionStorage 里那个锚点摆回去
	else restoreStoredScroll();
	return { lost: lost.length };
}

/** 记住"视口顶部那一块是谁、它偏了多少"（重画前）。 */
function scrollAnchor() {
	const box = $("#rpBody");
	const boxTop = box.getBoundingClientRect().top;
	const kids = [...box.children].map((n) => ({ key: n.dataset.range ?? null, top: n.getBoundingClientRect().top - boxTop }));
	return { box, scrollTop: box.scrollTop, anchor: kids.find((x) => x.key && x.top >= -2) ?? null };
}

/** 重画后按锚点把位置摆回去（那一块没了就退回原来的 scrollTop）。 */
function restoreScroll(a) {
	if (!a?.box) return;
	const boxTop = a.box.getBoundingClientRect().top;
	const after = new Map([...a.box.children].map((n) => [n.dataset.range ?? null, n.getBoundingClientRect().top - boxTop]));
	if (a.anchor && after.has(a.anchor.key)) a.box.scrollTop = a.scrollTop + (after.get(a.anchor.key) - a.anchor.top);
	else a.box.scrollTop = a.scrollTop;
}

// ── 「读到哪儿了」也要留住 ────────────────────────────────────────────────
// 上面那套锚点只在**同一次文档**里管用（`reloadKeepingScroll()`）。
// 而**真刷新**（重新加载这一页文档）时：`#rpBody` 是一个**内部滚动容器**，浏览器不会把它的
// scrollTop 还给我们（实测：刷前 1672 → 刷后 0，深页里那一块直接滑出视口）——
// 于是「刷新后块位置/滚动不放飞」这一条得自己存。存 sessionStorage（一个标签页一本账）：
// 刷新能留住，关掉标签页就随它去（不会把一个旧位置带给下一次浏览）。锚点判据与上面**同一条**。
const SS_PREFIX = "sopho.reading.scroll.v1:";

/** 把「视口顶部那一块是谁、偏了多少」按页面记下来（离开这一页之前调）。 */
function saveScrollAnchor(rel = state.rel) {
	if (!rel || !state.page || !$("#rpBody")) return;
	const a = scrollAnchor();
	try {
		sessionStorage.setItem(
			SS_PREFIX + rel,
			JSON.stringify({ range: a.anchor?.key ?? null, offset: a.anchor ? Math.round(a.anchor.top) : 0, scrollTop: Math.round(a.scrollTop), at: Date.now() }),
		);
	} catch {
		/* 存不下就算了：只影响「刷新之后回到原处」这一下 */
	}
}

/** 真刷新之后按同一个锚点把位置摆回去（那一块没了就退回记录里的 scrollTop）。 */
function restoreStoredScroll(rel = state.rel) {
	const box = $("#rpBody");
	if (!rel || !box) return;
	let j = null;
	try {
		j = JSON.parse(sessionStorage.getItem(SS_PREFIX + rel) ?? "null");
	} catch {
		j = null;
	}
	if (!j || typeof j.scrollTop !== "number") return;
	const boxTop = box.getBoundingClientRect().top;
	const sNow = box.scrollTop; // 刚加载时是 0，但不吃这个假设
	const hit = j.range ? [...box.children].find((n) => (n.dataset.range ?? null) === j.range) : null;
	// 判据与 `restoreScroll()` 同一条：**让那一块仍停在它当时的视觉位置**（所以减去**当时**的偏移量）
	box.scrollTop = hit ? sNow + (hit.getBoundingClientRect().top - boxTop - j.offset) : j.scrollTop;
}

// ── 按一下 ──────────────────────────────────────────────────────────────

const editOf = (d) => ({ range: d.range, text: d.text, expectedFingerprint: d.expectedFingerprint, keepPrefix: d.keepPrefix });

/** 发**一块**：`edits` 里只有这一条（人类要的"发送范围 = 只那一块"）。 */
async function pressBlock(key) {
	const d = state.dirty.get(key);
	if (!d || !state.page) return;
	const why = blockingReasonFor(d);
	if (why) {
		state.block.set(key, { status: "failed", message: why, at: Date.now() });
		renderBlockTools(key);
		return;
	}
	// 一次只发一块（串行）；期间别人按了 ⇒ **排队中**（那一块自己的回执上写着）
	if (state.sending) {
		if (!state.queue.includes(key)) state.queue.push(key);
		state.block.set(key, { status: "queued", at: Date.now() });
		renderBlockTools(key);
		return;
	}
	state.sending = key;
	state.busy = true;
	state.block.set(key, { status: "sending", at: Date.now() });
	renderBlockTools(key);
	renderPress();
	renderDebug();
	let wrote = false;
	let applied = null;
	let receipt = null; // 这一块该记什么回执（按服务端的真话给）
	try {
		const r = await api("/pages/press", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: state.rel, edits: [editOf(d)] }),
		});
		const j = await r.json();
		state.last = { status: r.status, body: j, at: Date.now() };
		wrote = !!j.saved?.wrote;
		applied = j.saved?.applied ?? null;
		if (wrote) {
			// 服务端确认**写进去了** ⇒ 这一块那份草稿就不该再留着（内存 + localStorage 一起清）
			clearSentDrafts(j.saved?.applied);
			state.dirty.delete(key); // 兜底：只提交了它一块，服务端说写了就不该还留在脏集合里
			persistDrafts();
		}
		if (wrote && j.delivered?.ok) {
			state.block.set(key, { status: "sent", message: `已交给会话 ${String(j.delivered.sessionId).slice(0, 8)}…`, at: Date.now() });
			state.notice = `✓ 这一块已保存，并已交给这个页面的会话。`;
			receipt = { status: "sent", message: "已交给这个页面的会话" };
		} else if (wrote && !j.delivered?.ok) {
			// ⚠️ 存住了、没发出去 —— 说法跟服务端一致，不许粉饰（挂在**这一块**上）
			state.block.set(key, { status: "failed", message: `已存盘，但没发出去（${j.delivered?.reason ?? "?"}）`, at: Date.now() });
			receipt = { status: "failed", message: `已存盘，但没发出去（${j.delivered?.reason ?? "?"}）` };
			state.notice = `⚠ 这一块的字已经存住了，但**没发出去**：${j.delivered?.reason ?? "?"}${j.delivered?.error ? `（${j.delivered.error}）` : ""}`;
		} else {
			state.block.set(key, { status: "failed", message: `没有要写的东西（${j.delivered?.reason ?? j.error ?? "?"}）`, at: Date.now() });
			state.notice = `这一块没有写进去：${j.error ?? j.delivered?.reason ?? "?"}`;
		}
	} catch (e) {
		state.block.set(key, { status: "failed", message: String(e?.message ?? e), at: Date.now() });
		state.notice = `请求没能完成：${e?.message ?? e}（**不确定有没有存住**，按一下「重读」看文件）`;
	} finally {
		if (wrote) {
			await reloadKeepingScroll({ reason: "刚发送这一块" });
			// 重读之后那一块在文件里的原文变了 ⇒ 把回执按**新原文**钉回去（否则回执会掉成“clean”）
			if (receipt) pinReceipts(applied, receipt);
		}
		state.sending = null;
		state.busy = false;
		renderPress();
		renderDebug();
		const next = state.queue.shift();
		if (next) void pressBlock(next);
	}
}

async function press({ dryRun = false } = {}) {
	if (state.busy || !state.page) return;
	const sentKeys = [...state.dirty.keys()];
	const edits = [...state.dirty.values()].map(editOf);
	if (!edits.length && !dryRun) {
		state.notice = "没有改动 —— 没写的字可交（所以不会投递）。";
		renderPress();
		return;
	}
	state.busy = true;
	renderPress();
	renderDebug();
	try {
		const r = await api("/pages/press", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: state.rel, edits, dryRun }),
		});
		const j = await r.json();
		state.last = { status: r.status, body: j, at: Date.now() };
		if (dryRun) {
			state.notice = `dry-run：没有写、也没有发。要发的字见左边调试面板。`;
		} else if (j.saved?.wrote && j.delivered?.ok) {
			state.notice = `✓ 已保存，并已交给会话 ${String(j.delivered.sessionId).slice(0, 8)}…${j.delivered.created ? "（这次新建的）" : ""}`;
		} else if (j.saved?.wrote && !j.delivered?.ok) {
			// ⚠️ 服务端说的就是这句：**存住了，但没发出去** —— 别粉饰
			state.notice = `⚠ 字已经存住了，但**没发出去**：${j.delivered?.reason ?? "?"}${j.delivered?.error ? `（${j.delivered.error}）` : ""}`;
		} else {
			state.notice = `没有要写的东西（${j.delivered?.reason ?? "nothing-new"}）—— 没写、也没发。`;
		}
		if (j.saved?.wrote) {
			// 服务端点名**写进去了**的那几块 ⇒ 那几份草稿算「真的发送成功」，先清掉（内存 + localStorage）；
			// 没被点名的（比如 `skipped`）一概不动 —— 它们的字还在内存里，接着标「有改动未发送」。
			clearSentDrafts(j.saved?.applied);
			for (const key of sentKeys) if (!state.dirty.has(key)) state.block.set(key, { status: "sent", message: "随「发送全部」一起交出去了", at: Date.now() });
			// 重新读盘：指纹变了，脏集合清掉。⚠️ `open()` 会清 notice —— 回执要等它回来再写，
			// 否则"已保存/没发出去"那句话会被重载顺手抹掉（这是我自己踩的坑）。
			const keep = state.notice;
			await open(state.rel, { rebase: true });
			state.notice = keep;
			pinReceipts(j.saved?.applied, j.delivered?.ok ? { status: "sent", message: "已交给这个页面的会话" } : { status: "failed", message: `已存盘，但没发出去（${j.delivered?.reason ?? "?"}）` });
			renderPress();
		} else {
			// 一条都没写（全被拒/全是空操作）⇒ 按块如实说
			for (const key of sentKeys) state.block.set(key, { status: "failed", message: `没写进去（${j.error ?? j.delivered?.reason ?? "?"}）`, at: Date.now() });
			render();
		}
	} catch (e) {
		state.notice = `请求没能完成：${e?.message ?? e}（**不确定有没有存住**，按一下「重读」看文件）`;
	} finally {
		state.busy = false;
		render();
	}
}

// ── 启动 ────────────────────────────────────────────────────────────────

$("#rpList").addEventListener("change", (e) => {
	location.hash = e.target.value;
	void open(e.target.value);
});
// 真刷新 / 关标签页 / 换页之前，先把「读到哪儿了」记下来（`pagehide` 比 `beforeunload` 可靠，也不拦导航）
window.addEventListener("pagehide", () => saveScrollAnchor());
$("#rpReload").addEventListener("click", () => state.rel && void open(state.rel));
$("#press").addEventListener("click", () => void press());
window.addEventListener("hashchange", () => {
	const h = decodeURIComponent(location.hash.slice(1));
	if (h && h !== state.rel) void open(h);
});

// ── 回流：订阅**同一条树级 SSE**（`GET /events`，标题那条也是它）────────────────
// 页面一变，A 就推一条 `{t:"page", path, pageFingerprint}`（只带路径 + 指纹，不带内容）。
// 这里**只**在自己这一页的指纹跟手上那份不一样时才重读 —— 没变就一声不响。
let pageStream = null;
function openPageStream() {
	try {
		pageStream?.close?.();
		pageStream = new EventSource("/api/events");
		pageStream.onmessage = (e) => {
			let m = null;
			try {
				m = JSON.parse(e.data);
			} catch {
				return;
			}
			if (m?.t !== "page") return;
			if (m.path !== state.rel) return;
			if (m.pageFingerprint && m.pageFingerprint === state.page?.pageFingerprint) return;
			void reloadKeepingScroll({ reason: "别处写动了这一页（工具或另一个人）" });
		};
		pageStream.onerror = () => {
			/* EventSource 自己会重连；断了也不该影响这一页 */
		};
	} catch {
		/* 没有 SSE 也能用（只是要手动点「重读」） */
	}
}

try {
	const list = await loadList();
	const want = decodeURIComponent(location.hash.slice(1));
	const first = list.pages.some((p) => p.path === want) ? want : list.pages[0]?.path;
	if (first) {
		$("#rpList").value = first;
		await open(first);
		openPageStream();
	} else {
		render();
	}
} catch (e) {
	$("#head").replaceChildren(el("span", "err", `读页面清单失败：${e?.message ?? e}`));
	render();
}
