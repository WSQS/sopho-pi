#!/usr/bin/env node
/**
 * 契约测试：阅读页的**页面格式 + 写入协议** —— `server/reading-page.mjs`
 *
 * 这个测试钉的是阅读页契约里的那几条硬性质，**不是**实现细节：
 *   · 解析：整页能无损回拼；块类型认得对；旧 span（没有 data-kind）靠文字前缀反推；
 *   · 挂段末插入：定位靠内容（srcId + 哈希），**不是行号** ⇒ 上方增删改不影响插入点；
 *   · 写前重读 + **范围内**指纹校验：
 *       – 目标区域被改 ⇒ **拒绝**（半字节不写）；
 *       – 目标区域**之外**被改 ⇒ 照写，且那处改动**逐字节保留**（证明指纹是"范围内"的，不是整页的）；
 *   · 危险用例：① 写前被改（指纹不符）② 锚点找不到 / 原文哈希不符 ③ 段落在单元末尾
 *     ④ 嵌套 / 未闭合 / 多行 span ⑤ 幂等（同一插入跑两次 = 不重复写）
 *   · 人写的东西（`A:` + 读者段落）在任何写入之后**一字未动**；
 *   · 原文可重建：重抽（换折行 / 多空白）→ 哈希一致 ⇒ no-op；改一个字 ⇒ 出替换计划。
 *
 * 自足：**不读 fs、不碰网络、不需要 A/B/pi**。内置一份造出来的页面（形状抄真实笔记
 * `/tmp/note-gongdu.md`）。可选：`SOPHO_READING_FIXTURE=<path>` 时，**只读地**对那份真笔记
 * 多跑一遍结构断言（不写它）。
 *
 * 跑法：npm run test:page       （全过 → 退出 0；任何一条红 → 退出 1）
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	applyPlan,
	humanOwnedRanges,
	listFields,
	normalizeSourceText,
	pageFingerprint,
	parsePage,
	planFieldLineReplace,
	planFieldReplace,
	planInsertBlock,
	planReplaceBlockText,
	planSourceRebuild,
	listBlocks,
	readField,
	renderBlock,
	sourceFingerprint,
	diffHunk,
} from "../server/reading-page.mjs";

let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};
const check = (cond, what, detail = "") => (cond ? ok(what, detail) : bad(what, detail));
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
/** 现算某个行区间的指纹（测试里用：拿最新文本重算）。 */
const fingerprintOf = (text, [s, e]) => {
	const lines = text.split("\n");
	return `sha256:${sha(lines.slice(s, e + 1).join("\n"))}`;
};
const hex = (fp) => fp.slice("sha256:".length);

// ── 造一份页面（形状抄真实笔记；原文块的哈希**写死**，免得用被测函数自证）──────
const P1 = "许多人对某一个人同时产生的影响，就是集体心理学的对象。";
const P2 = "第二段原文：个体与他人的关系。";
const P3 = "第三段原文。";
const H1 = "5e755744134e3a43df985656ee1fa1422620fe1084038f613f652dfa008ef680";
const H2 = "ac323f19d520ef68b588750f1ac7c7eb4b96da4e1426c2b926e0e5d985f976da";
const H3 = "69d80567d0ca3e365262b586aeb46a64b3d05ecb104c0fb9cacf8c293107716c";
const EP = "demo.epub!part0004.xhtml";

const PAGE = [
	"---",
	"title: 测试书",
	"date: 2026-09-15",
	"---",
	"",
	"## 阅读位置",
	"",
	"- 版本：某译本，2011 年。",
	"- 当前状态：第一个学习单元已完成。",
	"",
	"> [!note] 我的阅读笔记写在这里",
	"> 说明说明。",
	"",
	"## 选书记录",
	"",
	"- 提议 / 选择者：user。",
	"- 已知风险：题材。",
	"",
	"## 第一个阅读单元：测试单元",
	"",
	"<!--",
	"设计理由注释。",
	"-->",
	"",
	"阅读范围：第一章。",
	"",
	"### 第一章 导论",
	"",
	`<!-- src: ${EP}#p1 sha256:${H1} -->`,
	P1,
	"",
	"Q1: 问题一？",
	"",
	"A: 我的答案一。",
	"",
	'<span data-author="assistant" style="color: #2563eb;">助手追问：继续。</span>',
	"",
	"A: 补充答案。",
	"",
	`<!-- src: ${EP}#p2 sha256:${H2} -->`,
	P2,
	"",
	"Q2: 问题二？",
	"",
	"A:",
	"",
	`<!-- src: ${EP}#p3 sha256:${H3} -->`,
	P3,
	"",
	"### 本学习单元的论述运动",
	"",
	"- 抵达的位置：",
	"",
	"## 第二个阅读单元：测试单元二",
	"",
	"### 第二章 勒邦",
	"",
	"Q1: 第二章问题？",
	"",
	"A:",
	"",
	"### 本学习单元的论述运动",
	"",
	"- 抵达的位置：",
	"",
].join("\n");

const isSubsequence = (sub, arr) => {
	let i = 0;
	for (const x of arr) if (i < sub.length && sub[i] === x) i++;
	return i === sub.length;
};

/** 人写的东西一字未动：读前的人块序列，必须在写后的序列里**按序**出现且逐字节相同。 */
function assertHumanUntouched(beforeDoc, afterDoc, label) {
	const b = humanOwnedRanges(beforeDoc).map((x) => x.text);
	const a = humanOwnedRanges(afterDoc).map((x) => x.text);
	check(isSubsequence(b, a), `${label}：人的块（答案 / 读者段落）一字未动`, `${b.length} 个块在写后仍按序逐字节相同`);
}

const kindSeq = (doc) => doc.blocks.map((b) => b.kind);

console.log("── 1. 解析 ─────────────────────────────────────────────────────────");
{
	const doc = parsePage(PAGE);
	check(doc.errors.length === 0, "造出来的页面无解析错误", JSON.stringify(doc.errors));
	check(doc.lines.join(doc.eol) === PAGE, "整页无损回拼（lines.join(eol) === 原文）");
	check(doc.eol === "\n", "EOL 判定 = \\n");

	const src = doc.blocks.filter((b) => b.kind === "source");
	check(src.length === 3, "三个原文块", src.map((s) => s.srcId.split("#")[1]).join(","));
	check(
		src.every((s) => s.storedHash === s.textFingerprint),
		"原文块的标记哈希与正文一致（这就是「可重建」的门槛）",
	);
	check(src[0].bodyStart === src[0].markerLine + 1, "标记行 + 紧邻正文 = 一个块", `p1: [${src[0].markerLine}, ${src[0].end}]`);

	const fields = listFields(doc);
	check(fields.length === 4, "四个字段", fields.map((f) => `${f.heading}(section=${f.section ? f.section.slice(0, 4) + "…" : "null"})`).join(" / "));
	check(fields[0].heading === "阅读位置" && fields[0].writable, "阅读位置 可写");
	check(fields[1].writable === false, "选书记录 不可写（助手不碰）");
	check(fields[2].writable && fields[2].section === "第一个阅读单元：测试单元", "论述运动 可写且能按 section 定位");
	check(fields[3].section === "第二个阅读单元：测试单元二", "第二个单元的 论述运动 是**另一**个字段（同名 ⇒ 必须带 section 才能定位）");

	const spans = doc.blocks.filter((b) => b.kind === "assistant");
	check(spans.length === 1 && spans[0].dataKind === "助手追问", "旧 span 无 data-kind ⇒ 从文字前缀反推出「助手追问」");
	check(spans[0].dataId === null, "旧 span 没有 data-id（可读、永不被改写）");
}

console.log("\n── 2. 挂段末插入（主用法）──────────────────────────────────────────");
const doc0 = parsePage(PAGE);
const humanBefore = humanOwnedRanges(doc0);
let text1 = PAGE;
{
	const plan = planInsertBlock(doc0, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q3: 新问题？" } });
	check(plan.ok, "锚点 p1 出计划", plan.ok ? `要在第 ${plan.expect.insertAtLine} 行插` : `reason=${plan.reason}`);
	const res = applyPlan(text1, plan);
	check(res.ok, "落盘（纯函数：拿到新文本）");
	text1 = res.text;

	const want = ["A: 补充答案。", "", "Q3: 新问题？", "", "A:", "", `<!-- src: ${EP}#p2`].join("\n");
	check(text1.includes(want), "问题落在 **p1 段末**（p1 已挂的那些块之后、下一段原文之前）");
	const d1 = parsePage(text1);
	assertHumanUntouched(doc0, d1, "插入问题后");
	const expSeq = [...kindSeq(doc0)];
	expSeq.splice(kindSeq(doc0).indexOf("source", kindSeq(doc0).indexOf("answer", 10)), 0, "question", "answer");
	check(
		JSON.stringify(kindSeq(d1)) === JSON.stringify(expSeq),
		"块序列 = 原序列**只多**一对 问题/答案（其余顺序没动）",
		`${kindSeq(doc0)}\n    → ${kindSeq(d1)}`,
	);
}

console.log("\n── 3. 危险用例 ⑤：幂等（同一插入跑两次）────────────────────────────");
{
	const d = parsePage(text1);
	const planA = planInsertBlock(d, { sourceId: `${EP}#p1`, block: { kind: "助手追问", text: "助手追问：同一件事。", id: "ask-p1-1" } });
	check(planA.ok, "第一次出计划");
	const r1 = applyPlan(text1, planA);
	check(r1.ok, "第一次写入成功");
	const text2 = r1.text;

	const planB = planInsertBlock(parsePage(text2), { sourceId: `${EP}#p1`, block: { kind: "助手追问", text: "助手追问：同一件事。", id: "ask-p1-1" } });
	check(!planB.ok && planB.reason === "already-present", "第二次**出计划时**就认出 `already-present`", planB.reason);
	const r2 = applyPlan(text2, planB);
	check(!r2.ok && r2.reason === "plan-protocol-mismatch", "被拒的计划**不能被当计划执行**（连试都不试）", r2.reason);
	check((text2.match(/同一件事。/g) ?? []).length === 1, "文本里只有一份");
	// 就算把老 plan 直接重放到新文本上，也不会重复
	const r3 = applyPlan(text2, planA);
	check(!r3.ok && r3.reason === "already-present", "把**老 plan** 重放到新文本上也不重复", r3.reason);
	check(parsePage(text2).errors.length === 0, "文本仍然合法");
}

console.log("\n── 4. 同一段落的多个问题按顺序追加 ─────────────────────────────────");
{
	const d = parsePage(text1);
	const p2 = planInsertBlock(d, { sourceId: `${EP}#p2`, block: { kind: "问题", text: "Q4: 二之一？" } });
	const r = applyPlan(text1, p2);
	check(r.ok, "第一个问题插入");
	const r2 = applyPlan(r.text, planInsertBlock(parsePage(r.text), { sourceId: `${EP}#p2`, block: { kind: "问题", text: "Q5: 二之二？" } }));
	check(r2.ok, "第二个问题插入");
	const idx4 = r2.text.indexOf("Q4: 二之一？");
	const idx5 = r2.text.indexOf("Q5: 二之二？");
	check(idx4 > 0 && idx5 > idx4, "两个问题的**顺序 = 写入顺序**（不翻转）");
	const region = r2.text.slice(idx4, idx5);
	check(region.includes("A:"), "第一个问题自带空答案位", JSON.stringify(region.trim().slice(0, 24)));
	assertHumanUntouched(parsePage(text1), parsePage(r2.text), "追加两个问题后");
}

console.log("\n── 5. 危险用例 ③：段落在单元 / 章节末尾 ────────────────────────────");
{
	const d = parsePage(text1);
	const plan = planInsertBlock(d, { sourceId: `${EP}#p3`, block: { kind: "问题", text: "Q6: 最后一段的问题？" } });
	check(plan.ok, "锚点 p3（课尾段）出计划");
	const r = applyPlan(text1, plan);
	check(r.ok, "插入成功");
	const iQ = r.text.indexOf("Q6: 最后一段的问题？");
	const iField = r.text.indexOf("### 本学习单元的论述运动");
	check(iQ > 0 && iQ < iField, "问题落在**章节末尾**（`### 本学习单元的论述运动` 之前），没有跑到收束字段下面");
	check(parsePage(r.text).blocks.find((b) => b.kind === "question" && b.label === "Q6") !== undefined, "新问题按块解析出来");
	assertHumanUntouched(d, parsePage(r.text), "末尾插入后");
}

console.log("\n── 6. 危险用例 ①：写前文件被改（指纹不符）→ 拒绝 ──────────────────");
{
	const d = parsePage(PAGE);
	const plan = planInsertBlock(d, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q3: 新问题？" } });
	check(plan.ok, "先出一个计划（针对旧文本）");

	// (a) 目标区域（p1 的挂段末区域）被人改过
	const tampered = PAGE.replace("A: 补充答案。", "A: 补充答案。又被我改了。");
	check(tampered !== PAGE, "确实改到了锚点区域内");
	const r = applyPlan(tampered, plan);
	check(!r.ok && r.reason === "conflict", "⇒ **拒绝**（conflict）", `expected=${hex(r.expected ?? "")} actual=${hex(r.actual ?? "")}`);
	check(tampered === PAGE.replace("A: 补充答案。", "A: 补充答案。又被我改了。"), "拒绝时**一个字节都没写**");

	// (b) 锚点原文块本身被改（哈希不符）
	const tampered2 = PAGE.replace(P1, "这是被人改过的原文。");
	const r2 = applyPlan(tampered2, plan);
	check(!r2.ok && (r2.reason === "page-has-errors" || r2.reason === "source-hash-mismatch"), "锚点原文被改 ⇒ 拒绝", r2.reason);

	// (c) **对照**：只改了目标区域**之外**的东西 ⇒ 照写，且那处改动逐字节保留
	const far = PAGE.replace("- 已知风险：题材。", "- 已知风险：题材（我另外补的）。");
	const r3 = applyPlan(far, plan);
	check(r3.ok, "目标区域之外的改动**不**阻止写入（指纹是范围内的，不是整页的）");
	check(r3.text.includes("- 已知风险：题材（我另外补的）。"), "那处外部改动**逐字节保留**");
	check(r3.text.includes("Q3: 新问题？"), "新块也进去了");
	check(pageFingerprint(r3.text) !== pageFingerprint(PAGE), "整页指纹确实变了（它只用于报告，不当门闸）");
}

console.log("\n── 7. 危险用例 ②：锚点找不到 / 不唯一 ──────────────────────────────");
{
	const d = parsePage(PAGE);
	const r1 = planInsertBlock(d, { sourceId: `${EP}#不存在`, block: { kind: "问题", text: "Q?" } });
	check(!r1.ok && r1.reason === "anchor-not-found", "srcId 不存在 ⇒ **拒绝**", r1.reason);
	const r2 = planInsertBlock(d, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q?" } });
	const r3 = applyPlan(PAGE, { ...r2, anchor: { sourceId: `${EP}#不存在` } });
	check(!r3.ok && r3.reason === "anchor-not-found", "apply 时锚点仍找不到 ⇒ 拒绝", r3.reason);
	// 重复 srcId ⇒ 页级错误 ⇒ 一切写入都拒绝
	const dup = PAGE.replace(`<!-- src: ${EP}#p3`, `<!-- src: ${EP}#p2`);
	const ddup = parsePage(dup);
	check(ddup.errors.some((e) => e.code === "duplicate-source-id"), "重复 srcId ⇒ 解析错误", JSON.stringify(ddup.errors.map((e) => e.code)));
	const r4 = planInsertBlock(ddup, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q?" } });
	check(!r4.ok && r4.reason === "page-has-errors", "页级错误存在 ⇒ 任何写入都拒绝", r4.reason);
}

console.log("\n── 8. 字段：只改指定行（阅读位置 / 论述运动）───────────────────────");
{
	const d = parsePage(PAGE);
	const cur = readField(d, { section: null, heading: "阅读位置" });
	check(cur.ok && cur.lines.length === 2, "读到 阅读位置 的正文", `${cur.range} = ${JSON.stringify(cur.lines)}`);

	const plan = planFieldLineReplace(d, { section: null, heading: "阅读位置" }, "- 当前状态：", "- 当前状态：进入第二个学习单元。", cur.fingerprint);
	check(plan.ok, "出「只换 当前状态 那一行」的计划");
	const r = applyPlan(PAGE, plan);
	check(r.ok, "写入成功");
	check(r.text.includes("- 当前状态：进入第二个学习单元。"), "那一行换了");
	check(r.text.includes("- 版本：某译本，2011 年。"), "同字段**其他行一字未动**");
	check(humanOwnedRanges(parsePage(r.text)).map((x) => x.text).join("|") === humanBefore.map((x) => x.text).join("|"), "人写的块一字未动");

	// 匹配行不唯一 / 不存在 ⇒ 拒绝
	const amb = planFieldLineReplace(d, { section: null, heading: "选书记录" }, "- ", "x");
	check(!amb.ok && amb.reason === "field-not-writable", "选书记录 不可写 ⇒ 拒绝", amb.reason);
	const nf = planFieldLineReplace(d, { section: null, heading: "阅读位置" }, "- 不存在的行：", "x");
	check(!nf.ok && nf.reason === "line-not-found", "匹配不到行 ⇒ 拒绝", nf.reason);

	// 论述运动：同名两处 ⇒ 必须带 section 才不歧义
	const noSec = readField(d, { heading: "本学习单元的论述运动" });
	check(!noSec.ok && noSec.reason === "field-ambiguous", "省略 section ⇒ 歧义 ⇒ 拒绝", noSec.reason);
	const withSec = planFieldReplace(
		d,
		{ section: "第一个阅读单元：测试单元", heading: "本学习单元的论述运动" },
		["- 抵达的位置：取消了二分。"],
	);
	check(withSec.ok, "带 section ⇒ 定位到单元一那一处");
	const rr = applyPlan(PAGE, withSec);
	check(rr.ok && rr.text.includes("- 抵达的位置：取消了二分。"), "整段正文替换只在那个字段里生效");
}

console.log("\n── 9. 危险用例 ①(b)：字段在 plan 与 apply 之间被改 → 拒绝 ──────────");
{
	const d = parsePage(PAGE);
	const cur = readField(d, { section: null, heading: "阅读位置" });
	const plan = planFieldLineReplace(d, { section: null, heading: "阅读位置" }, "- 当前状态：", "- 当前状态：新值。", cur.fingerprint);
	const tampered = PAGE.replace("- 版本：某译本，2011 年。", "- 版本：某译本，2012 年（我改了）。");
	const r = applyPlan(tampered, plan);
	check(!r.ok && r.reason === "conflict", "同字段内被人改过 ⇒ **拒绝**", r.reason);
	check(tampered.includes("2012 年（我改了）。") && !tampered.includes("新值。"), "拒绝时零写入");
}

console.log("\n── 10. 危险用例 ④：嵌套 / 未闭合 / 多行 span ──────────────────────");
{
	// (a) 多行 span（一个物理块跨两行）—— 合法的正向用例
	const multi = PAGE.replace(
		'<span data-author="assistant" style="color: #2563eb;">助手追问：继续。</span>',
		'<span data-author="assistant" style="color: #2563eb;">助手追问：继续。<br>第二部分还在同一个块里。</span>',
	);
	const dm = parsePage(multi);
	check(dm.errors.length === 0, "多行 / 带 <br> 的 span 正常解析", JSON.stringify(dm.errors));
	const sp = dm.blocks.find((b) => b.kind === "assistant");
	check(sp.end === sp.start, "（这里仍是单行）");
	const multi2 = multi.replace("助手追问：继续。<br>第二部分还在同一个块里。", "助手追问：继续。\n第二部分跨行。");
	const dm2 = parsePage(multi2);
	check(dm2.errors.length === 0 && dm2.blocks.find((b) => b.kind === "assistant").end === dm2.blocks.find((b) => b.kind === "assistant").start + 1, "跨两个物理行的 span = 一个块");
	const r = applyPlan(multi2, planInsertBlock(dm2, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q7: x" } }));
	check(r.ok, "多行 span 存在时，插入照样能用（没有被它搅坏）");

	// (b) 嵌套 span ⇒ 页级错误 ⇒ 拒绝
	const nested = PAGE.replace("助手追问：继续。", '助手追问：<span data-author="assistant">内层</span>继续。');
	const dn = parsePage(nested);
	check(dn.errors.some((e) => e.code === "nested-span"), "嵌套 span ⇒ nested-span 错误", JSON.stringify(dn.errors.map((e) => e.code)));
	const rn = planInsertBlock(dn, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q7: x" } });
	check(!rn.ok && rn.reason === "page-has-errors", "有嵌套 span 时 ⇒ 一切写入拒绝", rn.reason);

	// (c) 未闭合 span ⇒ 拒绝
	const unter = PAGE.replace('助手追问：继续。</span>', "助手追问：继续。");
	const du = parsePage(unter);
	check(du.errors.some((e) => e.code === "unterminated-span"), "未闭合 span ⇒ unterminated-span", JSON.stringify(du.errors.map((e) => e.code)));

	// (d) 未闭合注释 ⇒ 拒绝（一个漏 `-->` 的 `<!--` 会把后面的东西整段吞掉）
	const uc = "## 阅读位置\n\n- a：b\n\n<!--\n没有结尾\n";
	const duc = parsePage(uc);
	check(duc.errors.some((e) => e.code === "unterminated-comment"), "未闭合注释 ⇒ unterminated-comment", JSON.stringify(duc.errors.map((e) => e.code)));
	// (d2) 就算注释"闭合"了（被后面的原文标记的 `-->` 顶上），也不能把原文标记吞掉
	const swallow = PAGE.replace("设计理由注释。\n-->", "设计理由注释。");
	const dsw = parsePage(swallow);
	check(
		dsw.errors.some((e) => e.code === "src-marker-inside-comment"),
		"注释吞掉原文标记 ⇒ src-marker-inside-comment（否则锚点会静默消失）",
		JSON.stringify(dsw.errors.map((e) => e.code)),
	);

	// (e) 渲染器拒绝会把边界搅坏的正文
	for (const [label, b] of [
		["正文里塞 span", { kind: "助手追问", text: "助手追问：<span>x</span>" }],
		["助手块正文多行", { kind: "助手追问", text: "助手追问：a\nb" }],
	]) {
		let threw = null;
		try {
			renderBlock(b);
		} catch (e) {
			threw = e.message;
		}
		check(threw !== null, `${label} ⇒ renderBlock 直接抛`, threw ?? "");
	}
	for (const kind of ["笔记", "答案", "读者内容"]) {
		let threw = null;
		try {
			renderBlock({ kind, text: "人写的字" });
		} catch (e) {
			threw = e.message;
		}
		check(threw !== null, `助手不许插入「${kind}」块（机制上堵死，不靠纪律）`, threw ?? "");
	}
}

console.log("\n── 11. 原文「可重建」判据 ──────────────────────────────────────────");
{
	const d = parsePage(PAGE);
	// (a) 重抽得到同样的字，只是折行 / 空白不同 ⇒ 规范化后哈希一致 ⇒ no-op
	const reflowed = `  ${P1.slice(0, 10)}\n\t${P1.slice(10)}   `;
	check(normalizeSourceText(reflowed) === normalizeSourceText(P1), "规范化吃掉折行 / 制表 / 首尾空白");
	const planNoop = planSourceRebuild(d, { srcId: `${EP}#p1`, text: reflowed });
	check(planNoop.ok && planNoop.op === "no-op", "重抽 == 文件里那份 ⇒ **no-op**（不写）", planNoop.fingerprint ?? "");

	// (b) 重抽与文件里那份**不一致** ⇒ 出替换计划（勘误 / 换译本）
	const corrected = P1.replace("就是集体心理学的对象", "也就是集体心理学的对象");
	const planFix = planSourceRebuild(d, { srcId: `${EP}#p1`, text: corrected });
	check(planFix.ok && planFix.op === "replace-source", "重抽 != 文件里那份 ⇒ 出 replace-source 计划");
	const r = applyPlan(PAGE, planFix);
	check(r.ok, "替换原文块成功");
	const d2 = parsePage(r.text);
	const s1 = d2.blocks.find((b) => b.kind === "source" && b.srcId === `${EP}#p1`);
	check(s1.storedHash === sourceFingerprint(corrected), "标记哈希被同步更新（下次重抽又变回 no-op）");
	check(s1.storedHash === s1.textFingerprint, "替换后自洽");
	check(r.text.includes("Q1: 问题一？"), "原文块之外（问题）没被动");
	assertHumanUntouched(d, d2, "原文重建后");

	// (c) 原文标记本身被改（正文没变、哈希仍自洽）⇒ 区域指纹不符 ⇒ 拒绝
	const dirty = PAGE.replace(`<!-- src: ${EP}#p1 sha256:${H1} -->`, `<!-- src: ${EP}#p1  sha256:${H1} -->`);
	const rd = applyPlan(dirty, planFix);
	check(!rd.ok && rd.reason === "conflict", "原文块区域（标记+正文）被改 ⇒ 拒绝", rd.reason);
}

console.log("\n── 12. 真实笔记（只读，可选）───────────────────────────────────────");
{
	const p = process.env.SOPHO_READING_FIXTURE ?? "/tmp/note-gongdu.md";
	if (!fs.existsSync(p)) {
		console.log(`  – 跳过：${p} 不在（这份真笔记不随仓库走）`);
	} else {
		const real = fs.readFileSync(p, "utf8");
		const d = parsePage(real);
		check(d.errors.length === 0, `${p} 解析零错误`, JSON.stringify(d.errors));
		check(d.blocks.filter((b) => b.kind === "assistant").length === 6, "6 个助手块（与真笔记一致）");
		check(d.blocks.filter((b) => b.kind === "source").length === 0, "0 个原文块（「原文进 md」是新做法 —— 现状确实没有）");
		check(listFields(d).length === 4, "4 个字段（阅读位置 / 选书记录 / 两处 论述运动）");
		check(d.blocks.every((b) => b.kind !== "field" || b.fieldKey !== "阅读位置" || b.writable), "阅读位置 可写");
		check(pageFingerprint(real) === `sha256:${sha(real)}`, "整页指纹可复算");
	}
}

console.log("\n── 13b. 读者自己写的字（`replace-block-text`：`A:` / 读者段落）────────");
{
	const d = parsePage(PAGE);
	const blocks = listBlocks(d);
	const ans = blocks.find((b) => b.kind === "answer");
	const note = blocks.find((b) => b.kind === "reader");
	check(!!ans && !!note, "块列表里能拿到答案块与读者段落", `${blocks.length} 块`);

	const plan = planReplaceBlockText(d, { range: ans.range, text: "我重写了一遍答案。", expectedFingerprint: ans.fingerprint, keepPrefix: true });
	check(plan.ok && plan.op === "replace-block-text", "答案块出计划（保留 `A:` 前缀）");
	const r = applyPlan(PAGE, plan);
	check(r.ok && r.text.split("\n")[ans.range[0]] === "A: 我重写了一遍答案。", "写入后那一行 = `A: 我重写了一遍答案。`", r.text.split("\n")[ans.range[0]]);
	// 这里**故意**改了一个人块，所以不能套"一字未动" —— 改成"**只有**那一块变了"
	{
		const before = humanOwnedRanges(d).map((x) => x.text);
		const after = humanOwnedRanges(parsePage(r.text)).map((x) => x.text);
		const changed = before.filter((x, i) => x !== after[i]);
		check(changed.length === 1 && after.length === before.length, "只有被改的那**一个**人块变了，其余逐字节相同", `变了 ${changed.length} 个`);
	}

	// 清空 ⇒ 只留 `A:`
	const plan2 = planReplaceBlockText(parsePage(r.text), { range: ans.range, text: "", expectedFingerprint: fingerprintOf(r.text, ans.range), keepPrefix: true });
	const r2 = applyPlan(r.text, plan2);
	check(r2.ok && r2.text.split("\n")[ans.range[0]] === "A:", "清空 ⇒ 只留 `A:`（占位还在）");

	// 幂等：内容一致 ⇒ no-op（**先比内容再比指纹** —— 这是"按一下连点两次"不炸的关键）
	const again = planReplaceBlockText(parsePage(r.text), { range: ans.range, text: "我重写了一遍答案。", keepPrefix: true });
	check(!again.ok && again.op === "no-op", "同一段文本再提交 ⇒ `no-op`（连点两次 = 干净的空操作）");
	const stale = planReplaceBlockText(parsePage(r.text), { range: ans.range, text: "我重写了一遍答案。", expectedFingerprint: "sha256:0000", keepPrefix: true });
	check(!stale.ok && stale.op === "no-op", "**即使指纹是旧的**，只要内容一致就还是 no-op（不会变成 409）");

	// 非空行 + 别人改过 ⇒ 409
	const bad = planReplaceBlockText(parsePage(r.text), { range: ans.range, text: "换一段", expectedFingerprint: "sha256:0000", keepPrefix: true });
	check(!bad.ok && bad.reason === "conflict", "内容不同 + 指纹不符 ⇒ `conflict`（写前校验）");

	// 门：只能改「答案」与「读者段落」
	const q = blocks.find((b) => b.kind === "question");
	const asst = blocks.find((b) => b.kind === "assistant");
	const fld = blocks.find((b) => b.kind === "field");
	for (const [label, it] of [["问题", q], ["助手块", asst], ["字段", fld]]) {
		const p = planReplaceBlockText(d, { range: it.range, text: "x", keepPrefix: false });
		check(!p.ok && p.reason === "not-reader-writable", `${label}块**不许**从这条路改（读者写的字只有两种）`, p.reason);
	}

	// 空行会把一个块劈成两块 ⇒ 拒绝
	const blank = planReplaceBlockText(d, { range: note.range, text: "甲\n\n乙", keepPrefix: false });
	check(!blank.ok && blank.reason === "blank-line-in-block", "块里出现空行 ⇒ 拒绝", blank.reason);

	// 读者段落：多行可以（只要没有空行）
	const multi = planReplaceBlockText(d, { range: note.range, text: "第一行\n第二行", keepPrefix: false });
	check(multi.ok, "读者段落里多行（无空行）可以");
	const rm = applyPlan(PAGE, multi);
	check(rm.ok && rm.text.includes("第一行\n第二行"), "写进去是两行");
	check(parsePage(rm.text).errors.length === 0, "写完之后页面仍然合法");
}


{
	// 这份笔记来自 Windows—— CRLF / BOM 不能让它静默先退。
	const crlf = PAGE.replace(/\n/g, "\r\n");
	const d = parsePage(crlf);
	check(d.eol === "\r\n" && d.errors.length === 0, "CRLF 页面解析零错误", JSON.stringify(d.errors));
	check(d.lines.join(d.eol) === crlf, "CRLF 无损回拼");
	check(
		d.blocks.filter((b) => b.kind === "source").every((b) => b.storedHash === b.textFingerprint),
		"CRLF 下原文哈希仍自洽（规范化把换行吃掉了）",
	);
	const r = applyPlan(crlf, planInsertBlock(d, { sourceId: `${EP}#p1`, block: { kind: "问题", text: "Q8: crlf？" } }));
	check(r.ok && r.text.includes("\r\nQ8: crlf？\r\n"), "在 CRLF 页面里插入仍用 CRLF");
	check(!/(^|[^\r])\n/.test(r.text), "写出的文本里没有落单的 \\n");
	check(parsePage(r.text).errors.length === 0, "插完仍是合法页面");

	const bom = `\uFEFF${PAGE}`;
	const db = parsePage(bom);
	check(db.errors.length === 0 && db.blocks[0].kind === "frontmatter", "带 BOM 的页面：front-matter 仍被认出来", JSON.stringify(db.errors));
	check(db.lines.join(db.eol) === bom, "带 BOM 也能无损回拼");

	// 分隔线是挂段末区域的**边界**
	const tiny = ["### X", "", `<!-- src: ${EP}#q1 sha256:${H1} -->`, P1, "", "---", "", "Q1: 后面的？", "", "A:", ""].join("\n");
	const rt = applyPlan(tiny, planInsertBlock(parsePage(tiny), { sourceId: `${EP}#q1`, block: { kind: "问题", text: "Q9: 段末？" } }));
	check(rt.ok && rt.text.indexOf("Q9: 段末？") < rt.text.indexOf("---"), "分隔线是边界 ⇒ 新问题插在 `---` **之前**（不越过结构分隔）");
}

console.log("\n── 15. diffHunk（报告用的差异摘要）─────────────────────────────────");
{
	const h = diffHunk("a\nb\nc\n", "a\nB\nc\n");
	check(JSON.stringify(h.removed) === JSON.stringify(["b"]) && JSON.stringify(h.added) === JSON.stringify(["B"]), "单行替换能夹出来");
	const h2 = diffHunk("a\nc\n", "a\nb\nc\n");
	check(h2.removed.length === 0 && h2.added[0] === "b", "纯插入：removed 为空");
	assert.equal(sha("x").length, 64);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} 阅读页契约：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
