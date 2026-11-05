#!/usr/bin/env node
/**
 * 回归（v2.2 重写后的 B 反代）：**两端都得「一端死了就把另一端也收摊」，且不许伪装成功。**
 *
 * 本仓 v2.1（`v2.1-final:server/app.mjs`）已经用 `test/proxy-abort.mjs` 钉过这套契约；v2.2 的
 * S0b 把 B 应用层整份重写成 `server/app.mjs`（不同 env / 不同代码形状）—— 这个文件是把那套
 * 契约**在 v2.2 的代码上重新钉一遍**，用例一一对应：
 *
 *   ① 普通 /api 转发照常（修法不许顺手弄坏普通请求，也不许丢 keep-alive）。
 *   ② 下游断（刷新页面 / 关标签页 / RST）→ 必须把**上游也销毁**。不做的话 `res` 一死，
 *      `upRes.pipe(res)` 的下一笔 `res.write()` 返回 false → pipe 把 upRes 暂停，而这条暂停
 *      永远等不到 drain（目的端没了）⇒ 每条断掉的 SSE 都在 B→A 留一条不回收的连接。
 *   ③ 没被掐断的 SSE 仍然长活、keepalive **即时**到达（不许被缓冲/攒着）、且不被压缩。
 *   ④ 上游**中途**没（A 重启 / 挂 / RST）→ 下游必须被收掉（Node 的 `pipe` 不会在 Readable
 *      出错时 end 目的端）。对 SSE：如实结束 = 干净 EOF（EventSource 会自己重连），不许永久挂着。
 *   ⑤ 非 SSE 的 body 被截断 → 下游必须**真的中止**，不许「看着像完整结束」（`end()` 的坑：
 *      声明了 Content-Length 只来一半，`end()` 会让客户一直等缺的那截）。
 *   ⑥ A 连不上时：SSE 要「软失败」（200 + text/event-stream，EventSource 才会继续重试），
 *      其它请求照旧 502 —— 这条钉住「重启 A 后标签页能自己回来」。
 *
 * 自足：本进程起一台**假 A** + 把**真 B**（`server/app.mjs`）当子进程拉起来。
 * **不需要 pi、不需要真 A、不碰任何会话目录、不用固定端口、不碰 7331/7321。**
 *
 * 跑法：node test/s1b-proxy.mjs        （通过退出 0；任一条契约回来 → 退出 1）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ABORTS = 20; // 连-断多少次（坏代码 1:1 全漏，20 次足够看出方向）
const KA_MS = 200; // 假 A 多久吐一次 keepalive

const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);

/** 要一个空闲端口：跟 OS 要一个、立刻放掉（B 是子进程，端口只能这么传）。 */
async function freePort() {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const p = s.address().port;
	await new Promise((r) => s.close(r));
	return p;
}

// ── 假 A：带 Accept: text/event-stream 的请求当 SSE；其余回一小段 JSON ──
const liveA = new Set(); // 假 A 这侧还开着的上游 SSE
const fakeA = http.createServer((req, res) => {
	// 「A 中途掉了」的 deterministic 版本：声明 2000 B，只发 200 B 就把连接打死。
	// （B 会把 `/api/trunc` 前缀去掉再转发，所以这里是 `/trunc`。）
	if (req.url === "/trunc") {
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2000" });
		res.write("X".repeat(200));
		setTimeout(() => res.socket.destroy(), 150);
		return;
	}
	// 上游的普通错误响应：B 必须**如实**透传状态与 Content-Type，不许自作主张改成 502/200。
	if (req.url === "/http-error") {
		const body = JSON.stringify({ ok: false, reason: "upstream said no" });
		res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
		return res.end(body);
	}
	if (!(req.headers.accept ?? "").includes("text/event-stream")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify({ ok: true, path: req.url }));
	}
	liveA.add(res);
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
	res.write(`data: {"t":"hello"}\n\n`);
	const ka = setInterval(() => {
		try {
			res.write(": ka\n\n");
		} catch {
			/* close 会收拾 */
		}
	}, KA_MS);
	res.on("close", () => {
		clearInterval(ka);
		liveA.delete(res);
	});
});
await new Promise((r) => fakeA.listen(0, "127.0.0.1", r));
const A_PORT = fakeA.address().port;

// ── 真 B（子进程），上游指到假 A ──
const procs = [];
let bOut = "";
let cleanupDone = false;
const cleanup = () => {
	for (const p of procs) p.kill("SIGKILL");
	for (const r of liveA) r.destroy();
	fakeA.close();
};
process.on("exit", cleanup);
const done = (code) => {
	cleanupDone = true;
	cleanup();
	process.exit(code);
};

/** 起一个真 B，上游指到 `upstreamPort`；等到能连上为止。返回它的端口。 */
async function startB(upstreamPort) {
	const port = await freePort();
	const proc = spawn(process.execPath, ["server/app.mjs"], {
		cwd: ROOT,
		env: {
			...process.env,
			SOPHO_APP_HOST: "127.0.0.1",
			SOPHO_APP_PORT: String(port),
			SOPHO_UPSTREAM_HOST: "127.0.0.1",
			SOPHO_UPSTREAM_PORT: String(upstreamPort),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	procs.push(proc);
	proc.stdout.on("data", (c) => (bOut += c));
	proc.stderr.on("data", (c) => (bOut += c));
	proc.on("exit", (code) => {
		if (cleanupDone) return;
		console.error(`❌ B 自己退出了（code=${code}）\n${bOut}`);
		process.exit(1);
	});
	for (let i = 0; ; i++) {
		try {
			await new Promise((res, rej) => {
				const s = net.connect(port, "127.0.0.1");
				s.on("connect", () => { s.destroy(); res(); });
				s.on("error", rej);
			});
			return port;
		} catch {
			if (i > 100) {
				console.error(`❌ 等不到 B 起来（${port}）\n${bOut}`);
				done(1);
			}
			await sleep(100);
		}
	}
}

const BPORT = await startB(A_PORT);

/** 一次 HTTP 往返：`abortOnFirstChunk` = 读到首块就 RST（刷新页面 / 关标签页）；否则挂 `keepMs` 再交出 socket。
 *  `raw` / `endedAt` 是**活的**（getter）：④⑤ 需要在后续时刻看到「下游到底收没收摊」。 */
function req(path, { accept = "text/event-stream", abortOnFirstChunk = false, keepMs = 0, port = BPORT } = {}) {
	return new Promise((resolve, reject) => {
		const s = net.connect(port, "127.0.0.1");
		let chunks = 0;
		let buf = "";
		const t0 = Date.now();
		let endedAt = null;
		s.on("end", () => (endedAt ??= Date.now() - t0));
		s.on("close", () => (endedAt ??= Date.now() - t0));
		s.on("connect", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: ${accept}\r\nConnection: keep-alive\r\n\r\n`));
		const out = { get raw() { return buf; }, get endedAt() { return endedAt; }, sock: s };
		s.on("error", (e) => (abortOnFirstChunk ? resolve(out) : reject(e)));
		s.on("data", (c) => {
			chunks++;
			buf += c.toString();
			if (abortOnFirstChunk && chunks === 1) {
				s.resetAndDestroy();
				resolve(out);
			}
		});
		if (!abortOnFirstChunk) setTimeout(() => resolve(out), keepMs);
	});
}

try {
	console.log("── B 反代：客户端断开 → 上游必须被销毁 ──");
	ok("B 起来了（子进程）", `端口 ${BPORT} → 假 A ${A_PORT}`);

	// ① 普通 /api 请求照常（修法不许顺手把普通请求弄坏、也不许丢掉 keep-alive）
	{
		const { raw, sock } = await req("/api/tree", { accept: "application/json", keepMs: 400 });
		sock.destroy();
		assert.match(raw, /200 OK/, "普通请求没回 200");
		assert.match(raw, /content-type: application\/json/i, "普通请求的 Content-Type 不对");
		assert.match(raw, /\{"ok":true/, "普通请求的 body 不对");
		ok("普通 /api 请求照常转发", raw.split("\r\n")[0]);
	}

	// ①b 上游返回非 200：状态码与 Content-Type **如实**透传（不是 B 自己编的 502）
	{
		const { raw, sock } = await req("/api/http-error", { accept: "application/json", keepMs: 400 });
		sock.destroy();
		assert.match(raw, /^HTTP\/1\.1 503 /, `上游 503 未如实透传：${raw.split("\r\n")[0]}`);
		assert.match(raw, /content-type: application\/json/i, "上游 Content-Type 未如实透传");
		assert.match(raw, /"reason":"upstream said no"/, "上游错误 body 未如实透传");
		ok("上游非 200：状态 / Content-Type / body 如实透传", raw.split("\r\n")[0]);
	}

	// ② 连-断 ABORTS 次：断完上游不能剩
	for (let i = 0; i < ABORTS; i++) await req("/api/events", { abortOnFirstChunk: true });
	await sleep(500);
	assert.equal(liveA.size, 0, `断开后假 A 侧还挂着 ${liveA.size} 条上游 SSE（应为 0）`);
	ok(`${ABORTS} 次「连上 SSE → 立刻 RST」之后，假 A 侧还开着的 SSE = 0`, "（坏代码这里是 1:1 全漏）");

	// ③ 没被掐断的 SSE 仍然长活，且 keepalive **即时**到达（不许被缓冲/攒着），也不许被压缩
	{
		const before = liveA.size;
		const { raw, sock } = await req("/api/events", { keepMs: KA_MS * 3 + 200 });
		const ka = (raw.match(/: ka/g) ?? []).length;
		assert.equal(liveA.size, before + 1, "正常开着的 SSE 没到假 A 那侧");
		sock.destroy();
		await sleep(300);
		assert.equal(liveA.size, before, "正常开着的 SSE 被误掐了");
		assert.match(raw, /content-type: text\/event-stream/i, "SSE 的 Content-Type 不对");
		assert.doesNotMatch(raw, /content-encoding:/i, "SSE 被压缩了（本项目规矩：SSE 不走压缩出口）");
		assert.ok(ka >= 2, `${KA_MS * 3 + 200}ms 里只收到 ${ka} 条 keepalive —— 被缓冲了？`);
		ok("正常 SSE 没被误掐、keepalive 即时到达、不压缩", `${KA_MS * 3 + 200}ms 里收到 ${ka} 条 \`: ka\``);
	}

	console.log("\n── 反向：上游中途没（A 重启 / 挂）→ 下游必须被收掉 ──");

	// ④ 客户端挂着的 SSE，**中途把上游掐了** → 下游不能永久挂着；必须是**如实结束**（干净 EOF）
	{
		const r = await req("/api/events", { keepMs: KA_MS + 150 });
		assert.match(r.raw, /"t":"hello"/, "SSE 没连上");
		for (const s of liveA) s.socket.destroy(); // 模拟「A 中途没了」
		await sleep(1200);
		const chunkTerm = r.raw.includes("0\r\n\r\n"); // `res.end()` 那条路：chunked 终止块 = 对 EventSource 而言的干净 EOF
		assert.ok(r.endedAt !== null || chunkTerm, "上游断了，下游却 1.2s 都没收摊（socket 还挂着、EventSource 永不重连）");
		ok("上游中途断掉 → 下游立刻收摊", r.endedAt !== null ? `${r.endedAt} ms 内收到 EOF` : "收到了 chunked 终止块（干净结束）");
		r.sock.destroy();
	}

	// ⑤ 非 SSE 的 body 被截断：B 必须**真的中止**下游 —— 钉的是「为什么是 destroy() 不是 end()」：
	//    假 A 声明 Content-Length: 2000、只发 200 就断；`end()` 的话 B 会「正常结束」，
	//    客户端于是一直等缺的那 1800 B，`destroy()` 才会立刻断掉。
	{
		const r = await req("/api/trunc", { accept: "application/json", keepMs: 900 });
		assert.match(r.raw, /content-length: 2000/i, "假 A 的 Content-Length 没转到下游");
		assert.ok(r.endedAt !== null, "body 被截断，下游却没收摊（客户端会一直等缺的那截）");
		ok("截断的 body：下游被真的中止（EOF）", `${r.endedAt} ms 内 EOF`);
		r.sock.destroy();
	}

	// ⑥ A 连不上时：SSE 要「软失败」（200 + text/event-stream，EventSource 才会继续重试），
	//    其它请求照旧 502 —— 这条钉住「重启 A 后标签页能自己回来」。
	{
		const dead = await freePort(); // 没任何人监听：ECONNREFUSED
		const port = await startB(dead);
		const sse = await req("/api/events", { port, keepMs: 400 });
		assert.match(sse.raw, /^HTTP\/1\.1 200 OK/, `A 连不上时 SSE 没软失败：${sse.raw.split("\r\n")[0]}`);
		assert.match(sse.raw, /content-type: text\/event-stream/i, "软失败没带 event-stream");
		// `res.end()` 在 keep-alive 的连接上只会补上 chunked 终止块、不关 socket（对 EventSource
		// 一样是「干净 EOF → 待会儿重连」），所以判「响应真的结束了」= EOF **或** 终止块。
		assert.ok(sse.endedAt !== null || sse.raw.includes("0\r\n\r\n"), "软失败没把响应结束掉（客户端会一直挂着）");
		ok("A 连不上 → SSE 软失败（200 + event-stream + 立刻结束）", sse.raw.split("\r\n")[0]);
		sse.sock.destroy();
		const json = await req("/api/tree", { port, accept: "application/json", keepMs: 400 });
		assert.match(json.raw, /^HTTP\/1\.1 502/, `非 SSE 请求该回 502，实际：${json.raw.split("\r\n")[0]}`);
		ok("A 连不上 → 非 SSE 请求照旧 502", json.raw.split("\r\n")[0]);
		json.sock.destroy();
	}

	console.log("\n✅ 全部通过");
	done(0);
} catch (err) {
	console.error(`\n❌ ${err?.message ?? err}`);
	done(1);
}
