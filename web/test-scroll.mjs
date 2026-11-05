#!/usr/bin/env node
/**
 * 会话正文的滚动跟随行为 + 左栏底部「存档箱」/ 分支折叠的端到端测试。
 *
 * 加载的是**真的** web/index.html + app.mjs + app.css（由本脚本自带的静态
 * 服务器从仓库里读），只把 /api/* 与 EventSource 换成 web/test/mock.js 里的
 * 假实现。因此：
 *   · 不需要 B 在跑，也不需要 A —— 自足、无外部依赖（只要机器上有 chromium）；
 *   · 全程不碰 A 的会话池：不发真 /api/*、不开真 SSE、不写任何会话文件。
 *
 * 跑法：npm run test:scroll       （通过退出 0；任何一项失败退出 1）
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// ─────────────────────────── 0. 准备 ───────────────────────────

// path.resolve 会把尾部分隔符收掉，且两种斜杠都按平台语义处理：
// 这样 WEB_DIR 稳是不带尾分隔符的 …/web（否则下面拼 WEB_DIR + sep 会拼出双分隔符，前缀判断恒假）。
const WEB_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const MOCK = readFileSync(join(WEB_DIR, "test", "mock.js"), "utf8");

const MIME = {
	".html": "text/html; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".map": "application/json; charset=utf-8",
};

/** 只从仓库里读 web/ 下的静态文件。刻意不实现 /api/*：万一 mock 漏了某个
 *  请求，这里会 404 并在页面 console 里报错 —— 测试会因此失败，而不是
 *  悄悄打到真的会话基底上去。 */
function startStaticServer() {
	const srv = createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
		const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
		const file = resolve(WEB_DIR, rel);
		if (file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) return void res.writeHead(403).end("forbidden");
		try {
			const body = await readFile(file);
			res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
			res.end(body);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 " + url.pathname);
		}
	});
	return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

const freePort = () =>
	new Promise((ok, no) => {
		const s = createProbeServer();
		s.on("error", no);
		s.listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			s.close(() => ok(p));
		});
	});

function findChromium() {
	const cands = [process.env.CHROME_BIN, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].filter(Boolean);
	for (const c of cands) {
		// 含分隔符（正反斜杠都算）→ 当路径直接看能不能执行；否则当命令名去 PATH 里找。
		// Windows 的 CHROME_BIN=C:\…\chrome.exe 不含 "/"，旧写法会错误地掉进 sh -c command -v。
		if (c.includes("/") || c.includes("\\")) {
			try {
				accessSync(c, constants.X_OK);
				return c;
			} catch {}
		} else {
			const r = spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" });
			if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
		}
	}
	return null;
}

// ────────────────────── 1. 断言与输出（中文、人看得懂）──────────────────────

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	if (!ok) failed++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  —— ${detail}` : ""}`);
}
const phase = (t) => console.log(`\n── ${t} ──`);
const fail = (name, detail) => check(name, false, detail);

// ─────────────────────────── 2. 起 chromium / 连 CDP ───────────────────────────

const chrome = findChromium();
if (!chrome) {
	console.error(
		"✗ 找不到 chromium / chrome。装一个，或用 CHROME_BIN=/path/to/chromium 指定。" +
			(process.platform === "win32" ? "（Windows 上通常形如 C:\\Users\\<你>\\AppData\\Local\\Chromium\\Application\\chrome.exe，两种斜杠都认）" : ""),
	);
	process.exit(1);
}

const staticSrv = await startStaticServer();
const PAGE = `http://127.0.0.1:${staticSrv.address().port}/`;
const devtoolsPort = await freePort();
const profileDir = mkdtempSync(join(tmpdir(), "sopho-scroll-"));

/** 清理临时 profile 目录。Windows 上好 chrome 退出后文件句柄要过一会儿才释放，
 *  rmSync 会因此抛 EPERM；清理失败不该把整个测试判成失败（退出码只看断言），
 *  所以这里只警告、不抛。maxRetries/retryDelay 让它在句柄刚释放时能自愈。 */
function cleanupProfile() {
	try {
		rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (e) {
		console.warn(`  ⚠ 临时 profile 目录没清掉（不影响测试结果）：${profileDir} —— ${e.code ?? e.message}`);
	}
}

console.log("sopho-pi webui 滚动测试");
console.log(`  页面：真 web/index.html + app.mjs + app.css（自带静态服务器 ${PAGE}）`);
console.log(`  后端：web/test/mock.js 假实现（不发真 /api/*、不开真 SSE、不碰 A 的会话池）`);
console.log(`  浏览器：${chrome}`);

const child = spawn(
	chrome,
	[
		"--headless=new",
		`--remote-debugging-port=${devtoolsPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,700",
		"--disable-gpu",
		"about:blank",
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
let chromeErr = "";
child.stderr.on("data", (d) => (chromeErr += d));

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
		wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
	} catch {}
	if (!wsUrl) await sleep(250);
}
if (!wsUrl) {
	child.kill("SIGKILL");
	staticSrv.close();
	cleanupProfile();
	console.error("✗ chromium 的 devtools 没起来：\n" + chromeErr.slice(-800));
	process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((ok, no) => {
	ws.onopen = ok;
	ws.onerror = (e) => no(new Error("CDP websocket 出错：" + e.message));
});
let seq = 0;
const pending = new Map();
const listeners = [];
const pageProblems = []; // 页面的未捕获异常 / console.error
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id) {
		const p = pending.get(m.id);
		if (p) {
			pending.delete(m.id);
			m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
		}
		return;
	}
	if (m.method === "Runtime.exceptionThrown") pageProblems.push("未捕获异常：" + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageProblems.push("console.error：" + m.params.args.map((a) => a.value ?? a.description).join(" "));
	if (m.method === "Log.entryAdded" && m.params.entry.level === "error") pageProblems.push("页面日志 error：" + m.params.entry.text);
	for (const l of listeners) l(m);
};
const send = (method, params = {}) =>
	new Promise((ok, no) => {
		const id = ++seq;
		pending.set(id, { res: ok, rej: no });
		ws.send(JSON.stringify({ id, method, params }));
	});
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error("页面求值异常：" + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
	return r.result.value;
};

// ─────────────────────────── 3. 页面里的小工具 ───────────────────────────

const HELPERS = `(() => {
	const mb = () => document.querySelector('#messages');
	const row = (id) => [...document.querySelectorAll('#tree .sess')].find(x => x.title.split('\\n')[1] === id);
	window.__h = {
		dist: () => { const m = mb(); return m.scrollHeight - m.scrollTop - m.clientHeight; },
		btn() { const b = document.querySelector('#jump'); return b ? { show: b.classList.contains('show'), display: getComputedStyle(b).display } : null; },
		geom() {
			const b = document.querySelector('#jump'), m = mb();
			if (!b) return null;
			const a = b.getBoundingClientRect(), c = m.getBoundingClientRect();
			return { w: Math.round(a.width), h: Math.round(a.height),
				inside: a.top >= c.top - 1 && a.bottom <= c.bottom + 1 && a.right <= c.right + 1,
				fromRight: Math.round(c.right - a.right), fromBottom: Math.round(c.bottom - a.bottom) };
		},
		up(px) { const m = mb(); m.scrollTop = Math.max(0, m.scrollTop - px); },
		bottom() { const m = mb(); m.scrollTop = m.scrollHeight; },
		frames(n) { return new Promise(r => { let i = n; const f = () => { if (--i <= 0) r(1); else requestAnimationFrame(f); }; requestAnimationFrame(f); }); },
		emit(d) { window.__es && window.__es._emit({ t: 'text', d }); },
		liveLen() { return document.querySelector('#liveBox').textContent.length; },
		rows() { return [...document.querySelectorAll('#tree .sess')].map(r => ({ id: r.title.split('\\n')[1], arch: r.classList.contains('arch'), depth: parseInt(r.style.paddingLeft) })); },
		atticRows() { return [...document.querySelectorAll('#atticList .sess')].map(r => ({ id: r.title.split('\\n')[1], arch: r.classList.contains('arch'), depth: parseInt(r.style.paddingLeft) })); },
		treeArchRoots() { return window.__h.rows().filter(r => r.depth === 10 && r.arch); },
		atticListHidden() { const l = document.querySelector('#atticList'); return !l || l.hidden; },
		liveShape() {
			const m = document.querySelector('#liveBox .msg');
			if (!m) return null;
			return [...m.children].map(c => c.classList.contains('think') ? 'think' : c.classList.contains('body') ? 'text' : c.classList.contains('tool') ? 'tool' : 'other');
		},
		histShape() {
			const ms = [...document.querySelectorAll('#hist .msg.assistant')];
			const m = ms[ms.length - 1];
			if (!m) return null;
			return [...m.children].map(c => c.classList.contains('think') ? 'think' : c.classList.contains('body') ? 'text' : c.classList.contains('tool') ? 'tool' : 'other');
		},
		attic() { const a = document.querySelector('#attic'); return a ? { text: a.textContent.replace(/\\s+/g, ' ').trim(), hidden: a.hidden, display: getComputedStyle(a).display } : null; },
		clickAttic() { const a = document.querySelector('#attic'); if (!a || a.hidden) return false; a.click(); return true; },
		fold(id) { const r = row(id); const f = r && r.querySelector('.fold'); return f ? { mark: f.textContent, none: f.classList.contains('none') } : null; },
		clickFold(id) { const r = row(id); const f = r && r.querySelector('.fold'); if (!f || f.classList.contains('none')) return false; f.click(); return true; },
		atticGeom() {
			const a = document.querySelector('#attic');
			if (!a || a.hidden) return null;
			const list = document.querySelector('#atticList');
			const tree = document.querySelector('#tree'), l = document.querySelector('#left');
			const r1 = a.getBoundingClientRect();
			tree.scrollTop = 400;
			const r2 = a.getBoundingClientRect(), rl = l.getBoundingClientRect();
			const rl2 = list && !list.hidden ? list.getBoundingClientRect() : null;
			const rows = list ? [...list.querySelectorAll('.sess')] : [];
			return { treeScrollable: tree.scrollHeight > tree.clientHeight + 200,
				fixedWhenTreeScrolls: Math.abs(r1.top - r2.top) < 1 && Math.abs(r1.bottom - r2.bottom) < 1,
				drawerBelowButton: rl2 ? rl2.top >= r2.bottom - 1 : false,
				rowsBelowButton: rows.length > 0 && rows.every(x => x.getBoundingClientRect().top >= r2.bottom - 1),
				drawerBottom: rl2 ? Math.abs(rl2.bottom - rl.bottom) < 2 : false,
				fullWidth: Math.abs(r2.left - rl.left) < 2 && Math.abs(r2.right - rl.right) < 2 && (!rl2 || (Math.abs(rl2.left - rl.left) < 2 && Math.abs(rl2.right - rl.right) < 2)),
				w: Math.round(r2.width), h: Math.round(r2.height) };
		},
		// ── 斜杠命令面板 ──
		cmds() { const b = document.querySelector('#cmds'); return b ? { hidden: b.hidden, display: getComputedStyle(b).display } : null; },
		cmdRows() { return [...document.querySelectorAll('#cmds .cmd')].map(r => ({ name: r.dataset.name, sel: r.classList.contains('sel'), src: (r.querySelector('.csrc') || {}).textContent || '', desc: (r.querySelector('.cdesc') || {}).textContent || '', dead: r.classList.contains('dead'), runnable: r.dataset.runnable || null, tag: (r.querySelector('.cdead') || {}).textContent || null, title: r.title || '' })); },
		mousedownCmd(name) { const r = [...document.querySelectorAll('#cmds .cmd')].find(x => x.dataset.name === name); if (!r) return false; r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; },
		confirm() { const c = document.querySelector('#confirm'); return c ? { hidden: c.hidden, display: getComputedStyle(c).display, text: c.textContent || '', buttons: [...c.querySelectorAll('button')].map(b => b.textContent) } : null; },
		clickConfirm(label) { const c = document.querySelector('#confirm'); if (!c || c.hidden) return false; const b = [...c.querySelectorAll('button')].find(x => x.textContent === label); if (!b) return false; b.click(); return true; },
		compactBtn() { const b = document.querySelector('#compact'); return b ? { hidden: b.hidden, text: b.textContent, cls: b.className, title: b.title, display: getComputedStyle(b).display } : null; },
		clickCompactBtn() { const b = document.querySelector('#compact'); if (!b || b.hidden) return false; b.click(); return true; },
		cmdNote() { const h = document.querySelector('#cmds .cmdhint'); const k = document.querySelector('#cmds .cmdkeys'); return { hint: h ? h.textContent : null, keys: k ? k.textContent : null }; },
		cmdScroll() { const b = document.querySelector('#cmds'); if (!b) return null; const s = getComputedStyle(b); return { overflowY: s.overflowY, maxH: s.maxHeight }; },
		// ── 标题（A 的 GET /events 树级 SSE）──
		name(id) { const r = row(id); const n = r && r.querySelector('.nm'); return n ? n.textContent : null; },
		titleOf(id) { const r = row(id); return r ? r.title : null; },
		titleEvent(id, name, source) { return window.__titleEvent(id, name, source); },
		streams() { return { tree: window.__treeES ? window.__treeES.url : null, sess: window.__es ? window.__es.url : null }; },
		headTitle() { const h = document.querySelector('#head .title'); return h ? h.textContent : null; },
		rowsCount() { return document.querySelectorAll('#tree .sess').length; },
		markAlive() { window.__noReload = 'yes'; return true; },
		alive() { return window.__noReload === 'yes'; },
		netCount(p) { return window.__net.filter(x => x.includes(p)).length; },
		// 向**假服务端**问一次：它那边的树里这个名字是什么（证明 DOM 上那个新名字不是从 /tree 来的）
		serverTreeName(id) { return fetch('/api/tree').then(r => r.json()).then(d => (d.nodes.find(n => n.id === id) || {}).name ?? null); },
		setInput(v) { const i = document.querySelector('#input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); },
		key(k, opts) { const i = document.querySelector('#input'); return i.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}))); },
		inputVal() { return document.querySelector('#input').value; },
		inputDisabled() { return document.querySelector('#input').disabled; },
		notice() { const n = document.querySelector('#notice'); return { hidden: n.hidden, text: n.textContent }; },
		bodies() { return window.__bodies.map(b => ({ url: b.url, body: b.body })); },
		// ── 上下文用量 ──
		ctx() { const c = document.querySelector('#ctx'); return c ? { text: c.textContent, cls: c.className, title: c.title } : null; },
		ctxRow() { const h = document.querySelector('#hint').getBoundingClientRect(); const c = document.querySelector('#ctx').getBoundingClientRect(); return { sameRow: Math.abs(h.top - c.top) < 2, hintTop: Math.round(h.top), ctxTop: Math.round(c.top) }; },
		histCount() { return document.querySelectorAll('#hist .msg').length; },
		cut() { const d = document.querySelector('#hist details.cut'); if (!d) return null; const kids = [...document.querySelector('#hist').children]; const i = kids.indexOf(d); return { text: d.querySelector('summary').textContent, body: (d.querySelector('.cutbody') || {}).textContent || '', open: d.open, index: i, msgsBefore: kids.slice(0, i).filter(x => x.classList.contains('msg')).length }; },
		cutOpen() { const d = document.querySelector('#hist details.cut'); if (!d) return null; d.open = true; const b = d.querySelector('.cutbody'); return { open: d.open, visible: b.offsetHeight > 0, body: b.textContent }; },
		// ── 未读（红点 + 树顶那一行）──
		unreadRow(id) {
			const r = row(id);
			if (!r) return null;
			const u = r.querySelector('.u'), run = r.querySelector('.dot.on'), nm = r.querySelector('.nm');
			const cs = u ? getComputedStyle(u) : null, rs = run ? getComputedStyle(run) : null;
			return {
				name: nm ? nm.textContent : null,
				unread: r.classList.contains('unread'),
				dot: !!u,
				bold: nm ? getComputedStyle(nm).fontWeight : null,
				dotBg: cs ? cs.backgroundColor : null,
				dotAnim: cs ? cs.animationName : null,
				dotW: u ? Math.round(u.getBoundingClientRect().width) : null,
				dotCount: r.querySelectorAll(".dot, .u").length, // 一个时刻只该有**一个**点
				running: !!run,
				runBg: rs ? rs.backgroundColor : null,
				runBorder: rs ? rs.borderTopColor : null,
				runAnim: rs ? rs.animationName : null,
			};
		},
		dots() { return [...document.querySelectorAll('#tree .sess')].filter(r => r.querySelector('.u')).map(r => r.title.split('\\n')[1]); },
		unreadBar() { const b = document.querySelector('#unread'); if (!b) return null; return { hidden: b.hidden, display: getComputedStyle(b).display, text: b.textContent.replace(/\\s+/g, ' ').trim(), title: b.title, n: (b.querySelector('.n') || {}).textContent ?? null, above: b.getBoundingClientRect().bottom <= document.querySelector('#tree').getBoundingClientRect().top + 1 }; },
		clickUnreadBar() { const b = document.querySelector('#unread'); if (!b || b.hidden) return false; b.click(); return true; },
		clickRow(id) { const r = row(id); if (!r) return false; r.click(); return true; },
		hash() { return decodeURIComponent(location.hash.slice(1)); },
		activeRow() { const r = document.querySelector('#tree .sess.active'); return r ? r.title.split('\\n')[1] : null; },
		seenPosts() { return window.__net.filter(x => x.includes('/seen')); },
		seenFor(id) { return window.__net.filter(x => x === 'POST /api/sessions/' + id + '/seen').length; },
		localKeys() { return Object.keys(localStorage); },
		unreadState() { return window.__unreadState(); },
		settle(id, at) { window.__settle(id, at); },
		forgetUnread() { sessionStorage.removeItem('mockUnreadState'); },
	};
	return 'ok';
})()`;

const load = async (url) => {
	const loaded = Promise.race([
		new Promise((ok) => listeners.push((m) => m.method === "Page.loadEventFired" && ok("ok"))),
		sleep(8000).then(() => "timeout"),
	]);
	await send("Page.navigate", { url });
	if ((await loaded) === "timeout") throw new Error("导航没等到 load：" + url);
	const probe = String(await ev("document.title + ' | #messages=' + document.querySelectorAll('#messages').length"));
	if (!probe.includes("#messages=1")) throw new Error(`页面没加载对（${url}）：${probe}`);
	await ev(HELPERS); // 新文档 → 重新注入页面辅助函数
};

const DELTA = (i) => `流式第 ${i} 行：` + "中文占位内容".repeat(5) + "\n";
const stream = async (n, ms = 45) => {
	for (let i = 0; i < n; i++) {
		await ev(`__h.emit(${JSON.stringify(DELTA(i))})`);
		await sleep(ms);
	}
};
const settle = async (frames = 3) => {
	await sleep(60);
	await ev(`__h.frames(${frames})`);
};
const snap = async () => ({ dist: Math.round(await ev("__h.dist()")), btn: await ev("__h.btn()"), live: await ev("__h.liveLen()") });
const atBottom = (s) => s.dist <= 4 && s.btn?.show === false;

/** 折叠探针：读标记上的 N → 点一下 → 量树上行数的真实变化 → 再把标记 / 可见 id 读回来。
 *  盯的就是那条不变式：**标记写的 N == 点它真能变的行数，而且一定 ≠ 0**
 *  （"有折叠标记 ⇔ 点它一定会改变可见性"—— 空开关就是 delta === 0 的那种）。 */
const foldProbe = async (id) => {
	const mark = (await ev(`__h.fold(${JSON.stringify(id)})`))?.mark ?? "";
	const before = (await ev("__h.rows()")).length;
	await ev(`__h.clickFold(${JSON.stringify(id)})`);
	await settle(2);
	const rows = await ev("__h.rows()");
	return {
		mark,
		mark2: (await ev(`__h.fold(${JSON.stringify(id)})`))?.mark ?? "",
		n: Number((mark.match(/\d+/) ?? ["?"])[0]),
		delta: rows.length - before,
		ids: rows.map((r) => r.id),
		rows: [before, rows.length],
	};
};

// ─────────────────────────── 4. 跑 ───────────────────────────

let fixture = null;
try {
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Log.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
	await load(PAGE);
	await sleep(300);
	fixture = await ev("window.__fixture");

	const rafOk = await ev(`new Promise(r => { requestAnimationFrame(() => r(1)); setTimeout(() => r(0), 800) })`);
	if (!rafOk) throw new Error("headless 里 requestAnimationFrame 不跑，滚动测试没有意义");

	// ── A 打开会话：forceBottom，直接到底 ──
	phase("A 打开会话");
	await ev(`location.hash = '#' + ${JSON.stringify(fixture.id)}`);
	await settle(4);
	const a = await snap();
	check("打开会话后直接到底（距底 0px、按钮隐藏）", atBottom(a), `距底 ${a.dist}px，按钮 ${a.btn?.show ? "显示" : "隐藏"}`);

	// ── B 主判据：流式中往上滚一点，不该被拽回 ──
	phase("B 流式中往上滚 → 不被拽回底部");
	await stream(5);
	await settle();
	const b0 = await snap();
	await ev("__h.up(60)"); // 往上滚 60px：正落在老代码 120px 陷阱里
	await settle();
	const b1 = { dist: Math.round(await ev("__h.dist()")), btn: await ev("__h.btn()"), geom: await ev("__h.geom()") };
	const samples = [];
	for (let i = 0; i < 12; i++) {
		await ev(`__h.emit(${JSON.stringify(DELTA(100 + i))})`);
		await sleep(50);
		await ev("__h.frames(1)");
		samples.push(Math.round(await ev("__h.dist()")));
	}
	await settle();
	const b2 = await snap();
	check("先确认滚之前贴在底部", b0.dist <= 4, `距底 ${b0.dist}px`);
	check("往上滚 60px 确实滚开了", b1.dist >= 50, `距底 ${b1.dist}px`);
	check("按钮浮出且落在消息区内右下", b1.btn?.show === true && b1.geom?.inside === true, `show=${b1.btn?.show} inside=${b1.geom?.inside} 距右 ${b1.geom?.fromRight}px 距底 ${b1.geom?.fromBottom}px`);
	check(
		`流式 ${samples.length} 次期间一直没被拽回（全程 >50px）`,
		Math.min(...samples) > 50,
		"距底采样 " + JSON.stringify(samples),
	);
	check(
		"视口只被内容推着走、没有跳回底部（距底单调不减）",
		samples.every((v, i) => i === 0 || v >= samples[i - 1] - 1),
		`末端距底 ${b2.dist}px，直播文本长度 ${b2.live}`,
	);

	// ── C 滚回底部：恢复跟随 ──
	phase("C 滚回底部 → 恢复跟随");
	await ev("__h.bottom()");
	await settle();
	const c0 = await snap();
	await stream(3);
	await settle();
	const c1 = await snap();
	check("滚回底部后按钮消失", c0.btn?.show === false, `show=${c0.btn?.show}，距底 ${c0.dist}px`);
	check("继续流式仍贴着底（自动跟随恢复）", atBottom(c1) && c1.live > c0.live, `距底 ${c1.dist}px，直播文本 ${c0.live} → ${c1.live}`);

	// ── D 容忍阈值：只滚 2px 仍算贴底 ──
	phase("D 只滚 2px 仍算贴底");
	await ev("__h.up(2)");
	await settle();
	await stream(3);
	await settle();
	const d = await snap();
	check("2px 视为贴底：不显示按钮、继续跟到底", atBottom(d), `距底 ${d.dist}px，按钮 ${d.btn?.show ? "显示" : "隐藏"}`);

	// ── E 不跟随时发消息：forceBottom → 到底 ──
	phase("E 滚开时发消息 → 回到并跟随底部");
	await ev("__h.up(90)");
	await settle();
	const e0 = await snap();
	await ev(`(() => { const i = document.querySelector('#input'); i.value = '测试发送'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await ev("__h.frames(2)");
	await ev(`document.querySelector('#send').click()`);
	await sleep(250);
	await settle(4);
	const e1 = { ...(await snap()), net: await ev("__net.slice(-4)") };
	check("发消息前确实处于「不跟随」", e0.dist > 50 && e0.btn?.show === true, `距底 ${e0.dist}px`);
	check("发消息后直接到底、按钮消失", atBottom(e1), `距底 ${e1.dist}px，请求 ${JSON.stringify(e1.net.at(-1))}`);

	// ── F 冷启动就带 hash：也直接到底 ──
	phase("F 带 hash 冷启动");
	await load(`${PAGE}?cold=1#${fixture.id}`);
	await sleep(500);
	await settle(4);
	const f = await snap();
	check("冷启动打开会话后直接到底、按钮隐藏", atBottom(f), `距底 ${f.dist}px`);

	// ── G 左栏：底部「存档箱」和分支折叠 ──
	phase("G 左栏存档箱 / 分支折叠");
	await load(`${PAGE}?attic=1`);
	await sleep(600);
	await settle(3);

	const g0 = { attic: await ev("__h.attic()"), treeArch: (await ev("__h.treeArchRoots()")).length, listHidden: await ev("__h.atticListHidden()"), fold: await ev(`__h.fold(${JSON.stringify(fixture.id)})`) };
	check(
		"默认：树里不露存档、抽屉关着，但有「存档 ▸ N」提示（N = 无父的已存档数）",
		g0.treeArch === 0 && g0.listHidden === true && g0.attic?.hidden === false && new RegExp(`▸\\s*${fixture.archivedRoots}\\b`).test(g0.attic.text),
		`树里存档 ${g0.treeArch} 行，抽屉 ${g0.listHidden ? "关" : "开"}，存档箱「${g0.attic?.text}」`,
	);
	check("带存档后代的分支有折叠标记 ▸N", g0.fold && !g0.fold.none && new RegExp(`▸\\s*${fixture.foldedUnderLiveRoot}\\b`).test(g0.fold.mark), `标记「${g0.fold?.mark}」`);

	const clicked = await ev("__h.clickAttic()");
	await settle(2);
	const g1 = { attic: await ev("__h.attic()"), rows: await ev("__h.atticRows()"), treeArch: (await ev("__h.treeArchRoots()")).length, listHidden: await ev("__h.atticListHidden()"), geom: await ev("__h.atticGeom()") };
	check(
		"点存档箱 → 存档行出现在按钮下面的抽屉里（树里依然 0 行）",
		clicked === true && g1.rows.length === fixture.archivedRoots && g1.rows.every((r) => r.arch) && g1.treeArch === 0 && g1.listHidden === false,
		`抽屉 ${g1.rows.length} 行（期望 ${fixture.archivedRoots}），树里 ${g1.treeArch} 行`,
	);
	check("标记翻成 ▾（朝下 = 内容就在下面）", new RegExp(`▾\\s*${fixture.archivedRoots}\\b`).test(g1.attic?.text ?? ""), `存档箱「${g1.attic?.text}」`);
	check(
		"抽屉整段落在按钮下方、贴左栏底、满宽，且不随树滚动",
		g1.geom?.treeScrollable === true && g1.geom.fixedWhenTreeScrolls && g1.geom.drawerBelowButton && g1.geom.rowsBelowButton && g1.geom.drawerBottom && g1.geom.fullWidth,
		`树可滚=${g1.geom?.treeScrollable} 固定=${g1.geom?.fixedWhenTreeScrolls} 抽屉在按钮下=${g1.geom?.drawerBelowButton} 行在按钮下=${g1.geom?.rowsBelowButton} 贴底=${g1.geom?.drawerBottom} 满宽=${g1.geom?.fullWidth} 尺寸 ${g1.geom?.w}×${g1.geom?.h}`,
	);
	await ev("__h.clickAttic()");
	await settle(2);
	const g2 = { attic: await ev("__h.attic()"), rows: await ev("__h.atticRows()"), listHidden: await ev("__h.atticListHidden()") };
	check("再点一次收起：抽屉清空并隐藏、回到 ▸", g2.rows.length === 0 && g2.listHidden === true && new RegExp(`▸\\s*${fixture.archivedRoots}\\b`).test(g2.attic?.text ?? ""), `抽屉 ${g2.rows.length} 行，隐藏=${g2.listHidden}，存档箱「${g2.attic?.text}」`);

	const before = (await ev("__h.rows()")).length;
	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	const g3 = { count: (await ev("__h.rows()")).length, fold: await ev(`__h.fold(${JSON.stringify(fixture.id)})`) };
	check("点分支折叠 ▸N → 这一支的存档冒出来", g3.count - before === fixture.foldedUnderLiveRoot, `行数 ${before} → ${g3.count}（+${g3.count - before}，期望 +${fixture.foldedUnderLiveRoot}）`);
	check("分支标记翻成 ▾N", new RegExp(`▾\\s*${fixture.foldedUnderLiveRoot}\\b`).test(g3.fold?.mark ?? ""), `标记「${g3.fold?.mark}」`);
	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	const g4 = (await ev("__h.rows()")).length;
	check("再点一次收回去", g4 === before, `行数 ${g3.count} → ${g4}`);

	// ── G2 嵌套折叠（回归）：展开父，不该顺手把「非归档子会话」自己的归档支也展开 ──
	// 形状（真树上就有这一条：01a090ea → 01a09376 → 01a09a14）：
	//   P（非归档，▸N）→ C（非归档，**活**，自己带 ▸1）→ C 自己的归档
	// 用户只点了 P 的标记。期望：C 的标记仍是 ▸1、C 的归档孩子不可见。
	phase("G3 嵌套折叠：展开父不该连坐展开活子的归档支");
	await load(`${PAGE}?nestedfold=1`);
	await sleep(600);
	await settle(3);
	const nested = (await ev("window.__fixture")).nested; // 这条形状只在 ?nestedfold=1 的页面里（得重新问）
	if (!nested) fail("mock 没给嵌套折叠那条形状", "window.__fixture.nested 是 null");

	const idsOf = (rows) => rows.map((r) => r.id);
	const nf0 = { rows: await ev("__h.rows()"), p: await ev(`__h.fold(${JSON.stringify(nested.p)})`), c: await ev(`__h.fold(${JSON.stringify(nested.c)})`) };
	check(
		"默认：活子自己也带标记 ▸1（它自己的那支归它管）",
		new RegExp(`▸\\s*${nested.cFold}\\b`).test(nf0.c?.mark ?? ""),
		`活子「${nf0.c?.mark}」`,
	);
	// 这一条是「计数不许骗人」的正脸：标记上写的数 = 点它真能掀出来的归档数。
	// 现在算的是「这一支的全部归档后代（含活子那支）」→ ▸3，但点下去只有 2 个是它该掀的。
	check(
		`默认：父的标记写的是它真能掀开的数（▸${nested.pFoldRight}）`,
		new RegExp(`▸\\s*${nested.pFoldRight}\\b`).test(nf0.p?.mark ?? ""),
		`父「${nf0.p?.mark}」（改之前那个宽口径会把它掀不开的活子那支也算进去 → ▸${nested.pFoldNow}）`,
	);
	check("默认：活子自己的归档藏在树上（不可见）", !idsOf(nf0.rows).includes(nested.a3), `树上可见 ${idsOf(nf0.rows).length} 行`);

	await ev(`__h.clickFold(${JSON.stringify(nested.p)})`);
	await settle(2);
	const nf1 = { rows: await ev("__h.rows()"), p: await ev(`__h.fold(${JSON.stringify(nested.p)})`), c: await ev(`__h.fold(${JSON.stringify(nested.c)})`) };
	const shown = idsOf(nf1.rows);
	check("点父的标记 → 父那一层的两个归档冒出来", shown.includes(nested.a1) && shown.includes(nested.a2), `树上可见 ${shown.length} 行`);
	check("活子本身没被连坐藏掉（它是活的，只是挂在被掀开的父下面）", shown.includes(nested.c), `树上可见 ${shown.length} 行`);
	check("★活子自己的标记仍是 ▸1（用户没点过它）", nf1.c?.mark === "▸1" && nf1.c?.none === false, `活子标记「${nf1.c?.mark}」`);
	check("★活子自己的归档仍不可见", !shown.includes(nested.a3), shown.includes(nested.a3) ? `它被连着露出来了（树上可见 ${shown.length} 行）` : `树上可见 ${shown.length} 行`);
	check(
		"计数与展开粒度一致：点父的标记，冒出来的行数 / 归档数 = 标记上写的那个数",
		nf1.rows.filter((r) => r.arch).length - nf0.rows.filter((r) => r.arch).length === nested.pFoldRight,
		`新露归档 ${nf1.rows.filter((r) => r.arch).length - nf0.rows.filter((r) => r.arch).length} 个，标记写「${nf1.p?.mark}」（期望 ${nested.pFoldRight}）`,
	);
	check("父的标记翻成 ▾（朝下 = 内容就在下面）", new RegExp(`▾\\s*${nested.pFoldRight}\\b`).test(nf1.p?.mark ?? ""), `父「${nf1.p?.mark}」`);

	// 另一个面：在父被掀开的状态下，活子自己的标记必须仍然是个**真开关**
	await ev(`__h.clickFold(${JSON.stringify(nested.c)})`);
	await settle(2);
	const nf2 = { rows: await ev("__h.rows()"), c: await ev(`__h.fold(${JSON.stringify(nested.c)})`) };
	await ev(`__h.clickFold(${JSON.stringify(nested.c)})`);
	await settle(2);
	const nf3 = { rows: await ev("__h.rows()"), c: await ev(`__h.fold(${JSON.stringify(nested.c)})`) };
	check("点活子自己的标记 → 它的归档真的冒出来（不是空开关）", idsOf(nf2.rows).includes(nested.a3) && nf2.c?.mark === "▾1", `活子标记「${nf2.c?.mark}」`);
	check("再点一次 → 收回去（父还开着也不该再露它）", !idsOf(nf3.rows).includes(nested.a3) && nf3.c?.mark === "▸1", `活子标记「${nf3.c?.mark}」`);

	// 逐例核计数：标记上写几，点它就真变几行（两个方向都要真动 —— 空开关的 delta 是 0）。
	const nf4 = await foldProbe(nested.c);
	check(
		"逐例计数：活子的 ▸1 点一下真掀开 1 行（不是空开关）",
		nf4.n === nested.cFold && nf4.delta === nested.cFold && nf4.mark2 === "▾1" && nf4.ids.includes(nested.a3),
		`标记「${nf4.mark}」→「${nf4.mark2}」，行数 ${nf4.rows[0]} → ${nf4.rows[1]}`,
	);
	const nf5 = await foldProbe(nested.c);
	check(
		"逐例计数：活子的 ▾1 再点一下真收起 1 行",
		nf5.n === nested.cFold && nf5.delta === -nested.cFold && nf5.mark2 === "▸1" && !nf5.ids.includes(nested.a3),
		`标记「${nf5.mark}」→「${nf5.mark2}」，行数 ${nf5.rows[0]} → ${nf5.rows[1]}`,
	);
	const nf6 = await foldProbe(nested.p);
	check(
		"逐例计数：活父的 ▾2 点一下真收起 2 行（只算它自己那一层，不把活子那支算进来）",
		nf6.n === nested.pFoldRight && nf6.delta === -nested.pFoldRight,
		`标记「${nf6.mark}」→「${nf6.mark2}」，行数 ${nf6.rows[0]} → ${nf6.rows[1]}（期望 ${-nested.pFoldRight}）`,
	);

	// 再一条形状：**归档支里夹着一个活节点**（LA_P → LA_A → LA_L → LA_G）。
	// ① 的语义在这一层上：掀开的级联只沿**归档**节点下传 —— LA_A 那一支露出来时，
	// 夹在它支里的活节点 LA_L 也跟着露（它本来就该可见），但 LA_L 自己那个标记管的 LA_G
	// 不许跟着露（三态里 effIf 对活节点不吃继承，就是这个分支）。
	const la = nested.liveArch;
	const la0 = { rows: await ev("__h.rows()"), p: await ev(`__h.fold(${JSON.stringify(la.p)})`) };
	const la0ids = idsOf(la0.rows);
	check(
		"归档支里的活节点：默认整段藏着（根上只挂它自己那个归档父的账）",
		!la0ids.includes(la.a) && !la0ids.includes(la.l) && !la0ids.includes(la.g) && new RegExp(`▸\\s*${la.pFold}\\b`).test(la0.p?.mark ?? ""),
		`根「${la0.p?.mark}」，支里可见 ${[la.a, la.l, la.g].filter((x) => la0ids.includes(x)).length} 行`,
	);
	await ev(`__h.clickFold(${JSON.stringify(la.p)})`);
	await settle(2);
	const la1 = { rows: await ev("__h.rows()"), p: await ev(`__h.fold(${JSON.stringify(la.p)})`), l: await ev(`__h.fold(${JSON.stringify(la.l)})`) };
	const la1ids = idsOf(la1.rows);
	check(
		"掀开它 → 归档父与**夹在它支里的活节点**一起露（活节点本来就该可见）",
		la1ids.includes(la.a) && la1ids.includes(la.l),
		`支里可见 ${[la.a, la.l, la.g].filter((x) => la1ids.includes(x)).length} 行（期望 2）`,
	);
	check(
		"★但夹在里面的活节点，它自己的归档孩子仍不可见（掀开没从活节点继续下传）",
		!la1ids.includes(la.g),
		la1ids.includes(la.g) ? "它被连着露出来了" : `树上可见 ${la1ids.length} 行`,
	);
	check(
		"★那个活节点自己的标记仍是 ▸1（归它自己管，不是 ▾）",
		la1.l?.mark === "▸1" && la1.l?.none === false,
		`活节点标记「${la1.l?.mark}」`,
	);
	const la2 = await foldProbe(la.l);
	check(
		"逐例计数：它的 ▸1 点一下真掀开 1 行（它的归档孩子），不是空开关",
		la2.n === la.lFold && la2.delta === la.lFold && la2.mark2 === "▾1" && la2.ids.includes(la.g),
		`标记「${la2.mark}」→「${la2.mark2}」，行数 ${la2.rows[0]} → ${la2.rows[1]}`,
	);
	const la3 = await foldProbe(la.l);
	check("逐例计数：再点一下真收起 1 行（标记回 ▸1）", la3.n === la.lFold && la3.delta === -la.lFold && la3.mark2 === "▸1" && !la3.ids.includes(la.g), `标记「${la3.mark}」→「${la3.mark2}」，行数 ${la3.rows[0]} → ${la3.rows[1]}`);
	// 根上的 N 数的是**存档**行（tooltip 说的就是「藏了 N 个已存档的会话」）：
	// 掀开它露 1 个归档父 + 1 个夹在里面的活节点 —— 活节点那行跟着露，但它不记账。
	const la4 = await foldProbe(la.p);
	check(
		"逐例计数：根的 ▾1 点一下真收起（1 个存档 + 跟着进去的 1 个活节点 = 2 行；N 只数存档行）",
		la4.n === la.pFold && la4.delta === -la.pOpenRows && !la4.ids.includes(la.l),
		`标记「${la4.mark}」→「${la4.mark2}」，行数 ${la4.rows[0]} → ${la4.rows[1]}（N=${la4.n}，真收 ${-la4.delta} 行）`,
	);

	// ── G4 折叠标记 = **生效状态**：归档节点被祖先掀开时，不许再挂个撒谎的 ▸N ──
	// 形状（mock 主树里就有；真树上也有这种形状 —— /tmp/real-inner.mjs 实测真树 134 个节点里
	//   8 个「归档节点带归档孩子」，拿走一个真节点验的）：LIVE_ROOT（活）→ sid(10)（归档，自己带 ▸1）
	//   → sid(30)（归档孙）。① 修完、三态之前：掀开 LIVE_ROOT 之后 sid(10) 整支已经露着，
	//   可它自己的标记写 ▸1 —— 内容露着、而点它点开点收都不动（空开关，/tmp/inner.mjs 实测 53→53→53）。
	// 三态（显式开 / 显式关 / 没说过，生效=显式优先否则继承）之后：这种节点是「生效=开」→ ▾1；
	//   点它写「显式关」→ 压过祖先的掀开、真收起；再点写「显式开」→ 真打开。
	phase("G4 折叠标记画生效状态：被祖先掀开的归档节点不再是空开关");
	await load(`${PAGE}?attic=1`);
	await sleep(600);
	await settle(3);

	const h0 = { root: await ev(`__h.fold(${JSON.stringify(fixture.id)})`), kid: await ev(`__h.fold(${JSON.stringify(fixture.archChild)})`) };
	check(
		"掀开前：主会话 ▸11，它的归档孩子还不在树上",
		new RegExp(`▸\\s*${fixture.foldedUnderLiveRoot}\\b`).test(h0.root?.mark ?? "") && h0.kid === null,
		`主会话「${h0.root?.mark}」，归档孩子那行 ${h0.kid === null ? "不在树上" : `在（标记「${h0.kid.mark}」）`}`,
	);

	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	const h1 = { ids: (await ev("__h.rows()")).map((r) => r.id), kid: await ev(`__h.fold(${JSON.stringify(fixture.archChild)})`) };
	check("掀开主会话 → 归档孩子露出来（它的归档孩子也一起露）", h1.ids.includes(fixture.archChild) && h1.ids.includes(fixture.archGrandchild), `树上一共 ${h1.ids.length} 行`);
	check(
		"★被祖先掀开的归档节点：标记是 ▾1（生效=开），不再写撒谎的 ▸1",
		h1.kid?.mark === "▾1" && h1.kid?.none === false,
		`归档孩子标记「${h1.kid?.mark}」（改前这里一直是 ▸1 —— 内容露着却写「点它能掀开」）`,
	);

	const h2 = await foldProbe(fixture.archChild);
	check(
		"★点它 → 真收起（行数 -1、标记回 ▸1、归档孙真不可见）—— 空开关变成真开关",
		h2.mark === "▾1" && h2.n === 1 && h2.delta === -1 && h2.mark2 === "▸1" && !h2.ids.includes(fixture.archGrandchild),
		`标记「${h2.mark}」→「${h2.mark2}」，行数 ${h2.rows[0]} → ${h2.rows[1]}，归档孙可见？ ${h2.ids.includes(fixture.archGrandchild)}`,
	);
	const h3 = await foldProbe(fixture.archChild);
	check(
		"★再点一次 → 真再打开（行数 +1、标记 ▾1、归档孙回来）",
		h3.mark === "▸1" && h3.n === 1 && h3.delta === 1 && h3.mark2 === "▾1" && h3.ids.includes(fixture.archGrandchild),
		`标记「${h3.mark}」→「${h3.mark2}」，行数 ${h3.rows[0]} → ${h3.rows[1]}，归档孙可见？ ${h3.ids.includes(fixture.archGrandchild)}`,
	);

	// 逐例核计数（两个方向）：主会话本身的 11 行也要对得上。
	const hp1 = await foldProbe(fixture.id);
	check(
		"逐例计数：主会话的 ▾11 点一下真收起 11 行（含嵌在归档里的那 1 行）",
		hp1.n === fixture.foldedUnderLiveRoot && hp1.delta === -fixture.foldedUnderLiveRoot,
		`标记「${hp1.mark}」，行数 ${hp1.rows[0]} → ${hp1.rows[1]}（期望 ${-fixture.foldedUnderLiveRoot}）`,
	);
	const hp2 = await foldProbe(fixture.id);
	check(
		"逐例计数：再点回去 → ▸11 点一下真掀开 11 行",
		hp2.n === fixture.foldedUnderLiveRoot && hp2.delta === fixture.foldedUnderLiveRoot,
		`标记「${hp2.mark}」，行数 ${hp2.rows[0]} → ${hp2.rows[1]}（期望 +${fixture.foldedUnderLiveRoot}）`,
	);

	// ── G5 内存态的 prune（expanded / collapsed **两个**都得剔）──
	// 三态之后「用户说过什么」比一个 Set 更值钱：脏 expanded = 新节点自己开着（老 bug）；
	// 脏 collapsed 更阴 —— 新节点一出生就被按成「显式关」，看着就像「点了没反应」。
	// 这里模拟真事：会话从树上消失（删 / 换掉），过一会儿同一个 id 又出现（重建）。
	// 它必须回到「没说过」。
	phase("G5 节点消失 → 那份内存态必须剔干净（脏键会让新节点凭空开合）");
	await load(`${PAGE}?attic=1`);
	await sleep(600);
	await settle(3);

	/** 让前端真重拉一次 /tree（用一条树上不存在的标题事件 —— 前端会 load()），并回报它真拉到了。 */
	const refetch = async (tag) => {
		const before = await ev("__h.netCount('/api/tree')");
		await ev(`__h.titleEvent('00000000-0000-4000-8000-9999999999${tag}', '树上没有的会话 ${tag}')`);
		await sleep(200);
		await settle(3);
		return (await ev("__h.netCount('/api/tree')")) > before;
	};

	// ① 脏 expanded：点开它 → 它从树上消失 → 再出现 → 该是「没说过」= ▸11
	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	const q1 = await ev(`__h.fold(${JSON.stringify(fixture.id)})`);
	check("先把它点开（此刻 ▾11，那份内存态里留了它的 id）", new RegExp(`▾\\s*${fixture.foldedUnderLiveRoot}\\b`).test(q1?.mark ?? ""), `主会话「${q1?.mark}」`);

	const gon = await ev(`window.__gone(${JSON.stringify(fixture.id)}, true)`);
	const refetched = await refetch("aa");
	check("把它（连同它那一支）从假树里拿掉，并让前端真重拉一次 /tree", gon.changed === true && refetched === true, `拿掉 changed=${gon.changed}，重拉=${refetched}`);
	const q2 = await ev("__h.rows()");
	check("树上它那一支真没了", ![fixture.id, fixture.archChild, fixture.archGrandchild].some((x) => q2.some((r) => r.id === x)), `树上 ${q2.length} 行`);

	await ev(`window.__gone(${JSON.stringify(fixture.id)}, false)`);
	await refetch("ab");
	const q3 = await ev(`__h.fold(${JSON.stringify(fixture.id)})`);
	check(
		"★同一个 id 再出现 → 回到「没说过」：▸11（脏 expanded 会让它自己开着 ▾11）",
		new RegExp(`▸\\s*${fixture.foldedUnderLiveRoot}\\b`).test(q3?.mark ?? ""),
		`主会话「${q3?.mark}」`,
	);

	// ② 脏 collapsed：在被祖先掀开的归档孩子上点一次（写「显式关」）→ 它消失再出现
	//    → 该回到「没说过」= 继承祖先的掀开（▾1、归档孙也在），不是被脏键按成 ▸1。
	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	await ev(`__h.clickFold(${JSON.stringify(fixture.archChild)})`);
	await settle(2);
	const q4 = { mark: await ev(`__h.fold(${JSON.stringify(fixture.archChild)})`), ids: (await ev("__h.rows()")).map((r) => r.id) };
	check(
		"先制造一个脏 collapsed：在被掀开的归档孩子上点一次 → ▸1、归档孙藏起来",
		q4.mark?.mark === "▸1" && !q4.ids.includes(fixture.archGrandchild),
		`归档孩子「${q4.mark?.mark}」，归档孙可见？ ${q4.ids.includes(fixture.archGrandchild)}`,
	);

	await ev(`window.__gone(${JSON.stringify(fixture.archChild)}, true)`);
	await refetch("ac");
	await ev(`window.__gone(${JSON.stringify(fixture.archChild)}, false)`);
	await refetch("ad");
	const q5 = { mark: await ev(`__h.fold(${JSON.stringify(fixture.archChild)})`), ids: (await ev("__h.rows()")).map((r) => r.id) };
	check(
		"★同一个 id 再出现 → 回到「没说过」：▾1、归档孙也回来（脏 collapsed 会仍写作 ▸1 并藏着它）",
		q5.mark?.mark === "▾1" && q5.ids.includes(fixture.archGrandchild),
		`归档孩子「${q5.mark?.mark}」，归档孙可见？ ${q5.ids.includes(fixture.archGrandchild)}`,
	);

	// ── I 流式 parts 交错：thinking → tool → thinking → tool 不被并成一段 ──
	phase("I 流式 parts 交错（Bug 1）");
	await load(`${PAGE}?parts=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const histShape = await ev("__h.histShape()");
	check(
		"历史渲染按 parts 原顺序：thinking→text→tool→thinking→tool",
		JSON.stringify(histShape) === JSON.stringify(["think", "text", "tool", "think", "tool"]),
		`实际 ${JSON.stringify(histShape)}`,
	);

	await ev("window.__es._emit({ t: 'run', phase: 'start' })");
	await ev("window.__es._emit({ t: 'thinking', d: '思考甲' })");
	await ev("window.__es._emit({ t: 'tool', phase: 'start', id: 't1', name: 'bash', args: { command: 'ls' } })");
	await ev("window.__es._emit({ t: 'tool', phase: 'end', id: 't1', result: 'ok' })");
	await ev("window.__es._emit({ t: 'thinking', d: '思考乙' })");
	await ev("window.__es._emit({ t: 'tool', phase: 'start', id: 't2', name: 'read', args: { path: '/tmp/x' } })");
	await ev("window.__es._emit({ t: 'tool', phase: 'end', id: 't2', result: 'ok' })");
	await ev("window.__es._emit({ t: 'text', d: '正文甲' })");
	await ev("window.__es._emit({ t: 'tool', phase: 'start', id: 't3', name: 'grep', args: { pattern: 'x' } })");
	await ev("window.__es._emit({ t: 'text', d: '正文乙' })");
	await settle(3);
	const liveShape = await ev("__h.liveShape()");
	check(
		"直播交错：think→tool→think→tool→text→tool→text（而不是思考并成长的一段、工具堆后面）",
		JSON.stringify(liveShape) === JSON.stringify(["think", "tool", "think", "tool", "text", "tool", "text"]),
		`实际 ${JSON.stringify(liveShape)}`,
	);
	const thinkTexts = await ev("[...document.querySelectorAll('#liveBox .think')].map(x => x.textContent)");
	check(
		"两段思考各自独立，文本没被并在一起",
		Array.isArray(thinkTexts) && thinkTexts.length === 2 && JSON.stringify(thinkTexts) === JSON.stringify(["思考甲", "思考乙"]),
		`#liveBox .think = ${JSON.stringify(thinkTexts)}`,
	);

	// ── J 斜杠命令面板 ──
	phase("J 斜杠命令面板");
	await load(`${PAGE}?cmd=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const j0 = { box: await ev("__h.cmds()"), net: await ev("window.__net") };
	check("刚打开：面板关着，但已经拉过命令清单", j0.box?.hidden === true && j0.net.some((x) => x.includes("/commands")), `hidden=${j0.box?.hidden}`);

	await ev("__h.setInput('/')");
	await settle(2);
	const j1 = { box: await ev("__h.cmds()"), rows: await ev("__h.cmdRows()"), note: await ev("__h.cmdNote()"), scroll: await ev("__h.cmdScroll()") };
	check(
		"输入 / → 面板弹出，列出全部命令（首行高亮）",
		j1.box?.hidden === false && j1.rows.length === fixture.commands.length && j1.rows[0].sel === true,
		`${j1.rows.length} 行（期望 ${fixture.commands.length}）`,
	);
	check("每行带名字 + 来源标签", j1.rows.every((r) => r.name && r.src), JSON.stringify(j1.rows.map((r) => `${r.name}:${r.src}`)));
	check("列表长了能滚（overflow-y:auto + max-height）", j1.scroll?.overflowY === "auto" && j1.scroll?.maxH !== "none", JSON.stringify(j1.scroll));
	check("有关键提示行", (j1.note.keys ?? "").includes("Esc"), `keys=${JSON.stringify(j1.note.keys)}`);

	await ev("__h.setInput('/com')");
	await settle(2);
	const j2 = await ev("__h.cmdRows()");
	check("输入 com → 过滤到 compact 一条", j2.length === 1 && j2[0].name === "compact" && j2[0].sel === true, JSON.stringify(j2.map((r) => r.name)));

	await ev("__h.setInput('/skill:')");
	await settle(2);
	const nav = [];
	for (const k of [null, "ArrowDown", "ArrowDown", "ArrowUp"]) {
		if (k) await ev(`__h.key(${JSON.stringify(k)})`);
		await settle(1);
		nav.push((await ev("__h.cmdRows()")).findIndex((r) => r.sel));
	}
	check("↑↓ 移动高亮（到底/到顶会绕回）", JSON.stringify(nav) === JSON.stringify([0, 1, 0, 1]), `高亮轨迹 ${JSON.stringify(nav)}`);

	await ev("__h.setInput('/com')");
	await settle(2);
	const netBeforeEnter = await ev("window.__net.length");
	await ev("__h.key('Enter')");
	await settle(2);
	const j3 = { val: await ev("__h.inputVal()"), box: await ev("__h.cmds()"), net: await ev("window.__net.length") };
	check("Enter 选中 → 只填进输入框、面板收起，且**没有发送**（留取消机会）", j3.val === "/compact " && j3.box?.hidden === true && j3.net === netBeforeEnter, `输入框「${j3.val}」，面板 hidden=${j3.box?.hidden}`);

	await ev("__h.setInput('/skill')");
	await settle(2);
	await ev("__h.key('Escape')");
	await settle(2);
	const j4 = { box: await ev("__h.cmds()"), val: await ev("__h.inputVal()") };
	check("Esc → 面板关闭、输入文字保留", j4.box?.hidden === true && j4.val === "/skill", `输入框「${j4.val}」`);
	await ev("__h.setInput('/skill')");
	await settle(2);
	const j5a = await ev("__h.cmds()");
	await ev("__h.setInput('/skill:on-w')");
	await settle(2);
	const j5b = { box: await ev("__h.cmds()"), rows: await ev("__h.cmdRows()") };
	check("Esc 关掉后同值不再弹、改了才弹", j5a?.hidden === true && j5b.box?.hidden === false && j5b.rows.length === 1 && j5b.rows[0].name === "skill:on-write", JSON.stringify(j5b.rows.map((r) => r.name)));

	await ev("__h.key('Tab')");
	await settle(2);
	const j6 = { val: await ev("__h.inputVal()"), box: await ev("__h.cmds()") };
	check("Tab 选中 → 填入", j6.val === "/skill:on-write " && j6.box?.hidden === true, `输入框「${j6.val}」`);

	await ev("__h.setInput('看 /tmp/x 这个文件')");
	await settle(2);
	const j7 = await ev("__h.cmds()");
	await ev("__h.setInput('a/b')");
	await settle(2);
	const j8 = await ev("__h.cmds()");
	check("只认开头的 /：正文中间、路径里的斜杠不弹面板", j7?.hidden === true && j8?.hidden === true, `中间斜杠 hidden=${j7?.hidden}，a/b hidden=${j8?.hidden}`);

	await ev("__h.setInput('/nope')");
	await settle(2);
	const j9 = { rows: await ev("__h.cmdRows()"), note: await ev("__h.cmdNote()") };
	check("输入清单里没有的名字 → 面板空 + 明确说明", j9.rows.length === 0 && (j9.note.hint ?? "").includes("nope"), `hint=${JSON.stringify(j9.note.hint)}`);

	// streaming：命令被明确拒绝（不发请求、输入保留、有说明）
	await ev("__h.setInput('/compact ')");
	await settle(1);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	const netBeforeRefuse = await ev("window.__net.length");
	await ev("__h.key('Enter')");
	await settle(2);
	const j10 = { notice: await ev("__h.notice()"), val: await ev("__h.inputVal()"), net: await ev("window.__net.length") };
	check(
		"流式中执行命令 → 明确拒绝（不发请求、输入保留、有说明）",
		j10.notice.hidden === false && j10.notice.text.includes("正在跑") && j10.net === netBeforeRefuse && j10.val === "/compact ",
		`提示「${j10.notice.text}」；请求 ${netBeforeRefuse} → ${j10.net}；输入框「${j10.val}」`,
	);

	// 停下来后：命令作为普通 prompt 发（不带 behavior）
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await settle(4);
	await ev("__h.setInput('/skill:on-write ')");
	await settle(1);
	await ev("document.querySelector('#send').click()");
	await sleep(200);
	await settle(2);
	const j11 = { bodies: await ev("__h.bodies()"), val: await ev("__h.inputVal()"), box: await ev("__h.cmds()") };
	const lastBody = j11.bodies.at(-1);
	check(
		"空闲时发命令 → 走普通 prompt（body 里没有 behavior）",
		lastBody && lastBody.url.includes("/message") && lastBody.body === JSON.stringify({ text: "/skill:on-write" }) && j11.val === "" && j11.box?.hidden === true,
		`body=${lastBody?.body}`,
	);

	// 边界：没选会话 / 清单为空 / 只靠接口报的 streaming
	await load(`${PAGE}?cmd0=1`);
	await sleep(300);
	await settle(2);
	const je = { box: await ev("__h.cmds()"), disabled: await ev("__h.inputDisabled()") };
	check("没选会话：输入框禁用、面板不弹", je.disabled === true && je.box?.hidden === true, `disabled=${je.disabled} hidden=${je.box?.hidden}`);

	await load(`${PAGE}?cmdsEmpty=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__h.setInput('/')");
	await settle(2);
	const jempty = { rows: await ev("__h.cmdRows()"), note: await ev("__h.cmdNote()") };
	check("清单为空：面板给明确说明（不是空白）", jempty.rows.length === 0 && (jempty.note.hint ?? "").includes("没有可用"), `hint=${JSON.stringify(jempty.note.hint)}`);

	await load(`${PAGE}?cmdsStreaming=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	const netBeforeApi = await ev("window.__net.length");
	await ev("__h.setInput('/compact ')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(2);
	const js = { notice: await ev("__h.notice()"), net: await ev("window.__net.length") };
	check("SSE 还没说、只靠接口报的 streaming 也拒绝（前端不自己推）", js.notice.hidden === false && js.net === netBeforeApi, `提示「${js.notice.text}」`);
	// 这一轮跑完之后，那个「拉清单那一刻的 streaming 快照」必须失效，命令要能重发
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await settle(4);
	const netBeforeRecover = await ev("window.__net.length");
	await ev("__h.setInput('/skill:on-write ')");
	await settle(1);
	await ev("__h.key('Enter')");
	await sleep(200);
	const rec = { notice: await ev("__h.notice()"), net: await ev("window.__net.length") };
	check("跑完一轮后命令重新可发（不会卡在拉清单那一刻的快照上）", rec.net > netBeforeRecover && rec.notice.hidden === true, `请求 ${netBeforeRecover} → ${rec.net}，提示 hidden=${rec.notice.hidden}`);

	// 内置命令 `/compact` 不再当普通 prompt 发出去 —— 它走自己的路由（先二次确认，不发 /message）
	//（发完上一条消息后 UI 认为还在跑 —— 先等这一轮真的结束，否则测的是「流式中被拒」）
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await settle(4);
	const netBeforeOwn = await ev("window.__net.length");
	await ev("__h.setInput('/compact')");
	await settle(1);
	await ev("__h.key('Enter')"); // 面板填入
	await settle(1);
	await ev("__h.key('Enter')"); // 真发
	await settle(2);
	const own = { confirm: await ev("__h.confirm()"), net: await ev("window.__net.length") };
	check(
		"/compact 走自己的路由：只弹确认、不当普通文本发（旧行为是 POST /message）",
		own.confirm?.hidden === false && own.net === netBeforeOwn,
		`确认框 hidden=${own.confirm?.hidden}，请求 ${netBeforeOwn} → ${own.net}`,
	);

	// ── K 上下文用量（输入框右侧常显）──
	phase("K 上下文用量");
	await load(`${PAGE}?ctx=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const k0 = { ctx: await ev("__h.ctx()"), row: await ev("__h.ctxRow()") };
	check("打开会话即拉到用量：百分比/窗口 + (auto) + 余量", (k0.ctx?.text ?? "").includes("60.4%/900k (auto)") && k0.ctx.text.includes("余 340k"), `“${k0.ctx?.text}”`);
	check("离阈值还远 → 不变色", /\bok\b/.test(k0.ctx?.cls ?? ""), `class=${k0.ctx?.cls}`);
	check("和 hint 同一行（不为它多占一行）", k0.row?.sameRow === true, `hint.top=${k0.row?.hintTop} ctx.top=${k0.row?.ctxTop}`);

	const rerender = "__es._emit({ t: 'run', phase: 'end' })";
	await ev("window.__ctx = { tokens: 800000, contextWindow: 900000, percent: 88.88888888888889, reserveTokens: 16384, compactAt: 883616, freeTokens: 83616, autoCompact: true }");
	await ev(rerender);
	await settle(4);
	const k1 = await ev("__h.ctx()");
	check("接近自动压缩阈值（≥90% 阈值 / 88.9% 窗口）→ 转黄 + 显示剩余", k1.cls.includes("warn") && k1.text.includes("88.9%") && k1.text.includes("余 84k"), `class=${k1.cls} “${k1.text}”`);

	await ev("window.__ctx = { tokens: 890000, contextWindow: 900000, percent: 98.88888888888889, reserveTokens: 16384, compactAt: 883616, freeTokens: -6384, autoCompact: true }");
	await ev(rerender);
	await settle(4);
	const k2 = await ev("__h.ctx()");
	check("越过自动压缩阈值 → 转红 + 显示超出量", k2.cls.includes("full") && k2.text.includes("超 6.4k"), `class=${k2.cls} “${k2.text}”`);

	await ev("window.__ctx = { tokens: null, contextWindow: 900000, percent: null, reserveTokens: 16384, compactAt: 883616, freeTokens: null, autoCompact: true }");
	await ev(rerender);
	await settle(4);
	const k3 = await ev("__h.ctx()");
	check("刚压缩过 / tokens 未知 → 显示 —（不编 0）且不变色", k3.text.includes("—/900k") && k3.cls.includes("none"), `class=${k3.cls} “${k3.text}”`);

	await ev("window.__ctx = null");
	await ev(rerender);
	await settle(4);
	const k4 = await ev("__h.ctx()");
	check("冷会话 / 拿不到用量 → 「上下文 —」，不变色", k4.text.includes("上下文 —") && k4.cls.includes("none"), `“${k4.text}”`);

	await ev("window.__ctx = { tokens: 123456, contextWindow: 900000, percent: 13.7, reserveTokens: 16384, compactAt: 883616, freeTokens: 760160, autoCompact: true }");
	await settle(6);
	const k5 = await ev("__h.ctx()");
	check("没有 run end 就不重拉（不是每帧/轮询拉）", k5.text.includes("上下文 —"), `“${k5.text}”`);

	// ── L 内置命令（标注 + 拒绝）+ /compact 二次确认 + /model ──
	phase("L 内置命令 / 压缩 / 切模型");
	await load(`${PAGE}?builtin=1#${fixture.id}`);
	await sleep(400);
	await settle(3);

	await ev("__h.setInput('/')");
	await settle(2);
	const l0 = await ev("__h.cmdRows()");
	const byName = Object.fromEntries(l0.map((r) => [r.name, r]));
	check(
		"内置命令照常列出来（compact / model / tree / new）",
		fixture.commands.every((n) => byName[n]),
		`共 ${l0.length} 行：${l0.map((r) => r.name).join(",")}`,
	);
	check(
		"能执行的（compact / model）带 runnable 标注、不灰、来源标「内置」",
		["compact", "model"].every((n) => byName[n]?.runnable === "true" && byName[n].dead === false && byName[n].src === "内置") && byName.model.arg === undefined,
		JSON.stringify(["compact", "model"].map((n) => byName[n] && { n, runnable: byName[n].runnable, srr: byName[n].src })),
	);
	check(
		"不能执行的灰掉 + 尾巴写明原因（不是静默不提）",
		["tree", "new"].every((n) => byName[n]?.dead === true && byName[n].runnable === "false" && !!byName[n].tag) && byName.tree.tag === "看左栏树",
		JSON.stringify(["tree", "new"].map((n) => byName[n] && { n, tag: byName[n].tag, title: byName[n].title })),
	);

	// 点不能执行的 → 明确解释、不填、不发请求
	await ev("__h.setInput('/tree')");
	await settle(2);
	const netBeforeDead = await ev("window.__net.length");
	const clickedDead = await ev("__h.mousedownCmd('tree')");
	await settle(2);
	const l1 = { notice: await ev("__h.notice()"), val: await ev("__h.inputVal()"), net: await ev("window.__net.length"), box: await ev("__h.cmds()") };
	check(
		"点不能执行的命令 → 有解释、不填入输入框、一个请求都不发",
		clickedDead === true && l1.notice.hidden === false && l1.notice.text.includes("左栏") && l1.val === "/tree" && l1.net === netBeforeDead,
		`提示「${l1.notice.text}」输入框「${l1.val}」请求 ${netBeforeDead} → ${l1.net}`,
	);

	// 即便写得明明白白发出去，也拒绝（不悄悄当普通文本发给模型）
	await ev("__h.setInput('/tree ')");
	await settle(1);
	const netBeforeDead2 = await ev("window.__net.length");
	await ev("__h.key('Enter')");
	await settle(2);
	const l2 = { notice: await ev("__h.notice()"), net: await ev("window.__net.length") };
	check(
		"发 /tree → 明确拒绝（不当普通文本发给模型）",
		l2.notice.hidden === false && l2.notice.text.includes("不能执行") && l2.notice.text.includes("左栏") && l2.net === netBeforeDead2,
		`提示「${l2.notice.text}」`,
	);

	// /compact → 先二次确认（带当前用量 + 预计释放量），确认前一个请求都不发
	await ev("__h.setInput('/compact')");
	await settle(2);
	await ev("__h.key('Enter')");
	await settle(2);
	const l3 = { val: await ev("__h.inputVal()"), box: await ev("__h.cmds()") };
	check("面板里选 compact → 只填入（不当场压）", l3.val === "/compact " && l3.box?.hidden === true, `输入框「${l3.val}」`);

	const netBeforeAsk = await ev("window.__net.length");
	await ev("__h.key('Enter')");
	await settle(2);
	const l4 = { confirm: await ev("__h.confirm()"), net: await ev("window.__net.length") };
	check(
		"发 /compact → 先弹二次确认（有损操作，还没压）",
		l4.confirm?.hidden === false && l4.net === netBeforeAsk && JSON.stringify(l4.confirm.buttons) === JSON.stringify(["确认压缩", "取消"]),
		`确认框 hidden=${l4.confirm?.hidden} 按钮 ${JSON.stringify(l4.confirm?.buttons)}；请求 ${netBeforeAsk} → ${l4.net}`,
	);
	check(
		"确认文案说清有损 + 当前用量 + 预计释放量",
		/有损/.test(l4.confirm.text) && l4.confirm.text.includes("543,754") && l4.confirm.text.includes("预计释放") && l4.confirm.text.includes("523,754"),
		l4.confirm.text,
	);

	await ev("__h.clickConfirm('取消')");
	await settle(2);
	const l5 = { confirm: await ev("__h.confirm()"), net: await ev("window.__net.length") };
	check("取消 → 不压、一个请求都不发", l5.confirm?.hidden === true && l5.net === netBeforeAsk, `hidden=${l5.confirm?.hidden} 请求 ${netBeforeAsk} → ${l5.net}`);

	// 入口二：上下文用量那一行的「压缩」按钮
	const l6 = await ev("__h.compactBtn()");
	check("用量那一行有「压缩」按钮（和「余 340k」同一行）", l6?.hidden === false && l6.text === "压缩" && l6.display !== "none", JSON.stringify(l6));
	await ev("__h.clickCompactBtn()");
	await settle(2);
	const l7 = await ev("__h.confirm()");
	check("点「压缩」按钮 → 同样先确认", l7?.hidden === false && /有损/.test(l7.text), l7?.text);

	await ev("__h.clickConfirm('确认压缩')");
	await sleep(250);
	await settle(4);
	const l8 = {
		notice: await ev("__h.notice()"),
		net: await ev("window.__net"),
		bodies: await ev("__h.bodies()"),
		ctx: await ev("__h.ctx()"),
		hist: await ev("__h.histCount()"),
		confirm: await ev("__h.confirm()"),
	};
	const cbody = l8.bodies.find((b) => b.url.endsWith("/compact"));
	check(
		"确认后打到 POST /sessions/{id}/compact（没指示 → body 是 {}）",
		l8.net.includes(`POST /api/sessions/${fixture.id}/compact`) && cbody?.body === "{}",
		`body=${cbody?.body}，最近请求 ${JSON.stringify(l8.net.slice(-3))}`,
	);
	check(
		"压完有成功反馈（给出真实释放量）",
		l8.notice.hidden === false && l8.notice.text.includes("已压缩") && l8.notice.text.includes("543,754") && l8.notice.text.includes("531,409"),
		`提示「${l8.notice.text}」`,
	);
	check(
		"压完用量与正文都刷新到新的（用量→—、历史变短）",
		l8.ctx.text.includes("—/900k") && l8.hist === 2 && l8.confirm?.hidden === true,
		`用量「${l8.ctx.text}」历史 ${l8.hist} 条`,
	);
	const l8cut = await ev("__h.cut()");
	check(
		"压完正文里出现「✂ 压缩边界」（说清上面那些已不在上下文里）",
		l8cut?.index === 0 && l8cut.text.includes("已不在模型上下文里") && l8cut.text.includes("543,754") && l8cut.open === false,
		JSON.stringify(l8cut),
	);
	const l8open = await ev("__h.cutOpen()");
	check("边界块点开能看到那段摘要（真正进了上下文的东西）", l8open?.visible === true && l8open.body.includes("合成摘要"), JSON.stringify(l8open));

	// 边界落在正文中间时：块就插在那一条之前（而不是永远贴顶）
	await load(`${PAGE}?cut=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const lcut = { cut: await ev("__h.cut()"), msgs: await ev("__h.histCount()") };
	check(
		"压缩边界落在中间时：块插在「第一条还在上下文里的消息」之前（前两条在上）",
		lcut.cut?.msgsBefore === 2 && lcut.cut?.index === 3 && lcut.cut.text.includes("上面 2 条"),
		JSON.stringify(lcut),
	);
	// 反过来：没有压缩历史 → 一条消息都不少、也不画边界块
	await load(`${PAGE}?plain=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const lplain = { cut: await ev("__h.cut()"), msgs: await ev("__h.histCount()") };
	check(
		"没压缩过的会话：不画边界块，消息条数和压缩过的那个一致（没偷藏）",
		lplain.cut === null && lplain.msgs === lcut.msgs,
		`cut=${JSON.stringify(lplain.cut)}，${lplain.msgs} 条 vs ${lcut.msgs} 条`,
	);

	// 带额外指示的 /compact
	await load(`${PAGE}?builtin2=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__h.setInput('/compact 只留结论')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(2);
	const l9 = await ev("__h.confirm()");
	check("带参数的 /compact：确认框里写清附带指示", l9?.hidden === false && l9.text.includes("只留结论"), l9?.text);
	await ev("__h.clickConfirm('确认压缩')");
	await sleep(250);
	await settle(2);
	const l10 = (await ev("__h.bodies()")).find((b) => b.url.endsWith("/compact"));
	check("确认后把指示一并带给后端（发给 pi 的 compact(customInstructions)）", l10?.body === JSON.stringify({ instructions: "只留结论" }), `body=${l10?.body}`);

	// 无事可做（pi 的「Nothing to compact」）→ 照实说，不装成功
	await load(`${PAGE}?compactNone=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	const histBeforeNone = await ev("__h.histCount()");
	await ev("__h.setInput('/compact')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(2);
	await ev("__h.clickConfirm('确认压缩')");
	await sleep(250);
	await settle(2);
	const l11 = { notice: await ev("__h.notice()"), hist: await ev("__h.histCount()") };
	check(
		"没事可压（409 nothing-to-compact）→ 照实说，不装成功",
		l11.notice.hidden === false && l11.notice.text.includes("没有可压缩的东西") && l11.hist === histBeforeNone,
		`提示「${l11.notice.text}」（历史 ${histBeforeNone} → ${l11.hist} 条）`,
	);

	// 流式中：按钮点下去也明确拒绝
	await load(`${PAGE}?builtin3=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	const netBeforeBusy = await ev("window.__net.length");
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	await ev("__h.clickCompactBtn()");
	await settle(2);
	const l12 = { notice: await ev("__h.notice()"), net: await ev("window.__net.length"), btn: await ev("__h.compactBtn()"), confirm: await ev("__h.confirm()") };
	check(
		"流式中点「压缩」→ 明确拒绝并说明（不发请求、不弹确认）",
		l12.notice.hidden === false && l12.notice.text.includes("正在跑") && l12.net === netBeforeBusy && l12.confirm?.hidden === true,
		`提示「${l12.notice.text}」请求 ${netBeforeBusy} → ${l12.net}`,
	);
	check("流式中按钮看着按不动（blocked）", l12.btn?.cls.includes("blocked") === true, `class=${l12.btn?.cls}`);

	// 流式中发 /compact → 同样拒绝（不弹确认、不发请求）
	const netBeforeBusy2 = await ev("window.__net.length");
	await ev("__h.setInput('/compact ')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(2);
	const l13 = { notice: await ev("__h.notice()"), net: await ev("window.__net.length"), confirm: await ev("__h.confirm()") };
	check(
		"流式中发 /compact → 同样明确拒绝",
		l13.notice.hidden === false && l13.notice.text.includes("正在跑") && l13.net === netBeforeBusy2 && l13.confirm?.hidden === true,
		`提示「${l13.notice.text}」`,
	);

	// ── /model：候选来自 GET /models，执行走 POST /model ──
	await load(`${PAGE}?model=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__h.setInput('/model')");
	await settle(1);
	await ev("__h.key('Enter')");
	await settle(3);
	const m0 = { rows: await ev("__h.cmdRows()"), notice: await ev("__h.notice()"), val: await ev("__h.inputVal()"), net: await ev("window.__net"), note: await ev("__h.cmdNote()") };
	check(
		"只写 /model → 把候选递到眼前（说不清就不发）",
		m0.rows.length === fixture.models.length && m0.val === "/model " && m0.net.some((x) => x.includes("/models")),
		`${m0.rows.length} 个候选，输入框「${m0.val}」，提示「${m0.notice.text}」面板「${JSON.stringify(m0.note)}」请求 ${JSON.stringify(m0.net.slice(-6))}`,
	);
	check(
		"候选来自 GET /sessions/{id}/models，并标出当前那个",
		m0.rows[0].name === fixture.currentModel && m0.rows[0].src === "当前",
		JSON.stringify(m0.rows.map((r) => `${r.name}:${r.src}`)),
	);

	await ev("__h.setInput('/model gpt-6')");
	await settle(2);
	const m1 = await ev("__h.cmdRows()");
	check("参数模糊匹配（gpt-6 → litellm/gpt-6-astra）", m1.length === 1 && m1[0].name === "litellm/gpt-6-astra", JSON.stringify(m1.map((r) => r.name)));
	await ev("__h.key('Tab')");
	await settle(2);
	const m2 = await ev("__h.inputVal()");
	check("Tab 填入 provider/id", m2 === "/model litellm/gpt-6-astra ", `输入框「${m2}」`);

	const netBeforeModel = await ev("window.__net.length");
	await ev("__h.key('Enter')");
	await sleep(250);
	await settle(2);
	const m3 = { notice: await ev("__h.notice()"), net: await ev("window.__net"), bodies: await ev("__h.bodies()"), models: await ev("__h.cmdRows()") };
	const mbody = m3.bodies.find((b) => b.url.endsWith("/model"));
	check(
		"Enter → POST /sessions/{id}/model（body 带 model，也走真路由不再当普通文本）",
		m3.net.length > netBeforeModel && m3.net.includes(`POST /api/sessions/${fixture.id}/model`) && mbody && JSON.parse(mbody.body).model === "litellm/gpt-6-astra",
		`body=${mbody?.body}`,
	);
	check(
		"切完有反馈，并说清「只对本会话生效」",
		m3.notice.hidden === false && m3.notice.text.includes("模型已切到") && m3.notice.text.includes("litellm/gpt-6-astra") && m3.notice.text.includes("只对这条会话生效"),
		`提示「${m3.notice.text}」`,
	);

	// 冷会话 / 拿不到用量 → 压缩按钮不出现
	await load(`${PAGE}?ctxNull=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const l14 = { btn: await ev("__h.compactBtn()"), ctx: await ev("__h.ctx()") };
	check(
		"context=null（冷会话）→ 用量显示 —，压缩按钮**不出现**",
		l14.btn?.hidden === true && l14.btn.display === "none" && l14.ctx.text.includes("上下文 —"),
		`按钮 hidden=${l14.btn?.hidden} display=${l14.btn?.display}；用量「${l14.ctx.text}」`,
	);

	// ── N 未读：树上的实心红点 + 树顶那一行（状态在服务端）──
	phase("N 未读：红点 + 树顶那一行");
	// 场景 `?unread=1`（mock 扮 A）造好四个会话：未读·旧 / 未读·新 / 未读·在跑 / 已读，
	// 外加两个反例 —— 已归档的（有落定，但不算未读）、被归档父藏住的活子会话（不亮、不计数）。
	// 先把 mock 那个「服务端」的账清干净（它只在头一次初始化场景时间戳）。
	await ev("__h.forgetUnread()");
	await load(`${PAGE}?unread=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	const U = (await ev("window.__fixture")).unread; // 场景里的会话 id（上面那次里页没带 ?unread → 得重新问）
	const uOld = JSON.stringify(U.old);
	const uNew = JSON.stringify(U.new);
	const uRun = JSON.stringify(U.running);

	const n0 = {
		bar: await ev("__h.unreadBar()"),
		dots: await ev("__h.dots()"),
		old: await ev(`__h.unreadRow(${uOld})`),
		read: await ev(`__h.unreadRow(${JSON.stringify(U.read)})`),
	};
	check(
		"落定在我上次看过之后 → 那个会话亮红点（已读的那个不亮，且只占一个点）",
		n0.dots.length === U.count && [U.old, U.new, U.running].every((id) => n0.dots.includes(id)) && !n0.dots.includes(U.read) && n0.read.dot === false && n0.read.dotCount === 1,
		`亮点 ${JSON.stringify(n0.dots.map((x) => x.slice(-4)))}（期望 3 个）；已读那行点数=${n0.read.dotCount}`,
	);
	check(
		"未读的会话名加粗（第二个信号，不只靠颜色）",
		n0.old.bold === "600" && n0.read.bold !== "600" && n0.old.unread === true,
		`未读 font-weight=${n0.old.bold}，已读 font-weight=${n0.read.bold}`,
	);
	check(
		"树顶那一行：`N 个会话有新东西 →`，N = **当前可见**的未读数",
		n0.bar.hidden === false && n0.bar.text === "3 个会话有新东西 →" && n0.bar.above === true && Number(n0.bar.n) === n0.dots.length,
		`「${n0.bar.text}」（树里亮着 ${n0.dots.length} 个，条在树上方=${n0.bar.above}）`,
	);

	// 归档那一支：已归档的孩子有落定 → 不算未读；被它藏住的活子会话 → 不亮、也不计数。
	// （撑开折叠才看得到它们 —— 正好 验「展开了也不亮」和「数字没被藏住的那个 +1」。）
	await ev(`__h.clickFold(${JSON.stringify(fixture.id)})`);
	await settle(2);
	const n1 = {
		arch: await ev(`__h.unreadRow(${JSON.stringify(U.archivedChild)})`),
		hidden: await ev(`__h.unreadRow(${JSON.stringify(U.hiddenLive)})`),
		bar: await ev("__h.unreadBar()"),
		dots: await ev("__h.dots()"),
	};
	check(
		"归档的会话不算未读（它有新落定也不亮）",
		n1.arch?.dot === false && n1.arch?.unread === false,
		`已归档那个：红点=${n1.arch?.dot} unread=${n1.arch?.unread}`,
	);
	check(
		"被归档父藏住的活子会话：掀开折叠也不亮、也不计入树顶那个数字",
		n1.hidden && n1.hidden.dot === false && n1.hidden.unread === false && n1.bar.text === "3 个会话有新东西 →" && n1.dots.length === 3,
		`藏住的活子会话：红点=${n1.hidden?.dot}；条「${n1.bar.text}」；亮点 ${n1.dots.length} 个`,
	);

	// 一个时刻只画一个点：未读（红）**优先于**在跑（脉冲环）—— 两个信号都成立时，脉冲环让位
	const n2 = n0.dots.includes(U.running) ? await ev(`__h.unreadRow(${uRun})`) : null;
	const n2bar = await ev("__h.unreadBar()");
	check(
		"「在跑 + 未读」都成立时：只画一个点（红点），脉冲环让位",
		n2?.dot === true && n2?.dotCount === 1 && n2?.running === false && n2.dotBg === "rgb(255, 77, 77)" && n2.dotAnim === "none" && n2.bold === "600" && n2.dotW === 7 && n0.dots.includes(U.running),
		`行内点数=${n2?.dotCount}（期望 1）· 红点=${n2?.dot}（${n2?.dotBg}/${n2?.dotW}px）· 脉冲环=${n2?.running}（期望 false）`,
	);

	// 点树顶那一行 → 跳到**最旧的**未读（按落定时间升序），顺手把那个标成已读
	const barTitle = n2bar.title;
	const clickedBar = await ev("__h.clickUnreadBar()");
	await sleep(250);
	await settle(3);
	const n3 = {
		hash: await ev("__h.hash()"),
		active: await ev("__h.activeRow()"),
		seenOld: await ev(`__h.seenFor(${uOld})`),
		bar: await ev("__h.unreadBar()"),
		oldRow: await ev(`__h.unreadRow(${uOld})`),
		dots: await ev("__h.dots()"),
		state: await ev("__h.unreadState()"),
	};
	check(
		"点树顶那一行 → 跳到**最旧的**未读（不是最新那个）",
		clickedBar === true && n3.hash === U.old && n3.active === U.old && (barTitle ?? "").includes("未读·旧"),
		`跳到了 #${n3.hash?.slice(-4)}（期望最旧的 ${U.old.slice(-4)}）；条上的提示「${barTitle}」`,
	);
	check(
		"跳过去也算「看过」：红点消失、数字 3 → 2，服务端记下了 seen",
		n3.seenOld === 1 && n3.oldRow.dot === false && n3.bar.text === "2 个会话有新东西 →" && n3.dots.length === 2 && n3.state.seen[U.old] >= n3.state.settled[U.old],
		`seen ${n3.seenOld} 次，亮点 ${n3.dots.length} 个，条「${n3.bar.text}」`,
	);

	// 刷新：**状态在服务端**（不是内存 / 不是 localStorage）→ 没看过的红点还在，看过的没回来
	await load(`${PAGE}?unread=1`); // 不带 hash：这一下没有会话被打开 → 谁也不该被标已读
	await sleep(400);
	await settle(3);
	const n4 = {
		bar: await ev("__h.unreadBar()"),
		dots: await ev("__h.dots()"),
		seen: await ev("__h.seenPosts()"),
		local: await ev("__h.localKeys()"),
	};
	check(
		"刷新后：还没看过的红点仍在（2 个），已经看过的那个没回来",
		n4.dots.length === 2 && n4.dots.includes(U.new) && n4.dots.includes(U.running) && !n4.dots.includes(U.old) && n4.bar.n === "2",
		`刷新后亮点 ${n4.dots.length} 个（含 U_NEW/U_RUN），条「${n4.bar.text}」`,
	);
	check(
		"刷新这一下没打开任何会话 → 一个 seen 都没发；状态也不在浏览器里（localStorage 空空）",
		n4.seen.length === 0 && n4.local.length === 0,
		`seen 请求 ${JSON.stringify(n4.seen)}；localStorage 键 ${JSON.stringify(n4.local)}`,
	);

	// 打开并跟随底部 → 「我看过了」
	const seenNewBefore = await ev(`__h.seenFor(${uNew})`);
	await ev(`location.hash = '#' + ${uNew}`);
	await sleep(300);
	await settle(4);
	const n5 = {
		dist: Math.round(await ev("__h.dist()")),
		seen: await ev(`__h.seenFor(${uNew})`),
		row: await ev(`__h.unreadRow(${uNew})`),
		bar: await ev("__h.unreadBar()"),
		state: await ev("__h.unreadState()"),
	};
	check(
		"打开并跟随底部 → 红点消失（数字 2 → 1），而且真的发了 POST /sessions/{id}/seen",
		n5.seen === seenNewBefore + 1 && n5.dist <= 4 && n5.row.dot === false && n5.bar.n === "1" && n5.state.seen[U.new] >= n5.state.settled[U.new],
		`seen 请求 ${seenNewBefore} → ${n5.seen}，距底 ${n5.dist}px，条「${n5.bar.text}」`,
	);

	// 视口没跟着底部（滚上去读历史）→ 打开也不该算「看过」
	await ev("__h.up(300)");
	await settle(2);
	const n6a = { dist: Math.round(await ev("__h.dist()")), following: (await ev("__h.btn()"))?.show === false };
	const seenRunBefore = await ev(`__h.seenFor(${uRun})`);
	await ev(`__h.clickRow(${uRun})`);
	await sleep(300);
	await settle(3);
	const n6 = { seen: await ev(`__h.seenFor(${uRun})`), row: await ev(`__h.unreadRow(${uRun})`), bar: await ev("__h.unreadBar()") };
	check(
		"视口没跟着底部（滚上去了）时打开 → 不标已读（红点还在、数字没减）",
		n6a.dist > 4 && n6a.following === false && n6.seen === seenRunBefore && n6.row.dot === true && n6.bar.n === "1",
		`滚上去了（距底 ${n6a.dist}px）→ seen ${seenRunBefore} → ${n6.seen}，红点=${n6.row.dot}，条「${n6.bar.text}」`,
	);
	// 再点一下（此刻视口已被打开动作带到底）→ 这次算看过；也是最后一个未读 → 整条消失
	await ev(`__h.clickRow(${uRun})`);
	await sleep(300);
	await settle(3);
	const n6b = {
		seen: await ev(`__h.seenFor(${uRun})`),
		row: await ev(`__h.unreadRow(${uRun})`),
		bar: await ev("__h.unreadBar()"),
		dots: await ev("__h.dots()"),
	};
	check(
		"再点一次（此刻贴着底）→ 标已读：红点消失（脉冲环回来、仍只有一个点），未读清零后那一行整条不显示（不是显示 0）",
		n6b.seen === seenRunBefore + 1 && n6b.row.dot === false && n6b.row.running === true && n6b.row.dotCount === 1 && n6b.bar.hidden === true && n6b.bar.display === "none" && n6b.bar.text === "" && n6b.dots.length === 0,
		`seen 又 +1（${n6b.seen}）；红点=${n6b.row.dot} 脉冲环=${n6b.row.running} 行内点数=${n6b.row.dotCount}；条 hidden=${n6b.bar.hidden} 文案「${n6b.bar.text}」`,
	);

	// 正在看着的会话跑完一轮 → 不算未读（我看见了），而且 seen 真的落到服务端
	await ev(`__h.settle(${uRun})`); // 服务端又记了一次落定（晚于刚才那次 seen）
	await settle(2);
	const n7pre = await ev("__h.unreadState()");
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await sleep(350);
	await settle(4);
	const n7 = { row: await ev(`__h.unreadRow(${uRun})`), bar: await ev("__h.unreadBar()"), state: await ev("__h.unreadState()") };
	check(
		"我看着它跑完这一轮 → 不亮红点（那就是「我看着它落定」）",
		n7pre.settled[U.running] > n7pre.seen[U.running] && n7.row.dot === false && n7.bar.hidden === true && n7.state.seen[U.running] >= n7.state.settled[U.running],
		`跑完前服务端口径「落定 ${n7pre.settled[U.running] - n7pre.seen[U.running]}ms 新于 seen」→ 跑完后红点=${n7.row.dot}`,
	);

	// 后台会话落定 → 树每 5 秒拉一次 /tree，红点在那之后出现
	await ev(`__h.settle(${JSON.stringify(U.read)})`); // 本来已读的那个，在后台又落定了一次
	await sleep(5400);
	await settle(3);
	const n8 = { row: await ev(`__h.unreadRow(${JSON.stringify(U.read)})`), bar: await ev("__h.unreadBar()"), dots: await ev("__h.dots()") };
	check(
		"后台会话落定 → 红点出现（数字 +1）；没看过的就是没看过",
		n8.row.dot === true && n8.bar.n === "1" && n8.dots.length === 1,
		`后台那个红点=${n8.row.dot}，条「${n8.bar.text}」，亮点 ${n8.dots.length} 个`,
	);

	// 一个未读都没有 → 那一行不显示（不是长着一个 0）
	await load(PAGE);
	await sleep(300);
	await settle(2);
	const n9 = { bar: await ev("__h.unreadBar()"), dots: await ev("__h.dots()") };
	check(
		"没有任何未读 → 树顶那一行不显示",
		n9.bar.hidden === true && n9.bar.display === "none" && n9.dots.length === 0,
		`条 hidden=${n9.bar.hidden} display=${n9.bar.display}`,
	);

	// ── G2 标题实时性：树上的名字**不刷新页面**就变（A 的树级 SSE `GET /events`）──
	// mock 的 /tree **永远不返回新名字**（它的节点是死的）→ DOM 上那个新名字只可能从 SSE 事件来。
	phase("G2 标题实时性（树级 SSE）");
	await load(PAGE);
	await sleep(300);
	await ev(`location.hash = '#' + ${JSON.stringify(fixture.id)}`); // 打开主会话：顺带确认会话那条流没被顶掉
	await sleep(300);
	await settle(3);
	const child = fixture.child;
	const NEWNAME = "模型自己起的标题";
	const t0 = {
		streams: await ev("__h.streams()"),
		childName: await ev(`__h.name(${JSON.stringify(child)})`),
		rows: await ev("__h.rowsCount()"),
	};
	check(
		"两条流分得清：树级 GET /events 与会话级 /sessions/{id}/stream 都活着（__es 仍是会话那条）",
		t0.streams.tree === "/api/events" && t0.streams.sess === `/api/sessions/${fixture.id}/stream`,
		`tree=${t0.streams.tree} sess=${t0.streams.sess}`,
	);

	await ev("__h.markAlive()"); // 页面一旦刷新/导航，这个标记就没了
	const netBefore = await ev("__h.netCount('/api/tree')");
	const emitted = await ev(`__h.titleEvent(${JSON.stringify(child)}, ${JSON.stringify(NEWNAME)})`);
	await sleep(120);
	await settle(3);
	const t1 = {
		name: await ev(`__h.name(${JSON.stringify(child)})`),
		rows: await ev("__h.rowsCount()"),
		hash: await ev("__h.hash()"),
		alive: await ev("__h.alive()"),
		net: await ev("__h.netCount('/api/tree')"),
		server: await ev(`__h.serverTreeName(${JSON.stringify(child)})`),
		tip: await ev(`__h.titleOf(${JSON.stringify(child)})`),
	};
	check(
		"改标题的事件到达 → 树上那一行**当场**变名（没刷新页面、没换会话、行数不变）",
		emitted === true && t1.name === NEWNAME && t1.rows === t0.rows && t1.hash === fixture.id && t1.alive === true,
		`「${t0.childName}」→「${t1.name}」（行数 ${t0.rows}→${t1.rows}，仍在 #${String(t1.hash).slice(0, 8)}，页面活着=${t1.alive}）`,
	);
	check(
		"这个新名字只可能来自 SSE：假服务端的 /tree 里它还是旧名字",
		t1.server === t0.childName && t1.name !== t1.server,
		`服务端 /tree 仍说「${t1.server}」而 DOM 上是「${t1.name}」`,
	);
	check(
		"名字的来源（seed/auto/manual）也落到那一行的 tooltip 里",
		String(t1.tip).includes("标题：模型自己起的"),
		`tooltip 末行「${String(t1.tip).split("\n").slice(-1)}」`,
	);

	const head0 = await ev("__h.headTitle()");
	await ev(`__h.titleEvent(${JSON.stringify(fixture.id)}, '主会话·新标题')`);
	await sleep(120);
	await settle(3);
	const t2 = { head: await ev("__h.headTitle()"), alive: await ev("__h.alive()") };
	check(
		"被打开的那个会话改标题 → 顶上那一行也当场变（同一帧，也不用刷新）",
		head0 === "主会话" && t2.head === "主会话·新标题" && t2.alive === true,
		`顶部「${head0}」→「${t2.head}」`,
	);

	await ev(`__h.titleEvent(${JSON.stringify(child)}, null)`);
	await sleep(120);
	await settle(3);
	const t3 = await ev(`__h.name(${JSON.stringify(child)})`);
	check(
		"标题被清空（name=null）→ 那一行退回短 id（不给你看一行空白）",
		t3 === child.slice(-8),
		`那一行现在显示「${t3}」（期望短 id ${child.slice(-8)}）`,
	);

	const netBefore2 = await ev("__h.netCount('/api/tree')");
	await ev("__h.titleEvent('99999999-0000-4000-8000-000000000999', '树上还没有的会话')");
	await sleep(200);
	await settle(3);
	const netAfter2 = await ev("__h.netCount('/api/tree')");
	check(
		"事件里的会话树上还没有 → 拉一次 /tree 把它请进来（不是默默丢掉）",
		netAfter2 > netBefore2,
		`/tree 请求 ${netBefore2} → ${netAfter2}`,
	);

	// ── H 全程页面无异常，且一个真接口都没打 ──

	phase("H 干净度");
	await settle(2);
	check("页面没有未捕获异常 / console.error", pageProblems.length === 0, pageProblems.join(" | "));
} catch (e) {
	fail("测试跑挂了", String(e.stack ?? e));
} finally {
	console.log("\n── 结果 ──");
	for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}${r.detail ? `  —— ${r.detail}` : ""}`);
	if (failed) console.log(`\n❌ ${results.length} 项断言里失败 ${failed} 项`);
	else console.log(`\n✅ ${results.length} 项断言全部通过`);
	ws.close();
	child.kill("SIGKILL");
	staticSrv.close();
	cleanupProfile();
}

process.exit(failed ? 1 : 0);
