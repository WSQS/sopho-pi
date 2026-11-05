/**
 * sopho-pi 服务器 —— M1（只读）
 *
 * 目标只有一个：**一屏看清"我有哪些事、哪件在等我、它们的会话在哪"**。
 * 所以这一版没有输入框、没有流式、没有写操作。先把结构看对。
 *
 * 零依赖：node:http + 静态文件。
 *
 * 路由
 *   GET /                  前端
 *   GET /api/tree          事项 + 它们的会话 + 未关联的会话
 *   GET /api/session?p=…   单个会话的正文（只读）
 *
 * 跑法：npm start        （或 node server/index.mjs）
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { itemOfSession, linkSession, noticeItem, planItemSession, readSession, readTree, reopenIfClosed, sessionParent } from "./sessions-api.mjs";
import { acquire, createConversation, live, pendingReports, prompt, publishReport, shutdownAll, status, subscribe } from "./runtime-pool.mjs";
import { QUOTA, chainsSnapshot, onExecReported, onExecSettled, stopChain } from "./auto-continue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const PORT = Number(process.env.SOPHO_PORT ?? 7321);
const HOST = process.env.SOPHO_HOST ?? "127.0.0.1";
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);

/**
 * 令牌 —— **可选，默认关闭**。
 *
 * 不设 SOPHO_TOKEN 就不做任何检查（= 和以前一样）。
 *
 * 为什么留着这个开关：这个服务器能把消息送进 agent，而 agent 有 bash ——
 * 也就是**任何能访问到它的人都能在这台机器上执行命令**。你确认过当前网络
 * 是可信的，所以默认不拦；哪天环境变了，一个环境变量就能开。
 */
const TOKEN = process.env.SOPHO_TOKEN ?? "";

/** 恒时间比较，避免用响应时间侧信道逐字节猜令牌。 */
function authed(req, url) {
	if (!TOKEN) return true;
	if (url.pathname === "/api/health") return true; // 健康检查不泄露任何东西
	const given = String(req.headers["x-sopho-token"] ?? url.searchParams.get("t") ?? "");
	if (given.length !== TOKEN.length) return false;
	try {
		return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
	} catch {
		return false;
	}
}

/** 本机所有非内部 IPv4 地址 —— 只为了把可访问的 URL 打印出来。 */
function lanURLs() {
	const out = [];
	for (const ifaces of Object.values(os.networkInterfaces())) {
		for (const i of ifaces ?? []) {
			if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
		}
	}
	return out;
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

function send(res, code, body, type) {
	res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(body);
}

const json = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2), MIME[".json"]);

/** 读并解析 JSON 请求体。有上限 —— 这是本地工具，但不做无上限缓冲。 */
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > limit) {
				reject(new Error("请求体过大"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** 客户端的问题就是 400，不是 500 —— 否则日志里全是假告警。 */
class BadRequest extends Error {}

/** 只有这些状态的事项才值得自动续跑（done/dropped 了就停）。 */
const ACTIVE_STATES = new Set(["open", "blocked_on_human", "waiting_external"]);

/**
 * 为一个事项开一场**新**会话（讨论/执行）。
 *
 * HTTP 入口（/api/item-session）与「手动发令」（扩展的 go → /api/item-session）走这里。
 * 自动续跑（#22/A′）**不再**走这里 —— 它把下一轮发回同一个会话（见 continueChain）。
 * 提示词渲染只在 bin/ledger.mjs 一份（硬约束 #15）。
 */
async function startItemSession(id, kind, parent) {
	const plan = await planItemSession(id, kind);
	const entry = await createConversation(undefined, { parent, name: plan.name });
	try {
		await linkSession(id, kind, entry.file, parent);
	} catch (err) {
		throw new Error(`会话已建，但关联到 #${id} 失败：${err.message}`);
	}
	prompt(entry, plan.prompt); // 不 await —— 进度走 SSE
	return { entry, name: plan.name };
}

const short = (s, n) => {
	const f = String(s ?? "").replace(/\s+/g, " ").trim();
	return f.length <= n ? f : f.slice(0, n - 1) + "…";
};

/**
 * 刹车回问的**摘要** —— 账本 notice 与投递正文都基于它（单一份，避免分叉）。
 */
function quotaSummary(item, runs) {
	return `服务器续跑（#${item.id} ${short(item.text, 24)}）：auto 链已自动跑满 ${runs}/${QUOTA} 轮，已刹车停下。`;
}

/** 额度耗尽时回问上游的**投递正文**：摘要 + 「接下来怎么办」。给投递队列和人看。 */
function quotaNotice(item, runs) {
	return (
		`- ${quotaSummary(item, runs)}\n` +
		`  要继续 → 手动再发一次令（ledger 的 go / 或 /exec ${item.id}）＝ 给一段新额度；\n` +
		`  不要继续 → 不用管，事项停在 [推进中]，等你下次来推。`
	);
}

/**
 * #22：读完 exec 的 auto 标记后，在**后台**续跑。
 *
 * **不 await**：`/api/report` 是 exec 的 `hand_back` 发来的 fetch，让它等「送进下一轮」
 * 才返回毫无必要 —— 续跑慢/失败都不该卡住交回。所以 fire-and-forget，
 * 错误只记日志（续跑失败时链条会停在 `error`，不做失败重试 #12）。
 *
 * A′（#36）：续跑 = 把下一轮发回**同一个会话**（长会话），不再每轮开新会话。
 */
function continueChain(item, file) {
	onExecReported({
		item,
		file,
		upstream: sessionParent(file), // 链条根部（通常是总台）
		openExec: async (id, _parent, turn) => {
			// A′（#36）：不再每轮开新会话 —— 把下一轮发回**同一个会话**（长会话）。
			//
			// “记忆”不靠会话本身连续（上下文会涨满），而靠每轮 exec 把累积理解写进
			// spec/账本（见 defaults/prompt-execute.md）。上下文涨满时的压缩/重开留待后续。
			//
			// behavior = followUp：hand_back 正在这个会话里执行，这一轮还没跑完 ——
			// 等它结束后再把下一轮送进去（steer 会插进当前回合，不是我们要的）。
			const plan = await planItemSession(id, "exec");
			const entry = await acquire(file);
			await reopenIfClosed(file); // 防御：正常路径不写 closed，万一被标了就重开
			prompt(entry, plan.prompt, "followUp");
			console.log(`[sopho-pi] 自动续跑：#${id} 第 ${turn}/${QUOTA} 轮 → ${path.basename(file)}（同一会话）`);
			return { file: entry.file };
		},
		wake: async (target, runs) => {
			console.log(`[sopho-pi] 自动续跑：#${item.id} 额度用满 ${runs}/${QUOTA} → 回问上游`);
			// #29：**投递前先落账本** —— 上游不在池里（方向 2 不投）/ parent 路径
			// 不规范（target=null）时，这条回问仍能从 `a` 的账本里看到。这是 #12
			// 的双写思路在刹车回问上的落地。
			await noticeItem(item.id, quotaSummary(item, runs));
			if (target) publishReport(target, quotaNotice(item, runs));
		},
	})
		.then((r) => {
			if (r.action === "braked") console.log(`[sopho-pi] 自动续跑：#${item.id} 已刹车（等上游确认）`);
			else if (r.action === "error") console.warn(`[sopho-pi] 自动续跑：#${item.id} 开轮失败：${r.error}`);
		})
		.catch((err) => console.error(`[sopho-pi] 自动续跑：#${item.id} 出错：`, err?.message ?? err));
}

/**
 * #26：一轮 exec 结束但**不续跑**时，把还在「running」的链条收尾成 `stopped`。
 *
 * 根因：以前只有 auto 路径（continueChain）会更新链条状态。某轮标了 ask 之后，
 * 链条就再也没人动，`/api/live.auto` 与 Web UI 会一直假报「在跑」。
 *
 * 与 continueChain 同一条按 itemId 的串行队列（在 auto-continue.mjs 里），后台跑、
 * 不阻塞交回 —— 收尾本身很轻，错误只记日志。
 */
function settleChain(item, file) {
	onExecSettled({ item, file })
		.then((r) => {
			if (r.action === "stopped")
				console.log(`[sopho-pi] 自动续跑：#${item.id} 链条停下（下一步标了 ${item.nextKind ?? "ask"}）`);
		})
		.catch((err) => console.error(`[sopho-pi] 自动续跑：#${item.id} 收尾出错：`, err?.message ?? err));
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		if (url.pathname.startsWith("/api/") && !authed(req, url)) {
			return json(res, 401, { error: "需要令牌：用启动日志里带 ?t=… 的地址打开" });
		}

		if (url.pathname === "/api/live")
			return json(res, 200, { live: live(), pendingReports: pendingReports(), auto: chainsSnapshot() });

		// 新建会话（还没关联事项）
		if (url.pathname === "/api/new" && req.method === "POST") {
			const body = await readBody(req).catch((e) => {
				throw new BadRequest(e.message);
			});
			const entry = await createConversation(body.cwd || undefined);
			return json(res, 201, { file: entry.file, status: status(entry) });
		}

		// 为某个事项开会话（讨论/执行）。
		//
		// 会话建在**服务器 runtime 池**里，不在任何 TUI 里 —— 它只出现在 Web UI
		// 的会话列表。请求方（总台的 pi 扩展）因此不需要 ctx.newSession()，也就不会
		// 把自己的会话切走。
		//
		// 提示词由 bin/ledger.mjs 渲染（硬约束 #15）—— 服务器不碰模板。
		// 血缘（parent）同时写进会话文件头和账本 link 两处。
		if (url.pathname === "/api/item-session" && req.method === "POST") {
			const body = await readBody(req).catch((e) => {
				throw new BadRequest(e.message);
			});
			const id = Number(body.id);
			const kind = body.kind;
			if (!Number.isInteger(id)) throw new BadRequest("缺 id");
			if (kind !== "discuss" && kind !== "exec") throw new BadRequest("kind 必须是 discuss 或 exec");
			// 新会话的父亲 = 发起请求的那个会话；没有就留空（它就是一条根会话）。
			const parent =
				typeof body.parent === "string" && body.parent ? path.resolve(body.parent) : undefined;
			let started;
			try {
				started = await startItemSession(id, kind, parent);
			} catch (err) {
				throw new BadRequest(err.message);
			}
			return json(res, 201, {
				file: started.entry.file,
				name: started.name,
				status: status(started.entry),
				item: { id, kind },
			});
		}

		// 下属会话的回报（#12）。两件事：
		//   1. 找到发起它的会话（会话头里的 parentSession）= 上级/总台；
		//   2. 把这行回报交给投递队列 —— 上级空闲就立刻 steer 进去，
		//      正忙就攒着，不在池里就把它的 runtime 拉起来跑一轮。
		//
		// 注意：**写账本不在这里**。账本那条由请求方（hand_back）自己调 `a report` 写。
		// 两者分开是为了：投递失败/服务器重启都不会让回报消失。
		if (url.pathname === "/api/report" && req.method === "POST") {
			const body = await readBody(req).catch((e) => {
				throw new BadRequest(e.message);
			});
			const text = String(body.text ?? "").trim();
			if (!body.file) throw new BadRequest("缺 file");
			if (!text) throw new BadRequest("缺 text");
			const file = path.resolve(String(body.file));
			// #22：exec 收尾时读它的续跑标记（auto/ask），决定要不要自动开下一轮。
			// 标记的事实源是主账本（`a go --kind` / 扩展的 `set_next` 写在 item 上），
			// 不是在回报正文里 —— 服务器不解析回报文本。
			// 放在「有没有上级」之前：有没有人可投递，和标记能不能被读到是两件事。
			const item = await itemOfSession(file);
			if (item?.kind === "exec") {
				const kind = item.nextKind ?? "ask";
				console.log(
					`[sopho-pi] 续跑标记：#${item.id} 执行会话标了 ${kind}` + (item.next ? ` → ${short(item.next, 60)}` : ""),
				);
				// 额度内自动开下一轮；额度耗尽刹车 + 回问上游。
				// 事件驱动：只由「上一轮 exec 结束」（这条 /api/report）触发，不是定时器。
				// 后台跑，不阻塞交回。
				if (kind === "auto" && ACTIVE_STATES.has(item.state)) continueChain(item, file);
				// 不续跑的这一轮（标了 ask，或事项已收尾）也必须收尾链条状态，
				// 否则链条会永远停在 running —— Web UI 假报「在跑」（#26）。
				else settleChain(item, file);
			}
			const target = sessionParent(file); // 不在会话根下 / 没有上级 → null
			if (!target) return json(res, 200, { ok: true, delivered: false, reason: "这个会话没有上级" });
			const who = item ? `#${item.id} ${item.kind === "exec" ? "执行" : "讨论"}会话` : "下属会话";
			// 一行：谁、说了什么、正文在哪个文件。合并时只做拼接。
			const line = `- ${who}（${path.basename(file)}）：\n  ${text}`;
			publishReport(target, line);
			return json(res, 202, { ok: true, delivered: true, target, item: item ?? null });
		}

		// 急停（#22）：停掉某条事项的 auto 链 —— 不再自动开新轮。
		// **不动正在跑的那一轮**：那是用户的会话，abort 会打断它手里正做的事。
		// 要重新发动，手动再发一次令即可（会被当成新链条根部 → 重置额度）。
		if (url.pathname === "/api/auto-stop" && req.method === "POST") {
			const body = await readBody(req).catch((e) => {
				throw new BadRequest(e.message);
			});
			const id = Number(body.id);
			if (!Number.isInteger(id)) throw new BadRequest("缺 id");
			const stopped = stopChain(id);
			console.log(`[sopho-pi] 自动续跑：#${id} ${stopped ? "已急停" : "没有在跑的 auto 链"}`);
			return json(res, 200, { ok: true, stopped, item: id });
		}

		// 发消息。不 await 整轮 —— 进度走 SSE。
		if (url.pathname === "/api/prompt" && req.method === "POST") {
			const body = await readBody(req).catch((e) => {
				throw new BadRequest(e.message);
			});
			if (!body.file) throw new BadRequest("缺 file");
			if (!String(body.text ?? "").trim()) throw new BadRequest("缺 text");
			let entry;
			try {
				entry = await acquire(body.file);
			} catch (err) {
				throw new BadRequest(err.message);
			}
			await reopenIfClosed(body.file); // 有后续消息 = 重开已交回的会话
			const r = prompt(entry, String(body.text), body.behavior);
			return json(res, 202, { ok: true, ...r, status: status(entry) });
		}

		// SSE：某个会话的实时事件流
		if (url.pathname === "/api/stream") {
			const p = url.searchParams.get("p") ?? "";
			let entry;
			try {
				entry = await acquire(p);
			} catch (err) {
				throw new BadRequest(err.message);
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(`data: ${JSON.stringify({ t: "hello", status: status(entry) })}\n\n`);
			const off = subscribe(entry, res);
			// 心跳：不看内容，只为了不让中间的代理/浏览器把长连接的连接断掉
			const ka = setInterval(() => {
				try {
					res.write(": ka\n\n");
				} catch {
					/* 断了下面的 close 会收拾 */
				}
			}, 15_000);
			// ★ 客户端断开只是退订 —— runtime 留着继续跑（这就是“切走还在跑”）
			req.on("close", () => {
				clearInterval(ka);
				off();
			});
			return;
		}

		if (url.pathname === "/api/tree") return json(res, 200, await readTree());

		if (url.pathname === "/api/session") {
			const p = url.searchParams.get("p") ?? "";
			const s = readSession(p);
			if (!s) return json(res, 403, { error: "会话路径不在 sessions 目录内" });
			return json(res, 200, s);
		}

		// 静态文件
		const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
		const file = path.resolve(WEB, rel);
		if (file !== WEB && !file.startsWith(WEB + path.sep)) {
			return send(res, 403, "forbidden", "text/plain; charset=utf-8");
		}
		let body;
		try {
			body = fs.readFileSync(file);
		} catch (err) {
			if (err.code === "ENOENT" || err.code === "EISDIR") {
				return send(res, 404, "not found", "text/plain; charset=utf-8");
			}
			throw err;
		}
		return send(res, 200, body, MIME[path.extname(file)] ?? "application/octet-stream");
	} catch (err) {
		if (err instanceof BadRequest) return json(res, 400, { error: err.message });
		console.error("[sopho-pi]", err);
		return json(res, 500, { error: String(err?.message ?? err) });
	}
});

server.listen(PORT, HOST, () => {
	// pidfile：给 npm run stop 用。pkill -f 在这个项目里不可靠（见 server/stop.mjs 注释）。
	try {
		fs.writeFileSync(path.join(os.tmpdir(), `sopho-pi-${PORT}.pid`), String(process.pid));
	} catch {
		// 写不了就算了，不影响服务
	}
	console.log(`\n  sopho-pi  →  http://localhost:${PORT}${TOKEN ? `/?t=${TOKEN}` : "/"}\n`);
	if (!LOOPBACK) {
		console.log("  局域网可访问：");
		for (const u of lanURLs()) console.log(`    ${u}${TOKEN ? `/?t=${TOKEN}` : "/"}`);
		console.log("\n  提醒：这个端口没鉴权 —— 能访问它的人就能让 agent 在本机执行命令。");
		console.log("       需要时启动加 SOPHO_TOKEN=…，前端会自动带上令牌。\n");
	}
});

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(`\n  端口 ${PORT} 已被占用。先停掉旧的：npm run stop\n`);
		process.exit(1);
	}
	throw err;
});

let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	server.close(); // 不再接受新连接
	try {
		fs.rmSync(path.join(os.tmpdir(), `sopho-pi-${PORT}.pid`), { force: true });
	} catch {
		// 无所谓
	}
	// 等正在跑的会话收尾（把已产生的工具结果落盘）—— 否则关服务器会丢掉这一轮
	await shutdownAll();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
