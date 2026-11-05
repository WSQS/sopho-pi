#!/usr/bin/env node
/**
 * triage-parse 的回归测试：`npm run test:triage`
 *
 * 守的是 #33 那个 bug —— 模型给了答案，我们却判成「没给 JSON / 取值非法」。
 * 不连网关、不碰账本，纯函数级。
 */
import { pickVerdict } from "./triage-parse.mjs";

const cases = [
	["纯 JSON", '{"clarity":"clear","note":"明确了"}', "clear"],
	["代码块包裹", '```json\n{"clarity":"vague","note":"缺范围"}\n```', "vague"],
	["前后有散文", '我认为：{"clarity":"clear","note":"ok"}\n以上。', "clear"],
	[
		"reasoning 里先抄模板再给答案（不能认模板）",
		'I must output {"clarity":"clear"或"vague","note":"一句话理由"}\n... 最终 {"clarity":"vague","note":"缺完成判据"}',
		"vague",
	],
	["note 里有花括号/转义引号", '{"clarity":"clear","note":"用 {x} 和 \\"y\\" 表示"}', "clear"],
	["嵌套对象", '{"clarity":"clear","note":"a","extra":{"b":1}}', "clear"],
	["被截断的推理（无完整 JSON）", 'I need to output JSON: {"clarity":"clear"', null],
	["只有模板，没有答案", '格式：{"clarity":"clear"或"vague","note":"一句话理由"}', null],
	["空内容", "", null],
];

let bad = 0;
for (const [name, input, expect] of cases) {
	const got = pickVerdict(input)?.clarity ?? null;
	const ok = got === expect;
	if (!ok) bad++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${JSON.stringify(got)} (expect ${expect})`);
}
console.log(bad ? `\n${bad} 个失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
