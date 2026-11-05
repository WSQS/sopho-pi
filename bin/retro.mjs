#!/usr/bin/env node
/**
 * retro — 复盘账本与复盘会话的入口（#19）
 *
 * 这里管两件事，都只跟「复盘」有关，刻意**不碰** items.jsonl：
 *
 *   1. **复盘账本**（`$ASSIST_HOME/retro/suggestions.jsonl`）：每条建议一条记录。
 *      为什么单独一本：建议要能被结掉（adopted / rejected / parked）、能被统计
 *      「采纳率」。塞进事项账本会污染「轮到我干什么」那列；只写在 md 里则没人翻，
 *      流程会腐烂（#19 未决问题 8）。追加式 JSONL，id 永不复用 —— 同 items.jsonl。
 *
 *   2. **渲染复盘提示词**（`defaults/prompt-retro.md`）。渲染只在这一份，
 *      宿主（服务器的定时器 / 你手工跑）读 `retro prompt --json` 的结果，
 *      不自己拼模板（硬约束 #15）。
 *
 * 存储：`$ASSIST_HOME/retro/`
 *   YYYY-MM-DD.md      当天报告（永久保留）
 *   suggestions.jsonl  复盘账本
 * 记录：
 *   {"t":"suggest","id":1,"ts":...,"date":"2026-09-12","title":"...","target":"...","change":"...","evidence":"..."}
 *   {"t":"status","id":1,"ts":...,"status":"adopted","note":"..."}
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RETRO, RETRO_LEDGER, REPO_ROOT, HOME, SESSIONS, SPECS, assetPath, readAsset } from "./paths.mjs";

const TTY = process.stdout.isTTY;
const C = TTY
	? {
			dim: "\x1b[2m",
			b: "\x1b[1m",
			y: "\x1b[33m",
			r: "\x1b[31m",
			g: "\x1b[32m",
			cy: "\x1b[36m",
			x: "\x1b[0m",
		}
	: { dim: "", b: "", y: "", r: "", g: "", cy: "", x: "" };

/** 建议的生命周期。pending = 还没人动它。 */
const STATUSES = new Set(["pending", "adopted", "rejected", "parked"]);
const STATUS_LABEL = {
	pending: "[待办]",
	adopted: "[已采纳]",
	rejected: "[已否决]",
	parked: "[搁置]",
};
const STATUS_COLOR = { pending: C.y, adopted: C.g, rejected: C.x, parked: C.dim };

// ─────────────────────────── 存储 ───────────────────────────

function readRecords() {
	let raw;
	try {
		raw = fs.readFileSync(RETRO_LEDGER, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	const out = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			// 坏行不致命：跳过继续。和 items.jsonl 一样，一行损坏不该让整本读不出来。
		}
	}
	return out;
}

function append(record) {
	fs.mkdirSync(path.dirname(RETRO_LEDGER), { recursive: true });
	fs.appendFileSync(RETRO_LEDGER, JSON.stringify(record) + "\n");
}

/** 追加式日志折叠成当前状态。id 永不复用。 */
function fold(records) {
	const suggestions = new Map();
	let nextId = 1;
	for (const r of records) {
		if (r.t === "suggest") {
			const id = r.id ?? nextId;
			suggestions.set(id, {
				id,
				date: r.date,
				title: r.title,
				target: r.target,
				change: r.change,
				evidence: r.evidence,
				createdAt: r.ts,
				status: "pending",
				notes: [],
			});
			nextId = Math.max(nextId, id + 1);
		} else if (r.t === "status") {
			const it = suggestions.get(r.id);
			if (!it) continue;
			it.status = r.status;
			if (r.note) it.notes.push({ ts: r.ts, status: r.status, note: r.note });
		}
	}
	return { suggestions: [...suggestions.values()], nextId };
}

const load = () => fold(readRecords());

// ─────────────────────────── 小工具 ───────────────────────────

function fail(msg) {
	console.error(`${C.r}${msg}${C.x}`);
	return 1;
}

const padTo = (s, w) => s + " ".repeat(Math.max(0, w - [...s].reduce((n, ch) => n + (/[\u2e80-\uffff]/.test(ch) ? 2 : 1), 0)));

/** 本地日期 YYYY-MM-DD（复盘按本地日历过日子，不是 UTC）。 */
function localDate(ts = Date.now()) {
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function reportPathFor(date) {
	return path.join(RETRO, `${date}.md`);
}

/**
 * 增量窗口的锚点：**上次复盘是哪天**。取 retro/ 里最新的报告文件名。
 *
 * 为什么用文件名而不是往账本写一条「我复盘过了」：报告文件本身就是那次复盘的
 * 产物，文件在 = 跑过。多写一条记录是同一个事实的第二份副本，会分叉（#19 未决 3
 * 的保守选择 —— 改回来很便宜，先按这个走）。
 */
function lastReportDate(before) {
	let latest = null;
	let names = [];
	try {
		names = fs.readdirSync(RETRO);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
	for (const name of names) {
		const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
		if (!m) continue;
		if (before && m[1] >= before) continue;
		if (!latest || m[1] > latest) latest = m[1];
	}
	return latest;
}

function parseFlags(args) {
	const flags = {};
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
			flags[key] = val;
		} else {
			rest.push(a);
		}
	}
	return { flags, rest };
}

// ─────────────────────────── 命令 ───────────────────────────

/** retro add "<标题>" --target <哪里> --change "<改成什么>" [--evidence "..."] [--date YYYY-MM-DD] */
function cmdAdd(args) {
	const { flags, rest } = parseFlags(args);
	const title = rest.join(" ").trim() || flags.title;
	if (!title) return fail('用法：retro add "<建议标题>" --target <改哪里> --change "<改成什么>" [--evidence "..."]');
	if (typeof flags.target !== "string") return fail("缺 --target：这条建议改哪里？（文件 / 机制 / 流程）");
	if (typeof flags.change !== "string") return fail("缺 --change：具体改成什么？只写「要改进」没用。");
	const date = typeof flags.date === "string" ? flags.date : localDate();
	const { nextId } = load();
	append({
		t: "suggest",
		id: nextId,
		ts: Date.now(),
		date,
		title,
		target: flags.target,
		change: flags.change,
		evidence: typeof flags.evidence === "string" ? flags.evidence : undefined,
	});
	console.log(`${C.dim}记下建议${C.x} ${C.b}#${nextId}${C.x}  ${title}`);
	console.log(`${C.dim}账本：${RETRO_LEDGER}${C.x}`);
	return 0;
}

/** retro list [--json] [--status pending] */
function cmdList(args) {
	const { flags } = parseFlags(args);
	const { suggestions } = load();
	const shown = flags.status ? suggestions.filter((s) => s.status === flags.status) : suggestions;

	if (flags.json) {
		console.log(JSON.stringify({ path: RETRO_LEDGER, retro: RETRO, suggestions: shown, total: suggestions.length }, null, 2));
		return 0;
	}

	if (suggestions.length === 0) {
		console.log(`${C.dim}复盘账本是空的。${C.x}`);
		if (TTY) console.log(`\n记一条：  ${C.b}retro add "标题" --target ... --change ...${C.x}`);
		return 0;
	}

	for (const s of shown) {
		const label = STATUS_COLOR[s.status] + (STATUS_LABEL[s.status] ?? s.status) + C.x;
		console.log(`${padTo(C.b + "#" + s.id, 6)}${C.x} ${s.date}  ${label}  ${s.title}`);
		console.log(`${" ".repeat(18)}${C.dim}改哪里：${s.target}${C.x}`);
		console.log(`${" ".repeat(18)}${C.dim}改成：${s.change}${C.x}`);
		for (const n of s.notes) console.log(`${" ".repeat(18)}${C.dim}↩ ${n.status}${n.note ? ` — ${n.note}` : ""}${C.x}`);
	}
	const pending = suggestions.filter((s) => s.status === "pending").length;
	console.log(`${C.dim}\n共 ${suggestions.length} 条 · 待办 ${pending} 条${C.x}`);
	return 0;
}

/** retro status <id> <pending|adopted|rejected|parked> [--note "..."] */
function cmdStatus(args) {
	const { flags, rest } = parseFlags(args);
	const id = Number.parseInt(rest[0] ?? "", 10);
	const status = rest[1];
	if (!Number.isInteger(id)) return fail("用法：retro status <id> <adopted|rejected|parked|pending> [--note \"...\"]");
	if (!STATUSES.has(status)) return fail(`状态只能是：${[...STATUSES].join(" / ")}`);
	const { suggestions } = load();
	const it = suggestions.find((s) => s.id === id);
	if (!it) return fail(`没有 #${id} 这条建议。用 retro list 看全部。`);
	append({ t: "status", id, ts: Date.now(), status, note: typeof flags.note === "string" ? flags.note : undefined });
	console.log(`${C.dim}已标记${C.x} ${C.b}#${id}${C.x} ${STATUS_LABEL[status]}  ${it.title}`);
	return 0;
}

/**
 * retro prompt [--date YYYY-MM-DD] [--json]
 * 渲染复盘提示词。服务器定时器 / 你手工跑，都读这里的输出。
 */
function cmdPrompt(args) {
	const { flags } = parseFlags(args);
	const date = typeof flags.date === "string" ? flags.date : localDate();
	const since = lastReportDate(date);
	const report = reportPathFor(date);
	const asset = readAsset("prompt-retro.md");
	if (!asset) return fail(`读不到提示词模板 ${assetPath("prompt-retro.md")}`);
	const prompt = asset.text
		.replaceAll("{{date}}", date)
		.replaceAll("{{since}}", since ?? "")
		.replaceAll("{{report}}", report)
		.replaceAll("{{ledger}}", RETRO_LEDGER)
		.replaceAll("{{retro}}", RETRO)
		.replaceAll("{{home}}", HOME)
		.replaceAll("{{sessions}}", SESSIONS)
		.replaceAll("{{specs}}", SPECS)
		.replaceAll("{{cli}}", path.join(REPO_ROOT, "bin", "retro.mjs"));
	const name = `复盘：${date}`;

	if (flags.json) {
		console.log(JSON.stringify({ name, date, since, report, ledger: RETRO_LEDGER, prompt }, null, 2));
		return 0;
	}
	process.stdout.write(prompt);
	return 0;
}

const HELP = `${C.b}retro${C.x} — 复盘账本（#19）

${C.b}复盘账本（建议跟踪）${C.x}
  retro add "<标题>" --target <改哪里> --change "<改成什么>" [--evidence "..."]
  retro list [--json] [--status pending]   看全部建议与采纳状态
  retro status <id> <adopted|rejected|parked|pending> [--note "..."]

${C.b}复盘会话${C.x}
  retro prompt [--date YYYY-MM-DD]   打印当天的复盘提示词（宿主/手工跑都用它）
  retro prompt --json                机器可读：{ name, date, since, report, prompt }

${C.dim}报告：${RETRO}/YYYY-MM-DD.md（永久保留）
账本：${RETRO_LEDGER}
提示词：${assetPath("prompt-retro.md")}${C.x}`;

function main(argv) {
	const [first, ...rest] = argv;
	if (first === undefined || first === "list" || first === "ls") return cmdList(rest);
	if (first === "add") return cmdAdd(rest);
	if (first === "status") return cmdStatus(rest);
	if (first === "prompt") return cmdPrompt(rest);
	if (first === "path") {
		console.log(RETRO_LEDGER);
		return 0;
	}
	if (first === "help" || first === "--help" || first === "-h") {
		console.log(HELP);
		return 0;
	}
	console.error(`${C.r}不认识的动作：${first}${C.x}\n`);
	console.log(HELP);
	return 1;
}

process.exit(main(process.argv.slice(2)));
