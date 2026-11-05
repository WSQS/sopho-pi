/**
 * 自动续跑（#22 主体）—— 链条状态与决策。
 *
 * 背景：exec 收尾时会用 `set_next` 给下一步标 `auto` / `ask`（落在主账本
 * `item.nextKind` 上，见 #22 第一里程碑）。本模块负责「读到 auto 之后怎么办」：
 * 在一段额度 K 内自动开下一轮 exec；额度耗尽就刹车并回问上游。
 *
 * ## 为什么单独一个模块
 *
 * 这段是**纯决策**，两个副作用（开下一轮、唤醒上游）由调用方注入。好处是它能
 * 脱离真实 runtime 测（见 server/test-auto-continue.mjs）—— 服务器代码要重启
 * 才能验，把能测的部分单独拎出来是这里唯一能先跑通的东西。
 *
 * ## 状态只放内存（未决 7：重启不恢复 = 停机即刹车）
 *
 * 「连续自动开了几轮」是**运行期**的东西，不该跨重启存活 —— 服务器重启意味着
 * 链条断了，再开一轮要人重新发动。所以不落账本。（`auto/ask` 那个**标记**仍
 * 落主账本 `item.nextKind`，Web UI 直接渲染它。）
 *
 * ## 空转也算一轮（未决 9）
 *
 * 额度在**开轮时**就记账，不是等它成功。所以自动开的 exec 若立刻结束/报错，
 * 那一轮照样算用掉 —— 连续空转会自己撞上 K 而停，不需要额外的空转检测。
 */
import * as path from "node:path";

/** 额度 K：一条 auto 链最多自动开几轮。用户 09-12 拍板默认 7。 */
export const QUOTA = Number(process.env.SOPHO_AUTO_QUOTA ?? 7);

/** itemId → 链条状态。见 makeChain。 */
const chains = new Map();
/** 会话文件绝对路径 → { itemId, turn }。用来认出「这一轮是我们自动开的」。 */
const autoSessions = new Map();

function makeChain({ itemId, runs, upstream, status, currentFile = null, error = null, startedAt }) {
	const now = Date.now();
	return {
		itemId,
		runs,
		quota: QUOTA,
		upstream, // 链条根部（通常是总台）—— 额度耗尽时回问它
		status, // running | waiting-upstream | stopped | error
		currentFile,
		error,
		startedAt: startedAt ?? now,
		updatedAt: now,
	};
}

/** 某条事项当前的 auto 链（没有就 null）。 */
export function chainOf(itemId) {
	return chains.get(itemId) ?? null;
}

/** 所有链条的快照 —— /api/live 给 Web UI 渲染。 */
export function chainsSnapshot() {
	return [...chains.values()].map((c) => ({ ...c }));
}

/**
 * 某个会话文件是不是我们自动开的？是的话给出它的轮次与链条状态。
 * runtime-pool 的 status() 用它，让 Web UI 的会话行能标「自动第 N 轮」。
 */
export function autoInfoFor(file) {
	const a = autoSessions.get(path.resolve(file));
	if (!a) return null;
	const ch = chains.get(a.itemId);
	return {
		itemId: a.itemId,
		turn: a.turn,
		quota: QUOTA,
		runs: ch?.runs ?? a.turn,
		status: ch?.status ?? "running",
	};
}

export function isAutoSession(file) {
	return autoSessions.has(path.resolve(file));
}

/** 注册一场我们自动开的会话。开完之后必须登记，否则下一轮会被误当成「手动」。 */
export function registerAutoSession(file, itemId, turn) {
	autoSessions.set(path.resolve(file), { itemId, turn });
}

/**
 * 急停：停掉某条事项的 auto 链 —— 不再自动开新轮。
 * **不动正在跑的那一轮**（那是用户的会话，abort 会打断它正在做的事）。
 * 要重新发动，手动再发一次令即可（会被当成新链条根部）。
 */
export function stopChain(itemId) {
	const ch = chains.get(itemId);
	if (!ch) return false;
	ch.status = "stopped";
	ch.currentFile = null;
	ch.updatedAt = Date.now();
	return true;
}

/**
 * 一轮 exec 结束但**不续跑**（下一步标了 ask，或事项已收尾）时的链条收尾。
 *
 * #26：以前没有这段 —— `/api/report` 只在 `nextKind === "auto"` 时才碰链条
 * （continueChain）。于是「上一轮 auto 还开着、这一轮标了 ask」时，链条状态再也没人
 * 动它，永远停在 `running`，`/api/live.auto` 与 Web UI 就假报「在跑」。
 *
 * 保守实现：只把**还在 running** 且**这一轮就是链条最新一轮**的链条关成 `stopped`。
 * - `waiting-upstream` / `error` / `stopped` 不降级（各有别的含义，不能被后来的 ask 抹掉）；
 * - 不是链条最新一轮的回报（重复 / 乱序 / 另一条会话）不会误停正在跑的链。
 * - 没有链条 → 空操作，不凭空造条目（否则 /api/live 会多出 `runs:0` 的空链）。
 */
export function onExecSettled({ item, file }) {
	return serialize(item.id, () => {
		const ch = chains.get(item.id);
		if (!ch) return { action: "nochain" };
		if (ch.status !== "running") return { action: "skipped", reason: `链条不是 running（是 ${ch.status}）` };
		if (ch.currentFile && path.resolve(ch.currentFile) !== path.resolve(file)) {
			return { action: "skipped", reason: "不是链条最新一轮的回报" };
		}
		ch.status = "stopped";
		ch.currentFile = null; // 会话已经结束，别再指着它当「在跑」
		ch.updatedAt = Date.now();
		return { action: "stopped", runs: ch.runs };
	});
}

/** 测试用：清空全部状态。 */
export function reset() {
	chains.clear();
	autoSessions.clear();
	locks.clear();
}

// 未决 8：同一事项的续跑决策**串行化**。因为决策内部有 await（开下一轮会话），
// 并发回报可能读到同一个 `used` 而各开一轮。按 itemId 排一条链，后到的排前面之后。
const locks = new Map();
function serialize(key, fn) {
	const prev = locks.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn); // 前一个成/败都继续 —— 一个报错不该卡死后续
	locks.set(
		key,
		next.then(
			() => {},
			() => {},
		),
	);
	return next;
}

/**
 * 一轮 exec 结束时的续跑决策。调用方（/api/report）已经确认 `item.nextKind === "auto"`。
 *
 * 三条规则：
 *   1. **手动开的那一轮 = 链条根部**：重置链条，额度从 0 起算（也是「上游答继续」
 *      的落地方式 —— 手动再发动一次就是给一段新额度）。
 *   2. 自动开的第 N 轮报回：N < K → 开第 N+1 轮；N ≥ K → 刹车 + 回问上游。
 *   3. 刹车/急停过的链条不再自动开；只有「最新那一轮的回报」能推进链条。
 *   4. 同一事项的多次回报串行处理（未决 8）。
 *
 * @param {object}   p
 * @param {{id:number,text:string}} p.item  刚报回的事项
 * @param {string}   p.file                 刚结束的 exec 会话文件
 * @param {string?}  p.upstream             它的上级（sessionParent）—— 只有手动轮会用它当链条根部
 * @param {(id:number,parent:string?,turn:number)=>Promise<{file:string}>} p.openExec 开下一轮
 * @param {(target:string|null,runs:number)=>void|Promise<void>} [p.wake]
 *        刹车（额度耗尽）时调用，**无论有没有上游** —— 上游为 null 时调用方仍应
 *        （先）把回问落进账本，只是不投递。这样「上游不在池里 / parent 路径不规范」
 *        时回问也不会静默消失（#29）。
 * @returns {Promise<{action:string, runs?:number, file?:string, error?:string, reason?:string}>}
 */
export function onExecReported(args) {
	// 同一事项串行（未决 8）—— 调用方可以不 await（它常在后台跑）。
	return serialize(args.item.id, () => decide(args));
}

async function decide({ item, file, upstream = null, openExec, wake }) {
	const key = item.id;
	const prev = autoSessions.get(path.resolve(file));
	// 手动轮（没有登记）→ 当成新链条根部：不继承旧链的任何状态与额度。
	const ch = prev ? chains.get(key) : null;

	if (ch?.status === "stopped") return { action: "skipped", reason: "已急停" };
	if (ch?.status === "waiting-upstream") return { action: "skipped", reason: "等上游确认" };
	if (ch?.status === "error") return { action: "skipped", reason: "上一轮开轮失败，已停" };
	// 只有链条里「最新那一轮」的回报才触发续跑 —— 否则同一个会话的重复回报
	// （或乱序到达的旧回报）会各开一轮。
	if (ch?.currentFile && path.resolve(ch.currentFile) !== path.resolve(file)) {
		return { action: "skipped", reason: "不是链条最新一轮的回报" };
	}

	const used = prev?.turn ?? 0;
	const upstreamFile = ch?.upstream ?? upstream ?? null;

	if (used >= QUOTA) {
		// 额度耗尽：刹车，把整个链条停下来，回问上游还继不继续。
		const next = makeChain({
			itemId: key,
			runs: used,
			upstream: upstreamFile,
			status: "waiting-upstream",
			startedAt: ch?.startedAt,
		});
		chains.set(key, next);
		// 刹车**一定**调用 wake（哪怕没有上游）—— 调用方据此先落账本，再决定投不投。
		// 上游不在池里（方向 2 不投）/ parent 路径不规范（target=null）时投递会失败，
		// 但账本里得留下这条回问（#29）。
		if (wake) await wake(upstreamFile, used);
		return { action: "braked", runs: used, upstream: upstreamFile };
	}

	const turn = used + 1;
	let opened;
	try {
		opened = await openExec(key, upstreamFile, turn);
	} catch (err) {
		const message = String(err?.message ?? err);
		chains.set(
			key,
			makeChain({ itemId: key, runs: used, upstream: upstreamFile, status: "error", error: message, startedAt: ch?.startedAt }),
		);
		return { action: "error", error: message };
	}
	chains.set(
		key,
		makeChain({
			itemId: key,
			runs: turn,
			upstream: upstreamFile,
			status: "running",
			currentFile: opened.file,
			startedAt: ch?.startedAt,
		}),
	);
	registerAutoSession(opened.file, key, turn);
	return { action: "continued", runs: turn, file: opened.file };
}
