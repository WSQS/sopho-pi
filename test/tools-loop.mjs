#!/usr/bin/env node
/**
 * **真闭环**：人写 → 按一下 → agent 收到 → **它调 `page_ask` 把问题写回** → 页面上出现那个问题
 * （+ 回流：A 广播 `{t:"page"}`，订阅者收得到）。
 *
 * 为什么这么测：工具是**给 agent 用的**，所以"工具能不能用"只能在**一个真会话**里验。
 * 模型用**本地假端点**（OpenAI 兼容）**按剧本**回 tool_call —— 于是整条链路是真的，
 * 而"模型什么时候决定用工具"这件事被钉成确定的（那件事用真模型另跑，见报告）。
 *
 * 链路（每一环都是真的）：
 *   POST /pages/press → store.press()（落盘）→ deliver()（投递给会话）
 *     → pi 把消息交给模型（本地假端点）→ 模型回 `tool_calls: page_ask`
 *     → pi 执行插件里的 page_ask → 它 fetch `POST /pages`（**同一个服务端，一份实现**）
 *     → 页面里多出一道 Q → A 广播 `{t:"page", path, pageFingerprint}`
 *
 * 自足：自己起 A（随机端口）+ 临时 home + 临时可写根 + 临时 epub 副本；不碰活实例 / note 仓库 / 另一台机器。
 * 跑法：`node test/tools-loop.mjs`（`SOPHO_REAL_NOTE` / `SOPHO_REAL_EPUB` 可指夹具；不在就用造的）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// pi 的插件加载器位于包内一个**没有 exports 入口**的子路径上，只能从包根自己拼。
// （上游仓库这里原本写死了一台机器的绝对路径；开源快照改成可移植解析，换机器/换 node_modules 位置也能跑。）
function piLoaderUrl() {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	let dir = path.dirname(entry);
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json"))) break;
		const up = path.dirname(dir);
		if (up === dir) throw new Error("找不到 @earendil-works/pi-coding-agent 的包根");
		dir = up;
	}
	return pathToFileURL(path.join(dir, "dist/core/extensions/loader.js")).href;
}


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};
const check = (c, what, detail = "") => (c ? ok(what, detail) : bad(what, detail));

const REAL_NOTE = process.env.SOPHO_REAL_NOTE ?? "/tmp/note-gongdu.md";
const REAL_EPUB = process.env.SOPHO_REAL_EPUB ?? "/tmp/zhiwo-yubenwo.epub";

// ── 先验插件**能不能被 pi 自己解析**（踩过一次：jiti 收下了，pi 的加载器拒收）──────
// 为什么必须先验：插件解析失败时，会话**看不出任何异常** —— 模型只是拿不到工具
// （得到一句 "Tool page_ask not found"），而 `[plugin-watch]` 也不会报。这条 10 行的预检
// 把那种"静默失败"变成一句人话。（pi 用自己的 TS 解析器；`jiti` 的宽容度不一样，别拿它当判据。）
{
	const { discoverAndLoadExtensions } = await import(piLoaderUrl()).catch(() => ({}));
	if (typeof discoverAndLoadExtensions !== "function") {
		console.log("  – 跳过插件预检（拿不到 pi 的加载器模块）");
	} else {
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-extprobe-"));
		fs.mkdirSync(path.join(probe, "extensions", "assistant"), { recursive: true });
		fs.symlinkSync(path.join(ROOT, "pi-extensions/assistant/index.ts"), path.join(probe, "extensions", "assistant", "index.ts"));
		const r = await discoverAndLoadExtensions([], os.tmpdir(), probe, {});
		fs.rmSync(probe, { recursive: true, force: true });
		if ((r.errors ?? []).length || (r.extensions ?? []).length === 0) {
			console.error("✗ 插件**加载不起来**（pi 的解析器拒了它）—— 后面的用例都会以「Tool xxx not found」收场：");
			console.error(JSON.stringify(r.errors ?? [], null, 1).slice(0, 800));
			process.exit(1);
		}
		const pageReadDescription = String(r.extensions[0].tools.get("page_read")?.definition?.description ?? "");
		assert.ok(
			pageReadDescription.includes("工具仍是首选") &&
				["read", "bash", "edit", "write"].every((name) => pageReadDescription.includes(name)) &&
				pageReadDescription.includes("兜底") &&
				pageReadDescription.includes("GET /pages") &&
				pageReadDescription.includes("停下，如实报告"),
			"page_read 工具描述必须同时声明：工具优先 + 直接读写可兜底 + 直写后核对并在坏页时停下",
		);
		console.log(`  ✓ 插件预检：pi 能加载它，且工具描述钉住新口径（${(r.extensions ?? []).length} 个扩展，0 个错误）`);
	}
}

// ── 临时沙箱 ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-tools-"));
const HOME = path.join(TMP, "home");
const PAGES = path.join(TMP, "root");
const REL = "note/书.md";
fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true });
fs.mkdirSync(path.join(PAGES, "note"), { recursive: true });
fs.mkdirSync(path.join(PAGES, "books"), { recursive: true });
if (!fs.existsSync(REAL_NOTE)) {
	console.error(`✗ 找不到夹具 ${REAL_NOTE}`);
	process.exit(1);
}
fs.copyFileSync(REAL_NOTE, path.join(PAGES, REL));
const HAVE_EPUB = fs.existsSync(REAL_EPUB);
if (HAVE_EPUB) fs.copyFileSync(REAL_EPUB, path.join(PAGES, "books/自我与本我.epub"));

// 插件：沙箱 home 里那个 `extensions/assistant/index.ts` 必须指向**本工作树**的那份
fs.mkdirSync(path.join(HOME, "extensions", "assistant"), { recursive: true });
fs.symlinkSync(path.join(ROOT, "pi-extensions/assistant/index.ts"), path.join(HOME, "extensions", "assistant", "index.ts"));

// ── 假模型：按剧本回 tool_call ─────────────────────────────────────────
// 剧本从环境变量来（JSON）。`n` = 已经收到过几条 tool 结果 ⇒ 决定这一发是"继续调工具"还是"收尾说话"。
// 剧本：默认这份就是"一个正常陪读"的最小形状 —— 先看页面，再挂一道问题，再看一眼自己写的东西。
// 第二道问题（at:7）是**给编号做的回归**：同一个单元里连问两次，必须拿到 Q4、Q5，不许重号/回退到 Q1。
const DEFAULT_SCRIPT = [
	{ tool: "page_read", args: {} },
	{ tool: "page_ask", args: { at: 5, text: "（自动）请用你自己的话说说这一段在整章里的位置。" } },
	{ tool: "page_read", args: { question: "Q4" } },
	{ tool: "page_ask", args: { at: 7, text: "（自动）第二道：这一段和前一段的差别是什么？" } },
];
const script = JSON.parse(process.env.SOPHO_TOOLS_SCRIPT ?? JSON.stringify(DEFAULT_SCRIPT));
const modelCalls = [];
const toolResults = [];
const stub = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		let payload = {};
		try {
			payload = JSON.parse(body);
		} catch {
			/* 不是 JSON 也照答 */
		}
		const msgs = Array.isArray(payload.messages) ? payload.messages : [];
		const n = msgs.filter((m) => m.role === "tool").length;
		for (const m of msgs) if (m.role === "tool") toolResults.push(String(m.content ?? ""));
		modelCalls.push({ at: Date.now(), tools: msgs.filter((m) => m.role === "tool").length });
		const step = script[n];
		// ⚠️ pi 默认是**流式**请求（`stream:true`）⇒ 这里必须回 SSE，而且 tool_calls 要按 delta 拼。
		const asSSE = (msg, reason) => {
			const chunk = (delta, fin) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta, finish_reason: fin ?? null }] })}\n\n`;
			let out = chunk({ role: "assistant", content: msg.content ?? "" });
			if (msg.tool_calls) {
				for (const [i, tc] of msg.tool_calls.entries()) {
					out += chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] });
					out += chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] });
				}
			}
			out += chunk({}, reason);
			out += "data: [DONE]\n\n";
			return out;
		};
		const finish = (msg, reason) => {
			if (payload.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(asSSE(msg, reason));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "stub-1", choices: [{ index: 0, message: msg, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
		};
		if (step && step.tool) {
			finish({ role: "assistant", content: step.say ?? null, tool_calls: [{ id: `call_${n + 1}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }, "tool_calls");
		} else {
			finish({ role: "assistant", content: "收到。" }, "stop");
		}
	});
});
const STUB_PORT = await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(stub.address().port)));
fs.writeFileSync(
	path.join(HOME, "models.json"),
	JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-1", name: "Stub", reasoning: false, contextWindow: 200000, maxTokens: 8192 }] } } }, null, 1),
);
fs.writeFileSync(path.join(HOME, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", compaction: { enabled: false } }, null, 1));

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
	env: { ...process.env, ASSIST_HOME: HOME, SOPHO_AGENT_DIR: HOME, SOPHO_BASE_PORT: String(PORT), SOPHO_CWD: TMP, SOPHO_PAGE_ROOT: PAGES, SOPHO_EPUB_ROOT: PAGES, SOPHO_IDLE_TTL_MS: "120000" },
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
let SID = null; // 主会话 id（诊断用）
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
const killChild = () => {
	try {
		child.kill("SIGKILL");
	} catch {
		/* 已死 */
	}
};
process.on("exit", killChild);

/** 读某个会话的 .jsonl（诊断/断言都用它）。 */
const dumpSession = (id) => {
	try {
		const dir = path.join(HOME, "sessions");
		const f = fs.readdirSync(dir).find((x) => x.includes(id));
		return f ? fs.readFileSync(path.join(dir, f), "utf8") : "";
	} catch {
		return "";
	}
};

const req = (method, p, body) =>
	new Promise((res, rej) => {
		const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (x) => {
			const c = [];
			x.on("data", (d) => c.push(d));
			x.on("end", () => {
				const raw = Buffer.concat(c).toString("utf8");
				let j = null;
				try {
					j = JSON.parse(raw);
				} catch {
					/* 非 JSON */
				}
				res({ status: x.statusCode, json: j, raw });
			});
		});
		r.on("error", rej);
		if (data) r.write(data);
		r.end();
	});
const POST = (p, b) => req("POST", p, b);
const GET = (p) => req("GET", p);

/** 订阅树级 SSE，收 `{t:"page"}`（回流）。⚠️ 必须等 A 起来之后再连（否则 ECONNREFUSED）。 */
const pageEvents = [];
let sseReq = null;
const subscribePages = () => {
	sseReq = http.request({ host: "127.0.0.1", port: PORT, path: "/events", method: "GET" }, (r) => {
	let buf = "";
	r.on("data", (d) => {
		buf += d.toString("utf8");
		for (const line of buf.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			try {
				const m = JSON.parse(line.slice(6));
				if (m.t === "page") pageEvents.push(m);
			} catch {
				/* 半行 */
			}
		}
		buf = buf.slice(buf.lastIndexOf("\n") + 1);
	});
	});
	sseReq.on("error", () => {
		/* A 没了就算了；这一条不该把测试搞挂 */
	});
	sseReq.end();
};

try {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await GET("/host");
			if (r.status === 200) break;
		} catch {
			/* 还没起来 */
		}
		await sleep(200);
	}
	await sleep(300);
	assert.ok((await GET("/host")).status === 200, `A 没起来：\n${logs}`);
	subscribePages();

	console.log("── 0. 造一条会真跑的会话 ───────────────────────────────────────");
	const s = await POST("/sessions", { name: "阅读测试" });
	check(s.status === 201 && s.json.id, "建了一条会话", s.json.id);
	const sid = s.json.id;
	SID = sid;
	const sessOf = () => dumpSession(sid);

	console.log("\n── 0b. 先把要讨论的那几段原文材料化进来（UI 上就是「贴原文」那一步）──");
	if (HAVE_EPUB) {
		const mat = await POST("/pages", { op: "materialize-source", path: REL, epub: "books/自我与本我.epub", file: "part0004.xhtml", paragraphs: [3, 4, 5, 6, 7], epubId: "自我与本我.epub", section: { level: 3, heading: "第二章 勒邦对集团心理的描述" } });
		check(mat.status === 200 && mat.json.wrote === true, "材料化了 ¶3–¶6", `${mat.json.saved?.plans?.length ?? 0} 个计划`);
		const pg = (await GET(`/pages?path=${encodeURIComponent(REL)}`)).json;
		check(pg.sources.length === 5, "页面里有了 5 个原文块（srcId 里带着「哪本书哪一段」）", pg.sources.map((x) => x.srcId.split("#")[1]).join(","));
		check(!!pg.binding?.epub, "绑定 sidecar 里记下了 epub 的根内路径（工具靠它找书）", String(pg.binding?.epub));
	} else {
		check(false, "没有 epub 夹具 ⇒ 闭环没法跑（page_ask 靠 srcId 定锚点）");
	}

	console.log("\n── 1. 人写一段 → 按一下 → 会话收到（S3 已有，这里验它仍然通）──");
	const page0 = (await GET(`/pages?path=${encodeURIComponent(REL)}`)).json;
	const ans = page0.blocks.find((b) => b.kind === "answer");
	check(!!ans, "读到答案块", JSON.stringify(ans.range));
	const press = await POST("/pages/press", { path: REL, sessionId: sid, edits: [{ range: ans.range, text: "（按一下写的）我对这一段的理解是……", expectedFingerprint: ans.fingerprint, keepPrefix: true }] });
	check(press.status === 200 && press.json.saved?.wrote === true && press.json.delivered?.ok === true, "按一下：先落盘、再投递", `${press.status} wrote=${press.json.saved?.wrote} delivered=${press.json.delivered?.ok}`);
	check(pageEvents.length >= 1 && pageEvents[0].path === REL, "回流：A 广播了 `{t:\"page\"}`", JSON.stringify(pageEvents[0]?.path));
	// **按块发送**（S3.3）：点某一块的按钮 ⇒ 投出去的那条消息里**只有这一块**的改动
	// （前端一次只放一条 edit；这里从"投递出去的字"这一端复核：`▸` 只该出现一次）
	{
		const line = [...(sessOf().match(/【阅读页·按一下】[^"]*?(?=页面：)/g) ?? [])].pop() ?? "";
		const n = (line.match(/▸ /g) ?? []).length;
		check(n === 1, "投出去的正文里**只有一条 `▸`**（= 只这一块的改动）", `▸ × ${n}`);
		check(line.includes("（按一下写的）"), "而它正是我写进那一块的字", (line.match(/▸[^\n]*/) ?? [""])[0].slice(0, 40));
	}

	console.log("\n── 2. agent 调工具把问题写回（这一条是本次的主判据）────────────────");
	// 剧本：让"读起来像人"的那个问题挂到 **第 5 段**（段号，不是行号）
	const askStep = script.find((x) => x.tool === "page_ask");
	check(!!askStep, "剧本里安排了 page_ask", JSON.stringify(askStep?.args));
	const waitUntil = async (fn, ms = 25000, step = 250) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (await fn()) return true;
			await sleep(step);
		}
		return false;
	};
	const gotQuestion = await waitUntil(() => fs.readFileSync(path.join(PAGES, REL), "utf8").includes(String(askStep.args.text).slice(0, 12)));
	check(gotQuestion, "**页面上出现了 agent 写回的那道题**", `等了 ${modelCalls.length} 次模型调用`);
	const after = fs.readFileSync(path.join(PAGES, REL), "utf8");
	check(after.includes("Q4:"), "它是作为一道**新问题**（Q 编号自动取了本单元的下一个）写进去的", (after.match(/Q\d+:/g) ?? []).join(","));
	check(after.includes("A:\n") || /Q4:[\s\S]{0,400}?\n\nA:/.test(after), "并且**答案位留空**（等他回应）");
	const q4idx = after.indexOf("Q4:");
	const srcAnchor = after.lastIndexOf("#p5", q4idx);
	const p6 = after.indexOf("#p6", q4idx - 200) >= 0 ? after.indexOf("<!-- src:", q4idx) : -1;
	check(srcAnchor > 0 && srcAnchor < q4idx && p6 > q4idx, "它挂在 **¶5 那一段的段末**（在那段原文之后、下一段原文之前）", `原文标记在 ${srcAnchor}，问题在 ${q4idx}，下一段在 ${p6}`);
	check((await GET(`/pages?path=${encodeURIComponent(REL)}`)).json.errors.length === 0, "写完之后页面仍然解析零错误");
	check((await GET(`/pages?path=${encodeURIComponent(REL)}`)).json.sources.length === 5, "原文块仍然是 5 份（工具没有把页面搞乱）");

	// 同一个单元里**连问两次**：编号必须往后走（Q4 → Q5），不许重号、也不许掉回 Q1
	const wantQ5 = await waitUntil(() => /Q5:/.test(fs.readFileSync(path.join(PAGES, REL), "utf8")), 25000);
	check(wantQ5, "同一单元里第二道问题拿到 **Q5**（编号跟着「这一段所属的单元」走）", ((fs.readFileSync(path.join(PAGES, REL), "utf8").match(/Q\d+:/g) ?? []).join(",")));
	// 注意：这一页本来就有**两个单元**，每个单元各有 Q1/Q2/Q3（那是既有内容，不是重号）。
	// 所以"没有重号"只能在**同一个单元里**成立 —— 看最后那个单元。
	const pageNow = fs.readFileSync(path.join(PAGES, REL), "utf8");
	const lastUnit = pageNow.split(/^## /m).pop() ?? "";
	const unitLabels = (lastUnit.match(/^Q(\d+):/gm) ?? []).map((x) => Number(x.replace(/\D/g, "")));
	check(
		new Set(unitLabels).size === unitLabels.length && unitLabels.join(",") === "1,2,3,4,5",
		"**这个单元里**编号连续且不重号（1,2,3 → 新加的 4、5）",
		unitLabels.join(","),
	);

	console.log("\n── 3. 回流：工具写的那一下也广播了 ─────────────────────────────");
	const pageEvent2 = await waitUntil(() => pageEvents.length >= 2);
	check(pageEvent2, "订阅者又收到一条 `{t:\"page\"}`（前端靠它不刷新就能看到）", `${pageEvents.length} 条`);
	check(String(pageEvents[pageEvents.length - 1].pageFingerprint).startsWith("sha256:"), "广播里带**整页指纹**（前端拿它决定要不要重读）", pageEvents[pageEvents.length - 1].pageFingerprint?.slice(0, 20) + "…");

	console.log("\n── 4. 工具真的走通了（模型看到的结果）──────────────────────────");
	const allToolResults = toolResults.join("\n");
	check(/已在 .*#p5 的段末挂上「Q4」/.test(allToolResults), "工具返回给模型的话里说清了它写了什么", (allToolResults.match(/已在[^\n]*/) ?? [""])[0].slice(0, 70));
	check(!/连不上会话基底|not found|Unknown tool|page_ask 不存在/.test(allToolResults), "没有\"工具不存在 / 连不上基底\"这类错", allToolResults.slice(0, 120).replace(/\n/g, " "));

	console.log("\n── 5. 会话文件里的痕迹（真跑起来了的证据）──────────────────────");
	const sess = sessOf();
	check(sess.includes("【阅读页·按一下】"), "会话文件里有那条投递的消息");
	check(/page_ask/.test(sess), "会话文件里记着它调了 `page_ask`");
	check(modelCalls.length >= 2, "模型被调了至少两次（先要工具、再收尾）", `${modelCalls.length} 次`);

	console.log("\n── 6. 非阅读会话：工具不该冒出来（gating 的兜底）────────────────");
	const t = await POST("/sessions", { name: "普通会话" });
	const tid = t.json.id;
	await sleep(200);
	const before = toolResults.length;
	await POST(`/sessions/${tid}/message`, { text: "试一下 page_read。" });
		const waited = await waitUntil(() => toolResults.length > before, 20000);
	if (!waited) console.log("── 诊断（普通会话）：\n" + dumpSession(tid).slice(-1200));
	const last = toolResults[toolResults.length - 1] ?? "";
	check(waited, "（假模型在普通会话里也照剧本要调工具）", `${toolResults.length} 条工具结果`);
	check(
		/没有绑定任何阅读页|not found|not available|unknown tool|不存在|no such tool/i.test(last),
		"普通会话里那个工具**要么不激活（pi 说 not found）、要么明确说\"没绑定阅读页\"** —— 两条兜底都算过关",
		last.slice(0, 100).replace(/\n/g, " "),
	);
} catch (e) {
	bad("测试跑挂了", String(e?.stack ?? e).split("\n").slice(0, 4).join(" | "));
} finally {
	if (failed) {
		// 红的时候把现场贴出来（不红不吵）
		console.log("\n── 诊断：A 的日志尾 ──\n" + logs.slice(-2500));
		console.log("── 诊断：模型看到的工具结果 ──\n" + JSON.stringify(toolResults).slice(0, 1200));
		console.log("── 诊断：会话文件里的痕迹 ──\n" + dumpSession(SID).slice(-1500));
	}
	killChild();
	sseReq?.destroy();
	stub.close();
	fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} 阅读页工具闭环：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
