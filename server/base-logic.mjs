/**
 * v2 · 会话基底的「逻辑」—— 天天改的那部分，可热重载。
 *
 * 这里放：路由、API 的形状、正文怎么读出来、树怎么长。
 * 生效方式：`curl -X POST localhost:7331/reload-code`
 *   —— 不用重启 A，池不动、一个会话都不丢。
 * （只有改宿主 server/base.mjs 才需要 bin/restart-base.sh。）
 *
 * ── 改这个文件时要守的规矩 ──
 *   1. **无长活状态**。跨请求的状态要么在宿主（池），要么在文件里。
 *      模块级只允许放**缓存**，并且必须假设"一重载就没了"。
 *   2. **不要在这里 subscribe pi 的事件** —— 重载会丢订阅。
 *      事件扇出（pi 事件 → SSE）归宿主，池里的 entry 里已经接好了。
 *      （唯一例外：订阅建在**进程级单例**上、回调每次现读单例里的 hook —— 见下面插件 watcher。）
 *   3. 会话正文/树这类"给人看"的形状都归这里；"pi 文件怎么访问"（idOf/fileOf/headerOf）归宿主。
 *   4. **要活过重载的状态只有一条路：挂 `globalThis` 的进程级单例**（下面插件 watcher 就是）。
 *      模块级变量一重载就重置；而"每次重载都新建一份"的东西（定时器、事件订阅）会**叠加** ——
 *      几个来回后同一个文件会被 reload 十几遍。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ═════════════════════ 网络压力仪表（只计量，不改任何行为） ═════════════════════
//
// 为什么单独存在：要弄清「webui 到底把多少字节推给浏览器」，就得有**按路由**的计数 +
// **每 5 秒一桶**的时间序列。累计值回答不了「开着页面什么都不干，速率是多少」——桶能。
// 这一层只**看**（patch res.write/res.end 数字节），不缓存、不改 header、不改响应内容：
// 这样量出来的才是「未优化」的干净基线，前后可比。
//
// 三条硬约束（踩了就白量）：
//   1. **含流式**：SSE 是长连接，`res.write` 出去的每个字节都要算 —— 不能只数 `res.end`。
//      （A 的事件扇出在宿主里（entry.subscribers），但写的是**同一个 res 对象**，patch 照样罩得住。）
//   2. **请求数 ≠ 连接数**：一条 SSE 长连接是 1 次请求、1 条长活连接；两者分开记，
//      否则「每 5 秒轮询一次」的曲线会被 SSE 的心跳和 tool 输出顶爆。
//   3. **不记内容**：不算 body、不记 query 的值、不记会话 id（路由模板化，36 位 id → `:id`）。
//
// 状态必须活过 `POST /reload-code`（否则每次改代码都把基线清零）→ 挂 globalThis 单例。
const METRICS_KEY = "__sophoBaseNetMetrics";
const BUCKET_MS = 5_000; // 每 5 秒一个桶
const BUCKETS_KEPT = 12; // 保留最近 12 个 = 最近 1 分钟

/** pi 的会话 id（36 位 uuid）—— 路由模板化时认它，**绝不把 id 铺出去**。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 进程级单例（热重载不重置）。 */
function netMetrics() {
	let st = globalThis[METRICS_KEY];
	if (!st) {
		st = { startedAt: Date.now(), requests: 0, bytes: 0, open: 0, maxOpen: 0, routes: new Map() };
		globalThis[METRICS_KEY] = st;
	}
	return st;
}

/** 路径 → 路由模板。`/sessions/<uuid>/messages` → `/sessions/:id/messages`。
 *  seg[1] 在 sessions 下**必是**会话 id（宿主已把短 id 解析成完整 uuid），所以无脑换；
 *  其余位置只换 uuid 形状的段，普通段照留（这样 404 也归得到一条线上）。 */
function routePatternOf(seg) {
	const parts = seg.map((s, i) => (i === 1 && seg[0] === "sessions" ? ":id" : UUID_RE.test(s) ? ":id" : s));
	return `/${parts.join("/")}`;
}

/** chunk 的**字节**数（字符串按 encoding 算，Buffer/Uint8Array 直接长）。 */
function byteLen(chunk, encoding) {
	if (chunk == null) return 0;
	if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined);
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	return 0;
}

function routeRec(st, pattern) {
	let r = st.routes.get(pattern);
	if (!r) {
		r = {
			pattern,
			requests: 0,
			bytes: 0,
			open: 0,
			maxOpen: 0,
			firstAt: Date.now(),
			lastRequestAt: null,
			lastByteAt: null,
			buckets: new Map(), // bucketIndex → { requests, bytes }
		};
		st.routes.set(pattern, r);
	}
	return r;
}

/** 记账进**当前**桶（按事件发生的时刻），顺带丢掉超出窗口的老桶。 */
function bumpBucket(rec, at, dr, db) {
	const idx = Math.floor(at / BUCKET_MS);
	let b = rec.buckets.get(idx);
	if (!b) {
		b = { requests: 0, bytes: 0 };
		rec.buckets.set(idx, b);
		if (rec.buckets.size > BUCKETS_KEPT) for (const k of [...rec.buckets.keys()]) if (k <= idx - BUCKETS_KEPT) rec.buckets.delete(k);
	}
	b.requests += dr;
	b.bytes += db;
}

function addBytes(st, rec, n) {
	if (!n) return;
	const at = Date.now();
	rec.bytes += n;
	st.bytes += n;
	rec.lastByteAt = at;
	bumpBucket(rec, at, 0, n);
}

/** 给一次请求装上计数器。**在交给路由之前调用**（404 也归得到线上）。 */
function instrumentRequest(req, res, pattern) {
	const st = netMetrics();
	const rec = routeRec(st, pattern);
	const at = Date.now();

	rec.requests += 1;
	st.requests += 1;
	rec.lastRequestAt = at;
	bumpBucket(rec, at, 1, 0);
	rec.open += 1;
	st.open += 1;
	if (rec.open > rec.maxOpen) rec.maxOpen = rec.open;
	if (st.open > st.maxOpen) st.maxOpen = st.open;

	// HEAD 没有 body（node 自己会丢掉写入）→ 不数，否则基线虚高。
	const counts = req.method !== "HEAD";
	const ow = res.write;
	const oe = res.end;
	res.write = function (chunk, encoding, cb) {
		if (typeof encoding === "function") {
			cb = encoding;
			encoding = undefined;
		}
		if (counts) addBytes(st, rec, byteLen(chunk, encoding));
		return ow.call(this, chunk, encoding, cb);
	};
	res.end = function (chunk, encoding, cb) {
		if (typeof chunk === "function") {
			cb = chunk;
			chunk = undefined;
		}
		if (typeof encoding === "function") {
			cb = encoding;
		}
		if (counts) addBytes(st, rec, byteLen(chunk, typeof encoding === "string" ? encoding : undefined));
		return oe.call(this, chunk, typeof encoding === "string" ? encoding : undefined, cb);
	};

	// 连接开/关：非 SSE 请求 finish 后就关；SSE 长连接一直到 close。
	let closed = false;
	const done = () => {
		if (closed) return;
		closed = true;
		rec.open -= 1;
		st.open -= 1;
	};
	res.on("finish", done);
	res.on("close", done);
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/** 仪表读数：累计 + 12 个桶（旧→新）+ 派生值。
 *  派生 rate 一律用 **1 分钟窗口**（不是 since-start）—— 「**空闲时**多少 B/s」只能这么答。 */
function netSnapshot() {
	const st = netMetrics();
	const now = Date.now();
	const cur = Math.floor(now / BUCKET_MS);
	const oldest = cur - BUCKETS_KEPT + 1;
	const windowMs = BUCKETS_KEPT * BUCKET_MS;

	// 全窗口逐桶（全局）+ 每条路由自己的 12 桶
	const buckets = [];
	for (let i = oldest; i <= cur; i++) {
		let requests = 0;
		let bytes = 0;
		const byRoute = {};
		for (const r of st.routes.values()) {
			const b = r.buckets.get(i);
			if (!b || (!b.requests && !b.bytes)) continue;
			requests += b.requests;
			bytes += b.bytes;
			byRoute[r.pattern] = { requests: b.requests, bytes: b.bytes };
		}
		buckets.push({ t: i * BUCKET_MS, ageSec: r3((now - i * BUCKET_MS) / 1000), requests, bytes, bytesPerSec: r3(bytes / (BUCKET_MS / 1000)), routes: byRoute });
	}

	const routes = [];
	for (const r of st.routes.values()) {
		const per = [];
		let wReqs = 0;
		let wBytes = 0;
		for (let i = oldest; i <= cur; i++) {
			const b = r.buckets.get(i) ?? { requests: 0, bytes: 0 };
			wReqs += b.requests;
			wBytes += b.bytes;
			per.push({ t: i * BUCKET_MS, requests: b.requests, bytes: b.bytes });
		}
		routes.push({
			pattern: r.pattern,
			requests: r.requests, // 请求数（一条 SSE = 1 次）
			openConnections: r.open, // 此刻还开着的连接数（SSE 会长活在这）
			maxOpenConnections: r.maxOpen,
			bytes: r.bytes,
			bytesPerSec: r3(r.bytes / Math.max((now - r.firstAt) / 1000, 0.001)), // 自 A 记账起的平均
			lastRequestAt: r.lastRequestAt,
			lastByteAt: r.lastByteAt,
			last1m: { requests: wReqs, bytes: wBytes, bytesPerSec: r3(wBytes / (windowMs / 1000)) },
			buckets: per, // 12 个（旧→新）
		});
	}

	const totalBytes = st.bytes;
	const winBytes = buckets.reduce((a, b) => a + b.bytes, 0);
	const winReqs = buckets.reduce((a, b) => a + b.requests, 0);
	for (const r of routes) {
		r.share = totalBytes ? r3(r.bytes / totalBytes) : 0; // 自记账起的占比
		r.share1m = winBytes ? r3(r.last1m.bytes / winBytes) : 0; // 最近 1 分钟的占比
	}
	routes.sort((a, b) => b.bytes - a.bytes);

	return {
		now,
		pid: process.pid,
		startedAt: st.startedAt,
		uptimeMs: now - st.startedAt,
		bucketMs: BUCKET_MS,
		bucketsKept: BUCKETS_KEPT,
		bucketsOrder: "oldest → newest",
		bytesNote: "只数 payload（res.write/res.end 的字节），不含 HTTP 头/状态行/分块框架",
		selfExcluded: ["/metrics", "/reload-code", "/host"],
		totals: {
			requests: st.requests,
			bytes: st.bytes,
			openConnections: st.open,
			maxOpenConnections: st.maxOpen,
			last1m: { requests: winReqs, bytes: winBytes, bytesPerSec: r3(winBytes / (windowMs / 1000)) },
			bytesPerSec: r3(st.bytes / Math.max((now - st.startedAt) / 1000, 0.001)),
		},
		buckets,
		top3ByBytes: routes.slice(0, 3).map((r) => ({ pattern: r.pattern, bytes: r.bytes, share: r.share, bytesPerSec1m: r.last1m.bytesPerSec })),
		routes,
	};
}

export function create(ctx) {
	// ─────────────────────── 插件层（pi 扩展）的新鲜度 ───────────────────────
	// 事实：**扩展是每个 runtime 建立时加载的**（宿主 factory → createAgentSessionServices），
	// 而且 pi 的加载器按 **cwd** 在进程内缓存扩展模块（cwd 没变就复用上次那份代码）。
	// 池里的长活会话永远跑它建立那一刻的模块；`POST /reload-code` 只换本文件，**完全不碰插件层**。
	// 所以只有「建 runtime 时**实际加载**的那一版」能认出旧插件。宿主（server/base.mjs）在 makeEntry
	// 里记，那是正路；下面这点补记只是**兜底** —— A 还在跑旧宿主（没有那个字段）时，我在「刚好把
	// entry 造出来」的这一刻补记。宿主一重启，stamp() 就自动变成 no-op。
	const PLUGIN_FILE = ctx.pluginFile ?? fileURLToPath(new URL("../pi-extensions/assistant/index.ts", import.meta.url));
	const pluginNow = () => {
		try {
			return fs.statSync(PLUGIN_FILE).mtimeMs;
		} catch {
			return null;
		}
	};

	/** 插件文件的完整指纹：mtimeMs + size + 内容 hash（读不到 → 全 null，不抛）。
	 *  判"文件到底变没变"要看 hash —— mtime 会被编辑器抖动 / checkout / touch 骗到。 */
	const pluginFingerprint = () => {
		try {
			const st = fs.statSync(PLUGIN_FILE);
			if (!st.isFile()) return { mtimeMs: null, size: null, hash: null };
			const hash = createHash("sha256").update(fs.readFileSync(PLUGIN_FILE)).digest("hex").slice(0, 16);
			return { mtimeMs: st.mtimeMs, size: st.size, hash };
		} catch {
			return { mtimeMs: null, size: null, hash: null };
		}
	};

	/** 只给「这一刻刚建出来的」entry 补记插件 mtime；早就热着的老 entry 无从得知 → 保持 null（不知道）。
	 *  同样要镜像 pi 的 per-cwd 缓存：只有 cwd 变了，这次加载才真的是「刚从磁盘读的」。
	 *  逻辑重载后这个镜像从空开始 → 重载后**第一条**新建会话仍可能沿用旧镜像
	 *（pi 的实际缓存 cwd 我们看不到），再一次 cwd 变化后就对齐了。 */
	let mirror = { cwd: null, fp: null };
	const pluginOnLoad = (cwd) => {
		const dir = path.resolve(cwd ?? ctx.DEFAULT_CWD);
		if (mirror.cwd !== dir || !mirror.fp) mirror = { cwd: dir, fp: pluginFingerprint() };
		return mirror.fp;
	};
	const stamp = (entry, wasHot) => {
		if (entry && !wasHot && entry.pluginMtimeMs == null) {
			const fp = pluginOnLoad(entry.cwd);
			entry.pluginMtimeMs = fp.mtimeMs;
			entry.pluginHashAtLoad = fp.hash;
		}
		return entry;
	};
	const ensure = async (id) => {
		const wasHot = ctx.pool.has(id);
		return stamp(await ctx.ensure(id), wasHot);
	};
	const create = async (opts) => stamp(await ctx.create(opts), false);

	// ─────────── 发送串行化：堵住 pi 的 `isStreaming` 窗口（会静默丢消息） ───────────
	//
	// 事实（已核到行）：宿主 `server/base.mjs` 的 `prompt()` **同步读** `session.isStreaming`
	// 决定带不带 `streamingBehavior`；而 pi 的 `AgentSession.prompt()` 把 `_isAgentRunActive = true`
	// 放在**若干 await 之后**（`agent-session.js:773/860`）。两条请求落进那个窗口 →
	// 都读到 `isStreaming === false` → 都当「普通 prompt」发 → 后一条抛 already processing，
	// 被 `.catch` 变成一条 SSE error，**HTTP 照样 202** ⇒ 用户消息被静默吞掉。
	//
	// 修法：**逻辑层自己按会话串行化这个窗口** —— 发出第一条后，在「真的看到这一轮起来了」
	// （`isStreaming` 变 true / 那一发已经落定）之前，第二条**不裸发**，而是等一拍再以
	// steer/followUp 发；始终没看到起来就超时兜底，照样当普通 prompt 发（**绝不卡死**）。
	//
	// ⚠️ 为什么必须直接调 `session.prompt`、不用 `ctx.prompt`：`ctx.prompt` 自己重算
	// opts（isStreaming 假就不带 behavior）—— 那正是竞态本身，得绕开。
	// 绕开的代价是宿主 `.catch → broadcast(error)` 那条路没了，所以这里照原样补一条
	// （只写 entry.subscribers，和宿主 broadcast 的线格式一致）。
	//
	// 状态挂在 **entry 上**（不是模块变量）：entry 活在宿主池里 → 活过逻辑热重载（规矩 1/4）。
	const SEND = Symbol.for("sopho.base.sendWindow");
	const SEND_WINDOW_MS = Number(process.env.SOPHO_SEND_WINDOW_MS ?? 5000);
	const sendState = (entry) => (entry[SEND] ??= { pending: null });
	const isBusyError = (e) => /already processing/i.test(String(e?.message ?? e));
	const nextTick = () => new Promise((r) => setImmediate(r));
	const nap = (ms) => new Promise((r) => setTimeout(r, ms));

	/** 发一条（**不 await 整轮**）；返回一个能看出「有没有被接受」的 rec。 */
	const fire = (entry, text, streamingBehavior) => {
		const rec = { settled: false, rejected: false, error: null, at: Date.now() };
		// 直接调 pi：`streamingBehavior` **无条件**带上（空闲时它当一个普通 prompt，在跑时插队）——
		// 这正是不再依赖"读 isStreaming 那一瞬"的地方。
		entry.runtime.session.prompt(text, streamingBehavior ? { streamingBehavior } : {}).then(
			() => {
				rec.settled = true;
			},
			(err) => {
				rec.settled = true;
				rec.rejected = true;
				rec.error = err;
				// 与宿主 `.catch(() => broadcast(entry, {t:"error",...}))` 等价（线格式一致）。
				const line = `data: ${JSON.stringify({ t: "error", message: String(err?.message ?? err) })}\n\n`;
				for (const res of entry.subscribers ?? new Set()) {
					try {
						res.write(line);
					} catch {
						entry.subscribers.delete(res);
					}
				}
			},
		);
		return rec;
	};

	/** 等「这一轮真的起来了」：isStreaming 变 true / 那一发已经落定 / 超时。 */
	const waitTurnStart = async (entry, rec, ms) => {
		const s = entry.runtime.session;
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (s.isStreaming) return "streaming";
			if (rec?.settled) return rec.rejected ? "rejected" : "settled";
			await nap(5);
		}
		return s.isStreaming ? "streaming" : "timeout";
	};

	/** 等一拍，看 pi 到底**拒没拒**这一发。
	 *  ⚠️ 判据是「pi **有没有拒绝**」这个**事实**（`rec.rejected`），**不是**错误文本匹配
	 *  （以前是 `busy = rec.rejected && isBusyError(rec.error)` ⇒ 别的拒绝理由匹配不上 ⇒ accepted=true
	 *   ⇒ 路由回 202 而消息悄悄不见）。最典型的反例就是**压缩中**：
	 *   pi 抛 "Cannot submit a prompt while compaction is in progress…"（不匹配 /already processing/i）
	 *   ⇒ 以前那版会回 202 却把消息丢掉，违反路由那句「**真接受不了就别回 202（回 409 并说清）**」。
	 *  `isBusyError` 现在只用来决定「**要不要改 steer 重发**」（见 deliver 的 ③），不再当"接不接受"的判据。
	 *  `streaming/behavior` 是"这一发是以什么姿态发的"（回执给人看），与 `accepted` 无关。 */
	const outcome = async (rec, streaming, behavior) => {
		await nextTick();
		return {
			streaming,
			behavior,
			accepted: !rec.rejected,
			...(rec.rejected ? { error: String(rec.error?.message ?? rec.error) } : {}),
		};
	};

	/** 把一条消息交给某个会话（所有发消息的路都该走它）—— 返回 { streaming, behavior, accepted, error? }。 */
	const deliver = async (entry, text, behavior) => {
		const s = entry.runtime.session;
		const st = sendState(entry);
		const pick = () => (behavior === "followUp" ? "followUp" : "steer");

		// ① 已经在跑：明确 steer/followUp（与旧行为一致）
		if (s.isStreaming) {
			st.pending = null;
			return outcome(fire(entry, text, pick()), true, pick());
		}

		// ② 「刚发出去、还没看到它起来」的窗口：等它起来，别裸发
		if (st.pending && !st.pending.settled) {
			const how = await waitTurnStart(entry, st.pending, SEND_WINDOW_MS);
			if (how === "streaming") {
				st.pending = null;
				return outcome(fire(entry, text, pick()), true, pick());
			}
			// 没起来 / 已经落定 / 超时 → 落到下面当普通 prompt 发（兜底，**绝不卡死**）
		}

		// ③ 普通：发这一轮的第一条。**带上调用方给的 behavior** —— "空闲 + 明确要求 steer"
		// 是明明白白的意图（对 pi 无害：isStreaming 假时它整段跳过），不该在这一层被静默抹成普通 prompt。
		const rec = fire(entry, text, behavior ?? null);
		st.pending = rec;
		await nextTick();
		// 罕见兜底：真撞上了别的 prompt（比如压着一个宽窗口）→ 立刻改 steer 重发，**绝不吞**。
		// ⚠️ 这条**必须先跑**：重发成功了就是 202 —— 别把它误报成 409。
		if (rec.rejected && isBusyError(rec.error)) {
			const rec2 = fire(entry, text, pick());
			st.pending = rec2;
			return outcome(rec2, true, pick());
		}
		return outcome(rec, false, behavior ?? null);
	};

	/** 状态 = 宿主那份 + 插件新鲜度（每个会话都能说清「你跑的是哪一版插件」）。 */
	const status = (entry) => {
		const now = pluginFingerprint();
		const at = entry.pluginMtimeMs ?? null;
		const atHash = entry.pluginHashAtLoad ?? null;
		return {
			...ctx.status(entry),
			// 树上显示的就是这个（pi 的 session_info）；title = 我们这一层的账（谁给的）。
			// ⚠️ name 读**文件**（nameOf），不读 session.sessionName：runtime 里那份是**内存**的 ——
			// TUI 是另一个进程，它 `/name` 改的是文件，热 runtime 里那份会旧 （不想让 /tree 与 /sessions/{id}
			// 对同一个会话报两个名字）。读不到文件才退回内存名。
			name: nameOf(entry.file) ?? entry.runtime.session.sessionName ?? null,
			title: titleRecOf(entry.id),
			// 池里的 entry 就是热的（宿主那份 status 只在冷分支才给 hot）
			hot: true,
			// 这个 runtime 建起来时插件层**实际加载**的版本（null = 不知道）
			pluginMtimeMs: at,
			pluginHashAtLoad: atHash,
			// 当前磁盘上那份插件的版本
			pluginNowMtimeMs: now.mtimeMs,
			pluginNowHash: now.hash,
			// 内容 hash 优先（mtime 精度只到秒、同一秒内改两次会漏判）；hash 不知道才退回 mtime。
			// 仍不是铁证（pi 按 cwd 缓存模块，我们只能记"建/重载 runtime 那一刻磁盘上是哪版"），
			// 要铁的话：POST /sessions/{id}/reload 或重启 A。
			pluginStale:
				atHash != null && now.hash != null
					? atHash !== now.hash
					: at == null || now.mtimeMs == null
						? null
						: now.mtimeMs !== at,
		};
	};

	/** pi 的**队列内容**（两侧全给）：`getSteeringMessages()` / `getFollowUpMessages()`
	 *  （`agent-session.js:1209/1213`）。只用在 **SSE `hello` 那一次对账**（连上/重连）——
	 *  稳态靠宿主转发的 `queue_update` 事件（`{t:"queue"}`）驱动，不在这里轮询。*/
	const queueOf = (entry) => {
		const s = entry?.runtime?.session;
		try {
			return {
				steering: [...(s?.getSteeringMessages?.() ?? [])],
				followUp: [...(s?.getFollowUpMessages?.() ?? [])],
			};
		} catch {
			return { steering: [], followUp: [] };
		}
	};

	/** 让一个 runtime 重新加载插件层；成功就把 pluginMtimeMs 更新成「新吃进去的那一版」。 */
	const reloadPlugin = async (entry) => {
		const s = entry.runtime.session;
		if (typeof s.reload !== "function") return false;
		await s.reload();
		// pi 的 reload 会 clearExtensionCache → 这个 runtime 吃的是现在磁盘上这份。
		// 宿主那边的镜像也要同步清掉（旧宿主没这个口子就退回本地读数）。
		ctx.notePluginReload?.();
		mirror = { cwd: null, fp: null };
		// reload **之后**再读：这才是它刚吃进去的那一版。
		const fp = pluginFingerprint();
		entry.pluginMtimeMs = fp.mtimeMs;
		entry.pluginHashAtLoad = fp.hash;
		return true;
	};

	// ─────────────── 插件改动「自动生效」：watcher（进程级单例） ───────────────
	// 改完 pi-extensions/ 并**提交**之后，池里的热会话自动吃上新版 —— 不用人肉
	// `POST /sessions/{id}/reload`。这件事宿主一个字都不用改。
	//
	// 触发条件（两条都要）：
	//   1. 插件文件**内容 hash 变了**（mtime 会被编辑器抖动 / checkout 骗到，hash 才是真的）
	//   2. 该文件相对 git **是干净的**（= 已提交）。半成品文件永远是 dirty；"提交"是这个项目里
	//      唯一稳定的"写完了"信号。git 问不到（不是 repo / 没装 git）→ 退化成「内容稳定
	//      STABLE_MS 没再变」就算写完（日志会写明走的是兜底）。
	//
	// 两条硬约束：
	//   · **加载失败绝不破坏现状**：先拿 pi 自己的 loader **单独预检**一遍，失败就一个会话都不碰、
	//     旧版照跑、同一版不再重试（等文件再变）。这一步不能省 —— pi 的 `session.reload()`
	//     **不会抛**：它只是把加载失败的扩展从 runner 里丢掉（errors 记进 resourceLoader），
	//     会话会**静默失去全部插件工具**，比不 reload 糟得多。
	//   · **绝不打断正在跑的会话**：isStreaming 的会话挂起（pending），等这一轮真结束
	//     （agent_settled / agent_end 信号；兜底靠轮询）再 reload。
	//
	// ⚠️ 本文件每次 /reload-code 都重新 import。watcher 必须**进程级单例**（规矩 4）：否则每热重载
	//   一次就多一个 interval + 多一份事件订阅，几个来回同一个文件被 reload 十几遍。

	const WATCH_MS = 1000; // 轮询间隔（便宜：先比 mtime+size，变了才读文件算 hash）
	const GIT_RECHECK_MS = 3000; // 「文件没变但可能刚提交」时复查 git 的节流
	const STABLE_MS = 5000; // 问不到 git 时的兜底：内容稳定这么久就当写完了
	const WATCH_OFF = process.env.SOPHO_PLUGIN_WATCH === "0";
	const log = (m) => console.log(`[plugin-watch] ${m}`);
	// 日志里报会话一律用**完整 uuid**（曾经只报前 8 位：同毫秒建的两个会话前 8 位相同，
	// 实测撞过 `01a0a3cc-b030-…` 与 `01a0a3cc-d05a-…` → 那种片段既认不出、`grep` 也不唯一）。

	const WATCH_KEY = "__sophoPluginWatch";
	const WATCH_V = 2; // 单例的形状版本（下面注意看）
	const freshWatch = () => ({
		v: WATCH_V,
		file: PLUGIN_FILE,
		createdAt: Date.now(),
		attaches: 0, // 逻辑热重载把 hook 挂上来的次数（每次 /reload-code +1）
		timersCreated: 0, // 必须永远 ≤ 1：涨了就说明又建了一个 watcher
		timer: null,
		busy: false,
		hook: null, // 每次挂载后指向**当前**这份逻辑（回调里现读，绝不闭包住）
		subs: new Map(), // 会话 id → pi 事件退订函数（用来在轮次结束的瞬间收尾）
		pending: new Set(), // 正在跑、等这一轮结束再 reload 的会话
		newEntries: new Set(), // 本轮新进池的会话（对账用：怕它落到 pi 的旧模块缓存上）
		appliedHash: null, // 已经推进池里的插件版本
		failedHash: null, // 这一版加载失败过 → 不再重试，等文件再变
		dirtyHash: null, // 见过、但还没提交的那一版
		dirtyLoggedHash: null,
		mtimeMs: null,
		size: null,
		gitCheckedAt: 0,
		stableSince: 0,
		stats: {
			triggers: 0,
			lastTriggerAt: null,
			lastTriggerHash: null,
			lastReloaded: 0,
			lastReloadedAt: null,
			totalReloads: 0,
			skippedDirty: 0,
			preflights: 0,
			failures: 0,
			lastError: null,
			lastErrorAt: null,
		},
	});
	/** 进程级单例。**只建一次**；之后每次 /reload-code 只是把 hook 重指到新逻辑。
	 *  万一开发期把这个单例的**形状**改了（加字段）：拿新默认值把旧的补上、留住活的那些
	 *  （timer / 指纹 / pending / subs）—— 绝不多建一个 timer。 */
	const watcher = () => {
		const cur = globalThis[WATCH_KEY];
		if (cur && cur.v === WATCH_V) return cur;
		const base = freshWatch();
		const next = cur ? { ...base, ...cur, v: WATCH_V, stats: { ...base.stats, ...(cur.stats ?? {}) } } : base;
		globalThis[WATCH_KEY] = next;
		return next;
	};

	/** 插件文件相对 git 干净吗？true = 已提交（干净）；false = 有未提交/未跟踪改动；null = 问不到。
	 *  只问这一个文件 —— 工作树里别的地方脏不影响。（git() 定义在下面「环境查询」段，运行时才调到。） */
	const pluginCommitted = () => {
		const out = git(path.dirname(PLUGIN_FILE), ["status", "--porcelain", "--", PLUGIN_FILE]);
		return out == null ? null : out === "";
	};

	/** pi 的扩展加载器在哪 —— 包根**没公开导出**它（package.json 的 exports 只有 "."），
	 *  所以解析到包根后用绝对路径 import（同下面 exporterFile() 的做法）。 */
	const pluginLoaderFile = () => {
		const rel = "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
		try {
			const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
			const f = path.join(path.dirname(path.dirname(fileURLToPath(entry))), "dist/core/extensions/loader.js");
			if (fs.existsSync(f)) return f;
		} catch {
			/* 落到下面兜底 */
		}
		for (let d = path.dirname(fileURLToPath(import.meta.url)); ; d = path.dirname(d)) {
			const f = path.join(d, rel);
			if (fs.existsSync(f)) return f;
			if (path.dirname(d) === d) throw new Error("找不到 pi 的 dist/core/extensions/loader 模块");
		}
	};
	let pluginLoader = null; // 模块级缓存（规矩 1：缓存，重载没了下次再来一次无所谓）
	const loadPluginLoader = async () => {
		if (!pluginLoader) pluginLoader = await import(pathToFileURL(pluginLoaderFile()).href);
		return pluginLoader;
	};

	/** 单独把插件加载一遍，专门为了**在碰任何会话之前**知道它到底能不能加载。
	 *  用 pi 自己的 loader（同一个 jiti 转译、同样的错误文案），且**不走缓存** ——
	 *  pi 的 per-cwd 扩展缓存只由 loadExtensionsCached 写，这里不会污染它。
	 *  ⚠️ 这一步会**真的执行一遍插件的 factory**：本插件的 factory 是纯注册（registerTool），无副作用。
	 *  将来若在 factory 里做副作用（写文件 / 起连接），得换成别的预检方式。
	 *  返回错误字符串（失败）或 null（能加载）。 */
	const preflightPlugin = async () => {
		const { loadExtensions } = await loadPluginLoader();
		const res = await loadExtensions([PLUGIN_FILE], path.dirname(PLUGIN_FILE));
		const errs = res?.errors ?? [];
		if (errs.length) return errs.map((e) => `${e.path}：${e.error}`).join("；");
		if (!(res?.extensions ?? []).length) return "加载器没吐出任何扩展（factory 没跑？）";
		return null;
	};

	/** reload 之后翻一眼 pi 记下的扩展加载错误（预检没盖住的窗口：预检→reload 之间文件又变了）。
	 *  只报**插件文件自己**的错（pi 也会加载别的扩展 / skills）。只记日志 —— 旧版已经被换掉，救不回来。 */
	const sessionExtErrors = (entry) => {
		try {
			const res = entry.runtime.session?._resourceLoader?.getExtensions?.();
			const mine = (res?.errors ?? []).filter((e) => String(e?.path ?? "").includes("pi-extensions/assistant"));
			return mine.length ? mine.map((e) => String(e.error)).join("；") : null;
		} catch {
			return null; // 拿不到就算了，不是关键路径
		}
	};

	const isStreaming = (entry) => !!entry?.runtime?.session?.isStreaming;

	/** 已过预检 → 空闲的热会话立刻 reload；正在跑的挂起。只由 tick 调用。 */
	const applyNewPlugin = async (w, fp) => {
		w.stats.triggers++;
		w.stats.lastTriggerAt = Date.now();
		w.stats.lastTriggerHash = fp.hash;
		w.dirtyHash = null;
		w.stableSince = 0;

		let err = null;
		try {
			w.stats.preflights++;
			err = await preflightPlugin();
		} catch (e) {
			err = String(e?.message ?? e);
		}
		if (err) {
			// **一个会话都没动** —— 池里照旧跑旧版，A 继续服务。
			w.failedHash = fp.hash;
			w.stats.failures++;
			w.stats.lastError = err;
			w.stats.lastErrorAt = Date.now();
			w.stats.lastReloaded = 0;
			log(`插件预检失败（旧版继续跑，**一个会话没动**；等文件再变才重试）：${err}`);
			return;
		}
		// 预检期间文件又变了 → 这一版先不碰（下一轮按新 hash 重新走一遍）
		if (pluginFingerprint().hash !== fp.hash) {
			log(`预检之后插件又变了（hash ${fp.hash} 已经不是当前这版）→ 这一轮跳过`);
			return;
		}

		let n = 0;
		const failed = [];
		for (const e of [...ctx.pool.values()]) {
			if (isStreaming(e)) {
				w.pending.add(e.id); // 正在跑：**绝不打断**，等它这一轮结束
				continue;
			}
			try {
				if (await reloadPlugin(e)) {
					n++;
					const bad = sessionExtErrors(e);
					if (bad) failed.push(`${e.id}（reload 后报错：${bad}）`);
				} else failed.push(`${e.id}（这个 runtime 没有 reload()）`);
			} catch (e2) {
				failed.push(`${e.id}（${String(e2?.message ?? e2)}）`);
			}
		}
		w.appliedHash = fp.hash;
		w.stats.lastReloaded = n;
		w.stats.lastReloadedAt = Date.now();
		w.stats.totalReloads += n;
		const pend = [...w.pending]; // 完整 id（别截：截了就没法照着它去查是哪个会话）
		log(
			`插件新版生效（hash ${fp.hash}）：立刻重载 ${n} 个空闲会话；挂起 ${w.pending.size} 个正在跑的${pend.length ? `（${pend.join(", ")}）` : ""}`,
		);
		if (failed.length) log(`⚠️ 有会话没吃上（它们继续跑旧版）：${failed.join(" | ")}`);
	};

	/** 挂起的会话里已经空闲下来的 → 补 reload。返回这一轮补了几个。 */
	const drainPending = async () => {
		const w = watcher();
		if (!w.pending.size || !w.appliedHash) return 0;
		let n = 0;
		const failed = [];
		for (const id of [...w.pending]) {
			const e = ctx.pool.get(id);
			if (!e) {
				w.pending.delete(id); // 已经被回收了：没什么可 reload 的
				continue;
			}
			if (isStreaming(e)) continue; // 还在跑 → 继续挂着
			try {
				if (await reloadPlugin(e)) n++;
				else failed.push(`${id}（没有 reload()）`);
			} catch (e2) {
				failed.push(`${id}（${String(e2?.message ?? e2)}）`);
			}
			w.pending.delete(id);
		}
		if (n) log(`挂起的会话轮次结束 → 补重载 ${n} 个（还挂 ${w.pending.size} 个）`);
		if (failed.length) log(`⚠️ 挂起的会话没吃上：${failed.join(" | ")}`);
		return n;
	};

	/** 给池里的会话订阅 pi 事件（**建在单例上**，所以 /reload-code 不会丢订阅）。
	 *  只为把「这一轮真结束了」的补 reload 从「最多晚 1 秒」变成「立刻」。 */
	const ensureSubs = (w) => {
		for (const [id, off] of [...w.subs]) {
			if (ctx.pool.has(id)) continue;
			try {
				off();
			} catch {
				/* 退订失败无所谓（session 可能已经 dispose） */
			}
			w.subs.delete(id);
		}
		for (const [id, e] of ctx.pool) {
			if (w.subs.has(id)) continue;
			try {
				const off = e.runtime.session.subscribe((ev) => {
					// agent_end = 一次低层 run 结束（之后还可能 retry/compaction/排队 follow-up）；
					// agent_settled = 真的不会再自己跑下去了。两个都听，真正的判据在 drain 里看 isStreaming。
					if (ev?.type !== "agent_settled" && ev?.type !== "agent_end") return;
					Promise.resolve(globalThis[WATCH_KEY]?.hook?.settled?.(id)).catch(() => {});
				});
				w.subs.set(id, off);
				w.newEntries.add(id); // 刚进池 —— 等会儿对一次账
			} catch {
				/* 订阅不上就退回轮询 */
			}
		}
	};

	/** 对账刚进池的会话。为什么需要：触发那一刻池是空的话，我们一个 reload 都没做 → pi 的 per-cwd
	 *  扩展缓存没被清 → 之后新建的会话可能直接命中**旧模块**（它记录的 hash 跟磁盘不一样）。
	 *  只在「磁盘就在 applied 那一版」时对账（磁盘是脏的时候新会话本来就会拿到脏版本，不动它）。 */
	const reconcileNew = async (w) => {
		const ids = [...w.newEntries];
		w.newEntries.clear();
		if (!ids.length || !w.appliedHash) return 0;
		if (pluginFingerprint().hash !== w.appliedHash) return 0;
		let n = 0;
		for (const id of ids) {
			const e = ctx.pool.get(id);
			if (!e || e.pluginHashAtLoad === w.appliedHash) continue;
			if (isStreaming(e)) {
				w.pending.add(id);
				continue;
			}
			try {
				if (await reloadPlugin(e)) n++;
			} catch {
				/* 失败了不重试：下一次文件变化会统一重载 */
			}
		}
		if (n) log(`对账：给 ${n} 个刚建出来的会话补了重载（它们落到了旧模块缓存上）`);
		return n;
	};

	const settled = (id) => (watcher().pending.has(id) ? drainPending() : undefined);

	/** 一轮检查。快速路径（没变、也不欠账）几乎零成本。 */
	const tick = async () => {
		const w = watcher();
		if (w.busy) return; // 上一轮还没跑完（预检要几十 ms）
		w.busy = true;
		try {
			ensureSubs(w);
			await reconcileNew(w); // 刚进池的会话对一次账（怕它落到 pi 的旧模块缓存）
			await drainPending(); // 再看上一轮挂起的有没有结束的

			const fp = pluginFingerprint();
			if (fp.hash == null) return; // 文件没了 / 读不到：保持现状，什么都不做

			const same = w.mtimeMs === fp.mtimeMs && w.size === fp.size;
			const seeingDirty = w.dirtyHash === fp.hash;
			if (same && !seeingDirty) return; // 快速路径
			// 文件没变、但上一轮判过「还没提交」：提交可能刚发生（内容没变，git 状态变了）
			if (same && Date.now() - w.gitCheckedAt < GIT_RECHECK_MS) return;
			w.mtimeMs = fp.mtimeMs;
			w.size = fp.size;
			w.gitCheckedAt = Date.now();

			if (fp.hash === w.appliedHash || fp.hash === w.failedHash) {
				w.dirtyHash = null; // 这一版已经处理过（成功 / 失败）
				return;
			}
			if (!seeingDirty) {
				w.dirtyHash = fp.hash;
				w.stableSince = Date.now();
			}

			const committed = pluginCommitted();
			const stableEnough = committed == null && Date.now() - w.stableSince >= STABLE_MS;
			if (committed !== true && !stableEnough) {
				if (w.dirtyLoggedHash !== fp.hash) {
					w.dirtyLoggedHash = fp.hash;
					w.stats.skippedDirty++;
					log(
						`插件变了但${committed === false ? "**还没提交**（dirty / 未跟踪）" : "问不到 git（不是 repo？）"}→ 不动任何会话：${PLUGIN_FILE}`,
					);
				}
				return; // 半成品：不触发。等它变干净、或内容再变
			}
			if (committed == null) log(`问不到 git → 退化成「内容稳定 ${STABLE_MS}ms 没变」当写完处理`);
			await applyNewPlugin(w, fp);
		} catch (e) {
			log(`watch 这一轮出错了（A 本身没事，下一轮继续）：${String(e?.message ?? e)}`);
		} finally {
			w.busy = false;
		}
	};

	/** 观测：最近一次触发、这次重载了几个、还挂着几个。`GET /plugin-watch`（和 `/live`）就是它。
	 *  ⚠️ 没并进 `GET /host`：那个是宿主自己的**逃生门**（宿主拦住、逻辑层够不着），
	 *  而宿主不许改（改了要重启 A）—— 想并进 /host 得动 server/base.mjs，留待下次重启。 */
	const watchState = () => {
		const w = globalThis[WATCH_KEY];
		if (!w) return { enabled: false, reason: WATCH_OFF ? "SOPHO_PLUGIN_WATCH=0" : "还没起来" };
		return {
			enabled: !!w.timer,
			file: w.file,
			intervalMs: WATCH_MS,
			startedAt: w.createdAt,
			// 逻辑热重载把这套逻辑挂上来了几次（每次 /reload-code +1）；
			// **timersCreated 必须永远是 1** —— 涨了就是 watcher 被重复创建了。
			attaches: w.attaches,
			timersCreated: w.timersCreated,
			appliedHash: w.appliedHash,
			triggers: w.stats.triggers,
			lastTriggerAt: w.stats.lastTriggerAt,
			lastTriggerHash: w.stats.lastTriggerHash,
			lastReloaded: w.stats.lastReloaded,
			lastReloadedAt: w.stats.lastReloadedAt,
			totalReloaded: w.stats.totalReloads,
			skippedDirty: w.stats.skippedDirty,
			preflights: w.stats.preflights,
			failures: w.stats.failures,
			lastError: w.stats.lastError,
			lastErrorAt: w.stats.lastErrorAt,
			pending: w.pending.size,
			pendingIds: [...w.pending], // 完整 id（这是给人和工具读的接口，不是给人眼看的日志）
			// 见过但还没提交的那一版（有值 = watcher 正在等 git 变干净）
			uncommittedHash: w.dirtyHash,
		};
	};

	/** 把 watcher 挂到**当前这份逻辑**上；timer 只在真没有时建一个（规矩 4）。 */
	const bindWatcher = () => {
		const w = watcher();
		w.attaches++;
		w.hook = { tick, settled, state: watchState };
		if (!w.timer) {
			w.timersCreated++;
			w.timer = setInterval(() => globalThis[WATCH_KEY]?.hook?.tick?.(), WATCH_MS);
			w.timer.unref?.();
			log(`watcher 起好了（进程级单例，每 ${WATCH_MS}ms 看一眼）：${PLUGIN_FILE}`);
		} else {
			log(`watcher 已经在跑（第 ${w.attaches} 次挂载，timer 只有一个）→ 只把 hook 指向新逻辑`);
		}
	};

	if (WATCH_OFF) {
		log("SOPHO_PLUGIN_WATCH=0 → 不自动 reload 插件（GET /plugin-watch 只报 enabled:false）");
	} else {
		bindWatcher();
	}

	// ─────────────── 「它停下来了叫我」：登记表（进程级单例） + settle 上报 ───────────────
	// 分工（刻意切成这样）：
	//   · **事实**来自 runtime —— pi 的 `agent_settled` 就是「这一轮不会再自己跑下去了」
	//     （docs 原话）。插件只管把它 POST 上来：`POST /sessions/{自己 id}/settled`。
	//     零延迟 + 精确 → **不需要**「必须先看见 isStreaming=true」那种轮询防误报补丁。
	//   · **策略**全在本文件：要不要唤醒、唤醒谁、一次性、文案、超时兜底、边界丢弃。
	//     改文案/语义 = bin/reload-base.sh（零成本），不用重启 A、更不用动插件。
	//
	// ⚠️ **「落定」≠「停下来了」**（这条是踩出来的，别退回去）：一个多轮的孩子每跑完一轮
	//   都会 agent_settled 一次 —— 那是「这一轮不会再自己跑下去了」，不是「它干完了」。
	//   旧版拿落定直接唤醒父，于是：父在孩子**第一轮**结束时就被叫醒（那时它刚开始干活），
	//   而登记是一次性的（唤醒即删）→ 孩子**真干完时再也不会叫**。
	//   现在的判据：settled 上报只**记**（`rec.settledAt = now`），**不唤醒**；只有它
	//   落定后**持续静默 ≥ NOTIFY_IDLE_MS 秒**（可配）**且仍未 streaming**，才唤醒父。
	//   静默期内它又开跑了（again streaming）→ **撤销**这次待唤醒（它还在干活，不是停下来）。
	//
	// 登记表必须**活过 /reload-code**（规矩 4）：成员挂在 globalThis 的进程级单例上，
	// 每次热重载只把 hook 重指到当前这份逻辑（跟上面 plugin-watch 一个套路，timer 只建一个）。
	//
	// ⚠️ 约定：**`notify` 只有显式 `true` 才登记**（不是「没给就是 true」）。
	//   这条 HTTP 路由不是插件专用的 —— webui 发消息、`push` 回报都走它。若「缺省=登记」，
	//   用户在前端给某个子会话发一句话就会顺手登记一次唤醒；`push` 更糟：它把「父这一轮结束」
	//   登记给祖父，而父发完 push 几乎立刻结束 → 立刻反噬祖父。所以：
	//   **插件侧工具默认 true 并显式发上来**；其它调用方不发这个字段 = 不登记。

	const NOTIFY_KEY = "__sophoNotify";
	// v 没变：改的是**策略**（怎么判「停下来」），记录结构只是**加了字段** ——
	// 热重载时活着的登记表必须原样留住（旧记录没有 settledAt = 就当「还没落定」，行为不变）。
	const NOTIFY_V = 1;
	// 兜底：settled 上报**根本没来**（那才是「孩子崩了 / 它跑的是旧插件 / runtime 从没起过」）。
	// ⚠️ 它**不**管「上报来了但孩子在多轮之间」—— 那是 NOTIFY_IDLE_MS 的事。
	const NOTIFY_TIMEOUT_MS = Number(process.env.SOPHO_NOTIFY_TIMEOUT_MS ?? 5 * 60_000);
	// 落定后要**持续静默**多久才算「它停下来了」。20s：够跨过「多轮之间的换气」（孩子下一轮
	// 通常 1~2 秒内就开始），又不至于让父等太久。改这个 + bin/reload-base.sh 即可生效。
	const NOTIFY_IDLE_MS = Number(process.env.SOPHO_NOTIFY_IDLE_MS ?? 20_000);
	// 周期性扫（清理 + 超时兜底 + 待唤醒的兜底检查）。唤醒本身走「落定时起的那一发 one-shot」
	// （到点就是正好 IDLE_MS，不用等下一次扫）；这个周期只兜底：定时器万一丢了也照样唤醒。
	const NOTIFY_SWEEP_MS = Number(process.env.SOPHO_NOTIFY_SWEEP_MS ?? Math.max(1000, Math.round(NOTIFY_IDLE_MS / 4)));
	const nlog = (m) => console.log(`[notify] ${m}`);
	// ⚠️ 日志/提示词里的会话 id 一律用**完整 uuid** —— 这里原来有个 `idfrag`（只取前 12 位），删了。
	// 三条证据（人类要求「彻底去除派生短 id，全部改为原始 id」的直接起因）：
	//  · 界面上的「尾巴 8 位」永远解析不到：解析侧是**前缀**匹配（server/base.mjs 的 resolveId），
	//    人类把 `cea39876` / `1a729d02` / `238413e5` 拿去查 → 一律回「没有这个会话」。
	//  · 前缀本身也不唯一：实测两个会话前 8 位相同（`01a0a3cc-b030-…` 与 `01a0a3cc-d05a-…`）。
	//  · 所以**截短的 id 既不能拿去用、grep 也不唯一** —— 只有完整 id 两者都成立。
	// 为什么日志也照此办理（而不是「日志截短、接口给全」）：这些日志要给人**排障时定位**，
	// 而定位的动作就是 `grep <id>`（会话文件名里就是 uuid）—— 截短了 grep 会撞。
	// 量也不是问题：登记/标题/唤醒都是「每个子会话每轮几条」的量级，不是热路径。
	// 真要可读性就**加名字**（rec.label / nameOf），别截 id。

	const freshNotify = () => ({
		v: NOTIFY_V,
		createdAt: Date.now(),
		attaches: 0,
		timersCreated: 0, // 历史累计（sweep 周期变了会换掉旧的 → 可能 >1）；**同时活着的**永远只有 1 个（见 timerMs）
		timerMs: null, // 当前那个 sweep timer 的周期（改 IDLE/SWEEP 后 reload 会自动换掉不匹配的）
		timer: null,
		hook: null, // 每次挂载后指向**当前**这份逻辑（回调里现读，绝不闭包住）
		records: new Map(), // `${parentId}|${childId}` → rec
		stats: {
			registered: 0,
			refreshed: 0,
			reports: 0, // 收到的 settled 上报总数（含匹配不上的）
			unmatchedReports: 0, // 上报了但登记表里没有（没登记 / 已被唤醒过 / 是别人的孩子）
			woken: 0,
			wokenAfterIdle: 0, // 其中「落定后静默 IDLE_MS 才唤醒」的次数（正常那条路）
			cancelledPending: 0, // 静默期内它又开跑 → 撤销待唤醒（它还在干活）
			lastWokenAt: null,
			idleTimersCreated: 0, // 「到点检查」的 one-shot（每来一份 settled 上报建一发；到点/撤销即清）
			droppedParent: 0,
			droppedGone: 0,
			droppedArchived: 0,
			droppedDisposed: 0,
			timeouts: 0,
		},
	});
	/** 进程级单例（只建一次）；之后每次 /reload-code 只把 hook 重指到新逻辑、留住活的登记表 + timer。
	 *  ⚠️ 热重载可能**加了新字段**（stats / timerMs / 记录里的 settledAt 等）→ 老单例要补齐，
	 *  否则它带着旧结构跑（新统计永远 undefined、老记录 `settledCount++` 变 NaN）。 */
	const notifyReg = () => {
		const cur = globalThis[NOTIFY_KEY];
		if (cur && cur.v === NOTIFY_V) {
			const base = freshNotify();
			for (const k of Object.keys(base.stats)) {
				// NaN 是「老结构少了这个计数器 + 旧代码 undefined++」的痕迹 → 一并归零
				if (!(k in cur.stats) || Number.isNaN(cur.stats[k])) cur.stats[k] = base.stats[k];
			}
			for (const k of Object.keys(base)) if (!(k in cur)) cur[k] = base[k];
			return cur;
		}
		const base = freshNotify();
		const next = cur
			? { ...base, ...cur, v: NOTIFY_V, records: cur.records ?? new Map(), stats: { ...base.stats, ...(cur.stats ?? {}) } }
			: base;
		globalThis[NOTIFY_KEY] = next;
		return next;
	};
	const nkey = (parentId, childId) => `${parentId}|${childId}`;

	// ── 「停下来」的判据（唯一实现，扫和定时器都走这里） ───────────────────────
	const settlePending = (rec) => Number(rec.settledAt) > 0;
	/** 撤销待唤醒 + 清掉那发 one-shot。它又在跑 / 又派活了 / 登记被丢弃 → 都要走这里。 */
	const cancelPending = (rec, why) => {
		const n = notifyReg();
		if (rec.idleTimer) {
			clearTimeout(rec.idleTimer);
			rec.idleTimer = null;
		}
		if (!settlePending(rec)) return false;
		rec.settledAt = null;
		n.stats.cancelledPending++;
		nlog(`撤销待唤醒：子 #${rec.childId} ${why}（它还在干活 → 不算「停下来了」）`);
		return true;
	};
	/** 落定 → 记一笔 + 起一发 one-shot（到点正好是 IDLE_MS）。**不**在这里唤醒。 */
	const markSettledPending = (rec, key) => {
		const n = notifyReg();
		if (rec.idleTimer) clearTimeout(rec.idleTimer);
		rec.settledAt = Date.now();
		rec.settledCount = (rec.settledCount ?? 0) + 1; // 老记录（reload 之前登记的）没这个字段 → 从 0 算
		n.stats.idleTimersCreated++;
		rec.idleTimer = setTimeout(() => globalThis[NOTIFY_KEY]?.hook?.due?.(key), NOTIFY_IDLE_MS);
		rec.idleTimer.unref?.();
		nlog(
			`落定上报：子 #${rec.childId} 第 ${rec.settledCount} 发 → 先不唤醒，等静默 ${Math.round(NOTIFY_IDLE_MS / 1000)}s（这期间它再跑就撤销）`,
		);
	};
	/** 丢登记时的清场：把那发 one-shot 也收掉（不记「撤销」—— 这是丢登记，不是「它又开跑了」）。 */
	const clearIdleTimer = (rec) => {
		if (rec.idleTimer) {
			clearTimeout(rec.idleTimer);
			rec.idleTimer = null;
		}
		rec.settledAt = null;
	};
	/** 到点了（one-shot 或 sweep 兜底调的，拿 key 现读登记）：还静着 → 唤醒；又跑起来了 → 撤销。 */
	const dueCheck = async (key) => {
		const n = notifyReg();
		const rec = n.records.get(key);
		if (!rec || !settlePending(rec)) return { checked: false, reason: "没有待唤醒的登记" };
		const ce = ctx.pool.get(rec.childId);
		// 没 runtime（池里没了）≠ 在跑：settled 上报已经到过 = 它确实不在了。
		if (ce?.runtime.session.isStreaming) return { checked: true, cancelled: cancelPending(rec, "静默期内又开跑了") };
		const idleMs = Date.now() - rec.settledAt;
		if (idleMs < NOTIFY_IDLE_MS) return { checked: true, cancelled: false, waiting: true, idleMs };
		n.records.delete(key);
		if (rec.idleTimer) {
			clearTimeout(rec.idleTimer);
			rec.idleTimer = null;
		}
		n.stats.wokenAfterIdle++;
		const out = await wake(rec, "settled");
		return { checked: true, idleMs, ...out };
	};

	/** 登记「这个子会话**停下来**叫我」。同一对 (父,子) 重复派活 = **刷新同一条**（绝不重复登记）。 */
	const registerNotify = ({ parentId, childId, reason, label }) => {
		if (!childId || !parentId || childId === parentId) return null;
		const n = notifyReg();
		const key = nkey(parentId, childId);
		const cur = n.records.get(key);
		if (cur) {
			// 又派活了（父再发一条 / spawn 复用）→ 旧的「待唤醒」作废：那是上一轮的落定。
			cancelPending(cur, "又派活了（旧落定作废）");
			cur.at = Date.now();
			cur.lastRunningSeenAt = null; // 新一轮的计时从现在算
			cur.reason = reason ?? cur.reason;
			if (label) cur.label = label;
			n.stats.refreshed++;
			return { parentId, childId, refreshed: true, at: cur.at };
		}
		const rec = {
			parentId,
			childId,
			at: Date.now(),
			reason: reason ?? null,
			label: label ?? null,
			seenHot: false, // 登记后有没有见过它热着（判「被池回收」用）
			lastRunningSeenAt: null, // 最近一次看见它 isStreaming（超时计时用，防长回合误报）
			settledAt: null, // **最近一次**收到 settled 上报的时刻（>0 = 有一发待唤醒在等静默窗口）
			settledCount: 0, // 一共收到几发 settled（多轮的孩子会 >1；观测用）
			idleTimer: null, // 到点检查的 one-shot（回调里现读 hook，绝不闭包住这份逻辑）
		};
		n.records.set(key, rec);
		n.stats.registered++;
		nlog(`登记：子 #${childId} → 父 #${parentId}（${reason ?? "?"}${label ? `「${label}」` : ""}）`);
		return { parentId, childId, refreshed: false, at: rec.at };
	};

	/** 这条消息该唤醒谁：优先 body 里显式给的 `notifyTo`，没有就退回**这个会话文件头里的 parentSession**。 */
	const notifierOf = (entry, explicit) => {
		if (explicit) return ctx.resolveId(String(explicit));
		try {
			const h = ctx.headerOf(entry.file) ?? {};
			return h.parentSession ? ctx.idOf(h.parentSession) : null;
		} catch {
			return null;
		}
	};

	/** 唤醒父：走本层那条发消息的路（`deliver`）—— 父在跑时自动 steer，与 push 完全同一语义。 */
	const wake = async (rec, kind) => {
		const n = notifyReg();
		const pid = rec.parentId;
		if (!ctx.fileOf(pid)) {
			n.stats.droppedParent++;
			nlog(`父 #${pid} 已不存在 → 丢弃登记（子 #${rec.childId}）`);
			return { woken: false, dropped: "parent-gone" };
		}
		let pe;
		try {
			pe = await ensure(pid); // 冷会话会被拉起来（和 push/send 唤醒同一条路）
		} catch (e) {
			n.stats.droppedParent++;
			nlog(`父 #${pid} 拉不起来（${String(e?.message ?? e)}）→ 丢弃登记`);
			return { woken: false, dropped: "parent-ensure-failed" };
		}
		const cf = ctx.fileOf(rec.childId);
		const name = rec.label ?? (cf ? nameOf(cf) : null);
		// ⚠️ 这句是**发给父会话的提示词**（模型读它，人也会在界面上看到）——里面那句「去 session_read 它」
		// 就是**照着这个 id 去用**，所以必须是**完整 uuid**（原来给的是前 12 位：模型直接拿它去
		// session_read 会解析不到唯一那个，人类照着抄也一样）。别在这里缩。
		const who = `#${rec.childId}${name ? `「${name}」` : ""}`;
		const text =
			kind === "settled"
				? `【子会话】${who} **停下来了**（落定后静默 ${Math.round(NOTIFY_IDLE_MS / 1000)} 秒没再动）—— 去 session_read 它（它可能没 push 回报）。`
				: `【子会话】${who} 登记后 ${Math.round(NOTIFY_TIMEOUT_MS / 60000)} 分钟了**一次 settled 上报都没来过**（可能：它没动 / 崩了 / 它跑的是旧插件没这个上报）—— 去 session_read 它看看。`;
		const pr = await deliver(pe, text); // 不 await 整轮（跟 /message 路由一样）
		n.stats.woken++;
		n.stats.lastWokenAt = Date.now();
		// 父当时在跑 → 走的是 steer（插到当前这轮里），否则就是新起一轮 —— 现有语义，没有新路径。
		const how = pr?.streaming ? `steer（父正在跑）` : "新起一轮（父空闲）";
		const why = kind === "settled" ? `它停下来了（静默 ≥${Math.round(NOTIFY_IDLE_MS / 1000)}s）` : "settled 上报从来没来过（超时兜底）";
		nlog(`唤醒父 #${pid}（${why}，${how}）：子 ${who}`);
		return { woken: true, text, parentStreaming: !!pr?.streaming, behavior: pr?.behavior ?? null };
	};

	/** 插件上报的事实：`rawId` 这个会话落定了（agent_settled）。
	 *  ⚠️ **这里不唤醒**：落定只是「这一轮不会再自己跑下去了」，多轮的孩子每轮都会上报一次。
	 *  匹配上的登记 → 记下「它落定了」+ 起一发静默计时；真的停下来由 dueCheck 判。 */
	const onSettledReport = async (rawId) => {
		const n = notifyReg();
		const id = ctx.resolveId(String(rawId ?? ""));
		n.stats.reports++;
		if (!id || !ctx.fileOf(id)) {
			nlog(`收到 settled 上报但会话不存在：${rawId}`);
			return { matched: 0 };
		}
		recordSettled(id); // 「它落定了」—— 未读判据的一半，就在这条路上接（不另造信号）
		const hits = [...n.records].filter(([, r]) => r.childId === id);
		if (!hits.length) {
			n.stats.unmatchedReports++;
			return { matched: 0 }; // 常见：这个会话没人登记（父没派活 / 已唤醒过 / 是别人的孩子）
		}
		for (const [key, rec] of hits) markSettledPending(rec, key);
		return { matched: hits.length, woken: 0, pending: hits.length }; // 唤醒交给 dueCheck（静默 IDLE_MS 后）
	};

	/** 一轮扫（每 NOTIFY_SWEEP_MS）：清理 + 待唤醒兜底 + 超时兜底。
	 *  「停下来」的判定**不在这里** —— 正常那条路是：settled 上报 → 记下 + 起一发静默 IDLE_MS
	 *   的 one-shot → 到点 dueCheck（见上）。这里只是兜底：定时器万一丢了，照样会唤醒。
	 *  超时兜底防的是另一件事：**settled 上报从来没来过**（孩子崩了 / 它跑的是旧插件（没这个上报）/ 根本没起过 runtime）。 */
	const sweepNotify = async () => {
		const n = notifyReg();
		const now = Date.now();
		const arch = readArchive();
		for (const [key, rec] of [...n.records]) {
			// 父没了 → 丢弃（别悬着）
			if (!ctx.fileOf(rec.parentId)) {
				clearIdleTimer(rec);
				n.records.delete(key);
				n.stats.droppedParent++;
				nlog(`父 #${rec.parentId} 没了 → 丢弃登记（子 #${rec.childId}）`);
				continue;
			}
			// 子会话文件没了 → 丢弃
			if (!ctx.fileOf(rec.childId)) {
				clearIdleTimer(rec);
				n.records.delete(key);
				n.stats.droppedGone++;
				nlog(`子 #${rec.childId} 会话文件没了 → 丢弃登记`);
				continue;
			}
			// 子会话已归档 → 丢弃（归档 = 父自己收的尾，它已经知道了）
			if (arch[rec.childId]) {
				clearIdleTimer(rec);
				n.records.delete(key);
				n.stats.droppedArchived++;
				nlog(`子 #${rec.childId} 已归档 → 丢弃登记`);
				continue;
			}
			const ce = ctx.pool.get(rec.childId);
			if (ce) rec.seenHot = true;
			if (ce?.runtime.session.isStreaming) {
				rec.lastRunningSeenAt = now; // 正在跑 → 超时计时往后挪（长回合绝不误报「没动」）
				// 静默期内它又开跑了 → **撤销**这发待唤醒（它还在干活，不是停下来了）。
				cancelPending(rec, "又开跑了（扫到 streaming）");
				continue;
			}
			// 有一发待唤醒 → 它的命运**只**由「静默 ≥ IDLE_MS 且没在跑」定：
			// 到点了但 one-shot 丢/还没到 → 这里补一发 dueCheck（幂等：到点且静着才唤醒）。
			// ⚠️ 这一段要在「池回收 → 丢弃」**之前**：孩子干完立刻被回收时，别把它当成「上报没来」。
			if (settlePending(rec)) {
				if (now - rec.settledAt < NOTIFY_IDLE_MS) continue;
				await dueCheck(key);
				continue;
			}
			if (!ce && rec.seenHot) {
				// 登记后热过、现在池里没了 = 被 LRU 回收了，而**一次 settled 上报都没来**。
				// 池回收后已**没得读**（文件还在但 runtime 没了）→ 丢弃 + 记日志，不悬着。
				n.records.delete(key);
				n.stats.droppedDisposed++;
				nlog(`子 #${rec.childId} 已被池回收（settle 上报没来）→ 丢弃登记`);
				continue;
			}
			if (now - (rec.lastRunningSeenAt ?? rec.at) < NOTIFY_TIMEOUT_MS) continue;
			n.records.delete(key);
			n.stats.timeouts++;
			await wake(rec, "timeout");
		}
	};

	/** 观测：`GET /registrations`（和 `/live` 里那份）。验证 / 将来「树上待验收标记」都用它。 */
	const notifyState = () => {
		const n = globalThis[NOTIFY_KEY];
		if (!n) return { enabled: false, reason: "还没起来" };
		const now = Date.now();
		return {
			enabled: !!n.timer,
			sweepMs: n.timerMs ?? NOTIFY_SWEEP_MS, // 实际跑着的那个 timer 的周期
			idleMs: NOTIFY_IDLE_MS, // 落定后要静默多久才算「停下来了」
			timeoutMs: NOTIFY_TIMEOUT_MS,
			source: "插件上报 POST /sessions/{id}/settled（pi 的 agent_settled）→ 静默 idleMs 且仍未 streaming 才唤醒",
			startedAt: n.createdAt,
			attaches: n.attaches, // 逻辑热重载把 hook 挂上来的次数（每次 /reload-code +1）
			timersCreated: n.timersCreated, // 历史累计（周期变了会换掉旧的）；**同时活着的**永远只有 1 个
			count: n.records.size,
			records: [...n.records.values()].map((r) => ({
				parentId: r.parentId,
				parent: r.parentId, // 以前是前 12 位（idfrag）；现在跟 parentId 一样 = 完整 id。
				// 留着这个字段只为不弄坏已经写好的 curl / 脚本，真想清理就把它删了（跟 parentId 重复）。
				childId: r.childId,
				child: r.childId, // 同上：原来是前 12 位，现在是完整 id
				at: r.at,
				ageMs: now - r.at,
				reason: r.reason,
				label: r.label,
				seenHot: !!r.seenHot,
				lastRunningSeenAt: r.lastRunningSeenAt ?? null,
				settledCount: r.settledCount ?? 0, // 收到过几发 settled 上报
				settledAt: r.settledAt ?? null, // 最近一发的时刻（>0 = 有一发在等静默窗口）
				settledIdleMs: r.settledAt ? now - r.settledAt : null,
				pendingWake: settlePending(r), // 有一发待唤醒在等静默窗口
				hot: ctx.pool.has(r.childId),
				streaming: ctx.pool.get(r.childId)?.runtime.session.isStreaming ?? null,
			})),
			stats: { ...n.stats },
		};
	};

	/** 把登记表挂到**当前这份逻辑**上；timer 只在真没有时建一个（规矩 4）。 */
	const bindNotify = () => {
		const n = notifyReg();
		n.attaches++;
		// `due` = 落定后静默到点的那一发检查（one-shot 回调通过它现读当前逻辑，不闭包住旧版本）。
		n.hook = { sweep: sweepNotify, state: notifyState, due: dueCheck };
		// 周期变了（改了 SOPHO_NOTIFY_IDLE_MS/SWEEP_MS 再 reload）→ 换掉旧 timer。
		// 先 clear 再 set、同步做完 → **任何时刻活着的 sweep timer 都只有 1 个**。
		if (n.timer && n.timerMs !== NOTIFY_SWEEP_MS) {
			clearInterval(n.timer);
			n.timer = null;
			nlog(`sweep 周期 ${n.timerMs}ms → ${NOTIFY_SWEEP_MS}ms（换掉旧 timer，同时活着的永远 1 个）`);
		}
		if (!n.timer) {
			n.timersCreated++;
			n.timerMs = NOTIFY_SWEEP_MS;
			n.timer = setInterval(() => globalThis[NOTIFY_KEY]?.hook?.sweep?.(), NOTIFY_SWEEP_MS);
			n.timer.unref?.();
			nlog(
				`登记表起来了（进程级单例，每 ${NOTIFY_SWEEP_MS}ms 扫清理/超时兜底；唤醒走 settled 上报 → 落定后静默 ${Math.round(NOTIFY_IDLE_MS / 1000)}s 仍未 streaming）`,
			);
		} else {
			nlog(`登记表已经在跑（第 ${n.attaches} 次挂载，timer 只有一个）→ 只把 hook 指向新逻辑`);
		}
	};
	bindNotify();

	// ─────────────────────── 存档（sidecar，不碰 pi 的会话文件） ───────────────────────
	// 「存档」是个义务，不是能从会话文件推导出来的事实，所以单独落一个 archive.json。

	const ARCHIVE = path.join(ctx.HOME, "archive.json");
	const readArchive = () => {
		try {
			return JSON.parse(fs.readFileSync(ARCHIVE, "utf8"));
		} catch {
			return {};
		}
	};
	const setArchived = (id, on) => {
		const a = readArchive();
		if (on) a[id] = Date.now();
		else delete a[id];
		fs.mkdirSync(ctx.HOME, { recursive: true });
		fs.writeFileSync(ARCHIVE, JSON.stringify(a, null, 1));
		return on;
	};

	// ─────────────────────── 「未读」：我上次看过之后，它又落定了 ───────────────────────
	// 两个信号**刻意分开**（别混成一个点）：
	//   · 在跑（`streaming`，青绿脉冲）= 它正在工作
	//   · 未读（`unread`，实心红点）  = **它落定了，而我之后没看过**
	// 两者可以同时成立（在跑且我没看）—— 前端的颜色/形状都不撞（见 web/app.css 的 .sess .u）。
	//
	// 「有更新」以**回合落定**为准，不用文件 mtime（会被非内容写入扰动）、
	// 也不用「消息数变了」（流式时每写一条都在变 → 会抖）。落定这件事今天刚做好：
	// 插件 `agent_settled` → `POST /sessions/{id}/settled` —— 就在**那条路上**顺手记一笔
	//（见 onSettledReport 里的 recordSettled），不另造信号。
	//
	// 「我看过」由**前端**告诉服务端：打开某个会话、且视口跟着底部 → `POST /sessions/{id}/seen`。
	// ⚠️ 状态**存服务端**、不存 localStorage —— 用户会换设备/换浏览器（局域网 / 手机），
	// localStorage 一换就全忘。两个 sidecar 和 archive.json 一个路子（义务存储，推导不出来）：
	//   `$ASSIST_HOME/settled.json` —— 事实：这个会话上次落定是什么时候（插件上报驱动）
	//   `$ASSIST_HOME/seen.json`    —— 我的注视：我上次看它是什么时候（前端上报驱动）
	// 判据：`未读 = 最后一次落定时间 > 我最后一次 seen 时间`。
	//
	// 刻意**不做**的两件：
	//   · **不做父节点聚合** —— 树里能折叠的只有归档的，而归档不算未读，聚合没东西可合。
	//   · **不做自动已读**（「打开网站就全标已读」等于没有）。
	const SEEN = path.join(ctx.HOME, "seen.json");
	const SETTLED = path.join(ctx.HOME, "settled.json");
	const readSidecar = (file) => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return {};
		}
	};
	const writeSidecar = (file, id, at) => {
		const m = readSidecar(file);
		m[id] = at;
		fs.mkdirSync(ctx.HOME, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(m, null, 1));
		return at;
	};
	/** sidecar 里的值必须是**毫秒时间戳**。脏值（手写/探针写进去的 `1` / `true` / 字符串）**当「没有」**。
	 *  为什么要卡：`Number(1) || 0` = 1 也是 truthy → `unread = 1 > seenAt(=0)` = true，
	 *  一个**从没跑过**的会话会永远亮红点；而且它是最小值 → 还会抢走树顶「跳到最旧未读」的目标。
	 *  1e12 ≈ 2001-09-09：本机时间不可能更早，比它小的都不是时间戳。 */
	const stampOf = (v) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 1e12 ? n : 0;
	};
	/** 插件上报的「这一轮落定了」→ 记一笔。**每条上报都记**（与唤醒的登记表无关）：
	 *  未读是给**人**看的信号，不只在「被派活的孩子」身上成立。 */
	const recordSettled = (id) => writeSidecar(SETTLED, id, Date.now());
	/** 前端说「我看过了」→ 记一笔。时间取**服务端**的 now：手机时钟不准 / 可造假，接客户端时间戳判据就废了。 */
	const recordSeen = (id) => writeSidecar(SEEN, id, Date.now());

	// ─────────────────────── 归档快照（pi 原生 HTML 导出） ───────────────────────
	// 归档成功后在 $ASSIST_HOME/exports/<id>.html 落一份 **pi 自己渲染的** HTML 快照
	// （用 pi 的 `exportFromFile(会话文件, {outputPath})`；不自己写渲染器）。
	//
	// ⚠️ **快照不是「终局」，只是「最近一次归档时的样子」。** 归档是可逆的（发消息即复活），
	// 所以：复活（unarchive / 发消息）后再归档 → **重新导**；会话文件 mtime 比快照新
	//（归档后又写过东西）→ 该快照算过期，GET 时现导。
	//
	// 为什么能对冷会话 / 归档会话用：`exportFromFile` 是**独立**入口，只读会话文件、
	// 不需要 AgentState（另一个 `exportSessionToHtml(sm, state)` 是给活会话的，TUI 的 /export 用它）。
	const EXPORTS = path.join(ctx.HOME, "exports");
	const snapshotOf = (id) => path.join(EXPORTS, `${id}.html`);

	/** pi 的导出器在哪：**包根没公开导出它**（package.json 的 exports 只有 "."），
	 *  所以解析到包根后用**绝对路径** import（绝对路径不受 exports 映射限制）。 */
	const exporterFile = () => {
		const rel = "node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js";
		try {
			// import.meta.resolve 走 "import" 条件 → dist/index.js → 再上一层就是包根
			const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
			const f = path.join(path.dirname(path.dirname(fileURLToPath(entry))), "dist/core/export-html/index.js");
			if (fs.existsSync(f)) return f;
		} catch {
			/* 落到下面兜底 */
		}
		// 兜底：从本文件往上找 node_modules（同一个依赖，只是不依赖 resolve 的行为）
		for (let d = path.dirname(fileURLToPath(import.meta.url)); ; d = path.dirname(d)) {
			const f = path.join(d, rel);
			if (fs.existsSync(f)) return f;
			if (path.dirname(d) === d) throw new Error("找不到 pi 的 dist/core/export-html 模块");
		}
	};

	// 导出器模块很大（HTML 模板全在里面），只在真的要用时才 import 一次。
	let exporter = null;
	const loadExporter = async () => {
		if (!exporter) exporter = await import(pathToFileURL(exporterFile()).href);
		return exporter;
	};

	/** 同一个 id 的导出**串行化**：并发的 archive / GET 不会互相踩同一个输出文件。 */
	const exporting = new Map();
	const exportSnapshot = (id) => {
		const inflight = exporting.get(id);
		if (inflight) return inflight;
		const p = (async () => {
			const file = ctx.fileOf(id);
			if (!file) throw new Error(`没有这个会话：${id}`);
			fs.mkdirSync(EXPORTS, { recursive: true });
			const out = snapshotOf(id);
			// 先写临时文件、再 rename：GET 绝不会读到写了一半的 HTML。
			const tmp = `${out}.tmp-${process.pid}`;
			try {
				const { exportFromFile } = await loadExporter();
				await exportFromFile(file, { outputPath: tmp });
				fs.renameSync(tmp, out);
			} catch (err) {
				try {
					fs.rmSync(tmp, { force: true }); // 失败的半成品不留：否则 exports 里堆垃圾
				} catch {
					/* 清不掉就算了，别盖住真正的错 */
				}
				throw err;
			}
			return out;
		})().finally(() => exporting.delete(id));
		exporting.set(id, p);
		return p;
	};

	/** 快照过期吗？不存在 → 过期；会话文件比快照新（归档后又被写过）→ 过期。 */
	const snapshotStale = (id, file) => {
		let snap;
		try {
			snap = fs.statSync(snapshotOf(id));
		} catch {
			return true;
		}
		try {
			return fs.statSync(file).mtimeMs > snap.mtimeMs;
		} catch {
			return false; // 会话文件都读不到了：宁可给旧的，也别白导一次
		}
	};

	// ─────────────────────── 读会话文件 ───────────────────────

	/** 会话名（pi 的 session_info，**最后一条赢**）。
	 *
	 *  ⚠️ **不能只读文件头** —— 实测 238 个真实会话里 session_info **一次都不在第一行**
	 *  （第 0 行 0 个；第 3 行 167 个，其余散布到第 6~386 行）。只读头会**丢名字**。
	 *
	 *  快在哪：pi 的会话文件是**只追加**的，改名字 = **再追加一条** session_info。所以“名字有没有变”
	 *  只需要看**新增的那段字节**里有没有 session_info —— 热会话（正在跑、一直在追加）原来每次都把
	 *  整份读完（实测 14.4 MB 会话一下 ~19 ms，3 个热会话 /tree 就从 30 ms 涨到 56 ms），
	 *  现在只读上次之后新写的那点尾巴。语义与“整份扫一遍取最后一条”**逐字段等价**。
	 *
	 *  三道守卫把“不是追加”的情况全打回全量扫：**变小**（截断）/ **大小没变但 mtime 变了**
	 *  （原地重写）/ 尾巴读不动。剩下唯一依赖的前提是「文件只往后长」 —— 这条本来就是 pi 的设计
	 *  （见 readMessages 那段注释：旧消息一条都没删，压缩也只是再追加一条）。 */
	const nameCache = new Map(); // file -> { size, mtimeMs, name, eof }；eof = 已经扫过的字节数（对齐到换行）

	/** 从一段 Buffer 里逐行找 `session_info`。返回 { name, consumed }。
	 *  · **最后一条赢**（与旧实现同）。
	 *  · `consumed` 只算到**最后一个换行**为止 —— 末尾那段没有换行的（写者正写到一半、或者
	 *    文件就是没写结尾换行）也按一行处理（旧实现 `split("\n")` 就是这么干的，要保持一致），
	 *    但**不**把它算进 consumed：下次从 eof 重读，那一行被补完之后能被正确解析。 */
	const scanNameInBuf = (buf, prev) => {
		let name = prev;
		let off = 0;
		const eat = (line) => {
			if (!line.includes('"session_info"')) return;
			try {
				const r = JSON.parse(line);
				if (r.type === "session_info" && r.name) name = r.name;
			} catch {
				/* 坏行跳过（与旧实现一致） */
			}
		};
		for (;;) {
			const nl = buf.indexOf(10, off);
			if (nl < 0) break;
			eat(buf.toString("utf8", off, nl));
			off = nl + 1;
		}
		if (off < buf.length) eat(buf.toString("utf8", off));
		return { name, consumed: off };
	};

	const nameOf = (file) => {
		let st;
		try {
			st = fs.statSync(file);
		} catch {
			return null;
		}
		const hit = nameCache.get(file);
		if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.name;

		// 只读尾巴：上一次已经扫到 eof，而且这次只是**变长**了（追加）。
		// 大小没变（原地重写）/ 变小（截断）/ 首见 都不走这条路 → 下面全量扫。
		if (hit && hit.eof > 0 && st.size > hit.size && hit.eof <= hit.size) {
			let tail = null;
			try {
				const fd = fs.openSync(file, "r");
				try {
					const len = st.size - hit.eof;
					const buf = Buffer.allocUnsafe(len);
					const n = fs.readSync(fd, buf, 0, len, hit.eof);
					tail = buf.subarray(0, n); // 短读也没关系：没读到的下次会重读
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				tail = null; // 读不动 → 落回全量那条路
			}
			if (tail) {
				const r = scanNameInBuf(tail, hit.name);
				nameCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, name: r.name, eof: hit.eof + r.consumed });
				return r.name;
			}
		}

		// 全量扫（首见 / 截断 / 原地重写 / 尾巴读不动）
		let name = null;
		let eof = 0;
		try {
			const buf = fs.readFileSync(file);
			const r = scanNameInBuf(buf, null);
			name = r.name;
			eof = r.consumed;
		} catch {
			/* 读不到就没名字（与旧实现一致） */
		}
		nameCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, name, eof });
		return name;
	};

	/** 会话正文：assistant 按原顺序保留 thinking / text / toolCall（工具名+参数+结果），
	 *  这样前端能还原成接近终端的样子，而不是只剩一段文本。 */
	const readMessages = (file) => {
		const out = [];
		const extras = []; // 扩展消息（pi 的 `custom_message`）—— **不进 messages**，理由见下面 handling 那句
		const ids = new Map(); // 条目 id → 它在 out 里的下标（压缩边界要用 firstKeptEntryId 反查）
		const pending = new Map(); // toolCallId -> part（等它自己的 toolResult；配到就 delete）
		const noId = []; // 没有 id 的 toolCall —— 永远配不到 result，也属「未完成」
		let other = 0;
		let cut = null; // 最近一次压缩边界
		let raw;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			return { messages: [], hiddenRecords: 0, compaction: null, unfinished: [], extras: [] };
		}
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let r;
			try {
				r = JSON.parse(t);
			} catch {
				continue;
			}
			// 压缩条目：**文件里的旧消息一条都没删**（pi 只追加一条 compaction 条目，
			// 里面记着 firstKeptEntryId = “从这一条起才还在模型上下文里”）。
			// 所以「正文列表」≠「模型现在的上下文」—— 得把边界告诉前端，否则压完屏幕上
			// 还是那些早就丢掉的老消息，看不出来发生了什么。
			// 多次压缩只报**最后一个**边界（更早的边界连同它的区间已被后面的压缩吞进去了）。
			if (r.type === "compaction") {
				cut = {
					firstKeptEntryId: r.firstKeptEntryId ?? null,
					atIndex: ids.has(r.firstKeptEntryId) ? ids.get(r.firstKeptEntryId) : out.length,
					tokensBefore: r.tokensBefore ?? null,
					summary: typeof r.summary === "string" ? r.summary : "",
					at: r.timestamp ?? null,
				};
				other++;
				continue;
			}
			if (r.type === "custom_message") {
				// ── 扩展消息（扩展用 `pi.sendMessage` 写下的东西）──
				// 今天它们对网页是**静默消失**的：这个函数只认 user/assistant/toolResult，
				// `custom_message` 全部记进 `hiddenRecords`。修法是把它当作一条**独立产出**返回（`extras`）。
				// ⚠️ **绝不塞进 `messages`**：`compaction.atIndex`、前端 `histSig` / 窗口计数全都建在
				// `messages` 的**下标**上；`hiddenRecords` 存在的意义正是“这些条目不进数组、不影响下标”。
				// 与其去证明“塞进去之后 atIndex 还指向同一条”，不如不让它进来。
				// `display:false` = 扩展自己说“别给人看” → 照旧丢掉（也不进 extras）。
				if (r.display === false) {
					other++;
					continue;
				}
				const c = r.content;
				const text =
					typeof c === "string"
						? c
						: Array.isArray(c)
							? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
							: "";
				if (String(text).trim()) {
					extras.push({ id: r.id ?? null, customType: r.customType ?? null, text: String(text).trim(), at: r.timestamp ?? null });
				} else other++;
				continue;
			}
			if (r.type !== "message") {
				other++;
				continue;
			}
			const m = r.message;
			if (m?.role === "toolResult") {
				// 工具结果：挂回它那次调用
				const part = pending.get(m.toolCallId);
				if (part) {
					part.result = (m.content ?? []).map((c) => c.text ?? "").join("\n").trim();
					part.isError = !!m.isError;
					pending.delete(m.toolCallId); // 配到了 → 不再是「未完成」
				} else other++;
				continue;
			}
			const role = m?.role;
			if (role === "user") {
				const text = (m.content ?? [])
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("\n")
					.trim();
				if (text) {
					if (r.id) ids.set(r.id, out.length);
					out.push({ role, text });
				} else other++;
				continue;
			}
			if (role !== "assistant") {
				other++;
				continue;
			}
			const parts = [];
			for (const p of m.content ?? []) {
				if (p.type === "text" && p.text?.trim()) parts.push({ type: "text", text: p.text });
				else if (p.type === "thinking" && p.thinking?.trim()) parts.push({ type: "thinking", text: p.thinking });
				else if (p.type === "toolCall") {
					const part = { type: "tool", name: p.name, args: p.arguments ?? {} };
					parts.push(part);
					if (p.id) pending.set(p.id, part);
					else noId.push(part); // 没 id ⇒ 配不到任何 result（见上）
				}
			}
			// `stopReason: "aborted"` = 这一轮被**中断**了（用户点停止 / TUI Esc / 压缩前那次 abort）。
			// **必须如实传下去**：否则被中断的那一轮看起来就是一条普通的（被截断的）回复 —— 骗人。
			// 而且**哪怕一个 part 都没有**也要保留：用户发了消息、模型还没吐字就被掐了，
			// 屏幕上就更该有一句「这一轮被中断了」，而不是「什么都没发生」（那种沉默正是事故现场的样子）。
			const aborted = m.stopReason === "aborted";
			if (parts.length || aborted) {
				if (r.id) ids.set(r.id, out.length);
				out.push(aborted ? { role, parts, aborted: true } : { role, parts });
			} else other++;
		}
		// `unfinished` = **落盘了 toolCall、却没配到 toolResult** 的那些分片。
		// 「还没配到 result」这个状态在 wire 上原来根本表达不出来 ⇒ 前端只能当「done」（绿）。
		// 扫完之后还留在 pending / noId 里的就是它们（配到的已经从 pending 里 delete 了）。
		return { messages: out, hiddenRecords: other, compaction: cut, unfinished: [...pending.values(), ...noId], extras };
	};

	/** 把「未完成」的分片按**会话当前的运行状态**如实标出来 —— 判据只能在服务端：
	 *  · 正在流式、且属于当前这条（未被中断的）助手消息 ⇒ 这些工具**确实还在跑** ⇒ `running: true`；
	 *  · 否则（不在流式 / 属于更早的消息 / 那条被中断了）⇒ 它们**不是**「在跑」，也**不是**
	 *    「成功」——今天却渲染成绿色，同样是骗人 ⇒ `interrupted: true`（前端有独立的第四态）。
	 *  （更紧的 running 判据见下面函数体里的注释 —— “只看在不在流式”会误报上一轮遗留的分片。）
	 *  ⚠️ 这个标记**不进 LRU 缓存**：缓存只按文件 (size,mtime) 失效，而这个状态来自 runtime。
	 *     所以每次请求都按「当下」的 streaming 现算 —— 「文件没变但已经不在流式了」（中断、
	 *     结果丢了）也判得对。只在真有 unfinished 时才复制那几个分片，其余原样复用缓存对象。 */
	const markUnfinished = (data, streaming) => {
		const list = data.unfinished ?? [];
		if (!list.length) return data;
		const pendingSet = new Set(list);
		// 「在跑」的**诚实**判据（比“只要在流式就算”更紧）：
		//   ① 会话正在流式；
		//   ② 这个未完成分片属于**最后一条助手消息**；且
		//   ③ 那条助手消息**不是 aborted**（被中断的那一轮永远不会再来工具结果）。
		// 为什么不能只看①：一个**上一轮被中断**、工具结果没落盘的分片会一直留在文件里；
		// 后来用户又发一条、新一轮开始流式时，只看①就会把那个**早就死了**的分片标成 running
		// —— 又是一次骗人。②把“更早消息里的未完成分片”判成 interrupted；
		// ③把“最后一条就是中断那条”也判成 interrupted。
		// （注意是**最后一条助手消息**，不是最后一条消息：流式中用户插话会往文件里追加 user
		//   消息，那会让“最后一条”变成 user —— 那时工具明明还在跑。）
		let lastAsst = null;
		for (const m of data.messages) if (m.role === "assistant" && Array.isArray(m.parts)) lastAsst = m;
		const runningSet = new Set();
		if (streaming && lastAsst && !lastAsst.aborted) for (const p of lastAsst.parts) if (pendingSet.has(p)) runningSet.add(p);
		const swapped = new Map(list.map((p) => [p, { ...p, [runningSet.has(p) ? "running" : "interrupted"]: true }]));
		const messages = data.messages.map((m) => {
			const parts = m.parts;
			if (!parts || !parts.some((p) => swapped.has(p))) return m;
			return { ...m, parts: parts.map((p) => swapped.get(p) ?? p) };
		});
		return { ...data, messages };
	};

	// ── `/messages` 结果的 LRU 缓存（本次性能改动的 ②）────────────────────────
	//
	// **为什么**：`readMessages` 每次都 `readFileSync` 整份 jsonl + 逐行 `JSON.parse`（上面那个函数
	// **完全无缓存**）。而它被调的场合远不止“切会话”：会话级 SSE 的 `hello`/`run end`/`compact end`、
	// 以及 `visibilitychange` 都会再打一发全量 —— 同一份没变的文件被反复重读重解。
	// 实测（identity、不压缩、局域网另一台机器上的 A）：4.5 MB 会话 Linux 23.3 ms / Windows 39.6 ms；
	// 27.8 MB 会话 Linux 49.2 ms / Windows **139.1 ms**（每次都重来一遍）。
	//
	// **为什么会是对的**：失效判据是 `(size, mtimeMs)` 两个一起比 ——
	//   · pi 只**追加**：追加必然改 size（也改 mtime），所以永远不会拿旧内容糊人；
	//   · 压缩/截断/重写：size 也变；
	//   · 只比 mtime 不够（Windows 上同毫秒内可能连改两次），所以加上 size。
	//
	// **代价与上限**：只缓存**最近** `MSG_CACHE_MAX` 个会话的形状（默认 **4**，`SOPHO_MSG_CACHE` 可改；
	// 设 0 = 等于关掉缓存）。默认给 4 而不是 8：命中场景其实很窄 —— 你自己在两个标签页里
	// A/B 来回切、或 SSE（run end / compact end）重拉“当前这个会话”，都在最近几个里。
	// 实测（238 会话的副本里最大那一份：identity 8.3 MB）解析后**常驻 13.2 MB**（约 1.6 × JSON 字节），
	// 所以上界 ≈ 4 × 1.6 × 最大单会话 payload ≈ **53 MB**（实测机上数据上界约 15 MB）；
	// 超过就淘汰**最久没被用到**的那条（Map 的插入序就是 LRU 序）。想要更激进的命中率就
	// `SOPHO_MSG_CACHE=8`，代价是上界翻倍。
	//
	// ⚠️ 返回的 `messages`/`compaction` 是**共享的**（同一个对象 id 交给多个请求）。
	//    调用方只拿去序列化，**不许改它** —— 要改请先自己复制一份。
	const MSG_CACHE_MAX = Number(process.env.SOPHO_MSG_CACHE ?? 4);
	const msgCache = new Map(); // file -> { size, mtimeMs, data }
	const readMessagesCached = (file) => {
		let st = null;
		try {
			st = fs.statSync(file);
		} catch {
			return { messages: [], hiddenRecords: 0, compaction: null, unfinished: [], extras: [] }; // 读不到 → 与 readMessages 同一个形状
		}
		const hit = msgCache.get(file);
		if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
			msgCache.delete(file); // 命中 → 挪到队尾（= 最新用过）
			msgCache.set(file, hit);
			return hit.data;
		}
		const data = readMessages(file);
		msgCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, data });
		if (msgCache.size > MSG_CACHE_MAX) msgCache.delete(msgCache.keys().next().value); // 淘汰最旧的
		return data;
	};

	/** 这个节点是不是被某个归档祖先藏住了（= renderTree 的 walk 会不会走到它）。
	 *  visited 防环：坏数据不该让 /tree 转不出来。 */
	const hiddenByArchive = (n, byId) => {
		const visited = new Set([n.id]);
		let p = n.parent ? byId.get(n.parent) : null;
		while (p && !visited.has(p.id)) {
			if (p.archived) return true;
			visited.add(p.id);
			p = p.parent ? byId.get(p.parent) : null;
		}
		return false;
	};

	/** 树顶那行「N 个会话有新东西」的汇总 —— **只数当前可见的会话**。
	 *  前端 renderTree 的 walk 碰到归档节点直接 return（连子树一起藏），所以**被归档父藏住的
	 *  活子会话，它的红点看不见 → 这种藏起来的不计数**（别让用户点了跳到一个看不见的地方）。
	 *  归档节点自己也不算（归档 = 我不看了）→ 于是只需看「祖先里有没有归档的」。 */
	const unreadSummary = (nodes) => {
		// 红点亮的集合 == 这个集合（前端画红点用的就是同一对字段）→ 数字和看得见的红点**永远对得上**。
		const visible = nodes.filter((n) => n.unread && !n.hiddenByArchive);
		// 最旧的排最前：点树顶那一行 → 跳到**最旧的**未读（按落定时间升序；同一毫秒的按 id 定序）。
		visible.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0) || String(a.id).localeCompare(String(b.id)));
		const head = visible[0] ?? null;
		return {
			count: visible.length,
			oldestId: head?.id ?? null,
			oldestName: head?.name ?? null,
			oldestAt: head?.settledAt ?? null,
		};
	};

	/** 所有会话的摘要（名字 / 血缘 / 存档态 / 在不在池 / 有没有新东西）。 */
	const tree = () => {
		const arch = readArchive();
		const seen = readSidecar(SEEN);
		const settled = readSidecar(SETTLED);
		const nodes = [];
		for (const file of ctx.allFiles()) {
			const id = ctx.idOf(file);
			if (!id) continue;
			const h = ctx.headerOf(file) ?? {};
			const e = ctx.pool.get(id);
			const archived = !!arch[id];
			const seenAt = stampOf(seen[id]); // 我上次看它（0 = 从没看过）
			const settledAt = stampOf(settled[id]); // 它上次落定（0 = 还没落定过）
			nodes.push({
				id,
				file,
				name: nameOf(file),
				// 这个名字**是谁给的**（seed / auto / manual；null = 我们还没记账）。只读账，不在这里对账 ——
				// GET /tree 是**只读**路径，别让它写 sidecar。要对账看 `GET /titles`。
				titleSource: titleRecOf(id)?.source ?? null,
				parent: h.parentSession ? ctx.idOf(h.parentSession) : null,
				cwd: h.cwd ?? null,
				archived,
				seenAt: seenAt || null,
				settledAt: settledAt || null,
				// 「未读」= 落定在我上次看之后（**归档的不算**：都归档了 = 我不看了）
				unread: !archived && settledAt > seenAt,
				// 有没有归档快照（前端「快照」链接的显示条件之一；另一个是 archived ——
				// 刚归档时导出还在异步跑，那一刻只有 archived 为真）
				snapshot: fs.existsSync(snapshotOf(id)),
				hot: !!e,
				streaming: e ? e.runtime.session.isStreaming : false,
				lastActivity: e?.lastActivity ?? null,
			});
		}
		// 「被归档父藏住」是**树的事实**（与落定/我有没有看过无关）：归档那一支整体静音 ——
		// 藏住的行不亮红点、也不计入树顶数字。两端用**同一对字段**（unread + hiddenByArchive），
		// 所以「数字」和「看得见的红点」不可能对不上。
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const n of nodes) n.hiddenByArchive = hiddenByArchive(n, byId);
		return { nodes, unread: unreadSummary(nodes) };
	};

	// ─────────────────────── 标题：这个会话在树上叫什么 ───────────────────────
	// 目标：**树上一眼看出每个会话现在在干什么**。名字（= pi 的 session_info）有三个来源：
	//   · `seed`   —— L0 **确定性种子**（零 LLM）：会话收到**第一条 user 消息**时它还没有名字
	//                 → 就用这条消息的第一行当标题（清 markdown / 压空白 / 截断 ~24 字）。
	//                 另外 spawn **显式给**的名字也记成 seed —— 那是确定性给的，不是模型判断的。
	//   · `auto`   —— L1 **模型自己起 / 自己改**：插件工具 `set_title` → `POST /sessions/{id}/title`
	//                 → 这里的 setTitle()。扩展侧拿不到「设会话名」的 API，必须绕这一圈。
	//   · `manual` —— **别人设的**：用户在 TUI 里 `/name`、手改会话文件、或我们从没管过的老会话。
	//
	// 真名只写在**一处**：pi 自己的 session_info 记录（`session.setSessionName()`）—— 树读的就是它
	//（nameOf）。`$ASSIST_HOME/titles.json` 是**我们这一层的账**：这条标题是谁给的、什么时候给的；
	// 判「要不要覆盖」只看它。
	//
	// ⚠️ 覆盖规则（**绝不覆盖用户手动改的标题**）：
	//   · 判「手动」的判据（实用且可判）：**当下会话文件里的名字 ≠ 我们账上那条** → 说明是**别人**设的
	//     → 记 `manual`，此后一律不覆盖。
	//     读**文件**而不是我们 runtime 里的内存名：TUI 是**另一个进程**，它改的是文件，而我们热着的
	//     runtime 里那份内存名会是旧的 —— 拿内存名判，恰好会漏掉最该保护的那次改动。
	//   · `seed` 可以被 `auto` 覆盖；`auto` 可以被新的 `auto` 覆盖（模型自己判断该不该改）。
	//   · 名字一变就**广播**给所有盯着树的人（GET /events，进程级单例）→ 前端不刷新页面就变。
	const TITLES = path.join(ctx.HOME, "titles.json");
	// 一屏能看全的上限。24 = 树那一行的宽度（比模型被告知的「≤20 字」宽一点：留点余量给
	// 「不听话但内容好」的标题，而不是把好标题切掉）。`SOPHO_TITLE_MAX` 可改。
	const TITLE_MAX = Number(process.env.SOPHO_TITLE_MAX ?? 24);
	const tlog = (m) => console.log(`[title] ${m}`);
	// （这里原来有个 `tid` = 取前 12 位，删了：标题日志里的 id 也用**完整 uuid**，理由见上面 `nlog` 那段）
	//
	// ── titles.json 的读缓存（本次 /tree 改动的 ①）──────────────────────────────
	// **为什么**：`titleRecOf(id)` 走的就是 `readTitles()`，而 `/tree` **每个节点**都调它一次 ⇒
	// 一个 30 KB 的 JSON 文件被 readFileSync + JSON.parse 了 **N 次**（N = 会话数）。
	// 实测 238 会话：单独这一项就 28~37 ms，是修完 `headerOf` 之后 `/tree` 剩下的 ~2/3。
	// 缓存后 O(1)（一次 statSync）。
	// 失效判据 `(size, mtimeMs)`：**别人**（手改、别的进程）动了这个文件也能看见。
	//
	//  写侧必须**显式失效**：这个文件是**我们自己**写的“义务账”，写完下一次 /tree 就得看见新账。
	//  只靠 `(size, mtimeMs)` 变了一定不同是**概率论**（同一毫秒内截断重写成同样长度就漏了），
	//  所以 `writeTitles()` 写完直接丢缓存；`putTitle()` 也**复制**一份再改，绝不就地改缓存里的那份
	//  （否则写盘失败时，内存里会留下一份**没落盘的**账，比“慢”坏多了）。
	let titlesCache = null; // { size, mtimeMs, data }
	const readTitles = () => {
		try {
			const st = fs.statSync(TITLES);
			if (titlesCache && titlesCache.size === st.size && titlesCache.mtimeMs === st.mtimeMs) return titlesCache.data;
			const m = JSON.parse(fs.readFileSync(TITLES, "utf8"));
			const data = m && typeof m === "object" ? m : {};
			titlesCache = { size: st.size, mtimeMs: st.mtimeMs, data };
			return data;
		} catch {
			titlesCache = null; // 没有 / 坏了 → 空账；也别把旧缓存留着
			return {}; // 没有 / 坏了 → 空账（当「我们什么都没设过」）
		}
	};
	const writeTitles = (m) => {
		fs.mkdirSync(ctx.HOME, { recursive: true });
		fs.writeFileSync(TITLES, JSON.stringify(m, null, 1));
		titlesCache = null; // ← 写侧立刻失效（下一次 readTitles 重新读盘）
	};
	const titleRecOf = (id) => readTitles()[id] ?? null;
	const putTitle = (id, title, source) => {
		const all = { ...readTitles() }; // 复制一份再改：缓存里那份永远只是“磁盘上的样子”
		all[id] = { title, source, at: Date.now() };
		writeTitles(all);
		return all[id];
	};

	/** pi 自己对会话名的洗法（session-manager 的 appendSessionInfo）：换行压成空格 + trim。
	 *  要用它（而不是 cleanTitle）的地方：**没经过我们清洗就把名字写进文件**的那些（create 的 `name`）。
	 *  账上那条**必须跟文件里的一字不差**，否则下一次对账会把它当成「别人改的」→ 错记 manual。 */
	const piName = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

	/** 标题文本的清洗（**L0 种子 / L1 模型的标题**走这里，它们是**我们**把它写进文件的）：
	 *  **只取第一行**、去 markdown、压空白、截断。先砍长度再拼 `…`（正好 TITLE_MAX 字）。
	 *  第一行是纯 `/命令` → null：`/compact` 不是标题（L0 种子靠它跳过命令；模型也不会这么起）。 */
	const cleanTitle = (text) => {
		const line = String(text ?? "")
			.split("\n")
			.map((s) => s.trim())
			.find(Boolean);
		if (!line) return null;
		const t = line
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → 它的 alt
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 它的文字
			.replace(/^\s*[>#]+\s*/, "") // 引用 / 标题符
			.replace(/^\s*([-*_]\s*){1,3}(?=\S)/, "") // 列表符 / 水平线
			.replace(/`+/g, "")
			.replace(/\*{1,3}|__/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!t || t.startsWith("/")) return null;
		return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
	};

	/** 当下这个名字是谁的：**文件里的名字**（pi 的 session_info）+ 我们账上那条。
	 *  顺手对账：账上没有 / 账上那条跟文件对不上 → 名字是**别人**设的 → 记 `manual`（此后不再覆盖）。
	 *  返回 null = 没有这个会话。 */
	const titleStateOf = (id) => {
		const file = ctx.fileOf(id);
		if (!file) return null;
		const cur = nameOf(file) ?? null; // pi 的说法（文件里的 session_info，最后那条赢）
		const rec = titleRecOf(id);
		if (!rec) {
			// 我们从没管过这个名字，但它已经有一个 → 是别人给的（spawn 那次我们记过账；没账 = 不是我们设的）
			if (cur) {
				const r = putTitle(id, cur, "manual");
				tlog(`#${id} 有一个不是我们设的名字「${cur}」→ 记 manual（此后不覆盖）`);
				return { file, current: cur, rec: r };
			}
			return { file, current: cur, rec: null }; // 没名字也没账 → 等 L0 种子（或模型）
		}
		if ((rec.title ?? null) !== cur) {
			// 账上那条跟文件对不上 = 名字被**别人**改了（TUI `/name` / 手改文件 / 清空）→ manual
			const r = putTitle(id, cur, "manual");
			tlog(`#${id} 标题被外部改成「${cur ?? "（清空）"}」（账上是「${rec.title ?? "（无）"}」）→ 记 manual`);
			return { file, current: cur, rec: r };
		}
		return { file, current: cur, rec };
	};

	/** 设标题。**唯一**动会话名的地方（L0 种子与 L1 auto 都走这里）。
	 *  返回 { ok, applied, name, source, previous, reason? }；reason: manual|empty-title|no-session|set-failed|already。
	 *  ⚠️ 从 setSessionName() 到记账这几行**必须同步**（中间不许 await）：setSessionName 会 emit
	 *     `session_info_changed`（插件把它 POST 回来）—— 账先对上，那条上报才不会把「我们自己刚设的」
	 *     误判成「别人改的」（那会把标题锁成 manual）。 */
	const setTitle = async (id, title, source) => {
		const st = titleStateOf(id);
		if (!st) return { ok: false, applied: false, reason: "no-session" };
		const want = cleanTitle(title);
		if (!want) return { ok: false, applied: false, reason: "empty-title", previous: st.current };
		if (st.rec?.source === "manual") {
			const same = st.current === want;
			tlog(
				same
					? `#${id} 想设的和（手动设的）名字一样 → 什么都不动`
					: `#${id} 已有手动标题「${st.current}」→ 拒绝改成「${want}」（绝不覆盖用户改过的）`,
			);
			return { ok: same, applied: false, reason: same ? "already" : "manual", name: st.current, source: "manual", previous: st.current };
		}
		let entry;
		try {
			entry = await ensure(id);
		} catch (e) {
			return { ok: false, applied: false, reason: "set-failed", error: String(e?.message ?? e), previous: st.current };
		}
		let name = want;
		try {
			const s = entry.runtime.session;
			s.setSessionName(want);
			name = cleanTitle(s.sessionName) ?? want; // pi 会 trim / 把换行压成空格 → 以它读回来的为准
			putTitle(id, name, source); // ← 到这一行为止都是同步的（见函数头）
		} catch (e) {
			return { ok: false, applied: false, reason: "set-failed", error: String(e?.message ?? e), previous: st.current };
		}
		treeBroadcast({ t: "title", id, name, source, at: Date.now() });
		tlog(`#${id} 标题 ${st.rec ? `「${st.rec.title}」(${st.rec.source})` : "（原来没有）"} → 「${name}」(${source})`);
		return { ok: true, applied: true, name, source, previous: st.current };
	};

	/** L0 种子：会话收到**第一条 user 消息**、它**还没有名字**、账上也空白 → 用这条消息的第一行当标题。
	 *  零 LLM、零成本、立刻见效（放在 prompt 之前：消息刚发出去，树上就已经有名字了）。
	 *  已经有名字（spawn / 用户 / TUI 给的）就**不种** —— 那种名字归别人，账上会被记成 manual。 */
	const seedTitle = async (id, text) => {
		const st = titleStateOf(id);
		if (!st || st.current || st.rec) return null;
		const want = cleanTitle(text);
		if (!want) return null;
		const r = await setTitle(id, want, "seed");
		if (r.ok) tlog(`#${id} 种子标题（第一条消息的第一行）→「${r.name}」`);
		return r;
	};

	/** 我们在 create 时显式给的名字（spawn 的 `name`）→ 记成 `seed`。
	 *  没这一步的话，第一次对账会把它记成 `manual`（那时它确实「不是我们设的」）—— 于是那个会话的模型
	 *  永远改不了自己的标题。**记 seed 才是准的**：这名字是我们确定性给的，不是用户手打的。
	 *  ⚠️ 原样记（只跟 pi 的洗法对齐）—— **别**用 cleanTitle 截断：这个名字是宿主直接写进文件的，
	 *     账上截短了就跟文件对不上 → 下一次对账会错记 manual（踩过）。 */
	const noteCreatedName = (id, name) => {
		const want = piName(name);
		if (!want) return null;
		const r = putTitle(id, want, "seed");
		tlog(`#${id} create 时给的名字「${want}」→ 记 seed（模型以后可以自己改）`);
		return r;
	};

	/** 插件上报的事实：这个会话的显示名刚被改过（pi 的 `session_info_changed`，比如 TUI 里 `/name`）。
	 *  插件**只报事实**（跟 settled 一个路子），判 manual / 广播都在这。 */
	const noteTitleChanged = (rawId) => {
		const id = ctx.resolveId(String(rawId ?? ""));
		if (!id || !ctx.fileOf(id)) return { ok: false, reason: "no-session" };
		const before = titleRecOf(id);
		const st = titleStateOf(id); // 对账：别人改的 → 记 manual
		const rec = st?.rec ?? null;
		const changed = !before || before.title !== (rec?.title ?? null) || before.source !== (rec?.source ?? null);
		if (changed && rec) treeBroadcast({ t: "title", id, name: rec.title ?? null, source: rec.source, at: rec.at });
		// 没变的那些**都是我们自己刚设的**（setSessionName → 插件上报回来）—— 这条日志就是「上报真的到了」的证据。
		else tlog(`#${id} 收到 title-changed 上报：名字跟账一致（我们自己刚设的）→ 什么都不用做`);
		return { ok: true, changed, title: rec?.title ?? null, source: rec?.source ?? null };
	};

	// ── 树级 SSE（`GET /events`）：一条通道，把「树上发生的事」推给所有开着页面的客户端 ──
	// 现在只有标题。**为什么不复用 `GET /sessions/{id}/stream`**：那条是**单个会话**的（打开哪个会话
	// 才有哪条），而树是全体的 —— 别的会话改了标题，你正开着的那个会话那条流不会知道。
	// 订阅者必须**活过 /reload-code**（规矩 4）：连接对象当然活着，但每次热重载都会换一份逻辑代码，
	// 所以集合挂进程级单例（跟 watcher / 登记表一个套路）。
	const TREE_KEY = "__sophoTreeSubs";
	const treeSubs = () => (globalThis[TREE_KEY] ??= new Set());
	const treeBroadcast = (msg) => {
		const line = `data: ${JSON.stringify(msg)}\n\n`;
		for (const res of treeSubs()) {
			try {
				res.write(line);
			} catch {
				treeSubs().delete(res); // 断了 → 让 close 那边收拾
			}
		}
	};

	// ─────────────────────── 环境查询（只读）：`GET /env?cwd=<path>` ───────────────────────
	// spawn 的硬拦靠它：先问「这个 cwd 上还有谁在干活 + 这棵树脏不脏」。
	// 这里只报事实（含已归档、含冷的会话），**怎么判、拦不拦由调用方定**。

	/** 只读地跑一条 git 命令；不是 repo / 命令失败 → null。绝不写、绝不报错。 */
	const git = (dir, args) => {
		try {
			return execFileSync("git", ["-C", dir, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
				maxBuffer: 4 << 20,
			}).trim();
		} catch {
			return null;
		}
	};

	/** git 事实；不是 git repo → null（不报错）。 */
	const gitInfo = (dir) => {
		// --show-toplevel 是「这是不是 repo」的判据：子目录也能用，给的是仓库根。
		const repo = git(dir, ["rev-parse", "--show-toplevel"]);
		if (!repo) return null;
		const status = git(dir, ["status", "--porcelain"]);
		const log = git(dir, ["log", "-n", "5", "--pretty=format:%h%x09%at%x09%s"]);
		return {
			repo,
			branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
			dirty: status ? status.split("\n").filter(Boolean).length : 0,
			head: git(dir, ["rev-parse", "--short", "HEAD"]),
			recent: (log ?? "")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [hash, at, ...rest] = line.split("\t");
					return { hash, subject: rest.join("\t"), at: Number(at) || null };
				}),
		};
	};

	/** 一个 cwd 的环境：git 事实 + 所有（含冷的、含已归档的）cwd 相同的会话。 */
	const envInfo = (cwd) => {
		const dir = path.resolve(cwd || ctx.DEFAULT_CWD);
		const nodes = tree().nodes.filter((n) => n.cwd && path.resolve(n.cwd) === dir);
		// 在跑的排前面，其次热的，再按最近活动 —— 让调用方一眼看到谁最可能撞车。
		nodes.sort(
			(a, b) =>
				Number(b.streaming) - Number(a.streaming) ||
				Number(b.hot) - Number(a.hot) ||
				(b.lastActivity ?? 0) - (a.lastActivity ?? 0),
		);
		return {
			cwd: dir,
			git: gitInfo(dir),
			sessions: nodes.map((n) => ({
				id: n.id,
				name: n.name,
				streaming: !!n.streaming,
				cwd: n.cwd,
				archived: !!n.archived,
				hot: !!n.hot,
				file: n.file,
				lastActivity: n.lastActivity,
			})),
		};
	};

	// ─────────────────────── cwd recents：最近用过哪些目录 ───────────────────────
	// 账只有一处、一个写者：`$ASSIST_HOME/cwd-recents.json`，形状 `{ "<绝对路径>": { count, at } }`。
	// 写点只有一个 —— **建会话时那个 cwd**（`POST /sessions {cwd}`，见下面 bumpRecents 的调用），
	// 所以不会重复计数。
	// 为什么要走 API：浏览器（`web/`）没有读文件的 HTTP 路由（B 只做静态 + 反代）⇒ recents 只能
	// 由 A 吐出来；而插件侧的 `cwd` 工具 / `/cwd` 参数补全也读**同一个** `GET /cwd-recents`
	// ⇒ agent 与 UI 看到的「最近用过」是同一份事实，不是两份各推各的。
	// 写是**原子**的（tmp → fsync → rename）：多条会话的建会话请求会并发写这个文件，
	// 半截文件比「少一条记录」坏得多。
	const RECENTS = path.join(ctx.HOME, "cwd-recents.json");
	/** 严格读：**坏文件绝不静默当空账**（`ok:false` + `error`）；只有 `ENOENT` 才是真的空账。 */
	const readRecentsStrict = () => {
		let raw;
		try {
			raw = fs.readFileSync(RECENTS, "utf8");
		} catch (e) {
			return e?.code === "ENOENT"
				? { ok: true, exists: false, all: {}, error: null }
				: { ok: false, exists: false, all: {}, error: `读不到 ${RECENTS}：${e?.message ?? e}` };
		}
		try {
			const m = JSON.parse(raw);
			if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, exists: true, all: {}, error: `${RECENTS} 的形状不对（应该是 { "<路径>": {count, at} }）` };
			return { ok: true, exists: true, all: m, error: null };
		} catch (e) {
			return { ok: false, exists: true, all: {}, error: `${RECENTS} 不是合法 JSON：${e?.message ?? e}` };
		}
	};
	/** 原子写：同目录 tmp → fsync → rename（rename 原子，读者永远看不到半截文件）。 */
	const writeRecents = (all) => {
		fs.mkdirSync(ctx.HOME, { recursive: true });
		const tmp = `${RECENTS}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeSync(fd, JSON.stringify(all, null, 1));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, RECENTS);
	};
	/** 记一次「用过这个目录」。**尽力而为**：写不进去不影响建会话，但会打日志（不静默）。
	 *  账坏了就不写（**不覆盖坏文件** —— 先让人看到那条 error）。 */
	const bumpRecents = (dir) => {
		try {
			const p = path.resolve(dir);
			if (!p) return;
			const r = readRecentsStrict();
			if (!r.ok && r.exists) return void console.warn(`[cwd-recents] ${r.error} —— 这次不记账（也不覆盖坏文件）`);
			const cur = r.all[p] ?? {};
			writeRecents({ ...r.all, [p]: { count: (typeof cur.count === "number" ? cur.count : 0) + 1, at: Date.now() } });
		} catch (e) {
			console.warn(`[cwd-recents] 记账失败（不影响建会话）：${e?.message ?? e}`);
		}
	};
	/** 最近用过（按最后使用倒序）。只认绝对路径（相对路径没意义，且可能是坏数据）。 */
	const recentsList = (limit = 50) => {
		const r = readRecentsStrict();
		const list = Object.entries(r.all)
			.map(([p, v]) => ({ path: p, count: Number(v?.count ?? 0) || 0, at: Number(v?.at ?? 0) || 0 }))
			.filter((x) => path.isAbsolute(x.path))
			.sort((a, b) => b.at - a.at)
			.slice(0, limit);
		return { list, exists: r.exists, error: r.error };
	};

	// ─────────────────────── 斜杠命令清单 ───────────────────────
	// 「这个会话能跑哪些 / 命令」是 **pi 运行时的事实**，绝不硬编码 —— 它随 agent dir
	//（提示模板 / 技能）与插件层（registerCommand）变化。
	//
	// ⚠️ 本机装的 pi 0.85.1 里 AgentSession **没有公开的 getCommands()**
	//（getCommands 只是 RPC/TUI 层拿下面三个来源现拼的一份）。所以有就用它（向前兼容），
	// 没有就按 pi 自己的拼法现拼：扩展命令 + 提示模板 + 技能命令。
	//
	// 这三条来源**都真的能经 `session.prompt(text)` 执行**：扩展命令立即执行；
	// 模板 / 技能命令展开成正文再发。所以它们 runnable=true、via="prompt"。
	const promptCommandsOf = (session) => {
		if (typeof session?.getCommands === "function") {
			return session.getCommands().map((c) => ({
				name: c.name,
				description: c.description ?? null,
				source: c.source,
				argumentHint: c.argumentHint ?? null,
				path: c.sourceInfo?.path ?? null,
			}));
		}
		const out = [];
		for (const c of session?.extensionRunner?.getRegisteredCommands?.() ?? [])
			out.push({ name: c.invocationName, description: c.description ?? null, source: "extension", argumentHint: null, path: c.sourceInfo?.path ?? null });
		for (const t of session?.promptTemplates ?? [])
			out.push({ name: t.name, description: t.description ?? null, source: "prompt", argumentHint: t.argumentHint ?? null, path: t.sourceInfo?.path ?? null });
		for (const s of session?.resourceLoader?.getSkills?.().skills ?? [])
			out.push({ name: `skill:${s.name}`, description: s.description ?? null, source: "skill", argumentHint: null, path: s.sourceInfo?.path ?? null });
		return out;
	};

	// ─────────────────── pi 的内置命令（BUILTIN_SLASH_COMMANDS）───────────────────
	// 事实（pi 0.85.1，逐条核对过）：
	//   · pi 的内置命令**只在 TUI 层被执行**（modes/interactive/interactive-mode.js 的 submit
	//     处理器里 `if (text === "/compact" …)` 那一串，内置永远先于扩展命令）；
	//     `session.prompt("/compact")` 不认它 —— 那只是普通文本。
	//   · `BUILTIN_SLASH_COMMANDS` 在 `dist/core/slash-commands.js` 里确实 `export`（.d.ts 也声明了），
	//     但 package.json 的 `exports` **只放行 "."**（+ 三个子路径）→ 按包名子路径 import 会被
	//     ERR_PACKAGE_PATH_NOT_EXPORTED 拦掉，根入口 index.js 也没 re-export 它。
	//   · 所以取法分两级：① 先试根入口（pi 哪天把它提到公共 API，这里自动接上）；
	//     ② 退到「解析出包根 → 绝对路径 import 那个文件」（exports 只管**包名子路径**，
	//     绝对路径不受它管）。拿不到就**如实报错**（builtinError）—— 绝不在本地抄一份清单冒充 pi 的事实。
	const PI_PKG = "@earendil-works/pi-coding-agent";
	const builtinCache = { tried: false, list: null, error: null, how: null };
	async function builtins() {
		if (builtinCache.tried) return builtinCache;
		builtinCache.tried = true;
		try {
			const root = await import(PI_PKG);
			if (Array.isArray(root.BUILTIN_SLASH_COMMANDS)) {
				builtinCache.list = root.BUILTIN_SLASH_COMMANDS;
				builtinCache.how = "package-root";
				return builtinCache;
			}
		} catch {
			/* 包不在 / 入口炸了 → 走下一级 */
		}
		try {
			const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(PI_PKG)))); // …/dist/index.js → 包根
			const file = path.join(pkgRoot, "dist", "core", "slash-commands.js");
			const mod = await import(pathToFileURL(file).href);
			if (Array.isArray(mod.BUILTIN_SLASH_COMMANDS)) {
				builtinCache.list = mod.BUILTIN_SLASH_COMMANDS;
				builtinCache.how = file;
			} else builtinCache.error = `${file} 里没有 BUILTIN_SLASH_COMMANDS`;
		} catch (err) {
			builtinCache.error = `读不到 pi 的内置命令清单：${err?.message ?? err}`;
		}
		return builtinCache;
	}

	/** 内置命令里**真的接好了**的：每条对应一条真实调用链（不是「看起来能做」）。
	 *  via = 前端该走哪条通路。 */
	const BUILTIN_HERE = {
		compact: {
			via: "compact",
			hint: "点上下文用量那行的「压缩」，或发 /compact（有损，会先二次确认）",
		},
		model: {
			via: "model",
			hint: "发 /model <provider/model>（打 /model 空格会列出这个会话可选的模型）",
		},
	};
	/** 接不了的：`tag` 给面板尾巴（一眼看出为什么灰），`why` 给它点下去 / 回车时的解释。
	 *  两者都要 —— 只写「不支持」等于没写。 */
	const BUILTIN_ELSEWHERE = {
		settings: { tag: "TUI 专用", why: "TUI 专用（设置菜单）" },
		tree: { tag: "看左栏树", why: "webui 用左栏的会话树（点节点就切）" },
		thinking: { tag: "TUI 专用", why: "TUI 专用（思考档位）" },
		"scoped-models": { tag: "TUI 专用", why: "TUI 专用（Ctrl+P 轮换范围）" },
		export: { tag: "点「快照」", why: "webui 用会话头部的「快照」链接（GET /sessions/{id}/export）" },
		import: { tag: "TUI 专用", why: "TUI 专用（从 JSONL 导入）" },
		share: { tag: "TUI 专用", why: "TUI 专用（分享成 gist）" },
		copy: { tag: "TUI 专用", why: "TUI 专用（复制到剪贴板）" },
		name: { tag: "TUI 专用", why: "TUI 专用（改会话显示名）" },
		session: { tag: "TUI 专用", why: "TUI 专用（会话统计）" },
		changelog: { tag: "TUI 专用", why: "TUI 专用（更新日志）" },
		hotkeys: { tag: "TUI 专用", why: "TUI 专用（快捷键一览）" },
		fork: { tag: "TUI 专用", why: "TUI 专用（从某条消息分叉）" },
		clone: { tag: "TUI 专用", why: "TUI 专用（复制当前会话）" },
		trust: { tag: "TUI 专用", why: "TUI 专用（项目信任）" },
		login: { tag: "TUI 专用", why: "TUI 专用（登录 provider，要交互）" },
		logout: { tag: "TUI 专用", why: "TUI 专用（登出 provider）" },
		new: { tag: "用＋新会话", why: "webui 用左栏的「＋ 新会话」" },
		resume: { tag: "点左栏会话", why: "webui 用左栏点会话（打开即唤醒）" },
		reload: { tag: "已自动", why: "插件改动由 watcher 自动重载；要手动用 POST /sessions/{id}/reload" },
		quit: { tag: "关标签页", why: "关掉标签页即可（A/B 还在跑：bin/stop.sh）" },
	};
	const NOT_HERE = { tag: "TUI 专用", why: "TUI 专用（webui 没接这条命令）" };

	/** 完整清单 = 内置（在前，和 TUI 的补全一致）+ 扩展/模板/技能。
	 *  同名时**内置优先**（pi 的 TUI 就是内置先命中；它的补全里会把同名的扩展命令藏掉并警告），
	 *  被顶掉的那条如实记进 builtin 条目的 `shadowed`，不假装它不存在。 */
	async function allCommands(session) {
		const here = promptCommandsOf(session).map((c) => ({ ...c, builtin: false, runnable: true, reason: null, tag: null, via: "prompt", hint: null, shadowed: null }));
		const b = await builtins();
		if (!b.list) return { commands: here, builtinError: b.error, builtinHow: null };
		const rest = new Map(here.map((c) => [c.name, c]));
		const out = [];
		for (const bc of b.list) {
			const clash = rest.get(bc.name) ?? null;
			if (clash) rest.delete(bc.name);
			const exec = BUILTIN_HERE[bc.name];
			const elsewhere = BUILTIN_ELSEWHERE[bc.name] ?? NOT_HERE;
			out.push({
				name: bc.name,
				description: bc.description ?? null,
				source: "builtin",
				argumentHint: bc.argumentHint ?? null,
				path: null,
				builtin: true,
				runnable: !!exec,
				reason: exec ? null : elsewhere.why,
				tag: exec ? null : elsewhere.tag, // 面板尾巴上的短标签
				via: exec?.via ?? null,
				hint: exec?.hint ?? null,
				shadowed: clash ? { name: clash.name, source: clash.source, description: clash.description ?? null, path: clash.path ?? null } : null,
			});
		}
		return { commands: [...out, ...rest.values()], builtinError: null, builtinHow: b.how };
	}

	// ─────────────────────── 模型清单（GET /sessions/{id}/models）───────────────────────
	// 「这个会话现在能选哪些模型」同样是 pi 运行时的事实 —— 用的是 pi RPC 的**同一句**：
	// `session.modelRuntime.getAvailableSnapshot()`（rpc-mode.js 的 set_model 拿它查表；
	// TUI 的 /model 参数补全也用它）。有 scoped models（--models）时以它为准，和 TUI 一致。
	// **不联网**：snapshot 是本地目录 + 认证过滤的结果（pi 的 refresh() 才要网络，这里不碰）。
	const modelsOf = (session) => {
		const scoped = session?.scopedModels ?? [];
		if (scoped.length) return { source: "scoped", list: scoped.map((x) => x.model) };
		const rt = session?.modelRuntime;
		if (rt && typeof rt.getAvailableSnapshot === "function") return { source: "available", list: [...rt.getAvailableSnapshot()] };
		return { source: "none", list: [] };
	};
	const modelRef = (m) => (m ? `${m.provider}/${m.id}` : null);

	/** 认两种写法：`provider/id`（TUI 补全给的就是这个，也是 argumentHint 的写法）或裸 id。
	 *  裸 id 跨 provider 撞名 → **拒绝**并列出候选（和 pi 的 findExactModelReferenceMatch 一个口径：
	 *  它也不替用户猜）。最后给一次大小写不敏感的兜底（手敲大小写不对时不至于卡死）。 */
	const pickModel = (want, list) => {
		const hit = list.find((m) => `${m.provider}/${m.id}` === want);
		if (hit) return { model: hit, how: "provider/id" };
		const byId = list.filter((m) => m.id === want);
		if (byId.length === 1) return { model: byId[0], how: "id" };
		if (byId.length > 1) return { ambiguous: byId, how: "id-ambiguous" };
		const low = want.toLowerCase();
		const ci = list.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === low || m.id.toLowerCase() === low);
		if (ci.length === 1) return { model: ci[0], how: "case-insensitive" };
		if (ci.length > 1) return { ambiguous: ci, how: "case-insensitive-ambiguous" };
		return null;
	};

	/** 往这个会话的 SSE 订阅者写一条我们自己造的线报。
	 *  ⚠️ 宿主（base.mjs）的 broadcast 在这里够不着（它在宿主里，且宿主不许改）；
	 *  但**订阅者是同一批** —— 本文件的 GET /stream 就是往 entry.subscribers 里塞的。
	 *  只写不订阅：规矩 2（逻辑层不许 subscribe pi 的事件）没破。 */
	const notify = (entry, msg) => {
		const line = `data: ${JSON.stringify(msg)}\n\n`;
		for (const res of entry.subscribers ?? []) {
			try {
				res.write(line);
			} catch {
				entry.subscribers.delete(res);
			}
		}
	};

	// ─────────────────────── 上下文用量 ───────────────────────
	// 「还差多少就该压缩了」才是真正有用的判据（pi 的 compaction 触发条件是
	// contextTokens > contextWindow - reserveTokens；见 dist/core/compaction）。
	// getContextUsage() 只给 tokens / contextWindow / percent，所以 reserveTokens 与阈值
	// 由这里现算，前端不用自己去读 settings。
	const DEFAULT_RESERVE = 16384; // 与 pi settings-manager 的默认值一致
	const contextOf = (session) => {
		const u = session?.getContextUsage?.();
		if (!u) return null; // 没模型 / 窗口不确定 → 不报（别编个 0 骗人）
		const st = session.settingsManager?.getCompactionSettings?.() ?? {};
		const reserveTokens = st.reserveTokens ?? DEFAULT_RESERVE;
		const compactAt = u.contextWindow > 0 ? Math.max(0, u.contextWindow - reserveTokens) : 0;
		return {
			// tokens / percent 可能是 null（刚压缩过、还没下一次 LLM 响应）—— 原样透传
			tokens: u.tokens ?? null,
			contextWindow: u.contextWindow,
			percent: u.percent ?? null,
			reserveTokens,
			compactAt, // 自动压缩阈值
			// 离阈值还有多少 token（负 = 已越过）；tokens 未知 → null
			freeTokens: u.tokens == null || !compactAt ? null : compactAt - u.tokens,
			autoCompact: !!st.enabled,
			// 压缩时**保留的最近多少 token**（默认 20000，见 pi 的 DEFAULT_COMPACTION_SETTINGS）。
			// 前端拿它给「预计释放」一个量级 —— 别把压缩说成「清空」。
			keepRecentTokens: st.keepRecentTokens ?? null,
		};
	};

	/** pi 手动压缩「无可压缩」时的原话（agent-session.js 里抛的）。认出来才能给一句人话。 */
	const NOTHING_TO_COMPACT = /Already compacted|Nothing to compact/i;
	const COMPACT_CANCELLED = /Compaction cancelled/i;

	// ─────────────────────── 中断（= pi 的 session.abort） ───────────────────────
	/** 等 abort() 落定的上限。`session.abort()` 会 `await waitForIdle()` —— 正常很快（掐掉信号，
	 *  工具返回），但万一某个工具**不认** abort signal 就永远回不来；那就别把 HTTP 请求也挂死，
	 *  到点回包并如实说 `still-running`（宁可能看到「还没停下来」，也不把请求卡成第二个事故）。 */
	const ABORT_WAIT_MS = Number(process.env.SOPHO_ABORT_WAIT_MS ?? 15_000);
	/** 中断的**能力边界** —— 如实说，绝不装成「万能停止键」。四格都是**本机实测**
	 *（Windows + Git Bash 宿主 / WSL2 ArchLinux），见 commit message：
	 *   · directChild     直接子进程（pi 的 bash 工具在 abort signal 上 `killProcessTree(child.pid)`）→ 杀得到；
	 *   · wslForeground   `wsl.exe -e bash -c …` 前台命令 → **实测杀得到**：杀掉 wsl.exe 客户端会把
	 *                     整个 WSL 会话连同 VM 里的进程一起停掉（与“逃出进程树就杀不到”的猜测相反）；
	 *   · detached        detached + 生成它的父已退出（被重新挂父）/ nohup / setsid / disown → 杀不到；
	 *   · remote          别的机器/容器上干的活（ssh / docker|kubectl exec / 远程 PowerShell）→ 杀不到。 */
	const abortBoundary = () => ({
		directChild: "killed",
		wslForeground: "killed",
		detached: "not-killed",
		remote: "not-killed",
		note: "中断会掐掉当前这一轮、并杀掉它起的**本地直接子进程**（pi 的 bash 工具自己就会 killProcessTree）。实测：WSL 前台的整条命令（wsl -e bash -c …）也会连同 VM 里的进程一起停。杀不到的两类：① 已经脱钩的后台进程（nohup / setsid / disown / detached 后父已退出）；② 在别的机器或容器上干的活（ssh / docker exec / kubectl exec / 远程 PowerShell）。",
	});

	/** 文本开头的 `/名字`（到第一个空格为止）；不是 / 开头 → null。 */
	const commandNameIn = (text) => {
		if (!text.startsWith("/")) return null;
		const sp = text.indexOf(" ");
		return text.slice(1, sp === -1 ? undefined : sp);
	};

	// ─────────────────────── 路由 ───────────────────────

	// ─────────── 阅读页 API 的位置（路由在下面；这里只放常量/缓存）───────────
	// 缓存是**模块级**的：逻辑层一重载就没了（规矩 1）—— 丢了只是重建一次，没有代价。
	let pages = null;
	const u0 = (req) => new URL(req.url ?? "/", "http://localhost");
	const PAGES_WARNING =
		"这个 API 能改写 SOPHO_PAGE_ROOT 里的 .md —— 而 B 默认零认证、绑 0.0.0.0：能连上它就等于能改这些文件。根限制只把爆炸半径限在一个目录，不是保险箱。";

	/** 阅读页的根：每次请求都重读 env / `$ASSIST_HOME/paths.json`，不能把配置结果缓存成启动时状态。 */
	const resolvePageRoots = (PageError) => {
		const pageEnv = process.env.SOPHO_PAGE_ROOT;
		const epubEnv = process.env.SOPHO_EPUB_ROOT;
		const configFile = path.join(ctx.HOME, "paths.json");
		let config = null;
		let configPresent = false;
		// 两个 env 都有值时，配置层根本不参与解析（env 最高优先，也保持旧行为）。
		if (pageEnv === undefined || epubEnv === undefined) {
			try {
				config = JSON.parse(fs.readFileSync(configFile, "utf8"));
				configPresent = true;
			} catch (e) {
				if (e?.code !== "ENOENT") {
					const detail = `无法读取或解析 ${configFile}：${String(e?.message ?? e)}`;
					console.error(`[pages] paths.json 无效：${detail}`);
					throw new PageError(500, "pages-config-invalid", { detail, configFile });
				}
			}
		}

		if (configPresent && (!config || Array.isArray(config) || typeof config !== "object" || typeof config.pageRoot !== "string" || config.pageRoot.trim() === "" || (Object.hasOwn(config, "epubRoot") && (typeof config.epubRoot !== "string" || config.epubRoot.trim() === "")))) {
			const detail = `${configFile} 必须是 {"pageRoot":"...","epubRoot":"..."}，其中 pageRoot 必须是非空字符串，epubRoot 可省略`;
			console.error(`[pages] paths.json 无效：${detail}`);
			throw new PageError(500, "pages-config-invalid", { detail, configFile });
		}

		const configured = (name) => {
			if (!configPresent) return null;
			const value = config[name];
			if (value === undefined) return null;
			const root = path.resolve(ctx.HOME, value);
			try {
				if (!fs.statSync(root).isDirectory()) throw new Error("不是目录");
			} catch (e) {
				const detail = `${configFile} 的 ${name} 根不存在或不可用：${root}（${String(e?.message ?? e)}）`;
				console.error(`[pages] paths.json 无效：${detail}`);
				throw new PageError(500, "pages-config-invalid", { detail, configFile, root });
			}
			return root;
		};
		const configPage = configured("pageRoot");
		const configEpub = configured("epubRoot");
		const pageRoot = pageEnv !== undefined ? path.resolve(pageEnv) : configPage ?? path.join(ctx.HOME, "pages");
		const pageSource = pageEnv !== undefined ? "env" : configPage ? "config" : "default";
		const epubRoot = epubEnv !== undefined ? path.resolve(epubEnv) : configEpub ?? pageRoot;
		const epubSource = epubEnv !== undefined ? "env" : configEpub || pageSource === "config" ? "config" : pageSource;
		return { pageRoot: path.resolve(pageRoot), epubRoot: path.resolve(epubRoot), rootSource: pageSource, epubRootSource: epubSource };
	};

	/** 阅读页的 store（按根缓存）。动态 import + 手动续 `?v=` —— 见上面那段说明。 */
	const pagesStore = async () => {
		const u = new URL("./page-store.mjs", import.meta.url);
		u.search = new URL(import.meta.url).search;
		const mod = await import(u.href);
		const roots = resolvePageRoots(mod.PageError);
		if (!pages || pages.root !== roots.pageRoot || pages.epubRoot !== roots.epubRoot) {
			pages = { store: mod.createPageStore({ root: roots.pageRoot, epubRoot: roots.epubRoot }), ...roots, PageError: mod.PageError };
		}
		return { store: pages.store, ...roots, PageError: mod.PageError };
	};

	/** **回流**：页面被写动之后，广播一条 `{t:"page", path, pageFingerprint}`。
	 *  为什么不用"前端轮询"：阅读页订阅的是**同一条树级 SSE**（`GET /events`，与标题那条一个通道）——
	 *  页面一变就推，没变就一声不响（轮询要么费流量、要么慢）。
	 *  ⚠️ 只在**真的写了**之后广播（`wrote:true`），否则"打开页面"也会触发一轮重读。
	 *  发出去的只有路径 + 指纹（**不带内容**）—— 前端拿着指纹跟自己对一下，不同才重读那一页。 */
	const broadcastPage = (rel, store) => {
		try {
			const pg = store.readPage(rel, { withText: false });
			treeBroadcast({ t: "page", path: rel, pageFingerprint: pg.pageFingerprint, bytes: pg.bytes, at: Date.now() });
		} catch {
			/* 广播失败不该影响写入本身的回执 */
		}
	};

	// ── 阅读页 ↔ 会话 的绑定（sidecar，与 titles.json / archive.json 一个路子）──
	// 这是**义务存储**："这一页归哪条会话"从会话文件里推不出来，所以单独落一个
	// `$ASSIST_HOME/reading-pages.json`。形状：
	//   { "<相对根路径>": { sessionId, boundBy, boundAt, lastPressAt, lastDeliveryAt, lastDeliveryOk } }
	// `boundBy`: auto-created（第一次按的时候自动建的）/ manual（调用方给了 sessionId）/ auto（沿用已有的）。
	const READING_PAGES = path.join(ctx.HOME, "reading-pages.json");
	const readBindings = () => {
		try {
			return JSON.parse(fs.readFileSync(READING_PAGES, "utf8"));
		} catch {
			return {};
		}
	};
	const bindingOf = (rel) => readBindings()[rel] ?? null;
	const setBinding = (rel, patch) => {
		const b = readBindings();
		b[rel] = { ...(b[rel] ?? {}), ...patch, updatedAt: Date.now() };
		fs.mkdirSync(ctx.HOME, { recursive: true });
		fs.writeFileSync(READING_PAGES, JSON.stringify(b, null, 1));
		return b[rel];
	};

	/**
	 * 要交给 agent 的那段字 —— **设计要点（人类的倾向，写进协议文档了）**：
	 * 一段说明 + **我这次新写的原文** + **指向那一页**。
	 * 为什么必须有后两样：那条会话的上下文里**没有**这一页的内容（它可能刚被建出来），
	 * 而"按一下"不是一次聊天 —— 它是把页面上新写的字递过去。
	 */
	const buildPressMessage = ({ rel, abs, applied }) => {
		const blocks = applied.map((a) => {
			const body = String(a.text ?? "");
			return `▸ ${a.label}（第 ${a.range[0] + 1} 行）\n${body.trim() === "" ? "（我清空了这一块）" : body}`;
		});
		return [
			"【阅读页·按一下】我在这一页写了新的字，下面是**我这次改动的块**（已经存进文件了）。",
			"",
			...blocks.flatMap((x) => [x, ""]),
			`页面：${rel}`,
			`绝对路径：${abs}`,
			"",
			"（这一页的原文、问题和我以前写的东西**都不在你的上下文里** —— 需要看整页就自己读上面那个文件。",
			"  这条消息只带我这次改的块；别把它当成一次聊天，也别在这里复述整页。）",
		].join("\n");
	};

	const body = (req) =>
		ctx.readBody(req).catch((e) => {
			throw new ctx.Bad(e.message);
		});

	/** 返回 true = 我处理了；false = 不是我管的（宿主接着 404）。 */
	async function handle(req, res, seg) {
		const m = req.method;

		// GET /metrics —— 网络压力仪表（见文件顶部的说明）。
		// **自己不计入**：否则「看仪表」这个动作本身会把仪表污染掉。
		if (m === "GET" && seg.length === 1 && seg[0] === "metrics") {
			ctx.json(res, 200, netSnapshot());
			return true;
		}

		// 其余一律先装计数器（含 404）：计数只读 res，不影响任何响应内容。
		instrumentRequest(req, res, routePatternOf(seg));

		// POST /sessions —— 建会话（可选 parent）。
		// `notify:true` + 有 parent → 顺手登记「这个子会话这一轮结束叫我」（见上面登记表那段）。
		if (m === "POST" && seg[0] === "sessions" && seg.length === 1) {
			const b = await body(req);
			const entry = await create({ parent: b.parent, cwd: b.cwd, name: b.name });
			// 「最近用过哪些目录」**只在这里记账**（建会话时显式给的那个 cwd）—— 一个写者，不重复计数。
			// 没给 cwd（用默认目录）的不记：那是“没选目录”，不是“选了这个目录”。
			if (typeof b.cwd === "string" && b.cwd.trim()) bumpRecents(b.cwd);
			// 我们（spawn）显式给的 `name` 记成 `seed`：它是**确定性给的**，不是模型自己判断的
			// → 这个会话的模型以后可以自己改（只有 `manual` 才一律不动）。记在 create 之后：
			// 此时 pi 已经把名字写进 session_info 了，读回来的是**它的**规范化版本。
			if (b.name) noteCreatedName(entry.id, entry.runtime.session.sessionName ?? String(b.name));
			const reg =
				b.notify === true && b.parent
					? registerNotify({ parentId: ctx.resolveId(String(b.parent)), childId: entry.id, reason: "spawn", label: b.name ?? null })
					: null;
			ctx.json(res, 201, {
				...status(entry),
				notify: reg ? { registered: true, refreshed: !!reg.refreshed, parent: reg.parentId } : { registered: false },
			});
			return true;
		}

		// POST /sessions/{id}/settled —— **插件上报的“事实”**：这个会话这一轮落定了（pi 的 agent_settled）。
		// 插件不做任何判定；要不要唤醒 / 唤醒谁 / 一次性 全在上面的登记表。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "settled") {
			const r = await onSettledReport(seg[1]);
			ctx.json(res, 200, { ok: true, id: seg[1], ...r });
			return true;
		}

		// POST /sessions/{id}/seen —— **前端说「我看过了」**（打开这个会话、并且视口跟着底部）。
		// 只记事实（seen.json），不做别的：要不要唤醒 / 红点怎么画都不在这。
		// 时间一律用服务端的 now，**不接客户端的时间戳**（见上面那段）。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "seen") {
			const id = ctx.resolveId(seg[1]);
			if (!id || !ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const seenAt = recordSeen(id);
			ctx.json(res, 200, { ok: true, id, seenAt, unread: false });
			return true;
		}

		// ⚠️ 测试用（dev-only）：**同一个 tick 连发 N 条** —— 专门用来复现/回归「两条消息落进
		// pi 的 `isStreaming` 窗口」这个发送竞态。HTTP 上做不到同 tick（Node 在两个 socket 回调
		// 之间会把微任务抽干，而 pi 的窗口只跨微任务 —— 见 test/race-message.mjs 的说明），
		// 所以同 tick 只能在进程内造。除了按名字给这个会话发 N 条，不做任何别的事。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "dev-burst") {
			const b = await body(req);
			const n = Math.max(1, Math.min(50, Number(b.n ?? 2)));
			const entry = await ensure(seg[1]);
			// 同 tick 把 N 条全发出去（**不 await 中间那条**）—— 交给 deliver 串行化。
			const results = await Promise.all(
				Array.from({ length: n }, (_, i) => deliver(entry, `${b.text ?? "burst"}-${i}`, b.behavior)),
			);
			ctx.json(res, 200, { id: entry.id, n, results });
			return true;
		}

		// POST /sessions/{id}/message —— 发消息 = 唤醒。**唤醒已存档的会话 = 复活它**
		//（存档只表示"默认不显示"，不是终态）
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "message") {
			const b = await body(req);
			const id = seg[1];
			if (!String(b.text ?? "").trim()) throw new ctx.Bad("缺 text");
			if (readArchive()[id]) setArchived(id, false);
			const entry = await ensure(id);
			const text = String(b.text);
			// 流式中**明确拒绝**斜杠命令，绝不静默 steer/followUp（命令不是能排队的东西）。
			// 只拦**真的在清单里的**命令：普通以 / 开头的文本（路径之类）照旧走。
			// 前端也会先拦一道；这里兜底 —— 前端对 streaming 的认知来自 SSE，可能慢一拍。
			const name = commandNameIn(text);
			if (name && entry.runtime.session.isStreaming && (await allCommands(entry.runtime.session)).commands.some((c) => c.name === name)) {
				ctx.json(res, 409, { error: `会话正在跑，斜杠命令「/${name}」不能插话也不能排队 —— 等这一轮跑完再发。` });
				return true;
			}
			// L0 种子：**第一条 user 消息** → 这个还没有名字的会话就有了标题（零 LLM、立刻见效）。
			// 放在 prompt **之前**：消息刚发出去，树上就已经有名字了（不用等模型第一句话）。
			// 已经有名字 / 已经记过账 → 什么也不做（seedTitle 自己判）。
			await seedTitle(entry.id, text);
			// `notify:true` → 登记「它这一轮结束叫我」。
			// ⚠️ **登记必须在 prompt 之前**：孩子可能极快就 settled，上报先到的话登记就丢了。
			const reg =
				b.notify === true
					? registerNotify({
						parentId: notifierOf(entry, b.notifyTo),
						childId: entry.id,
						reason: "message",
					})
					: null;
			const r = await deliver(entry, text, b.behavior);
			// 真接受不了就**别回 202**（回 409 并说清），**绝不允许"回 OK 却丢掉"**。
			if (r.accepted === false) {
				ctx.json(res, 409, { id: entry.id, ...r, status: status(entry) });
				return true;
			}
			ctx.json(res, 202, {
				ok: true,
				...r,
				status: status(entry),
				title: titleRecOf(entry.id), // 刚种的标题（L0）—— 前端/调用方不用另发一问
				notify: reg ? { registered: true, refreshed: !!reg.refreshed, parent: reg.parentId } : { registered: false },
			});
			return true;
		}

		// POST /sessions/{id}/title —— **给这个会话起 / 改标题**（L1：插件工具 `set_title` 走这里；
		// 前端以后想加「改名」也走这里）。覆盖规则全在 setTitle()：seed 可被 auto 覆盖、
		// auto 可被新的 auto 覆盖，**manual（用户手动改过的）一律不动**。
		// 成功 200；被拒（manual / 空标题 / 设不上去）409 —— 调用方**必须**看得出「没改成」。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "title") {
			const b = await body(req);
			if (!ctx.fileOf(seg[1])) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			// source 只接 `auto`（模型/自动）；`seed` 是内部 L0 那条路（不走 HTTP），`manual` 只由
			// 「对账」产生 —— 外面无权自己声称「我是用户」。
			const r = await setTitle(seg[1], b.title, "auto");
			ctx.json(res, r.ok ? 200 : r.reason === "no-session" ? 404 : 409, { id: seg[1], ...r });
			return true;
		}

		// POST /sessions/{id}/title-changed —— **插件上报的事实**：这个会话的显示名刚被改过
		//（pi 的 `session_info_changed`：TUI `/name`、或我们自己的 setSessionName）。
		// 插件不做任何判定；「这是不是『别人』改的」由对账（titleStateOf）说 —— 名字跟账上不一致才记 manual。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "title-changed") {
			const b = await body(req);
			if (!ctx.fileOf(seg[1])) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			ctx.json(res, 200, { id: seg[1], ...noteTitleChanged(seg[1]) });
			return true;
		}

		// GET /titles —— 标题的**账**（诊断 / 验证）：每条 + 会话文件里**当下**的名字 + 对不对得上。
		// ⚠️ 它会**顺手对账**（把「不是我们设的」名字记成 manual），所以这个 GET 是**会写 sidecar** 的。
		if (m === "GET" && seg[0] === "titles") {
			const items = tree().nodes.map((n) => {
				const st = titleStateOf(n.id);
				return {
					id: n.id,
					name: n.name, // pi 文件里的当下名字（树显示的就是它）
					title: st?.rec?.title ?? null, // 我们账上那条
					source: st?.rec?.source ?? null,
					at: st?.rec?.at ?? null,
					manual: st?.rec?.source === "manual",
				};
			});
			ctx.json(res, 200, { file: TITLES, count: items.length, items });
			return true;
		}

		// GET /events —— **树级** SSE（一条通道说树上的事，现在只有标题）：
		// {t:"title", id, name, source, at} —— 前端不刷新页面就跟着变（web/app.mjs 的 openTreeStream）。
		if (m === "GET" && seg[0] === "events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(`data: ${JSON.stringify({ t: "hello", now: Date.now() })}\n\n`);
			treeSubs().add(res);
			const ka = setInterval(() => {
				try {
					res.write(": ka\n\n");
				} catch {
					/* 断了 close 会收拾 */
				}
			}, 15_000);
			req.on("close", () => {
				clearInterval(ka);
				treeSubs().delete(res);
			});
			return true;
		}

		// GET /sessions/{id}/commands —— 这个会话的斜杠命令清单 + 现在能不能跑。
		// 冷会话没有 runtime 就没有清单 —— **ensure** 一个（和 /stream 一样，GET 有唤醒副作用）。
		// 返回里带上 streaming / canRun / compacting，前端不用自己推。
		// 每条命令都带「能不能在 webui 里执行」（runnable + reason + via）—— 不能执行的
		// 也**列出来**（用户拿 TUI 的清单对照时不会觉得漏了），但绝不装成能用。
		if (m === "GET" && seg[0] === "sessions" && seg[2] === "commands") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const entry = await ensure(id);
			const s = entry.runtime.session;
			const streaming = !!s.isStreaming;
			const compacting = !!s.isCompacting;
			const { commands, builtinError, builtinHow } = await allCommands(s);
			ctx.json(res, 200, {
				id,
				streaming,
				compacting,
				canRun: !streaming && !compacting,
				commands,
				builtinError,
				builtinHow, // 内置清单是从哪儿拿的（包根 / 文件路径）—— 排查用
			});
			return true;
		}

		// GET /sessions/{id}/context —— 上下文用量（tokens / 窗口 / 离自动压缩阈值还有多少）。
		// **冷会话不 ensure**：没有 runtime 就没有用量，context 直接 null（前端显示 —）。
		// 为了看一眼用量就把一整个 runtime 拉起来太贵，而且冷会话“还没跑”本来就是事实。
		if (m === "GET" && seg[0] === "sessions" && seg[2] === "context") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const entry = ctx.pool.get(id);
			const s = entry?.runtime.session;
			ctx.json(res, 200, {
				id,
				hot: !!entry,
				streaming: !!s?.isStreaming,
				compacting: !!s?.isCompacting,
				context: s ? contextOf(s) : null,
			});
			return true;
		}

		// POST /sessions/{id}/abort —— **中断当前这一轮**（= pi 的 session.abort()、TUI 的 Esc）。
		//
		// 为什么要有（两天里同一个病发作两次的直接教训）：一条 bash 卡了 14 分钟（grep -r 从整个
		// 用户目录起搜）、一条卡了 32 分钟以上（音乐库全库扫描），会话卡在 streaming:true 出不来、
		// **界面什么都不显示、新消息也插不进（409）**——人只能从外面精确杀进程。
		// **核心不是「慢」，是「没有出口」**：这条路由就是那个出口。
		//
		// 真实入口（pi 0.85.1，dist/core/agent-session.d.ts:444）：
		//   abort(): Promise<void>  —— 'Abort current operation and wait for agent to become idle.'
		// 实现：abortRetry + abortCompaction + abortBranchSummary + agent.abort() + waitForIdle()。
		// agent.abort() 触发那一轮的 AbortSignal；pi 的 bash 工具在该 signal 上
		// `killProcessTree(child.pid)`（dist/core/tools/bash.js）→ **直接子进程会被杀掉**。
		// 杀不到的那几类（已脱钩的后台进程 / 别的机器上的活）如实写在 response.boundary 里。
		//
		// 语义（与 /compact、/model 那些「流式中 409」的路由**刻意不同**）：
		//   · 中断**就是要打断**那一轮 —— 它不是「插一条命令」，所以不受「命令插不进流式回合」那条
		//     规矩约束（那条规矩是给发消息的，原样不动）。别把两者混起来。
		//   · **不在跑时**：200 幂等（code:"idle"），**不是** 409。理由：中断是个「收敛到停下」的
		//     动作，「已经停了」就是它要的状态；而「这一轮刚好在你点下去前 100ms 跑完」是**最常见的
		//     竞态**，回 409 会让前端把一件好事当成错误、还得多写一段特判。只有「没有这个会话」= 404。
		//   · **冷会话不 ensure**：没 runtime = 没在跑，别为了掐一个不存在的回合把 runtime 拉起来。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "abort") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const entry = ctx.pool.get(id);
			if (!entry) {
				ctx.json(res, 200, {
					ok: true,
					id,
					code: "idle",
					aborted: false,
					hot: false,
					wasStreaming: false,
					wasCompacting: false,
					streaming: false,
					compacting: false,
					waitedMs: 0,
					timedOut: false,
					boundary: abortBoundary(),
				});
				return true;
			}
			const s = entry.runtime.session;
			if (typeof s.abort !== "function") throw new ctx.Bad("这个会话的 pi 没有 abort 入口（session.abort 不存在）");
			const wasStreaming = !!s.isStreaming;
			const wasCompacting = !!s.isCompacting;
			if (!wasStreaming && !wasCompacting) {
				ctx.json(res, 200, {
					ok: true,
					id,
					code: "idle",
					aborted: false,
					hot: true,
					wasStreaming,
					wasCompacting,
					streaming: false,
					compacting: false,
					waitedMs: 0,
					timedOut: false,
					boundary: abortBoundary(),
				});
				return true;
			}
			// 先广播「要中断了」——别的标签页也能立刻反映（不靠这次请求的回包）；
			// 结束那一条在 abort() 落定后再广播（那时 streaming 才是真事实）。
			notify(entry, { t: "abort", phase: "start", id, wasStreaming, wasCompacting });
			const t0 = Date.now();
			let timedOut = false;
			try {
				await Promise.race([s.abort(), nap(ABORT_WAIT_MS).then(() => void (timedOut = true))]);
			} catch (err) {
				const msg = String(err?.message ?? err);
				notify(entry, { t: "abort", phase: "error", id, error: msg });
				ctx.json(res, 500, { ok: false, id, code: "failed", error: `中断时报错：${msg}`, detail: msg });
				return true;
			}
			const waitedMs = Date.now() - t0;
			const streaming = !!s.isStreaming;
			const compacting = !!s.isCompacting;
			const code = timedOut || streaming || compacting ? "still-running" : "aborted";
			notify(entry, { t: "abort", phase: "end", id, code, streaming, compacting, waitedMs, timedOut, boundary: abortBoundary() });
			ctx.json(res, 200, {
				ok: true,
				id,
				code,
				aborted: true,
				hot: true,
				wasStreaming,
				wasCompacting,
				streaming,
				compacting,
				waitedMs,
				timedOut,
				boundary: abortBoundary(),
			});
			return true;
		}

		// POST /sessions/{id}/compact —— **手动压缩**（= TUI 的 /compact、RPC 的 compact）。
		//
		// 真实入口（pi 0.85.1，dist/core/agent-session.d.ts:501）：
		//   compact(customInstructions?: string): Promise<CompactionResult>
		// 注释原文：'Manually compact the session context. This is the manual entry point
		// used by `/compact`, RPC, and extensions.' —— 和自动压缩（_checkCompaction）是两条路。
		//
		// ⚠️ 它**开头就 `await this.abort()`**：会把当前这一轮掐掉。所以 isStreaming 时必须
		// 拒（409），不能因为点了压缩就顺手杀掉正在跑的一轮。isCompacting 同理（pi 会拒绝 prompt）。
		//
		// 语义：**同步等**（请求挂着，直到压完 / 失败），不搞「立刻返回 + 事后通知」。
		// 理由：① 回执本身（tokensBefore / estimatedTokensAfter）就是要给人看的，
		// 立刻返回等于把回执再拆成第二条通道；② 压缩期间 isCompacting，pi 本来就不让
		// 并发做别的（submit 会报错）；③ 前端等待期间拿到的是真数字，不是猜的进度。
		// 代价：长请求（一次 LLM 调用，可能几十秒）。B→A 是纯管道、无超时，浏览器 fetch 也无超时。
		// 顺带往 SSE 广播 {t:"compact"}（开始/结束）—— 别的标签页也能看见（不靠这次请求）。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "compact") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const b = await body(req);
			const entry = await ensure(id);
			const s = entry.runtime.session;
			if (typeof s.compact !== "function") throw new ctx.Bad("这个会话的 pi 没有手动压缩入口（session.compact 不存在）");
			if (s.isStreaming) {
				ctx.json(res, 409, {
					ok: false,
					code: "streaming",
					error: "会话正在跑 —— pi 的手动压缩会先 abort 掉当前这一轮，所以这里不硬来：等这一轮跑完再压。",
				});
				return true;
			}
			if (s.isCompacting) {
				ctx.json(res, 409, { ok: false, code: "compacting", error: "已经在压缩了 —— 等这一次压完再来。" });
				return true;
			}
			const instructions = typeof b.instructions === "string" && b.instructions.trim() ? b.instructions.trim() : undefined;
			const before = contextOf(s);
			notify(entry, { t: "compact", phase: "start", tokensBefore: before?.tokens ?? null, instructions: instructions ?? null });
			let result;
			try {
				result = await s.compact(instructions);
			} catch (err) {
				const msg = String(err?.message ?? err);
				notify(entry, { t: "compact", phase: "error", error: msg });
				// 「无事可做」不是服务器的错，是用户可预期的状态 → 409 + 人话 + pi 的原话
				if (NOTHING_TO_COMPACT.test(msg)) {
					ctx.json(res, 409, {
						ok: false,
						code: "nothing-to-compact",
						error: `没有可压缩的东西 —— 这个会话要么太短（还没超出保留预算），要么刚压过（最后一条就是压缩边界）。pi 的原话：${msg}`,
						detail: msg,
					});
					return true;
				}
				if (COMPACT_CANCELLED.test(msg)) {
					ctx.json(res, 409, { ok: false, code: "cancelled", error: "压缩被取消了。", detail: msg });
					return true;
				}
				ctx.json(res, 500, { ok: false, code: "failed", error: `压缩失败：${msg}`, detail: msg });
				return true;
			}
			const tokensBefore = result?.tokensBefore ?? null;
			const estimatedTokensAfter = result?.estimatedTokensAfter ?? null;
			const freed = tokensBefore != null && estimatedTokensAfter != null ? tokensBefore - estimatedTokensAfter : null;
			notify(entry, { t: "compact", phase: "end", tokensBefore, estimatedTokensAfter });
			ctx.json(res, 200, {
				ok: true,
				id,
				code: "compacted",
				tokensBefore,
				estimatedTokensAfter,
				freed,
				summaryChars: typeof result?.summary === "string" ? result.summary.length : null,
				instructions: instructions ?? null,
				context: contextOf(s), // 压完立刻的用量（tokens 通常是 null：等下一次 LLM 响应）
			});
			return true;
		}

		// GET /sessions/{id}/models —— 这个会话现在能选的模型（+ 当前在用的那个）。
		// 冷会话不 ensure（和 /context 一个道理：看一眼清单不值得把 runtime 拉起来）。
		if (m === "GET" && seg[0] === "sessions" && seg[2] === "models") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const s = ctx.pool.get(id)?.runtime.session;
			if (!s) {
				ctx.json(res, 200, { id, hot: false, current: null, source: "cold", models: [], error: null });
				return true;
			}
			const { source, list } = modelsOf(s);
			const cur = s.model ?? null;
			ctx.json(res, 200, {
				id,
				hot: true,
				current: modelRef(cur),
				source, // scoped / available / none（none = 这个 pi 没有 modelRuntime，退化：按名字设置）
				models: list.map((m) => ({
					provider: m.provider,
					id: m.id,
					name: m.name ?? null,
					ref: modelRef(m),
					reasoning: !!m.reasoning,
					contextWindow: m.contextWindow ?? null,
					current: modelRef(m) === modelRef(cur),
				})),
				error: null,
			});
			return true;
		}

		// POST /sessions/{id}/model {model} —— 切模型（= TUI 的 `/model <provider/id>`）。
		// 真身是 session.setModel(model, options?)；**默认只对这条会话生效**（pi 的
		// ModelMutationOptions.persist 默认 false，= session-only，不写全局默认模型）。
		// 流式中拒绝：切模型会改 agent 的模型，正在跑的那一轮不该被换掉（等跑完再切）。
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "model") {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const b = await body(req);
			const want = String(b.model ?? "").trim();
			if (!want) throw new ctx.Bad("缺 model（例：litellm/deepseek-flash）");
			const entry = await ensure(id);
			const s = entry.runtime.session;
			if (typeof s.setModel !== "function") throw new ctx.Bad("这个会话的 pi 没有 setModel 入口");
			if (s.isStreaming) {
				ctx.json(res, 409, { ok: false, code: "streaming", error: "会话正在跑 —— 等这一轮跑完再切模型（半路换模型会让这一轮的上下文对不上）。" });
				return true;
			}
			if (s.isCompacting) {
				ctx.json(res, 409, { ok: false, code: "compacting", error: "正在压缩 —— 等压完再切模型。" });
				return true;
			}
			const { source, list } = modelsOf(s);
			const hit = pickModel(want, list);
			if (hit?.ambiguous) {
				ctx.json(res, 409, {
					ok: false,
					code: "ambiguous-model",
					error: `「${want}」在多个 provider 下都有 —— 写全一点：`, 
					candidates: hit.ambiguous.map(modelRef),
				});
				return true;
			}
			if (!hit?.model) {
				ctx.json(res, 404, {
					ok: false,
					code: "model-not-found",
					error: `这个会话的可选模型里没有「${want}」（${source} 来源共 ${list.length} 个）。打 /model 空格可以列出来。`,
					sample: list.slice(0, 8).map(modelRef),
				});
				return true;
			}
			// persist 默认 false（= session-only）；只有请求里显式写 persist:true 才写全局默认模型。
			try {
				await s.setModel(hit.model, { persist: b.persist === true });
			} catch (err) {
				const msg = String(err?.message ?? err);
				ctx.json(res, 400, { ok: false, code: "set-model-failed", error: `切不过去：${msg}`, detail: msg });
				return true;
			}
			ctx.json(res, 200, {
				ok: true,
				id,
				model: modelRef(hit.model),
				matched: hit.how,
				source,
				persist: b.persist === true,
				status: status(entry),
			});
			return true;
		}

		// GET /sessions/{id}/stream —— SSE
		if (m === "GET" && seg[0] === "sessions" && seg[2] === "stream") {
			const entry = await ensure(seg[1]);
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(`data: ${JSON.stringify({ t: "hello", status: status(entry), queue: queueOf(entry) })}\n\n`);
			entry.subscribers.add(res);
			const off = () => entry.subscribers.delete(res);
			const ka = setInterval(() => {
				try {
					res.write(": ka\n\n");
				} catch {
					/* 断了 close 会收拾 */
				}
			}, 15_000);
			req.on("close", () => {
				clearInterval(ka);
				off();
			});
			return true;
		}

		// GET /sessions/{id}
		if (m === "GET" && seg[0] === "sessions" && seg.length === 2) {
			const id = seg[1];
			const e = ctx.pool.get(id);
			if (e) {
				ctx.json(res, 200, status(e));
				return true;
			}
			const file = ctx.fileOf(id);
			if (!file) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			// 冷会话没有 runtime → 没有「它跑哪一版插件」这回事（下次 ensure 会加载**当前**版本，永不陈旧）
			ctx.json(res, 200, {
				id,
				file,
				hot: false,
				name: nameOf(file), // 树上显示的名字（文件里的 session_info）
				title: titleRecOf(id), // 我们账上那条（source = seed/auto/manual）
				cwd: ctx.headerOf(file)?.cwd ?? null,
				pluginMtimeMs: null,
				pluginNowMtimeMs: pluginNow(),
				pluginStale: null,
			});
			return true;
		}

		// GET /sessions/{id}/messages
		if (m === "GET" && seg[0] === "sessions" && seg[2] === "messages") {
			const file = ctx.fileOf(seg[1]);
			if (!file) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			// 「未完成」的分片要按**会话当下在不在跑**标成 running / interrupted ——
			// 判据来自 runtime（只有服务端分得清「还在跑」和「被中断」），且**不进缓存**
			// （见 markUnfinished 的注释）。冷会话（不在池里）没有 runtime ⇒ 不在跑 ⇒ interrupted。
			const data = readMessagesCached(file);
			const marked = markUnfinished(data, isStreaming(ctx.pool.get(seg[1])));
			const { unfinished, ...rest } = marked; // unfinished 只是内部记账，别铺到 wire 上
			ctx.json(res, 200, { id: seg[1], ...rest });
			return true;
		}

		// POST /sessions/{id}/archive · /unarchive
		if (m === "POST" && seg[0] === "sessions" && (seg[2] === "archive" || seg[2] === "unarchive")) {
			const id = seg[1];
			if (!ctx.fileOf(id)) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			const archived = setArchived(id, seg[2] === "archive");
			ctx.json(res, 200, { ok: true, id, archived });
			// 归档**之后**才导快照，而且是**异步**的：响应不等它（归档该多快就多快）。
			// 失败只记日志 —— 快照是锦上添花，**绝不允许它破坏归档本身**。
			// 每次归档都重导：归档可逆（发消息即复活），复活后再归档拿到的就是新的一份。
			if (archived) {
				exportSnapshot(id).catch((err) => console.error(`[base-logic] 归档快照导出失败 ${id}：${err?.message ?? err}`));
			}
			return true;
		}

		// GET /sessions/{id}/export —— 归档快照（pi 原生 HTML）。有快照且不过期就回它，
		// 没有 / 过期（会话文件更新过）就**现导一次**再回。
		// 也认 HEAD：`curl -sI` 是看这个快照是否存在 / 多新的自然做法（Node 自己会扔掉 body）。
		if ((m === "GET" || m === "HEAD") && seg[0] === "sessions" && seg[2] === "export") {
			const id = seg[1];
			const file = ctx.fileOf(id);
			if (!file) {
				ctx.json(res, 404, { error: "没有这个会话" });
				return true;
			}
			let out = snapshotOf(id);
			try {
				if (snapshotStale(id, file)) out = await exportSnapshot(id);
			} catch (err) {
				// 现导失败：有旧快照就退回旧的（旧的 ≠ 终局，好过 500）；一份都没有才如实报错。
				if (!fs.existsSync(out)) {
					ctx.json(res, 500, { error: `导出快照失败：${err?.message ?? err}` });
					return true;
				}
			}
			let body;
			try {
				body = fs.readFileSync(out);
			} catch (err) {
				ctx.json(res, 500, { error: `读不到快照：${err?.message ?? err}` });
				return true;
			}
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				// 这是个**独立导航**打开的 HTML 文档，别被当成页面内的资源/脚本。
				"X-Content-Type-Options": "nosniff",
			});
			res.end(body);
			return true;
		}

		// POST /sessions/{id}/reload —— 原地重载插件（pi 的 session.reload()）：不丢会话、不重启 A
		if (m === "POST" && seg[0] === "sessions" && seg[2] === "reload") {
			const entry = await ensure(seg[1]);
			const done = await reloadPlugin(entry).catch(() => false);
			ctx.json(res, 200, { ok: true, id: seg[1], reloaded: done, pluginMtimeMs: entry.pluginMtimeMs ?? null });
			return true;
		}

		// POST /reload —— 所有热会话都重载插件
		if (m === "POST" && seg[0] === "reload") {
			let n = 0;
			for (const e of [...ctx.pool.values()]) {
				try {
					if (await reloadPlugin(e)) n++;
				} catch {
					/* 单个失败不挡其他 */
				}
			}
			ctx.json(res, 200, { ok: true, reloaded: n, hot: ctx.pool.size });
			return true;
		}

		// GET /cwd-recents —— 「最近用过哪些目录」（`$ASSIST_HOME/cwd-recents.json` 的只读出口）。
		// 前端的新建会话下拉、插件的 `cwd` 工具 / `/cwd` 补全都读这一条 ⇒ 同一份事实。
		// ⚠️ 坏文件**如实带 error**（绝不静默当空账）；`exists:false` = 还没记过账（不是错）。
		if (m === "GET" && seg[0] === "cwd-recents") {
			const { list, exists, error } = recentsList();
			ctx.json(res, 200, { recents: list, exists, ...(error ? { error } : {}) });
			return true;
		}

		// GET /env?cwd=<path> —— 只读：这个 cwd 的 git 事实 + 还有哪些会话在这里
		if (m === "GET" && seg[0] === "env") {
			const u = new URL(req.url ?? "/", "http://localhost");
			ctx.json(res, 200, envInfo(u.searchParams.get("cwd") ?? ctx.DEFAULT_CWD));
			return true;
		}

		// GET /registrations —— 「这一轮结束了叫我」的登记表（验证 / 将来树上「待验收」标记都用它）
		if (m === "GET" && seg[0] === "registrations") {
			ctx.json(res, 200, notifyState());
			return true;
		}

		// GET /plugin-watch —— 插件自动重载的观测：最近一次触发、这次重载了几个、还挂着几个。
		// ⚠️ 为什么不在 `GET /host`：那个是宿主的**逃生门**（宿主自己拦住，逻辑层够不着），
		// 而宿主不许改 —— 想并进 /host 得改 server/base.mjs。这里给的是等价的一份（宿主重启后再并）。
		if (m === "GET" && seg[0] === "plugin-watch") {
			ctx.json(res, 200, watchState());
			return true;
		}

		// GET /tree
		if (m === "GET" && seg[0] === "tree") {
			ctx.json(res, 200, tree());
			return true;
		}

		// GET /live —— 池里有什么（顺手带上插件 watcher 的观测）
		if (m === "GET" && seg[0] === "live") {
			ctx.json(res, 200, {
				hot: [...ctx.pool.values()].map(status),
				count: ctx.pool.size,
				sessions: ctx.SESSIONS,
				pluginWatch: watchState(),
				notify: notifyState(),
			});
			return true;
		}

		// ─────── 阅读页 API ───────
		//
		// ⚠️⚠️ **这是"任意文件写"的门**：B 零认证、默认绑 0.0.0.0 ⇒ 能连上它 = 能改根里的 .md。
		// 根由上面的 `resolvePageRoots()` 按请求解析（env > paths.json > `$ASSIST_HOME/pages`）；
		// 坏配置直接报错，绝不静默换根。每条路径仍过 `resolveUnderRoot()`（绝对路径 / `..` / 越根 /
		// 非 .md / 软链逃逸 ⇒ 403）；epub 根缺省继承 page root。
		//
		// ⚠️ 为什么用**动态** import 而不是文件顶部的静态 import：`loadLogic()` 是
		// `import(base-logic.mjs?v=<ts>)` —— 查询串**不会**被子模块继承，静态 import 会让
		// `page-store.mjs` 永远停在第一次加载的那份（改了它、热重载了，跑的还是旧代码 —— 这个坑
		// 本仓在插件层踩过）。这里把 `?v=` 手动续上，让它们跟着逻辑层一起重载。
		if ((seg.length === 1 || seg.length === 2) && seg[0] === "pages" && (m === "GET" || m === "POST")) {
			try {
				const { store, rootSource, epubRootSource, PageError } = await pagesStore();
				try {
					// ── «按一下»：读者在阅读页上写完 → **先落盘，再投递** ──
					if (m === "POST" && seg[1] === "press") {
						const b = await body(req);
						const resolved = store.resolvePage(String(b.path ?? ""), { mustExist: true });
						if (!resolved.ok) throw new PageError(resolved.status, resolved.reason, { detail: resolved.detail });
						const rel = resolved.rel;
						// ① **先落盘**（要么全写、要么一个字节不写）
						const saved = await store.press(rel, { edits: b.edits ?? [], dryRun: b.dryRun === true });
						const binding = bindingOf(rel);
						const message = buildPressMessage({ rel, abs: resolved.abs, applied: saved.applied });
						const reply = (status, payload) => ctx.json(res, status, { ok: status === 200, path: rel, message, binding: bindingOf(rel), ...payload });

						// 没有新写的字 ⇒ 什么也不做（**也就不投递**）—— "连点两次"在服务端就是这条：
						// 第二次的编辑与文件里的逐字一致 ⇒ no-op ⇒ 不写、也不重复发。
						if (!saved.wrote) {
							reply(200, { saved, delivered: { ok: false, reason: saved.wouldWrite ? "dry-run" : "nothing-new" } });
							return true;
						}
						// ② 投递（走**同一条**发消息路 `deliver()`——不另造第二条）
						let sessionId = b.sessionId ? (ctx.resolveId(String(b.sessionId)) ?? String(b.sessionId)) : (binding?.sessionId ?? null);
						let created = false;
						try {
							if (!sessionId) {
								// 没绑定 ⇒ **自动建一条并绑上**（代价：第一次"按一下"会顺手建一条会话；见协议文档）
								const e = await create({ name: `阅读：${path.basename(rel)}` });
								sessionId = e.id;
								created = true;
							}
							// 绑定**在投递之前**落：投递失败也要留下"本该发给谁"这条痕
							setBinding(rel, { sessionId, boundBy: b.sessionId ? "manual" : created ? "auto-created" : (binding?.boundBy ?? "auto"), boundAt: binding?.boundAt ?? Date.now(), lastPressAt: Date.now() });
							if (!ctx.fileOf(sessionId)) {
								reply(502, { saved, delivered: { ok: false, reason: "session-missing", sessionId, hint: "这一页绑的会话文件不在了 —— 带 sessionId 再按一次就重新绑" } });
								return true;
							}
							// 归档只是"默认不显示"，不是终态 —— 发消息即复活（与 /sessions/{id}/message 同一规矩）
							if (readArchive()[sessionId]) setArchived(sessionId, false);
							const entry = await ensure(sessionId);
							const out = await deliver(entry, message, b.behavior ?? null);
							setBinding(rel, { lastDeliveryAt: Date.now(), lastDeliveryOk: out.accepted !== false });
							if (out.accepted === false) {
								// ⚠️ **存了但没发出去** —— 如实报（502），绝不装成功；也不回滚已存下的字
								reply(502, { saved, delivered: { ok: false, reason: "rejected", sessionId, error: out.error ?? "pi 没接这条消息" } });
								return true;
							}
							broadcastPage(rel, store);
							reply(200, { saved, delivered: { ok: true, sessionId, created, streaming: out.streaming, behavior: out.behavior ?? null } });
							return true;
						} catch (e) {
							// 投递路上任何异常：**字已经存了**，如实说清
							reply(502, { saved, delivered: { ok: false, reason: "delivery-failed", sessionId, error: String(e?.message ?? e) } });
							return true;
						}
					}

					if (m === "GET") {
						const params = u0(req).searchParams;
						if (!params.has("path")) {
							// 顺带把每页绑的会话报出来（页选择器要用）
							const binds = readBindings();
							ctx.json(res, 200, { ok: true, root: store.root, epubRoot: store.epubRoot, rootSource, epubRootSource, warning: PAGES_WARNING, pages: store.listPages().map((p) => ({ ...p, binding: binds[p.path] ?? null })) });
						} else {
							// `?path=`（给了但空）**不是**"列清单" —— 那是一个人以为自己在指某一页。⇒ 400。
							const withText = params.get("text") !== "0";
							const rel = params.get("path") ?? "";
							ctx.json(res, 200, { ok: true, root: store.root, epubRoot: store.epubRoot, rootSource, epubRootSource, warning: PAGES_WARNING, binding: bindingOf(rel), ...store.readPage(rel, { withText }) });
						}
					} else {
						const b = await body(req);
						if (b.op === "extract") ctx.json(res, 200, { ok: true, ...store.extract(b) });
						else if (b.op === "list-paragraphs") ctx.json(res, 200, { ok: true, ...store.listParagraphsOf(b) });
						// 只读：给工具用的两个索引（章节树 / 按关键词找段）
						else if (b.op === "outline") ctx.json(res, 200, { ok: true, ...store.outlineOf(b) });
						else if (b.op === "search") ctx.json(res, 200, { ok: true, ...store.searchOf(b) });
						else if (b.op === "find-epub") ctx.json(res, 200, { ok: true, ...store.findEpub(b.name) });
						else {
							const r = await store.apply(b.path, b);
							// **回流**：写动了就广播（前端不刷新也能看到）
							if (r.wrote) {
								if (b.op === "materialize-source" && b.section) setBinding(b.path, { epub: b.epub ?? null, file: b.file ?? null, epubId: b.epubId ?? null });
								broadcastPage(b.path, store);
							}
							ctx.json(res, 200, { ok: true, path: b.path, ...r });
						}
					}
				} catch (e) {
					if (e instanceof PageError) ctx.json(res, e.status, { ok: false, error: e.reason, ...e.extra });
					else throw e;
				}
			} catch (e) {
				// 根解析也在这里报错：保留明确原因，绝不把坏 paths.json 静默当默认根。
				if (Number.isInteger(e?.status) && e?.reason) ctx.json(res, e.status, { ok: false, error: e.reason, ...e.extra });
				else {
					// 逻辑/存储层自己有毛病（语法错、import 失败）—— **如实报**，不假装 404。
					ctx.json(res, 500, { ok: false, error: "pages-module-error", detail: String(e?.message ?? e) });
				}
			}
			return true;
		}

		return false;
	}

	return { handle };
}
