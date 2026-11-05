#!/usr/bin/env node
/**
 * v2 · 会话基底的「宿主」（进程 A）—— 稳定，极少改。
 *
 * 只干三件事：
 *   1. **持 runtime 池** —— 这个进程里唯一不能丢的东西
 *   2. 把 pi 的事件扇出给 SSE 订阅者（订阅必须活在宿主：重载逻辑不能丢它）
 *   3. 起 HTTP，把请求交给 ./base-logic.mjs
 *
 * 为什么还要再分一层：宿主稳定、逻辑天天改。
 *   · 改逻辑 → `curl -X POST http://127.0.0.1:7331/reload-code`：热重载，池不动、会话不丢
 *   · 改宿主 → `bin/restart-base.sh`（会重写所有 runtime，**别在会话里跑**）
 *
 * ⚠️ 还有**第三层：pi 扩展（pi-extensions/）**，它不在这两条热重载路径上 ——
 *   扩展是**每个 runtime 建立时加载**的（而且 pi 的加载器**按 cwd 在进程内缓存**扩展模块），
 *   池里的长活会话会静默地继续跑旧版。
 *   见下面「插件层的版本」那段：靠 entry.pluginMtimeMs + /sessions/{id}.pluginStale 把它照出来。
 *
 * 逃生门（`POST /reload-code`、`GET /host`）刻意留在宿主：
 * 不能建在可重载的代码上 —— 否则逻辑写坏了就救不回来。
 *
 * 与 v1 的关键差别：**池会回收**。v1 的池只进不出（一天挂 30+ 个 runtime），
 * 长活会话一多就爆。这里按"空闲时间 + 上限"LRU dispose（文件留着，下次 ensure 再来）。
 *
 * 数据：$ASSIST_HOME/sessions/*.jsonl（pi 原生格式）。
 *   · 会话 id = 文件名里 pi 那个 uuid（稳定、跨重启不变）
 *   · 血缘 = 会话文件头的 parentSession（不另记账本）
 *
 * 环境变量：ASSIST_HOME / ASSIST_SESSIONS / SOPHO_AGENT_DIR / SOPHO_BASE_PORT /
 *           SOPHO_IDLE_TTL_MS / SOPHO_MAX_HOT
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";

const HOME = process.env.ASSIST_HOME ?? path.join(os.homedir(), ".pi/profiles/assistant");
const AGENT_DIR = process.env.SOPHO_AGENT_DIR ?? HOME;
const SESSIONS = process.env.ASSIST_SESSIONS ?? path.join(HOME, "sessions");
const PORT = Number(process.env.SOPHO_BASE_PORT ?? 7331);
const DEFAULT_CWD = process.env.SOPHO_CWD ?? process.cwd();

/** 空闲超过它就 dispose；池里超过 MAX_HOT 个也淘汰最旧的。 */
const IDLE_TTL_MS = Number(process.env.SOPHO_IDLE_TTL_MS ?? 30 * 60_000);
const MAX_HOT = Number(process.env.SOPHO_MAX_HOT ?? 8);
const SWEEP_MS = 30_000;

class Bad extends Error {}

const json = (res, code, obj) => {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(obj));
};

const readBody = (req, limit = 1 << 20) =>
	new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > limit) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				reject(new Error("body 不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});

// ─────────────────────────── 身份：pi 的会话文件 ───────────────────────────
// 这一层（"pi 文件怎么访问"）留在宿主：ensure/create 自己就要用。

/** pi 的会话文件名： `<ISO 时间>_<uuid>.jsonl`。id 就是这个 uuid。 */
function idOf(file) {
	const m = path.basename(file).match(/_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
	return m ? m[1] : null;
}

/** 会话根下所有 .jsonl（pi 按 cwd 分子目录，所以递归）。 */
function allFiles() {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(SESSIONS);
	return out;
}

const fileCache = new Map(); // id -> file（找过就记住；文件会被删，所以先看还在不在）
function fileOf(id) {
	const hit = fileCache.get(id);
	if (hit && fs.existsSync(hit)) return hit;
	const found = allFiles().find((f) => idOf(f) === id);
	if (found) fileCache.set(id, found);
	return found ?? null;
}

/** 允许传短 id（唯一前缀）→ 解析成完整 uuid。 */
function resolveId(id) {
	if (!id) return id;
	const ids = allFiles().map((f) => idOf(f)).filter(Boolean);
	if (ids.includes(id)) return id;
	const hits = ids.filter((x) => x.startsWith(id));
	return hits.length === 1 ? hits[0] : id;
}

/** 只读会话文件头（第一行）——拿 cwd 与 parentSession。 */
function headerOf(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
	} catch {
		return null;
	}
}

// ────────────────────── 插件层（pi 扩展）的版本 ──────────────────────
// 关键事实：pi 的扩展是**每个 runtime 建立时加载**的（factory → createAgentSessionServices），
// 而且加载器按 **cwd** 在进程内缓存模块（见下面的 pluginMtimeOnLoad）。
// 所以池里的长活会话永远攥着它建立那一刻的模块 —— 文件之后怎么改都跟它无关。
// `POST /reload-code` 只换 base-logic.mjs，**完全不碰这一层**（它只是 import("./base-logic.mjs?v=…")）。
// 结果：改了插件后，**已在池里的长活会话静默地用旧版**，新建的会话也不保险（cwd 命中缓存就还是旧的）。
// 所以这里必须记下「建 runtime 时**实际加载**的那一版」，跟「当前文件」比，才看得出某个会话在跑旧插件。

/** 插件文件：pi 扩展层的入口（本仓库里的那份）。 */
const PLUGIN_FILE = fileURLToPath(new URL("../pi-extensions/assistant/index.ts", import.meta.url));

/** 插件文件**当前**的版本：mtimeMs + 内容 hash（读不到 → null，不抛）。 */
function pluginInfo() {
	try {
		const st = fs.statSync(PLUGIN_FILE);
		const bytes = fs.readFileSync(PLUGIN_FILE);
		return { path: PLUGIN_FILE, mtimeMs: st.mtimeMs, hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
	} catch {
		return { path: PLUGIN_FILE, mtimeMs: null, hash: null };
	}
}

/** ⚠️ pi 的扩展加载器是**按 cwd 在进程内缓存**扩展模块的（pi 的 extensions/loader.js：
 *  useExtensionCacheCwd —— cwd 没变就复用上一次加载的那份**代码**，cwd 一变才 clearExtensionCache()
 *  重读磁盘；session.reload() 也会清缓存）。
 *  所以「这个 runtime 跑的是哪一版插件」**不等于**「现在文件是什么」：同一 cwd 上新会话可能拿到
 *  好几版之前的代码。这里镜像这条规则（纯记账，不碰 pi 内部）。 */
let pluginCache = { cwd: null, mtimeMs: null };

/** 建 runtime 的这一刻，插件层**实际加载**的是哪一版（mtimeMs）。 */
function pluginMtimeOnLoad(cwd) {
	const dir = path.resolve(cwd ?? DEFAULT_CWD);
	// cwd 变了 → pi 会清缓存重读磁盘 → 这次加载的就是当前文件
	if (pluginCache.cwd !== dir || pluginCache.mtimeMs == null) pluginCache = { cwd: dir, mtimeMs: pluginInfo().mtimeMs };
	return pluginCache.mtimeMs; // 否则：复用上次那份代码，它比磁盘上的旧
}

/** 有人做了 session.reload()（pi 会 clearExtensionCache）→ 下一次加载必然重读磁盘。 */
function notePluginReload() {
	pluginCache = { cwd: null, mtimeMs: null };
	return pluginInfo().mtimeMs;
}

// ─────────────────────────── 池 ───────────────────────────

/** id → entry。进程级单例。**宿主重启 = 全池消失**（文件留着，下次 ensure 再来）。 */
const pool = new Map();

const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd, agentDir: AGENT_DIR });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

/** 工具结果 → 可读文本（给前端展示用）。 */
function resultText(result) {
	const c = result?.content ?? result;
	if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("\n").trim();
	if (typeof c === "string") return c;
	return "";
}

function wireOf(ev) {
	switch (ev.type) {
		case "message_update": {
			const a = ev.assistantMessageEvent;
			if (a?.type === "text_delta") return { t: "text", d: a.delta };
			if (a?.type === "thinking_delta") return { t: "thinking", d: a.delta };
			return null;
		}
		case "tool_execution_start":
			return { t: "tool", phase: "start", id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {} };
		case "tool_execution_end":
			return {
				t: "tool",
				phase: "end",
				id: ev.toolCallId,
				name: ev.toolName,
				error: !!ev.isError,
				result: resultText(ev.result).slice(0, 1000),
			};
		case "agent_start":
			return { t: "run", phase: "start" };
		case "agent_end":
			return { t: "run", phase: "end" };
		default:
			return null;
	}
}

function broadcast(entry, msg) {
	const line = `data: ${JSON.stringify(msg)}\n\n`;
	for (const res of entry.subscribers) {
		try {
			res.write(line);
		} catch {
			entry.subscribers.delete(res);
		}
	}
}

function makeEntry(id, file, cwd, runtime) {
	const entry = {
		id,
		file,
		cwd,
		runtime,
		// 记下**这一刻实际加载**的插件版本（runtime 就是刚由 factory 建起来的）。
		// 之后文件再怎么改，这条 entry 的 runtime 都不会变 —— 差别就是 pluginStale。
		pluginMtimeMs: pluginMtimeOnLoad(cwd),
		subscribers: new Set(),
		lastActivity: Date.now(),
	};
	entry.off = runtime.session.subscribe((ev) => {
		entry.lastActivity = Date.now();
		const wire = wireOf(ev);
		if (wire) broadcast(entry, wire);
	});
	return entry;
}

/** 把某会话的 runtime 拿进池。已在池里就直接返回。 */
async function ensure(id) {
	const hit = pool.get(id);
	if (hit) return hit;

	const file = fileOf(id);
	if (!file) throw new Error(`没有这个会话：${id}`);
	const cwd = headerOf(file)?.cwd ?? DEFAULT_CWD;
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: AGENT_DIR,
		sessionManager: SessionManager.open(file),
	});
	const entry = makeEntry(id, file, cwd, runtime);
	pool.set(id, entry);
	await evict();
	return entry;
}

/** 建一个新会话（可选 parent）。返回 entry。 */
async function create({ parent, cwd, name } = {}) {
	fs.mkdirSync(SESSIONS, { recursive: true });
	const dir = cwd ?? (parent ? (headerOf(fileOf(parent) ?? "")?.cwd ?? DEFAULT_CWD) : DEFAULT_CWD);
	const sm = SessionManager.create(dir, SESSIONS, parent ? { parentSession: fileOf(parent) ?? parent } : undefined);
	const runtime = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: AGENT_DIR, sessionManager: sm });
	const file = runtime.session.sessionFile;
	if (!file) throw new Error("新会话没有文件路径（SessionManager 没持久化？）");
	if (name) {
		try {
			runtime.session.setSessionName(name);
		} catch {
			/* 起名失败无所谓 */
		}
	}
	// pi 延迟落盘：主动把 header（+ session_info）写出去，UI 才不会"扑空"。
	try {
		sm._rewriteFile?.();
		sm.flushed = true;
	} catch {
		/* 退回延迟落盘 */
	}
	const id = idOf(file);
	if (!id) throw new Error(`会话文件名里没找到 uuid：${file}`);
	const entry = makeEntry(id, path.resolve(file), dir, runtime);
	pool.set(id, entry);
	await evict();
	return entry;
}

/** 发一条消息（调用方负责先 ensure —— "唤醒"）。不 await 整轮。 */
function prompt(entry, text, behavior) {
	const s = entry.runtime.session;
	const opts = {};
	if (s.isStreaming) opts.streamingBehavior = behavior === "followUp" ? "followUp" : "steer";
	s.prompt(text, opts).catch((err) => broadcast(entry, { t: "error", message: String(err?.message ?? err) }));
	return { streaming: s.isStreaming, behavior: opts.streamingBehavior ?? null };
}

function status(entry) {
	const s = entry.runtime.session;
	const now = pluginInfo().mtimeMs;
	const at = entry.pluginMtimeMs ?? null;
	return {
		id: entry.id,
		file: entry.file,
		cwd: entry.cwd,
		streaming: s.isStreaming,
		model: s.model?.id ?? null,
		messages: s.messages.length,
		lastActivity: entry.lastActivity,
		// 这个 runtime 建起来时插件层**实际加载**的版本（null = 不知道：这条 entry 早于本次宿主启动、当时没记）
		pluginMtimeMs: at,
		// 当前磁盘上那份插件的 mtime
		pluginNowMtimeMs: now,
		// **猜**：只比 mtime。同一秒内改文件（或文件系统 mtime 精度只到秒）会误判成 false，
		// "改了又改回同样 mtime"同理；并发建会话时上面的缓存镜像也可能与 pi 的实际状态错开一格。
		// 比没有信号强得多，但不是铁证 —— 要确定生效就用 POST /sessions/{id}/reload 或重启 A。
		pluginStale: at == null || now == null ? null : now !== at,
	};
}

/** dispose 一个 entry（文件留着）。 */
async function dispose(entry) {
	try {
		entry.off?.();
		await entry.runtime.session.abort?.();
		entry.runtime.session.dispose?.();
	} catch {
		/* 尽力而为 */
	}
	pool.delete(entry.id);
}

/** 回收：超过上限就淘汰最旧的 idle。**绝不动正在跑的会话。** */
async function evict() {
	if (pool.size <= MAX_HOT) return;
	const idle = [...pool.values()].filter((e) => !e.runtime.session.isStreaming).sort((a, b) => a.lastActivity - b.lastActivity);
	for (const e of idle) {
		if (pool.size <= MAX_HOT) break;
		await dispose(e);
	}
}

setInterval(() => {
	const now = Date.now();
	for (const e of [...pool.values()]) {
		if (!e.runtime.session.isStreaming && now - e.lastActivity > IDLE_TTL_MS) dispose(e);
	}
}, SWEEP_MS).unref?.();

// ─────────────────────────── 交给逻辑的东西 ───────────────────────────
// 一次给全：逻辑模块只管路由，不 import 宿主的内部。

const ctx = {
	HOME,
	SESSIONS,
	DEFAULT_CWD,
	Bad,
	json,
	readBody,
	pool,
	idOf,
	allFiles,
	fileOf,
	resolveId,
	headerOf,
	// 插件层的事实（逻辑层用它判 pluginStale；也给逻辑层一个「当前版本」的读数）
	pluginFile: PLUGIN_FILE,
	pluginInfo,
	// session.reload() 之后叫一声：pi 清了扩展缓存，下一次加载必然重读磁盘
	notePluginReload,
	ensure,
	create,
	prompt,
	status,
	dispose,
	evict,
};

// ─────────────────────────── 逻辑的热重载 ───────────────────────────

const LOGIC_URL = new URL("./base-logic.mjs", import.meta.url);
let logic = null;
let code = { version: null, loadedAt: 0 };

/** 每次都用带 ?v= 的新 URL import —— ESM 按 URL 缓存模块，不加就永远拿到旧的。
 *  代价：旧模块不回收（每次几 KB）。开发期无所谓。 */
async function loadLogic() {
	const v = String(Date.now());
	const mod = await import(`${LOGIC_URL.href}?v=${v}`);
	if (typeof mod.create !== "function") throw new Error("base-logic.mjs 必须导出 create(ctx)");
	const made = mod.create(ctx);
	if (!made || typeof made.handle !== "function") throw new Error("create(ctx) 必须返回 { handle }");
	logic = made;
	code = { version: v, loadedAt: Date.now() };
	return v;
}

async function reloadLogic() {
	try {
		return { ok: true, version: await loadLogic() };
	} catch (err) {
		// 载入失败就**保留老的** —— 否则一次手滑就把底座写死了
		return { ok: false, error: String(err?.message ?? err), keeping: code.version };
	}
}

// ─────────────────────────── HTTP ───────────────────────────

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const seg = url.pathname.split("/").filter(Boolean); // ["sessions", id, ...]
	if (seg[0] === "sessions" && seg[1]) seg[1] = resolveId(seg[1]); // 允许短 id
	try {
		// ← 逃生门刻意在宿主里：逻辑写坏了也得能救
		if (req.method === "POST" && seg[0] === "reload-code") {
			const r = await reloadLogic();
			if (r.ok) console.log(`[base] 逻辑已热重载 v=${r.version}`);
			else console.error(`[base] 逻辑重载失败，继续用旧的：${r.error}`);
			return json(res, r.ok ? 200 : 500, r);
		}
		if (req.method === "GET" && seg[0] === "host") {
			const p = pluginInfo();
			return json(res, 200, {
				pid: process.pid,
				uptimeMs: Math.round(process.uptime() * 1000),
				code: code.version,
				codeLoadedAt: code.loadedAt,
				// 插件层（pi-extensions/）= **另一条版本线**：`code` 说的是 base-logic，插件是每个 runtime
				// 各自加载一份。这里报的是「当前磁盘上那份」（谁还在跑旧的 → 看 /sessions/{id}.pluginStale）。
				pluginPath: p.path,
				pluginMtimeMs: p.mtimeMs,
				pluginHash: p.hash,
				hot: pool.size,
				sessions: SESSIONS,
				home: HOME,
			});
		}

		if (await logic.handle(req, res, seg, url)) return;
		return json(res, 404, { error: "not found" });
	} catch (err) {
		if (err instanceof Bad) return json(res, 400, { error: err.message });
		return json(res, 500, { error: String(err?.message ?? err) });
	}
});

await loadLogic();
server.listen(PORT, "127.0.0.1", () => {
	console.log(`[base] 会话基底 → http://127.0.0.1:${PORT}   sessions=${SESSIONS}`);
	console.log(`[base] 逻辑在 server/base-logic.mjs —— 改完热重载：curl -X POST http://127.0.0.1:${PORT}/reload-code`);
});

// ─────────────────────────── 收摊 ───────────────────────────

let down = false;
async function shutdown() {
	if (down) return;
	down = true;
	server.close();
	await Promise.all([...pool.values()].map((e) => e.runtime.session.abort?.().catch(() => {})));
	await Promise.all([...pool.values()].map((e) => e.runtime.session.dispose?.()));
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
