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
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
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

// ───────────────────── 出网字节：压缩 + 304（本次全部目标就在这儿） ─────────────────────
// 为什么改这一处就够：**所有 JSON 响应的唯一出口就是下面这个 `json()`**
//   · 宿主自己的（/host、/reload-code、404、Bad→400）
//   · 逻辑层的全部路由（ctx.json 给的就是这个函数）
// 所以压缩 / ETag 挂在这里，base-logic.mjs 一个字都不用改。
//
// ⚠️ **text/event-stream 在这里物理上碰不到** —— 两条 SSE 路由（/sessions/{id}/stream、/events）
//    用的是各路由自己的 `res.writeHead(200, {Content-Type: text/event-stream})` + 多次 `res.write`，
//    根本不经过 `json()`。压 SSE 会把事件攒到响应结束才发（实时性直接没了），所以这条不是
//    "记得排除"，而是"压根不在同一条路上"—— 本次最容易出人命的地方被结构性地避开了。
//    同理：/export 的 HTML、SSE 之外的流式写入也不在这里（它们不走 json()）。

/** 小于它就**不压**：几百字节的响应压完常常**更大**（gzip 头 18B + 帧开销，brotli 头更多），
 *  还白搭 CPU。1KB 是 nginx（gzip_min_length 20 是字节，但它文档常推荐 1k）/ express compression
 *  的常用默认，本项目的 /tree(18KB) 与 /messages(0.5~2.5MB) 都远超它，只有 404/202 那种小壳子不受影响。 */
const COMPRESS_MIN = Number(process.env.SOPHO_COMPRESS_MIN ?? 1024);
/** 不给 br 的客户端（老的 curl/代理）用 gzip 6：省流 ~2.95x，CPU 与 br 5 相当。 */
const GZIP_LEVEL = Number(process.env.SOPHO_GZIP_LEVEL ?? 6);
/** brotli 质量：**5**。实测这份真实 /messages（2.48MB）：br q5 = 677KB / 46ms、
 *  gzip 6 = 840KB / 43ms（同样 CPU 少 20% 字节）；q6 再多 5ms 只少 12KB；
 *  **q11 千万别用** —— 602KB 但 3.3 秒（单核卡死整个 A，所有会话跟着卡）。 */
const BROTLI_QUALITY = Number(process.env.SOPHO_BROTLI_QUALITY ?? 5);

/** Accept-Encoding → 我们能给的最好编码（'br' | 'gzip' | 'identity'）。
 *  认 q 值（q=0 = 明确不要）与 `*`；什么都没给 / 都不支持 → identity（**不压**）。 */
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
	// q 值说了算：客户端"更想要"哪个就给哪个（q 相同时 br 优先 —— 同样的 CPU 少 20% 字节）。
	// 典型输入 `gzip, deflate, br` 三个都是 q=1 → br。
	const bw = weight("br");
	const gw = weight("gzip");
	if (bw <= 0 && gw <= 0) return "identity";
	if (bw <= 0) return "gzip";
	if (gw <= 0) return "br";
	return bw >= gw ? "br" : "gzip";
}

/** ETag = 内容指纹 + **编码**。带上编码是必须的：gzip 和 br 的字节不是一回事，
 *  RFC 9110 里强 ETag 必须"同一份 representation"—— 拼上编码才名正言顺地当强 ETag 用。
 *  对**未压缩**的体算 hash（这样同一份 JSON 无论怎么编码，指纹都是同一个内容指纹）。 */
const etagOf = (body, enc) => `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}-${enc}"`;

/** If-None-Match 命中吗？只认精确匹配与 `*`（不算弱比较前缀 W/ —— 我们发的是强 ETag）。 */
function ifNoneMatch(req, etag) {
	const raw = String(req?.headers?.["if-none-match"] ?? "");
	if (!raw) return false;
	const tags = raw.split(",").map((t) => t.trim());
	return tags.includes("*") || tags.includes(etag);
}

/** 只有**读**才有 304 可言：GET/HEAD 且 200。别的（202/404/500、POST）照旧发完整 body。 */
const cacheableJson = (req, code) => (req?.method === "GET" || req?.method === "HEAD") && code === 200;

const json = (res, code, obj) => {
	const req = res.req; // node 给每个响应挂着的那个请求（Accept-Encoding / If-None-Match 从这儿拿）
	const body = Buffer.from(JSON.stringify(obj));
	// 小响应直接不压（说清代价：不压的代价是那点字节，压的代价是 CPU + 可能更大）
	const enc = body.length >= COMPRESS_MIN ? pickEncoding(req?.headers?.["accept-encoding"]) : "identity";
	const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Accept-Encoding" };

	if (cacheableJson(req, code)) {
		const etag = etagOf(body, enc);
		headers.ETag = etag;
		// `no-cache`（= 可以存，但每次都得回来复验）而不是 `no-store`：
		// 只有允许客户端存下来，If-None-Match 才有机会命中 → 命中时 0 字节，比压缩彻底。
		headers["Cache-Control"] = "private, no-cache";
		if (ifNoneMatch(req, etag)) return res.writeHead(304, headers).end(); // 304 **不带 body**
	}

	if (enc !== "identity") {
		let out = null;
		try {
			out =
				enc === "br"
					? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
					: gzipSync(body, { level: GZIP_LEVEL });
		} catch {
			out = null; // 压不动就原样发 —— 省流绝不能变成"响应没了"
		}
		if (out) {
			headers["Content-Encoding"] = enc;
			headers["Content-Length"] = out.length;
			return res.writeHead(code, headers).end(out); // 一次写完（Content-Length 已知）
		}
	}
	headers["Content-Length"] = body.length;
	res.writeHead(code, headers).end(body);
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

/** 会话 id **只收完整 uuid** —— 片段（前缀 / 尾巴）一律拒绝，并尽量说清为什么。
 *
 *  以前的写法是「唯一前缀也认，都不中就**原样返回**」，两条路都踩过坑（见 handoff 珂表「别把 id 片段当标识」）：
 *    · 尾巴：解析只看前缀 → **永远**中不了 → 「没有这个会话」（人从界面上复制尾巴给 AI，吃过三次）；
 *    · 前缀：pi 的 uuid 前 8 位就是时间戳，同秒建的会话前缀相同 → 歧义被**静默**伪装成「不存在」。
 *  所以现在：不是完整 uuid 就抛 `Bad`（宿主把它变成 400 + 人话），并在可能时**告诉你正确的完整 id**。
 *  （文档已同步：界面/日志/提示词/工具返回值一律给完整 id。） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveId(id) {
	if (!id) return id;
	const s = String(id);
	if (UUID_RE.test(s)) return s; // 完整 id：原样（在不在，由各路由自己回 404）
	const ids = allFiles().map((f) => idOf(f)).filter(Boolean);
	const pref = ids.filter((x) => x.startsWith(s));
	const tail = ids.filter((x) => x.endsWith(s));
	const hint =
		pref.length === 1
			? `（它唯一的**前缀**是 ${pref[0]} —— 请用这个完整 id）`
			: pref.length > 1
				? `（有 ${pref.length} 个会话以它开头：${pref.slice(0, 3).join(" / ")}${pref.length > 3 ? " …" : ""} —— 前缀不保证唯一，请用完整 id）`
				: tail.length === 1
					? `（它看起来是 ${tail[0]} 的**尾巴** —— 尾巴永远解析不到，请用完整 id）`
					: "";
	throw new Bad(`会话 id 必须是完整的 36 字符 uuid；收到的是 ${JSON.stringify(s.slice(0, 48))}${hint}`);
}

// ───────────────── 会话文件头：只读头部，别整份读（本次性能改动的 ①） ─────────────────
//
// **为什么**：pi 的会话文件是**只追加**的，头（第一行）在写入时最先落盘、之后再不变。
// 而旧写法 `JSON.parse(fs.readFileSync(file,"utf8").split("\n",1)[0])` 为了拿这第一行
// **把整个文件读完**——`/tree` 每个节点都要调一次它，于是“看一眼树”= 把全部会话字节重读一遍。
// 实测（逐文件深比解析后的头都相同）：
//   · Linux 238 文件 / 95 MB：49~54 ms → **2.1~2.6 ms**（~21×）
//   · Windows 上 52 文件 / 113 MB：304~316 ms → **18~20 ms**（~16×）
// 端到端 `/tree`（同一份数据、同一端口顺序）：101.7 ms → 32.1 ms（238 会话）
//（剩下的那部分不再跟 headerOf 走，而跟**会话数**走：见 base-logic 里 readTitles 那段。）

/** 读头时最多先看这么多字节。**不是**缓存命中率参数：命中不了也无所谓（读 8 KB 本身就够便宜），
 *  绝不能为了“让缓存更常命中”把它调大 —— 那样就等于把整份读又请回来了。 */
const HEAD_BYTES = 8 * 1024;

/** file -> { size, mtimeMs, header }。只缓存**成功解析出来的**头（见下面“坏头不缓存”那段）。
 *  热会话一直在追加 → mtime/size 一直变 → 一直 miss；这是预期的，不为此做任何优化。 */
const headerCache = new Map();

/** 第一行（不含 `\n`）。返回 string；读不到时抛。
 *
 *  ⚠️ **正确性陷阱（别踩）**：如果 8 KB 里**找不到换行**，只有两种可能 ——
 *    (a) 文件本来就小于 8 KB（那这 8 KB 里就是全部内容）；
 *    (b) **头那一行比 8 KB 还长**。
 *  这条路上**必须退回整读**，绝不能因为“8 KB 里没解析出东西”就放弃：
 *  上层把 `null` 当成「cwd 未知」→ 静默落到 `DEFAULT_CWD`（见下面 create() 的两处调用），
 *  那是**语义退化** —— 比慢更坏，而且看不出来。所以这里的每一条失败路径都指向“整读”，
 *  而不是“返回 null 收工”。 */
function firstLineOf(file, size) {
	if (size <= HEAD_BYTES) return fs.readFileSync(file, "utf8").split("\n", 1)[0]; // (a) 小文件：一次读完
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(HEAD_BYTES);
		const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
		// 只在**真读到的** n 个字节里找换行：allocUnsafe 的尾巴是脏的。
		// 按字节切 LF 是安全的（LF 只有一个字节，绝不会是某个多字节字符的一半）。
		const nl = buf.subarray(0, n).indexOf(10);
		if (nl >= 0) return buf.toString("utf8", 0, nl);
	} finally {
		fs.closeSync(fd);
	}
	// (b) 8 KB 里没有换行 ⇒ 头那一行超长。**退回整读**（这里就是那条不能丢的退路）。
	return fs.readFileSync(file, "utf8").split("\n", 1)[0];
}

/** 只读会话文件头（第一行）——拿 cwd 与 parentSession。
 *  与旧版的**唯一**区别是“怎么读到那一行”，返回的**内容**逐字节不变（有测试与 sha1 对账）。 */
function headerOf(file) {
	try {
		const st = fs.statSync(file);
		const hit = headerCache.get(file);
		if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.header;
		const header = JSON.parse(firstLineOf(file, st.size));
		// 只缓存成功的。解析失败（文件正在写、真坏了）时**不**写入缓存 ——
		// 否则一次瞬时坏读会被钉住，后面每次 /tree 都跟着错，而且没有自愈的机会。
		headerCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, header });
		return header;
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
		// **队列事件**（pi 的 `_emitQueueUpdate()` → `agent-session.js:320`）。
		// 形状**原样**采用 pi 的：`{ steering: [文本...], followUp: [文本...] }` —— 不另造语义。
		// 它同时是“入队”与“离队（被注入）”的信号：`steering`/`followUp` 里**没有**那条 = 已经不在队里。
		// 前端就是靠它把“排队中”那个态**自动清掉**（而不是靠猜/轮询）。
		// 大小：数组里是**用户消息文本**（本来就经 HTTP 传过一次），不是正文/工具结果 —— 小。
		// 长度仍兜一个上限：队列里偶尔会有很长的插话，别让一条事件把订阅者撑爆。
		case "queue_update":
			return { t: "queue", steering: (ev.steering ?? []).map(clipQueueText), followUp: (ev.followUp ?? []).map(clipQueueText) };
		default:
			return null;
	}
}

/** 队列事件里单条文本的上限（正文字符）。前端只拿它**对齐**自己发过的那条（<1000 的常见情形全字匹配），
 *  超长插话会被截 —— 那时前端对不上就**不冒充**“排队中”（宁可不说，也不说错）。*/
const QUEUE_TEXT_MAX = 1000;
const clipQueueText = (s) => { const t = String(s); return t.length > QUEUE_TEXT_MAX ? t.slice(0, QUEUE_TEXT_MAX) : t; };

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
	// **显式钉住投递形状**（别吃 pi 的默认）：pi 的 `settingsManager.getSteeringMode()` 是
	// `this.settings.steeringMode || "one-at-a-time"` —— 那个 `"one-at-a-time"` 是**代码里的兑底值**。
	// 上游哪天把兑底值改成 `"all"`（或引入别的默认），我们的投递形状（steer 逐轮注入 vs 一次全给）
	// 就**静默变了** —— 而 webui 的“排队中”显示、`push`/notify 的唤醒都建立在它上面。
	// 所以把“我们依赖的形状”写成**显式配置**（pi 自己提供的 `setSteeringMode`/`setFollowUpMode`，RPC 也用它）：
	// 写进 `$ASSIST_HOME/settings.json`，`session.reload()` 会从 settings 同步回 agent ⇒ 热重载/重启都钉得住。
	// 只在**盘上那份值不等于我们的**时才写（避免每次建 runtime 都白写一遍设置文件）。
	pinQueueModes(runtime.session);
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

/** 我们依赖的队列模式（`SOPHO_STEERING_MODE` / `SOPHO_FOLLOWUP_MODE` 可覆盖；默认 `one-at-a-time`）。*/
const STEERING_MODE = process.env.SOPHO_STEERING_MODE ?? "one-at-a-time";
const FOLLOWUP_MODE = process.env.SOPHO_FOLLOWUP_MODE ?? "one-at-a-time";
/** 把上面两个模式**显式**写进 pi 的 settings（见 makeEntry 里的说明）。写不成就算了（老 pi 没这 API）。 */
function pinQueueModes(session) {
	try {
		const sm = session.settingsManager;
		const persisted = sm?.settings ?? {}; // **盘上那份**（不是带兑底的 getter）
		if (persisted.steeringMode !== STEERING_MODE) session.setSteeringMode(STEERING_MODE);
		if (persisted.followUpMode !== FOLLOWUP_MODE) session.setFollowUpMode(FOLLOWUP_MODE);
	} catch {
		/* 老 pi / 被锁死 → 退回 pi 的默认；绝不因此把建会话搞挂 */
	}
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
		// **队列对账**（= pi 的 `session.pendingMessageCount`）：steering + followUp 里还有几条。
		// 它只是个 **getter**（两个数组 `.length` 相加）—— 不是“读队列内容/拷数组”，挂在热路径上也无所谓。
		// 前端拿它**对账**乐观状态：0 = 队里没东西（“排队中”那个态就该清）。
		pendingMessageCount: s.pendingMessageCount ?? null,
		// 这个 runtime **实际**在用的投递形状（我们显式钉的，见 makeEntry；万一被别的进程改过也能一眼看出来）。
		steeringMode: s.steeringMode ?? null,
		followUpMode: s.followUpMode ?? null,
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
	try {
		// 会话 id **只收完整 uuid**（片段 → 400 + 人话）—— 所以这一步必须在 try 里，不能再提到外面。
		if (seg[0] === "sessions" && seg[1]) seg[1] = resolveId(seg[1]);
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
