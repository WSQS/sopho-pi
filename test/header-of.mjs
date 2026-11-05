#!/usr/bin/env node
/**
 * 回归：**会话文件头只读头部就得拿到，而“头部那行超过 8 KB”时必须退回整读。**
 *
 * 被钉住的 bug（性能 + 一个正确性陷阱）：
 *   · 性能：`headerOf` 原来为了拿第一行 `readFileSync` **整个文件**。而 `/tree` 每个节点都调它一次
 *     ⇒ “看一眼树”= 把全部会话字节重读一遍。实测 52 会话 / 113 MB：Linux 61 ms、Windows 447 ms
 *     （Windows 每次文件打开贵 20~55×），而改成只读头 8 KB 后是 0.5 ms / 11 ms。
 *   · 正确性陷阱：只读 8 KB 就**可能读不到换行**（头那一行比 8 KB 长）。这时如果偷懒 `return null`，
 *     上层会把 `null` 当成「cwd 未知」→ **静默落到 `DEFAULT_CWD`** —— 那是语义退化，比慢更坏，
 *     而且在界面上看不出来。所以这条路上必须**退回整读**。
 *
 * 这个测试直接钉那两件事（不吃“看不见的内部状态”，只看 `/tree` 吐出来的 `cwd`）：
 *   ① 头那行 > 8 KB ⇒ `cwd` 仍必须是文件里那个值，**绝不能**等于 `SOPHO_CWD`（= 默认值哨兵）；
 *   ② 头那行 < 8 KB ⇒ 一样；
 *   ③ 头那一行就是整个文件、且**没有结尾换行** ⇒ 一样；
 *   ④ 头真的坏了（不是合法 JSON）⇒ `cwd` 是 `null`（**不是**默认值）—— 别顺手把 null 也“修”成默认值。
 *
 * 自足：起一台**真的 A**（`server/base.mjs` 子进程）指向一个临时 home，里面只放几个**造出来的**
 * 会话文件。不碰任何真实会话目录、不需要 pi、不用固定端口。
 *
 * 跑法：npm run test:header     （通过退出 0；退回路径失效 → 退出 1）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path, { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD_BYTES = 8 * 1024; // 与 server/base.mjs 的 HEAD_BYTES 同值
const DEFAULT_CWD_SENTINEL = "/__sentinel__/this-must-never-show-up-as-a-cwd";
let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};

const freePort = async () => {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const p = s.address().port;
	await new Promise((r) => s.close(r));
	return p;
};

// ── 造一个临时 home：sessions/ 里四个文件 ─────────────────────────────────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-header-"));
const SESS = path.join(HOME, "sessions");
fs.mkdirSync(SESS, { recursive: true });

const uuid = (n) => `01a0${String(n).padStart(4, "0")}-0000-4000-8000-00000000000${n}`;
const put = (n, firstLine, extra = []) => {
	const id = uuid(n);
	const file = path.join(SESS, `2026-09-15T00-00-0${n}-000Z_${id}.jsonl`);
	fs.writeFileSync(file, [firstLine, ...extra].join("\n"));
	return { id, file, firstLine };
};

const CWD_SHORT = "/work/short-cwd";
const CWD_LONG = "/work/long-header-cwd";
const CWD_ONE_LINE = "/work/one-line-no-eol-cwd";
const CWD_BROKEN = "/work/broken-cwd";

// ① 正常小头
const A = put(1, JSON.stringify({ type: "session", cwd: CWD_SHORT, parentSession: null }));
// ② 头那行 > 8 KB：用一个大而无害的字段把第一行撑长，cwd 还是它自己的那个值
const pad = "x".repeat(HEAD_BYTES + 2000);
const B = put(2, JSON.stringify({ type: "session", cwd: CWD_LONG, pad }));
// ③ 只有一行、没有结尾换行
const C = put(3, JSON.stringify({ type: "session", cwd: CWD_ONE_LINE }));
fs.writeFileSync(C.file, C.firstLine); // 覆盖：去掉 put() 加的那个 \n
// ④ 头是坏的（不是合法 JSON）
const D = put(4, "{ this is not json at all " + pad);

// 自证：② 的前 8 KB 里**确实没有换行**，否则这个用例根本没在压退回路径
assert.equal(C.firstLine.includes("\n"), false, "③ 的构造前提：单一一行");
const head8k = fs.readFileSync(B.file).subarray(0, HEAD_BYTES);
assert.equal(head8k.includes(10), false, "② 的构造前提：前 8 KB 里没有换行（这才逼出退回路径）");
assert.ok(fs.statSync(B.file).size > HEAD_BYTES, "② 的构造前提：文件比 8 KB 大");
ok(
	"造出来的用例真的踩在边界上",
	`② 第一行 ${B.firstLine.length} B（前 8 KB 无换行）、③ 单行无 EOL、④ 坏头`,
);

// ── 起真的 A（子进程），SOPHO_CWD = 哨兵 ────────────────────────────────
const PORT = await freePort();
const child = spawn(process.execPath, ["server/base.mjs"], {
	cwd: ROOT,
	env: {
		...process.env,
		ASSIST_HOME: HOME,
		SOPHO_AGENT_DIR: HOME,
		SOPHO_BASE_PORT: String(PORT),
		SOPHO_CWD: DEFAULT_CWD_SENTINEL, // 哨兵：谁悄悄用了默认值，一眼就看出来
		SOPHO_IDLE_TTL_MS: "60000",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const get = (p) =>
	new Promise((res, rej) => {
		http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
			const c = [];
			r.on("data", (d) => c.push(d));
			r.on("end", () => res({ status: r.statusCode, body: Buffer.concat(c) }));
		}).on("error", rej);
	});

let tree = null;
try {
	for (let i = 0; i < 100 && !tree; i++) {
		try {
			const r = await get("/tree");
			if (r.status === 200) tree = JSON.parse(r.body);
		} catch {
			/* 还没起来 */
		}
		if (!tree) await sleep(200);
	}
	assert.ok(tree, `A 没起来。子进程输出：\n${out}`);
	const cwdOf = (id) => (tree.nodes.find((n) => n.id === id) ?? {}).cwd ?? null;

	assert.equal(tree.nodes.length, 4, "四个造出来的会话都该出现在 /tree 里");

	for (const [label, t, want] of [
		["① 正常小头（走 8 KB 那条快路）", A, CWD_SHORT],
		["② 头 > 8 KB（**必须走退回整读**）", B, CWD_LONG],
		["③ 单行无结尾换行", C, CWD_ONE_LINE],
	]) {
		const got = cwdOf(t.id);
		if (got === want) ok(`${label}：cwd 正确`, got);
		else bad(`${label}：cwd 不对`, `期望 ${want}，拿到 ${JSON.stringify(got)}`);
		if (got === DEFAULT_CWD_SENTINEL) bad(`${label}：**静默退化到 DEFAULT_CWD**（SOPHO_CWD 哨兵）`, got);
	}

	// ④ 坏头：null，而不是默认值
	const gotD = cwdOf(D.id);
	if (gotD === null) ok("④ 头是坏 JSON：cwd = null（如实说“读不出”，不冒充默认值）");
	else bad("④ 头是坏 JSON：cwd 该是 null", JSON.stringify(gotD));

	// 顺序守恒：四个都在，且没有一个是哨兵（整体兜底）
	const all = tree.nodes.map((n) => n.cwd);
	if (all.includes(DEFAULT_CWD_SENTINEL)) bad("有节点落到了默认 cwd 上", JSON.stringify(all));
	else ok("没有任何节点落到默认 cwd 上", JSON.stringify(all));
} finally {
	child.kill("SIGKILL");
	fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} 头读取回归：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
