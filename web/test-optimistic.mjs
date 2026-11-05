/**
 * 无头验证 #15：乐观用户消息按会话隔离。
 *
 * 回归的是这个 bug —— 在会话 A 发的消息（尚未落盘）会显示在随后打开的
 * 会话 B 里，切回 A 才自愈。根因是乐观层原来是一个全局数组，切会话时
 * 没跟着换。这里只测纯逻辑（web/optimistic.mjs），不需要浏览器。
 *
 * 跑法：node web/test-optimistic.mjs
 */
import { createOptimistic } from "./optimistic.mjs";

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";
const fails = [];
const check = (name, ok) => {
	console.log(`  ${ok ? "✅" : "❌"} ${name}`);
	if (!ok) fails.push(name);
};

console.log("\n乐观用户消息按会话隔离（#15）\n");

// 1. 加了只在它自己的会话里可见
{
	const p = createOptimistic();
	p.add(A, "在 A 说的话");
	check("A 的乐观消息只出现在 A", p.for(A).length === 1 && p.for(B).length === 0);
}

// 2. 回归：切到 B 不会串（等价于 openSession(B)：重置右栏状态，但乐观层不动）
{
	const p = createOptimistic();
	p.add(A, "在 A 说的话");
	check("切到 B 后 B 里没有 A 的话", p.for(B).length === 0);
	check("切回 A 时 A 的话还在（不是靠清空来「修」）", p.for(A).length === 1);
}

// 3. 重读只清对应会话
{
	const p = createOptimistic();
	p.add(A, "A 的话");
	p.add(B, "B 的话");
	p.reconcile(A, [{ role: "user", text: "A 的话" }, { role: "assistant", text: "好的" }]);
	check("A 落盘后 A 的乐观消息消失", p.for(A).length === 0);
	check("对账 A 不影响 B 的乐观消息", p.for(B).length === 1);
}

// 4. 对账不会误杀同会话里还没落盘的另一条
{
	const p = createOptimistic();
	p.add(A, "第一条");
	p.add(A, "第二条");
	p.reconcile(A, [{ role: "user", text: "第一条" }]);
	check("已落盘的清掉、没落盘的留着", p.for(A).length === 1 && p.for(A)[0] === "第二条");
}

console.log(fails.length ? `\n❌ ${fails.length} 条不通过\n` : "\n✅ 全部通过\n");
process.exit(fails.length ? 1 : 0);
