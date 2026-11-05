/**
 * M2 的无头验收测试：开新会话 → 流式收事件 → 发消息 → 看到跑完。
 *
 * 刻意不依赖浏览器：SSE 是纯文本协议，这里用原生 http 直接读，
 * 比"打开页面肉眼看"更可靠，也能进 CI。
 *
 * 跑法：
 *   ASSIST_HOME=/tmp/t9 SOPHO_AGENT_DIR=~/.pi/profiles/assistant SOPHO_PORT=7322 \
 *     node server/index.mjs &
 *   SOPHO_BASE=http://127.0.0.1:7322 node server/test-stream.mjs
 */
import * as http from "node:http";

const BASE = process.env.SOPHO_BASE ?? "http://127.0.0.1:7321";
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(2).padStart(7);

async function post(path, body) {
	const r = await fetch(BASE + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
}

/** 极简 SSE 客户端：按 \n\n 切事件，只认 data: 行。 */
function sse(file, onEvent) {
	const url = `${BASE}/api/stream?p=${encodeURIComponent(file)}`;
	const req = http.get(url, (res) => {
		console.log(`  ${stamp()}s  ── SSE 已连接 (${res.statusCode})`);
		let buf = "";
		res.setEncoding("utf8");
		res.on("data", (chunk) => {
			buf += chunk;
			let i;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const raw = buf.slice(0, i);
				buf = buf.slice(i + 2);
				for (const line of raw.split("\n")) {
					if (!line.startsWith("data: ")) continue; // ": ka" 心跳忽略
					try {
						onEvent(JSON.parse(line.slice(6)));
					} catch {
						// 坏帧忽略
					}
				}
			}
		});
	});
	req.on("error", (e) => console.log("  SSE 错误:", e.message));
	return req;
}

// ─────────────────────────── 跑 ───────────────────────────

console.log(`\n目标: ${BASE}\n`);

const created = await post("/api/new", {});
if (created.status !== 201) {
	console.error("建会话失败:", created.status, created.body);
	process.exit(1);
}
const file = created.body.file;
console.log(`  ${stamp()}s  ── 新会话 ${file}`);
console.log(`              cwd=${created.body.status.cwd} model=${created.body.status.model}\n`);

let helloed = false;
let runEnded = false;
let textBuf = "";

sse(file, (ev) => {
	switch (ev.t) {
		case "hello":
			helloed = true;
			console.log(`  ${stamp()}s  hello  streaming=${ev.status.streaming} messages=${ev.status.messages}`);
			break;
		case "text":
			textBuf += ev.d;
			break;
		case "thinking":
			break;
		case "tool":
			console.log(`  ${stamp()}s  tool   ${ev.phase}  ${ev.name}${ev.error ? "  ❌" : ""}`);
			break;
		case "run":
			console.log(`  ${stamp()}s  run    ${ev.phase}`);
			if (ev.phase === "end") runEnded = true;
			break;
		case "error":
			console.log(`  ${stamp()}s  ❌ ${ev.message}`);
			break;
	}
});

// 等 SSE 连上再发，否则会漏掉开头的事件
for (let i = 0; i < 50 && !helloed; i++) await new Promise((r) => setTimeout(r, 100));
if (!helloed) {
	console.error("SSE 没连上");
	process.exit(1);
}

const pr = await post("/api/prompt", { file, text: "只回复两个字：收到" });
console.log(`\n  ${stamp()}s  ── prompt → HTTP ${pr.status} ${JSON.stringify(pr.body)}\n`);

for (let i = 0; i < 90 && !runEnded; i++) await new Promise((r) => setTimeout(r, 1000));

console.log(`\n  ${stamp()}s  ── 流式收到的文本: ${JSON.stringify(textBuf)}\n`);

// 收完再核对文件里到底落了什么（流式是过程，文件是结果）
const hist = await (await fetch(`${BASE}/api/session?p=${encodeURIComponent(file)}`)).json();
const assistantMsgs = (hist.messages ?? []).filter((m) => m.role === "assistant" && m.text);
console.log(`  文件里: ${hist.messages?.length ?? 0} 条可显示消息，助手文本 ${assistantMsgs.length} 条`);
for (const m of assistantMsgs.slice(-2)) console.log(`         助手: ${m.text.slice(0, 60)}`);

const pass = runEnded && assistantMsgs.length > 0;
console.log(`\n  ${pass ? "✅ 通过 —— 流式 + 落盘都对" : "❌ 不通过"}\n`);
process.exit(pass ? 0 : 1);
