#!/usr/bin/env node
/**
 * 验收（真浏览器 + **真 A + 真 B** + 本地假模型）：**一轮还在飞的时候，同一轮不能被画两遍。**
 *
 * 被钉住的现象（2026-09-16 实测，证据见报告 /tmp/reading-page-s3.4.md）：
 *   pi 在这一轮的助手消息一落盘，`GET /messages` 里就有它（比如一条带 toolCall 的、或已经写出来的
 *   正文）；而直播块（SSE delta 攒出来的）里也有同一份 ⇒ **历史块一张工具卡 + 直播块同一张工具卡**
 *   （正文同理）。触发点很常见：`visibilitychange` / SSE `hello` / status 变化都会 `requestReload()`。
 *
 * 判据（每一条都必须在「工具真在跑」的窗口里量）：
 *   ① 工具跑着（有 start 事件）+ 中途重拉 ⇒ 同一个工具**只有一张卡**，且卡里带着参数；
 *      这一轮**已经产出的正文在整页里只出现一次**；
 *   ② 工具跑着时**刷新页面**（`tool start` 事件已经错过）⇒ 那张卡**还在**（不消失）、
 *      状态是 `running`（不是绿、不是 done），**这一轮已经产出的正文也还在**；
 *   ③ 一轮结束 ⇒ 历史里那张卡带着结果出现，数量对、顺序对（卡在正文之后、收尾正文之前）；
 *   ④ `aborted` 那条 ⇒ 历史里照常有「⏹ 这一轮被中断了」，卡是第四态 interrupted。
 *
 * 为什么用**真 A + 真 B**：mock 出来的 /messages 是我自己造的，而这件事的全部事实都在
 * 「pi 什么时候落盘、服务端怎么标 running、SSE 什么时候到」这三者之间 —— 只有真链路才算证据。
 * （`web/test-scroll.mjs` 里另有一组 mock 版的回归，跑得快、钉的是同一套判据的边界情形。）
 *
 * 自足、无外部依赖：不要真 A/B 在跑、不用 7331/7321、不碰真实例（临时 home + 随机端口 + 本地假模型）。
 * 跑法：`node web/test-live-dedup.mjs`（通过退出 0；任何一条红退出 1）
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

/** 第 n 轮的「已经产出的正文」/「收尾正文」—— 每轮文本不同，才数得清「只出现一次」。 */
const TXT_A = (n) => `已经产出的正文（第 ${n} 轮）：先说一句话，然后动手。`;
const TXT_DONE = (n) => `工具跑完了，第 ${n} 轮收尾。`;
/** 「慢正文」那一段的一小片（每片都不同，好数「中断前已经流出来的那些还在不在」）。 */
const SLOW_CHUNK = (n, i) => `慢正文第${n}轮-第${i}片。`;

// ─────────────────────────── 1. 临时 home + 本地假模型 ───────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-livededup-"));
const HOME = path.join(TMP, "home");
const SESS = path.join(HOME, "sessions");
fs.mkdirSync(SESS, { recursive: true });

/** 假模型（OpenAI 兼容 SSE）：
 *   · 请求里**没有** tool 结果 ⇒ 先吐一段正文，再回一个 `bash: sleep N` 的 tool_call；
 *   · 拿到 tool 结果 ⇒ 吐收尾正文 + stop。
 *  N 按**用户那句话**里的关键词定（"长工具" ⇒ 长 sleep），于是「工具还在跑」这个窗口是我说了算的。 */
const TOOL_SHORT = Number(process.env.SOPHO_DEDUP_SHORT ?? 6);
const TOOL_LONG = Number(process.env.SOPHO_DEDUP_LONG ?? 45);
let lastSleep = null;
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
		const users = msgs.filter((m) => m.role === "user");
		const userText = users.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join(" ");
		// 「第几轮」= 会话里有几条用户消息（每一轮都由一条用户消息起头）。
		const roundN = users.length || 1;
		// 这一发的**最后一条**是不是工具结果：是 ⇒ 这一轮收尾；否则 ⇒ 先吐正文 + 一个 tool_call。
		// （不能数「整段对话里有几个 tool」—— 第二轮请求里带着第一轮的结果，那样就永远收不了尾。）
		const afterTool = msgs.length > 0 && msgs[msgs.length - 1]?.role === "tool";
		const chunk = (delta, fin) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta, finish_reason: fin ?? null }] })}\n\n`;
		let out = "";
		res.writeHead(200, { "content-type": "text/event-stream" });
		// 「慢正文」：一小段一小段地吐（每段 120ms）—— 中断**流式中的正文**才测得到
		// 「这一轮被中断了」那条标记（pi 只在「助手消息被掐在半路」时才写 stopReason: aborted）。
		if (/慢正文/.test(userText) && !afterTool) {
			(async () => {
				try {
					res.write(chunk({ role: "assistant", content: "" }));
					for (let i = 1; i <= 60; i++) {
						res.write(chunk({ content: SLOW_CHUNK(roundN, i) }));
						await sleep(120);
					}
					res.write(chunk({}, "stop"));
					res.end("data: [DONE]\n\n");
				} catch {
					/* 被中断就算了 */
				}
			})();
			return;
		}
		if (!afterTool) {
			lastSleep = /长工具/.test(userText) ? TOOL_LONG : TOOL_SHORT;
			out += chunk({ role: "assistant", content: TXT_A(roundN) });
			out += chunk({ tool_calls: [{ index: 0, id: "call_live_1", type: "function", function: { name: "bash", arguments: "" } }] });
			// 每一轮的工具参数都**不一样**（`echo 第N轮 && sleep …`）—— 数「这一轮那张卡」才数得清。
			out += chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: `echo 第${roundN}轮 && sleep ${lastSleep}` }) } }] });
			out += chunk({}, "tool_calls");
		} else {
			// 收尾正文**故意晚 2.5s**才来：好把「工具结束 ⇒ 那张卡变完成」这一幕留在
			// **这一轮还在跑**的窗口里（否则它会和 run end 那一次重拉混在一起，分不清是哪条路修好的）。
			setTimeout(() => {
				try {
					res.write(chunk({ role: "assistant", content: TXT_DONE(roundN) }));
					res.write(chunk({}, "stop"));
					res.end("data: [DONE]\n\n");
				} catch {
					/* 中断/断了就算了 */
				}
			}, 2500);
			return;
		}
		res.end(out + "data: [DONE]\n\n");
	});
});
const STUB_PORT = await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(stub.address().port)));
fs.writeFileSync(
	path.join(HOME, "models.json"),
	JSON.stringify(
		{
			providers: {
				stub: {
					baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
					api: "openai-completions",
					apiKey: "stub-key",
					models: [{ id: "stub-1", name: "Stub", reasoning: false, contextWindow: 100000, maxTokens: 4096 }],
				},
			},
		},
		null,
		1,
	),
);
fs.writeFileSync(path.join(HOME, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", compaction: { enabled: false } }, null, 1));

const freePort = async () => {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const p = s.address().port;
	await new Promise((r) => s.close(r));
	return p;
};

// ─────────────────────────── 2. 起真 A + 真 B ───────────────────────────

const procs = [];
function killAll() {
	for (const c of procs.splice(0)) {
		try {
			if (process.platform === "win32") c.kill("SIGKILL");
			else process.kill(-c.pid, "SIGKILL");
		} catch {
			try {
				c.kill("SIGKILL");
			} catch {
				/* 已死 */
			}
		}
	}
}
process.on("exit", killAll);

const A_PORT = await freePort();
let aLog = "";
const aChild = spawn(process.execPath, ["server/base.mjs"], {
	cwd: ROOT,
	env: { ...process.env, ASSIST_HOME: HOME, SOPHO_AGENT_DIR: HOME, ASSIST_SESSIONS: SESS, SOPHO_BASE_PORT: String(A_PORT), SOPHO_CWD: TMP, SOPHO_IDLE_TTL_MS: "300000" },
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
procs.push(aChild);
aChild.stdout.on("data", (d) => (aLog += d));
aChild.stderr.on("data", (d) => (aLog += d));

const B_PORT = await freePort();
let bLog = "";
const bChild = spawn(process.execPath, ["server/app.mjs"], {
	cwd: ROOT,
	env: { ...process.env, SOPHO_PORT: String(B_PORT), SOPHO_HOST: "127.0.0.1", SOPHO_BASE_URL: `http://127.0.0.1:${A_PORT}` },
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
procs.push(bChild);
bChild.stdout.on("data", (d) => (bLog += d));
bChild.stderr.on("data", (d) => (bLog += d));

const req = (method, p, body) =>
	new Promise((res, rej) => {
		const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const r = http.request(
			{ host: "127.0.0.1", port: A_PORT, path: p, method, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} },
			(x) => {
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
			},
		);
		r.on("error", rej);
		if (data) r.write(data);
		r.end();
	});
const GET = (p) => req("GET", p);
const POST = (p, b) => req("POST", p, b);

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
assert.ok(up, `A 没起来（先 \`npm i\`？）。输出：\n${aLog.slice(-2000)}`);
{
	let bUp = false;
	for (let i = 0; i < 60 && !bUp; i++) {
		try {
			bUp = (await fetch(`http://127.0.0.1:${B_PORT}/app.mjs`)).status === 200;
		} catch {
			/* 还没起来 */
		}
		if (!bUp) await sleep(200);
	}
	assert.ok(bUp, `B 没起来。输出：\n${bLog.slice(-2000)}`);
}
const mk = await POST("/sessions", { name: "live-dedup 验收" });
assert.ok((mk.status === 200 || mk.status === 201) && mk.json?.id, `建会话失败：${mk.status} ${mk.raw}`);
const SID = mk.json.id;
const PAGE = `http://127.0.0.1:${B_PORT}/#${SID}`;
console.log(`  A=${A_PORT}  B=${B_PORT}  会话=${SID}  （假模型 sleep ${TOOL_SHORT}s / 长工具 ${TOOL_LONG}s）`);

// ─────────────────────────── 3. 真 chromium + CDP ───────────────────────────

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
assert.ok(chrome, "找不到 chromium / chrome（CHROME_BIN 可指定）");
const devtoolsPort = await freePort();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-livededup-"));
const chromeChild = spawn(
	chrome,
	["--headless=new", `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "--disable-gpu", "about:blank"],
	{ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
);
procs.push(chromeChild);
let chromeErr = "";
chromeChild.stderr.on("data", (d) => (chromeErr += d));

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
		wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
	} catch {}
	if (!wsUrl) await sleep(250);
}
assert.ok(wsUrl, `chromium 的 devtools 没起来：\n${chromeErr.slice(-600)}`);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
	ws.onopen = res;
	ws.onerror = (e) => rej(new Error("CDP websocket 出错：" + e.message));
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
	new Promise((res, rej) => {
		const id = ++seq;
		pend.set(id, { res, rej });
		ws.send(JSON.stringify({ id, method, params }));
	});
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error("页面求值异常：" + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
	return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
	source: `(() => {
		// 数 /messages 的拉取次数（判「重拉真发生了」；不拦内容，只记数）
		window.__net = [];
		const orig = window.fetch;
		window.fetch = (...a) => { try { window.__net.push(String(a[0])); } catch {} return orig(...a); };
		window.__probe = {
			who: () => ({ hist: document.querySelectorAll('#hist .who').length, live: document.querySelectorAll('#liveBox .who').length }),
			cards: (sel) => [...document.querySelectorAll(sel || '#messages .tool')].map(b => ({
				where: b.closest('#liveBox') ? 'live' : 'hist',
				state: b.getAttribute('data-state'),
				name: (b.querySelector('.tname') || {}).textContent,
				args: (b.querySelector('.targs') || {}).textContent,
				res: (b.querySelector('.tres') || {}).textContent,
				bg: getComputedStyle(b).backgroundColor,
			})),
			occur: (t) => document.querySelector('#messages').textContent.split(t).length - 1,
			msgs: () => window.__net.filter(u => u.includes('/messages')).length,
			aborted: () => { const a = document.querySelector('#hist .aborted'); return a ? a.textContent : null; },
			running: () => !!document.querySelector('#head .running'),
			setInput(v) { const i = document.querySelector('#input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; },
			enter() { const i = document.querySelector('#input'); return i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); },
			abort() { const b = document.querySelector('#abort'); if (!b || b.hidden) return false; b.click(); return true; },
			abortBtn: () => { const b = document.querySelector('#abort'); return b ? { hidden: b.hidden, text: b.textContent } : null; },
			pokeReload() { document.dispatchEvent(new Event('visibilitychange')); return true; },  // 真触发路径之一（从后台切回来）
			text: () => document.querySelector('#messages').textContent,
		};
		return true;
	})()`,
});

const navOnce = async (url, ms) => {
	const loaded = Promise.race([
		new Promise((res) => listeners.push((m) => m.method === "Page.loadEventFired" && res("ok"))),
		sleep(ms).then(() => "timeout"),
	]);
	await send("Page.navigate", { url });
	return await loaded;
};
/** 导航 + 等 load。**刷新页面**也走这里（换个 URL query，保证是一次真导航）。 */
const load = async (url) => {
	let how = await navOnce(url, 15_000);
	if (how === "timeout") how = await navOnce(url, 25_000);
	assert.equal(how, "ok", `导航没等到 load：${url}`);
	const probe = String(await ev("document.querySelectorAll('#messages').length + '|' + document.querySelectorAll('#input').length"));
	assert.equal(probe, "1|1", `页面没加载对（${url}）：${probe}`);
};
const reloadPage = async () => {
	const loaded = Promise.race([
		new Promise((res) => listeners.push((m) => m.method === "Page.loadEventFired" && res("ok"))),
		sleep(20_000).then(() => "timeout"),
	]);
	await send("Page.reload", { ignoreCache: true });
	assert.equal(await loaded, "ok", "刷新页面没等到 load");
};

/** 等一个条件（页面里求值）成真；超时给出最后的观察值。 */
async function waitFor(expr, what, ms = 20_000, step = 150) {
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < ms) {
		last = await ev(expr);
		if (last) return last;
		await sleep(step);
	}
	throw new Error(`等「${what}」超时（${ms}ms）—— 最后看到：${JSON.stringify(last)}`);
}

// ─────────────────────────── 4. 跑 ───────────────────────────

const cards = () => ev("__probe.cards()");
/** 只看**这一轮**的卡：每轮的工具参数都带「第N轮」（见假模型），否则上一轮那张卡也在窗口里。 */
const round = (list, n) => list.filter((c) => String(c.args).includes(`第${n}轮`));

try {
	// ── ① 工具跑着 + 中途重拉 ⇒ 同一张卡只该出现一次 ──
	phase("① 工具跑着（有 start 事件）+ 中途重拉：同一张卡不许出现两张");
	await load(PAGE);
	await sleep(400);
	await ev("__probe.setInput('第一轮：先说一句，再跑一个工具。')");
	await ev("__probe.enter()");
	// 等到「工具在跑」：先认直播块里那张 running 卡（还没重拉过，历史里还没有它）
	await waitFor("__probe.cards('#liveBox .tool').some(c => c.state === 'running')", "直播块里出现 running 的工具卡");
	const before = await cards();
	check(round(before, 1).length === 1, "重拉之前：整页只有 1 张这一轮的卡（在直播块里）", JSON.stringify(round(before, 1)));
	const msgsBefore = await ev("__probe.msgs()");
	await ev("__probe.pokeReload()"); // = 从后台切回来（真触发路径）
	const msgsAfter = await waitFor(`__probe.msgs() > ${msgsBefore} ? __probe.msgs() : 0`, "重拉 /messages 落地");
	check(msgsAfter > msgsBefore, `中途重拉真的发生了（/messages ${msgsBefore} → ${msgsAfter}）`);
	await sleep(400);
	const after = await cards();
	const r1 = round(after, 1);
	check(r1.length === 1, "★重拉之后：整页仍然只有 1 张这一轮的卡（不是历史一张 + 直播一张）", JSON.stringify(after));
	check(r1.every((c) => c.state === "running"), "★那张卡的状态是 running（在跑，不是绿/完成）", JSON.stringify(r1.map((c) => c.state)));
	check(r1.every((c) => /sleep/.test(String(c.args))), "★那张卡带着参数（不是一张没信息的空卡）", JSON.stringify(r1.map((c) => c.args)));
	check(r1.every((c) => c.where === "hist"), "那张卡由**历史块**在画（服务端那条在飞消息），直播块不再重画它", JSON.stringify(r1.map((c) => c.where)));
	check((await ev(`__probe.occur(${JSON.stringify(TXT_A(1))})`)) === 1, "★这一轮**已经产出的正文**在整页里只出现一次", `出现 ${await ev(`__probe.occur(${JSON.stringify(TXT_A(1))})`)} 次`);
	check((await ev("__probe.who()")).live <= 1, "直播块没多出一个空的「助手 ›」头", JSON.stringify(await ev("__probe.who()")));
	// 工具结束时**这一轮还在跑**（收尾正文 2.5s 后才来）⇒ 那张卡必须就地变成完成 ——
	// 它这一份由服务端说话（历史），所以走后端「工具结束 → 重拉」那条路（见 reloadUntilToolSettled）。
	await waitFor(`__probe.cards().some(c => String(c.args).includes('第1轮') && c.state === 'done')`, "工具结束 ⇒ 那张卡变成完成", 30_000);
	check(await ev("__probe.running()"), "★此刻这一轮**还在跑**（不是等 run end 才变的）", `#head .running = ${await ev("__probe.running()")}`);
	{
		const r1b = round(await cards(), 1);
		check(r1b.length === 1, "★工具结束后仍然只有 1 张（没有历史一张 + 直播补一张）", JSON.stringify(r1b));
		check(r1b.every((c) => c.state === "done" && /第1轮/.test(String(c.res))), "★那张卡带着结果（就地更新，没有换一张）", JSON.stringify(r1b.map((c) => [c.state, c.res])));
	}

	// ── ③ 一轮结束 ⇒ 历史里那张卡带着结果，而且只有一张 ──
	phase("③ 一轮结束：历史里照常有那张卡（带结果），数量对、顺序对");
	await waitFor("!__probe.running()", "这一轮结束", 40_000);
	await sleep(500);
	const r1done = round(await cards(), 1);
	check(r1done.length === 1, "★跑完之后整页仍然只有 1 张这一轮的卡", JSON.stringify(r1done));
	check(r1done.every((c) => c.where === "hist"), "它在历史块里（直播块已经收掉）", JSON.stringify(r1done.map((c) => c.where)));
	check(r1done.every((c) => c.state === "done"), "★状态是完成（带结果，不是运行中）", JSON.stringify(r1done.map((c) => c.state)));
	check(r1done.every((c) => /第1轮/.test(String(c.res))), "★卡里带着结果（`echo 第1轮` 的输出）", JSON.stringify(r1done.map((c) => c.res)));
	check((await ev(`__probe.occur(${JSON.stringify(TXT_A(1))})`)) === 1, "已经产出的正文仍然只出现一次", `出现 ${await ev(`__probe.occur(${JSON.stringify(TXT_A(1))})`)} 次`);
	check((await ev(`__probe.occur(${JSON.stringify(TXT_DONE(1))})`)) === 1, "收尾正文出现一次", `出现 ${await ev(`__probe.occur(${JSON.stringify(TXT_DONE(1))})`)} 次`);
	// 顺序：工具卡在「这一轮的正文」之后、在「收尾正文」之前（历史里按原顺序画）
	{
		const order = await ev(`(() => {
			const t = document.querySelector('#messages').textContent;
			return [t.indexOf(${JSON.stringify(TXT_A(1))}), t.indexOf('第1轮 && sleep'), t.indexOf(${JSON.stringify(TXT_DONE(1))})];
		})()`);
		check(order[0] >= 0 && order[0] < order[1] && order[1] < order[2] && order[2] > 0, "★顺序对：正文 → 工具卡 → 收尾正文", JSON.stringify(order));
	}

	// ── ② 工具跑着时刷新页面（start 事件错过）⇒ 卡不消失、正文不消失 ──
	phase("② 工具跑着时刷新页面：那张卡必须还在（running），已产出的正文也必须在");
	await ev("__probe.setInput('第二轮：再说一句，再跑一个工具。')");
	await ev("__probe.enter()");
	await waitFor("__probe.cards('#liveBox .tool').some(c => c.state === 'running')", "直播块里又出现 running 的卡");
	await reloadPage(); // 真正的页面刷新：SSE 事件全错过（tool start 不可能收到）
	await sleep(300);
	await waitFor(`__probe.cards().some(c => String(c.args).includes('第2轮'))`, "刷新之后这一轮的卡出现（历史里）");
	const r2 = round(await cards(), 2);
	check(r2.length === 1, "★刷新之后整页只有 1 张这一轮的卡（没多、也没少）", JSON.stringify(r2));
	check(r2.every((c) => c.where === "hist"), "它是历史块画出来的（直播块里没有 start 事件、什么都没有）", JSON.stringify(r2.map((c) => c.where)));
	check(r2.every((c) => c.state === "running"), "★状态是 running（服务端如实标着在跑）", JSON.stringify(r2.map((c) => c.state)));
	check(r2.every((c) => /sleep/.test(String(c.args))), "★卡里带着参数（不是一张没信息的空卡）", JSON.stringify(r2.map((c) => c.args)));
	check((await ev(`__probe.occur(${JSON.stringify(TXT_A(2))})`)) === 1, "★这一轮**已经产出的正文**刷新后还在（且只出现一次）", `出现 ${await ev(`__probe.occur(${JSON.stringify(TXT_A(2))})`)} 次`);
	check((await ev("__probe.cards('#liveBox .tool').length")) === 0, "直播块里没有那张卡（它本来就不该有：start 事件错过了）", JSON.stringify(await ev("__probe.cards('#liveBox .tool')")));
	// 工具在这之后结束 ⇒ 结果必须落到**同一张**卡上（不能变成两张）
	await waitFor(`__probe.cards().some(c => String(c.args).includes('第2轮') && c.state === 'done')`, "刷新之后工具结束、卡变成完成", 40_000);
	const r2done = round(await cards(), 2);
	check(r2done.length === 1, "★工具结束后仍然只有 1 张这一轮的卡（没有「历史一张 + 直播补一张」）", JSON.stringify(r2done));
	check(r2done.every((c) => /第2轮/.test(String(c.res))), "★结果是落到那一张卡上的", JSON.stringify(r2done.map((c) => c.res)));
	await waitFor("!__probe.running()", "第二轮结束", 40_000);

	// ── ④a 工具跑着时中断：live 被收掉（null）⇒ 历史必须照常画那一条（不误跳、不重复）──
	phase("④a 工具跑着时中断：历史照常画那条（live 已收掉）");
	await ev("__probe.setInput('第三轮：长工具，我要中断它。')");
	await ev("__probe.enter()");
	await waitFor("__probe.cards('#liveBox .tool').some(c => c.state === 'running')", "长工具在跑");
	await waitFor("__probe.abortBtn() && !__probe.abortBtn().hidden", "「停止」按钮出现");
	check(await ev("__probe.abort()"), "点了「停止」");
	await waitFor("!__probe.running()", "中断落地（不再「正在跑」）", 30_000);
	await sleep(600);
	const r3 = round(await cards(), 3);
	const r3mark = await ev("__probe.aborted()");
	check(r3.length === 1, "★中断之后整页仍然只有 1 张这一轮的卡", JSON.stringify(r3));
	check(r3.every((c) => c.where === "hist"), "★它是历史块画的（中断把直播块收掉了 ⇒ 不许因为「跳过」而让它消失）", JSON.stringify(r3.map((c) => c.where)));
	check(r3.every((c) => c.state !== "running"), "★没有卡停在「运行中…」（中断之后它必须落定）", JSON.stringify(r3.map((c) => c.state)));
	check((await ev("__probe.cards('#liveBox .tool').length")) === 0, "直播块里没有残留的卡", JSON.stringify(await ev("__probe.cards('#liveBox .tool')")));
	console.log(`  （如实记录）工具跑着时中断后：卡=${JSON.stringify(r3)} 历史里的中断标记=${JSON.stringify(r3mark)}`);

	// ── ④b 流式中断：历史里照常有「⏹ 这一轮被中断了」（+ 已流出的正文不丢）──
	phase("④b 正文流式中断：历史里照常有那条中断标记，已流出的正文不丢");
	await ev("__probe.setInput('第四轮：慢正文，我要中断它。')");
	await ev("__probe.enter()");
	const PREFIX = "慢正文第4轮-第"; // 每一片都以它开头 ⇒ 数它 = 数「整页里有几片」
	await waitFor(`__probe.occur(${JSON.stringify(PREFIX)}) >= 4`, "慢正文流出至少 4 片来");
	const liveBefore = await ev(`__probe.occur(${JSON.stringify(PREFIX)})`);
	check(liveBefore >= 4, "中断前：流出来的那几片在整页里各只有一份（没有同一片画两遍）", `片数 ${liveBefore}`);
	await waitFor("__probe.abortBtn() && !__probe.abortBtn().hidden", "「停止」按钮出现（流式中）");
	check(await ev("__probe.abort()"), "点了「停止」（正文流式当中）");
	const mark = await waitFor("__probe.aborted()", "历史里出现「这一轮被中断了」", 30_000);
	check(/中断/.test(String(mark)), "★历史里照常有那条中断标记", JSON.stringify(mark));
	await sleep(500);
	check((await ev("__probe.cards('#liveBox .tool').length")) === 0, "直播块收掉了（不再有残留的正文）", JSON.stringify(await ev("__probe.cards('#liveBox .tool')")));
	check((await ev(`__probe.occur(${JSON.stringify(SLOW_CHUNK(4, 1))})`)) === 1, "★中断前已经流出来的第一片**还在**（且只出现一次）", `出现 ${await ev(`__probe.occur(${JSON.stringify(SLOW_CHUNK(4, 1))})`)} 次`);
	// 中断会「掐在那一刻」：落盘的正文可能比屏幕上刚流出来的少一两片（pi 那边还没吐完就被掐了）——
	// 所以这里只要求**≥2 片**（证明不是只剩一句空的），并且**每一片都只出现一次**（不重复画）。
	const afterAbort = await ev(`__probe.occur(${JSON.stringify(PREFIX)})`);
	check(afterAbort >= 2, "★中断前流出来的正文（不止一片）还在", `片数 ${liveBefore} → ${afterAbort}`);
	check(afterAbort <= liveBefore, "（如实：中断是掐在那一刻的，落盘不会比屏幕上更多）", `片数 ${liveBefore} → ${afterAbort}`);

	phase("干净度");
	check(pageProblems.length === 0, "页面无未捕获异常 / console.error", pageProblems.join(" | ").slice(0, 400));
} catch (e) {
	bad("浏览器验收跑挂了", String(e.stack ?? e));
} finally {
	console.log("\n── 结果 ──");
	if (failed) console.log(`\n❌ 失败 ${failed} 项`);
	else console.log("\n✅ 全部通过");
	try {
		ws.close();
	} catch {}
	killAll();
	await sleep(400);
	stub.close();
	try {
		fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (e) {
		console.warn(`  ⚠ 临时 profile 没清掉（不影响结果）：${profileDir} —— ${e.code ?? e.message}`);
	}
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清不掉算了 */
	}
	fs.rmSync(path.join(profileDir), { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
