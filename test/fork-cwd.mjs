#!/usr/bin/env node
/**
 * 实测 pi SessionManager.forkFrom() 能否把完整会话原生 fork 到另一个 cwd。
 *
 * 自足边界：
 *   · 临时副本 home（配置/凭据解引用复制；不复制真实 sessions/exports/pages）
 *   · 自己起一台 A（127.0.0.1 高位随机端口），按子进程 pid 停止
 *   · 所有会话、cwd、git 仓库都在唯一 mkdtemp 目录里，结束时按该具体路径清理
 *   · 不碰 7331/7321，不碰真实 sessions，不启动 B
 *
 * 需要真模型：从当前 ASSIST_HOME/SOPHO_AGENT_DIR 复制模型配置。可用
 * SOPHO_FORK_SOURCE_HOME 显式指定只读来源。
 *
 * 跑法：node test/fork-cwd.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-fork-cwd-"));
const HOME = path.join(TMP, "home");
const SOURCE_CWD = path.join(TMP, "source-cwd");
const TARGET_CWD = path.join(TMP, "target-plain");
const GIT_TARGET = path.join(TMP, "target-git");
const MISSING_TARGET = path.join(TMP, "target-does-not-exist");
const SOURCE_DIR = path.join(HOME, "sessions", "manual-source");
const MARKER = "FORK_TARGET_ONLY_7d61b2";
const STREAM_RESULT = "STREAM_SOURCE_DONE";
const MARKER_FILE = path.join(TARGET_CWD, "fork-target-only.txt");
const SOURCE_ID = "01b00000-0000-7000-8000-000000000001";
const SOURCE_FILE = path.join(SOURCE_DIR, `2026-01-01T00-00-00-000Z_${SOURCE_ID}.jsonl`);
const COPY_SKIP = new Set(["sessions", "exports", "pages", "archive.json", "cwd-recents.json", "registrations.json", "seen.json", "settled.json", "titles.json", "workspaces.json"]);

let child = null;
let childLogs = "";
let stubNodeModules = false;
let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `\n    ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `\n    ${detail}` : ""}`);
};
const check = (condition, what, detail = "") => (condition ? ok(what, detail) : bad(what, detail));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const linesOf = (file) => fs.readFileSync(file, "utf8").trimEnd().split("\n");
const entriesOf = (file) => linesOf(file).map((line) => JSON.parse(line));
const shell = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function packageDir() {
	const candidates = [
		process.env.SOPHO_PI_PACKAGE_ROOT,
		path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
		path.resolve(ROOT, "../../sopho-pi/node_modules/@earendil-works/pi-coding-agent"),
	].filter(Boolean);
	const hit = candidates.find((p) => fs.existsSync(path.join(p, "dist/core/session-manager.js")));
	if (!hit) throw new Error(`找不到 pi 包；查过：${candidates.join(", ")}`);
	return fs.realpathSync(hit);
}

function copySandboxHome(source, target) {
	assert.ok(fs.existsSync(source) && fs.statSync(source).isDirectory(), `配置来源不是目录：${source}`);
	fs.mkdirSync(target, { recursive: true });
	for (const name of fs.readdirSync(source)) {
		if (COPY_SKIP.has(name)) continue;
		fs.cpSync(path.join(source, name), path.join(target, name), {
			recursive: true,
			dereference: true,
			preserveTimestamps: true,
		});
	}
	fs.mkdirSync(path.join(target, "sessions"), { recursive: true });
}

async function highPort() {
	for (let i = 0; i < 100; i++) {
		const port = randomInt(20000, 60000);
		if (port === 7331 || port === 7321) continue;
		const available = await new Promise((resolve) => {
			const server = net.createServer();
			server.once("error", () => resolve(false));
			server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
		});
		if (available) return port;
	}
	throw new Error("找不到空闲高位端口");
}

function request(port, method, pathname, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: pathname,
				method,
				headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					let parsed = null;
					try {
						parsed = JSON.parse(raw);
					} catch {
						// 保留 raw
					}
					resolve({ status: res.statusCode, json: parsed, raw });
				});
			},
		);
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}

async function waitUntil(fn, timeoutMs = 180_000, stepMs = 250) {
	const started = Date.now();
	let last;
	while (Date.now() - started < timeoutMs) {
		try {
			last = await fn();
			if (last) return last;
		} catch (error) {
			last = error;
		}
		await sleep(stepMs);
	}
	throw new Error(`等待超时（${timeoutMs}ms）；最后状态：${String(last?.message ?? last ?? "无")}`);
}

async function stopChild() {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM"); // 精确 child pid；不用 pkill
	await Promise.race([exited, sleep(10_000)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}

async function cleanup() {
	await stopChild();
	if (stubNodeModules) {
		try {
			fs.unlinkSync(path.join(ROOT, "node_modules"));
		} catch {
			// 已清掉
		}
	}
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		// 尽力而为；只删本脚本创建的具体目录
	}
}

process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));
process.on("SIGTERM", () => cleanup().finally(() => process.exit(143)));

try {
	const PI_PACKAGE = packageDir();
	const packageJson = JSON.parse(fs.readFileSync(path.join(PI_PACKAGE, "package.json"), "utf8"));
	const realHome = path.resolve(process.env.SOPHO_FORK_SOURCE_HOME ?? process.env.SOPHO_AGENT_DIR ?? process.env.ASSIST_HOME ?? path.join(os.homedir(), ".pi/profiles/assistant"));

	console.log("── 0. 沙箱边界 ────────────────────────────────────────────────");
	console.log(`TMP=${TMP}`);
	console.log(`sandbox HOME=${HOME}`);
	console.log(`pi package=${PI_PACKAGE}`);
	console.log(`pi version=${packageJson.version}`);
	console.log(`source home（只读复制来源）=${realHome}`);
	copySandboxHome(realHome, HOME);
	ok("配置副本 home 已建立（真实 sessions/exports/pages 未复制）");

	fs.mkdirSync(SOURCE_CWD, { recursive: true });
	fs.mkdirSync(TARGET_CWD, { recursive: true });
	fs.mkdirSync(GIT_TARGET, { recursive: true });
	fs.writeFileSync(MARKER_FILE, `${MARKER}\n`);
	shell("git", ["init", "-q"], GIT_TARGET);
	shell("git", ["config", "user.email", "fork@test.invalid"], GIT_TARGET);
	shell("git", ["config", "user.name", "fork-test"], GIT_TARGET);
	fs.writeFileSync(path.join(GIT_TARGET, "README.md"), "fork test\n");
	shell("git", ["add", "README.md"], GIT_TARGET);
	shell("git", ["commit", "-q", "-m", "fixture"], GIT_TARGET);

	const sourceEntries = [
		{ type: "session", version: 3, id: SOURCE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: SOURCE_CWD },
		{ type: "message", id: "src-user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "首条历史：alpha 原样保留。" }], timestamp: 1767225601000 } },
		{ type: "message", id: "src-assistant-1", parentId: "src-user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "中间历史：beta / 中文 / symbols <> &。" }], timestamp: 1767225602000, stopReason: "stop", usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
		{ type: "custom", customType: "fork-probe", data: { exact: "custom-entry-kept", n: 42 }, id: "src-custom-1", parentId: "src-assistant-1", timestamp: "2026-01-01T00:00:03.000Z" },
		{ type: "session_info", id: "src-info-1", parentId: "src-custom-1", timestamp: "2026-01-01T00:00:04.000Z", name: "尾条历史：fork fixture" },
	];
	fs.mkdirSync(SOURCE_DIR, { recursive: true });
	fs.writeFileSync(SOURCE_FILE, sourceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const sourceBefore = fs.readFileSync(SOURCE_FILE);
	const sourceHashBefore = sha256(sourceBefore);

	// forkFrom 的默认目录读取 PI_CODING_AGENT_DIR；必须在动态 import 前指到副本 home。
	process.env.PI_CODING_AGENT_DIR = HOME;
	const { SessionManager } = await import(pathToFileURL(path.join(PI_PACKAGE, "dist/index.js")).href);

	console.log("\n── 1. forkFrom 默认落点、header 与完整历史 ─────────────────────");
	console.log(`source=${SOURCE_FILE}`);
	console.log(`target cwd=${TARGET_CWD}`);
	const forkManager = SessionManager.forkFrom(SOURCE_FILE, TARGET_CWD);
	const FORK_FILE = forkManager.getSessionFile();
	const FORK_ID = forkManager.getSessionId();
	const forkLines = linesOf(FORK_FILE);
	const forkEntries = entriesOf(FORK_FILE);
	console.log(`fork file=${FORK_FILE}`);
	console.log(`fork id=${FORK_ID}`);
	console.log(`source lines=${linesOf(SOURCE_FILE).length}; fork lines=${forkLines.length}`);
	console.log(`fork header=${JSON.stringify(forkEntries[0])}`);
	check(path.resolve(forkEntries[0].cwd) === path.resolve(TARGET_CWD), "新 header.cwd 是目标目录", forkEntries[0].cwd);
	check(forkEntries[0].parentSession === path.resolve(SOURCE_FILE), "新 header.parentSession 是源文件绝对路径", forkEntries[0].parentSession);
	check(forkLines.length === linesOf(SOURCE_FILE).length, "总条目数一致（header 替换，非 header 全复制）", `source=${linesOf(SOURCE_FILE).length}, fork=${forkLines.length}`);
	const sourceLines = linesOf(SOURCE_FILE);
	console.log(`首条非 header/source=${sourceLines[1]}`);
	console.log(`首条非 header/fork  =${forkLines[1]}`);
	console.log(`尾条/source=${sourceLines.at(-1)}`);
	console.log(`尾条/fork  =${forkLines.at(-1)}`);
	check(sourceLines[1] === forkLines[1], "首条非 header 逐字相同");
	check(sourceLines.at(-1) === forkLines.at(-1), "尾条逐字相同");
	check(sourceLines.slice(1).every((line, i) => line === forkLines[i + 1]), "全部非 header 行逐字相同", `${sourceLines.length - 1}/${sourceLines.length - 1}`);
	check(sha256(fs.readFileSync(SOURCE_FILE)) === sourceHashBefore && Buffer.compare(fs.readFileSync(SOURCE_FILE), sourceBefore) === 0, "fork 后源文件字节与条目数完全不变", `sha256=${sourceHashBefore}`);

	console.log("\n── 2. 相对路径、缺失目标、非 git / git 边界 ───────────────────");
	const relativeSource = path.relative(process.cwd(), SOURCE_FILE);
	const relativeGitTarget = path.relative(process.cwd(), GIT_TARGET);
	const relativeManager = SessionManager.forkFrom(relativeSource, relativeGitTarget);
	const relativeHeader = entriesOf(relativeManager.getSessionFile())[0];
	console.log(`relative source arg=${relativeSource}`);
	console.log(`relative target arg=${relativeGitTarget}`);
	console.log(`resolved relative fork file=${relativeManager.getSessionFile()}`);
	console.log(`resolved relative header=${JSON.stringify(relativeHeader)}`);
	check(relativeHeader.parentSession === path.resolve(SOURCE_FILE), "sourcePath 不要求绝对路径：相对路径按 process.cwd() 解析");
	check(relativeHeader.cwd === path.resolve(GIT_TARGET), "targetCwd 不要求绝对路径：相对路径解析成绝对 cwd");

	let missingResult;
	try {
		const manager = SessionManager.forkFrom(SOURCE_FILE, MISSING_TARGET);
		missingResult = { ok: true, file: manager.getSessionFile(), header: entriesOf(manager.getSessionFile())[0], targetExists: fs.existsSync(MISSING_TARGET) };
	} catch (error) {
		missingResult = { ok: false, error: String(error?.message ?? error), targetExists: fs.existsSync(MISSING_TARGET) };
	}
	console.log(`missing target result=${JSON.stringify(missingResult)}`);
	check(missingResult.ok === true && missingResult.targetExists === false, "目标 cwd 不存在时 fork 仍成功，但不会创建目标 cwd", JSON.stringify(missingResult));
	console.log(`plain target git? ${fs.existsSync(path.join(TARGET_CWD, ".git"))}; git target git? ${fs.existsSync(path.join(GIT_TARGET, ".git"))}`);
	check(fs.existsSync(FORK_FILE) && fs.existsSync(relativeManager.getSessionFile()), "非 git 与 git 目标都能 fork，没有行为差异", `plain=${FORK_FILE}\ngit=${relativeManager.getSessionFile()}`);

	console.log("\n── 3. 启动沙箱 A；递归扫描 /tree 与 /messages ──────────────────");
	// worktree 通常没有 node_modules。只在缺失时建立一个临时、精确清理的 symlink，
	// 让 worktree 的 server/base.mjs 仍从同版本主树安装依赖；不会修改主树。
	const rootNodeModules = path.join(ROOT, "node_modules");
	if (!fs.existsSync(rootNodeModules)) {
		const installedNodeModules = path.resolve(PI_PACKAGE, "../..");
		fs.symlinkSync(installedNodeModules, rootNodeModules, "dir");
		stubNodeModules = true;
		console.log(`temporary node_modules symlink=${rootNodeModules} -> ${installedNodeModules}`);
	}
	const PORT = await highPort();
	child = spawn(process.execPath, ["server/base.mjs"], {
		cwd: ROOT,
		env: {
			...process.env,
			ASSIST_HOME: HOME,
			SOPHO_AGENT_DIR: HOME,
			PI_CODING_AGENT_DIR: HOME,
			SOPHO_BASE_PORT: String(PORT),
			SOPHO_CWD: SOURCE_CWD,
			SOPHO_IDLE_TTL_MS: "300000",
			SOPHO_MAX_HOT: "8",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => (childLogs += d));
	child.stderr.on("data", (d) => (childLogs += d));
	console.log(`A pid=${child.pid}; port=${PORT}`);
	await waitUntil(async () => (await request(PORT, "GET", "/host")).status === 200, 60_000);
	const host = await request(PORT, "GET", "/host");
	console.log(`GET /host -> ${host.status} ${host.raw}`);
	check(host.json?.pid === child.pid, "就绪的是本脚本刚起的 A（pid 对得上）", `expected=${child.pid}, actual=${host.json?.pid}`);

	const tree = await request(PORT, "GET", "/tree");
	const sourceNode = tree.json?.nodes?.find((node) => node.id === SOURCE_ID);
	const forkNode = tree.json?.nodes?.find((node) => node.id === FORK_ID);
	console.log(`GET /tree -> ${tree.status}`);
	console.log(`source node=${JSON.stringify(sourceNode)}`);
	console.log(`fork node=${JSON.stringify(forkNode)}`);
	check(tree.status === 200 && sourceNode && forkNode, "递归扫描让源会话与默认子目录里的 fork 都出现在 /tree");
	check(forkNode?.cwd === path.resolve(TARGET_CWD) && forkNode?.parent === SOURCE_ID, "/tree 读到目标 cwd 与源会话血缘", JSON.stringify({ cwd: forkNode?.cwd, parent: forkNode?.parent }));

	const sourceMessages = await request(PORT, "GET", `/sessions/${SOURCE_ID}/messages`);
	const forkMessages = await request(PORT, "GET", `/sessions/${FORK_ID}/messages`);
	console.log(`source messages status/count=${sourceMessages.status}/${sourceMessages.json?.messages?.length}`);
	console.log(`fork messages status/count=${forkMessages.status}/${forkMessages.json?.messages?.length}`);
	console.log(`source messages first=${JSON.stringify(sourceMessages.json?.messages?.[0])}`);
	console.log(`fork messages first  =${JSON.stringify(forkMessages.json?.messages?.[0])}`);
	console.log(`source messages last=${JSON.stringify(sourceMessages.json?.messages?.at(-1))}`);
	console.log(`fork messages last  =${JSON.stringify(forkMessages.json?.messages?.at(-1))}`);
	check(sourceMessages.status === 200 && forkMessages.status === 200, "源与 fork 的 /messages 都可服务");
	check(JSON.stringify(sourceMessages.json?.messages) === JSON.stringify(forkMessages.json?.messages), "/messages 的消息数组逐字 JSON 相同", `count=${forkMessages.json?.messages?.length}`);

	console.log("\n── 4. 真模型续聊：bash 证明 runtime cwd 是目标目录 ─────────────");
	const prompt = [
		"这是 cwd 硬证据测试。必须调用 bash 工具执行下面这一条命令，不要改写命令：",
		`pwd; printf '\\nMARKER_CONTENT='; cat ./fork-target-only.txt`,
		"工具结束后只回复 CWD_PROBE_DONE。",
	].join("\n");
	const send = await request(PORT, "POST", `/sessions/${FORK_ID}/message`, { text: prompt });
	console.log(`POST /sessions/${FORK_ID}/message -> ${send.status} ${send.raw}`);
	check(send.status === 202, "真模型消息被沙箱 A 接受");
	await waitUntil(async () => {
		const raw = fs.readFileSync(FORK_FILE, "utf8");
		const status = await request(PORT, "GET", `/sessions/${FORK_ID}`);
		return status.status === 200 && status.json?.streaming === false && raw.includes(MARKER) && raw.includes(path.resolve(TARGET_CWD));
	}, 300_000, 500);
	const continuedEntries = entriesOf(FORK_FILE);
	const cwdHeader = continuedEntries[0];
	const toolEvidence = continuedEntries.find(
		(entry) => entry.type === "message" && entry.message?.role === "toolResult" && JSON.stringify(entry).includes(MARKER) && JSON.stringify(entry).includes(path.resolve(TARGET_CWD)),
	);
	console.log("cwd evidence entries=");
	console.log(JSON.stringify(cwdHeader));
	console.log(JSON.stringify(toolEvidence));
	check(!!toolEvidence, "bash 工具结果同时含目标 pwd 与目标目录独有文件内容", `${TARGET_CWD}\n${MARKER}`);

	console.log("\n── 5. 源正在流式时 fork ────────────────────────────────────────");
	const sourceCountBeforeStream = linesOf(SOURCE_FILE).length;
	const streamPrompt = "流式 fork 边界测试：必须调用 bash 执行 `sleep 8; printf '\\123\\124\\122\\105\\101\\115\\137\\123\\117\\125\\122\\103\\105\\137\\104\\117\\116\\105'`，不要跳过工具；结束后只回复 STREAM_CHAT_DONE。";
	const streamSend = await request(PORT, "POST", `/sessions/${SOURCE_ID}/message`, { text: streamPrompt });
	console.log(`POST source streaming message -> ${streamSend.status} ${streamSend.raw}`);
	const streamingStatus = await waitUntil(async () => {
		const status = await request(PORT, "GET", `/sessions/${SOURCE_ID}`);
		return status.json?.streaming === true ? status.json : false;
	}, 30_000, 50);
	console.log(`source status at fork=${JSON.stringify(streamingStatus)}`);
	let streamingForkResult;
	try {
		const manager = SessionManager.forkFrom(SOURCE_FILE, TARGET_CWD);
		streamingForkResult = { ok: true, file: manager.getSessionFile(), id: manager.getSessionId(), linesAtFork: linesOf(manager.getSessionFile()).length };
	} catch (error) {
		streamingForkResult = { ok: false, error: String(error?.message ?? error) };
	}
	console.log(`fork while streaming result=${JSON.stringify(streamingForkResult)}`);
	check(streamingForkResult.ok === true, "源正在 streaming 时 forkFrom 不报错，也不检查 runtime 状态", JSON.stringify(streamingForkResult));
	await waitUntil(async () => {
		const status = await request(PORT, "GET", `/sessions/${SOURCE_ID}`);
		return status.status === 200 && status.json?.streaming === false && fs.readFileSync(SOURCE_FILE, "utf8").includes(STREAM_RESULT);
	}, 300_000, 500);
	const sourceCountAfterStream = linesOf(SOURCE_FILE).length;
	const streamingForkCount = linesOf(streamingForkResult.file).length;
	console.log(`source lines before streaming=${sourceCountBeforeStream}`);
	console.log(`streaming fork snapshot lines=${streamingForkCount}`);
	console.log(`source lines after settled=${sourceCountAfterStream}`);
	console.log(`streaming fork has ${STREAM_RESULT}=${fs.readFileSync(streamingForkResult.file, "utf8").includes(STREAM_RESULT)}`);
	check(sourceCountAfterStream > streamingForkCount && !fs.readFileSync(streamingForkResult.file, "utf8").includes(STREAM_RESULT), "流式时 fork 只是当下文件快照：后续完成内容不会追进 fork", `snapshot=${streamingForkCount}, settled source=${sourceCountAfterStream}`);

	console.log("\n── 6. 总结性机械判据 ──────────────────────────────────────────");
	console.log(`checks failed=${failed}`);
	if (failed) throw new Error(`${failed} 个断言失败`);
	ok("全部机械断言通过");
} catch (error) {
	console.error(`\nFATAL: ${error?.stack ?? error}`);
	if (childLogs) console.error(`\nA logs (tail):\n${childLogs.slice(-8000)}`);
	failed++;
} finally {
	await cleanup();
	console.log(`\ncleanup: stopped exact A pid and removed ${TMP}`);
}

if (failed) process.exit(1);
