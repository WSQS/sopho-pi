/**
 * 从模型回复里抠分诊结论 —— 纯函数，单独成文件是为了能被测试（见 test-triage-parse.mjs）。
 *
 * 为什么要这么麻烦（这几点踩过）：
 *
 *   1. **推理模型会把系统提示里的格式模板原样抄进 reasoning_content。**
 *      reasoning 里会出现 `{"clarity":"clear"或"vague","note":"一句话理由"}` ——
 *      它长得像答案但不是答案。简单取「第一个 {…}」会把它认成结果，然后报「clarity 取值非法」。
 *
 *   2. **`/\{[\s\S]*\}/` 是贪心的。** 从第一个 `{` 一路吃到最后一个 `}`，
 *      中间夹着解释文字/多个对象，JSON.parse 必挂 —— 于是「模型明明给了答案」却判成解析失败。
 *
 * 做法：按括号配对（跳过字符串与转义）切出每个候选顶层对象，逐个 parse，
 * 返回**第一个 clarity 取值合法**的。前后有散文、包着代码块、模板在前答案在后，都能应付。
 */

/**
 * 抠出分诊结论。
 * @param {string} text 模型回复（content 或 reasoning_content）
 * @returns {{clarity: "clear"|"vague", note: string} | null} 抠不到合法结论时返回 null
 */
export function pickVerdict(text) {
	if (!text) return null;
	for (const candidate of jsonObjects(text)) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const clarity = parsed?.clarity === "clear" ? "clear" : parsed?.clarity === "vague" ? "vague" : null;
		if (clarity) return { clarity, note: String(parsed?.note ?? "") };
	}
	return null;
}

/** 扫出所有括号配对的顶层 JSON 对象子串（字符串/转义里的 { } 不算）。 */
export function* jsonObjects(text) {
	let depth = 0;
	let start = -1;
	let inStr = false;
	let esc = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
		} else if (c === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (c === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				yield text.slice(start, i + 1);
				start = -1;
			}
		}
	}
}
