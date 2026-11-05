#!/usr/bin/env node
/**
 * 契约测试：**「用户和 agent 都能看/操作 cwd」这一版**。
 *
 * 覆盖：
 *   · `cwd` 工具（**只读**）：报当前 cwd + 目录事实（存在/可写 / git / AGENTS.md / worktree）+
 *     最近用过（读 `GET /cwd-recents`）。**造正反例目录**（真 git repo / 非 git / 只读 / worktree）。
 *   · `session_new(cwd, name?, firstMessage?)` 工具：**真建出会话**、`parent` 正确、`firstMessage` 真收到。
 *     走**假模型按剧本回 tool_call**（和 `test/tools-loop.mjs` 同一个办法）⇒ 整条链路是真的，
 *     而「模型什么时候决定用工具」这件事被钉死。
 *   · `/cwd` 命令：无参（显示 cwd + 最近用过）/ 带参（在别的目录**新开**一条会话）/ 补全
 *     （`getArgumentCompletions`：子目录 + 最近用过）
 *   · **扩展消息在网页里可见**（`GET /sessions/{id}/messages` 的 `extras`）—— 这是本轮新加的字段，
 *     它的**不变量**单独有一节：加 custom_message **不许**改变 `messages`（逐字）与 `compaction.atIndex`。
 *   · `GET /sessions/{id}/commands` 里能看到 `/cwd`（= 网页命令面板里敲得到）。
 *
 * 自足：自己起一台 A（`server/base.mjs` 子进程，随机端口、临时 home、临时目录树）；假模型是本地
 * OpenAI 兼容端点。**不碰活实例（7331/7321 一律不碰）、不碰真实 `$ASSIST_HOME`**。
 *
 * 跑法：npm run test:cwd
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

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

// ── 临时目录树：正反例都在这里 ──────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-cwd-"));
const HOME = path.join(TMP, "home");
const GIT = path.join(TMP, "repo"); // 真 git 仓库（有 AGENTS.md、干净）
const PLAIN = path.join(TMP, "plain"); // 非 git、无 AGENTS.md（可写）
const RO = path.join(TMP, "readonly"); // 存在但不可写
const WT = path.join(TMP, "wt"); // GIT 的 worktree
const CLEAN = path.join(TMP, "clean"); // 存在、且**还没有任何会话**（验守卫的放行那一路）
const NOPE = path.join(TMP, "does-not-exist");
fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true });
fs.mkdirSync(GIT, { recursive: true });
fs.mkdirSync(PLAIN, { recursive: true });
fs.mkdirSync(RO, { recursive: true });
fs.mkdirSync(CLEAN, { recursive: true });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git(GIT, ["init", "-q"]);
git(GIT, ["config", "user.email", "t@t"]);
git(GIT, ["config", "user.name", "t"]);
fs.writeFileSync(path.join(GIT, "AGENTS.md"), "# 测试用 AGENTS.md\n");
fs.writeFileSync(path.join(GIT, "a.txt"), "hi\n");
fs.mkdirSync(path.join(GIT, "sub", "deep"), { recursive: true }); // 补全要能列出子目录
git(GIT, ["add", "-A"]);
git(GIT, ["commit", "-q", "-m", "init"]);
git(GIT, ["worktree", "add", "-q", WT, "-b", "wt/one"]);
fs.chmodSync(RO, 0o555); // 不可写（我们是普通用户，chmod 挡得住）

// 插件：沙箱 home 里那份 `extensions/assistant/index.ts` 指向**本工作树**的实现
fs.mkdirSync(path.join(HOME, "extensions", "assistant"), { recursive: true });
fs.symlinkSync(path.join(ROOT, "pi-extensions/assistant/index.ts"), path.join(HOME, "extensions", "assistant", "index.ts"));

// ── 「extras 不变量」用的两条人造会话：有 / 没有 custom_message ─────────────
const ID_WITH = "01a0b001-0000-7000-8000-000000000001";
const ID_WITHOUT = "01a0b002-0000-7000-8000-000000000002";
const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
const mkSession = (id, withCustom) => {
	const lines = [
		{ type: "session", version: 3, id, timestamp: iso(100), cwd: TMP, parentSession: null },
		{ type: "message", id: "m1", parentId: null, timestamp: iso(90), message: { role: "user", content: [{ type: "text", text: "压缩边界之前这一条" }] } },
	];
	if (withCustom)
		lines.push({
			type: "custom_message",
			id: "c1",
			parentId: "m1",
			timestamp: iso(80),
			customType: "sopho-cwd",
			content: "【/cwd】这是扩展写的一条输出",
			display: true,
		});
	lines.push(
		{ type: "message", id: "m2", parentId: withCustom ? "c1" : "m1", timestamp: iso(70), message: { role: "assistant", content: [{ type: "text", text: "压缩边界之后这一条" }] } },
		{ type: "compaction", id: "cp", parentId: "m2", timestamp: iso(60), firstKeptEntryId: "m2", tokensBefore: 1234, summary: "（摘要）" },
		{ type: "custom_message", id: "c2", parentId: "cp", timestamp: iso(50), customType: "sopho-hidden", content: "这条 display=false，不该出现", display: false },
	);
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
};
fs.writeFileSync(path.join(HOME, "sessions", `2026-01-01T00-00-00-000Z_${ID_WITH}.jsonl`), mkSession(ID_WITH, true));
fs.writeFileSync(path.join(HOME, "sessions", `2026-01-01T00-00-00-000Z_${ID_WITHOUT}.jsonl`), mkSession(ID_WITHOUT, false));

// ── 假模型（OpenAI 兼容，按剧本回 tool_call）────────────────────────────
const CHILD_MARKER = "【子会话测试】";
const script = [
	{ tool: "cwd", args: {} },
	{ tool: "session_new", args: { cwd: PLAIN, name: "子会话测试", firstMessage: `${CHILD_MARKER}你好` } },
];
const toolResults = [];
const modelCalls = [];
const stub = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		let payload = {};
		try {
			payload = JSON.parse(body);
		} catch {
			/* 非 JSON 也照答 */
		}
		const msgs = Array.isArray(payload.messages) ? payload.messages : [];
		for (const m of msgs) if (m.role === "tool") toolResults.push(String(m.content ?? ""));
		modelCalls.push(msgs.length);
		const lastUser = [...msgs].reverse().find((m) => m.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const nTool = msgs.filter((m) => m.role === "tool").length;
		// 子会话：只要一句收尾，别再调工具（免得把主会话的剧本吃乱）
		const step = userText.includes(CHILD_MARKER) ? null : script[nTool];
		const asSSE = (msg, reason) => {
			const chunk = (delta, fin) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta, finish_reason: fin ?? null }] })}\n\n`;
			let out = chunk({ role: "assistant", content: msg.content ?? "" });
			if (msg.tool_calls)
				for (const [i, tc] of msg.tool_calls.entries()) {
					out += chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] });
					out += chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] });
				}
			out += chunk({}, reason ?? "stop");
			out += "data: [DONE]\n\n";
			return out;
		};
		const msg = step
			? { role: "assistant", content: "", tool_calls: [{ id: `call_${step.tool}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
			: { role: "assistant", content: "收到。" };
		if (payload.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(asSSE(msg));
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "stub-1", choices: [{ index: 0, message: msg, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
		}
	});
});
const STUB_PORT = await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(stub.address().port)));
fs.writeFileSync(
	path.join(HOME, "models.json"),
	JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-1", name: "Stub", reasoning: false, contextWindow: 100000, maxTokens: 4096 }] } } }, null, 1),
);
fs.writeFileSync(path.join(HOME, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", compaction: { enabled: false } }, null, 1));

// ── 起 A（随机端口）────────────────────────────────────────────────────
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
	env: { ...process.env, ASSIST_HOME: HOME, SOPHO_AGENT_DIR: HOME, SOPHO_BASE_PORT: String(PORT), SOPHO_CWD: TMP, SOPHO_IDLE_TTL_MS: "60000" },
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
const killChild = () => {
	try {
		child.kill("SIGKILL");
	} catch {
		/* 已经死了 */
	}
};
process.on("exit", killChild);

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
const GET = (p) => req("GET", p);
const POST = (p, b) => req("POST", p, b);
const waitUntil = async (fn, ms = 20000, step = 200) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(step);
	}
	return false;
};

const cleanup = () => {
	killChild();
	try {
		fs.chmodSync(RO, 0o755);
	} catch {
		/* 已经没了 */
	}
	try {
		git(GIT, ["worktree", "remove", "--force", WT]);
	} catch {
		/* 尽力而为 */
	}
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 尽力而为 */
	}
};

try {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await GET("/host")).status === 200) break;
		} catch {
			/* 还没起来 */
		}
		await sleep(200);
	}
	assert.ok((await GET("/host")).status === 200, `A 没起来：\n${logs}`);

	// ── 1. /cwd-recents：空账 → 建会话后记账（原子写，一个写者）────────────
	console.log("── 1. GET /cwd-recents + 建会话时记账 ─────────────────────────");
	const empty = await GET("/cwd-recents");
	check(empty.status === 200 && Array.isArray(empty.json.recents), "GET /cwd-recents 通了", JSON.stringify(empty.json));
	check(empty.json.recents.length === 0 && empty.json.exists === false, "刚开始是空账（exists:false，不是错误）", JSON.stringify(empty.json));

	const s1 = await POST("/sessions", { cwd: GIT, name: "看 cwd 的主会话" });
	check(s1.status === 201 && s1.json.id, "在 git 目录建了一条主会话", s1.json.id);
	const SID = s1.json.id;
	const rec1 = await GET("/cwd-recents");
	check(rec1.json.recents.some((r) => r.path === GIT && r.count >= 1), "建会话后 git 目录进了「最近用过」", JSON.stringify(rec1.json.recents));
	check(!fs.readdirSync(HOME).some((f) => f.startsWith("cwd-recents.json.tmp-")), "没有留下 .tmp- 残留（原子写的中间文件被 rename 走了）", fs.readdirSync(HOME).join(","));

	// ── 2. 命令清单里能看到 /cwd（= 网页命令面板里敲得到）────────────────
	console.log("\n── 2. GET /sessions/{id}/commands 里能看到 /cwd ───────────────");
	const cmds = await GET(`/sessions/${SID}/commands`);
	const cwdCmd = (cmds.json?.commands ?? []).find((c) => c.name === "cwd");
	check(!!cwdCmd, "命令清单里有 /cwd", JSON.stringify((cmds.json?.commands ?? []).map((c) => c.name)));
	check(cwdCmd?.source === "extension" && cwdCmd?.runnable === true, "/cwd 是扩展命令且标注可跑", JSON.stringify({ source: cwdCmd?.source, runnable: cwdCmd?.runnable, via: cwdCmd?.via }));
	check(/新开一条会话|not moving|搬家/.test(cwdCmd?.description ?? "") || /新开/.test(cwdCmd?.description ?? ""), "描述里说清了「是在别处新开会话」", String(cwdCmd?.description).slice(0, 60));

	// ── 3. extras 不变量：custom_message 不进 messages、不动 atIndex ────────
	console.log("\n── 3. extras 不变量（加 custom_message 不许动 messages / atIndex）──");
	const a = (await GET(`/sessions/${ID_WITH}/messages`)).json;
	const b = (await GET(`/sessions/${ID_WITHOUT}/messages`)).json;
	check(Array.isArray(a.messages) && a.messages.length === 2, "带 custom_message 的会话 messages 还是 2 条（没被塞进去）", `len=${a.messages?.length}`);
	check(JSON.stringify(a.messages) === JSON.stringify(b.messages), "messages 与「不含 custom_message」的那份**逐字相同**", `a=${JSON.stringify(a.messages).slice(0, 80)}`);
	check(a.compaction?.atIndex === b.compaction?.atIndex && a.compaction?.atIndex === 1, "compaction.atIndex 相同（都指向第 1 条，没被挤动）", `with=${a.compaction?.atIndex} without=${b.compaction?.atIndex}`);
	check(a.messages[a.compaction.atIndex]?.parts?.[0]?.text === "压缩边界之后这一条", "atIndex **指向的还是同一条消息**（拿边界两侧的文本核，不比数字）", a.messages[a.compaction.atIndex]?.parts?.[0]?.text);
	check(Array.isArray(a.extras) && a.extras.length === 1 && a.extras[0].customType === "sopho-cwd", "新字段 extras 里有那条扩展消息、且看得出是谁发的", JSON.stringify(a.extras));
	check(!a.extras.some((x) => x.customType === "sopho-hidden"), "display:false 的那条照旧丢掉（不进 extras）", JSON.stringify(a.extras.map((x) => x.customType)));
	check(Array.isArray(b.extras) && b.extras.length === 0, "不含 custom_message 的会话 extras 是空的", JSON.stringify(b.extras));

	// ── 4. 假模型按剧本走：cwd 工具 + session_new 工具（真建会话）──────────
	console.log("\n── 4. agent 用 session_new 去别的目录开会话（真链路）─────────────");
	const kick = await POST(`/sessions/${SID}/message`, { text: "先看你在哪个目录，再去 plain 目录开一条会话把上面那句话转给它的模型。" });
	check(kick.status === 202, "kickoff 被接受", `${kick.status}`);
	const ran = await waitUntil(() => toolResults.length >= 2, 30000);
	check(ran, "模型真的调到了两个工具（cwd → session_new）", `toolResults=${toolResults.length} modelCalls=${modelCalls.length}`);
	const cwdOut = toolResults.find((t) => t.includes("本会话的工作目录"));
	check(!!cwdOut && cwdOut.includes(GIT), "cwd 工具报出了本会话的工作目录", String(cwdOut).slice(0, 80).replace(/\n/g, " "));
	check(/git 仓库：是/.test(cwdOut ?? "") && /未提交=0/.test(cwdOut ?? ""), "cwd 工具报出了 git 事实（是仓库、未提交=0）", (cwdOut ?? "").match(/git 仓库：[^\n]*/)?.[0]);
	check(/AGENTS\.md：有/.test(cwdOut ?? ""), "cwd 工具报出了 AGENTS.md 存在", (cwdOut ?? "").match(/AGENTS\.md：[^\n]*/)?.[0]);
	check(/worktree：否/.test(cwdOut ?? ""), "cwd 工具报出这不是 worktree", (cwdOut ?? "").match(/worktree：[^\n]*/)?.[0]);
	check(/不能改|只读|不支持就地改/.test(cwdOut ?? ""), "cwd 工具**明说**它不能改 cwd（不假装能搬这家）", (cwdOut ?? "").match(/[^\n]*不支持就地改[^\n]*/)?.[0]?.slice(0, 60) ?? "");

	const newOut = toolResults.find((t) => t.includes("新开一条会话："));
	check(!!newOut, "session_new 的返回值里带了新会话 id", String(newOut).slice(0, 90).replace(/\n/g, " "));
	const childId = String(newOut ?? "").match(/新开一条会话：([0-9a-f-]{36})/)?.[1] ?? null;
	check(!!childId, "解析出了新会话 id", childId);

	// 亲子关系 + cwd：从 /tree 核
	const tree = (await GET("/tree")).json;
	const cnode = (tree.nodes ?? []).find((n) => n.id === childId);
	check(!!cnode, "树上真多了一条会话", childId);
	check(cnode?.parent === SID, "它的 parent 正是那条主会话（不是凭空建的）", `parent=${cnode?.parent}`);
	check(cnode?.cwd === PLAIN, "它的 cwd 就是指定的 plain 目录", String(cnode?.cwd));

	// firstMessage 真到了孩子那里
	const childMsgs = await GET(`/sessions/${childId}/messages`);
	const childText = JSON.stringify(childMsgs.json?.messages ?? []);
	check(childText.includes(CHILD_MARKER), "firstMessage 真的进了子会话（能读到那行字）", childText.includes(CHILD_MARKER) ? "found" : childText.slice(0, 120));
	const rec2 = await GET("/cwd-recents");
	check(rec2.json.recents.some((r) => r.path === PLAIN), "session_new 用的目录也进了「最近用过」", JSON.stringify(rec2.json.recents.map((r) => [r.path.split("/").pop(), r.count])));

	// ── 5. /cwd 命令：无参 / 带参 / 坏路径 ─────────────────────────────
	console.log("\n── 5. /cwd 命令（无参 / 带参 / 坏路径）───────────────────────");
	const cmdNoArg = await POST(`/sessions/${SID}/message`, { text: "/cwd" });
	check(cmdNoArg.status === 202, "发了 `/cwd`（无参）", `${cmdNoArg.status}`);
	const gotExtra = await waitUntil(async () => {
		const m = (await GET(`/sessions/${SID}/messages`)).json;
		return (m.extras ?? []).some((x) => x.customType === "sopho-cwd" && x.text.includes("当前工作目录"));
	}, 10000);
	check(gotExtra, "无参 /cwd 的输出进了 extras（= 网页里看得到）", "");
	const exText = ((await GET(`/sessions/${SID}/messages`)).json.extras ?? []).find((x) => x.text.includes("当前工作目录"))?.text ?? "";
	check(exText.includes(GIT), "无参输出里有当前 cwd", exText.split("\n")[0]?.slice(0, 60));
	check(exText.includes("最近用过"), "无参输出里有「最近用过」那一节", "");
	check(/不是.*搬家|新开一条会话/.test(exText), "无参输出里说清了「换目录 = 新开一条会话，不是搬家」", (exText.match(/[^\n]*搬家[^\n]*/) ?? [""])[0].slice(0, 80));

	const before = (await GET("/tree")).json.nodes.length;
	const cmdArg = await POST(`/sessions/${SID}/message`, { text: `/cwd ${PLAIN}` });
	check(cmdArg.status === 202, "发了 `/cwd <path>`", `${cmdArg.status}`);
	const grew = await waitUntil(async () => (await GET("/tree")).json.nodes.length > before, 10000);
	check(grew, "带参 /cwd 真的多建了一条会话", `nodes ${before} → ${(await GET("/tree")).json.nodes.length}`);
	const t2 = (await GET("/tree")).json;
	const made = (t2.nodes ?? []).filter((n) => n.cwd === PLAIN && n.parent === SID).map((n) => n.id);
	check(made.length >= 2, "新建的那条 cwd=plain 且 parent=主会话", JSON.stringify(made));
	const argExtra = ((await GET(`/sessions/${SID}/messages`)).json.extras ?? []).filter((x) => x.text.includes("新开一条会话")).pop()?.text ?? "";
	check(/搬家/.test(argExtra) && /独立的一条新会话/.test(argExtra), "带参输出里也写明了「这不是搬家、是独立新会话」", argExtra.replace(/\n/g, " ").slice(0, 90));

	const cntBefore = (await GET("/tree")).json.nodes.length;
	await POST(`/sessions/${SID}/message`, { text: `/cwd ${NOPE}` });
	const gotNope = await waitUntil(async () => ((await GET(`/sessions/${SID}/messages`)).json.extras ?? []).some((x) => x.text.includes("没建会话")), 8000);
	const cntAfter = (await GET("/tree")).json.nodes.length;
	const nopeExtra = ((await GET(`/sessions/${SID}/messages`)).json.extras ?? []).filter((x) => x.text.includes("没建会话")).pop()?.text ?? "";
	check(gotNope && cntAfter === cntBefore && /不存在/.test(nopeExtra), "坏路径：**不建会话**，且如实说「不存在」", `nodes ${cntBefore}→${cntAfter}; ${nopeExtra.replace(/\n/g, " ").slice(0, 70)}`);

	// ── 6. 插件层直调：补全 + cwd 工具的正反例 ────────────────────────
	console.log("\n── 6. 补全（getArgumentCompletions）+ cwd 工具的正反例目录 ─────");
	process.env.SOPHO_BASE_URL = `http://127.0.0.1:${PORT}`;
	process.env.ASSIST_HOME = HOME;
	process.env.SOPHO_AGENT_DIR = HOME;
	const { discoverAndLoadExtensions } = await import(piLoaderUrl());
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-cwd-extprobe-"));
	fs.mkdirSync(path.join(probe, "extensions", "assistant"), { recursive: true });
	fs.symlinkSync(path.join(ROOT, "pi-extensions/assistant/index.ts"), path.join(probe, "extensions", "assistant", "index.ts"));
	const loaded = await discoverAndLoadExtensions([], os.tmpdir(), probe, {});
	fs.rmSync(probe, { recursive: true, force: true });
	check((loaded.errors ?? []).length === 0 && (loaded.extensions ?? []).length === 1, "插件能被 pi 的加载器收下（0 错误）", JSON.stringify(loaded.errors ?? []).slice(0, 200));
	const ext = loaded.extensions[0];
	// 让命令的补全拿到 cwd（getArgumentCompletions 拿不到 ctx，靠 session_start 缓存）
	for (const h of ext.handlers.get("session_start") ?? []) {
		try {
			await h({ type: "session_start" }, { cwd: GIT });
		} catch {
			/* setActiveTools 之类在裸加载器下可能没有 —— 不影响 myCwd */
		}
	}
	const cmd = ext.commands.get("cwd");
	check(!!cmd?.getArgumentCompletions, "注册的命令带着 getArgumentCompletions", typeof cmd?.getArgumentCompletions);
	const compEmpty = await cmd.getArgumentCompletions("");
	check(Array.isArray(compEmpty) && compEmpty.length > 0, "空前缀 → 有候选", `n=${compEmpty?.length}`);
	const labels = (compEmpty ?? []).map((x) => x.label);
	check(labels.includes("sub/"), "候选里有**子目录**（相对当前 cwd）", labels.slice(0, 8).join(","));
	check(!labels.includes("a.txt/") && !labels.includes("AGENTS.md/"), "普通文件**不**当成目录列出来", labels.slice(0, 8).join(","));
	check((compEmpty ?? []).some((x) => x.value === path.join(GIT, "sub")), "候选取值是真能用的绝对路径", String(compEmpty?.find((x) => x.label === "sub/")?.value));
	const compSub = await cmd.getArgumentCompletions(path.join(GIT, "sub") + "/");
	check((compSub ?? []).some((x) => x.value === path.join(GIT, "sub", "deep")), "已到一个目录时 → 列它的子目录", JSON.stringify((compSub ?? []).map((x) => x.label)));
	const compPartial = await cmd.getArgumentCompletions(path.join(GIT, "su"));
	check((compPartial ?? []).some((x) => x.value === path.join(GIT, "sub")), "名字前缀能收窄候选", JSON.stringify((compPartial ?? []).map((x) => x.label)));
	// 最近用过也进候选（先造一个：上面已经建过 plain 目录的会话）
	const compRecent = await cmd.getArgumentCompletions(PLAIN.slice(0, PLAIN.length - 2));
	check((compRecent ?? []).some((x) => x.value === PLAIN), "前缀能匹配到「最近用过」的目录", JSON.stringify((compRecent ?? []).map((x) => x.value.split("/").pop())).slice(0, 120));

	// cwd 工具直调：正反例目录
	const cwdTool = ext.tools.get("cwd").definition;
	const callCwd = async (dir) => {
		const r = await cwdTool.execute("t", {}, undefined, undefined, { cwd: dir });
		return r.content?.[0]?.text ?? "";
	};
	const tGit = await callCwd(GIT);
	check(/git 仓库：是/.test(tGit) && /未提交=0/.test(tGit) && /AGENTS\.md：有/.test(tGit) && /worktree：否/.test(tGit), "正例：git 仓库 + AGENTS.md + 不是 worktree", tGit.match(/git 仓库：[^\n]*/)?.[0]);
	const tPlain = await callCwd(PLAIN);
	check(/git 仓库：否/.test(tPlain) && /AGENTS\.md：无/.test(tPlain) && /可写：是/.test(tPlain), "反例：非 git、无 AGENTS.md、可写", tPlain.match(/git 仓库：[^\n]*/)?.[0]);
	const tRo = await callCwd(RO);
	check(/可写：\*\*否\*\*/.test(tRo), "反例：只读目录如实报「可写：否」", tRo.match(/可写：[^\n]*/)?.[0].slice(0, 40));
	const tWt = await callCwd(WT);
	check(/worktree：是/.test(tWt), "正例：worktree 被认出来（git-dir ≠ git-common-dir）", tWt.match(/worktree：[^\n]*/)?.[0]);
	const tNope = await callCwd(NOPE);
	check(/不存在/.test(tNope), "反例：不存在的目录如实说「不存在」（不猜）", (tNope.match(/不存在[^\n]*/) ?? [""])[0].slice(0, 60));

	// ── 7. session_new 的工作区守卫（与 spawn 同一条硬规则）──────────────
	console.log("\n── 7. session_new 的工作区守卫（同目录有活会话 ⇒ 拒绝）──────────");
	const newTool = ext.tools.get("session_new").definition;
	const callNew = async (dir, extra = {}) => (await newTool.execute("t", { cwd: dir, ...extra }, undefined, undefined, { cwd: GIT })).content?.[0]?.text ?? "";
	const nodesNow = async () => (await GET("/tree")).json.nodes.length;

	// 7a 目标目录（PLAIN）已经有活会话（§ 4 建的儿子、§ 5 用 /cwd 建的）⇒ 拒绝、什么都不建
	const beforeBlocked = await nodesNow();
	const blockedOut = await callNew(PLAIN);
	const afterBlocked = await nodesNow();
	check(/workspace-conflict/.test(blockedOut), "目标目录有活会话 → 明确拒绝（workspace-conflict）", blockedOut.split("\n")[0]);
	check(afterBlocked === beforeBlocked, "拒绝时**真的什么都没建**（/tree 节点数不变）", `nodes ${beforeBlocked} → ${afterBlocked}`);
	check(PLAIN && blockedOut.includes(PLAIN), "拒绝信息里点明是哪个目录", PLAIN);
	check(/[0-9a-f]{8}-[0-9a-f-]{27}/.test(blockedOut), "拒绝信息里**列出了是谁**（完整 id）", (blockedOut.match(/· [0-9a-f-]{36}[^\n]*/) ?? [""])[0]);
	check(/share/.test(blockedOut) && /worktree/.test(blockedOut), "同时说清怎么才能继续（share:true / 换目录 / spawn worktree）", "");

	// 7b 没有活会话的目录 ⇒ 照旧成功（守卫不该误拦）
	const beforeClean = await nodesNow();
	const cleanOut = await callNew(CLEAN, { name: "干净目录的会话" });
	const afterClean = await nodesNow();
	const cleanId = String(cleanOut).match(/新开一条会话：([0-9a-f-]{36})/)?.[1] ?? null;
	check(afterClean === beforeClean + 1 && !!cleanId, "目标目录没有活会话 → 照旧成功（多了一条）", `${beforeClean} → ${afterClean}; ${cleanId}`);
	const cleanNode = ((await GET("/tree")).json.nodes ?? []).find((n) => n.id === cleanId);
	check(cleanNode?.cwd === CLEAN, "新会话的 cwd 就是那个干净目录", String(cleanNode?.cwd));

	// 7c 显式 share:true ⇒ 明知共享而放行（逃生口真的通）
	const beforeShare = await nodesNow();
	const shareOut = await callNew(PLAIN, { share: true, name: "明知共享" });
	const afterShare = await nodesNow();
	check(afterShare === beforeShare + 1 && /新开一条会话/.test(shareOut), "显式 share:true → 放行（守卫的逃生口是通的）", `${beforeShare} → ${afterShare}`);
} finally {
	cleanup();
}

console.log(failed ? `\n✗ ${failed} 条失败` : "\n✓ 全绿");
process.exit(failed ? 1 : 0);
