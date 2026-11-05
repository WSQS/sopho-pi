#!/usr/bin/env node
/**
 * `web/mentions.mjs` 的自足测试 —— **不依赖浏览器、不依赖 A/B**，`node test/mentions.mjs` 直接跑。
 * （形状照 test/race-message.mjs：一个进程，跑完给退出码；本文件只测纯逻辑 + 无 DOM 的状态机。）
 *
 * 覆盖：
 *   解析  单个 / 多个 `@`、行首 / 行中、名字带空格、名字与 id 混用、邮箱不算、`@@` 转义
 *   光标  正在敲的提及定位、空白边界、完整 token 不再弹
 *   插入  空文本、替换正在输入的片段、中间插入、光标位置、带空格的名字
 *   候选  按名字 / 按完整 id 过滤、归档会话（含最后）、被归档祖先藏住的不出现、当前会话标记
 *   发送  canonical 原样、松散名字 → 补全完整 uuid、完整 uuid、**片段明确拒绝**、歧义拒绝、找不到拒绝
 *   面板  开关、过滤、循环选择、插入、Esc 关掉不重弹、没有候选
 *
 * 退出码：任何一项失败 → 1。
 */
import assert from "node:assert/strict";
import {
	canonicalToken,
	candidates,
	createMentionState,
	insertMention,
	isFullUuid,
	mentionAt,
	mountMentions,
	parseMentions,
	resolveDraft,
} from "../web/mentions.mjs";

// ─────────────────────────── 夹具 ───────────────────────────
const A = "01a0a3cc-b030-4b1e-9a2f-111111111111"; // 修插件热重载（在跑）
const B = "01a0a3cc-d05a-4b1e-9a2f-222222222222"; // 沙箱脚本（未读）
const C = "01a0a3cc-e001-4b1e-9a2f-333333333333"; // sandbox 脚本 带空格
const D = "01a0a3cc-f002-4b1e-9a2f-444444444444"; // 已存档的老会话（archived）
const E = "01a0a3cc-a003-4b1e-9a2f-555555555555"; // 藏在归档父下的子会话
const F = "01a0a3cc-c004-4b1e-9a2f-666666666666"; // 没有名字
const G1 = "01a0a3cc-1105-4b1e-9a2f-777777777777"; // 重复名
const G2 = "01a0a3cc-2206-4b1e-9a2f-888888888888"; // 重复名

const NODES = [
	{ id: A, name: "修插件热重载", archived: false, hot: true, streaming: true, unread: false, cwd: "C:/w/a" },
	{ id: B, name: "沙箱脚本", archived: false, hot: true, streaming: false, unread: true, cwd: "C:/w/b" },
	{ id: C, name: "sandbox 脚本 带空格", archived: false, hot: false, streaming: false, unread: false, cwd: "C:/w/c" },
	{ id: D, name: "已存档的老会话", archived: true, hot: false, streaming: false, unread: false, cwd: "C:/w/d" },
	{ id: E, name: "藏在归档父下的子会话", archived: false, hiddenByArchive: true, hot: false, streaming: false, unread: false },
	{ id: F, name: null, archived: false, hot: false, streaming: false, unread: false },
	{ id: G1, name: "重复名", archived: false, hot: false, streaming: false, unread: false },
	{ id: G2, name: "重复名", archived: false, hot: false, streaming: false, unread: false },
];
const tok = (id, name) => canonicalToken({ id, name });

// ─────────────────────────── 小测试台 ───────────────────────────
let pass = 0;
let fail = 0;
const group = (t) => console.log(`\n── ${t} ──`);
const ok = (name, fn) => {
	try {
		fn();
		pass++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		fail++;
		console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split("\n").join("\n      ")}`);
	}
};
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);

// ─────────────────────────── A. 解析 ───────────────────────────
group("A. parseMentions 解析");
ok("单个 canonical：@#<完整 uuid>「名字」", () => {
	const r = parseMentions(`看 @#${A}「修插件热重载」 这个`);
	eq(r.length, 1);
	eq(r[0].kind, "canonical");
	eq(r[0].uuid, A);
	eq(r[0].name, "修插件热重载");
});
ok("多个 @（同一行）", () => {
	const r = parseMentions(`${tok(A, "修插件热重载")} 和 ${tok(B, "沙箱脚本")}`);
	eq(r.map((m) => m.uuid), [A, B]);
});
ok("行首 + 行中", () => {
	const r = parseMentions(`${tok(A, "x")}\nhello @沙箱脚本`);
	eq(r.length, 2);
	eq(r[0].start, 0);
	eq(r[1].kind, "loose");
});
ok("名字带空格", () => {
	const r = parseMentions(`@#${C}「sandbox 脚本 带空格」`);
	eq(r.length, 1);
	eq(r[0].name, "sandbox 脚本 带空格");
});
ok("名字与 id 混用（canonical + loose）", () => {
	const r = parseMentions(`${tok(A, "修插件热重载")} @沙箱脚本`);
	eq(r.map((m) => m.kind), ["canonical", "loose"]);
	eq(r[1].query, "沙箱脚本");
});
ok("邮箱 a@b.com 不算提及", () => {
	eq(parseMentions("mail me at a@b.com").length, 0);
});
ok("@@ 转义 / @ 后跟空白 都不是提及", () => {
	eq(parseMentions("@@foo").length, 0);
	eq(parseMentions("@ foo").length, 0);
});
ok("标点后（（@…）是提及", () => {
	eq(parseMentions(`（@#${A}「x」）`).length, 1);
});
ok("`@#片段`（只写了一半 uuid）→ 记成 loose（发送时会被拒）", () => {
	const r = parseMentions("@#01a0a3cc");
	eq(r.length, 1);
	eq(r[0].kind, "loose");
	eq(r[0].query, "#01a0a3cc");
});

// ─────────────────────────── B. 光标处 ───────────────────────────
group("B. mentionAt 光标处定位");
ok("刚打一个 @ → q 为空", () => eq(mentionAt("@", 1), { start: 0, end: 1, q: "" }));
ok("@foo 光标在末尾 → q=foo", () => eq(mentionAt("@foo", 4), { start: 0, end: 4, q: "foo" }));
ok("行中 hello @fo → start=6", () => {
	const r = mentionAt("hello @fo", 9);
	eq(r, { start: 6, end: 9, q: "fo" });
});
ok("空白截断：@foo bar 光标在 bar 后 → null", () => eq(mentionAt("@foo bar", 8), null));
ok("完整 canonical token 光标在末尾 → null（不重弹）", () => eq(mentionAt(`@#${A}「x」`, `@#${A}「x」`.length), null));
ok("写到一半的 canonical（@#<uuid>）→ null", () => eq(mentionAt(`@#${A}`, 2 + A.length), null));
ok("邮箱 a@b 光标末尾 → null（前导是字母）", () => eq(mentionAt("a@b", 3), null));

// ─────────────────────────── C. 插入 ───────────────────────────
group("C. insertMention 插入");
ok("空文本：插入 token + 一个尾空格", () => {
	const r = insertMention("", 0, { id: A, name: "修插件热重载" });
	eq(r.text, `${tok(A, "修插件热重载")} `);
	eq(r.cursor, tok(A, "修插件热重载").length + 1);
});
ok("替换正在输入的片段 @沙", () => {
	const r = insertMention("看 @沙", 4, { id: B, name: "沙箱脚本" });
	eq(r.text, `看 ${tok(B, "沙箱脚本")} `);
	eq(r.cursor, 2 + tok(B, "沙箱脚本").length + 1);
});
ok("行中插入：光标在中间，前后都保留", () => {
	const r = insertMention("ab", 1, { id: B, name: "沙箱脚本" });
	eq(r.text, `a${tok(B, "沙箱脚本")} b`);
	eq(r.cursor, 1 + tok(B, "沙箱脚本").length + 1);
});
ok("名字带空格：token 里用「」裹住", () => {
	const r = insertMention("@s", 2, { id: C, name: "sandbox 脚本 带空格" });
	eq(r.text, `${tok(C, "sandbox 脚本 带空格")} `);
});
ok("后面已有空白 → 不叠第二个空格", () => {
	const r = insertMention("@x done", 2, { id: B, name: "沙箱脚本" });
	eq(r.text, `${tok(B, "沙箱脚本")} done`);
});
ok("插进去的 token 一定带**完整 uuid**（不是片段）", () => {
	const t = insertMention("", 0, { id: A, name: "x" }).text;
	const m = parseMentions(t)[0];
	eq(isFullUuid(m.uuid), true);
	eq(m.uuid, A);
});

// ─────────────────────────── D. 候选 ───────────────────────────
group("D. candidates 候选");
ok("空查询：列出除 hiddenByArchive 外的全部，归档沉底", () => {
	const r = candidates(NODES, "", {});
	eq(r.map((n) => n.id), [A, B, C, F, G1, G2, D]);
	eq(r.at(-1).archived, true);
});
ok("hiddenByArchive 不出现", () => {
	eq(candidates(NODES, "", {}).some((n) => n.id === E), false);
});
ok("按名字过滤", () => eq(candidates(NODES, "脚本", {}).map((n) => n.id), [B, C]));
ok("按完整 id 过滤（粘贴 uuid 能搜到）", () => eq(candidates(NODES, F, {}).map((n) => n.id), [F]));
ok("`#` 前缀剥掉再过滤", () => eq(candidates(NODES, "#沙箱", {}).map((n) => n.id), [B]));
ok("当前会话标记 current", () => {
	const r = candidates(NODES, "", { activeId: B });
	eq(r.find((n) => n.id === B).current, true);
	eq(r.find((n) => n.id === A).current, false);
});
ok("没有名字的会话 label = 完整 id", () => {
	eq(candidates(NODES, F, {}).find((n) => n.id === F).label, F);
});
ok("已归档会话在候选里且带 archived 标记", () => {
	const d = candidates(NODES, "", {}).find((n) => n.id === D);
	eq(d.archived, true);
});

// ─────────────────────────── E. 发送前规范化 ───────────────────────────
group("E. resolveDraft 发送前规范化");
ok("canonical 原样不动", () => {
	const t = `看 ${tok(A, "修插件热重载")}`;
	const r = resolveDraft(t, NODES);
	eq(r.ok, true);
	eq(r.text, t);
});
ok("松散名字 → 补全成 canonical（带完整 uuid）", () => {
	const r = resolveDraft("帮我问 @沙箱脚本 有结论没", NODES);
	eq(r.ok, true);
	eq(r.text, `帮我问 ${tok(B, "沙箱脚本")} 有结论没`);
});
ok("直接敲完整 uuid（不带 #）→ canonical", () => {
	const r = resolveDraft(`发给 @${A}`, NODES);
	eq(r.ok, true);
	eq(r.text, `发给 ${tok(A, "修插件热重载")}`);
});
ok("名字子串唯一 → 补全；后面的字仍当正文", () => {
	const r = resolveDraft("@sandbox 帮我看看", NODES);
	eq(r.ok, true);
	eq(r.text, `${tok(C, "sandbox 脚本 带空格")} 帮我看看`);
});
ok("canonical + loose 混用，一起规范化", () => {
	const r = resolveDraft(`${tok(A, "修插件热重载")} and @沙箱脚本`, NODES);
	eq(r.ok, true);
	eq(r.text, `${tok(A, "修插件热重载")} and ${tok(B, "沙箱脚本")}`);
});

group("E2. 片段 / 歧义 / 找不到 —— **必须明确拒绝**");
ok("uuid **前缀**片段 → 拒绝（id-fragment）", () => {
	const r = resolveDraft("@01a0a3cc 你好", NODES);
	eq(r.ok, false);
	eq(r.errors[0].reason.code, "id-fragment");
	assert.match(r.error, /片段/);
});
ok("uuid **尾巴**片段 → 拒绝（解析只看前缀）", () => {
	const r = resolveDraft("@111111111111", NODES); // A 的尾 12 位
	eq(r.ok, false);
	eq(r.errors[0].reason.code, "id-fragment");
});
ok("`@#片段`（带 # 的一半 uuid）→ 拒绝", () => {
	const r = resolveDraft("@#01a0a3cc", NODES);
	eq(r.ok, false);
	eq(r.errors[0].reason.code, "id-fragment");
});
ok("名字撞车（重复名）→ 拒绝并列出候选", () => {
	const r = resolveDraft("@重复名", NODES);
	eq(r.ok, false);
	eq(r.errors[0].reason.code, "ambiguous-name");
	assert.match(r.error, new RegExp(G1));
	assert.match(r.error, new RegExp(G2));
});
ok("找不到的会话名 → 拒绝（不静默当普通文本发）", () => {
	const r = resolveDraft("@nope 在吗", NODES);
	eq(r.ok, false);
	eq(r.errors[0].reason.code, "unknown");
	assert.match(r.error, /找不到会话/);
});
ok("`@@foo` 不是提及 → 原样通过", () => {
	const r = resolveDraft("@@foo", NODES);
	eq(r.ok, true);
	eq(r.text, "@@foo");
});
ok("一条拒绝里，前面的合法提及也一并报错（不半途改文本）", () => {
	const r = resolveDraft(`${tok(A, "x")} 和 @01a0a3cc`, NODES);
	eq(r.ok, false);
	eq(r.errors.length, 1);
});

// ─────────────────────────── F. 选择器状态机 ───────────────────────────
group("F. createMentionState 面板（无 DOM）");
ok("打一个 @ → 打开，候选=全部可见", () => {
	const s = createMentionState({ getNodes: () => NODES });
	eq(s.sync("@", 1), true);
	eq(s.items.length, NODES.filter((n) => !n.hiddenByArchive).length);
});
ok("过滤 + 循环选择", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("@脚本", 3);
	eq(s.items.map((n) => n.id), [B, C]);
	eq(s.index, 0);
	s.move(-1);
	eq(s.index, 1); // 从 0 往上 = 绕到最后一个
	s.move(1);
	eq(s.index, 0);
});
ok("commit → 插入 canonical token 且光标正确", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("看 @沙", 4);
	eq(s.items[0].id, B);
	const r = s.commit("看 @沙", 4);
	eq(r.text, `看 ${tok(B, "沙箱脚本")} `);
	eq(r.cursor, 2 + tok(B, "沙箱脚本").length + 1);
	eq(s.open, false);
});
ok("Esc 关掉后同文本不重弹，改了才重弹", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("@沙", 3);
	eq(s.open, true);
	s.dismiss("@沙");
	eq(s.sync("@沙", 3), false); // 没改 → 不弹
	eq(s.sync("@沙x", 4), true); // 改了 → 弹（哪怕没有候选）
});
ok("没有候选时：面板开着但 items 为空，commit 返回 null", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("@zzz", 4);
	eq(s.open, true);
	eq(s.items.length, 0);
	eq(s.commit("@zzz", 4), null);
});
ok("isBlocked()（/ 面板开着）→ 一直关着", () => {
	const s = createMentionState({ getNodes: () => NODES, isBlocked: () => true });
	eq(s.sync("@沙", 3), false);
});
ok("已归档会话出现在候选里，选中能插入它的完整 uuid", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("@已存档", 4);
	eq(s.items.map((n) => n.id), [D]);
	const r = s.commit("@已存档", 4);
	eq(r.text, `${tok(D, "已存档的老会话")} `);
	eq(parseMentions(r.text)[0].uuid, D);
});
ok("从候选插入的 token，再走 resolveDraft 原样通过（往返一致）", () => {
	const s = createMentionState({ getNodes: () => NODES });
	s.sync("@sandbox", 8);
	const r = s.commit("@sandbox", 8);
	const back = resolveDraft(r.text, NODES);
	eq(back.ok, true);
	eq(back.text, r.text);
});

// ─────────────────────────── G. DOM 挂载（微假 DOM，无依赖）───────────────────────────
// 状态机上面已经测透了；这段只证明**接线**对：input 事件开面板、capture keydown 接管方向键/Enter/Esc、
// 选中后真的写回 input.value + 光标、Esc 不重弹。刻意不引 jsdom（本仓库没有浏览器测试依赖）。
function fakeDom() {
	const all = [];
	const mk = (tag) => {
		const el = {
			tagName: String(tag).toUpperCase(),
			id: "",
			className: "",
			textContent: "",
			hidden: false,
			title: "",
			style: {},
			children: [],
			listeners: {},
			parentElement: null,
			value: "",
			selectionStart: 0,
			append(...kids) {
				for (const k of kids) {
					k.parentElement = el;
					el.children.push(k);
				}
			},
			replaceChildren(...kids) {
				el.children = [];
				el.append(...kids);
			},
			insertBefore(node, ref) {
				node.parentElement = el;
				const i = el.children.indexOf(ref);
				if (i < 0) el.children.push(node);
				else el.children.splice(i, 0, node);
			},
			remove() {
				const p = el.parentElement;
				if (!p) return;
				const i = p.children.indexOf(el);
				if (i >= 0) p.children.splice(i, 1);
			},
			querySelector(sel) {
				const classes = sel.split(".").filter(Boolean);
				const walk = (n) => {
					for (const c of n.children ?? []) {
						if (classes.every((k) => c.className.split(/\s+/).includes(k))) return c;
						const hit = walk(c);
						if (hit) return hit;
					}
					return null;
				};
				return walk(el);
			},
			scrollIntoView() {},
			addEventListener(type, fn) {
				(el.listeners[type] ??= []).push(fn);
			},
			removeEventListener(type, fn) {
				el.listeners[type] = (el.listeners[type] ?? []).filter((f) => f !== fn);
			},
			setSelectionRange(a, b) {
				el.selectionStart = a;
				el.selectionEnd = b;
			},
			dispatch(type, ev) {
				for (const f of [...(el.listeners[type] ?? [])]) f(ev);
			},
		};
		all.push(el);
		return el;
	};
	const doc = {
		createElement: mk,
		head: mk("head"),
		documentElement: mk("html"),
		getElementById: (id) => all.find((e) => e.id === id) ?? null,
	};
	return doc;
}

/** 造一个 [composer > input] 的输入环境，返回 { doc, input, composer }。 */
function fakeInput() {
	const doc = fakeDom();
	const composer = doc.createElement("footer");
	const input = doc.createElement("textarea");
	composer.append(input);
	return { doc, input, composer };
}

const keyEv = (input, key, extra = {}) => {
	const ev = { target: input, key, shiftKey: false, altKey: false, prevented: false, stopped: false, preventDefault() { ev.prevented = true; }, stopPropagation() { ev.stopped = true; }, ...extra };
	return ev;
};

group("G. mountMentions DOM 接线（微假 DOM）");
ok("mount 后创建 #mentions，初始隐藏", () => {
	const { doc, input } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	eq(m.box.id, "mentions");
	eq(m.box.hidden, true);
	eq(input.parentElement.children.includes(m.box), true);
});
ok("input 事件 → 面板打开、渲染候选行", () => {
	const { doc, input } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	input.value = "@沙";
	input.selectionStart = 3;
	input.dispatch("input");
	eq(m.isOpen(), true);
	eq(m.box.hidden, false);
	eq(m.state.items.map((n) => n.id), [B]);
	assert.ok(m.box.children.some((c) => c.className.includes("cmd")));
});
ok("capture keydown：Enter 选中 → 写回 value + 光标，且阻止冒泡", () => {
	const { doc, input, composer } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	input.value = "看 @沙";
	input.selectionStart = 4;
	input.dispatch("input");
	const ev = keyEv(input, "Enter");
	composer.dispatch("keydown", ev); // 捕获监听挂在父元素上
	eq(ev.prevented, true);
	eq(ev.stopped, true);
	eq(input.value, `看 ${tok(B, "沙箱脚本")} `);
	eq(input.selectionStart, 2 + tok(B, "沙箱脚本").length + 1);
	eq(m.isOpen(), false);
});
ok("面板关着时，keydown 原样放过（不 preventDefault）", () => {
	const { doc, input, composer } = fakeInput();
	mountMentions({ input, getNodes: () => NODES, doc });
	const ev = keyEv(input, "Enter");
	composer.dispatch("keydown", ev);
	eq(ev.prevented, false);
	eq(ev.stopped, false);
});
ok("Escape 关闭且同文本不重弹", () => {
	const { doc, input, composer } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	input.value = "@沙";
	input.selectionStart = 3;
	input.dispatch("input");
	composer.dispatch("keydown", keyEv(input, "Escape"));
	eq(m.isOpen(), false);
	input.dispatch("input"); // 文本没变
	eq(m.isOpen(), false);
});
ok("resolveForSend 直接可用（片段被拒）", () => {
	const { doc, input } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	eq(m.resolveForSend("@01a0a3cc").ok, false);
	eq(m.resolveForSend("@沙箱脚本").text, `${tok(B, "沙箱脚本")}`);
});
ok("destroy 解绑监听、移走面板", () => {
	const { doc, input } = fakeInput();
	const m = mountMentions({ input, getNodes: () => NODES, doc });
	m.destroy();
	eq(input.listeners.input.length, 0);
	eq(input.parentElement.children.includes(m.box), false);
});

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`通过 ${pass} · 失败 ${fail} · 共 ${pass + fail}`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 有失败");
process.exit(fail > 0 ? 1 : 0);
