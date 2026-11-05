#!/usr/bin/env node
/**
 * 分诊 worker
 *
 * 由 `a "<文本>"` 在后台以 detached 方式启动的**一次性**进程 —— 跑完就退出，
 * 不是守护进程，不监听任何东西，不持有状态。所以它不属于 S2。
 *
 * 职责只有一个：判断这条事项的描述是否清楚（clear / vague），把结论追加回账本。
 *
 * 判据来自 criteria.md（原样注入，你可以直接改那个文件来调行为）。
 *
 * 环境变量：
 *   ASSIST_HOME            数据家目录（默认 ~/.pi/profiles/assistant）
 *   ASSIST_LEDGER          账本 JSONL 路径
 *   ASSIST_MODELS_JSON     models.json 路径（取网关地址与密钥）
 *
 * 判据文本走 paths.mjs 的 overrides → defaults 查找。
 *   ASSIST_TRIAGE_PROVIDER 默认 litellm
 *   ASSIST_TRIAGE_MODEL    默认 deepseek-flash
 */
import * as fs from "node:fs";
import { LEDGER, MODELS_JSON, readAsset } from "./paths.mjs";
import { pickVerdict } from "./triage-parse.mjs";

// LEDGER / MODELS_JSON 来自 paths.mjs：数据在 ASSIST_HOME，代码在本仓库。
const PROVIDER = process.env.ASSIST_TRIAGE_PROVIDER ?? "litellm";
const MODEL = process.env.ASSIST_TRIAGE_MODEL ?? "deepseek-flash";

/**
 * 输出预算。**别调小。**
 *
 * deepseek-flash 是推理模型：max_tokens 是 completion 的总额，**reasoning_content 先花**，
 * 剩下的才轮到 content。400 时实测 finish_reason=length、content 长度 0、reasoning 上千 token
 * —— 结论是「模型没给 JSON」，其实是没预算写 JSON 了。
 * 判据文本 ~500 token，推理抖动大，2000 给约 6 倍余量（成本仍可忽略：只在分诊时跑一次）。
 */
const MAX_TOKENS = 2000;

const id = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(id)) {
	process.stderr.write("triage: 需要一个数字 id\n");
	process.exit(2);
}

// ── 账本读写（和 ledger.mjs 里那几行重复，故意不共享：
//    worker 必须能独立运行，不能被主 CLI 的改动带崩）─────────────

function readItem(target) {
	let raw;
	try {
		raw = fs.readFileSync(LEDGER, "utf8");
	} catch {
		return null;
	}
	let item = null;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let r;
		try {
			r = JSON.parse(t);
		} catch {
			continue;
		}
		if (r.t === "capture" && r.id === target) {
			item = { id: r.id, text: r.text, createdAt: r.ts, state: r.state ?? "open" };
		} else if (r.t === "update" && r.id === target && item) {
			if (r.state) item.state = r.state;
		}
	}
	return item;
}

function append(record) {
	fs.appendFileSync(LEDGER, JSON.stringify(record) + "\n");
}

function finish(clarity, note) {
	append({
		t: "update",
		id,
		ts: Date.now(),
		clarity,
		note: String(note ?? "").slice(0, 200),
	});
	process.exit(0);
}

// ── 取网关配置 ────────────────────────────────────────────

function gateway() {
	const cfg = JSON.parse(fs.readFileSync(MODELS_JSON, "utf8"));
	const p = cfg?.providers?.[PROVIDER];
	if (!p?.baseUrl) throw new Error(`models.json 里找不到 provider "${PROVIDER}" 的 baseUrl`);
	return { baseUrl: p.baseUrl.replace(/\/+$/, ""), apiKey: p.apiKey ?? "" };
}

// ── 主流程 ──────────────────────────────────────────────────────

const item = readItem(id);
if (!item) finish("error", "账本里找不到这条");
if (item.state !== "open") process.exit(0); // 已经结束的事项不必分诊

const criteriaAsset = readAsset("criteria.md");
if (!criteriaAsset) finish("error", "读不到判据：overrides/criteria.md 或 defaults/criteria.md");
const criteria = criteriaAsset.text;

const SYSTEM = `${criteria}

---
输出要求：**只输出一个 JSON 对象**，不要 markdown 代码块，不要任何解释或前后缀。
格式：{"clarity":"clear"或"vague","note":"一句话理由"}
note 用中文，不超过 40 字。`;

let res;
try {
	const { baseUrl, apiKey } = gateway();
	res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: MODEL,
			temperature: 0,
			max_tokens: MAX_TOKENS,
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: `事项：${item.text}` },
			],
		}),
		signal: AbortSignal.timeout(90_000),
	});
} catch (err) {
	finish("error", `请求失败: ${err.message}`);
}

if (!res.ok) {
	let body = "";
	try {
		body = (await res.text()).slice(0, 120);
	} catch {}
	finish("error", `HTTP ${res.status} ${body}`);
}

let content = "";
let reasoning = "";
let finishReason = "";
try {
	const data = await res.json();
	const choice = data?.choices?.[0];
	content = choice?.message?.content ?? "";
	reasoning = choice?.message?.reasoning_content ?? "";
	finishReason = choice?.finish_reason ?? "";
} catch (err) {
	finish("error", `响应无法解析: ${err.message}`);
}

// content 优先。推理模型可能把预算全烧在 reasoning_content 上导致 content 为空
// （实测 finish_reason=length 且 content 长度 0）—— 这时从 reasoning 里兜底抠一次。
let verdict = pickVerdict(content);
if (!verdict && reasoning) verdict = pickVerdict(reasoning);
if (!verdict) {
	const head = (content || reasoning).slice(0, 60);
	finish(
		"error",
		`模型没给 JSON (finish=${finishReason || "?"}, content ${content.length} 字 / reasoning ${reasoning.length} 字): ${head}`,
	);
}

finish(verdict.clarity, verdict.note);
