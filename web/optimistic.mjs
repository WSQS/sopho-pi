/**
 * 乐观用户消息层 —— 按会话文件分桶。
 *
 * 为什么单独一个模块：这块出过 bug（#15）。原来是**一个全局数组**，
 * openSession() 切换会话时重置了 activeMessages / liveRun，却忘了它 ——
 * 于是在会话 A 发出、还没落盘的消息，会显示在随后打开的会话 B 里
 * （直到切回 A、重读文件把它从乐观层里摘掉，才"自愈"）。
 *
 * 做成按 file 分桶 + 纯逻辑（不碰 DOM），切会话时天然互不串；
 * 也便于无头验证（见 web/test-optimistic.mjs）。
 */
export function createOptimistic() {
	/** @type {Map<string, string[]>} file → 还没从文件里读到的消息文本 */
	const byFile = new Map();

	return {
		/** 记下一条尚未落盘的乐观消息（发送时调用）。 */
		add(file, text) {
			const list = byFile.get(file);
			if (list) list.push(text);
			else byFile.set(file, [text]);
		},

		/** 当前这个会话要额外显示（文件里还没有）的乐观消息。 */
		for(file) {
			return byFile.get(file) ?? [];
		},

		/**
		 * 重读历史后对账：文件里已经有的就从乐观层去掉，否则会显示两遍。
		 *
		 * 只动 file 这一个桶 —— 别的会话的乐观消息不受影响，
		 * 这正是修 #15 的关键：重读只清对应会话。
		 */
		reconcile(file, messages) {
			const list = byFile.get(file);
			if (!list) return;
			const landed = new Set(messages.filter((m) => m.role === "user").map((m) => m.text));
			const kept = list.filter((t) => !landed.has(t));
			if (kept.length) byFile.set(file, kept);
			else byFile.delete(file);
		},
	};
}
