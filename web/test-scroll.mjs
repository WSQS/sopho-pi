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

/** 把 chromium **连同它 fork 出来的那一串子进程**一起杀掉。
 *  · Linux/macOS：`detached:true` 让主进程当进程组长 ⇒ `kill(-pid)` 收掉整组；
 *  · Windows：没有进程组这套，退回 kill 主进程（chromium 的 job object 会带着子进程走）。
 *  · 另一个入口是 `process.on("exit")`：异常退出（stdout 被下游关掉之类）时 `finally` 不一定跑，
 *    那种情况下这些渲染进程会一直留着。 */
function killChrome() {
	if (killChrome.done) return;
	killChrome.done = true;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			/* 已经死了 */
		}
	}
}
process.on("exit", killChrome);

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
	// ⚠️ `detached: true` 不是为了"脱离"，是为了**能按进程组杀干净**：
	// chromium 会 fork 出一串渲染/zygote/crashpad 进程；只 kill 那一个主进程的话，它们会被
	// 重新挂到别的父上活下来（实测攒了 49 个进程 / 116 个残留 profile 目录）。见下面 killChrome()。
	{ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
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
		// 「排队中」的乐观块（app.mjs 的 pendingUserEl / applyQueue）：kind = steering|followUp，
		// msgTexts = 历史区里**普通**用户块（= 已经进正文的那些）的文本。
		queued() {
			return [...document.querySelectorAll('#hist .msg.user.queued')].map(x => ({ kind: x.dataset.queue || null, text: x.textContent || '' }));
		},
		userTexts() {
			return [...document.querySelectorAll('#hist .msg.user:not(.queued)')].map(x => x.textContent || '');
		},
		queueEvent(steering, followUp) { window.__es && window.__es._emit({ t: 'queue', steering: steering || [], followUp: followUp || [] }); },
		// 工具状态色：量真的 computed style（背景 + 左边缘色），不只看 class 名
		toolStates(sel) {
			return [...document.querySelectorAll(sel || '.tool')].map(b => {
				const cs = getComputedStyle(b);
				return { state: b.getAttribute('data-state'), bad: b.classList.contains('bad'),
					bg: cs.backgroundColor, edge: cs.borderLeftColor,
					res: (b.querySelector('.tres') || {}).textContent ?? null };
			});
		},
		// ── 「同一轮不许画两遍」用的探针（历史块 + 直播块一起数）──
		// allCards：整页（#messages 里）所有工具卡，带 where=hist|live —— 重复画就是同一个工具出两张。
		allCards(sel) {
			return [...document.querySelectorAll(sel || '#messages .tool')].map(b => {
				const cs = getComputedStyle(b);
				return { where: b.closest('#liveBox') ? 'live' : 'hist', state: b.getAttribute('data-state'),
					name: (b.querySelector('.tname') || {}).textContent, args: (b.querySelector('.targs') || {}).textContent,
					res: (b.querySelector('.tres') || {}).textContent ?? null, bg: cs.backgroundColor };
			});
		},
		// occur：一段文字在整页（#messages）里出现几次 —— 「已产出的正文只出现一次」就这么量。
		occur(t) { const s = document.querySelector('#messages').textContent; return s.split(t).length - 1; },
		who() { return { hist: document.querySelectorAll('#hist .who').length, live: document.querySelectorAll('#liveBox .who').length }; },
		liveParts() { return window.__liveParts ? window.__liveParts() : null; },
		// 真触发路径之一（从后台切回来 → load() + requestReload()）：改 document.hidden 改不了，
		// 但这个监听器只关心「事件来了 + 当前可见」，所以派一个事件就走的同一条代码。
		pokeReload() { document.dispatchEvent(new Event('visibilitychange')); return true; },
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
		// ── 中断（= TUI 的 Esc）──
		abortBtn() { const b = document.querySelector('#abort'); return b ? { hidden: b.hidden, text: b.textContent, cls: b.className, title: b.title, display: getComputedStyle(b).display, disabled: b.disabled } : null; },
		clickAbortBtn() { const b = document.querySelector('#abort'); if (!b || b.hidden) return false; b.click(); return true; },
		abortMark() { const a = document.querySelector('#hist .aborted'); return a ? { text: a.textContent, cls: a.className } : null; },
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
		// ── L1 带宽：把某个会话的 /messages 变慢，而且**认 abort**（真 fetch 就是这么干的）──
		// 延迟里被 abort 掉就把会话 id 记进 __aborted —— 这是「在飞请求真被取消」的观测点。
		patchMsgDelay(id, ms, text, afterMs) {
			window.__msgPatch = window.__msgPatch || {};
			window.__msgPatch[id] = { ms, text, afterMs, n: 0 };
			if (window.__msgPatched) return true;
			window.__msgPatched = true;
			window.__aborted = [];
			const orig = window.fetch;
			window.fetch = async (u, init) => {
				const m = String(u).match(/\\/sessions\\/([^/]+)\\/messages/);
				const cfg = m && window.__msgPatch[m[1]];
				if (!cfg) return orig(u, init);
				const wait = cfg.n++ === 0 ? cfg.ms : (cfg.afterMs ?? cfg.ms);
				await new Promise((ok, no) => {
					const sig = init && init.signal;
					const t = setTimeout(ok, wait);
					const bang = () => { clearTimeout(t); window.__aborted.push(m[1]); no(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
					if (sig) sig.aborted ? bang() : sig.addEventListener('abort', bang, { once: true });
				});
				const d = await (await orig(u, init)).json();
				return new Response(JSON.stringify({ ...d, messages: [{ role: 'assistant', text: cfg.text }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			};
			return true;
		},
		aborted() { return window.__aborted || []; },
		histText() { const h = document.querySelector('#hist'); return h ? h.textContent : ''; },
		// 向**假服务端**问一次：它那边的树里这个名字是什么（证明 DOM 上那个新名字不是从 /tree 来的）
		serverTreeName(id) { return fetch('/api/tree').then(r => r.json()).then(d => (d.nodes.find(n => n.id === id) || {}).name ?? null); },
		setInput(v) { const i = document.querySelector('#input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); },
		key(k, opts) { const i = document.querySelector('#input'); return i.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}))); },
		inputVal() { return document.querySelector('#input').value; },
		inputDisabled() { return document.querySelector('#input').disabled; },
		notice() { const n = document.querySelector('#notice'); return { hidden: n.hidden, text: n.textContent }; },
		bodies() { return window.__bodies.map(b => ({ url: b.url, body: b.body })); },
		// ── @ 会话选择器（web/mentions.mjs）──
		mentions() { const b = document.querySelector('#mentions'); return b ? { hidden: b.hidden, display: getComputedStyle(b).display } : null; },
		mentionRows() { return [...document.querySelectorAll('#mentions .cmd')].map(r => ({ name: (r.querySelector('.cname') || {}).textContent || '', sel: r.classList.contains('sel'), badges: [...r.querySelectorAll('.csrc')].map(x => x.textContent), uuid: (r.querySelector('.cdesc') || {}).textContent || '', title: r.title || '' })); },
		mentionHint() { const h = document.querySelector('#mentions .cmdhint'); const k = document.querySelector('#mentions .cmdkeys'); return { hint: h ? h.textContent : null, keys: k ? k.textContent : null }; },
		mentionGeom() { const b = document.querySelector('#mentions'), i = document.querySelector('#input'); if (!b || b.hidden) return null; const rb = b.getBoundingClientRect(), ri = i.getBoundingClientRect(); return { aboveInput: rb.bottom <= ri.top + 1, inComposer: b.parentElement.id === 'composer' }; },
		mousedownMention(name) { const r = [...document.querySelectorAll('#mentions .cmd')].find(x => ((x.querySelector('.cname') || {}).textContent) === name); if (!r) return false; r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; },
		inputValAt() { const i = document.querySelector('#input'); return { v: i.value, start: i.selectionStart, end: i.selectionEnd }; },
		setInputAt(v, n) { const i = document.querySelector('#input'); i.value = v; i.focus(); i.setSelectionRange(n, n); i.dispatchEvent(new Event('input', { bubbles: true })); return true; },
		msgCount() { return window.__bodies.filter(b => b.url.includes('/message')).length; },
		lastMsgBody() { const b = [...window.__bodies].reverse().find(x => x.url.includes('/message')); try { return b ? JSON.parse(b.body) : null; } catch { return null; } },
		// ── 扩展消息（extras）：「命令输出」那一块到底画出来没有、样式是不是真的与助手正文不同 ──
		extras() {
			const exts = [...document.querySelectorAll('#hist .ext')];
			const cs = exts[0] ? getComputedStyle(exts[0]) : null;
			const asst = document.querySelector('#hist .msg.assistant');
			return {
				box: !!document.querySelector('#hist .extras'),
				count: exts.length,
				texts: exts.map(x => (x.querySelector('.extbody') || {}).textContent || ''),
				badge: (document.querySelector('#hist .extbadge') || {}).textContent || '',
				src: (document.querySelector('#hist .extsrc') || {}).textContent || '',
				bg: cs ? cs.backgroundColor : null,
				borderLeftWidth: cs ? parseFloat(cs.borderLeftWidth) : 0,
				asstBg: asst ? getComputedStyle(asst).backgroundColor : null,
				insideMsg: !!document.querySelector('#hist .msg .ext'),
			};
		},
		// ── 新建会话面板 ──
		clickNew() { const b = document.querySelector('#new'); if (!b) return false; b.click(); return true; },
		newBox() { const b = document.querySelector('#newbox'); return b ? { hidden: b.hidden, display: getComputedStyle(b).display } : null; },
		newRecentOptions() { return [...document.querySelectorAll('#newrecent option')].map(o => o.value); },
		newHint() { const h = document.querySelector('#newhint'); return h ? h.textContent : ''; },
		newCwdVal() { const i = document.querySelector('#newcwd'); return i ? i.value : null; },
		setNewCwd(v) { const i = document.querySelector('#newcwd'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); return true; },
		pickRecent(n) { const s = document.querySelector('#newrecent'); const o = s.options[n]; if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; },
		clickNewGo() { const b = document.querySelector('#newgo'); if (!b) return false; b.click(); return true; },
		lastNewSessionBody() { const b = [...window.__bodies].reverse().find(x => x.url === '/api/sessions' && String(x.method || '').toUpperCase() === 'POST'); try { return b ? JSON.parse(b.body) : null; } catch { return null; } },
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

/** 导航一次，等 load 事件（或超时）。 */
const navOnce = async (url, ms) => {
	const loaded = Promise.race([
		new Promise((ok) => listeners.push((m) => m.method === "Page.loadEventFired" && ok("ok"))),
		sleep(ms).then(() => "timeout"),
	]);
	await send("Page.navigate", { url });
	return await loaded;
};

const load = async (url) => {
	const t0 = Date.now();
	let how = await navOnce(url, 12_000);
	// 偶发：`?abort…` 那几个 mock 场景下，这个文档的 load 事件**根本不来**（实测同一份代码 4 次
	// 里挂 1-2 次；把超时拉到 30s 照样挂 → 不是"慢"，是那次导航的文档没走到 load）。
	// 文档的 load 要等**模块求值完**，而 app.mjs 顶层有 `await load()` + `await open(...)`。
	// 重试一次 = 换一次干净的导航，比继续等/拉长超时都能治偶发。
	if (how === "timeout") {
		console.log(`  （load 没来，重试一次导航：${url}）`);
		how = await navOnce(url, 20_000);
	}
	if (how === "timeout") throw new Error(`导航没等到 load（12s+20s 两次）：${url}`);
	const probe = String(await ev("document.title + ' | #messages=' + document.querySelectorAll('#messages').length"));
	if (!probe.includes("#messages=1")) throw new Error(`页面没加载对（${url}）：${probe}`);
	if (Date.now() - t0 > 4000) console.log(`  （导航耗时 ${Date.now() - t0}ms）`);
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
	check("主界面有到阅读页的入口（a.mini → /reading.html）", await ev("!!document.querySelector('a[href=\"/reading.html\"]')"));
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

	// ── I2 流式中发消息：直播块**不许被抹掉** ──
	// 根因（已核到行）：`web/app.mjs` 的 send() 成功分支**无条件** `live = { parts: [], running: true, error: null }`。
	// 流式中发 steer / followUp 时，那一刻 live 里攒着的（= 还没落盘的）thinking / 工具 / 正文
	// 会被**整块清掉** —— 用户看到的就是「发完消息，中间那段直播内容凭空消失、再从句子中间重续」。
	// 判据（本仓的行为契约）：发消息前后 **#liveBox 不缩短、part 数不减少、发消息前的前缀还在**；
	// 且**空闲**时发消息（新起一轮）该清还得清（别把上一轮残块留在屏幕上）。
	phase("I2 流式中发消息不抹直播块（steer/followUp）");
	await load(`${PAGE}?steer=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await ev("__es._emit({ t: 'thinking', d: '思考甲：发消息前就流出来的内容。' })");
	await ev("__es._emit({ t: 'tool', phase: 'start', id: 's1', name: 'bash', args: { command: 'ls' } })");
	await ev("__es._emit({ t: 'text', d: '正文甲：发消息之前已经流出来的一段。' })");
	await settle(3);
	const ib = { len: await ev("__h.liveLen()"), shape: await ev("__h.liveShape()"), text: await ev("document.querySelector('#liveBox').textContent") };
	check(
		"前置：直播块已有 thinking→工具→正文（且这一轮在跑）",
		ib.len > 0 && ib.shape?.length === 3 && ib.text.includes('正文甲'),
		`liveLen=${ib.len} shape=${JSON.stringify(ib.shape)}`,
	);
	await ev("__h.setInput('插话：还在跑的时候发第二条')");
	await ev("__h.key('Enter')"); // live.running === true → 走 steer
	await sleep(180); // 等这一发 POST /message 落地（send() 是 async）
	await settle(4);
	const ia = { len: await ev("__h.liveLen()"), shape: await ev("__h.liveShape()"), text: await ev("document.querySelector('#liveBox').textContent"), body: await ev("__h.lastMsgBody()") };
	check(
		"★流式中发消息：直播块**没被抹掉**（长度不缩、段数不减、发消息前的前缀还在）",
		ia.len >= ib.len && (ia.shape?.length ?? 0) >= (ib.shape?.length ?? 0) && ia.text.includes('正文甲'),
		`liveLen ${ib.len} → ${ia.len}；shape ${JSON.stringify(ib.shape)} → ${JSON.stringify(ia.shape)}；前缀「正文甲」还在？ ${ia.text.includes('正文甲')}`,
	);
	check(
		"发出去的那条带 streamingBehavior=steer（插话语义没被改成新 prompt）",
		ia.body?.behavior === 'steer',
		`POST /message body = ${JSON.stringify(ia.body)}`,
	);
	await ev("__h.emit(' 正文乙：发消息之后新到的一段。')");
	await settle(3);
	const ic = { len: await ev("__h.liveLen()"), text: await ev("document.querySelector('#liveBox').textContent") };
	check(
		"之后的新 delta 照常续在原来的块上（不清 ≠ 冻住）",
		ic.len > ia.len && ic.text.includes('正文甲') && ic.text.includes('正文乙'),
		`liveLen ${ia.len} → ${ic.len}；两段都在？ ${ic.text.includes('正文甲') && ic.text.includes('正文乙')}`,
	);
	// 空闲时（新一轮）：该清还得清 —— 别把上一轮的残块留在屏幕上
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await settle(5);
	await ev("__h.setInput('新一轮的第一条')");
	await ev("__h.key('Enter')");
	await sleep(180);
	await settle(4);
	const ifresh = await ev("document.querySelector('#liveBox').textContent");
	check(
		"空闲时发消息（新起一轮）：直播块是干净的（不残留上一轮的正文甲/乙）",
		!ifresh.includes('正文甲') && !ifresh.includes('正文乙'),
		`#liveBox = ${JSON.stringify(ifresh.slice(0, 60))}`,
	);

	// ── I3 压缩中发消息：前端**明确拒绝**（别让用户走进“202 却丢”那条路）──
	// pi 在压缩期间拒收任何 prompt（`Cannot submit a prompt while compaction is in progress.`）。
	// 后端现在会 409 并把原话带回来（见 test/compact-window.mjs），但前端该在**发出去之前**就拦：
	// 不发 /message、输入**保留**、给一句人话 —— 而不是等后端把错误弹回来。
	phase("I3 压缩中发消息被明确拒绝");
	await load(`${PAGE}?i3=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	await ev("__es._emit({ t: 'compact', phase: 'start' })");
	await settle(3);
	const i3before = await ev("window.__net.filter(x => x.endsWith('/message')).length");
	await ev("__h.setInput('压缩中试图发送的消息')");
	await ev("__h.key('Enter')");
	await sleep(180);
	await settle(3);
	const i3 = { net: await ev("window.__net.filter(x => x.endsWith('/message')).length"), val: await ev("__h.inputVal()"), notice: await ev("__h.notice()") };
	check("压缩中发消息：**没有**发出 /message（拦在前端）", i3.net === i3before, `/message ${i3before} → ${i3.net}`);
	check("压缩中发消息：输入**保留**（用户能改 / 等完再发）", i3.val === '压缩中试图发送的消息', `input=${JSON.stringify(i3.val)}`);
	check("压缩中发消息：给一句人话（不是静默）", !i3.notice.hidden && /压缩/.test(i3.notice.text), `notice=${JSON.stringify(i3.notice)}`);
	// 压缩跑完 → 同样一条消息发得出去（恢复）
	await ev("__es._emit({ t: 'compact', phase: 'end' })");
	await settle(4);
	await ev("__h.setInput('压缩跑完之后的消息')");
	await ev("__h.key('Enter')");
	await sleep(180);
	await settle(3);
	const i3after = await ev("window.__net.filter(x => x.endsWith('/message')).length");
	check("压缩跑完 → 同样的发送**发得出去**（恢复）", i3after > i3.net, `/message ${i3.net} → ${i3after}`);

	// ── I4 队列可观测：插话「排队中 → 进正文后消失」──
	// pi 有 `queue_update` 事件，宿主 `wireOf` 把它转发成 `{t:"queue"}`；前端据此把还没投给模型的
	// 插话画成「排队中」（对齐 TUI 的 `Steering:`/`Follow-up:` 待发项），而不是当成已发出的历史消息。
	// 队列里没那条了 = 已被注入 ⇒ 自动清掉「排队中」（不靠猜/轮询）；进正文后再从 pendingUser 消失。
	phase("I4 插话「排队中」态 + 队列对账");
	await load(`${PAGE}?i4=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	await ev("window.__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	await ev("__h.setInput('排队观察-甲')");
	await ev("__h.key('Enter')"); // live.running → 走 steer；POST /message 由 mock 回 202
	await sleep(180);
	await settle(3);
	const i4a = { queued: await ev("__h.queued()"), users: await ev("__h.userTexts()") };
	check("还没收到队列事件：先按普通已发消息画（不冒充“排队中”）", i4a.queued.length === 0 && i4a.users.some((t) => t.includes('排队观察-甲')), `queued=${JSON.stringify(i4a.queued)}`);
	await ev("__h.queueEvent(['排队观察-甲'], [])");
	await settle(3);
	const i4b = await ev("__h.queued()");
	check("收到 {t:'queue', steering:[那条]} → 画成「排队中 · steering」", i4b.length === 1 && i4b[0].kind === 'steering' && /排队中/.test(i4b[0].text), JSON.stringify(i4b));
	check("如实说出时机（steer = 本轮工具跑完、下次请求模型前注入）", /工具跑完/.test(i4b[0].text) && /下次请求模型前/.test(i4b[0].text), JSON.stringify(i4b[0].text));
	// 再发一条 Alt+Enter（followUp）—— 另一种队列、另一种时机
	await ev("__h.setInput('排队观察-乙')");
	await ev("__h.key('Enter', { altKey: true })");
	await sleep(180);
	await settle(3);
	await ev("__h.queueEvent(['排队观察-甲'], ['排队观察-乙'])");
	await settle(3);
	const i4c = await ev("__h.queued()");
	check("followUp 队列里那条 → 「排队中 · followUp」，并说清「真停下来时才注入」", i4c.length === 2 && i4c.some((x) => x.kind === 'followUp' && /真停下来/.test(x.text)), JSON.stringify(i4c));
	await ev("__h.queueEvent([], [])");
	await settle(3);
	const i4d = await ev("__h.queued()");
	check("队列里没有了（= 被注入）→ 「排队中」自动清掉", i4d.length === 0, JSON.stringify(i4d));
	// 进正文：让 mock 的 /messages 带上这条，再触发一次 reload（run end 会拉）
	await ev("window.__histExtraUser = '排队观察-甲'");
	await ev("window.__es._emit({ t: 'run', phase: 'end' })");
	await sleep(300);
	await settle(6);
	const i4e = { queued: await ev("__h.queued()"), users: await ev("__h.userTexts()") };
	check("进了 /messages → 乐观块消失、正文里留下它（按文本对账，不重复画）", i4e.queued.length === 0 && i4e.users.some((t) => t.includes('排队观察-甲')), `queued=${JSON.stringify(i4e.queued)} users=${JSON.stringify(i4e.users)}`);

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

	// 后台会话落定 → 树在**下一个兜底轮询**拉 /tree 时把红点带上来。
	// 节拍跟着 `web/app.mjs` 的 TREE_POLL_MS（15 s）走：等 15.6 s 保证至少跨过一个周期。
	// **这是本次降频的代价，不是“测试变松了”** —— 断言本身（红点出现、数字 +1）一字未改。
	await ev(`__h.settle(${JSON.stringify(U.read)})`); // 本来已读的那个，在后台又落定了一次
	await sleep(15600);
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
		"标题被清空（name=null）→ 那一行退回**完整 id**（不给你看一行空白；视觉上靠 CSS 省略号，复制出来必须是完整 id）",
		t3 === child,
		`那一行现在显示「${t3}」（期望完整 id ${child}）`,
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

	// ── O L1 带宽：正文只在**有理由**时重拉（稳态/流式中一次都不拉，有信号才拉）──
	// 老代码是 `setInterval(() => { load(); reload(); }, 5000)` —— 稳态下每 5 秒白拉一份全量正文
	// （实测占全部出网的 98%、平均每次 1.23MB）。这四条盯的就是它。
	phase("O 正文只在有理由时重拉（L1 带宽）");
	await load(PAGE);
	await sleep(300);
	await ev(`__h.clickRow(${JSON.stringify(fixture.id)})`); // 打开主会话
	await sleep(900); // open 的首拉 + 会话流 hello 那一拉，都落定
	const o0 = {
		msg: await ev("__h.netCount('/messages')"),
		tree: await ev("__h.netCount('/api/tree')"),
		hist: await ev("__h.histCount()"),
	};
	check("打开会话照旧拉正文（基线：不是「再也不拉」了）", o0.msg >= 1 && o0.hist > 0, `打开后 /messages ${o0.msg} 次，历史 ${o0.hist} 条`);

	// 稳态：没人动、也没有新内容 —— 等 32 秒（= 两个 TREE_POLL_MS 周期，见 web/app.mjs）。
	// 等这么久的**理由**：这条要同时证两件事 —— ① 正文一次都不白拉；② 树的兜底轮询还在跑。
	// 降频后（5 s → 15 s）窗口也得跟着放宽，否则 ② 会因为“窗口里压根没到下一次轮询”而假失败。
	// ⚠️ 断言本身没改（`o1.msg === o0.msg && o1.tree > o0.tree`）—— 两件事都仍然被钉住。
	await sleep(32000);
	const o1 = { msg: await ev("__h.netCount('/messages')"), tree: await ev("__h.netCount('/api/tree')") };
	check(
		"稳态 32 秒：一个 /messages 都不再拉（老代码这里会白拉 6 份全量），而树还在照常轮询",
		o1.msg === o0.msg && o1.tree > o0.tree,
		`/messages ${o0.msg} → ${o1.msg}（增长 ${o1.msg - o0.msg}），/tree ${o0.tree} → ${o1.tree}`,
	);

	// 流式中：SSE 正在推这一段，正文不该再被整份拉一次（自抢带宽）
	const live0 = await ev("__h.liveLen()");
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	for (let i = 0; i < 5; i++) {
		await ev(`__h.emit(${JSON.stringify(`流式第 ${i} 段。`)})`);
		await sleep(200);
	}
	const liveMid = await ev("__h.liveLen()");
	await sleep(16000); // 跨过一个完整的 TREE_POLL_MS（15 s）：这段窗口里**至少被轮询过一次**仍不能重拉全量
	const o2 = { msg: await ev("__h.netCount('/messages')"), live: await ev("__h.liveLen()") };
	check(
		"流式中 16 秒（跨过一整个轮询周期）：正文一次都不重拉（有 SSE 在推，再拉全量是自抢带宽），而直播区确实在长",
		o2.msg === o1.msg && liveMid > live0 && o2.live > live0,
		`/messages ${o1.msg} → ${o2.msg}；直播区 ${live0} → ${liveMid} → ${o2.live} 字`,
	);

	// 一轮跑完 = 有信号 → 这时才该拉（不拉就成了一张死界面）
	await ev("__es._emit({ t: 'run', phase: 'end' })");
	await sleep(700);
	const o3 = { msg: await ev("__h.netCount('/messages')"), live: await ev("__h.liveLen()") };
	check(
		"同一轮跑完（run end）→ 这时才拉一次，把直播区那份收进历史",
		o3.msg > o2.msg && o3.live === 0,
		`/messages ${o2.msg} → ${o3.msg}；直播区清空（${o2.live} → ${o3.live}）`,
	);

	// ── P 切会话的竞态：在飞的旧请求既不覆盖新会话，也不白占带宽 ──
	// 让 A 的正文慢 900ms 才回；只在 A 没回来的那 900ms 里切到 B。
	// 老代码这里会把 A 那份**后到**的正文写进界面（覆盖 B）—— 见 open() 里那个世代号。
	phase("P 切会话的竞态（世代号 + abort）");
	await load(PAGE);
	await sleep(300);
	const A = fixture.id;
	const B = fixture.child;
	const STALE = "旧会话的正文（晚到）";
	const FRESH = "新会话的正文";
	await ev(`__h.patchMsgDelay(${JSON.stringify(A)}, 900, ${JSON.stringify(STALE)})`);
	// B：**第一次**（打开它那一下）立刻回；之后每一发都拖长 6 秒。
	// 为什么要这样：旧代码里，旧会话那份晚到的正文写进界面之后，会被**它自己那条流的 hello**
	// 顺手治回来（hello 会无条件重拉一次**当前**会话）—— 不拖长就看不到“晚到的盖过了后选的”。
	await ev(`__h.patchMsgDelay(${JSON.stringify(B)}, 0, ${JSON.stringify(FRESH)}, 6000)`);
	await ev(`__h.clickRow(${JSON.stringify(A)})`);
	await sleep(250); // A 的正文还在路上
	await ev(`__h.clickRow(${JSON.stringify(B)})`); // 等加载时切到 B
	await sleep(1700); // A 那份晚到的（900ms）已落地；而“治回来”那一发还压在 6 秒延迟里
	const p1 = {
		text: await ev("__h.histText()"),
		hash: await ev("__h.hash()"),
		active: await ev("__h.activeRow()"),
		sess: (await ev("__h.streams()")).sess,
		aborted: await ev("__h.aborted()"),
	};
	check(
		"等加载时切走：晚到的旧会话正文被丢掉，覆盖不了后选的会话",
		p1.text.includes(FRESH) && !p1.text.includes(STALE) && p1.hash === B && p1.active === B,
		`界面上是新会话那份？${p1.text.includes(FRESH)}；旧会话那份爬上来没有？${p1.text.includes(STALE)}；当前 #${String(p1.hash).slice(0, 8)}`,
	);
	check(
		"被顶掉的那次打开不再往下做（不许给旧会话开流）",
		p1.sess === `/api/sessions/${B}/stream`,
		`会话流 = ${p1.sess}`,
	);
	check(
		"在飞的那份旧请求真的被 abort 了（不是只靠比对丢弃）",
		p1.aborted.includes(A),
		`被 abort 的会话：${JSON.stringify(p1.aborted.map((x) => String(x).slice(0, 8)))}`,
	);

	// ── Q 中断（= TUI 的 Esc / pi 的 session.abort）──
	// 事故给的教训：卡住的一轮必须有个出口。盯的是：按钮**只在忙时出现**、点了真打到
	// POST /sessions/{id}/abort、回执按 code 说人话、界面**立刻**收掉直播块 + 重拉正文并标出中断，
	// 以及「杀不到的活」在按钮 title 上如实标出（不装成万能停止键）。

	phase("Q 中断（= TUI 的 Esc）");

	// 1) 闲时：按钮不出现（紧急出口只在需要时出来）
	await load(`${PAGE}?abort=1&abortMark=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	const ab0 = await ev("__h.abortBtn()");
	check("闲时「停止」按钮不出现（不摆一个永远点不动的按钮）", ab0?.hidden === true && ab0.display === "none", JSON.stringify(ab0));

	// 2) 跑起来 + 一个在跑的「远程」工具 → 按钮出现，title 标出「杀不到」
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(1);
	await ev(`__es._emit({ t: 'tool', phase: 'start', id: 'tc1', name: 'bash', args: { command: 'ssh build@203.0.113.9 "sleep 300"' } })`);
	await settle(2);
	const ab1 = await ev("__h.abortBtn()");
	check("正在跑 → 「停止」按钮出现（■ 停止）", ab1?.hidden === false && ab1.text === "■ 停止" && ab1.display !== "none", JSON.stringify(ab1));
	check("在跑的命令像是在别处干活（ssh）→ title 如实说「杀不到」", /杀不到/.test(ab1.title) && ab1.title.includes("ssh"), ab1.title);

	// 3) 点下去：真打到 /abort，回执说清有损 + 边界，直播块**立刻**收掉，正文重拉并标出中断
	const msgBeforeQ = await ev("__h.netCount('/messages')");
	const liveBeforeQ = await ev("__h.liveLen()");
	await ev("__h.clickAbortBtn()");
	await sleep(250);
	await settle(4);
	const ab2 = {
		net: await ev("window.__net"),
		notice: await ev("__h.notice()"),
		live: await ev("__h.liveLen()"),
		btn: await ev("__h.abortBtn()"),
		mark: await ev("__h.abortMark()"),
		msgs: await ev("__h.netCount('/messages')"),
	};
	check("点「停止」→ 打到 POST /sessions/{id}/abort", ab2.net.includes(`POST /api/sessions/${fixture.id}/abort`), JSON.stringify(ab2.net.slice(-3)));
	check(
		"回执说清「已中断」+ 有损（产出停在半路）+ 能力边界（杀不到的两类）",
		ab2.notice.hidden === false && ab2.notice.text.includes("已中断") && ab2.notice.text.includes("杀不到"),
		`提示「${ab2.notice.text}」`,
	);
	check("中断后直播块**立刻**收掉（不等 5 秒轮询）", liveBeforeQ > 0 && ab2.live === 0, `直播区 ${liveBeforeQ} → ${ab2.live}`);
	check("中断后正文被重拉一次（中断也是一个「理由」）", ab2.msgs > msgBeforeQ, `/messages ${msgBeforeQ} → ${ab2.msgs}`);
	check("正文里如实标出「这一轮被中断了」（不把截断回复装成完整回复）", !!ab2.mark && ab2.mark.text.includes("被中断"), JSON.stringify(ab2.mark));
	check("停下来之后按钮又收起来（回到闲时）", ab2.btn?.hidden === true, JSON.stringify(ab2.btn));

	// 4) 这一轮刚好跑完（200 幂等 code:idle）→ 照实说，不当错误
	await load(`${PAGE}?abortIdle=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	await ev("__h.clickAbortBtn()");
	await sleep(200);
	await settle(3);
	const ab3 = await ev("__h.notice()");
	check("这一轮刚好跑完（code:idle）→ 照实说「已经停了」，不当成错误", ab3.text.includes("已经停了"), `提示「${ab3.text}」`);

	// 5) 卡在杀不到的工具里（code:still-running）→ 照实说 + 留着直播块（不装成停了）
	await load(`${PAGE}?abortStill=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	await ev("__h.clickAbortBtn()");
	await sleep(200);
	await settle(3);
	const ab4 = { notice: await ev("__h.notice()"), live: await ev("__h.liveLen()") };
	check("它没停下来（code:still-running）→ 照实说「还没停下来」并留着直播块", ab4.notice.text.includes("还没停下来") && ab4.live > 0, `提示「${ab4.notice.text}」直播区 ${ab4.live}`);

	// 6) 中断失败（HTTP 500）→ 照实报错，不装成功
	await load(`${PAGE}?abortFail=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(2);
	await ev("__h.clickAbortBtn()");
	await sleep(200);
	await settle(3);
	const ab5 = { notice: await ev("__h.notice()"), live: await ev("__h.liveLen()") };
	check("中断失败（HTTP 500）→ 照实报错（不装成已停），直播块留着", ab5.notice.text.includes("中断时报错") && ab5.live > 0, `提示「${ab5.notice.text}」`);

	// 7) 别的标签页发起的中断：SSE 线报也让本页收敛（直播块收掉 + 出回执）
	await load(`${PAGE}?abort=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(1);
	await ev("__es._emit({ t: 'abort', phase: 'start', id: __ID, wasStreaming: true })");
	await settle(1);
	const ab6start = await ev("__h.abortBtn()");
	await ev(`__es._emit({ t: 'abort', phase: 'end', id: __ID, code: 'aborted', streaming: false, boundary: { note: '中断会掐掉当前这一轮……杀不到的两类：① 已经脱钩的后台进程；② 在别的机器上干的活。' } })`);
	await settle(3);
	const ab6 = { notice: await ev("__h.notice()"), live: await ev("__h.liveLen()"), btn: await ev("__h.abortBtn()") };
	check("别的标签页发起中断 → SSE 线报也让本页收掉直播块 + 出回执", ab6start.text === "中断中…" && ab6.notice.text.includes("已中断") && ab6.live === 0, `start 时按钮「${ab6start.text}」；结束提示「${ab6.notice.text}」直播区 ${ab6.live}`);
	check("SSE 报完结束后按钮又收起来", ab6.btn?.hidden === true, JSON.stringify(ab6.btn));

	// ── R @ 指定另一个会话（web/mentions.mjs）──
	// 真前端 + 真 index.html/app.mjs/app.css，假后端。盯的是：
	//  面板出现/过滤/键盘上下/Esc · 在光标处插入的正确性 · 发送时规范化（松散名字→完整 uuid；
	//  歧义/片段/找不到→保留输入并报错，绝不静默发）· 与 `/` 面板互不抢键。
	// 这一期只做「提及」（A 语义）：@ 只是把「说的是哪个会话」明确写进正文，消息仍发给当前会话。

	phase("R @ 指定另一个会话（提及选择器）");
	await load(`${PAGE}?mentions=1#${fixture.id}`);
	await sleep(400);
	await settle(2);
	const mrME = fixture.id; // 主会话
	const mrTOK = `@#${mrME}「主会话」`;

	// R1 初始：没敲 @ 就不该有面板
	const mrPanel0 = await ev("__h.mentions()");
	check("初始：@ 面板隐藏（没敲 @ 就不占位置）", mrPanel0 && mrPanel0.hidden === true, JSON.stringify(mrPanel0));

	// R2 敲 @ → 面板出现、列候选、贴在输入框上方
	await ev("__h.setInput('@')");
	await settle(2);
	const mrAll = { panel: await ev("__h.mentions()"), rows: await ev("__h.mentionRows()"), hint: await ev("__h.mentionHint()"), geom: await ev("__h.mentionGeom()") };
	check("敲 @ → 面板出现且候选非空", mrAll.panel?.hidden === false && mrAll.rows.length > 0, `行数 ${mrAll.rows.length}`);
	check("面板贴着输入框上方、在 composer 里（不盖住输入）", mrAll.geom?.aboveInput === true && mrAll.geom?.inComposer === true, JSON.stringify(mrAll.geom));
	check("候选行给出**完整 uuid**（不是片段）", mrAll.rows.some((x) => x.uuid === mrME), `主会话行的 uuid=${JSON.stringify(mrAll.rows.find((x) => x.name === '主会话')?.uuid)}`);
	check("候选行标出当前会话", mrAll.rows.find((x) => x.uuid === mrME)?.badges.includes('当前') === true, JSON.stringify(mrAll.rows.find((x) => x.uuid === mrME)?.badges));
	check("面板底部有键位说明", /↑↓/.test(mrAll.hint.keys || '') && /Esc/.test(mrAll.hint.keys || ''), JSON.stringify(mrAll.hint.keys));

	// R3 过滤（按名字）
	await ev("__h.setInput('@主会话')");
	await settle(2);
	const mrFilt = await ev("__h.mentionRows()");
	check("按名字过滤 → 只剩「主会话」且默认选中", mrFilt.length === 1 && mrFilt[0].name === '主会话' && mrFilt[0].sel === true, JSON.stringify(mrFilt.map((x) => x.name)));

	// R4 键盘上下选（多个候选）
	await ev("__h.setInput('@会话')");
	await settle(2);
	const mrK0 = await ev("__h.mentionRows()");
	check("过滤出多个候选时默认选第一个", mrK0.length > 1 && mrK0[0].sel === true, `行数 ${mrK0.length}`);
	await ev("__h.key('ArrowDown')");
	await settle(1);
	const mrK1 = await ev("__h.mentionRows()");
	check("↓ 把选中移到下一行（且只有一个选中）", mrK1[1].sel === true && mrK1.filter((x) => x.sel).length === 1, JSON.stringify(mrK1.map((x) => x.sel)));
	await ev("__h.key('ArrowUp')");
	await settle(1);
	const mrK2 = await ev("__h.mentionRows()");
	check("↑ 移回上一行", mrK2[0].sel === true, JSON.stringify(mrK2.map((x) => x.sel)));

	// R5 Esc 关掉、同文本不重弹、改了才重弹；Esc 不发消息
	const mrSentBeforeEsc = await ev("__h.msgCount()");
	await ev("__h.key('Escape')");
	await settle(1);
	const mrE0 = await ev("__h.mentions()");
	await ev("__h.setInput('@会话')"); // 同一段文本
	await settle(1);
	const mrE1 = await ev("__h.mentions()");
	await ev("__h.setInput('@会话x')"); // 改了
	await settle(1);
	const mrE2 = await ev("__h.mentions()");
	check("Esc 关面板；同文本不重弹；改了才重弹", mrE0.hidden === true && mrE1.hidden === true && mrE2.hidden === false, `Esc后=${mrE0.hidden} 同文本=${mrE1.hidden} 改了=${mrE2.hidden}`);
	check("Esc 不会发消息", (await ev("__h.msgCount()")) === mrSentBeforeEsc, `发消息请求数 ${mrSentBeforeEsc} → ${await ev("__h.msgCount()")}`);

	// R6 没有候选：面板在、0 行、明说「没有匹配」
	await ev("__h.setInput('@zzzznope')");
	await settle(2);
	const mrNone = { rows: await ev("__h.mentionRows()"), hint: await ev("__h.mentionHint()"), panel: await ev("__h.mentions()") };
	check("没有候选时不假装有：面板开着、0 行、明说「没有匹配」", mrNone.panel?.hidden === false && mrNone.rows.length === 0 && /没有匹配/.test(mrNone.hint.hint || ''), JSON.stringify(mrNone.hint));

	// R7 在光标处插入（光标在**行中**，不在末尾）——这是「在光标处插」的正脸
	await ev("__h.setInputAt('前半 @主 后半', 5)"); // 光标在 主 之后、空格之前
	await settle(2);
	const mrMid0 = await ev("__h.mentionRows()");
	await ev("__h.key('Enter')"); // 选中 → 只插入，不开新消息
	await settle(2);
	const mrMid1 = await ev("__h.inputValAt()");
	check("光标在行中 → token 插在光标处，前后都保留", mrMid0.length === 1 && mrMid1.v === `前半 ${mrTOK} 后半`, `值=${JSON.stringify(mrMid1.v)}`);
	check("插入后光标落在 token 之后（能接着打字）", mrMid1.start === `前半 `.length + mrTOK.length, `光标 ${mrMid1.start}（期望 ${`前半 `.length + mrTOK.length}）`);
	check("Enter 是「插入」不是「发送」", (await ev("__h.msgCount()")) === mrSentBeforeEsc, `发消息请求数 ${await ev("__h.msgCount()")}`);

	// R8 鼠标点候选也能插入；已归档会话在候选里带标记
	await ev("__h.setInput('请 @存档根')");
	await settle(2);
	const mrArch0 = await ev("__h.mentionRows()");
	const mrClicked = await ev("__h.mousedownMention('存档根 0')");
	await settle(1);
	const mrArch1 = await ev("__h.inputValAt()");
	check("已归档会话出现在候选里（带「已存档」标记）", mrArch0.some((x) => x.name === '存档根 0' && x.badges.includes('已存档')), JSON.stringify(mrArch0.find((x) => x.name === '存档根 0')?.badges));
	check("鼠标点候选 → 插入它的**完整 uuid**", mrClicked === true && mrArch1.v === `请 @#00000000-0000-4000-8000-000000000200「存档根 0」 `, `值=${JSON.stringify(mrArch1.v)}`);

	// R9 发送时规范化：松散 @名字 → 带完整 uuid 的 canonical
	const mrBeforeSend = await ev("__h.msgCount()");
	await ev("__h.setInput('问一下 @主会话 有结论没')");
	await settle(1);
	await ev("__h.key('Enter')"); // 没有未闭合的提及 → 面板关着 → 这一下是「发送」
	await sleep(250);
	await settle(2);
	const mrSent1 = { body: await ev("__h.lastMsgBody()"), val: await ev("__h.inputVal()"), notice: await ev("__h.notice()"), n: await ev("__h.msgCount()") };
	check("松散 @名字 发送时被规范化成带**完整 uuid** 的 token", mrSent1.n === mrBeforeSend + 1 && mrSent1.body?.text === `问一下 ${mrTOK} 有结论没`, `body=${JSON.stringify(mrSent1.body?.text)}`);
	check("发出去后输入框清空、没有报错", mrSent1.val === '' && mrSent1.notice.hidden === true, `val=${JSON.stringify(mrSent1.val)} notice=${JSON.stringify(mrSent1.notice.text)}`);

	// R10 片段（前缀）→ 明确拒绝、保留输入、**绝不静默发**
	const mrBeforeFrag = await ev("__h.msgCount()");
	await ev("__h.setInput('@aaaabbbb ')"); // 主会话 uuid 的前缀（8 位）+ 尾空格（让面板收起，Enter 落到发送）
	await settle(1);
	await ev("__h.key('Enter')");
	await sleep(200);
	await settle(2);
	const mrFrag = { n: await ev("__h.msgCount()"), val: await ev("__h.inputVal()"), notice: await ev("__h.notice()") };
	check("uuid 片段 → 拒绝、**没有**发出去", mrFrag.n === mrBeforeFrag && /片段|完整 uuid/.test(mrFrag.notice.text), `发消息请求数 ${mrBeforeFrag} → ${mrFrag.n}，提示「${mrFrag.notice.text}」`);
	check("被拒时输入保留（不吞草稿）", mrFrag.val === '@aaaabbbb ', JSON.stringify(mrFrag.val));

	// R11 名字歧义（子串命中多个）→ 拒绝
	const mrBeforeAmb = await ev("__h.msgCount()");
	await ev("__h.setInput('@会话 ')");
	await settle(1);
	await ev("__h.key('Enter')");
	await sleep(200);
	await settle(2);
	const mrAmb = { n: await ev("__h.msgCount()"), val: await ev("__h.inputVal()"), notice: await ev("__h.notice()") };
	check("名字歧义 → 拒绝、**没有**发出去、输入保留", mrAmb.n === mrBeforeAmb && mrAmb.val === '@会话 ' && /多个会话匹配/.test(mrAmb.notice.text), `提示「${mrAmb.notice.text}」`);

	// R12 找不到 → 拒绝
	const mrBeforeUnk = await ev("__h.msgCount()");
	await ev("__h.setInput('@不存在的会话zzz')");
	await settle(1);
	await ev("__h.key('Enter')");
	await sleep(200);
	await settle(2);
	const mrUnk = { n: await ev("__h.msgCount()"), val: await ev("__h.inputVal()"), notice: await ev("__h.notice()") };
	check("找不到的会话 → 拒绝、**没有**发出去、输入保留", mrUnk.n === mrBeforeUnk && mrUnk.val === '@不存在的会话zzz' && /找不到会话/.test(mrUnk.notice.text), `提示「${mrUnk.notice.text}」`);

	// R13 与 `/` 面板互不抢键
	await ev("__h.setInput('/')");
	await settle(2);
	const mrCmd0 = { cmds: await ev("__h.cmds()"), mentions: await ev("__h.mentions()") };
	check("`/` 面板开着时，@ 面板让位（不抢）", mrCmd0.cmds?.hidden === false && mrCmd0.mentions?.hidden === true, `cmds=${JSON.stringify(mrCmd0.cmds)} mentions=${JSON.stringify(mrCmd0.mentions)}`);
	await ev("__h.key('ArrowDown')");
	await settle(1);
	const mrCmd1 = await ev("__h.cmdRows()");
	check("`/` 开着时 ↓ 动的是命令面板（不是 @ 面板）", mrCmd1[1]?.sel === true && (await ev("__h.mentions()")).hidden === true, JSON.stringify(mrCmd1.map((x) => x.sel)));
	await ev("__h.key('Escape')");
	await settle(1);
	await ev("__h.setInput('@会话')");
	await settle(2);
	const mrMent0 = { cmds: await ev("__h.cmds()"), mentions: await ev("__h.mentions()") };
	check("`@` 面板开着时，`/` 面板不开", mrMent0.mentions?.hidden === false && mrMent0.cmds?.hidden === true, `cmds=${JSON.stringify(mrMent0.cmds)} mentions=${JSON.stringify(mrMent0.mentions)}`);

	// ── S 工具状态色：运行中 / 成功完成 / 错误完成 三态可见不同 ──
	// 参考 pi TUI：dist/modes/interactive/components/tool-execution.js:217-221 按
	// isPartial / result.isError 选 toolPendingBg / toolErrorBg / toolSuccessBg，
	// 值取 pi dark 主题 dist/modes/interactive/theme/dark.json:17-19。
	phase("S 工具状态色（运行 vs 完成 vs 出错）");
	await load(`${PAGE}?parts=1#${fixture.id}`);
	await sleep(400);
	await settle(3);
	await ev("__es._emit({ t: 'run', phase: 'start' })");
	await settle(1);
	await ev("__es._emit({ t: 'tool', phase: 'start', id: 'cs1', name: 'bash', args: { command: 'ls' } })");
	await ev("__es._emit({ t: 'tool', phase: 'end', id: 'cs1', result: 'ok' })"); // 成功完成
	await ev("__es._emit({ t: 'tool', phase: 'start', id: 'cs2', name: 'read', args: { path: '/nope' } })");
	await ev("__es._emit({ t: 'tool', phase: 'end', id: 'cs2', error: true, result: 'ENOENT' })"); // 错误完成
	await ev("__es._emit({ t: 'tool', phase: 'start', id: 'cs3', name: 'bash', args: { command: 'sleep 300' } })"); // 还在跑
	await settle(3);
	const st = await ev("__h.toolStates('#liveBox .tool')");
	const stRun = st.find((x) => x.state === 'running'), stOk = st.find((x) => x.state === 'done'), stBad = st.find((x) => x.state === 'error');
	check("运行中：data-state=running，仍带「运行中…」且不标错", stRun?.state === 'running' && stRun.bad === false && /运行中/.test(stRun.res || ''), JSON.stringify(stRun));
	check(
		"成功完成：data-state=done，底色/边缘色都不同于运行中（不是同一个样子）",
		stOk?.state === 'done' && stOk.bad === false && stOk.bg !== stRun?.bg && stOk.edge !== stRun?.edge,
		`运行 bg=${stRun?.bg} edge=${stRun?.edge} / 完成 bg=${stOk?.bg} edge=${stOk?.edge}`,
	);
	check(
		"错误完成：data-state=error（带 bad），颜色不同于运行中、也不同于成功",
		stBad?.state === 'error' && stBad.bad === true && stBad.bg !== stRun?.bg && stBad.bg !== stOk?.bg && stBad.edge !== stOk?.edge,
		`错误 bg=${stBad?.bg} edge=${stBad?.edge}`,
	);
	check(
		"三态真的映射到 pi 的 toolPendingBg/toolSuccessBg/toolErrorBg（#282832 / #283228 / #3c2828）",
		stRun?.bg === 'rgb(40, 40, 50)' && stOk?.bg === 'rgb(40, 50, 40)' && stBad?.bg === 'rgb(60, 40, 40)',
		`${stRun?.bg} / ${stOk?.bg} / ${stBad?.bg}`,
	);
	const stHist = await ev("__h.toolStates('#hist .tool')");
	check(
		"历史工具块走同一套状态（内容为结果的成功块 = done，不残留运行中态）",
		stHist.length >= 2 && stHist.every((x) => x.state === 'done' && x.bad === false),
		`历史工具 ${stHist.length} 个，state=${JSON.stringify(stHist.map((x) => x.state))}`,
	);

	// ── T 一轮还在飞：同一轮**不许画两遍**（历史块 + 直播块）──
	//
	// 现象（2026-09-16 实测；真链路的证据在 `web/test-live-dedup.mjs`）：pi 在这一轮的助手消息
	// 一落盘，`GET /messages` 里就有它（一条带 toolCall 的、或已经写出来的正文），而直播块
	// （SSE delta 攒的）里也有同一份 ⇒ **历史一张工具卡 + 直播同一张卡**（正文同理）。
	// 触发点很常见：`visibilitychange` / SSE `hello` / status 变化都会 `requestReload()`。
	//
	// 修法（`web/app.mjs` 的 advanceCoverage）：**直播块不画「历史已经在画的那部分」**。
	// 判据是**逐 part 完全相等**（文字全等；工具按名字 + 参数，不看跑着/跑完）；对不上就**不接管**
	// —— 宁可多画一份，也绝不吞内容。这一段就把这两条钉住（含「对不齐时两份都在」那个方向）。
	phase("T 一轮在飞：同一轮不许画两遍（历史 + 直播）");
	{
		const ONE = { type: 'text', text: '直播正文甲' };
		const THINK = { type: 'thinking', text: '直播思考' };
		const TOOL = { type: 'tool', name: 'bash', args: { command: 'sleep 30' } };
		await load(`${PAGE}?live=1#${fixture.id}`);
		await sleep(400);
		await settle(3);
		await ev("__es._emit({ t: 'run', phase: 'start' })");
		await ev("__es._emit({ t: 'thinking', d: '直播思考' })");
		await ev("__es._emit({ t: 'tool', phase: 'start', id: 'T1', name: 'bash', args: { command: 'sleep 30' } })");
		await ev("__es._emit({ t: 'text', d: '直播正文甲' })");
		await settle(3);
		// 服务端那份：与直播块**同一份内容**（这一轮落盘了），工具还在跑（running:true）
		await ev(`window.__histInFlight = () => ([{type:'thinking',text:'直播思考'},{type:'tool',name:'bash',args:{command:'sleep 30'},running:!window.__histDone,result:window.__histDone?'ok':undefined},{type:'text',text:'直播正文甲'}]); true`);
		const MINE = "c => String(c.args).includes('sleep 30')"; // 夹具 HISTORY 里本来就有两张工具卡（ls / read）
		const myCards = () => ev(`__h.allCards().filter(${MINE})`);
		const t0 = { cards: await myCards(), text: await ev("__h.occur('直播正文甲')") };
		check("前置：还没重拉时那一轮只画一份（在直播块里）", t0.cards.length === 1 && t0.cards[0].where === 'live' && t0.text === 1, JSON.stringify(t0));
		await ev("__h.pokeReload()"); // = 从后台切回来（真触发路径）
		await sleep(300);
		await settle(4);
		const t1 = { cards: await myCards(), text: await ev("__h.occur('直播正文甲')"), who: await ev("__h.who()") };
		check("★重拉之后（历史里那条在飞消息进来了）：同一个工具**只有一张卡**", t1.cards.length === 1, JSON.stringify(t1.cards));
		check("★那一张卡由**历史块**画（直播块不再重画它）", t1.cards[0]?.where === 'hist', JSON.stringify(t1.cards));
		check("★它的状态是 running（服务端如实标着在跑，不是绿）", t1.cards[0]?.state === 'running' && t1.cards[0]?.bg !== 'rgb(40, 50, 40)', JSON.stringify(t1.cards));
		check("★已经产出的正文在整页里只出现一次", t1.text === 1, `出现 ${t1.text} 次`);
		check("直播块没多出一个空的「助手 ›」头", t1.who.live === 0, JSON.stringify(t1.who));
		// 工具结束（start 那次收到了）⇒ 那张卡必须**就地**变成完成（它这一份由服务端说话 ⇒ 走重拉那条路）
		await ev("window.__histDone = true; true");
		await ev("__es._emit({ t: 'tool', phase: 'end', id: 'T1', result: 'ok', error: false })");
		await sleep(500);
		await settle(4);
		const t2 = { cards: await myCards(), text: await ev("__h.occur('直播正文甲')") };
		check("工具结束之后仍然只有一张卡（没有「历史一张 + 直播补一张」）", t2.cards.length === 1, JSON.stringify(t2.cards));
		check("那张卡变成完成、结果落在同一张卡上", t2.cards[0]?.state === 'done' && /ok/.test(String(t2.cards[0]?.res)), JSON.stringify(t2.cards));
		check("正文仍然只出现一次（工具结果落地没有把正文重画成两份）", t2.text === 1, `出现 ${t2.text} 次`);

		// ── T3 对不齐 ⇒ **不许吞内容**（宁可多画一份）──
		// 这是「刷新后直播块只收到后半段」的形状：历史那份是全文、直播块只有后缀。
		// 判据：两份都在（没有哪一份消失），代价如实是「同一段正文短暂出现两次」。
		await load(`${PAGE}?live=3#${fixture.id}`);
		await sleep(400);
		await settle(3);
		await ev("__es._emit({ t: 'run', phase: 'start' })");
		await ev("__es._emit({ t: 'text', d: '后半段' })");
		await settle(3);
		await ev("window.__histInFlight = [{type:'text',text:'前半段后半段'}]; true");
		await ev("__h.pokeReload()");
		await sleep(300);
		await settle(4);
		const t3 = { head: await ev("__h.occur('前半段')"), tail: await ev("__h.occur('后半段')") };
		check("★对不齐时不接管：历史那份（前半段）在", t3.head >= 1, JSON.stringify(t3));
		check("★直播块那份（后半段）也在 —— 两份都没被吞掉", t3.tail >= 1, JSON.stringify(t3));

		// ── T5 插话把两条助手消息隔开：接管要**跨过那条 user 消息**，顺序不许乱 ──
		// 形状：M1（正文 + 工具，已落盘）→ U（流式中的插话，pi 把它写进文件）→ 直播块里接着的是
		// 新一条消息的正文。接管必须把 M1 交给历史（不重画），同时**跳过 U 继续对账**，而 U 由
		// 历史画在它该在的位置上 —— 结果是「M1 的卡 → U → 新正文」这个顺序，且一份都不多。
		await load(`${PAGE}?live=5#${fixture.id}`);
		await sleep(400);
		await settle(3);
		await ev("__es._emit({ t: 'run', phase: 'start' })");
		await ev("__es._emit({ t: 'text', d: '插话前那一段' })"); // 直播块里先有正文，再有工具（同一轮）
		await ev("__es._emit({ t: 'tool', phase: 'start', id: 'T5', name: 'bash', args: { command: 'sleep 30' } })");
		await settle(2);
		await ev("window.__histInFlight = [{type:'text',text:'插话前那一段'},{type:'tool',name:'bash',args:{command:'sleep 30'},running:true}]; true");
		await ev("window.__histTail = [{ role: 'user', text: '插话：还在跑的时候发的第二条' }]; true");
		await ev("__es._emit({ t: 'text', d: '插话之后流出来的正文' })");
		await ev("__h.pokeReload()");
		await sleep(300);
		await settle(4);
		const t5 = {
			cards: await myCards(),
			before: await ev("__h.occur('插话前那一段')"),
			steer: await ev("__h.occur('插话：还在跑的时候发的第二条')"),
			after: await ev("__h.occur('插话之后流出来的正文')"),
			order: await ev(`(() => { const t = document.querySelector('#messages').textContent; return [t.indexOf('插话前那一段'), t.indexOf('插话：还在跑的时候发的第二条'), t.indexOf('插话之后流出来的正文')]; })()`),
		};
		check("★跨插话也接管：工具卡只有一张（在历史里）", t5.cards.length === 1 && t5.cards[0].where === 'hist', JSON.stringify(t5.cards));
		check("★每一段都只出现一次（插话前的正文 / 插话 / 插话后的正文）", t5.before === 1 && t5.steer === 1 && t5.after === 1, JSON.stringify({ b: t5.before, u: t5.steer, a: t5.after }));
		check("★顺序对：插话前的正文 → 工具卡 → 插话 → 插话后的正文", t5.order[0] >= 0 && t5.order[0] < t5.order[1] && t5.order[1] < t5.order[2], JSON.stringify(t5.order));

		// ── T4 被中断的那一轮：live 为 null ⇒ 一条都不接管，历史照常画它 ──
		await load(`${PAGE}?live=4#${fixture.id}`);
		await sleep(400);
		await settle(3);
		await ev("__es._emit({ t: 'run', phase: 'start' })");
		await ev("__es._emit({ t: 'text', d: '直播正文丙' })");
		await settle(3);
		await ev("window.__histInFlight = [{type:'text',text:'直播正文丙'}]; window.__histAborted = true; true");
		await ev("__es._emit({ t: 'abort', phase: 'end', code: 'aborted', streaming: false })"); // live = null
		await sleep(400);
		await settle(4);
		const t4 = { cards: await myCards(), text: await ev("__h.occur('直播正文丙')"), mark: await ev("__h.abortMark()"), who: await ev("__h.who()") };
		check("★中断之后正文还在、且只出现一次（没被「跳过」吞掉）", t4.text === 1, JSON.stringify(t4));
		check("★历史里照常有「⏹ 这一轮被中断了」", /中断/.test(String(t4.mark?.text)), JSON.stringify(t4.mark));
		check("直播块收掉了（中断把 live 收成 null）", t4.who.live === 0, JSON.stringify(t4.who));
	}

	// ── H 全程页面无异常，且一个真接口都没打 ──

	phase("H 干净度");
	await settle(2);
	check("页面没有未捕获异常 / console.error", pageProblems.length === 0, pageProblems.join(" | "));
	// ── I 阅读页（web/reading.html）：**放在最后**（换了一页文档，`__h` 就不在了）──
	//
	// 人类拍板的三条：① 按钮就是「一个发送按钮」，样式沿用现有那套；② debug 按钮初版有一个即可（默认收起）；
	// ③ **不做聊天面板**。这一段就盯这三条 + 那次「按一下」到底发了什么。
	phase("I 阅读页：渲染 / 发送按钮 / 调试面板");
	{
		const RD = PAGE + "reading.html";
		const navR = async (url, ms) => {
			const loaded = Promise.race([new Promise((ok) => listeners.push((m) => m.method === "Page.loadEventFired" && ok("ok"))), sleep(ms).then(() => "timeout")]);
			await send("Page.navigate", { url });
			return await loaded;
		};
		let how = await navR(RD, 12_000);
		if (how === "timeout") how = await navR(RD, 20_000);
		check("阅读页导航到了 load", how !== "timeout", RD);
		const probe = String(await ev("document.title + ' | #reading=' + document.querySelectorAll('#reading').length + ' | #press=' + document.querySelectorAll('#press').length"));
		check("阅读页文档加载对了（有 #reading 与 #press）", probe.includes("#reading=1") && probe.includes("#press=1"), probe);
		await sleep(250);

		// ① 渲染：原文 / 段末问题 / 答案 / 笔记 / 助手块 / 字段 都在这
		const shape = await ev(`(() => {
			const src = document.querySelector('.rp-src');
			return {
				src: src?.textContent ?? null,
				srcTag: document.querySelector('.rp-srctag')?.textContent ?? null,
				q: document.querySelector('.rp-q')?.textContent ?? null,
				answers: document.querySelectorAll('textarea.rp-a').length,
				notes: document.querySelectorAll('textarea.rp-note').length,
				asst: document.querySelector('.rp-asst')?.textContent ?? null,
				field: document.querySelector('.rp-field')?.textContent ?? null,
				heading: document.querySelector('.rp-h')?.textContent ?? null,
				buttons: [...document.querySelectorAll('button')].map(b => b.id),
			};
		})()`);
		check("原文段渲染出来了（正文文字）", /差别初看起来好像很重要/.test(shape.src ?? ""), (shape.src ?? "").slice(0, 26));
		check("原文段里**没有**标记行（人读的字与服务端的标记分开）", !/<!--|src:/.test(shape.src ?? ""));
		check("原文块旁边标出它的 srcId 与剥离痕迹", /原文/.test(shape.srcTag ?? "") && /part0004/.test(shape.srcTag ?? ""), shape.srcTag ?? "");
		check("段末问题渲染出来了", /Q1:/.test(shape.q ?? ""), (shape.q ?? "").slice(0, 24));
		check("答案 / 笔记各一个可编辑框", shape.answers === 1 && shape.notes === 1, `答案 ${shape.answers} · 笔记 ${shape.notes}`);
		check("助手块渲染出来了（含 kind）", /助手追问/.test(shape.asst ?? ""), (shape.asst ?? "").slice(0, 20));
		check("字段（阅读位置）渲染出来了（只读）", /阅读位置/.test(shape.field ?? ""));
		check("标题渲染出来了", shape.heading === "第一章 导论", shape.heading ?? "");
		check("底部那个「发送全部」还在，而且没有第二套 `#send`", shape.buttons.includes("press") && !shape.buttons.includes("send"), JSON.stringify(shape.buttons));
		const perBlock0 = await ev(`({
			editable: document.querySelectorAll('textarea.rp-a, textarea.rp-note').length,
			sendBtns: document.querySelectorAll('.rp-edit .rp-send').length,
			allDisabled: [...document.querySelectorAll('.rp-edit .rp-send')].every((b) => b.disabled),
			chips: [...document.querySelectorAll('.rp-edit .rp-chip')].map((c) => c.dataset.state),
		})`);
		check(perBlock0.editable >= 2 && perBlock0.sendBtns === perBlock0.editable, "**每个可编辑框都有自己的发送按钮**", `${perBlock0.editable} 个输入框 / ${perBlock0.sendBtns} 个按钮`);
		check(perBlock0.allDisabled, "还没改字时**每一块的按钮都是 disabled**");
		check(perBlock0.chips.every((x) => x === "clean"), "也没挂任何状态（clean）", JSON.stringify(perBlock0.chips));

		// ② 按钮：样式**沿用** app.css 的发送按钮（同一组计算样式），一开始 disabled
		const style = await ev(`(() => {
			const p = document.querySelector('#press');
			const cs = p ? getComputedStyle(p) : null;
			return { exists: !!p, disabled: p?.disabled ?? null, text: p?.textContent ?? null, bg: cs?.backgroundColor ?? null, radius: cs?.borderRadius ?? null, pad: cs?.padding ?? null };
		})()`);
		check("底部那个「发送全部未发送的改动」在（`#press`）", style.exists && /发送全部/.test(style.text), JSON.stringify({ text: style.text }));
		check("还没改字之前是 disabled（没有可存的东西就不让点）", style.disabled === true);
		check(
			"样式与主界面发送按钮**同源**（app.css 里 #send 与 #press 同一组值）",
			style.bg === "rgb(30, 32, 39)" && style.radius === "4px" && style.pad === "3px 14px",
			`${style.bg} / ${style.radius} / ${style.pad}`,
		);

		// ③ 调试面板：**默认收起**，里面能看到路径 / 指纹 / 待发 / 上次返回
		const dbg = await ev(`(() => {
			const d = document.querySelector('#rpDebug');
			return { exists: !!d, open: d?.open ?? null, isDetails: d?.tagName ?? null };
		})()`);
		check("调试面板存在且**默认收起**", dbg.exists && dbg.isDetails === "DETAILS" && dbg.open === false, `tag=${dbg.isDetails} open=${dbg.open}`);
		await ev("document.querySelector('#rpDebug').open = true");
		await sleep(80);
		const dbg2 = await ev("document.querySelector('#rpDebug').textContent");
		check("面板里有**整页指纹**", /整页指纹/.test(dbg2) && /sha256:mock-page-fingerprint/.test(dbg2), (dbg2.match(/sha256:[a-z0-9-]+/g) ?? []).join(","));
		check("面板里有**路径**（相对 + 绝对）", /绝对路径/.test(dbg2) && /\/tmp\/mock\/root\/note\/测试页\.md/.test(dbg2));
		check("面板里有**待发**这一行", /待发/.test(dbg2));
		check("面板里有**上次调用返回**这一行", /上次调用/.test(dbg2));

		// ④ 改字 → 按钮亮 → 按一下 → body 形状对（只有改动的那一块 + 指纹）
		const before = await ev("window.__net.filter(x => x.includes('/pages/press')).length");
		check("按下之前一个 press 请求都没发", before === 0, String(before));
		await ev(`(() => {
			const t = document.querySelector('textarea.rp-a');
			t.value = '我在这页写的新答案。';
			t.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
		await sleep(60);
		const dis = await ev(`({
			block: document.querySelector('.rp-edit .rp-send').disabled,
			bottom: document.querySelector('#press').disabled,
		})`);
		check("改了字之后**那一块自己的**按钮变可用（底部那个仍然禁用 —— 只有一块）", dis.block === false && dis.bottom === true, JSON.stringify(dis));
		await ev("document.querySelector('.rp-edit .rp-send').click()");
		await sleep(300);
		const press = await ev("window.__press ?? []");
		check("按一下**只发了一个** press 请求", press.length === 1, `${press.length} 个`);
		const body = press[0]?.body ?? {};
		check("请求里带着页面路径", body.path === "note/测试页.md", String(body.path));
		check("只带**改动过的那一块**（不是整页重发）", Array.isArray(body.edits) && body.edits.length === 1, `${body.edits?.length} 处`);
		check("带的是新写的字（答案保留 A: 前缀）", body.edits?.[0]?.text === "我在这页写的新答案。" && body.edits[0].keepPrefix === true, JSON.stringify(body.edits?.[0]?.text));
		check(
			"并且带上那一块的**指纹**（服务端据此拒绝覆盖）",
			typeof body.edits?.[0]?.expectedFingerprint === "string" && body.edits[0].expectedFingerprint.startsWith("sha256:"),
			String(body.edits?.[0]?.expectedFingerprint),
		);
		const notice = await ev("document.querySelector('#rpNotice').textContent");
		const blk0 = await ev(`(() => {
			const w = document.querySelector('.rp-edit');
			return { chip: w?.querySelector('.rp-chip')?.dataset.state ?? null, dirty: w?.classList.contains('rp-dirty') ?? null };
		})()`);
		check(blk0.chip === "sent", "发送之后**那一块自己**的回执变成「已发送」", JSON.stringify(blk0));
		check("回执说清「已保存 + 已交给会话」", /已保存/.test(notice) && /交给/.test(notice), notice.slice(0, 46));
		const dbg3 = await ev("document.querySelector('#rpDebug').textContent");
		check("调试面板里能看到**上次调用的返回**", /上次调用/.test(dbg3) && /HTTP 200/.test(dbg3), (dbg3.match(/HTTP \d+/g) ?? []).join(","));

		// ⑤ 连点：第二次点必须**不再发**（没有新改动 = 没有可交的字；飞行中按钮也是 disabled）
		const n1 = await ev("window.__net.filter(x => x.includes('/pages/press')).length");
		await ev("document.querySelector('#press').click()");
		await ev("document.querySelector('#press').click()");
		await sleep(150);
		const n2 = await ev("window.__net.filter(x => x.includes('/pages/press')).length");
		check("没改动时连点**不再发请求**（连点两次 = 0 个新请求）", n2 === n1, `${n1} → ${n2}`);

		// ⑥ 失败要如实显示：?pressfail=1 扮「字存住了但没发出去」（真路由回 502）
		how = await navR(RD + "?pressfail=1", 20_000);
		check("换到「投递失败」那一档（?pressfail=1）", how !== "timeout");
		await sleep(250);
		await ev(`(() => {
			const t = document.querySelector('textarea.rp-a');
			t.value = '这一条会存住但发不出去。';
			t.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
		await sleep(60);
		await ev("document.querySelector('.rp-edit .rp-send').click()");
		await sleep(300);
		const failMsg = await ev("document.querySelector('#rpNotice').textContent");
		check("**如实说「字存住了但没发出去」**（不粉饰成成功）", /存住/.test(failMsg) && /没发出去/.test(failMsg), failMsg.slice(0, 52));

		// ⑦ 没有聊天面板：这一页里既没有消息列表也没有聊天输入框
		const noChat = await ev(`({
			messages: document.querySelectorAll('#messages, #hist, #liveBox').length,
			composer: document.querySelectorAll('#input').length,
		})`);
		check("**没有聊天面板**（没有消息列表 / 没有聊天输入框）", noChat.messages === 0 && noChat.composer === 0, JSON.stringify(noChat));
		check("阅读页也没有未捕获异常 / console.error", pageProblems.length === 0, pageProblems.join(" | "));

		// ⑩ **按块发送**（人类 2026-09-16 的原话：「我觉得应该**所有输入框都提供一个发送按钮**，
		//    而不是只在页面底部提供一个按钮」）—— 每块一个按钮、只提交那一块、回执挂在那块上、
		//    Ctrl+Enter 等价、底部那个只在**多处未发送**时可用、未保存改动看得见。
		phase("I4 按块发送：每块一个按钮 / 只提交那一块 / 回执挂那块 / 键盘等价");
		{
			const how5 = await navR(RD, 20_000);
			check(how5 !== "timeout", "回到普通长度的页面（两块可编辑：一个答案 + 一处笔记）");
			await sleep(300);
			const shape5 = await ev(`(() => {
				const eds = [...document.querySelectorAll('.rp-edit')];
				return {
					n: eds.length,
					keys: eds.map((e) => e.dataset.range),
					kinds: eds.map((e) => e.dataset.kind),
					sendBtns: document.querySelectorAll('.rp-edit .rp-send').length,
					pressLabel: document.querySelector('#press').textContent,
					pressDisabled: document.querySelector('#press').disabled,
				};
			})()`);
			check("每个可编辑框各带一个「发送这一块」", shape5.n >= 2 && shape5.sendBtns === shape5.n, `${shape5.n} 块 / ${shape5.sendBtns} 按钮；${JSON.stringify(shape5.kinds)}`);
			check("底部那个是「发送全部未发送的改动」且此刻**不可用**（没有多处未发送）", shape5.pressDisabled && shape5.pressLabel === "发送全部未发送的改动", shape5.pressLabel);

			// 只改**第一块** ⇒ 只有它亮、只有它有"未发送"标记
			await ev(`(() => {
				const t = document.querySelectorAll('.rp-edit textarea')[0];
				t.value = '（按块发送）只改这一块。';
				t.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
			await sleep(80);
			const one = await ev(`(() => {
				const eds = [...document.querySelectorAll('.rp-edit')];
				return {
					btns: eds.map((e) => e.querySelector('.rp-send').disabled),
					chips: eds.map((e) => e.querySelector('.rp-chip').dataset.state),
					dirtyMarks: eds.map((e) => e.classList.contains('rp-dirty')),
					pressDisabled: document.querySelector('#press').disabled,
					pressLabel: document.querySelector('#press').textContent,
				};
			})()`);
			check("只有**改动过的那一块**按钮可用（其它块不受影响）", one.btns[0] === false && one.btns.slice(1).every((x) => x === true), JSON.stringify(one.btns));
			check("只有那一块挂「有改动未发送」", one.chips[0] === "dirty" && one.chips.slice(1).every((x) => x === "clean"), JSON.stringify(one.chips));
			check("未保存的改动**看得见**（那一块左边有条色标）", one.dirtyMarks[0] === true && one.dirtyMarks.slice(1).every((x) => x === false), JSON.stringify(one.dirtyMarks));
			check("只有一块未发送时，底部那个**仍然不可用**（不许与按块发送含混）", one.pressDisabled && /发送全部未发送的改动/.test(one.pressLabel), `${one.pressDisabled} / ${one.pressLabel}`);

			// 点**那一块**的按钮 ⇒ 请求体里只有这一条 edits，range 就是那一块
			const nBefore = await ev("window.__net.filter(x => x.includes('/pages/press')).length");
			await ev("document.querySelectorAll('.rp-edit .rp-send')[0].click()");
			await sleep(350);
			const nAfter = await ev("window.__net.filter(x => x.includes('/pages/press')).length");
			const pressed = await ev("(window.__press ?? []).slice(-1)[0]");
			check("只发了**一个** press 请求", nAfter === nBefore + 1, `${nBefore} → ${nAfter}`);
			check("请求体里 `edits` **只有一条**（按块发送）", pressed?.body?.edits?.length === 1, `${pressed?.body?.edits?.length} 条`);
			check(
				JSON.stringify(pressed?.body?.edits?.[0]?.range) === JSON.stringify(shape5.keys[0].split("-").map(Number)),
				"而且 range 就是**那一块**",
				`edits[0].range=${JSON.stringify(pressed?.body?.edits?.[0]?.range)} / 那一块=${shape5.keys[0]}`,
			);
			const afterOne = await ev(`(() => {
				const eds = [...document.querySelectorAll('.rp-edit')];
				return { chips: eds.map((e) => e.querySelector('.rp-chip').dataset.state), dirty: eds.map((e) => e.classList.contains('rp-dirty')), btns: eds.map((e) => e.querySelector('.rp-send').disabled) };
			})()`);
			check("回执挂在**那一块**上（已发送 ✓、色标消失）", afterOne.chips[0] === "sent" && afterOne.dirty[0] === false, JSON.stringify(afterOne.chips));
			check("**另一块一点没被牵连**（还是 clean + disabled）", afterOne.btns[1] === true && afterOne.chips[1] === "clean", JSON.stringify(afterOne));

			// 键盘等价：在第二块里 Ctrl+Enter ⇒ 发的是**这一块**
			await ev(`(() => {
				const t = document.querySelectorAll('.rp-edit textarea')[1];
				t.value = '（键盘）这一块用 Ctrl+Enter 发。';
				t.dispatchEvent(new Event('input', { bubbles: true }));
				t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
			})()`);
			await sleep(350);
			const kb = await ev("(window.__press ?? []).slice(-1)[0]");
			check("框内 **Ctrl+Enter** 等价于按那一块的按钮（发的还是只有这一块）", kb?.body?.edits?.length === 1 && /Ctrl\+Enter/.test(kb?.body?.edits?.[0]?.text ?? ""), JSON.stringify(kb?.body?.edits?.[0]?.text));

			// 两块都有改动时：底部那个才可用，而且一次交两块
			await ev(`(() => {
				for (const t of document.querySelectorAll('.rp-edit textarea')) {
					t.value = (t.value || '') + '再加一句。';
					t.dispatchEvent(new Event('input', { bubbles: true }));
				}
			})()`);
			await sleep(80);
			const two = await ev(`({ disabled: document.querySelector('#press').disabled, label: document.querySelector('#press').textContent })`);
			check("**多处未发送**时底部那个才可用，标签说清是几块", two.disabled === false && /2 块/.test(two.label), JSON.stringify(two));
			await ev("document.querySelector('#press').click()");
			await sleep(350);
			const all = await ev("(window.__press ?? []).slice(-1)[0]");
			check("「发送全部」一次交**两块**（保留的路，语义与按块发送分得清）", all?.body?.edits?.length === 2, `${all?.body?.edits?.length} 条`);
		}

		// ⑪ 按块发送 + 滚动/窄窗（在**长页面**上验，别让"按钮行"把布局搞坏）
		phase("I5 按块发送：长页面上滚动不跳 + 窄窗不挤");
		{
			const how6 = await navR(RD + "?long=1", 20_000);
			check(how6 !== "timeout", "长页面导航到了 load");
			await sleep(300);
			const scrollRight3 = async (frac) =>
				await ev(`(() => { const el = document.querySelector('#rpBody'); el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac}); return Math.round(el.scrollTop); })()`);
			const st3 = async () =>
				await ev(`(() => {
					const box = document.querySelector('#rpBody');
					const boxTop = box.getBoundingClientRect().top;
					const anchor = [...box.children].find((n) => n.getBoundingClientRect().top - boxTop >= -2);
					const edit = document.querySelector('.rp-edit');
					const ta = document.querySelector('.rp-edit textarea');
					return {
						scrollTop: Math.round(box.scrollTop),
						anchor: anchor?.dataset.range ?? null,
						innerH: innerHeight, innerW: innerWidth,
						pageScrollH: document.scrollingElement.scrollHeight,
						editTop: edit ? Math.round(edit.getBoundingClientRect().top) : null,
						toolsH: edit ? Math.round(edit.querySelector('.rp-tools').getBoundingClientRect().height) : null,
						taW: ta ? Math.round(ta.getBoundingClientRect().width) : null,
						taH: ta ? Math.round(ta.getBoundingClientRect().height) : null,
					};
				})()`);

			await scrollRight3(0.5);
			const b3 = await st3();
			check("先滚到中间", b3.scrollTop > 100, `scrollTop=${b3.scrollTop}`);
			// 用**最后一个**可编辑块（长页里那个在 i=20 的位置，很深）——
			// 这样"发送后滚动不跳"才有意义（用一个贴顶的块会得到 scrollTop 0 → 0 的假通过）
			await ev(`(() => { const e = [...document.querySelectorAll('.rp-edit')].pop(); e.scrollIntoView({ block: 'center' }); return true; })()`);
			await sleep(150);
			const b4 = await st3();
			check("把要发的那个框滚到视口里（且位置**不是 0**）", b4.scrollTop > 200, `scrollTop=${b4.scrollTop}`);
			await ev(`(() => { const t = [...document.querySelectorAll('.rp-edit textarea')].pop(); t.value = '（长页里按这一块发送）'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
			await sleep(80);
			await ev("[...document.querySelectorAll('.rp-edit .rp-send')].pop().click()");
			await sleep(450);
			const a4 = await st3();
			check("**按块发送之后滚动不跳**（这一条是今天刚修的，不许退化）", a4.scrollTop > 200 && Math.abs(a4.scrollTop - b4.scrollTop) <= 4, `scrollTop ${b4.scrollTop} → ${a4.scrollTop}（差 ${a4.scrollTop - b4.scrollTop}）`);
			check("页面本身仍然不滚（按钮行没有把布局撑坏）", a4.pageScrollH <= a4.innerH + 1, `scrollHeight=${a4.pageScrollH} innerHeight=${a4.innerH}`);
			check("工具行没把输入框挤没（窄条 + 输入框仍有宽高）", a4.toolsH !== null && a4.toolsH <= 40 && a4.taW > 80 && a4.taH > 10, `tools h=${a4.toolsH} textarea ${a4.taW}×${a4.taH}`);

			// 窄窗 900×600：按钮还在、输入框还在、页面不滚
			await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
			await sleep(250);
			await ev(`(() => { document.querySelector('.rp-edit').scrollIntoView({ block: 'center' }); return true; })()`);
			await sleep(150);
			const narrow2 = await st3();
			const inView = await ev(`(() => {
				const e = document.querySelector('.rp-edit');
				const btn = e.querySelector('.rp-send');
				const ta = e.querySelector('textarea');
				const r = (n) => { const x = n.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), w: Math.round(x.width), h: Math.round(x.height) }; };
				return { edit: r(e), btn: r(btn), ta: r(ta), innerH: innerHeight, innerW: innerWidth };
			})()`);
			check("窄窗（900×600）下页面仍然不滚", narrow2.pageScrollH <= narrow2.innerH + 1, `scrollHeight=${narrow2.pageScrollH} innerHeight=${narrow2.innerH}`);
			check(
				inView.ta.w > 100 && inView.ta.h > 10 && inView.btn.w > 10 && inView.btn.bottom <= inView.innerH + 1 && inView.ta.bottom <= inView.innerH + 1,
				"窄窗下**输入框与它的按钮都在**、都没被挤没",
				`textarea ${inView.ta.w}×${inView.ta.h} / button w=${inView.btn.w} bottom=${inView.btn.bottom} / innerH=${inView.innerH}`,
			);
			await send("Emulation.clearDeviceMetricsOverride");
			await sleep(150);
		}

		// ⑨ **回流（断点 C）**：工具/别人写动了这一页 ⇒ A 广播 `{t:"page"}` ⇒ 前端**不刷新**也能看到，
		//   而且**阅读位置不许跳**（人类早就预警过这一条：重读会不会跳回顶部）。
		phase("I3 回流：`{t:page}` 推来就重读，且滚动位置不跳");
		{
			const how4 = await navR(RD + "?long=1", 20_000);
			check(how4 !== "timeout", "长页面导航到了 load（回流要在「已经滚到中间」的状态下验）");
			await sleep(300);

			// 先把页面滚到 50%，并记住「视口顶部那一块」
			const scrollRight2 = async (frac) =>
				await ev(`(() => {
					const el = document.querySelector('#rpBody');
					el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
					return Math.round(el.scrollTop);
				})()`);
			const scrollState = async () =>
				await ev(`(() => {
					const box = document.querySelector('#rpBody');
					const boxTop = box.getBoundingClientRect().top;
					const anchor = [...box.children].find((n) => n.getBoundingClientRect().top - boxTop >= -2);
					return {
						scrollTop: Math.round(box.scrollTop),
						scrollH: box.scrollHeight,
						anchorKind: anchor?.dataset.kind ?? null,
						anchorRange: anchor?.dataset.range ?? null,
						anchorOffset: anchor ? Math.round(anchor.getBoundingClientRect().top - boxTop) : null,
						qCount: document.querySelectorAll('.rp-q').length,
						lastQ: [...document.querySelectorAll('.rp-q')].pop()?.textContent?.slice(0, 20) ?? null,
						reads: window.__net.filter((x) => x.includes('/pages?path=')).length,
					};
				})()`);

			await scrollRight2(0.5);
			const b = await scrollState();
			check("先把右栏滚到中间（这一条才有意义）", b.scrollTop > 100, `scrollTop=${b.scrollTop} / scrollH=${b.scrollH}`);
			check("这时候页面上还没有工具写的那道题", !/工具写回来/.test(b.lastQ ?? ""), String(b.lastQ));

			// 推一条回流事件（= A 广播 `{t:"page", path, pageFingerprint}`）
			const pushed = await ev(`__pageEvent('note/测试页.md')`);
			check("假装 A 广播了一条 `{t:page}` 事件", pushed === true);
			await sleep(400);

			const a2 = await scrollState();
			check("前端**自己重读了那一页**（没有人工刷新）", a2.reads > b.reads, `GET /pages?path= ${b.reads} → ${a2.reads}`);
			check("**页面上出现了工具写的那道题** —— 不刷新也看得到", a2.qCount === b.qCount + 1 && /工具写回来/.test(a2.lastQ ?? ""), `${b.qCount} → ${a2.qCount} 个问题；最后一条=${a2.lastQ}`);
			check(
				Math.abs(a2.scrollTop - b.scrollTop) <= 4,
				"**阅读位置没有跳**（还停在原处）",
				`scrollTop ${b.scrollTop} → ${a2.scrollTop}（差 ${a2.scrollTop - b.scrollTop}）；锚点 ${b.anchorKind}${b.anchorRange} → ${a2.anchorKind}${a2.anchorRange}`,
			);
			check("视口顶部还是**同一块**（按它恢复位置）", a2.anchorRange === b.anchorRange, `${b.anchorRange} → ${a2.anchorRange}`);

			// ② 有未保存的改动时：**不许**自动重读（重画会把正在写的字吞掉）
			await ev(`(() => {
				const t = document.querySelector('textarea.rp-a') ?? document.querySelector('textarea.rp-note');
				t.value = '我正在写，别覆盖我。';
				t.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
			await sleep(80);
			const c1 = await scrollState();
			await ev(`__pageEvent('note/测试页.md')`);
			await sleep(350);
			const c2 = await scrollState();
			const kept = await ev(`document.querySelector('textarea.rp-a')?.value ?? document.querySelector('textarea.rp-note')?.value ?? null`);
			// ⚠️ 这一条的**语义在 S3.3 变了**（不是退化）：以前"有未保存改动就干脆不重读"，
			// 现在按块发送需要"发送一块之后照样重读" ⇒ 改成**重读但把你写的那一块原样挂回去**。
			check("有未保存改动时**照样重读**（否则发完一块就没法接着看）", c2.reads > c1.reads, `${c1.reads} → ${c2.reads}`);
			check("**你正在写的字还在**（没有被覆盖）", kept === "我正在写，别覆盖我。", String(kept).slice(0, 20));
			const stillDirty = await ev(`(() => { const e = [...document.querySelectorAll('.rp-edit')].find((x) => x.classList.contains('rp-dirty')); return e ? e.querySelector('.rp-chip').dataset.state : null; })()`);
			check("而且它**还挂在那一块上**（标着「有改动未发送」）", stillDirty === "dirty", String(stillDirty));
		}

		// ⑧ **布局约束**（这一条是人类的第一个 UI 硬伤，2026-09-15）：
		//   原话「阅读页右侧的长度会把左侧的栏位也给撑长，导致滑动到中间的时候，左侧实际上是看不到东西的」
		//   ⇒ 用**一页很长**的页面，量三件事：① 页面本身不许滚；② 右栏自己滚；③ 左栏的关键元素
		//   无论右栏滚到 0% / 50% / 100% 都**留在视口内**。窄窗口（900×600）再量一遍。
		phase("I2 长页面：右栏自己滚，左栏不许被撑长、不许滑出视口");
		{
			const how2 = await navR(RD + "?long=1", 20_000);
			check("长页面导航到了 load", how2 !== "timeout");
			await sleep(250);

			/** 量一次：页面滚动尺寸 / 右栏滚动尺寸 / 左栏关键元素的 rect。 */
			const measure = async () =>
				await ev(`(() => {
					const se = document.scrollingElement;
					const body = document.body;
					const left = document.querySelector('#left');
					const rpBody = document.querySelector('#rpBody');
					const pick = (sel) => {
						const el = document.querySelector(sel);
						if (!el) return null;
						const r = el.getBoundingClientRect();
						return {
							sel,
							top: Math.round(r.top),
							bottom: Math.round(r.bottom),
							height: Math.round(r.height),
							// ⚠️ 收起状态的 details 用的是 content-visibility 那套：**看不见的内容
							// 仍然报得出 rect**（实测收起时 #rpDebugBody 还报 603→750，而面板只有 25px 高）。
							// 所以"在不在视口内"必须**先问它可见不可见**，不然就是在断言一个幽灵盒子。
							visible: el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }) : null,
						};
					};
					return {
						debugOpen: document.querySelector('#rpDebug').open,
						innerH: innerHeight,
						innerW: innerWidth,
						pageScrollH: se.scrollHeight,
						pageClientH: se.clientHeight,
						pageScrollTop: se.scrollTop,
						bodyH: Math.round(body.getBoundingClientRect().height),
						leftH: Math.round(left.getBoundingClientRect().height),
						metaScrollH: document.querySelector('#rpMeta').scrollHeight,
						metaClientH: document.querySelector('#rpMeta').clientHeight,
						rpBodyScrollH: rpBody.scrollHeight,
						rpBodyClientH: rpBody.clientHeight,
						rpBodyScrollTop: Math.round(rpBody.scrollTop),
						rects: ['#rpPick', '#rpList', '#rpMeta', '#rpDebug', '#rpDebugBody'].map(pick),
					};
				})()`);

			/** 把右栏滚到某个比例。 */
			const scrollRight = async (frac) =>
				await ev(`(() => {
					const el = document.querySelector('#rpBody');
					el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
					return Math.round(el.scrollTop);
				})()`);

			/** 一次断言里把左栏**关键元素的原始 rect** 全贴出来（人看得到数字，不是"看起来对了"）。 */
			const assertAll = async (label) => {
				const m = await measure();
				check(`（${label}）**页面本身不滚**：scrollingElement.scrollHeight ≤ innerHeight+1`, m.pageScrollH <= m.innerH + 1, `scrollHeight=${m.pageScrollH} innerHeight=${m.innerH} clientHeight=${m.pageClientH}`);
				check(`（${label}）body 高度没有被内容撑高（≤ innerHeight+1）`, m.bodyH <= m.innerH + 1, `body=${m.bodyH} innerHeight=${m.innerH}`);
				check(`（${label}）左栏高度 = 视口高（没被右栏撑长）`, m.leftH <= m.innerH + 1, `#left=${m.leftH} innerHeight=${m.innerH}`);
				check(`（${label}）滚动发生在**右栏容器**里（#rpBody 内容比它自己高）`, m.rpBodyScrollH > m.rpBodyClientH + 20, `#rpBody scrollHeight=${m.rpBodyScrollH} clientHeight=${m.rpBodyClientH}`);
				// 「在视口内」只对**真的可见**的那些成立：收起的 details 正文报得出 rect 但看不见
				// （那是浏览器不给它布局，不是我们把它挤出去了）⇒ 只有在"看得见却跑到视口外"时才算坏。
				const bad = m.rects.filter((r) => !r || (r.visible !== false && (r.top < -1 || r.bottom > m.innerH + 1)));
				check(
					`（${label}）左栏关键元素**全在视口内**（选择框 / 元信息 / 调试面板）`,
					bad.length === 0,
					m.rects.map((r) => `${r?.sel}{top=${r?.top},bottom=${r?.bottom},h=${r?.height},vis=${r?.visible}}`).join(" ") + ` | innerHeight=${m.innerH} open=${m.debugOpen}`,
				);
				return m;
			};

			/** 0% / 50% / 100% 各量一次。 */
			const sweep = async (tag) => {
				await scrollRight(0);
				await assertAll(`${tag} 滚 0%`);
				await scrollRight(0.5);
				const m50 = await assertAll(`${tag} 滚 50%`);
				check(`（${tag} 滚 50%）右栏**确实滚动了**（scrollTop > 0）`, m50.rpBodyScrollTop > 0, `scrollTop=${m50.rpBodyScrollTop}`);
				await scrollRight(1);
				await assertAll(`${tag} 滚 100%`);
			};

			// 两种状态都要过：面板**收起**（默认，人平时看到的）与**展开**（左栏最长的情况）
			await ev("document.querySelector('#rpDebug').open = false");
			await sleep(80);
			check("这一轮先量**面板收起**", (await ev("document.querySelector('#rpDebug').open")) === false);
			const visOf = async () =>
				await ev(`(() => {
					const v = (sel) => { const el = document.querySelector(sel); return el?.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true }) : null; };
					return { summary: v('#rpDebug'), body: v('#rpDebugBody') };
				})()`);
			const vClosed = await visOf();
			check("收起 = **开关还在**（summary 可见）但正文确实隐藏（不是被裁在半路）", vClosed.summary === true && vClosed.body === false, JSON.stringify(vClosed));
			await sweep("宽窗/收起");

			await ev("document.querySelector('#rpDebug').open = true");
			await sleep(150);
			check("这一轮量**面板展开**（左栏最长的情况）", (await ev("document.querySelector('#rpDebug').open")) === true);
			const vOpen = await visOf();
			check("展开 = 开关与正文都可见（正文自己滚，不许溢出面板）", vOpen.summary === true && vOpen.body === true, JSON.stringify(vOpen));
			await sweep("宽窗/展开");

			// 窄窗口（900×600）：最坏那一档（面板展开）再走一遍
			await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
			await sleep(200);
			const narrow = await ev("innerWidth + 'x' + innerHeight");
			check("窗口已经改成 900×600", narrow === "900x600", narrow);
			await sweep("窄窗/展开");
			await send("Emulation.clearDeviceMetricsOverride");
			await sleep(150);

			// 第三种状态：**左栏元信息很长**（长路径 / 一堆错误行）—— 它该**自己滚**，不许把调试面板顶出视口
			await ev(`(() => {
				const m = document.querySelector('#rpMeta');
				m.textContent = '路径：' + '很长的路径段/'.repeat(80);
				return m.scrollHeight;
			})()`);
			await sleep(120);
			await scrollRight(0);
			const mMeta = await measure();
			check("元信息很长时：**它自己滚**（内容比它自己高）", mMeta.metaScrollH > mMeta.metaClientH, `#rpMeta scrollHeight=${mMeta.metaScrollH} clientHeight=${mMeta.metaClientH}`);
			await sweep("宽窗/元信息很长");

			// 顺带守住**共用那条规则**：主界面（`#right`）也必须仍然"页面不滚、左栏不被撑长"
			// （我把 `#right` 扩成 `#right, #reading`，这条断言就是防那次改动把主界面搞坏）
			const how3 = await navR(PAGE, 20_000);
			check("回到主界面", how3 !== "timeout");
			await sleep(400);
			const mainUI = await ev(`(() => {
				const se = document.scrollingElement;
				const l = document.querySelector('#left').getBoundingClientRect();
				return { innerH: innerHeight, pageScrollH: se.scrollHeight, leftH: Math.round(l.height), hasRight: !!document.querySelector('#right') };
			})()`);
			check(
				"主界面仍然「页面不滚 + 左栏 = 视口高」（共用规则没被改坏）",
				mainUI.hasRight && mainUI.pageScrollH <= mainUI.innerH + 1 && mainUI.leftH <= mainUI.innerH + 1,
				JSON.stringify(mainUI),
			);
		}

		// ⑫ 草稿（未发送的改动）：人类在方向书里点名的**当前唯一的功能缺口**
		//    （内部方向书的原话：「未发送的改动刷新之后不保存，切换会话之后回来也不保存」）。
		//    这一段全用**真 chromium + 真刷新（Page.navigate 重新加载文档）+ 真 localStorage**：
		//    ① 写一块 → 刷新 → 草稿还在、那一块上标着「上次没发送的草稿」；② 切到另一页再切回来 → 还在；
		//    ③ 按块发送成功 → 草稿清掉（localStorage 里也清）+ 滚动差 0；④ 改回与文件一致 → 自动清；
		//    ⑤ 那一块在文件里被改掉（认不回原位）→ 摊在页尾，而不是消失；⑥ 有草稿时来一条回流不丢草稿。
		phase("I6 草稿：刷新还在 / 切页回来还在 / 发送成功就清 / 改回原样自动清 / 认不回原位摊页尾");
		{
			const KEY1 = "sopho.reading.drafts.v1:note/测试页.md";
			const PAGE2 = "note/另一页.md";
			const KEY2 = "sopho.reading.drafts.v1:" + PAGE2;
			const problems0 = pageProblems.length;
			/** localStorage 里这一页的草稿账（null = 根本没有这条键）。 */
			const storeOf = (key) =>
				ev(`(() => { try { const j = JSON.parse(localStorage.getItem(${JSON.stringify(key)}) ?? 'null'); return j ? (j.drafts ?? 'NO-DRAFTS-FIELD') : null; } catch (e) { return 'PARSE-ERROR:' + e.message; } })()`);
			/** 一页的现场：每个可编辑块的现值 / 草稿标记 / 回执 / 页尾摊出来的草稿 / 滚动位置 / press 次数。 */
			const PROBE = `(() => {
				const eds = [...document.querySelectorAll('.rp-edit')];
				const tag = (e) => e.querySelector('.rp-drafttag');
				return {
					head: document.querySelector('#head').textContent.trim(),
					values: eds.map((e) => e.querySelector('textarea').value),
					ranges: eds.map((e) => e.dataset.range),
					chips: eds.map((e) => e.querySelector('.rp-chip').dataset.state),
					drafts: eds.map((e) => ({ marked: e.classList.contains('rp-draft'), hidden: tag(e).hidden, display: getComputedStyle(tag(e)).display, text: tag(e).textContent })),
					orphanBoxes: document.querySelectorAll('.rp-draftorphans').length,
					orphanValues: [...document.querySelectorAll('.rp-orphan[data-draft-orphan]')].map((t) => t.value),
					scrollTop: Math.round(document.querySelector('#rpBody').scrollTop),
					presses: window.__net.filter((x) => x.includes('/pages/press')).length,
				};
			})()`;
			const probe = () => ev(PROBE);
			const navOk = async (url, ms = 20_000) => (await navR(url, ms)) !== "timeout";
			const type = (idx, text) =>
				ev(`(() => { const t = [...document.querySelectorAll('.rp-edit textarea')][${idx}]; t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return t.value; })()`);
			const pickPage = async (path) => {
				await ev(`(() => { const s = document.querySelector('#rpList'); s.value = ${JSON.stringify(path)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
				await sleep(450);
			};

			// 起点：把账清干净（前面几个阶段留过草稿 —— 这一段自己管自己那本账）
			check("I6 先回到阅读页", await navOk(RD));
			await sleep(250);
			await ev("localStorage.clear()");
			check("I6 清账后重新加载这一页", await navOk(RD));
			await sleep(350);
			const clean = await probe();
			check("起点干净：账是空的、页面上没有任何「草稿」标记", (await storeOf(KEY1)) === null && clean.drafts.every((d) => !d.marked), JSON.stringify(await storeOf(KEY1)));

			// ── ① 写一块 → **真刷新** → 草稿还在 + 那一块上有标记 ──
			const ANCHOR1 = "笔记：这里我自己写一句。"; // 那一块在文件里的原文 = 锚点
			const DRAFT1 = "（草稿）刷新之前写的一行。";
			await type(1, DRAFT1);
			await sleep(120);
			const s1 = await storeOf(KEY1);
			check("① 一改字，草稿**立刻落进 localStorage**（不再只活在内存里）", Array.isArray(s1) && s1.length === 1 && s1[0].text === DRAFT1, JSON.stringify(s1));
			check("① 草稿的锚点是**那一块在文件里的原文**（不是行号 / range）", s1?.[0]?.fileText === ANCHOR1, JSON.stringify(s1?.[0]?.fileText));
			const keys1 = await ev("Object.keys(localStorage)");
			check("① 草稿键**含页面相对路径**（一页一份账）", keys1.length === 1 && keys1[0] === KEY1, JSON.stringify(keys1));
			check("① **真刷新**（重新加载这一页的文档）", await navOk(RD));
			await sleep(450);
			const r1 = await probe();
			check("① 刷新之后**草稿回到原来那一块**（第 2 个输入框 = 那段笔记）", r1.values.length === 2 && r1.values[1] === DRAFT1 && r1.ranges[1] === clean.ranges[1], JSON.stringify(r1.values));
			check("① 那一块上**如实标出「上次没发送的草稿」**（看得见，不是个空壳）", r1.drafts[1].marked === true && r1.drafts[1].hidden === false && r1.drafts[1].display !== "none" && /上次没发送的草稿/.test(r1.drafts[1].text), JSON.stringify(r1.drafts[1]));
			check("① 那一块的**回执**照旧说「有改动未发送」（草稿标记是**另加**的，没换掉原有回执）", r1.chips[1] === "dirty", JSON.stringify(r1.chips));
			check("① **只有那一块**是草稿（别的块不受影响）", r1.drafts.filter((d) => d.marked).length === 1, JSON.stringify(r1.drafts.map((d) => d.marked)));
			check("① **绝不自动发送**：刷新之后一个 `/pages/press` 都没发", r1.presses === 0, String(r1.presses));

			// ── ② 切到另一页再切回来（人类点名的**正是这半**：「切换会话之后回来也不保存」）──
			await pickPage(PAGE2);
			const p2 = await probe();
			check("② 真的换了一页（`#head` 上的 rel 变了）", p2.head === PAGE2, p2.head);
			check("② 另一页**没有**这一页的草稿（别的页面不会把它顶掉）", p2.drafts.every((d) => !d.marked) && (await storeOf(KEY2)) === null, JSON.stringify(await storeOf(KEY2)));
			check("② 切页**没把原来那一页的草稿弄丢**（localStorage 里那份还在）", (await storeOf(KEY1))?.length === 1, JSON.stringify(await storeOf(KEY1)));
			await pickPage("note/测试页.md");
			const b2 = await probe();
			check("② 切回来 ⇒ **草稿还在原来那一块**、标记也还在", b2.values[1] === DRAFT1 && b2.drafts[1].marked === true && /上次没发送的草稿/.test(b2.drafts[1].text), JSON.stringify({ v: b2.values, chips: b2.chips }));

			// 顺带：手动点「重读」（`#rpReload`）也不许再把没发送的字吞掉（它以前走的是同一条 clear）
			await ev("document.querySelector('#rpReload').click()");
			await sleep(450);
			const rc = await probe();
			check("手动「重读」也不吞没发送的字（草稿从本地账上回来）", rc.values[1] === DRAFT1 && rc.drafts[1].marked === true, JSON.stringify(rc.values));
			check("「重读」也没有顺手把它发出去", rc.presses === 0, String(rc.presses));

			// ── ④ 用户把内容改回与文件一致 ⇒ 自动清掉 ──
			await type(1, ANCHOR1);
			await sleep(150);
			const c2 = await probe();
			check("④ 改回与文件一致 ⇒ 内存里那份没了（回执回到 clean）", c2.drafts.every((d) => !d.marked) && c2.chips[1] === "clean", JSON.stringify(c2.chips));
			check("④ 而且 localStorage 里那条键**直接删掉**（不留空账）", (await storeOf(KEY1)) === null, JSON.stringify(await storeOf(KEY1)));

			// ── ③ + ⑥ 长页：刷新/回流/发送之后**滚动与草稿**都要照旧 ──
			check("③ 换成**长页面**（同一页 rel，但内容很长 —— 滚动才有意义）", await navOk(RD + "?long=1"));
			await sleep(450);
			const L2 = 2; // 长页里最后那个可编辑块（i=20 那处笔记，位置很深）
			const DRAFT2 = "（草稿）长页最后一块的草稿。";
			await ev(`(() => { document.querySelectorAll('.rp-edit')[${L2}].scrollIntoView({ block: 'center' }); return true; })()`);
			await type(L2, DRAFT2);
			await sleep(150);
			const l0 = await probe();
			check("③ 长页里这一块也吃到了草稿（账上的锚点跟着换了）", (await storeOf(KEY1))?.[0]?.text === DRAFT2, JSON.stringify(await storeOf(KEY1)));
			check("③ 打字之前它已经在视口里（下面量滚动位置才不是假通过）", l0.scrollTop > 200, `scrollTop=${l0.scrollTop}`);
			check("③ **真刷新长页**", await navOk(RD + "?long=1"));
			await sleep(500);
			const l1 = await probe();
			check("③ 刷新之后草稿还在**原来那一块**（深页里也一样）", l1.values[L2] === DRAFT2 && l1.drafts[L2].marked === true, JSON.stringify({ v: l1.values.slice(-1), d: l1.drafts.map((d) => d.marked) }));
			console.log(`     （刷新前后 #rpBody.scrollTop：${l0.scrollTop} → ${l1.scrollTop}；深块在不在视口里：${await ev(`(() => { const r = document.querySelectorAll('.rp-edit')[${L2}].getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)}）`);
			check("③ 刷新之后**滚动位置没被甩到顶上**（块位置不放飞）", l1.scrollTop > 200, `scrollTop=${l0.scrollTop} → ${l1.scrollTop}`);
			// ⑥ 有草稿时来一条 `{t:page}` 回流：草稿一个字都不许丢，滚动差 0
			await ev("__pageEvent('note/测试页.md')");
			await sleep(500);
			const l2 = await probe();
			check("⑥ 有草稿时照样重读（S3.3 的语义没变），但**草稿一个字都没丢**", l2.values[L2] === DRAFT2 && l2.drafts[L2].marked === true, JSON.stringify(l2.values[L2]));
			check("⑥ 回流重读之后 **scrollTop 差 0**（阅读位置不放飞）", l2.scrollTop - l1.scrollTop === 0, `${l1.scrollTop} → ${l2.scrollTop}`);
			// ③ 按块发送成功 ⇒ 草稿清掉（内存 + localStorage）+ 滚动差 0
			await ev(`document.querySelectorAll('.rp-edit .rp-send')[${L2}].click()`);
			await sleep(550);
			const l3 = await probe();
			const sent = await ev("(window.__press ?? []).slice(-1)[0]");
			check("③ 按块发送只提交这一块", sent?.body?.edits?.length === 1 && JSON.stringify(sent?.body?.edits?.[0]?.range) === JSON.stringify(l1.ranges[L2].split("-").map(Number)), `${JSON.stringify(sent?.body?.edits?.[0]?.range)} / 那一块=${l1.ranges[L2]}`);
			check("③ 发送成功 ⇒ 草稿标记消失、回执变「已发送」", l3.drafts.every((d) => !d.marked) && l3.chips[L2] === "sent", JSON.stringify({ chips: l3.chips, marked: l3.drafts.map((d) => d.marked) }));
			check("③ **localStorage 里那份也清掉了**（键直接没了）", (await storeOf(KEY1)) === null, JSON.stringify(await storeOf(KEY1)));
			check("③ 发送之后 **scrollTop 差 0**（发送后滚动不跳）", l3.scrollTop - l1.scrollTop === 0, `${l1.scrollTop} → ${l3.scrollTop}`);

			// ── ⑤ 那一块在文件里被改掉 ⇒ 草稿认不回原位：**不静默丢**，摊在页尾 ──
			check("⑤ 回到短页", await navOk(RD));
			await sleep(400);
			const DRAFT3 = "（认不回原位）短页笔记的草稿。";
			await type(1, DRAFT3);
			await sleep(150);
			check("⑤ 先在短页写一份草稿（账上一条）", (await storeOf(KEY1))?.length === 1, JSON.stringify(await storeOf(KEY1)));
			check("⑤ 换成**读者段落的字不一样的那一页**（同一页 rel）", await navOk(RD + "?long=1"));
			await sleep(500);
			const o1 = await probe();
			check("⑤ 认不回原位的草稿**没被吞掉**：页尾把它摊出来了", o1.orphanBoxes === 1 && o1.orphanValues.includes(DRAFT3), JSON.stringify({ boxes: o1.orphanBoxes, values: o1.orphanValues }));
			check("⑤ 它**没有**被硬塞进别的块（认不回就是认不回）", !o1.values.includes(DRAFT3) && o1.drafts.every((d) => !d.marked), JSON.stringify(o1.values.slice(0, 3)));
			check("⑤ 账上也还留着它（下次读这一页还在）", (await storeOf(KEY1))?.some((d) => d.text === DRAFT3) === true, JSON.stringify(await storeOf(KEY1)));
			check("⑤ 回到原文那一页", await navOk(RD));
			await sleep(450);
			const o2 = await probe();
			check("⑤ 它**又挂回原来那一块**了（不是只在页尾躺一次）", o2.values[1] === DRAFT3 && o2.drafts[1].marked === true && o2.orphanBoxes === 0, JSON.stringify({ v: o2.values, boxes: o2.orphanBoxes }));
			check("⑤ 再换成内容不一样的那一页", await navOk(RD + "?long=1"));
			await sleep(500);
			await ev("document.querySelector('.rp-draftorphans .rp-dismiss').click()");
			await sleep(250);
			const o3 = await probe();
			check("⑤ 页尾那个「丢掉这一份草稿」真的能清掉（草稿要有出口，不能只涨不消）", o3.orphanBoxes === 0 && (await storeOf(KEY1)) === null, JSON.stringify({ boxes: o3.orphanBoxes, store: await storeOf(KEY1) }));

			// ── 存储坏掉（配额满 / 隐私模式）：**编辑与发送照旧**，只是草稿留不下来 ──
			//    （「存不下也不该影响编辑」这句是我写在代码注释里的承诺 —— 这里把它变成判据）
			check("换回短页，把 localStorage 打成「一律抛异常」", await navOk(RD));
			await sleep(400);
			await ev(`(() => {
				const proto = Object.getPrototypeOf(localStorage);
				proto.setItem = function () { throw new DOMException("quota", "QuotaExceededError"); };
				proto.getItem = function () { throw new DOMException("denied", "SecurityError"); };
				proto.removeItem = function () { throw new DOMException("denied", "SecurityError"); };
				return true;
			})()`);
			await type(1, "（存储坏掉时）这一行照样能打。");
			await sleep(150);
			const bk = await probe();
			check("（存储坏掉）**打字照旧**：改动照样认得出来、按钮照样亮", bk.chips[1] === "dirty", JSON.stringify(bk.chips));
			await ev("document.querySelectorAll('.rp-edit .rp-send')[1].click()");
			await sleep(550);
			const bk2 = await probe();
			check("（存储坏掉）按块发送**照旧**成功（回执「已发送 ✓」）", bk2.chips[1] === "sent", JSON.stringify(bk2.chips));
			check("（存储坏掉）重读之后也不炸（那一页还在、还是那些块）", bk2.values.length >= 2 && bk2.head === "note/测试页.md", JSON.stringify({ n: bk2.values.length, head: bk2.head }));
			// ── 服务端「存住了但没发出去」：那一块的回执**不许**被粉饰成「已发送 ✓」──
			check("（投递失败那一档）导航到 ?pressfail=1（真路由回 502）", await navOk(RD + "?pressfail=1"));
			await sleep(400);
			await type(1, "（投递失败）这一块存住了但发不出去。");
			await sleep(150);
			await ev("document.querySelectorAll('.rp-edit .rp-send')[1].click()");
			await sleep(550);
			const pf = await probe();
			const pfNotice = await ev("document.querySelector('#rpNotice').textContent");
			check("（投递失败）那一块的回执是**失败**，不是「已发送 ✓」", pf.chips[1] === "failed", JSON.stringify(pf.chips));
			check("（投递失败）那句话也说的是「存住了但没发出去」", /存住/.test(pfNotice) && /没发出去/.test(pfNotice), pfNotice.slice(0, 60));
			check("（投递失败）那份草稿已经清了（字确实写进文件了 —— 清了才是对的）", (await storeOf(KEY1)) === null, JSON.stringify(await storeOf(KEY1)));
			check("I6 这一段没有新报错（未捕获异常 / console.error）", pageProblems.length === problems0, pageProblems.slice(problems0).join(" | "));
		}
	}

	// ── S 扩展消息（extras）+ 新建会话面板（本轮新增的两块前端）──
	// 真 chromium + 真 index.html/app.mjs/app.css。盯的是两件**只有开了浏览器才验得到**的事：
	//   ① 扩展消息（命令输出）真的画出来，而且**样式与助手正文明显不同**（拿 getComputedStyle 量，
	//      不是只断言“有个 div”），并且**没有 extras 时不多出任何东西**（空块不占位）；
	//   ② 新建会话面板填了目录后**真的把 cwd 发出去**（拦请求看 body），下拉候选来自 GET /cwd-recents。
	phase("S 扩展消息（extras）+ 新建会话面板（真 chromium）");
	// ⚠️ 用一个**新 query**（不是只有 hash 变）—— 只改 `#` 是 same-document 导航，
	// **不会**有 Page.loadEventFired，`load()` 会等至超时。
	await load(`${PAGE}?extrasui=1#${fixture.id}`);
	await sleep(400);
	await settle(2);

	// S1 没有 extras → 一个扩展块都没有（别让空块占位）
	const s0 = await ev("__h.extras()");
	check("没有 extras 时：一个扩展块都没有（空块不占位）", s0.count === 0 && s0.box === false, JSON.stringify(s0));

	// S2 有 extras → 真渲染 + 样式与助手正文明显不同 + 明写「不是模型说的话」
	await ev("window.__extras = [{ id: 'c1', customType: 'sopho-cwd', text: '【/cwd】当前工作目录：/tmp/mock\\n最近用过：/tmp/mock/one', at: '2026-01-01T00:00:00.000Z' }]");
	await ev("__h.pokeReload()");
	await settle(4);
	await sleep(200);
	const s1 = await ev("__h.extras()");
	check("有 extras 时：扩展块**真的渲染出来**了（能读到那段文本）", s1.count === 1 && s1.texts[0].includes("当前工作目录"), JSON.stringify(s1.texts));
	check("样式与助手正文**明显不同**（左侧竖条 + 非透明灰底，拿 getComputedStyle 量的）", s1.borderLeftWidth >= 2 && !!s1.bg && s1.bg !== "rgba(0, 0, 0, 0)" && s1.asstBg !== s1.bg, `ext bg=${s1.bg} border-left=${s1.borderLeftWidth}px asstBg=${s1.asstBg}`);
	check("**没有**伪装成一条助手消息（不在 .msg 里）", s1.insideMsg === false, `insideMsg=${s1.insideMsg}`);
	check("块头**明写「不是模型说的话」**并标出来源（sopho-cwd）", s1.badge.includes("扩展消息") && s1.src.includes("不是模型说的话") && s1.src.includes("sopho-cwd"), `badge=「${s1.badge}」 src=「${s1.src}」`);

	// S3 清掉 extras → 块跟着消失（不是一次性的残留）
	await ev("window.__extras = []");
	await ev("__h.pokeReload()");
	await settle(4);
	await sleep(200);
	const s2 = await ev("__h.extras()");
	check("extras 清空后块也消失（不会留残影）", s2.count === 0 && s2.box === false, JSON.stringify(s2));

	// S4 新建会话面板：候选来自 GET /cwd-recents
	await ev("window.__recents = { recents: [ { path: '/tmp/mock/one', count: 3, at: 2 }, { path: '/tmp/mock/two', count: 1, at: 1 } ], exists: true }");
	await ev("__h.clickNew()");
	let s4 = null;
	for (let i = 0; i < 20; i++) {
		await sleep(60);
		s4 = { box: await ev("__h.newBox()"), opts: await ev("__h.newRecentOptions()") };
		if (s4.opts.filter(Boolean).length >= 2) break;
	}
	const s4hint = await ev("__h.newHint()");
	check("点「＋ 新会话」→ 面板出现", s4.box?.hidden === false, JSON.stringify(s4.box));
	check("下拉候选**来自 GET /cwd-recents**（那两条路径都在）", s4.opts.includes("/tmp/mock/one") && s4.opts.includes("/tmp/mock/two"), JSON.stringify(s4.opts));
	check("面板如实说明「没有白名单」（不假装替人挡了什么）", /没有白名单/.test(s4hint), s4hint);

	// S5 选候选会填进输入框；填了目录后建会话 → POST body 里真的带 cwd
	await ev("__h.pickRecent(1)");
	await settle(1);
	const s5 = await ev("__h.newCwdVal()");
	check("选下拉候选 → 填进输入框", s5 === "/tmp/mock/one", String(s5));
	await ev("__h.setNewCwd('/tmp/mock/typed')");
	await ev("__h.clickNewGo()");
	await sleep(400);
	await settle(3);
	const s6 = { body: await ev("__h.lastNewSessionBody()"), box: await ev("__h.newBox()") };
	check("点「建这条会话」→ POST /sessions 的 body 里**真的带着 cwd**", s6.body && s6.body.cwd === "/tmp/mock/typed", JSON.stringify(s6.body));
	check("建完面板收起来", s6.box?.hidden === true, JSON.stringify(s6.box));

} catch (e) {
	fail("测试跑挂了", String(e.stack ?? e));
} finally {
	console.log("\n── 结果 ──");
	for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}${r.detail ? `  —— ${r.detail}` : ""}`);
	if (failed) console.log(`\n❌ ${results.length} 项断言里失败 ${failed} 项`);
	else console.log(`\n✅ ${results.length} 项断言全部通过`);
	ws.close();
	killChrome();
	await sleep(300); // 给进程组一点时间真的退掉，再去删 profile 目录
	staticSrv.close();
	cleanupProfile();
}

process.exit(failed ? 1 : 0);
