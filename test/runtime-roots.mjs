#!/usr/bin/env node
/**
 * 契约测试：阅读根每次请求现算，优先级 env > paths.json > default。
 * 自足：每个优先级启动一个临时 A；动态用例在同一进程里改 paths.json，不重启 A。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-runtime-roots-"));
const HOME = path.join(TMP, "home");
const ENV_PAGE = path.join(TMP, "env-pages");
const ENV_EPUB = path.join(TMP, "env-epub");
const CONFIG_PAGE = path.join(TMP, "config-pages");
const CONFIG_EPUB = path.join(TMP, "config-epub");
const DEFAULT_PAGE = path.join(HOME, "pages");
for (const d of [HOME, ENV_PAGE, ENV_EPUB, CONFIG_PAGE, CONFIG_EPUB, DEFAULT_PAGE]) fs.mkdirSync(d, { recursive: true });
for (const [dir, name] of [[ENV_PAGE, "env.md"], [CONFIG_PAGE, "config.md"], [DEFAULT_PAGE, "default.md"]]) fs.writeFileSync(path.join(dir, name), `# ${name}\n`);
fs.writeFileSync(path.join(HOME, "models.json"), JSON.stringify({ providers: {} }));
fs.writeFileSync(path.join(HOME, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));

const freePort = async () => {
	const s = net.createServer();
	await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
	const port = s.address().port;
	await new Promise((resolve) => s.close(resolve));
	return port;
};
const request = (port, pathName) => new Promise((resolve, reject) => {
	const req = http.get({ host: "127.0.0.1", port, path: pathName }, (res) => {
		const chunks = [];
		res.on("data", (chunk) => chunks.push(chunk));
		res.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let json;
			try { json = JSON.parse(raw); } catch { json = null; }
			resolve({ status: res.statusCode, json, raw });
		});
	});
	req.on("error", reject);
});

async function start(extraEnv = {}) {
	const port = await freePort();
	const child = spawn(process.execPath, ["server/base.mjs"], {
		cwd: ROOT,
		env: { ...process.env, ASSIST_HOME: HOME, SOPHO_AGENT_DIR: HOME, SOPHO_BASE_PORT: String(port), SOPHO_CWD: TMP, SOPHO_IDLE_TTL_MS: "60000", ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	child.stdout.on("data", (d) => (logs += d));
	child.stderr.on("data", (d) => (logs += d));
	for (let i = 0; i < 100; i++) {
		try {
			const r = await request(port, "/host");
			if (r.status === 200) return { child, port, logs: () => logs };
		} catch { /* starting */ }
		await sleep(100);
	}
	child.kill("SIGKILL");
	throw new Error(`A 未启动：${logs}`);
}
async function stop(a) {
	a.child.kill("SIGKILL");
	await new Promise((resolve) => a.child.once("exit", resolve));
}
async function pages(a) {
	return request(a.port, "/pages");
}

try {
	console.log("── env > config：env 根优先，且来源可观测");
	fs.writeFileSync(path.join(HOME, "paths.json"), JSON.stringify({ pageRoot: CONFIG_PAGE, epubRoot: CONFIG_EPUB }));
	let a = await start({ SOPHO_PAGE_ROOT: ENV_PAGE, SOPHO_EPUB_ROOT: ENV_EPUB });
	try {
		const r = await pages(a);
		assert.equal(r.status, 200);
		assert.equal(r.json.root, ENV_PAGE);
		assert.equal(r.json.epubRoot, ENV_EPUB);
		assert.equal(r.json.rootSource, "env");
		assert.equal(r.json.epubRootSource, "env");
		console.log(JSON.stringify(r.json));
	} finally { await stop(a); }

	console.log("── config > default：paths.json 根优先，epub 缺省继承 pageRoot");
	fs.writeFileSync(path.join(HOME, "paths.json"), JSON.stringify({ pageRoot: CONFIG_PAGE }));
	a = await start();
	try {
		let r = await pages(a);
		assert.equal(r.status, 200);
		assert.equal(r.json.root, CONFIG_PAGE);
		assert.equal(r.json.epubRoot, CONFIG_PAGE);
		assert.equal(r.json.rootSource, "config");
		assert.equal(r.json.epubRootSource, "config");
		assert.ok(r.json.pages.some((p) => p.path === "config.md"));
		console.log(JSON.stringify(r.json));

		fs.writeFileSync(path.join(HOME, "paths.json"), JSON.stringify({ pageRoot: ENV_PAGE, epubRoot: ENV_EPUB }));
		r = await pages(a);
		assert.equal(r.status, 200);
		assert.equal(r.json.root, ENV_PAGE);
		assert.equal(r.json.epubRoot, ENV_EPUB);
		assert.equal(r.json.rootSource, "config");
		assert.equal(r.json.epubRootSource, "config");
		assert.ok(r.json.pages.some((p) => p.path === "env.md"));
		console.log(JSON.stringify(r.json));
	} finally { await stop(a); }

	console.log("── default：没有 paths.json 时回到 ASSIST_HOME/pages");
	fs.rmSync(path.join(HOME, "paths.json"));
	a = await start();
	try {
		const r = await pages(a);
		assert.equal(r.status, 200);
		assert.equal(r.json.root, DEFAULT_PAGE);
		assert.equal(r.json.epubRoot, DEFAULT_PAGE);
		assert.equal(r.json.rootSource, "default");
		assert.equal(r.json.epubRootSource, "default");
		assert.ok(r.json.pages.some((p) => p.path === "default.md"));
		console.log(JSON.stringify(r.json));
	} finally { await stop(a); }

	console.log("── 坏 paths.json：明确报错，不静默回落");
	for (const bad of [
		"不是 JSON",
		JSON.stringify({ pageRoot: 7 }),
		JSON.stringify({ pageRoot: CONFIG_PAGE, epubRoot: 7 }),
		JSON.stringify({ pageRoot: path.join(TMP, "不存在") }),
		JSON.stringify({ pageRoot: CONFIG_PAGE, epubRoot: path.join(TMP, "不存在的书") }),
	]) {
		fs.writeFileSync(path.join(HOME, "paths.json"), bad);
		a = await start();
		try {
			const r = await pages(a);
			assert.equal(r.status, 500);
			assert.equal(r.json.error, "pages-config-invalid");
			assert.match(r.json.detail, /paths\.json/);
			assert.notEqual(r.json.root, DEFAULT_PAGE);
			assert.match(a.logs(), /\[pages\] paths\.json 无效/);
			console.log(JSON.stringify(r.json));
		} finally { await stop(a); }
	}
	console.log("PASS runtime roots");
} finally {
	fs.rmSync(TMP, { recursive: true, force: true });
}
