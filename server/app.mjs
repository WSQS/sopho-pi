#!/usr/bin/env node
/**
 * v2 · 应用层（进程 B）—— 常改的那一层。
 *
 * 只做三件事：① 服务前端静态文件；② 把 /api/* 反代给 A（会话基底）；
 * ③ 别的什么都不做。**重启 B 不会碰到 A 里的会话。**
 *
 * 环境变量：SOPHO_PORT / SOPHO_HOST / SOPHO_BASE_URL（默认 http://127.0.0.1:7331）
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const PORT = Number(process.env.SOPHO_PORT ?? 7322);
const HOST = process.env.SOPHO_HOST ?? "0.0.0.0"; // 与 bin/serve.sh 一致：默认面向 LAN（零认证，见 README 顶部警告）
const BASE = (process.env.SOPHO_BASE_URL ?? `http://127.0.0.1:${process.env.SOPHO_BASE_PORT ?? 7331}`).replace(/\/+$/, "");

const MIME = {
	".html": "text/html; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

// ─────────────────── 静态资源：压缩 + ETag/304 + 一个想清楚的缓存策略 ───────────────────
// 与宿主/server/base.mjs 里那份是**同一条约定**（阈值/编码策略一致），代码有意重复：
// 两个进程各有各的存活周期（B 常重启、A 几乎不动），共用一个模块 = 改一边能把另一边弄挂。
// ⚠️ 压缩**只做白名单里的文本类型**：图片/字体本来就压过（或压不动），再蒸一遍白烧 CPU；
//    也**绝不碰 SSE**（本文件只服务静态文件，/api/* 是纯管道，原样转发不碰）。
const COMPRESS_MIN = Number(process.env.SOPHO_COMPRESS_MIN ?? 1024); // 与 base.mjs 同一个阈值，理由见那边
const GZIP_LEVEL = Number(process.env.SOPHO_GZIP_LEVEL ?? 6);
const BROTLI_QUALITY = Number(process.env.SOPHO_BROTLI_QUALITY ?? 5);
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/i;

/** Accept-Encoding → 'br' | 'gzip' | 'identity'（认 q 值与 `*`；不支持就不压）。 */
function pickEncoding(header) {
	const q = new Map();
	let star = null;
	for (const part of String(header ?? "").split(",")) {
		const seg = part.trim();
		if (!seg) continue;
		const [name, ...params] = seg.split(";");
		let w = 1;
		for (const p of params) {
			const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
			if (m) w = Number(m[1]);
		}
		const key = name.trim().toLowerCase();
		if (key === "*") star = w;
		else q.set(key, w);
	}
	const weight = (n) => (q.has(n) ? q.get(n) : (star ?? 0));
	// q 值说了算（q 相同时 br 优先：同样的 CPU 少 20% 字节）；都不支持 → 不压。
	const bw = weight("br");
	const gw = weight("gzip");
	if (bw <= 0 && gw <= 0) return "identity";
	if (bw <= 0) return "gzip";
	if (gw <= 0) return "br";
	return bw >= gw ? "br" : "gzip";
}

const etagOf = (body, enc) => `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}-${enc}"`;

/** 静态文件的 Cache-Control —— 两边不一样，**这是故意的**：
 *  · html（现在就 index.html）= `no-store` 吗？不是：`no-cache`（可存、**每次都要复验**）。
 *    入口文档一变（新版 web/app.mjs 的 <script src>、样式），下次请求就该拿到新的 ——
 *    所以它不能有任何新鲜期；但也**没必要**堵住存储：配上 ETag 后复验就是一次 304（0 字节）。
 *  · 其它资源（.mjs/.js/.css/.svg）= **同样 `no-cache`**，不给 `max-age`。
 *    为什么不做"永久缓存"：**这个项目没有构建指纹** —— 文件 URL 恒是 /app.mjs、/style.css，
 *    内容变了 URL 不变。要是设成 `max-age=31536000, immutable`，用户"改了代码刷新还是旧的"，
 *    会直接怀疑人生（且没法靠一次硬刷新自救）。
 *    想拿掉这条复验 RTT 的正路只有一条：**给 URL 加版本（?v= 或文件名指纹）**，那是前端（web/）
 *    的事，不在这一个改动的范围内；一旦有了指纹，这里就该改成 `max-age=31536000, immutable`。
 */
const cacheControlFor = () => "no-cache";

/** 修一个文件到位：ETag/If-None-Match(304) + 按类型压缩。code 非 200（403/404）时不带 ETag。 */
function sendFile(req, res, code, body, type, mtimeMs) {
	const headers = { "Content-Type": type };
	if (code !== 200) {
		headers["Cache-Control"] = "no-store"; // 错误是瞬时的：别让客户端把 404 记下来
		res.writeHead(code, headers);
		return res.end(body);
	}
	const enc = COMPRESSIBLE.test(type) && body.length >= COMPRESS_MIN ? pickEncoding(req.headers["accept-encoding"]) : "identity";
	const etag = etagOf(body, enc);
	const lastModified = new Date(mtimeMs).toUTCString();
	headers.Vary = "Accept-Encoding"; // 同一 URL 按编码给不同字节 → 缓存必须按编码分槽
	headers.ETag = etag;
	headers["Cache-Control"] = cacheControlFor();
	headers["Last-Modified"] = lastModified; // 只做 IMS 的老客户端（/代理）也有得谈

	// 复验：ETag 优先（比 IMS 准），客户端只给 If-Modified-Since 就退回比时间（秒级）。
	const inm = String(req.headers["if-none-match"] ?? "");
	const ims = Date.parse(String(req.headers["if-modified-since"] ?? ""));
	const fresh = inm
		? inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")
		: Number.isFinite(ims) && Math.floor(mtimeMs / 1000) * 1000 <= ims;
	if (fresh) return res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"], "Last-Modified": lastModified, Vary: "Accept-Encoding" }).end();

	if (enc !== "identity") {
		let out = null;
		try {
			out =
				enc === "br"
					? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
					: gzipSync(body, { level: GZIP_LEVEL });
		} catch {
			out = null; // 压不动就原样发
		}
		if (out) {
			headers["Content-Encoding"] = enc;
			headers["Content-Length"] = out.length;
			return res.writeHead(code, headers).end(out);
		}
	}
	headers["Content-Length"] = body.length;
	res.writeHead(code, headers).end(body);
}

/** /api/<x> → BASE/<x>，纯管道（SSE 不缓冲）。
 *
 *  ⚠️ 客户端断开（刷新页面 / 关标签页 / 网络断）时**必须把上游也切断** —— 这是被量出来的泄漏：
 *    · `res` 一死，`upRes.pipe(res)` 的下一笔 `res.write()` 就返回 false → pipe 把 upRes 暂停。
 *      而这条暂停**永远等不到 drain**（目的端已经没了）——B 从此既不读 A、也不销毁 `up`；
 *    · A 那侧 `req.on("close")` 是**唯一**回收 SSE 订阅的地方，可它收不到 close
 *      （B→A 的 socket 一直挂 ESTAB）⇒ 每条断掉的 SSE 都永久占住一条连接。
 *      实测：B→A 91 条上游连接、A 的 `openConnections` 111，而下游真实客户端只有 23 条；
 *    · 大 body 被中途 abort（比如几 MB 的 `/messages`）还多一层：暂停后未读的那截全堆在
 *      recv-q（实测单条卡在 59 KB 不再动，socket 缓冲塞满后连 A 也写不动）。
 *
 *  为什么是 `!res.writableFinished`：正常跑完时 `close` 也会响，那时 `up` 已经没事了 ——
 *  不判断的话每条 `/api/*` 都会顺手掐掉与 A 的 keep-alive（Node 19+ 的 globalAgent 默认开着它），
 *  白丢复用连接。修泄漏不该换来连接 churn。
 */
function proxy(req, res, rest) {
	const u = new URL(BASE + rest);
	const up = http.request(
		{
			hostname: u.hostname,
			port: u.port,
			path: u.pathname + u.search,
			method: req.method,
			headers: { ...req.headers, host: u.host },
		},
		(upRes) => {
			res.writeHead(upRes.statusCode ?? 502, upRes.headers);
			// ⚠️ 上游**中途**没了（A 被重启 / 挂了 / RST）时，Node 的 `pipe` **不会**替我们收掉下游
			//   （规矩：Readable 出错时**不**自动 end 目的端）⇒ 下游 socket 永久挂着、标签页的
			//   EventSource 永不重连。实测：杀掉 A 后客户端 12s+ 收不到 EOF，两边一直 ESTAB；
			//   而**每次重启 A** 都会把所有开着的 SSE 撞进这个场景。
			//   `upRes` 这时会报 'error'（ECONNRESET；旧版是已废弃的 'aborted'），就在这儿收尾。
			//   判 `!res.writableFinished`：上游正常跑完时它自己会走 'end'，pipe 会把 res.end() 掉，
			//   那一趟不在这儿再动一次。
			//   为什么用 `destroy()` 而不是 `end()`：两者对浏览器**一模一样**（实测 chromium：
			//   干净 EOF 与 RST 都是 readyState=0、约 3s 后重连 —— `end()` 并没有「让 EventSource
			//   重连」这个好处）；但 `end()` 会让**截断的 body 看起来是完整的**：声明了 Content-Length
			//   只来一半时，客户端会一直等缺的那截（实测 5s 都不收摊），chunked 时更糟 ——
			//   它会补上终止块、客户端当成「完整结束」（`/export` 那种 HTML 就静默截断了）。
			upRes.on("error", () => {
				if (!res.writableFinished) res.destroy();
			});
			upRes.pipe(res);
		},
	);
	// 下游没了 → 上游也断（上面那段说的就是没有这一行会怎样）。
	// 正常跑完（writableFinished）不碰 —— 让 agent 把 socket 收回去复用。
	res.on("close", () => {
		if (!res.writableFinished) up.destroy();
	});
	up.on("error", (e) => {
		if (!res.headersSent) {
			// A 连不上（重启中 / 挂了）：**SSE 请求必须「软失败」** —— 200 + text/event-stream +
			//   立刻结束，**不能**回 502。实测 chromium：EventSource 收到非 200 会
			//   readyState=2（CLOSED）**永久放弃**（连接尝试只发生一次）；而 200 + 立刻断
			//   它会每 ~3s 重试一次。重启 A 期间那次重试正好撞上这里，回 502 的话
			//   所有标签页就死到手动刷新（实测：A 停 6s，页面 T+2s error(rs=0) →
			//   T+5s error(rs=2) 之后再没动静，A 回来了也不接）。
			//   非 SSE 的请求照旧回 502：JSON 客户端不吃这套重试，给它真话。
			if (String(req.headers.accept ?? "").includes("text/event-stream")) {
				res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
				return res.end(); // 干净 EOF = 对 EventSource 就是「连接失败，待会儿再来」
			}
			res.writeHead(502, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
		}
		res.end(JSON.stringify({ error: `连不上会话基底（${BASE}）：${e.message}` }));
	});
	req.pipe(up);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
		return proxy(req, res, url.pathname.replace(/^\/api/, "") + url.search);
	}

	const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
	const file = path.resolve(WEB, rel);
	if (file !== WEB && !file.startsWith(WEB + path.sep))
		return sendFile(req, res, 403, Buffer.from("forbidden"), "text/plain; charset=utf-8", Date.now());
	let st;
	let body;
	try {
		st = fs.statSync(file);
		if (st.isDirectory()) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
		body = fs.readFileSync(file);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "EISDIR")
			return sendFile(req, res, 404, Buffer.from("not found"), "text/plain; charset=utf-8", Date.now());
		throw err;
	}
	const ext = path.extname(file);
	sendFile(req, res, 200, body, MIME[ext] ?? "application/octet-stream", st.mtimeMs);
});

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(`端口 ${PORT} 被占。`);
		process.exit(1);
	}
	throw err;
});

server.listen(PORT, HOST, () => {
	console.log(`[app] v2 → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}   （会话基底 ${BASE}）`);
	if (HOST === "0.0.0.0")
		console.log(
			`[app] ⚠️  绑在 0.0.0.0:${PORT} —— 局域网上任何能连到它的人，都能在这台机器上执行任意命令（这个 UI 零认证）。`,
		);
});
