#!/usr/bin/env node
/**
 * 契约测试：阅读页的 **HTTP API + 存储层**（路由在 `server/base-logic.mjs`，存储在 `server/page-store.mjs`）。
 *
 * 这一份补的是 S1 **有意留在纯函数之外**的两件事，外加"根限制"这条硬要求：
 *   · **可写根限制**（`SOPHO_PAGE_ROOT` / `SOPHO_EPUB_ROOT`）：绝对路径 / `..` / 越根 / 非 `.md` /
 *     软链逃逸 ⇒ **403，连读都不给**。⚠️ B 零认证、默认绑 0.0.0.0 —— 这个 API 就是"任意文件写"的门，
 *     根限制是**硬要求**，不是加固。
 *   · **写前重读 + 指纹校验**：在 API 上重演人类会造成的真实情形（"你读完之后我又改了字段"）⇒ 409 conflict。
 *   · **锁 / 重试**：同一个页面上两条并发写入**都不丢**（无锁的话后一条会被前一条撞掉）。
 *   · **原子写**：临时文件 → rename；跑完**不留** `.sopho-tmp-*` 垃圾。
 *   · **真 epub 端到端**：材料化 4 段 ⇒ 再抽一次 ⇒ **no-op（逐字节不写）**。
 *
 * 自足：**自己起一台 A**（`server/base.mjs` 子进程）指向一个临时 home + 临时可写根，
 * 用**随机端口**。不碰活实例（7331/7321 一律不碰）、不碰真实 `$ASSIST_HOME`、不碰 `note` 仓库。
 *
 * 跑法：npm run test:api
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { PageError, createPageStore } from "../server/page-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};
const check = (c, what, detail = "") => (c ? ok(what, detail) : bad(what, detail));
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const REAL_NOTE = process.env.SOPHO_READING_FIXTURE ?? "/tmp/note-gongdu.md";
const REAL_EPUB = process.env.SOPHO_REAL_EPUB ?? "/tmp/zhiwo-yubenwo.epub";

// ── 临时可写根 ──────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-pageapi-"));
const HOME = path.join(TMP, "home");
const PAGES = path.join(TMP, "root");
const REL = "note/集体心理学和自我的分析.md";
let pageAbs;
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PAGES, "note"), { recursive: true });
fs.mkdirSync(path.join(PAGES, "books"), { recursive: true });
if (fs.existsSync(REAL_NOTE)) {
	fs.copyFileSync(REAL_NOTE, path.join(PAGES, REL));
	ok("把真笔记拷进临时根（只读输入）", `${fs.readFileSync(REAL_NOTE).length} B`);
} else {
	fs.writeFileSync(path.join(PAGES, REL), ["## 阅读位置", "", "- 当前状态：初稿。", "", "### 第二章 勒邦对集团心理的描述", "", "笔记：", "", "A:", ""].join("\n"));
	ok("真笔记不在 ⇒ 用造出来的一页", REAL_NOTE);
}
pageAbs = path.join(PAGES, REL);

const HAVE_EPUB = fs.existsSync(REAL_EPUB);
if (HAVE_EPUB) {
	fs.copyFileSync(REAL_EPUB, path.join(PAGES, "books/zhiwo-yubenwo.epub"));
	ok("把真 epub 拷进临时根", "books/zhiwo-yubenwo.epub");
} else {
	console.log(`  – 真 epub 不在（${REAL_EPUB}）⇒ 跳过与 epub 有关的用例`);
}

// ── 本地**假模型**（OpenAI 兼容）────────────────────────────────────────
// 为什么需要它：验收要求是"**会话真收到了消息**"。真去调模型的代价是：要凭据、要网络、要花钱。
// 所以这里起一个本地的 OpenAI 兼容端点，把 pi 的默认 provider 指过去 —— 于是
// `session.prompt()` 真的被接受、消息真的落进会话文件（**一条网络请求都不出这台机器**）。
const modelHits = [];
const stubModel = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		modelHits.push({ url: req.url, at: Date.now() });
		let payload = {};
		try {
			payload = JSON.parse(body);
		} catch {
			/* 不是 JSON 也照答，免得假端点自己把测试搅黄 */
		}
		if (payload.stream) {
			const chunk = (delta, fin) => JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta, finish_reason: fin ?? null }] });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${chunk({ role: "assistant", content: "" })}\n\n`);
			res.write(`data: ${chunk({ content: "收到。" })}\n\n`);
			res.write(`data: ${chunk({}, "stop")}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "stub-1", choices: [{ index: 0, message: { role: "assistant", content: "收到。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
		}
	});
});
const STUB_PORT = await new Promise((r) => stubModel.listen(0, "127.0.0.1", () => r(stubModel.address().port)));
fs.writeFileSync(
	path.join(HOME, "models.json"),
	JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-1", name: "Stub", reasoning: false, contextWindow: 100000, maxTokens: 4096 }] } } }, null, 1),
);
fs.writeFileSync(path.join(HOME, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", compaction: { enabled: false } }, null, 1));

// 根外放一个文件 + 一个从根里指出去的软链（验"软链逃逸也要拒"）
const OUTSIDE = path.join(TMP, "outside.md");
fs.writeFileSync(OUTSIDE, "# 根外的文件，不该被读到\n");
let HAVE_SYMLINK = true;
try {
	fs.symlinkSync(OUTSIDE, path.join(PAGES, "escape.md"));
} catch {
	HAVE_SYMLINK = false;
}

// ── 起 A ────────────────────────────────────────────────────────────────
const freePort = async () => {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const p = s.address().port;
	await new Promise((r) => s.close(r));
	return p;
};
const PORT = await freePort();
const child = spawn(process.execPath, ["server/base.mjs"], {
	cwd: ROOT,
	env: {
		...process.env,
		ASSIST_HOME: HOME,
		SOPHO_AGENT_DIR: HOME,
		SOPHO_BASE_PORT: String(PORT),
		SOPHO_CWD: TMP,
		SOPHO_PAGE_ROOT: PAGES,
		SOPHO_EPUB_ROOT: PAGES,
		SOPHO_IDLE_TTL_MS: "60000",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
// ? 双保险：`finally` 只能盖住正常路径。stdout 被下游提前关掉（`| head` 之类）会 EPIPE，
// 那种退出**不会**跑 finally —— 沙箱 A 就残留了（本仓真踩过一次）。exit 钩子兼盖这种。
const killChild = () => {
	try {
		child.kill("SIGKILL");
	} catch {
		/* 已经死了 */
	}
};
process.on("exit", killChild);

function req(method, urlPath, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
		const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
			const chunks = [];
			res.on("data", (d) => chunks.push(d));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				let json = null;
				try {
					json = JSON.parse(raw);
				} catch {
					json = null;
				}
				resolve({ status: res.statusCode, json, raw });
			});
		});
		r.on("error", reject);
		if (data) r.write(data);
		r.end();
	});
}
const GET = (p) => req("GET", p);
const POST = (b) => req("POST", "/pages", b);
const getPage = (text = true) => GET(`/pages?path=${encodeURIComponent(REL)}${text ? "" : "&text=0"}`);
const getPage2 = (rel) => GET(`/pages?path=${encodeURIComponent(rel)}`);

let up = false;
try {
	for (let i = 0; i < 100 && !up; i++) {
		try {
			const r = await GET("/host");
			if (r.status === 200) up = true;
		} catch {
			/* 还没起来 */
		}
		if (!up) await sleep(200);
	}
	assert.ok(
		up || !logs.includes("ERR_MODULE_NOT_FOUND"),
		`A 起不来：这个树里找不到依赖（ERR_MODULE_NOT_FOUND）。\n  先 \`npm i\`，或把 node_modules 链过来：\n    ln -s <主树>/node_modules ${ROOT}/node_modules\n原始输出：\n${logs}`,
	);
	assert.ok(up, `A 没起来。输出：\n${logs}`);

	console.log("\n── 1. GET /pages：能读、能说要紧的话 ───────────────────────────────");
	let fileHash0;
	{
		const list = await GET("/pages");
		check(list.status === 200, "GET /pages 200");
		check(list.json.root === PAGES, "报出**根**（让人一眼看见这个 API 的爆炸半径）", list.json.root);
		check(list.json.epubRoot === PAGES, "报出 epub 根", list.json.epubRoot);
		check(list.json.rootSource === "env" && list.json.epubRootSource === "env", "报告根来源（env）", `${list.json.rootSource}/${list.json.epubRootSource}`);
		check(typeof list.json.warning === "string" && list.json.warning.includes("零认证"), "**带零认证警告**（如实说明）", list.json.warning.slice(0, 28) + "…");
		check(list.json.pages.some((p) => p.path === REL), "页面清单里有那一页", `${list.json.pages.length} 页`);

		const page = await getPage();
		check(page.status === 200 && page.json.errors.length === 0, "GET ?path= 读页 + 解析零错误", JSON.stringify(page.json.errors));
		check(page.json.fields.length >= 3, "报出字段", page.json.fields.map((f) => f.heading).join(" / "));
		check(page.json.stats.byKind && page.json.stats.blocks > 0, "报出块结构", JSON.stringify(page.json.stats.byKind));
		check(typeof page.json.text === "string" && page.json.pageFingerprint.startsWith("sha256:"), "报出正文 + 整页指纹", page.json.pageFingerprint.slice(0, 20) + "…");
		const noText = await getPage(false);
		check(noText.json.text === undefined && noText.json.stats.blocks === page.json.stats.blocks, "`?text=0` 只给结构（省流）");
		fileHash0 = sha(fs.readFileSync(pageAbs, "utf8"));
	}

	console.log("\n── 2. 根限制（硬要求：403，连读都不给）────────────────────────────");
	{
		const cases = [
			["../outside.md", 403, "path-has-parent"],
			["/etc/passwd", 403, "path-absolute"],
			["note/../../outside.md", 403, "path-has-parent"],
			["note/集体心理学和自我的分析.txt", 403, "path-ext-not-allowed"],
			["", 400, "path-empty"], // 给了 `?path=` 但为空 ≠ "列清单"
		];
		for (const [p, wantStatus, want] of cases) {
			const r = await GET(`/pages?path=${encodeURIComponent(p)}`);
			check(r.status === wantStatus && r.json.error === want, `拒绝 ${JSON.stringify(p)}`, `${r.status} ${r.json?.error}`);
		}
		const r = await GET(`/pages?path=${encodeURIComponent("../outside.md")}&x=1`);
		check(r.status === 403, "越根请求不会因为加参数就放行");
		if (HAVE_SYMLINK) {
			const s = await GET(`/pages?path=${encodeURIComponent("escape.md")}`);
			check(s.status === 403 && s.json.error === "outside-root", "**软链逃逸**（根里一个指向根外的链接）⇒ 403", `${s.status} ${s.json?.error}`);
		} else {
			console.log("  – 跳过软链用例（这个平台不让建软链）");
		}
		const w = await POST({ op: "replace-field-line", path: "../outside.md", address: {}, match: "x", line: "y" });
		check(w.status === 403, "写路径同样被拦（不是只有读被拦）", `${w.status} ${w.json?.error}`);
		check(fs.readFileSync(OUTSIDE, "utf8").includes("不该被读到"), "根外的文件一个字节没动");
	}

	console.log("\n── 3. 只读 op：查段落 / 抽一段（不碰页面）────────────────────────");
	let p5;
	if (HAVE_EPUB) {
		const lp = await POST({ op: "list-paragraphs", epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml" });
		check(lp.status === 200 && lp.json.count === 293, "list-paragraphs：293 段", `count=${lp.json.count}`);
		check(lp.json.items[4].paragraph === 5 && lp.json.items[4].length === 579, "第 5 段就是那个 579 字段落", `head=${lp.json.items[4].head.slice(0, 18)}…`);
		// 人类拍板：按段落、**不做语义选择器** ⇒ 选到标题/脚注**不拒绝**，但要**如实带 warning**
		check(lp.json.items[0].cls === "title1" && (lp.json.items[0].warnings ?? []).some((w) => w.includes("标题")), "¶1（class=title1）带「看着像标题」的 warning", JSON.stringify(lp.json.items[0].warnings));
		check(lp.json.items[1].cls === "subtitle4" && (lp.json.items[1].warnings ?? []).some((w) => w.includes("标题")), "¶2（class=subtitle4）= 第一章标题，也带 warning", JSON.stringify(lp.json.items[1].warnings));
		const noteItem = lp.json.items.find((i) => (i.cls ?? "").startsWith("note") && (i.warnings ?? []).length);
		check(!!noteItem && (noteItem.warnings ?? []).some((w) => w.includes("脚注")), "注释段（class=note1）带「看着像脚注」的 warning", JSON.stringify(noteItem?.warnings ?? null));
		check((lp.json.items[4].warnings ?? null)?.length === 0, "正文段（class=normaltext）**不**背 warning（别把警告变成噪音）", JSON.stringify(lp.json.items[4].warnings ?? null));

		const ex0 = await POST({ op: "extract", epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: 1, epubId: "自我与本我.epub" });
		check(ex0.status === 200, "抽标题段**不拒绝**（人类要的是 warning，不是语义选择器）", `${ex0.status}`);
		check((ex0.json.warnings ?? []).some((w) => w.includes("标题") && w.includes("title1")), "取出的是标题，就**明说**（含 class 名，够人自己判）", JSON.stringify(ex0.json.warnings));

		const ex = await POST({ op: "extract", epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: 5, epubId: "自我与本我.epub" });
		check(ex.status === 200 && ex.json.srcId === "自我与本我.epub!part0004.xhtml#p5", "extract：给出 srcId", ex.json.srcId);
		check(ex.json.stripped === "a=2,sup=2" && ex.json.fingerprint.startsWith("sha256:"), "带**剥离痕迹**与指纹", `stripped=${ex.json.stripped}`);
		p5 = ex.json;

		const oob = await POST({ op: "extract", epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: 999 });
		check(oob.status === 400 && String(oob.json.error).includes("out-of-range"), "越界 ⇒ 400", oob.json.error);
		const eb = await POST({ op: "extract", epub: "../outside.md", file: "x", paragraph: 1 });
		check(eb.status === 403, "epub 也在根限制里", `${eb.status} ${eb.json?.error}`);
	} else {
		console.log("  – 跳过（没有真 epub）");
	}

	console.log("\n── 3b. 工具用的只读索引：章节树 / 按关键词找段 / 按文件名找书 ────────");
if (HAVE_EPUB) {
	const out = await POST({ op: "outline", epub: "books/zhiwo-yubenwo.epub", epubId: "自我与本我.epub" });
	check(out.status === 200 && out.json.files.length === 10, "outline：10 份 xhtml", `${out.json.files?.length} 份`);
	check(out.json.chapterCount > 20, "outline：认出「看着像标题」的段落（章节树）", `${out.json.chapterCount} 个`);
	check(
		out.json.chapters.some((c) => c.paragraph === 1 && String(c.text).includes("集体心理学")),
		"outline：能定位到「集体心理学和自我的分析」那一篇",
		out.json.chapters.slice(0, 3).map((c) => `${c.file}#p${c.paragraph}`).join(","),
	);
	const srch = await POST({ op: "search", epub: "books/zhiwo-yubenwo.epub", q: "原始部落", limit: 3, epubId: "自我与本我.epub" });
	check(srch.status === 200 && srch.json.count >= 1, "search：「原始部落」找得到（真实陪读要向前引用时会用）", `${srch.json.count} 段`);
	check(
		srch.json.hits.every((h) => h.srcId.includes("!") && h.srcId.includes("#p")),
		"search：每条都给**可用的 srcId**（模型拿它去 page_source，不必自己切段）",
		srch.json.hits[0]?.srcId,
	);
	const noq = await POST({ op: "search", epub: "books/zhiwo-yubenwo.epub", q: "   " });
	check(noq.status === 400, "search：不给 q ⇒ 400（不瞎搜）", noq.json?.error);
	const fe = await POST({ op: "find-epub", name: "zhiwo-yubenwo.epub" });
	check(fe.status === 200 && fe.json.found?.length === 1, "find-epub：按文件名找到根内相对路径（工具的 srcId→路径 那一环）", JSON.stringify(fe.json?.found));
	const fe2 = await POST({ op: "find-epub", name: "不存在的.epub" });
	check(fe2.json?.found?.length === 0, "find-epub：找不到就如实回空数组", JSON.stringify(fe2.json?.found));
} else {
	console.log("  – 跳过（没有真 epub）");
}

console.log("\n── 3c. 回流：写动了就广播 `{t:\"page\"}`（前端靠它不刷新）───────────");
{
	// 订阅树级 SSE（自己开一条，读一行就够）
	const seen = [];
	const sse = http.request({ host: "127.0.0.1", port: PORT, path: "/events", method: "GET" }, (r) => {
		let buf = "";
		r.on("data", (d) => {
			buf += d.toString("utf8");
			for (const line of buf.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				try {
					const m = JSON.parse(line.slice(6));
					if (m.t === "page") seen.push(m);
				} catch {
					/* 半行 */
				}
			}
			buf = buf.slice(buf.lastIndexOf("\n") + 1);
		});
	});
	sse.on("error", () => {});
	sse.end();
	await sleep(200);
	// ⚠️ 这一段会**真的写**一次（为了看它广播），写完得把这页恢复回去 ——
	// 否则后面"人写的东西一字未动"那些断言会被它带坏（测试自己的临时文件，直接写回即可）。
	const before3c = fs.readFileSync(pageAbs, "utf8");
	const pg = await getPage();
	const rd = pg.json.blocks.find((b) => b.kind === "reader");
	const w = await POST({ op: "replace-block-text", path: REL, range: rd.range, text: "改一下，看它广不广播。", expectedFingerprint: rd.fingerprint, keepPrefix: false });
	check(w.status === 200 && w.json.wrote === true, "写一次页面（走通用 op）", `${w.status} wrote=${w.json.wrote}`);
	for (let i = 0; i < 20 && !seen.length; i++) await sleep(100);
	check(seen.length >= 1 && seen[0].path === REL, "**广播到了** `{t:\"page\", path}`", JSON.stringify(seen[0]?.path));
	check(String(seen[0]?.pageFingerprint ?? "").startsWith("sha256:"), "广播里带整页指纹（前端拿它决定要不要重读）", seen[0]?.pageFingerprint?.slice(0, 20) + "…");
	// 只读 op **不该**广播（否则"打开页面"都会触发重读）
	const n0 = seen.length;
	await getPage();
	await POST({ op: "outline", epub: "books/zhiwo-yubenwo.epub" }).catch(() => {});
	await sleep(300);
	check(seen.length === n0, "**只读**动作不广播（只有真的写了才推）", `${n0} → ${seen.length}`);
	sse.destroy();
	fs.writeFileSync(pageAbs, before3c);
	check(sha(fs.readFileSync(pageAbs, "utf8")) === sha(before3c), "（这一段自己收尾：把这一页恢复回写之前的样子）");
}

console.log("\n── 4. 材料化：真 epub → 4 段原文进 md（先 dryRun 看计划）──────────");
	const SECT = { level: 3, heading: "第二章 勒邦对集团心理的描述" };
	if (HAVE_EPUB) {
		const dry = await POST({ op: "materialize-source", path: REL, epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraphs: [3, 4, 5, 6], epubId: "自我与本我.epub", section: SECT, dryRun: true });
		check(dry.status === 200 && dry.json.wrote === false && dry.json.dryRun, "dryRun：只出计划、**不写**");
		check(sha(fs.readFileSync(pageAbs, "utf8")) === fileHash0, "dryRun 之后文件哈希没变");
		check(dry.json.plans.length === 4 && dry.json.extractions[2].srcId === "自我与本我.epub!part0004.xhtml#p5", "4 个计划（¶3–¶6）", dry.json.plans.map((p) => p.block?.srcId).join(", "));

		const wet = await POST({ op: "materialize-source", path: REL, epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraphs: [3, 4, 5, 6], epubId: "自我与本我.epub", section: SECT });
		check(wet.status === 200 && wet.json.wrote === true && wet.json.attempt === 1, "真写：一次成功", `attempt=${wet.json.attempt} bytes ${wet.json.bytes.before}→${wet.json.bytes.after}`);
		const page = await getPage();
		check(page.json.sources.length === 4, "页面里出现 4 个原文块", page.json.sources.map((s) => s.srcId.split("#")[1]).join(","));
		check(page.json.sources.every((s) => s.selfConsistent), "4 个块的**标记哈希都自洽**");
		check(page.json.sources[2].markerAttrs.stripped === "a=2,sup=2", "¶5 的留痕写在标记里（人类要的\"必须留痕\"）", JSON.stringify(page.json.sources[2].markerAttrs));
		check(page.json.errors.length === 0, "写完之后页面仍然解析零错误");
		check(page.json.sources.every((s) => s.markerAttrs.id === `src-${sha(s.srcId).slice(0, 16)}`), "每个源块都有一个**由 srcId 派生**的稳定 data-id（`src-<hash>`）", page.json.sources.map((s) => s.markerAttrs.id).join(","));
	}

	console.log("\n── 4b. 幂等：连点两次 / 三次都只许有一份（UI 按钮天然可连点）────────");
	if (HAVE_EPUB) {
		const M = (paragraphs) => ({ op: "materialize-source", path: REL, epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraphs, epubId: "自我与本我.epub", section: SECT });
		const bytes0 = fs.readFileSync(pageAbs, "utf8");
		const countOf = (page, p) => page.json.sources.filter((x) => x.srcId.endsWith(`#p${p}`)).length;

		// (a) 同一组 4 段再点两次
		const click2 = await POST(M([3, 4, 5, 6]));
		check(click2.status === 200 && click2.json.wrote === false, "（4 段）第二次连点 ⇒ **200 + wrote:false**（不写；不是失败）", `${click2.status} op=${click2.json.op}`);
		check(click2.json.op === "already-present", "并说清它做了什么：`op:already-present`", click2.json.op);
		check(Array.isArray(click2.json.outcomes) && click2.json.outcomes.length === 4 && click2.json.outcomes.every((o) => o.op === "already-present"), "逐段报出结局（4 段都是 already-present）", JSON.stringify(click2.json.outcomes?.map((o) => o.op)));
		const click3 = await POST(M([3, 4, 5, 6]));
		check(click3.status === 200 && click3.json.wrote === false && click3.json.op === "already-present", "第三次连点也一样（幂等）", `${click3.status} ${click3.json.op}`);
		const after = await getPage();
		check(after.json.sources.length === 4, "**页面里仍然只有 4 份**（不是 8 / 12 份）", `${after.json.sources.length} 份`);
		check(after.json.errors.length === 0, "**parsePage 零错误**（没有 duplicate-source-id）", JSON.stringify(after.json.errors.map((e) => e.code)));
		check(fs.readFileSync(pageAbs, "utf8") === bytes0, "连点之后文件**逐字节没变**");

		// (b) **真·复现**：单段连点（UI 那个按钮开一次、人再点一次的形状）
		//     为什么单段才复现：走 4 段时，第二段会在"已经把第一段插进去"的文本上撞出 duplicate-source-id，
		//     于是整批**提前失败、根本没落盘** —— 那是**碰巧**安全，不是幂等。
		const snap = fs.readFileSync(pageAbs, "utf8");
		const oneA = await POST(M([5]));
		const oneB = await POST(M([5]));
		const pageOne = await getPage();
		check(countOf(pageOne, 5) === 1, "（单段）连点两次后 ¶5 **只有一份**", `${countOf(pageOne, 5)} 份`);
		check(pageOne.json.errors.length === 0, "（单段）连点两次后 **parsePage 零错误**", JSON.stringify(pageOne.json.errors.map((e) => e.code)));
		check(oneA.status === 200 && oneA.json.wrote === false && oneA.json.op === "already-present", "（单段）第一次就说 already-present", `${oneA.status} ${oneA.json.op}`);
		check(oneB.status === 200 && oneB.json.wrote === false && oneB.json.op === "already-present", "（单段）第二次也说 already-present", `${oneB.status} ${oneB.json.op}`);
		fs.writeFileSync(pageAbs, snap);

		// (c) 情形 2：同 srcId 已存在、但正文不同 ⇒ 这是"重建"的活：**拒绝并指路**（绝不覆盖、也不许插第二份）
		const tampered = bytes0.replace("处在以上所谈的种种关系", "处在以上所述种种关系");
		check(tampered !== bytes0, "造出「正文被改」的情形");
		fs.writeFileSync(pageAbs, tampered);
		const diff = await POST(M([5]));
		check(diff.status === 409 && diff.json.error === "source-exists-different", "同 srcId 但正文不同 ⇒ **409 `source-exists-different`**（拒绝并指路）", `${diff.status} ${diff.json.error}`);
		check(String(diff.json.hint ?? "").includes("rebuild-source"), "把路指清楚（hint 里点名 `rebuild-source`）", String(diff.json.hint ?? "").slice(0, 56) + "…");
		check(Array.isArray(diff.json.outcomes) && diff.json.outcomes.some((o) => o.op === "refuse" && o.reason === "source-exists-different"), "逐段报出结局（这一段是 refuse）", JSON.stringify(diff.json.outcomes));
		const tamperedPage = await getPage();
		check(tamperedPage.json.sources.length === 4, "拒绝之后**没有插第二份**（仍是 4 份）", `${tamperedPage.json.sources.length} 份`);
		check(fs.readFileSync(pageAbs, "utf8") === tampered, "拒绝时零写入（被改的那份原样在）");
		// 指的那条路真的能走通
		const fixed = await POST({ op: "rebuild-source", path: REL, epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: 5, epubId: "自我与本我.epub" });
		check(fixed.status === 200 && fixed.json.op === "replace-source" && fixed.json.wrote === true, "按 hint 叫 `rebuild-source` 能修好", `${fixed.json.op} wrote=${fixed.json.wrote}`);
		const fixedPage = await getPage();
		check(fixedPage.json.sources.length === 4 && fixedPage.json.errors.length === 0, "修完仍然只有 4 份、零错误");
		const again = await POST(M([3, 4, 5, 6]));
		check(again.status === 200 && again.json.wrote === false && again.json.op === "already-present", "修完再连点 ⇒ 回到 already-present", `${again.status} ${again.json.op}`);
		// (d) 老块（S2 时代写的、没有 id）再材料化 ⇒ already-present，但**如实报** attrsDiffer
		const legacy = bytes0.replace(/ id="src-[0-9a-f]{16}"/, "");
		check(legacy !== bytes0, "造出一个「老块」（把某个源块的 id 抹掉）");
		fs.writeFileSync(pageAbs, legacy);
		const lpage = await getPage();
		check(lpage.json.sources.some((x) => x.id === null && x.idConsistent === null), "GET 如实报 id=null / idConsistent=null（老块照旧可读）", JSON.stringify(lpage.json.sources.map((x) => x.id)));
		const lclick = await POST(M([3, 4, 5, 6]));
		check(lclick.status === 200 && lclick.json.wrote === false && lclick.json.op === "already-present", "老块再材料化 ⇒ already-present（**不写**，不 \"顺手补个 id\"）", `${lclick.status} ${lclick.json.op}`);
		check(lclick.json.outcomes.some((o) => (o.attrsDiffer ?? []).includes("id")), "并如实报 `attrsDiffer:[\"id\"]`（账面上差一个键，说清而不是沉默）", JSON.stringify(lclick.json.outcomes.map((o) => o.attrsDiffer)));
		check(fs.readFileSync(pageAbs, "utf8") === legacy, "仍然零写入");

		// (e) 手改过的 id ⇒ GET 报 idConsistent:false，但**不**把页面判成错（不 brick）
		const wrongId = bytes0.replace(/ id="src-[0-9a-f]{16}"/, ' id="src-deadbeefdeadbeef"');
		check(wrongId !== bytes0, "造出「手改过的 id」");
		fs.writeFileSync(pageAbs, wrongId);
		const wpage = await getPage();
		check(wpage.json.errors.length === 0, "手改 id **不**让页面变成错误（没 brick）", JSON.stringify(wpage.json.errors.map((e) => e.code)));
		check(wpage.json.sources.some((x) => x.idConsistent === false), "但 GET 如实报 idConsistent:false（不静默）", JSON.stringify(wpage.json.sources.map((x) => x.idConsistent)));
		fs.writeFileSync(pageAbs, bytes0);
		check((await getPage()).json.sources.every((x) => x.idConsistent === true), "恢复之后 id 全部自洽");
	}

	console.log("\\n── 5. 真 epub 端到端：再抽一次 ⇒ **no-op（逐字节不写）**──────────");
	if (HAVE_EPUB) {
		const before = sha(fs.readFileSync(pageAbs, "utf8"));
		for (const n of [3, 4, 5, 6]) {
			const r = await POST({ op: "rebuild-source", path: REL, epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: n, epubId: "自我与本我.epub" });
			if (r.status !== 200 || r.json.op !== "no-op" || r.json.wrote !== false) {
				bad(`¶${n} 重抽应当是 no-op`, `${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
			}
		}
		if (!failed) ok("¶3–¶6 重抽全部 = `no-op` + `wrote:false`");
		const after = sha(fs.readFileSync(pageAbs, "utf8"));
		check(before === after, "**文件逐字节没变**（这就是\"原文可重建\"的判据在真 epub 上成立）", `${after.slice(0, 16)}…`);
		// 对照：改一个字就会真的写（否则上面那条 no-op 是"永远不写"的假象）
		const tmpPage = path.join(PAGES, "note", "勘误对照.md");
		fs.writeFileSync(tmpPage, fs.readFileSync(pageAbs, "utf8").replace(p5.text, p5.text.replace("个人", "各人")));
		const r2 = await POST({ op: "rebuild-source", path: "note/勘误对照.md", epub: "books/zhiwo-yubenwo.epub", file: "part0004.xhtml", paragraph: 5, epubId: "自我与本我.epub" });
		check(r2.status === 200 && r2.json.op === "replace-source" && r2.json.wrote === true, "**对照**：文件里那段被改过一个字 ⇒ 出 `replace-source` 并真写（证明 no-op 不是假的）", `${r2.json.op} wrote=${r2.json.wrote}`);
		const fixed = fs.readFileSync(tmpPage, "utf8");
		check(fixed.includes(p5.text) && !fixed.includes("各人"), "替换后与重抽结果一致（勘误被纠正）");
	} else {
		console.log("  – 跳过（没有真 epub）");
	}

	console.log("\n── 6. 挂段末插问题 / 改字段一行（在 API 上）──────────────────────");
	if (HAVE_EPUB) {
		const ins = await POST({ op: "insert-block", path: REL, sourceId: "自我与本我.epub!part0004.xhtml#p5", block: { kind: "问题", text: "Q4: 这三条原因之间是什么关系？" } });
		check(ins.status === 200 && ins.json.wrote === true, "挂段末插一个问题", `attempt=${ins.json.attempt}`);
		const page = await getPage();
		const lines = page.json.text.split("\n");
		const iQ = page.json.text.indexOf("Q4: 这三条原因之间是什么关系？");
		const src5 = page.json.sources.find((s) => s.srcId.endsWith("#p5"));
		check(iQ > 0, "问题进去了");
		const qLine = lines.findIndex((l) => l.startsWith("Q4: 这三条原因之间是什么关系？"));
		const gap = lines.slice(src5.range[1] + 1, qLine);
		check(qLine > src5.range[1] && gap.every((l) => l.trim() === ""), "它紧贴在 ¶5 后面（挂段末：中间只有空行）", `¶5 末行 ${src5.range[1]} → Q4 行 ${qLine}，中间 ${gap.length} 行都是空行`);
		check(iQ < page.json.text.indexOf("<!-- src: 自我与本我.epub!part0004.xhtml#p6"), "在 ¶6 之前（不会跑到下一段去）");

		const dup = await POST({ op: "insert-block", path: REL, sourceId: "自我与本我.epub!part0004.xhtml#p5", block: { kind: "助手追问", text: "助手追问：先只回答一点。", id: "asst-追问-1" } });
		const dup2 = await POST({ op: "insert-block", path: REL, sourceId: "自我与本我.epub!part0004.xhtml#p5", block: { kind: "助手追问", text: "助手追问：先只回答一点。", id: "asst-追问-1" } });
		check(dup.status === 200 && dup.json.wrote === true, "带 data-id 的助手块能插");
		check(dup2.status === 409 && dup2.json.error === "already-present", "同一个 data-id 再来一次 ⇒ 409 already-present（幂等）", `${dup2.status} ${dup2.json.error}`);
		const page2 = await getPage();
		check((page2.json.text.match(/先只回答一点/g) ?? []).length === 1, "文本里只有一份");

		const cur = page2.json.fields.find((f) => f.heading === "阅读位置");
		check(!!cur, "找到 阅读位置 字段");
		const rf = await POST({ op: "replace-field-line", path: REL, address: { section: null, heading: "阅读位置" }, match: "- 当前状态：", line: "- 当前状态：（经 API）第二个学习单元进行中。", expectedFingerprint: cur.fingerprint });
		check(rf.status === 200 && rf.json.wrote === true, "改指定字段的一行", `replacedLine=${rf.json.plan?.before?.range?.[0]}`);
		const page3 = await getPage();
		check(page3.json.text.includes("- 当前状态：（经 API）第二个学习单元进行中。"), "那一行换了");
		check(page3.json.text.includes("- 版本：弗洛伊德"), "同字段其他行一字未动");
		check(page3.json.text.includes("Q4: 这三条原因之间是什么关系？"), "之前的插入还在（写入不是整体重写）");
	}

	console.log("\n── 7. 写前重读 + 指纹校验（人类在中间改了字段）─────────────────────");
	{
		const page = await getPage();
		const cur = page.json.fields.find((f) => f.heading === "阅读位置");
		// 模拟：UI 读到指纹 F → 人说"我自己改一下" → UI 拿着 F 去提交
		const text = fs.readFileSync(pageAbs, "utf8");
		fs.writeFileSync(pageAbs, text.replace("- 本次阅读目的：", "- 本次阅读目的（我自己补的）："));
		const r = await POST({ op: "replace-field-line", path: REL, address: { section: null, heading: "阅读位置" }, match: "- 当前状态：", line: "- 当前状态：不该写进去。", expectedFingerprint: cur.fingerprint });
		check(r.status === 409 && r.json.error === "conflict", "字段在你读之后被改过 ⇒ **409 conflict**（绝不覆盖）", `${r.status} ${r.json.error}`);
		check(!fs.readFileSync(pageAbs, "utf8").includes("不该写进去。"), "拒绝时**一个字节都没写**");
		check(fs.readFileSync(pageAbs, "utf8").includes("- 本次阅读目的（我自己补的）："), "人的那处改动完好");
	}

	console.log("\n── 8. 锁 / 重试：同一个页面上两条并发写入都不许丢 ─────────────────");
	{
		const store = createPageStore({ root: PAGES, epubRoot: PAGES, lockDir: path.join(TMP, "locks"), lockTimeoutMs: 4000 });
		const before = fs.readFileSync(pageAbs, "utf8");
		const [a, b] = await Promise.all([
			store.apply(REL, { op: "insert-block", sourceId: "自我与本我.epub!part0004.xhtml#p3", block: { kind: "助手整理", text: "助手整理：并发甲。", id: "asst-整理-conc-a" } }),
			store.apply(REL, { op: "insert-block", sourceId: "自我与本我.epub!part0004.xhtml#p5", block: { kind: "助手整理", text: "助手整理：并发乙。", id: "asst-整理-conc-b" } }),
		]).catch((e) => [{ ok: false, reason: e.message }, { ok: false, reason: e.message }]);
		check(a.ok && b.ok, "两条并发写入都成功（拿锁 → 重读 → 重规划）", `attempts=${a.attempt},${b.attempt}`);
		const text = fs.readFileSync(pageAbs, "utf8");
		check(text.includes("并发甲。") && text.includes("并发乙。"), "**两条都留在文件里**（没有一条被撞掉）");
		check(text.length > before.length, "文件确实变长了");

		// 跨进程锁：手动占住锁文件 ⇒ 必须报 409，而不是"没锁也写"
		const busy = createPageStore({ root: PAGES, epubRoot: PAGES, lockDir: path.join(TMP, "locks"), lockTimeoutMs: 150 });
		const real = fs.realpathSync(pageAbs);
		const lockFile = path.join(TMP, "locks", `${sha(real).slice(0, 16)}.lock`);
		fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), target: real }));
		let err = null;
		try {
			await busy.apply(REL, { op: "insert-block", sourceId: "自我与本我.epub!part0004.xhtml#p3", block: { kind: "助手整理", text: "助手整理：不该写。" } });
		} catch (e) {
			err = e;
		}
		check(err instanceof PageError && err.status === 409 && err.reason === "page-locked", "锁被别人占着 ⇒ 409 page-locked", err ? err.reason : "（居然成功了）");
		check(!fs.readFileSync(pageAbs, "utf8").includes("不该写。"), "拿不到锁就**一个字节都不写**");

		// 陈旧锁（进程已经没了）⇒ 自动回收，不该永久卡住
		const stale = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		stale.pid = 999999; // 不存在的 pid
		fs.writeFileSync(lockFile, JSON.stringify(stale));
		const r = await busy.apply(REL, { op: "insert-block", sourceId: "自我与本我.epub!part0004.xhtml#p3", block: { kind: "助手整理", text: "助手整理：陈旧锁之后能写。", id: "asst-整理-stale" } });
		check(r.ok && r.wrote, "陈旧锁（死 pid）被自动回收 ⇒ 能写（不会永久卡死）");
		check(!fs.existsSync(lockFile), "写完之后锁文件被释放");
	}

	console.log("\n── 9. 原子写：不留垃圾、拒绝时不落盘 ─────────────────────────────");
	{
		const tmpFiles = () => fs.readdirSync(path.join(PAGES, "note")).filter((f) => f.includes(".sopho-tmp-"));
		check(tmpFiles().length === 0, "跑完没有 `.sopho-tmp-*` 残留", tmpFiles().join(",") || "（空）");
		const before = sha(fs.readFileSync(pageAbs, "utf8"));
		const bad1 = await POST({ op: "insert-block", path: REL, sourceId: "自我与本我.epub!part0004.xhtml#不存在", block: { kind: "助手整理", text: "x" } });
		check(bad1.status === 409 && bad1.json.error === "anchor-not-found", "锚点找不到 ⇒ 409", bad1.json.error);
		const bad2 = await POST({ op: "insert-block", path: REL, sourceId: "自我与本我.epub!part0004.xhtml#p3", block: { kind: "笔记", text: "助手想替你写笔记" } });
		check(bad2.status === 400 && bad2.json.error === "bad-block", "助手想插\"人写的区域\"的块 ⇒ 400（机制上堵死）", bad2.json.error);
		const bad3 = await POST({ op: "不认识的op", path: REL });
		check(bad3.status === 400, "不认识的 op ⇒ 400", bad3.json.error);
		const bad4 = await POST({ op: "insert-block", path: "note/does-not-exist.md", sourceId: "x", block: { kind: "助手整理", text: "x" } });
		check(bad4.status === 404, "页面不存在 ⇒ 404", bad4.json.error);
		check(sha(fs.readFileSync(pageAbs, "utf8")) === before, "这一串失败之后文件哈希没变");
		check(tmpFiles().length === 0, "失败也不留临时文件");
	}

	console.log("\n── 10. 热重载：改了存储层代码也能生效（不是\"静默跑旧代码\"）─────");
	{
		const r = await req("POST", "/reload-code");
		check(r.status === 200 && r.json.ok, "POST /reload-code 成功（A 没重启、会话不丢）", `v=${r.json.version}`);
		const after = await getPage();
		check(after.status === 200 && after.json.errors.length === 0, "重载后 GET /pages 照常работает（路由跟着逻辑层一起换）");
		const page = await getPage();
		check(page.json.sources.length >= 4, "重载后原文块还在（写的是文件，不是内存）", `${page.json.sources.length} 个`);
	}

{
	console.log("\n── 11. 人写的东西一字未动（在**真笔记**上全流程之后核一遍）───────");
	{
		const { parsePage, humanOwnedRanges } = await import("../server/reading-page.mjs");
		const orig = fs.readFileSync(HAVE_EPUB ? REAL_NOTE : path.join(PAGES, REL), "utf8");
		const now = fs.readFileSync(pageAbs, "utf8");
		const hb = humanOwnedRanges(parsePage(orig)).map((x) => x.text);
		const ha = humanOwnedRanges(parsePage(now)).map((x) => x.text);
		const subseq = (sub, arr) => {
			let i = 0;
			for (const x of arr) if (i < sub.length && sub[i] === x) i++;
			return i === sub.length;
		};
		if (fs.existsSync(REAL_NOTE) && orig === fs.readFileSync(REAL_NOTE, "utf8")) {
			check(subseq(hb, ha), `真笔记的 ${hb.length} 个人块（答案 / 读者段落）在写后仍**按序逐字节**都在`);
		} else {
			check(subseq(hb, ha), `原页的 ${hb.length} 个人块在写后仍按序逐字节都在`);
		}
		const before = parsePage(orig);
		const afterDoc = parsePage(now);
		const legacyLost = before.blocks.filter((b) => b.kind === "assistant").filter((b) => !now.includes(orig.split(/\r\n|\n/).slice(b.start, b.end + 1).join("\n")));
		check(legacyLost.length === 0, `原有 ${before.blocks.filter((b) => b.kind === "assistant").length} 个旧助手块逐字节仍在`);
		check(afterDoc.errors.length === 0, "最终页面解析零错误");
	}

	console.log("\n── 12. «按一下»：先落盘、再投递（真 HTTP + 真会话 + 本地假模型）──");
	const REL2 = REL;
	const sessOf = (id) => {
		const dir = path.join(HOME, "sessions");
		const f = fs.readdirSync(dir).find((x) => x.includes(id));
		return f ? { file: path.join(dir, f), text: fs.readFileSync(path.join(dir, f), "utf8") } : null;
	};
	const s = await req("POST", "/sessions", { name: "阅读测试" });
	check(s.status === 201 && s.json.id, "先建一条真会话（POST /sessions）", s.json.id);
	const sid = s.json.id;

	// (a) 第一次故意带错指纹 ⇒ 409，且**没写、没发**
	const page0 = await getPage();
	const ans0 = page0.json.blocks.find((b) => b.kind === "answer");
	check(!!ans0, "读到答案块（给「按一下」改的那块）", JSON.stringify(ans0.range));
	const disk0 = sha(fs.readFileSync(pageAbs, "utf8"));
	const badFp = await req("POST", "/pages/press", { path: REL2, sessionId: sid, edits: [{ range: ans0.range, text: "这条不该落盘。", expectedFingerprint: "sha256:0000", keepPrefix: true }] });
	check(badFp.status === 409 && badFp.json.error === "conflict", "指纹不符 ⇒ **409 conflict**", badFp.json.error);
	check(sha(fs.readFileSync(pageAbs, "utf8")) === disk0, "（a）没写一个字节");
	check(!(sessOf(sid)?.text ?? "").includes("这条不该落盘。"), "（a）也没投递");

	// (b) 正常「按一下」
	const r = await req("POST", "/pages/press", {
		path: REL2,
		sessionId: sid,
		edits: [{ range: ans0.range, text: "我重写了答案（按一下）。", expectedFingerprint: ans0.fingerprint, keepPrefix: true }],
	});
	check(r.status === 200 && r.json.saved.wrote === true, "**先落盘**：saved.wrote=true", JSON.stringify(r.json.saved?.bytes));
	check(r.json.delivered?.ok === true && r.json.delivered.sessionId === sid, "**再投递**：delivered.ok=true", JSON.stringify(r.json.delivered));
	const disk1 = fs.readFileSync(pageAbs, "utf8");
	check(disk1.includes("A: 我重写了答案（按一下）。"), "文件里真的多了我写的字");
	check(r.json.message.includes("我重写了答案（按一下）。"), "投递内容里有我这次改的块");
	check(r.json.message.includes(REL2) && r.json.message.includes(pageAbs), "投递内容里**指向那一页**（相对 + 绝对路径）", `${REL2} / …${pageAbs.slice(-18)}`);
	check(r.json.message.includes("不在你的上下文里"), "并且说清「页面内容不在你上下文里」");
	await sleep(2500);
	const sess = sessOf(sid);
	check((sess?.text ?? "").includes("【阅读页·按一下】"), "**会话真的收到了这条消息**（会话文件里有它）", sess?.file?.split("/").pop());
	check((sess?.text ?? "").includes("我重写了答案（按一下）。"), "而且带着我写的字");
	check((sess?.text ?? "").includes("收到。"), "假模型也回了话（说明这一轮真跑起来了）", `${modelHits.length} 次模型调用`);

	// (c) **连点两次**：第二次带着**同一个（陈旧的）行区间**再来一次 —— 这才是真·连点
	const nBefore = (sessOf(sid)?.text.match(/【阅读页·按一下】/g) ?? []).length;
	const click2 = await req("POST", "/pages/press", { path: REL2, sessionId: sid, edits: [{ range: ans0.range, text: "我重写了答案（按一下）。", expectedFingerprint: ans0.fingerprint, keepPrefix: true }] });
	check(click2.status === 200 && click2.json.saved.wrote === false && click2.json.delivered.reason === "nothing-new", "真·连点（陈旧指纹、同样文本）⇒ **200 + nothing-new**（不写、不投）", `${click2.status} wrote=${click2.json.saved?.wrote} ${click2.json.delivered?.reason}`);
	check(sha(fs.readFileSync(pageAbs, "utf8")) === sha(disk1), "（c）文件逐字节没变");
	await sleep(400);
	const nAfter = (sessOf(sid)?.text.match(/【阅读页·按一下】/g) ?? []).length;
	check(nAfter === nBefore, "**同一条没有投两遍**（会话文件里的次数没变）", `${nBefore} → ${nAfter}`);

	// (c2) 另一个形状：**行区间也变了**（读者把两块并成一块之类）⇒ 拒绝，同样不许重复投
	const page1 = await getPage();
	const rd1 = page1.json.blocks.filter((b) => b.kind === "reader").pop();
	const nBefore2 = (sessOf(sid)?.text.match(/【阅读页·按一下】/g) ?? []).length;
	const stale = await req("POST", "/pages/press", { path: REL2, sessionId: sid, edits: [{ range: [rd1.range[0], rd1.range[1] + 5], text: "行区间乱指。", keepPrefix: false }] });
	check(stale.status === 409, "行区间指错 ⇒ **409**（不是说「没找到就随便改一块」）", `${stale.status} ${stale.json?.error}`);
	check((sessOf(sid)?.text.match(/【阅读页·按一下】/g) ?? []).length === nBefore2, "（c2）也没有第二次投递");

	// (d) dryRun：算得出要发的字，但**不写也不发**
	const page2 = await getPage();
	const ans2 = page2.json.blocks.find((b) => b.kind === "answer");
	const dry = await req("POST", "/pages/press", { path: REL2, dryRun: true, sessionId: sid, edits: [{ range: ans2.range, text: "dry-run 的字。", expectedFingerprint: ans2.fingerprint, keepPrefix: true }] });
	check(dry.status === 200 && dry.json.saved.wrote === false && dry.json.saved.wouldWrite === true, "dryRun ⇒ wrote=false / wouldWrite=true", JSON.stringify({ wrote: dry.json.saved?.wrote, wouldWrite: dry.json.saved?.wouldWrite }));
	check(dry.json.message.includes("dry-run 的字。"), "dryRun 也算出了要发的字（调试面板用它）");
	check(dry.json.delivered?.reason === "dry-run", "dryRun 不投递", dry.json.delivered?.reason);
	check(sha(fs.readFileSync(pageAbs, "utf8")) === sha(disk1), "（d）文件逐字节没变");

	// (e) 没绑定时：**自动建一条会话并绑上**（首次按一下的代价，写进文档了）
	const other = "note/另一页.md";
	fs.copyFileSync(REAL_NOTE, path.join(PAGES, other));
	const p3 = await getPage2(other);
	const rd = p3.json.blocks.find((b) => b.kind === "reader");
	const auto = await req("POST", "/pages/press", { path: other, edits: [{ range: rd.range, text: "第一次按就先建了会话。", expectedFingerprint: rd.fingerprint, keepPrefix: false }] });
	check(auto.status === 200 && auto.json.delivered.ok === true && auto.json.delivered.created === true, "没绑定 ⇒ **自动建一条会话**再投", JSON.stringify(auto.json.delivered));
	check(auto.json.binding?.sessionId === auto.json.delivered.sessionId && auto.json.binding?.boundBy === "auto-created", "绑定落进了 sidecar", JSON.stringify(auto.json.binding));
	const sidecar = JSON.parse(fs.readFileSync(path.join(HOME, "reading-pages.json"), "utf8"));
	check(sidecar[other]?.sessionId === auto.json.delivered.sessionId, "`$ASSIST_HOME/reading-pages.json` 里真有这条绑定", Object.keys(sidecar).join(","));
	const autoId = auto.json.delivered.sessionId;
	const nAuto = (sessOf(autoId)?.text.match(/【阅读页·按一下】/g) ?? []).length;
	const againAuto = await req("POST", "/pages/press", { path: other, edits: [{ range: rd.range, text: "第一次按就先建了会话。", expectedFingerprint: rd.fingerprint, keepPrefix: false }] });
	check(againAuto.status === 409, "（陈旧 range）第二次按 ⇒ 409", `${againAuto.status} ${againAuto.json?.error}`);
	check((sessOf(autoId)?.text.match(/【阅读页·按一下】/g) ?? []).length === nAuto, "**没有第二次投递**（会话文件里的次数没变）", String(nAuto));
	const reread = (await getPage2(other)).json.blocks.find((b) => b.kind === "reader");
	const clean = await req("POST", "/pages/press", { path: other, edits: [{ range: reread.range, text: "第一次按就先建了会话。", expectedFingerprint: reread.fingerprint, keepPrefix: false }] });
	check(clean.status === 200 && clean.json.saved.wrote === false && clean.json.delivered.reason === "nothing-new", "重读后再按同一条 ⇒ **nothing-new**（不重复投，也不会再建一条会话）", `${clean.status} ${clean.json.delivered?.reason}`);

	// (f) 归档的会话：投递即复活（归档只是\"默认不显示\"）
	const arch = await req("POST", `/sessions/${sid}/archive`, {});
	check(arch.status === 200 && arch.json.archived === true, "先把绑定的会话归档", JSON.stringify(arch.json).slice(0, 80));
	const page3 = await getPage();
	const ans3 = page3.json.blocks.find((b) => b.kind === "answer");
	const rv = await req("POST", "/pages/press", { path: REL2, sessionId: sid, edits: [{ range: ans3.range, text: "归档之后又写了一句。", expectedFingerprint: ans3.fingerprint, keepPrefix: true }] });
	check(rv.status === 200 && rv.json.delivered.ok === true, "归档的会话照样能投（不静默失败）", JSON.stringify(rv.json.delivered));
	const tree = await req("GET", "/tree");
	const node = tree.json.nodes.find((n) => n.id === sid);
	check(node && node.archived === false, "投递把它**复活**了（/tree 里 archived=false）", JSON.stringify(node?.archived));

	// (g) 投递失败要**如实报**：绑一个不存在的会话 ⇒ 502，但字已经存住了
	const page4 = await getPage();
	const rd4 = page4.json.blocks.filter((b) => b.kind === "reader").pop();
	const ghost = await req("POST", "/pages/press", { path: REL2, sessionId: "00000000-0000-4000-8000-000000000999", edits: [{ range: rd4.range, text: "这次会存住但发不出去。", expectedFingerprint: rd4.fingerprint, keepPrefix: false }] });
	check(ghost.status === 502 && ghost.json.delivered.ok === false && ghost.json.delivered.reason === "session-missing", "绑的会话不在 ⇒ **502 session-missing**", `${ghost.status} ${ghost.json.delivered?.reason}`);
	check(ghost.json.saved.wrote === true, "而 `saved.wrote=true` —— **\"存了但没发出去\"说得清清楚楚**", JSON.stringify(ghost.json.saved?.wrote));
	check(fs.readFileSync(pageAbs, "utf8").includes("这次会存住但发不出去。"), "那处字**确实存住了**（没有被回滚）");
}
} finally {
	killChild();
	stubModel.close();
	fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} 阅读页 API 契约：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
