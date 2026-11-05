#!/usr/bin/env node
/**
 * 工具状态的契约测试：**「工具还在跑，却已渲染成绿色（=完成）」** 这个骗人 bug 的回归。
 *
 * 两半，缺一不可：
 *
 * 【A】服务端契约（真起一台 A，随机端口 + 临时 home；不碰活实例 / 真实例 / 7331 / 7321）
 *   `GET /messages` 对「落盘了 toolCall、还没配到 toolResult」的分片怎么标：
 *     ① toolCall + 无 result + **在流式**   ⇒ `running: true`
 *     ② toolCall + 有 result               ⇒ 完成（没有 running / interrupted）
 *     ③ toolCall + 无 result + **不在流式** ⇒ `interrupted: true`（第四态；被中断 / 结果丢了）
 *     ④ 错误完成                            ⇒ `isError: true` 仍然如实
 *   ①② 用**真会话**（本地假模型按剧本回 `bash: sleep N` 的 tool_call）+ 冷夹具两种都验；
 *   ③④ 用**冷夹具**（直接往 sessions/ 写 pi 原生 .jsonl）。
 *
 * 【B】真浏览器（headless chromium + 真 web/index.html + app.mjs + app.css）
 *   用 mock（`web/test/mock.js`，只读、不改）喂一份「会话正在流式 + toolCall 无 result」的历史，
 *   断言渲染出来 `data-state="running"`、且背景色 **不是** pi 的 toolSuccessBg（绿 `rgb(40, 50, 40)`）；
 *   顺带把第四态 interrupted 的颜色钉死。
 *   另外复现「历史里的在飞分片 + 直播块 = 两张同工具卡」那个现象并**如实记录**（修不修由总台定）。
 *
 * 跑法：`npm run test:toolstate`（需要 node_modules —— 真会话那半要 import pi；浏览器那半要 chromium）。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};
const check = (c, what, detail = "") => (c ? ok(what, detail) : bad(what, detail));
const phase = (t) => console.log(`\n── ${t} ──`);

// 颜色常量（app.css 里的值；两端都拿它当判据）
const GREEN_SUCCESS = "rgb(40, 50, 40)"; // #283228 = pi toolSuccessBg —— 「绿」就是它
const BG_RUNNING = "rgb(40, 40, 50)"; // #282832 = pi toolPendingBg
const BG_INTERRUPTED = "rgb(58, 50, 37)"; // #3a3225 —— 我们给第四态定的值（钉在这）
const BG_ERROR = "rgb(60, 40, 40)"; // #3c2828 = pi toolErrorBg

// ═════════════════════════════════════════════════════════════════════════
// 【A】服务端契约
// ═════════════════════════════════════════════════════════════════════════
phase("【A】服务端契约：GET /messages 怎么标「未完成」的分片");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-toolstate-"));
const HOME = path.join(TMP, "home");
const SESS = path.join(HOME, "sessions");
fs.mkdirSync(SESS, { recursive: true });

// ── 冷夹具：直接写 pi 原生 .jsonl（不用真跑，情形 ③④ 就靠它）──────────────
const line = (o) => JSON.stringify(o) + "\n";
const userLine = (id, text) => line({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const toolCallAsst = (id, callId, name, args) =>
	line({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], stopReason: "toolUse" } });
const toolResult = (id, callId, text, isError) =>
	line({ type: "message", id, message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], isError: !!isError } });
const writeSession = (id, lines) => {
	fs.writeFileSync(path.join(SESS, `2026-01-01T00-00-00-000Z_${id}.jsonl`), lines.join(""));
	return id;
};

const ID_DONE = "22222222-2222-4222-8222-222222222222";
const ID_ERR = "33333333-3333-4333-8333-333333333333";
const ID_COLD_INTERRUPTED = "44444444-4444-4444-8444-444444444444";
writeSession(ID_DONE, [
	userLine("u1", "跑个工具"),
	toolCallAsst("a1", "call_done", "bash", { command: "echo hi" }),
	toolResult("t1", "call_done", "hi\n", false),
]);
writeSession(ID_ERR, [
	userLine("u1", "跑个会失败的"),
	toolCallAsst("a1", "call_err", "bash", { command: "false" }),
	toolResult("t1", "call_err", "boom\n", true),
]);
writeSession(ID_COLD_INTERRUPTED, [
	userLine("u1", "跑个长的"),
	toolCallAsst("a1", "call_cut", "bash", { command: "sleep 30" }),
	// 故意**没有** toolResult —— 这轮被中断 / 结果丢了
]);

// ── 本地假模型：第一发回 `bash: sleep N`，拿到结果后收尾 ────────────────
const SLEEP_N = Number(process.env.SOPHO_TOOLSTATE_SLEEP ?? 4);
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
		const nTool = msgs.filter((m) => m.role === "tool").length;
		const chunk = (delta, fin) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta, finish_reason: fin ?? null }] })}\n\n`;
		const sse = (msg, reason) => {
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
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (nTool === 0) {
			res.end(sse({ role: "assistant", content: null, tool_calls: [{ id: "call_live_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `sleep ${SLEEP_N}` }) } }] }, "tool_calls"));
		} else {
			res.end(sse({ role: "assistant", content: "跑完了。" }, "stop"));
		}
	});
});
const STUB_PORT = await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(stub.address().port)));
fs.writeFileSync(
	path.join(HOME, "models.json"),
	JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-1", name: "Stub", reasoning: false, contextWindow: 100000, maxTokens: 4096 }] } } }, null, 1),
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
	env: { ...process.env, ASSIST_HOME: HOME, SOPHO_AGENT_DIR: HOME, ASSIST_SESSIONS: SESS, SOPHO_BASE_PORT: String(PORT), SOPHO_CWD: TMP, SOPHO_IDLE_TTL_MS: "300000" },
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
const killA = () => {
	try {
		child.kill("SIGKILL");
	} catch {
		/* 已死 */
	}
};
process.on("exit", killA);

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

/** 在一份 /messages 里找某次工具调用的分片（按 name 找第一个）。 */
const toolParts = (d) => (d?.messages ?? []).flatMap((m) => (m.parts ?? []).filter((p) => p.type === "tool"));

{
	let up = false;
	for (let i = 0; i < 100 && !up; i++) {
		try {
			const r = await GET("/host");
			if (r.status === 200) up = true;
		} catch {
			/* 还没起来 */
		}
		if (!up) await sleep(200);
	}
	assert.ok(up || !logs.includes("ERR_MODULE_NOT_FOUND"), `A 起不来：依赖不在（先 \`npm i\` 或把 node_modules 链过来）。\n${logs}`);
	assert.ok(up, `A 没起来。输出：\n${logs}`);
}

// ── ①②③④：冷夹具的三种情形 ──────────────────────────────────────────
{
	const done = await GET(`/sessions/${ID_DONE}/messages`);
	check(done.status === 200, "夹具②（有 result）：GET 200");
	const p = toolParts(done.json)[0];
	check(p && p.result === "hi", "② 有 result ⇒ 结果如实带上", JSON.stringify(p?.result));
	check(p && !p.running && !p.interrupted, "② 有 result ⇒ **没有** running / interrupted（= 完成）", `running=${p?.running} interrupted=${p?.interrupted}`);
	check(p && p.isError === false, "② 正常完成 ⇒ isError:false", String(p?.isError));

	const err = await GET(`/sessions/${ID_ERR}/messages`);
	const pe = toolParts(err.json)[0];
	check(pe && pe.isError === true, "④ 错误完成 ⇒ isError:true 仍然如实", String(pe?.isError));
	check(pe && !pe.running && !pe.interrupted, "④ 错误完成 ⇒ 也不带 running / interrupted", `running=${pe?.running} interrupted=${pe?.interrupted}`);

	const cut = await GET(`/sessions/${ID_COLD_INTERRUPTED}/messages`);
	check(cut.status === 200, "夹具③（无 result + 不流式）：GET 200");
	const pc = toolParts(cut.json)[0];
	check(pc && pc.interrupted === true, "③ 无 result + 不在流式 ⇒ interrupted:true（第四态，不是绿）", JSON.stringify(pc));
	check(pc && !pc.running, "③ 不在流式 ⇒ **不是** running（诚实：它没在跑）", `running=${pc?.running}`);
	check(pc && !("result" in pc), "③ 没有结果 ⇒ 不带 result 字段", JSON.stringify(pc));
}

// ── ①：真会话（假模型回 bash: sleep N）+ 冷夹具的 running 不可能（冷=不在流式）──
{
	const mk = await POST("/sessions", { name: "tool-state 契约" });
	assert.ok((mk.status === 200 || mk.status === 201) && mk.json?.id, `建会话失败：${mk.status} ${mk.raw}`);
	const SID = mk.json.id;
	const st = await POST(`/sessions/${SID}/message`, { text: "跑一个 sleep。" });
	check(st.status === 202 || st.status === 200, "① 发消息被接受", `HTTP ${st.status}`);

	// 轮询：等「toolCall 落盘、结果还没到」这个窗口
	let running = null;
	for (let i = 0; i < 80 && !running; i++) {
		await sleep(150);
		const r = await GET(`/sessions/${SID}/messages`);
		const tp = toolParts(r.json);
		if (tp.some((x) => x.running === true)) running = { d: r.json, part: tp.find((x) => x.running === true) };
	}
	check(!!running, "① 在工具真跑着的时候，/messages 里的分片带 running:true（**原始形状**）", running ? JSON.stringify(running.part) : "80 次轮询（12s）都没看到 running:true");
	if (running) {
		check(running.part.name === "bash" && String(running.part.args?.command ?? "").startsWith("sleep"), "① running 的是那次 bash sleep", JSON.stringify(running.part.args));
		check(!("result" in running.part), "① 还在跑 ⇒ 没有 result（骗人的绿色就是从这儿来的）", JSON.stringify(Object.keys(running.part)));
	}

	// 等它跑完（结果落盘）→ 变成完成态
	let finished = null;
	for (let i = 0; i < 200 && !finished; i++) {
		await sleep(200);
		const r = await GET(`/sessions/${SID}/messages`);
		const tp = toolParts(r.json);
		const x = tp[0];
		if (x && !x.running && !x.interrupted && "result" in x) finished = x;
	}
	check(!!finished, "① 工具跑完后同一分片变成完成态（原始形状）", finished ? JSON.stringify(finished) : "40s 内没等到完成态");
	if (finished) check(finished.isError === false, "① 完成态 isError:false", String(finished.isError));
}

// ═════════════════════════════════════════════════════════════════════════
// 【B】真浏览器
// ═════════════════════════════════════════════════════════════════════════
phase("【B】真浏览器：渲染成 running（不是绿）+ 第四态颜色");

const WEB_DIR = path.join(ROOT, "web");
const MOCK = await readFile(path.join(WEB_DIR, "test", "mock.js"), "utf8");
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

function startStaticServer() {
	const srv = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
		const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
		const file = path.resolve(WEB_DIR, rel);
		if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) return void res.writeHead(403).end("forbidden");
		try {
			const body = await readFile(file);
			res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
			res.end(body);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 " + url.pathname);
		}
	});
	return new Promise((ok2) => srv.listen(0, "127.0.0.1", () => ok2(srv)));
}

function findChromium() {
	const cands = [process.env.CHROME_BIN, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].filter(Boolean);
	for (const c of cands) {
		if (c.includes("/") || c.includes("\\")) {
			try {
				fs.accessSync(c, fs.constants.X_OK);
				return c;
			} catch {}
		} else {
			const r = spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" });
			if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
		}
	}
	return null;
}

const chrome = findChromium();
if (!chrome) {
	console.error("✗ 找不到 chromium / chrome。装一个，或用 CHROME_BIN=/path/to/chromium 指定。");
	killA();
	process.exit(1);
}

const staticSrv = await startStaticServer();
const PAGE = `http://127.0.0.1:${staticSrv.address().port}/`;
const devtoolsPort = await freePort();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-toolstate-"));

const chromeChild = spawn(
	chrome,
	["--headless=new", `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,700", "--disable-gpu", "about:blank"],
	{ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
);
let chromeErr = "";
chromeChild.stderr.on("data", (d) => (chromeErr += d));
function killChrome() {
	if (killChrome.done) return;
	killChrome.done = true;
	try {
		if (process.platform === "win32") chromeChild.kill("SIGKILL");
		else process.kill(-chromeChild.pid, "SIGKILL");
	} catch {
		try {
			chromeChild.kill("SIGKILL");
		} catch {
			/* 已死 */
		}
	}
}
process.on("exit", killChrome);

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
		wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
	} catch {}
	if (!wsUrl) await sleep(250);
}
if (!wsUrl) {
	console.error("✗ chromium 的 devtools 没起来：\n" + chromeErr.slice(-600));
	killChrome();
	staticSrv.close();
	killA();
	process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((ok2, no) => {
	ws.onopen = ok2;
	ws.onerror = (e) => no(new Error("CDP websocket 出错：" + e.message));
});
let seq = 0;
const pend = new Map();
const listeners = [];
const pageProblems = [];
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id) {
		const p = pend.get(m.id);
		if (p) {
			pend.delete(m.id);
			m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
		}
		return;
	}
	if (m.method === "Runtime.exceptionThrown") pageProblems.push("未捕获异常：" + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageProblems.push("console.error：" + m.params.args.map((a) => a.value ?? a.description).join(" "));
	for (const l of listeners) l(m);
};
const send = (method, params = {}) =>
	new Promise((ok2, no) => {
		const id = ++seq;
		pend.set(id, { res: ok2, rej: no });
		ws.send(JSON.stringify({ id, method, params }));
	});
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error("页面求值异常：" + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
	return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
// 注入：真 mock.js + 一小段覆盖。/messages 在 ?toolstate / __histTool 打开时多带一条
// 「assistant 消息，里面有 running / interrupted / done / error 四种工具分片」——
// 形状与真实服务端（server/base-logic.mjs 的 readMessages + markUnfinished）逐字段一致。
await send("Page.addScriptToEvaluateOnNewDocument", {
	source:
		MOCK +
		`
(() => {
  const orig = window.fetch;
  window.fetch = async (url, init) => {
    const res = await orig(url, init);
    const u = String(url);
    const want = new URLSearchParams(location.search).has('toolstate') || window.__histTool;
    if (!u.includes('/messages') || !want) return res;
    let d;
    try { d = await res.json(); } catch { return res; }
    d.messages = [...(d.messages ?? []), { role: 'assistant', parts: [
      { type: 'tool', name: 'bash', args: { command: 'sleep 30' }, running: true },
      { type: 'tool', name: 'read', args: { path: '/tmp/x' }, interrupted: true },
      { type: 'tool', name: 'ls', args: {}, result: 'ok' },
      { type: 'tool', name: 'false', args: {}, result: 'boom', isError: true },
    ] }];
    return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
`,
});

const navOnce = async (url, ms) => {
	const loaded = Promise.race([new Promise((ok2) => listeners.push((m) => m.method === "Page.loadEventFired" && ok2("ok"))), sleep(ms).then(() => "timeout")]);
	await send("Page.navigate", { url });
	return await loaded;
};
const load = async (url) => {
	let how = await navOnce(url, 12000);
	if (how === "timeout") how = await navOnce(url, 20000);
	if (how === "timeout") throw new Error(`导航没等到 load：${url}`);
	const probe = String(await ev("document.title + ' | #messages=' + document.querySelectorAll('#messages').length"));
	if (!probe.includes("#messages=1")) throw new Error(`页面没加载对（${url}）：${probe}`);
};

const LIVE_ROOT = "aaaabbbb-1111-2222-3333-444455556666";
const cardProbe = `(() => [...document.querySelectorAll('#hist .tool')].map(b => ({ state: b.getAttribute('data-state'), bg: getComputedStyle(b).backgroundColor, edge: getComputedStyle(b).borderLeftColor, name: (b.querySelector('.tname')||{}).textContent, res: (b.querySelector('.tres')||{}).textContent })))()`;

try {
	// ── B1：历史里的四种状态分片 ──
	await load(`${PAGE}?toolstate=1#${LIVE_ROOT}`);
	await sleep(500);
	const cards = await ev(cardProbe);
	const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
	check(!!byName.bash && byName.bash.state === "running", "历史里的 running 分片 ⇒ data-state=\"running\"", JSON.stringify(byName.bash));
	check(byName.bash?.bg === BG_RUNNING, "running 卡不是绿（= toolPendingBg）", `bg=${byName.bash?.bg}`);
	check(byName.bash?.bg !== GREEN_SUCCESS, "running 卡 ≠ pi toolSuccessBg(绿)", `bg=${byName.bash?.bg} vs ${GREEN_SUCCESS}`);
	check(byName.bash?.res?.includes("运行中"), "running 卡有「运行中…」人话", JSON.stringify(byName.bash?.res));
	check(!!byName.read && byName.read.state === "interrupted", "interrupted 分片 ⇒ data-state=\"interrupted\"（第四态）", JSON.stringify(byName.read));
	check(byName.read?.bg === BG_INTERRUPTED, "第四态颜色 = #3a3225（钉死，且不是绿）", `bg=${byName.read?.bg}`);
	check(byName.read?.bg !== GREEN_SUCCESS, "第四态 ≠ 绿（不然还是骗人）", `bg=${byName.read?.bg} vs ${GREEN_SUCCESS}`);
	check(byName.read?.res?.includes("没跑完"), "第四态有「没跑完／结果没落盘」人话", JSON.stringify(byName.read?.res));
	check(byName.ls?.state === "done" && byName.ls?.bg === GREEN_SUCCESS, "完成分片仍然是绿（done）", JSON.stringify(byName.ls));
	check(byName["false"]?.state === "error" && byName["false"]?.bg === BG_ERROR, "错误完成仍然红（error）", JSON.stringify(byName["false"]));
	check(pageProblems.length === 0, "页面无未捕获异常 / console.error", pageProblems.join(" | ").slice(0, 300));

	// ── B2：复现「历史里的在飞分片 + 直播块 = 两张同工具卡」 ──
	phase("【B2】重复渲染：历史 + 直播会不会同时出现同一张工具卡");
	await load(`${PAGE}#${LIVE_ROOT}`);
	await sleep(400);
	// 直播块：这一轮开始 + bash 工具开始跑（= 只走 SSE，不走 /messages）
	await ev(`__es._emit({t:'run',phase:'start'})`);
	await ev(`__es._emit({t:'tool',phase:'start',id:'live_bash',name:'bash',args:{command:'sleep 30'}})`);
	await sleep(150);
	// 现在让 /messages 里也出现这条在飞的 toolCall（= 真服务端会把已落盘的助手消息给出来），
	// 再制造一次「流式中途 reload」——hello 正是生产里的一条触发路径（SSE 重连）。
	await ev("window.__histTool = true; true");
	const before = await ev("window.__net.filter(x => x.includes('/messages')).length");
	await ev(`__es._emit({t:'hello',status:{streaming:true}})`);
	for (let i = 0; i < 30; i++) {
		await sleep(100);
		const now = await ev("window.__net.filter(x => x.includes('/messages')).length");
		if (now > before) break;
	}
	await sleep(400);
	const dup = await ev(`(() => ({
		hist: [...document.querySelectorAll('#hist .tool')].map(b => ({ state: b.getAttribute('data-state'), bg: getComputedStyle(b).backgroundColor, name: (b.querySelector('.tname')||{}).textContent })),
		live: [...document.querySelectorAll('#liveBox .tool')].map(b => ({ state: b.getAttribute('data-state'), name: (b.querySelector('.tname')||{}).textContent })),
		histBash: document.querySelectorAll('#hist .tool[data-state="running"]').length,
		liveBash: document.querySelectorAll('#liveBox .tool[data-state="running"]').length,
	}))()`);
	const histRunning = dup.hist.filter((c) => c.state === "running" && c.name === "bash");
	const liveRunning = dup.live.filter((c) => c.state === "running" && c.name === "bash");
	const twoCards = histRunning.length > 0 && liveRunning.length > 0;
	console.log(
		`  ${twoCards ? "⚠" : "•"} 复现「一运行中一历史」：历史 running bash 卡 ${histRunning.length} 张 / 直播 running bash 卡 ${liveRunning.length} 张` +
			`  —— 历史=${JSON.stringify(dup.hist)} 直播=${JSON.stringify(dup.live)}`,
	);
	check(histRunning.length > 0, "历史里确实出现了在飞分片（中途 reload 真发生）", `hist=${JSON.stringify(dup.hist)}`);
	if (twoCards) {
		// 这是**如实记录**，不是要求修好 —— 修它要动 web/app.mjs（见报告）。
		check(histRunning.every((c) => c.bg !== GREEN_SUCCESS), "（复现）历史那张**不是绿**——本任务的骗人 bug 已修，剩的只是重复卡", JSON.stringify(histRunning));
		console.log("     ⚠ 复现成功：同一个 bash 工具，历史里一张 + 直播里一张 = 两张卡（修复需动 web/app.mjs，超出本任务允许改的范围）。");
	}
} catch (e) {
	bad("浏览器测试跑挂了", String(e.stack ?? e));
} finally {
	console.log("\n── 结果 ──");
	if (failed) console.log(`\n❌ 失败 ${failed} 项`);
	else console.log("\n✅ 全部通过");
	ws.close();
	killChrome();
	await sleep(300);
	staticSrv.close();
	try {
		fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (e) {
		console.warn(`  ⚠ 临时 profile 没清掉（不影响结果）：${profileDir} —— ${e.code ?? e.message}`);
	}
	killA();
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清不掉就算了 */
	}
}

process.exit(failed ? 1 : 0);
