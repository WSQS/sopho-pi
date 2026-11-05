#!/usr/bin/env node
/**
 * 在**真实笔记的副本**上跑一次 S1 的完整写入循环，产出人能一眼看懂的 diff。
 *
 * 它干四件事（全部有原始输出）：
 *   A. 材料化一段原文（`原文进 md` 是新做法；现状那份笔记里 0 段原文）
 *      —— 锚点 = `### 第二章 …` 这一节的**节末**（`section` 锚点）
 *   B. 在 A 的原文块**段末**插一个问题（`Q4: …` + 空 `A:`）—— 主用法（`sourceId` 锚点）
 *   C. 在**同一个段末**再插一个助手块（`助手追问` span，带 data-kind / data-id），
 *      并且**跑两次**证明幂等（第二次 `already-present`，一个字节都不写）
 *   D. 更新 `阅读位置` 里的 `- 当前状态：` **那一行**（只动这一行）
 *   E. 危险用例 ①：拿 B 的计划去撞一份"被人改过"的文本 ⇒ 必须**拒绝**
 *
 * ⚠️ **绝不动原件**：输入只读，输出写到 `--out`（默认 mkdtemp 出来的临时目录）。
 * ⚠️ 测试机**没有**那份 epub（它在另一台机器上），所以 A 的原文正文是**造出来的占位字**，
 *    srcId 也写明是合成的（`__合成演示__.epub!…`）—— 别把它当成弗洛伊德原文。
 *
 * 跑法：
 *   node test/reading-page-demo.mjs                       # 用 /tmp/note-gongdu.md
 *   node test/reading-page-demo.mjs <输入.md> --out <目录>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	applyPlan,
	humanOwnedRanges,
	listFields,
	pageFingerprint,
	parsePage,
	planFieldLineReplace,
	planInsertBlock,
	readField,
} from "../server/reading-page.mjs";

const argv = process.argv.slice(2);
const argOf = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const SRC = argv.find((a) => !a.startsWith("--") && a !== argOf("out", null)) ?? "/tmp/note-gongdu.md";
const OUT = argOf("out", null) ?? fs.mkdtempSync(path.join(os.tmpdir(), "reading-page-demo-"));
fs.mkdirSync(OUT, { recursive: true });

const artifact = (name, text) => {
	fs.writeFileSync(path.join(OUT, name), text);
	return path.join(OUT, name);
};

const say = (s = "") => console.log(s);
const step = (n, title) => {
	say("");
	say(`── ${n}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
};

const original = fs.readFileSync(SRC, "utf8");
const pagePath = artifact("note.md", original);
const before = parsePage(original);
const humanBefore = humanOwnedRanges(before);

say(`输入（只读）：${SRC}`);
say(`  字节 ${Buffer.byteLength(original)} · 行 ${before.lines.length - 1} · 整页指纹 ${pageFingerprint(original)}`);
say(`  解析错误：${JSON.stringify(before.errors)}`);
say(`  字段：${listFields(before).map((f) => `${f.heading}${f.section ? `@${f.section.slice(0, 6)}…` : ""}${f.writable ? "(可写)" : "(只读)"}`).join(" / ")}`);
say(`  人写的块（答案 / 读者段落）：${humanBefore.length} 个`);
say(`  旧助手块：${before.blocks.filter((b) => b.kind === "assistant").length} 个（无 data-kind，靠文字前缀反推）`);
say(`  原文块：${before.blocks.filter((b) => b.kind === "source").length} 个`);

const SRC_ID = "__合成演示__.epub!part0004.xhtml#p2";
const DEMO_TEXT = "〔演示用占位原文 —— 本机没有那份 epub，这段不是弗洛伊德原文，只为跑通「原文进 md + 问题挂段末」的格式与写入。〕";

let text = original;
const log = [];

// ── A. 材料化一段原文（节末锚点）────────────────────────────────────────
step("A", "材料化一段原文（锚点 = `### 第二章 …` 的节末）");
{
	const doc = parsePage(text);
	const plan = planInsertBlock(doc, {
		section: { level: 3, heading: "第二章 勒邦对集团心理的描述" },
		block: { kind: "原文", srcId: SRC_ID, text: DEMO_TEXT },
	});
	if (!plan.ok) throw new Error(`A 出计划失败：${plan.reason}`);
	say(`计划：在「第二章」节末（节末上一块 = 第 ${plan.expect.regionRange[0]}-${plan.expect.regionRange[1]} 行）插入原文块`);
	say(`  节末区域指纹 ${plan.expect.regionFingerprint.slice(0, 24)}…`);
	const r = applyPlan(text, plan);
	if (!r.ok) throw new Error(`A 落盘失败：${r.reason}`);
	say(`落盘：插入到第 ${r.insertAtLine} 行`);
	text = r.text;
	log.push(["A 材料化原文（节末锚点）", r.insertAtLine]);
	const f = parsePage(text).blocks.find((b) => b.kind === "source" && b.srcId === SRC_ID);
	say(`  新块：[${f.markerLine}, ${f.end}]  标记哈希自洽 = ${f.storedHash === f.textFingerprint}`);
}

// ── B. 挂段末插一个问题 ─────────────────────────────────────────────────
step("B", "在原文块**段末**插一个问题（主用法：`sourceId` 锚点）");
{
	const doc = parsePage(text);
	const plan = planInsertBlock(doc, { sourceId: SRC_ID, block: { kind: "问题", text: "Q4: 勒邦描述的那三条原因之间是什么关系？" } });
	if (!plan.ok) throw new Error(`B 出计划失败：${plan.reason}`);
	say(`计划：锚点 = ${SRC_ID}`);
	say(`  段末区域 = 第 ${plan.expect.regionRange[0]}-${plan.expect.regionRange[1]} 行（空区间 ⇒ 指纹 ${plan.expect.regionFingerprint.slice(7, 15)}… = sha256(空串)）`);
	const r = applyPlan(text, plan);
	if (!r.ok) throw new Error(`B 落盘失败：${r.reason}`);
	say(`落盘：问题插入到第 ${r.insertAtLine} 行`);
	text = r.text;
	log.push(["B 挂段末插问题", r.insertAtLine]);
}

// ── C. 同一个段末再插一个助手块；跑两次验幂等 ──────────────────────────
step("C", "同一段末再插一个助手块（幂等：同一插入跑两次）");
{
	const block = { kind: "助手追问", text: "助手追问：先只回答一点 —— 这三条原因是并列的，还是有先后？", id: "ask-p2-first" };
	const plan1 = planInsertBlock(parsePage(text), { sourceId: SRC_ID, block });
	if (!plan1.ok) throw new Error(`C 出计划失败：${plan1.reason}`);
	const r1 = applyPlan(text, plan1);
	if (!r1.ok) throw new Error(`C 落盘失败：${r1.reason}`);
	say(`第一次：插入到第 ${r1.insertAtLine} 行`);
	text = r1.text;
	log.push(["C 助手追问（第一次）", r1.insertAtLine]);

	const plan2 = planInsertBlock(parsePage(text), { sourceId: SRC_ID, block });
	say(`第二次（同一 id）：plan.ok=${plan2.ok} reason=${plan2.reason ?? "-"}`);
	const r2 = applyPlan(text, plan2);
	say(`第二次（同一 id）：apply.ok=${r2.ok} reason=${r2.reason ?? "-"}  ${r2.reason === "plan-protocol-mismatch" ? "（被拒的计划不能被当计划执行）" : ""}`);
	const r3 = applyPlan(text, plan1);
	say(`把**第一次的老计划**重放到新文本上：apply.ok=${r3.ok} reason=${r3.reason}  ⇒ 不重复写`);
	const n = (text.match(/先只回答一点/g) ?? []).length;
	say(`文本里「先只回答一点」出现 ${n} 次（期望 1）`);
	if (n !== 1) throw new Error("幂等被破坏了");
}

// ── D. 更新 阅读位置 的一行 ─────────────────────────────────────────────
step("D", "更新 `阅读位置` 的 `- 当前状态：` **那一行**");
{
	const doc = parsePage(text);
	const cur = readField(doc, { section: null, heading: "阅读位置" });
	say(`字段正文 = 第 ${cur.range[0]}-${cur.range[1]} 行 · 指纹 ${cur.fingerprint.slice(0, 24)}…`);
	say(`  旧值：${cur.lines.find((l) => l.startsWith("- 当前状态："))}`);
	const plan = planFieldLineReplace(
		doc,
		{ section: null, heading: "阅读位置" },
		"- 当前状态：",
		"- 当前状态：第二个学习单元（第二章勒邦）的原文已进 md，问题挂在各段段末；正在回答 Q1–Q4。",
		cur.fingerprint,
	);
	if (!plan.ok) throw new Error(`D 出计划失败：${plan.reason}`);
	const r = applyPlan(text, plan);
	if (!r.ok) throw new Error(`D 落盘失败：${r.reason}`);
	say(`落盘：只换了第 ${r.replacedLine} 行`);
	text = r.text;
	log.push(["D 更新 阅读位置 一行", r.replacedLine]);
}

// ── E. 危险用例 ①：写前被改 ⇒ 拒绝（在真文件上跑）──────────────────────
step("E", "危险用例 ①：写前文件被改（指纹不符）⇒ 拒绝");
{
	const doc = parsePage(text);
	const plan = planInsertBlock(doc, { sourceId: SRC_ID, block: { kind: "问题", text: "Q5: 这条不该被写进去？" } });
	say(`先出计划（ok=${plan.ok}）`);
	// 模拟：人在同一区域里自己写了点东西
	const tampered = text.replace(DEMO_TEXT, `${DEMO_TEXT}\n\n（我自己在这里补了一句。）`);
	const r = applyPlan(tampered, plan);
	say(`apply.ok=${r.ok}  reason=${r.reason}  detail=${r.detail ?? ""}`);
	say(`  expected ${String(r.expected ?? "").slice(0, 24)}…`);
	say(`  actual   ${String(r.actual ?? "").slice(0, 24)}…`);
	say(`被改的文本里有没有 Q5：${tampered.includes("Q5:")}（必须是 false）`);
	if (r.ok || tampered.includes("Q5:")) throw new Error("冲突没被拦住");
}

// ── 落盘 + 校验 + diff ──────────────────────────────────────────────────
step("F", "校验与 diff");
const after = parsePage(text);
const humanAfter = humanOwnedRanges(after);

const subseq = (sub, arr) => {
	let i = 0;
	for (const x of arr) if (i < sub.length && sub[i] === x) i++;
	return i === sub.length;
};
const hb = humanBefore.map((x) => x.text);
const ha = humanAfter.map((x) => x.text);
say(`人写的块：写前 ${hb.length} 个 → 写后 ${ha.length} 个；写前那 ${hb.length} 个是否**按序逐字节**仍在：${subseq(hb, ha)}`);

const legacy = before.blocks.filter((b) => b.kind === "assistant");
const legacyKept = legacy.every((b) => text.includes(before.lines.slice(b.start, b.end + 1).join(before.eol)));
say(`旧助手块 ${legacy.length} 个：逐字节仍在 = ${legacyKept}`);

const readerBefore = before.blocks.filter((b) => b.kind === "reader").map((b) => before.lines.slice(b.start, b.end + 1).join(before.eol));
say(`读者段落 ${readerBefore.length} 个：逐字节仍在 = ${readerBefore.every((t) => text.includes(t))}`);

const answerBefore1 = before.blocks.filter((b) => b.kind === "answer").map((b) => before.lines.slice(b.start, b.end + 1).join(before.eol));
const answerNonEmpty = before.blocks.filter((b) => b.kind === "answer" && before.lines[b.start].trim().length > 2).length;
say(`答案块 ${answerBefore1.length} 个（其中非空 ${answerNonEmpty} 个）：逐字节仍在 = ${answerBefore1.every((t) => text.includes(t))}`);

const finalPath = artifact("note.after.md", text);
say(`产物：`);
say(`  原件副本 ${pagePath}`);
say(`  写入结果 ${finalPath}`);

let diff = "";
try {
	diff = execFileSync("diff", ["-u", pagePath, finalPath], { encoding: "utf8" });
} catch (e) {
	diff = e.stdout ?? "";
}
artifact("note.diff", diff);
say("");
say(`diff -u（原件 → 写入结果）：`);
say(diff);

const hunks = diff.split("\n").filter((l) => l.startsWith("@@")).length;
say(`hunk 数 = ${hunks}（A/B/C 三次插入在文件里**是挨着的**，所以 diff 把它们合成一个 hunk；加 D 一共 2 个 hunk）`);
say(`写入行号：${log.map(([k, n]) => `${k}→L${n + 1}`).join(" · ")}`);
say("");
say(`✅ 演示完成。产物目录：${OUT}`);
