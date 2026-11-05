/**
 * #22 主体：auto 链决策的无头验收。
 *
 * 这块逻辑（额度、刹车、回问上游、空转算一轮）改服务器代码才生效，而服务器
 * **不能在会话里重启** —— 所以把决策抽成纯函数在这里先验一遍。
 * 真·端到端（服务器自动开轮）仍要用户重启后跑一轮标 auto 的 exec。
 *
 * 跑法：npm run test:auto
 */
import assert from "node:assert/strict";
import { QUOTA, autoInfoFor, chainOf, chainsSnapshot, onExecReported, onExecSettled, reset, stopChain } from "./auto-continue.mjs";

/** 造一个可注入的 openExec / wake，并记下调用。 */
function harness() {
	const opened = [];
	const woken = [];
	return {
		opened,
		woken,
		openExec: async (id, parent, turn) => {
			const file = `/sessions/fake-auto-${turn}.jsonl`;
			opened.push({ id, parent, turn, file });
			return { file };
		},
		wake: (target, runs) => woken.push({ target, runs }),
	};
}

const item = { id: 22, text: "续跑机制" };
const boss = "/sessions/boss.jsonl";
const manual = "/sessions/manual.jsonl";
const autoFile = (turn) => `/sessions/fake-auto-${turn}.jsonl`;
/** 把一条链条跑到想要的轮次：手动第 0 轮 + 依次上报第 1..n 轮。 */
async function reportChain(h, n) {
	let r = await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	for (let turn = 1; turn <= n && r.action === "continued"; turn++) {
		r = await onExecReported({ item, file: autoFile(turn), upstream: null, openExec: h.openExec, wake: h.wake });
	}
	return r;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test(`一条 auto 链连开 K=${QUOTA} 轮后刹车并回问上游`, async () => {
	reset();
	const h = harness();
	// 手动开的第 0 轮标了 auto → 服务器开第 1 轮
	let r = await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "continued");
	assert.equal(r.runs, 1);
	assert.equal(h.opened.length, 1);
	assert.equal(h.opened[0].parent, boss, "自动轮的 parent 应是链条根部");
	assert.equal(h.woken.length, 0);

	// 第 1..K-1 轮继续开
	for (let turn = 1; turn <= QUOTA - 1; turn++) {
		r = await onExecReported({ item, file: autoFile(turn), upstream: null, openExec: h.openExec, wake: h.wake });
		assert.equal(r.action, "continued", `第 ${turn} 轮应继续`);
		assert.equal(r.runs, turn + 1);
	}
	assert.equal(h.opened.length, QUOTA, `应一共自动开了 ${QUOTA} 轮`);
	assert.equal(h.woken.length, 0, "还没到额度，不该回问上游");

	// 第 K 轮报回 → 刹车
	r = await onExecReported({ item, file: autoFile(QUOTA), upstream: null, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "braked");
	assert.equal(h.opened.length, QUOTA, "刹车后不该再开新轮");
	assert.equal(h.woken.length, 1, "额度耗尽应回问上游一次");
	assert.equal(h.woken[0].target, boss);
	assert.equal(chainOf(22).status, "waiting-upstream");

	// 等待上游期间是静止的：再报一次也不开、不再问
	r = await onExecReported({ item, file: autoFile(QUOTA), upstream: null, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "skipped");
	assert.equal(h.opened.length, QUOTA);
	assert.equal(h.woken.length, 1);
});

test("手动再发动一次 = 重置链条、给一段新额度（上游答「继续」的落地方式）", async () => {
	reset();
	const h = harness();
	await reportChain(h, QUOTA);
	assert.equal(chainOf(22).status, "waiting-upstream");
	assert.equal(h.opened.length, QUOTA);

	// 用户又手动开了一轮（新链条根部）→ 额度重置
	const r = await onExecReported({ item, file: "/sessions/manual-again.jsonl", upstream: boss, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "continued");
	assert.equal(r.runs, 1, "新链条从第 1 轮重新起算");
	assert.equal(chainOf(22).status, "running");
});

test("事件驱动：没有下一轮上报，链条不会自己往下滚", async () => {
	reset();
	const h = harness();
	const r = await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "continued");
	assert.equal(h.opened.length, 1);
	// 到此为止不再有人上报（模拟自动开的 exec 一开就无声结束）
	assert.equal(h.opened.length, 1);
	assert.equal(chainOf(22).runs, 1);
});

test("重复回报同一个会话只算一轮（不会多开）", async () => {
	reset();
	const h = harness();
	await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake }); // 开 auto-1
	const afterFirst = h.opened.length;
	await onExecReported({ item, file: autoFile(1), upstream: null, openExec: h.openExec, wake: h.wake }); // 开 auto-2
	const afterSecond = h.opened.length;
	assert.equal(afterSecond, afterFirst + 1);
	// auto-1 再报一次（重复 / 乱序）—— 链条里最新的是 auto-2，所以不该再开
	const r = await onExecReported({ item, file: autoFile(1), upstream: null, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "skipped");
	assert.equal(h.opened.length, afterSecond, "重复回报不该再多开一轮");
});

test("空转也占额度：连开 K 轮后同样撞上刹车", async () => {
	reset();
	const h = harness();
	// 每次 openExec 都成功，但会话立刻结束、下一轮又继续 —— 额度照记
	for (let i = 0; i <= QUOTA; i++) {
		const file = i === 0 ? manual : autoFile(i);
		await onExecReported({ item, file, upstream: i === 0 ? boss : null, openExec: h.openExec, wake: h.wake });
	}
	assert.equal(h.opened.length, QUOTA);
	assert.equal(chainOf(22).status, "waiting-upstream");
});

test("开轮失败 = 链条停下（不做失败重试 #12），且不占额度", async () => {
	reset();
	const h = harness();
	const boom = async () => {
		throw new Error("没有当前动作");
	};
	const r = await onExecReported({ item, file: manual, upstream: boss, openExec: boom, wake: h.wake });
	assert.equal(r.action, "error");
	assert.equal(chainOf(22).status, "error");
	assert.equal(chainOf(22).runs, 0, "没开成不该记额度");
	assert.match(chainOf(22).error, /没有当前动作/);
	// 报错只影响「自动开轮」这件事：没有新会话被开出，也就没有下一轮
	assert.equal(h.opened.length, 0);
});

test("急停：链条停了就不再自动开轮", async () => {
	reset();
	const h = harness();
	await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	// 自动开头一轮会在 autoSessions 里登记；急停后它报回时不该再开新轮
	const before = h.opened.length;
	assert.equal(stopChain(22), true);
	assert.equal(chainOf(22).status, "stopped");
	const r = await onExecReported({ item, file: autoFile(1), upstream: null, openExec: h.openExec, wake: h.wake });
	assert.equal(r.action, "skipped");
	assert.equal(h.opened.length, before);
});

test("autoInfoFor：Web UI 认得出「这场是自动开的第 N 轮」", async () => {
	reset();
	const h = harness();
	await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	const a = autoInfoFor(autoFile(1));
	assert.equal(a.turn, 1);
	assert.equal(a.itemId, 22);
	assert.equal(a.quota, QUOTA);
	assert.equal(a.status, "running");
	assert.equal(autoInfoFor(manual), null, "手动开的那一轮不该被标成自动");
});

test("没有上游时也能跑：刹车仍触发 wake（target=null），由调用方落账本但不投递", async () => {
	reset();
	const h = harness();
	await onExecReported({ item, file: manual, upstream: null, openExec: h.openExec, wake: h.wake });
	for (let turn = 1; turn <= QUOTA; turn++) {
		await onExecReported({ item, file: autoFile(turn), upstream: null, openExec: h.openExec, wake: h.wake });
	}
	assert.equal(chainOf(22).status, "waiting-upstream");
	// #29：没有上游也要调一次 wake —— 账本兜底靠它（投递那半由 target 决定）。
	assert.equal(h.woken.length, 1, "没有上游 → 不投递，但刹车必须通知一次（落账本）");
	assert.equal(h.woken[0].target, null);
});

// ---- #26：链条 stale（某轮标 ask 后 status 停在 running） ----

test("#26 标 ask 的那一轮报回 → 链条停下，不再假报「在跑」", async () => {
	reset();
	const h = harness();
	// 手动轮标了 auto → 服务器开 auto-1，链条 running
	await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake });
	assert.equal(chainOf(22).status, "running");
	assert.equal(autoInfoFor(autoFile(1)).status, "running");
	// auto-1 收尾时下一步标了 ask → 不续跑，但链条状态必须收尾
	const r = await onExecSettled({ item, file: autoFile(1) });
	assert.equal(r.action, "stopped");
	assert.equal(chainOf(22).status, "stopped", "标 ask 后链条不该再是 running");
	assert.equal(chainOf(22).currentFile, null, "会话已结束，不该还指着它当「在跑」");
	assert.equal(autoInfoFor(autoFile(1)).status, "stopped", "Web UI 读到的轮次状态也要是停");
	assert.equal(h.opened.length, 1, "标 ask 不该再开新轮");
	// 停下之后同一会话重复回报不会复活它
	const r2 = await onExecSettled({ item, file: autoFile(1) });
	assert.equal(r2.action, "skipped");
	assert.equal(chainOf(22).status, "stopped");
});

test("#26 收尾只认链条最新一轮：别的会话报回不会误停正在跑的链", async () => {
	reset();
	const h = harness();
	await onExecReported({ item, file: manual, upstream: boss, openExec: h.openExec, wake: h.wake }); // 开 auto-1
	await onExecReported({ item, file: autoFile(1), upstream: null, openExec: h.openExec, wake: h.wake }); // 开 auto-2
	const r = await onExecSettled({ item, file: manual }); // 旧会话（手动轮）的迟到回报
	assert.equal(r.action, "skipped");
	assert.equal(chainOf(22).status, "running", "auto-2 还在跑，不能被误停");
	assert.equal(chainOf(22).currentFile, autoFile(2));
});

test("#26 没有链条的事项标 ask → 空操作，不凭空造链条", async () => {
	reset();
	const r = await onExecSettled({ item, file: manual });
	assert.equal(r.action, "nochain");
	assert.equal(chainOf(22), null);
	assert.deepEqual(chainsSnapshot(), [], "/api/live.auto 不该冒出一条 runs:0 的空链");
});

test("#26 不降级已有含义的状态：waiting-upstream 不被 ask 收尾抹掉", async () => {
	reset();
	const h = harness();
	await reportChain(h, QUOTA); // 跑到额度耗尽刹车
	assert.equal(chainOf(22).status, "waiting-upstream");
	const r = await onExecSettled({ item, file: autoFile(QUOTA) });
	assert.equal(r.action, "skipped");
	assert.equal(chainOf(22).status, "waiting-upstream", "等上游确认的状态比 stopped 更具体，不能降级");
});

// ---- #36 A′：长会话 —— auto 续跑发回**同一个会话**，而不是每轮开新会话 ----

/** A′ 的 openExec：无论第几轮都返回同一个会话文件（服务器 prompt 同一个会话）。 */
function sameSessionHarness(file) {
	const opened = [];
	return {
		opened,
		openExec: async (id, parent, turn) => {
			opened.push({ id, parent, turn, file });
			return { file };
		},
	};
}

test("#36 同一会话续跑：每轮都发回同一个会话，额度照记、到 K 刹车", async () => {
	reset();
	const h = harness();
	const same = "/sessions/long-exec.jsonl";
	const s = sameSessionHarness(same);

	// 手动开的那一轮就是这条长会话；它标了 auto → 服务器开第 1 轮（仍是它自己）
	let r = await onExecReported({ item, file: same, upstream: boss, openExec: s.openExec, wake: h.wake });
	assert.equal(r.action, "continued");
	assert.equal(r.runs, 1);
	assert.equal(s.opened.at(-1).file, same, "续跑必须发回同一个会话，不许新开");
	assert.equal(autoInfoFor(same).turn, 1);

	// 之后每一轮都从**同一个文件**报回
	for (let turn = 1; turn <= QUOTA - 1; turn++) {
		r = await onExecReported({ item, file: same, upstream: null, openExec: s.openExec, wake: h.wake });
		assert.equal(r.action, "continued", `第 ${turn} 轮应继续`);
		assert.equal(r.runs, turn + 1);
	}
	assert.equal(s.opened.length, QUOTA, `应一共自动续了 ${QUOTA} 轮`);
	assert.ok(s.opened.every((o) => o.file === same), "每一轮都必须发回同一个会话");
	assert.equal(chainOf(22).currentFile, same);

	// 第 K 轮报回 → 刹车（额度和旧模型一样，不因共用会话而变）
	r = await onExecReported({ item, file: same, upstream: null, openExec: s.openExec, wake: h.wake });
	assert.equal(r.action, "braked");
	assert.equal(s.opened.length, QUOTA, "刹车后不该再续");
	assert.equal(h.woken.length, 1, "额度耗尽应回问上游一次");
	assert.equal(chainOf(22).status, "waiting-upstream");
});

test("#36 长会话标 ask：同一文件也认得出来，链条收尾不再假报「在跑」", async () => {
	reset();
	const same = "/sessions/long-exec.jsonl";
	const s = sameSessionHarness(same);
	await onExecReported({ item, file: same, upstream: boss, openExec: s.openExec, wake: () => {} });
	assert.equal(chainOf(22).status, "running");
	const r = await onExecSettled({ item, file: same });
	assert.equal(r.action, "stopped");
	assert.equal(chainOf(22).status, "stopped");
	assert.equal(autoInfoFor(same).status, "stopped");
});

console.log("#22 auto 链决策");
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		console.error(`  ✗ ${name}\n    ${err.message}`);
		process.exitCode = 1;
	}
}
if (!process.exitCode) console.log(`\n${tests.length} 项通过`);
