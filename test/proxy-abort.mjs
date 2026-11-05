#!/usr/bin/env node
/**
 * 回归：**`server/app.mjs` 的反代，两端都得「一端死了就把另一端也收摊」。**
 *
 * 被钉住的两个 bug（都实测到过）：
 *   ① **下游断**（刷新页面 / 关标签页）→ 必须把上游也销毁。不做的话：`res` 一死，
 *      `upRes.pipe(res)` 的下一笔 `res.write()` 返回 false → pipe 把 upRes 暂停，
 *      而这条暂停**永远等不到 drain** ⇒ 每条断掉的 SSE 都在 B→A 留下一条不回收的连接
 *      （旧代码：200 次连-断 → 200 条 ESTAB、A 的 `openConnections` 卡在 200）。
 *   ② **上游中途没**（A 被重启 / 挂掉 / RST）→ 必须把下游也收掉。不做的话：Node 的
 *      `pipe` **不**会在 Readable 出错时 end 目的端 ⇒ 下游 socket 永久挂着（实测：
 *      杀掉 A 之后客户端 12s+ 收不到 EOF，两边一直 ESTAB，标签页的 EventSource 也永
 *      不重连）。修法是 `upRes.on("error") → res.destroy()`（为什么不是 `res.end()`：
 *      `end()` 会让「声明了 Content-Length 但只来一半」的下游**一直等缺的那截** —— 见 ⑤）。
 *
 * 自足：本进程起一台**假 A** + 把**真 B** 当子进程拉起来（`SOPHO_BASE_URL` 指向假 A）。
 * **不需要 pi、不需要真 A、不碰任何会话目录、不用固定端口**。
 *
 * 跑法：npm run test:proxy        （通过退出 0；任一个 bug 回来 → 退出 1）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ABORTS = 20; // 连-断多少次（旧代码 1:1 全漏，20 次足够看出方向）
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

/** 起一个真 B，上游指到 `baseUrl`；等到能连上为止。返回它的端口。 */
async function startB(baseUrl) {
	const port = await freePort();
	const proc = spawn(process.execPath, ["server/app.mjs"], {
		cwd: ROOT,
		env: { ...process.env, SOPHO_BASE_URL: baseUrl, SOPHO_PORT: String(port), SOPHO_HOST: "127.0.0.1" },
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
		} catch (e) {
			if (i > 100) {
				console.error(`❌ 等不到 B 起来（${port}）\n${bOut}`);
				done(1);
			}
			await sleep(100);
		}
	}
}

const BPORT = await startB(`http://127.0.0.1:${A_PORT}`);

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
		assert.match(raw, /\{"ok":true/, "普通请求的 body 不对");
		ok("普通 /api 请求照常转发", raw.split("\r\n")[0]);
	}

	// ② 连-断 ABORTS 次：断完上游不能剩
	for (let i = 0; i < ABORTS; i++) await req("/api/events", { abortOnFirstChunk: true });
	await sleep(500);
	assert.equal(liveA.size, 0, `断开后假 A 侧还挂着 ${liveA.size} 条上游 SSE（应为 0）`);
	ok(`${ABORTS} 次「连上 SSE → 立刻 RST」之后，假 A 侧还开着的 SSE = 0`, "（旧代码这里是 1:1 全漏）");

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

	// ④ 客户端挂着的 SSE，**中途把上游掐了** → 下游不能永久挂着
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

	// ⑤ 非 SSE 的 body 被截断：B 必须**真的中止**下游 —— 这条钉的是「为什么是 destroy() 不是 end()」：
	//    假 A 声明 Content-Length: 2000、只发 200 就断；`end()` 的话 B 会「正常结束」，
	//    客户端于是一直等缺的那 1800 B（实测 5s 都没收摊），`destroy()` 才会立刻断掉。
	{
		const r = await req("/api/trunc", { accept: "application/json", keepMs: 900 });
		assert.match(r.raw, /content-length: 2000/i, "假 A 的 Content-Length 没转到下游");
		assert.ok(r.endedAt !== null, "body 被截断，下游却没收摊（客户端会一直等缺的那截）");
		ok("截断的 body：下游被真的中止（EOF）", `${r.endedAt} ms 内 EOF`);
		r.sock.destroy();
	}

	// ⑥ A 连不上时：SSE 要「软失败」（200 + text/event-stream，EventSource 才会继续重试），
	//    其它请求照旧 502 —— 这条钉住「重启 A 后标签页能自己回来」（实测 502 会让 EventSource
	//    readyState=2 永久放弃：全链实测见 /tmp/proxy-upstream-dies.md）。
	{
		const dead = await freePort(); // 没任何人监听：ECONNREFUSED
		const port = await startB(`http://127.0.0.1:${dead}`);
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
