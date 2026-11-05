#!/usr/bin/env node
/**
 * 复现 / 回归：**两条（或多条）消息落进 pi 的 `isStreaming` 窗口**时，后到的是不是被静默吞掉。
 *
 * 机制（已核到行，别重新调查）：
 *   `server/base.mjs:313-319` 的 `prompt()` 是**同步读** `s.isStreaming` 决定带不带
 *   `streamingBehavior`；而 pi 的 `AgentSession.prompt()` 把 `_isAgentRunActive = true`
 *   放在**若干 `await` 之后**（`agent-session.js:773/860`）。同 tick 两条：
 *     · 两条都读到 `isStreaming === false` → 都走「普通 prompt」（不带 behavior）
 *     · 后一条到 `:860` 时前一条已经把 active 置 true → 抛
 *       "Agent is already processing…" → 宿主 `.catch` 变成一条 SSE error，**HTTP 照样 202**。
 *
 * ── 为什么用 /dev-burst 而不是两条 HTTP 请求 ──────────────────────────────
 * 两台 HTTP 请求**打不进这个窗口**：窗口只跨**微任务**（实测 2 个微任务、~0.5ms），
 * 而 Node 在两个 socket / 两个请求回调之间**必定把微任务抽干**（见 `--mode http` 那一档，
 * 永远 0 命中，连带 pipelining 也一样）。同 tick 只能在**进程内**造 —— A 的
 * `POST /sessions/{id}/dev-burst`（base-logic 里的 dev-only 路由）正是干这个：同一个 tick
 * 连发 N 条，走的就是 `/message` 那条发消息的路。
 *
 * 用法：
 *   node test/race-message.mjs --trials 10 --n 3          # 每轮同 tick 发 3 条
 *   node test/race-message.mjs --mode http --trials 5     # 两条并发 HTTP（对照，预期 0 命中）
 *   BASE=http://127.0.0.1:7331 node test/race-message.mjs
 *
 * 退出码：命中（丢**或重**）→ 1；一次没中 → 0。修好之后就该是 0。
 */
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:7331";
const args = process.argv.slice(2);
const argOf = (k, d) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : d;
};
const TRIALS = Number(argOf("trials", 10));
const N = Number(argOf("n", 3)); // 每轮同 tick 发几条
const MODE = argOf("mode", "burst");
const SESSION = argOf("session", null);
const QUIET_MS = Number(argOf("quiet", 700));

const json = async (path, opts) => {
	const r = await fetch(BASE + path, opts);
	const t = await r.text();
	let b;
	try {
		b = JSON.parse(t);
	} catch {
		b = t;
	}
	return { code: r.status, body: b };
};
const post = (path, obj) =>
	json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj ?? {}) });

const safeParse = (s) => {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
};

// ── 两条并发 HTTP（对照档；预期打不进窗口）───────────────────────────────
async function concurrentPost(pathsAndBodies) {
	const reqs = pathsAndBodies.map(({ path, body }) =>
		fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({
			code: r.status,
			body: safeParse(await r.text()),
		})),
	);
	return Promise.all(reqs);
}

// ── SSE：抓第二条被丢时广播出来的 error ──────────────────────────────────
async function watchErrors(id, sink) {
	const ctrl = new AbortController();
	const res = await fetch(`${BASE}/sessions/${id}/stream`, { signal: ctrl.signal });
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	(async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				for (const line of dec.decode(value, { stream: true }).split("\n")) {
					if (!line.startsWith("data:")) continue;
					const p = safeParse(line.slice(5).trim());
					if (p && p.t === "error") sink.push(String(p.message ?? p));
				}
			}
		} catch {
			/* 关流 */
		}
	})();
	return () => ctrl.abort();
}

async function userMessages(id) {
	const { body } = await json(`/sessions/${id}`);
	const { readFileSync } = await import("node:fs");
	let n = 0;
	for (const line of readFileSync(body.file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			if (JSON.parse(line)?.message?.role === "user") n++;
		} catch {
			/* 半行 */
		}
	}
	return n;
}

async function waitIdle(id, ms = 180_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if ((await json(`/sessions/${id}`)).body.streaming === false) {
			await sleep(QUIET_MS);
			if ((await json(`/sessions/${id}`)).body.streaming === false) return true;
		}
		await sleep(250);
	}
	return false;
}

// ── main ────────────────────────────────────────────────────────────────
let created = false;
let id = SESSION;
const mkSession = async () => {
	const { code, body } = await post("/sessions", { cwd: process.cwd(), name: "#race-probe 消息竞态复现" });
	if (code !== 201) {
		console.error("建探针会话失败", code, body);
		process.exit(2);
	}
	return body;
};
if (!id) {
	const b = await mkSession();
	id = b.id;
	created = true;
	console.log(`探针会话：${id.slice(0, 8)}（file=${b.file}）`);
}
console.log(`模式=${MODE}  每轮同 tick 发 ${MODE === "burst" ? N : 2} 条  trials=${TRIALS}`);
console.log(MODE === "burst" ? "（每轮用一个全新会话，避开上一轮失败 prompt 把 isStreaming 旗子踩乱）\n" : "");

const errors = [];
let stop = null;
if (MODE !== "burst" || SESSION) {
	stop = await watchErrors(id, errors);
	await sleep(300);
}

let hits = 0;
for (let i = 1; i <= TRIALS; i++) {
	// burst 模式每轮新建会话：上一轮被竞态踩坏的 isStreaming 旗子会污染下一轮
	let sid = id;
	let createdThis = null;
	if (MODE === "burst" && !SESSION) {
		const b = await mkSession();
		sid = b.id;
		createdThis = sid;
		// 每轮独立 SSE（抓住被丢那几条的 error 广播）
		stop = await watchErrors(sid, errors);
		await sleep(200);
	} else if (!(await waitIdle(sid))) {
		console.error(`第 ${i} 轮：会话一直没空闲，放弃`);
		break;
	}
	if (MODE === "burst" && SESSION && !(await waitIdle(sid))) break;

	const before = await userMessages(sid);
	const errBefore = errors.length;
	const tag = `race#${process.pid}-${i}`;
	let codes;
	if (MODE === "burst") {
		const r = await post(`/sessions/${sid}/dev-burst`, { n: N, text: tag });
		codes = Array.isArray(r.body?.results) ? r.body.results.map((x) => `s=${x?.streaming} b=${x?.behavior ?? "-"}`).join(" | ") : JSON.stringify(r.body);
	} else {
		const rs = await concurrentPost([
			{ path: `/sessions/${sid}/message`, body: { text: `${tag}-A` } },
			{ path: `/sessions/${sid}/message`, body: { text: `${tag}-B` } },
		]);
		codes = rs.map((x) => `HTTP=${x.code} s=${x.body?.streaming} b=${x.body?.behavior ?? "-"}`).join(" | ");
	}
	await sleep(400);
	const dropped = errors.length - errBefore;
	await waitIdle(sid);
	const landed = (await userMessages(sid)) - before;
	const want = MODE === "burst" ? N : 2;
	// ⚠️ **`!==`，不是 `<`**：少一条是“丢”，多一条是“**重**” —— 两个都要抓。
	// （`deliver()` 的“撞了就改 steer 重发”只能发生在第一发**被拒**之后，被拒=没入队 ⇒
	//   机制上不该重；但这条只能靠断言看住，别依赖“应该不会”。）
	const lost = dropped > 0 || landed !== want;
	if (lost) hits++;
	console.log(
		`#${String(i).padStart(2)}  打进 ${want} 条 → 落库 user 消息 ${landed}/${want}${landed > want ? "（**多了**=重）" : ""}  SSE错误=${dropped ? `${dropped} 条「${errors[errBefore]}」` : "无"}  → ${lost ? "❌ 丢/重" : "✓ 不丢不重"}\n     ${codes}`,
	);
	if (createdThis) {
		stop?.();
		await post(`/sessions/${createdThis}/archive`);
	}
}

stop?.();
console.log(`\n命中率：${hits}/${TRIALS}（${((hits / TRIALS) * 100).toFixed(0)}%）　（命中 = 丢或重）`);
if (created) {
	await post(`/sessions/${id}/archive`);
	console.log(`探针会话 ${id.slice(0, 8)} 已归档`);
}
process.exit(hits > 0 ? 1 : 0);
