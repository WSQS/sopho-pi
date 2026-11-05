#!/usr/bin/env node
/**
 * v2 · 应用层（进程 B）—— 常改的那一层。
 *
 * 只做三件事：① 服务前端静态文件；② 把 /api/* 反代给 A（会话基底）；
 * ③ 别的什么都不做。**重启 B 不会碰到 A 里的会话。**
 *
 * 环境变量：SOPHO_PORT / SOPHO_HOST / SOPHO_BASE_URL（默认 http://127.0.0.1:7331）
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

const send = (res, code, body, type) => {
	res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(body);
};

/** /api/<x> → BASE/<x>，纯管道（SSE 不缓冲）。 */
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
			upRes.pipe(res);
		},
	);
	up.on("error", (e) => {
		if (!res.headersSent) res.writeHead(502, { "Content-Type": MIME[".json"] });
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
	if (file !== WEB && !file.startsWith(WEB + path.sep)) return send(res, 403, "forbidden", "text/plain; charset=utf-8");
	let body;
	try {
		body = fs.readFileSync(file);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "EISDIR") return send(res, 404, "not found", "text/plain; charset=utf-8");
		throw err;
	}
	send(res, 200, body, MIME[path.extname(file)] ?? "application/octet-stream");
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
