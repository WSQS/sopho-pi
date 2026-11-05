#!/usr/bin/env node
/**
 * 回归：「**压缩中发消息**」必须 **409**、且消息**不进会话**。
 *
 * 为什么要有这条（已实测的坑，内部「坑表」有记录）：
 *   pi 在压缩期间拒收任何 prompt —— `Cannot submit a prompt while compaction is in progress.`
 *   而 `deliver()` 以前判"接不接受"是拿**错误文本**匹配 `/already processing/i`：
 *   压缩的报错匹配不上 ⇒ `accepted = true` ⇒ 路由回 **202**，消息却被**静默丢掉**
 *   （直接违反 `server/base-logic.mjs` 那句「真接受不了就别回 202（回 409 并说清）」）。
 *   修法：判据改成「pi **有没有拒绝**」这个事实（`rec.rejected`）。
 *
 * 判据（**HTTP 状态 + 文件内容**，不用"正文形状" —— 事后从 .jsonl 分不出 steer 与普通 prompt）：
 *   1) 压缩窗口里 `POST /sessions/{id}/message` → **HTTP 409**，回执 `accepted === false`，
 *      且 `error` 里带 pi 的原话（"compaction in progress"）；
 *   2) 那条消息的**唯一标记**既不在会话文件里、也不在 `GET /messages` 里；
 *   3) 对照：会话**空闲**（压缩跑完）时同样的 POST → **202** 且**真的进了**会话。
 *
 * 需要：A 在跑（默认 127.0.0.1:7331）+ 一个能用的模型（压缩 = 一次 LLM 摘要）。
 * 会话：默认**自己造一条**（往 A 的 sessions 目录写一条合成的、够大的会话，用完删掉）——
 *   这样不依赖任何既有会话。也可以 `--session <完整 id>` 用一条现成的**还没压过**的大会话。
 *   ⚠️ 往 sessions 目录写文件是**故意**的（A 的 `fileOf` 是每次扫盘，新文件能被认到）；
 *      用 `--keep` 可以留下那条合成会话自己看。
 *
 * 用法：BASE=http://127.0.0.1:7331 node test/compact-window.mjs
 * 退出码：通过 0；任何一条断言不成立 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:7331";
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const KEEP = args.includes("--keep");
const GIVEN = argOf("session");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = async (p, o) => {
	const r = await fetch(BASE + p, o);
	let b; try { b = await r.json(); } catch { b = null; }
	return { code: r.status, body: b };
};
const post = (p, obj) => json(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj ?? {}) });

let failed = 0;
const check = (name, ok, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  —— ${detail}` : ""}`);
};

// ── 0. 会话：给定 or 合成 ────────────────────────────────────────────────
const host = await json("/host");
if (host.code !== 200 || !host.body?.sessions) {
	console.error(`✗ 连不上 A（${BASE}/host）—— 先起 A：ASSIST_HOME=<沙箱> SOPHO_BASE_PORT=7331 node server/base.mjs`);
	process.exit(2);
}
const SESSIONS = host.body.sessions;

let file = null;
let id = GIVEN ?? null;
const hex = (n) => randomBytes(n).toString("hex").slice(0, n);

if (!id) {
	id = randomUUID();
	const dir = path.join(SESSIONS, "--sopho-compact-probe--");
	fs.mkdirSync(dir, { recursive: true });
	file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
	// 合成一条"够大"的会话：keepRecentTokens 默认 20000 ⇒ 要有 >2 万 token 的旧内容可压。
	// 40 条 × ~3000 字符文本 ≈ 6 万 token（中文字符约 1 token/字，够）。
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: os.tmpdir() })];
	let parentId = null;
	const t0 = Date.now();
	for (let i = 0; i < 40; i++) {
		const mid = hex(8);
		const text = `[seed ${i}] ` + `这是一条用来把上下文撑大的合成消息。`.repeat(120);
		lines.push(JSON.stringify({ type: "message", id: mid, parentId, timestamp: new Date(t0 + i * 1000).toISOString(), message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text }], timestamp: t0 + i * 1000 } }));
		parentId = mid;
	}
	fs.writeFileSync(file, lines.join("\n") + "\n");
	console.log(`合成探测会话：${id}（file=${file}）`);
} else {
	const s = await json(`/sessions/${id}`);
	if (s.code !== 200) { console.error(`✗ 没有这个会话：${id}`); process.exit(2); }
	file = s.body.file;
	console.log(`用现成会话：${id}（file=${file}）`);
}
const readFileSafe = () => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const cleanup = () => { if (file && !GIVEN && !KEEP) { try { fs.unlinkSync(file); } catch {} } };

try {
	// ── 1. 起压缩 + 抓 SSE 的 compact start/end ──
	const evs = [];
	const ctrl = new AbortController();
	const res = await fetch(`${BASE}/sessions/${id}/stream`, { signal: ctrl.signal });
	const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
	(async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const fr = buf.slice(0, i); buf = buf.slice(i + 2); const dl = fr.split("\n").find((l) => l.startsWith("data: ")); if (dl) evs.push(JSON.parse(dl.slice(6))); } } } catch {} })();
	const waitEv = async (pred, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const e = evs.find(pred); if (e) return e; await sleep(80); } return null; };

	const compactP = post(`/sessions/${id}/compact`, {});
	const started = await waitEv((e) => e.t === "compact" && e.phase === "start", 30000);
	check("压缩已开始（SSE {t:compact,phase:start}）", !!started);
	if (!started) { console.error("（压缩起不来：模型/上下文有问题，没法测这个窗口）"); throw new Error("no compaction"); }

	const MARK = `COMPACT-WINDOW-MARK-${Date.now()}-${hex(4)}`;
	const msg = await post(`/sessions/${id}/message`, { text: MARK, behavior: "steer" });
	check("★压缩中发消息 → HTTP 409（不是 202）", msg.code === 409, `HTTP ${msg.code} body=${JSON.stringify(msg.body && { streaming: msg.body.streaming, behavior: msg.body.behavior, accepted: msg.body.accepted })}`);
	check("★回执 accepted === false", msg.body?.accepted === false, `accepted=${msg.body?.accepted}`);
	check("★回执把 pi 的原话带给前端（识别压缩窗口的判据）", /compaction .*in progress/i.test(String(msg.body?.error ?? "")), `error=${JSON.stringify(msg.body?.error)}`);
	await sleep(300);
	check("★那条消息**没进会话**（文件里没有这个标记）", !readFileSafe().includes(MARK));
	const m1 = await json(`/sessions/${id}/messages`);
	check("★那条消息**没进会话**（/messages 里也没有）", !(m1.body?.messages ?? []).some((m) => m.role === "user" && String(m.text).includes(MARK)));

	const ended = await waitEv((e) => e.t === "compact" && (e.phase === "end" || e.phase === "error"), 180000);
	const cr = await compactP;
	check("压缩跑完了（end）", ended?.phase === "end", `phase=${ended?.phase} compact回执 HTTP ${cr.code} ${cr.body?.error ?? ""}`);

	// ── 2. 对照：空闲时发同样的消息 → 202 且**真的进会话** ──
	const OK = `IDLE-MARK-${Date.now()}-${hex(4)}`;
	const idle = await post(`/sessions/${id}/message`, { text: OK });
	check("对照·空闲发消息 → HTTP 202", idle.code === 202, `HTTP ${idle.code}`);
	let landed = false;
	for (let i = 0; i < 40 && !landed; i++) { await sleep(250); landed = readFileSafe().includes(OK); }
	check("对照·空闲那条**真的进了会话**（文件里有标记）", landed);
	ctrl.abort();
} catch (e) {
	console.error(`✗ 跑挂了：${e.stack ?? e}`);
	failed++;
} finally {
	cleanup();
	console.log(failed ? `\n❌ ${failed} 项断言失败` : `\n✅ compact-window 全部通过`);
	process.exit(failed ? 1 : 0);
}
