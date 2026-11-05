/**
 * S0 spike —— 一个进程里两个会话真的能并发吗？
 *
 * ## 为什么验这个
 *
 * pi 的单前台模型是硬约束：切换会话会 `abort()` + `dispose()`（见
 * dist/core/agent-session-runtime.js 的 teardownCurrent）。所以"切走就断"。
 *
 * pi-web-ui 的解法是**每个会话持有自己的 runtime**（它源码注释：
 * "every open conversation keeps its own runtime"）。但那个项目捆的是
 * pi SDK 0.84.4，我们本地是 0.85.1。**这条地基没验过。**
 *
 * ## 这个 spike 做什么
 *
 *   起两个 AgentSessionRuntime（不同 cwd、不同 sessionDir，互不知道对方）
 *   → 给 A 一个耗时任务（多条 bash，中间 sleep）
 *   → 等 A 真的跑起来
 *   → 给 B 一个短任务
 *   → 记录两条会话所有事件的相对时间戳
 *
 * ## 判定
 *
 *   通过：B 开始之后，A 的事件继续出现，且 A 最终 resolve
 *          → 并发成立，可以按 pi-web-ui 的架构建服务器
 *   不通过：A 在 B 开始后停滞
 *          → 得退回多进程方案（每个会话一个 pi 进程）
 *
 * 跑法：npm run spike
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const ROOT = "/tmp/sopho-pi-spike";
const T0 = Date.now();
const records = [];

const t = () => (Date.now() - T0) / 1000;

function rec(who, type, extra = "") {
	const at = t();
	records.push({ at, who, type, extra });
	const stamp = at.toFixed(2).padStart(7);
	const name = who.padEnd(3);
	console.log(`  ${stamp}s  ${name} ${type}${extra ? `  ${extra}` : ""}`);
}

/** 心跳：证明事件循环没被阻塞，也证明"什么都没发生"不是被卡住。 */
const heartbeat = setInterval(() => rec("·", "tick"), 1500);

/** 把 session 的事件流映射成时间线（只留有用的，text_delta 太吵不记）。 */
function watch(label, session) {
	return session.subscribe((ev) => {
		switch (ev.type) {
			case "agent_start":
				rec(label, "agent_start");
				break;
			case "tool_execution_start":
				rec(label, "tool_start", ev.toolName);
				break;
			case "tool_execution_end":
				rec(label, "tool_end", ev.isError ? "❌ERROR" : "ok");
				break;
			case "agent_end":
				rec(label, "agent_end");
				break;
		}
	});
}

async function makeRuntime(label, cwd, sessionDir) {
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });

	const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd });
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: getAgentDir(),
		sessionManager: SessionManager.create(cwd, sessionDir),
	});
	return { label, runtime, off: watch(label, runtime.session) };
}

// ─────────────────────────── 跑 ───────────────────────────

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nagentDir = ${getAgentDir()}\n`);

const A = await makeRuntime("A", path.join(ROOT, "work-a"), path.join(ROOT, "sessions"));
const B = await makeRuntime("B", path.join(ROOT, "work-b"), path.join(ROOT, "sessions"));
console.log(`两个 runtime 已就绪（A.sessionId=${A.runtime.session.sessionId.slice(0, 8)}  B.sessionId=${B.runtime.session.sessionId.slice(0, 8)}）\n`);

// A 的任务要明显比 B 长：四条命令，命令之间睡 4 秒
const TASK_A =
	"依次运行下面四条 bash 命令，一条一条来，不要合并：\n" +
	"1) date +%s\n2) sleep 4 && date +%s\n3) sleep 4 && date +%s\n4) sleep 4 && date +%s\n" +
	"全部跑完后把四个时间戳列出来。";
const TASK_B = "只回复两个字：收到";

rec("—", "启动 A");
const pA = A.runtime.session
	.prompt(TASK_A)
	.then(() => {
		rec("A", "✅prompt_resolved");
		return "ok";
	})
	.catch((e) => {
		rec("A", "❌prompt_error", e.message);
		return "err";
	});

// 等 A 真的开始跑工具，再把 B 放进去 —— 这样才测得出"交错"
await new Promise((r) => setTimeout(r, 9000));

rec("—", "启动 B（A 应该正在跑）");
const pB = B.runtime.session
	.prompt(TASK_B)
	.then(() => {
		rec("B", "✅prompt_resolved");
		return "ok";
	})
	.catch((e) => {
		rec("B", "❌prompt_error", e.message);
		return "err";
	});

const [ra, rb] = await Promise.all([pA, pB]);
clearInterval(heartbeat);

// ─────────────────────────── 判定 ───────────────────────────

const bStart = records.find((r) => r.who === "B" && r.type === "agent_start");
const aAfterB = records.filter((r) => r.who === "A" && bStart && r.at > bStart.at && r.type !== "tick");
const aToolStarts = records.filter((r) => r.who === "A" && r.type === "tool_start").length;
const bToolStarts = records.filter((r) => r.who === "B" && r.type === "tool_start").length;

console.log("\n" + "═".repeat(64));
console.log("判定");
console.log("═".repeat(64));
console.log(`  A 的工具调用数        : ${aToolStarts}`);
console.log(`  B 的工具调用数        : ${bToolStarts}`);
console.log(`  A 的最终结果          : ${ra}`);
console.log(`  B 的最终结果          : ${rb}`);
console.log(`  B 开始时间            : ${bStart ? bStart.at.toFixed(2) + "s" : "（B 没启动）"}`);
console.log(`  B 开始后 A 的事件数   : ${aAfterB.length}`);
if (aAfterB.length) console.log(`     ${aAfterB.slice(0, 4).map((r) => `${r.at.toFixed(1)}s:${r.type}`).join("  ")}`);

const pass = ra === "ok" && rb === "ok" && !!bStart && aAfterB.length > 0;
console.log(`\n  ${pass ? "✅ 通过 —— 两个会话真的并发，A 没被 B 打断" : "❌ 不通过 —— 需要退回多进程方案"}`);
console.log("═".repeat(64) + "\n");

process.exit(pass ? 0 : 1);
