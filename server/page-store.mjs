/**
 * 阅读页的**存储层**：可写根限制 · 读 · 原子写 · 锁/重试 · 计划→校验→落盘。
 *
 * 这一层是 S1 **有意留在纯函数之外**的东西（S1 只交协议与纯函数；落盘与并发在那儿没有位置）。
 *
 * ⚠️⚠️ **这个模块是"任意文件写"的门**。B（`server/app.mjs`）**零认证**、默认绑 `0.0.0.0` ——
 * 能连上它 = 能在这台机器上执行任意命令。所以：
 *   1. **必须配 `SOPHO_PAGE_ROOT`**（默认 `$ASSIST_HOME/pages`，一个不会碰到真实文件的地方）；
 *   2. 每一条路径都过 `resolveUnderRoot()`：**绝对路径 / `..` / 越出根 / 非 `.md` / 软链逃逸**
 *      一律拒绝（`403 outside-root`），**连读都不给**；
 *   3. epub 走另一条根 `SOPHO_EPUB_ROOT`（默认 = page root），理由同上（它能读任意文件）。
 *     「根限制」不是保险箱 —— 它是**把爆炸半径限制在一个目录**里；零认证这件事本身仍在。
 *
 * 三条不变量：
 *   · **落盘是原子的**：同目录临时文件 → `fsync` → `rename`（同文件系统上是原子的）；
 *   · **写前重读**：拿锁之后**重新读盘 + 重新出计划**，绝不重放一个"上次读到的"计划；
 *   · **拒绝时零写入**：`applyPlan` 返回 `ok:false` ⇒ 一个字节都不写（纯函数保证）。
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractParagraph, listParagraphs, openEpub, resolveEpubFile, srcIdFileName, strippedToString } from "./epub-extract.mjs";
import {
	applyPlan,
	listBlocks,
	listFields,
	listSources,
	pageFingerprint,
	parsePage,
	planFieldLineReplace,
	planFieldReplace,
	planInsertBlock,
	planMaterializeSource,
	planReplaceBlockText,
	planSourceRebuild,
	renderBlock,
} from "./reading-page.mjs";

export class PageError extends Error {
	constructor(status, reason, extra = {}) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.extra = extra;
	}
}

const sha256Hex = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

// ── 根限制 ──────────────────────────────────────────────────────────────

/** 前缀检查（`/a/b` 在 `/a` 里，`/a/bc` 不在）。两者都必须是**已 realpath 的**绝对路径。 */
export function isInside(rootReal, abs) {
	return abs === rootReal || abs.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

/**
 * 把一个相对路径钉进某个根。任何可疑形状**直接拒绝**（不"帮你归一化到合法"）。
 * `{ ok:true, abs, rel }` 或 `{ ok:false, status, reason, detail }`。
 */
export function resolveUnderRoot(root, rel, { ext = null, mustExist = false } = {}) {
	if (typeof rel !== "string" || rel.trim() === "") return { ok: false, status: 400, reason: "path-empty" };
	if (rel.includes("\0")) return { ok: false, status: 400, reason: "path-has-nul" };
	if (path.isAbsolute(rel)) return { ok: false, status: 403, reason: "path-absolute", detail: "只收相对根目录的相对路径" };
	const segs = rel.split(/[\\/]+/);
	if (segs.some((s) => s === "..")) return { ok: false, status: 403, reason: "path-has-parent", detail: "不许出现 .." };
	if (ext && !rel.toLowerCase().endsWith(ext)) return { ok: false, status: 403, reason: "path-ext-not-allowed", detail: `只允许 ${ext}` };

	const rootAbs = path.resolve(root);
	const abs = path.resolve(rootAbs, rel);

	// ① 词法前缀（挡住 `..` 绕过以后剩下的情况）
	if (!isInside(rootAbs, abs)) return { ok: false, status: 403, reason: "outside-root", detail: `${abs} 不在 ${rootAbs} 里` };

	// ② 真·前缀（挡住软链逃逸）：根要 realpath，目标（或它的父目录）也要
	let rootReal;
	try {
		rootReal = fs.realpathSync(rootAbs);
	} catch {
		return { ok: false, status: 500, reason: "root-missing", detail: rootAbs };
	}
	const probe = fs.existsSync(abs) ? abs : path.dirname(abs);
	let probeReal;
	try {
		probeReal = fs.realpathSync(probe);
	} catch {
		return { ok: false, status: 404, reason: "dir-not-found", detail: probe };
	}
	if (!isInside(rootReal, probeReal)) return { ok: false, status: 403, reason: "outside-root", detail: `realpath ${probeReal} 不在 ${rootReal} 里` };
	if (mustExist && !fs.existsSync(abs)) return { ok: false, status: 404, reason: "page-not-found", detail: rel };
	if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) return { ok: false, status: 400, reason: "not-a-file", detail: rel };

	return { ok: true, abs, rel, root: rootAbs, rootReal };
}

// ── 锁 ──────────────────────────────────────────────────────────────────

/** 进程内互斥（同一份文件串行化）。键 = realpath 目标。 */
const inProcChains = new Map();
function withInProcessLock(key, fn) {
	const prev = inProcChains.get(key) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	inProcChains.set(
		key,
		run.then(
			() => {},
			() => {},
		),
	);
	return run;
}

/**
 * 跨进程的建议锁：`<lockDir>/<hash>.lock` 用 `wx` 独占创建。
 * 锁文件**不放在页面旁边**（不给 note 仓库留垃圾）—— 放临时目录，键是目标绝对路径的 hash。
 * 陈旧锁（进程没了 / 太老）自动回收。拿不到就抛 409，**绝不"没锁也写"**。
 *
 * ⚠️ 等锁用 `await` 睡，**不能**用 `Atomics.wait` 同步睡：A 是一个进程养着所有会话，
 * 同步阻塞事件循环 3 秒 = 全站卡 3 秒。
 */
async function acquireFileLock(abs, { lockDir, timeoutMs = 3000, staleMs = 30000 }) {
	fs.mkdirSync(lockDir, { recursive: true });
	const lockFile = path.join(lockDir, `${sha256Hex(abs).slice(0, 16)}.lock`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const fd = fs.openSync(lockFile, "wx");
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), target: abs }));
			fs.closeSync(fd);
			return () => {
				try {
					fs.unlinkSync(lockFile);
				} catch {
					/* 已经没了就算了 */
				}
			};
		} catch (e) {
			if (e?.code !== "EEXIST") throw e;
			let holder = null;
			try {
				holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
			} catch {
				holder = null;
			}
			const stale = !holder || Date.now() - Number(holder.at ?? 0) > staleMs || !pidAlive(holder.pid);
			if (stale) {
				try {
					fs.unlinkSync(lockFile);
				} catch {
					/* 竞争：别人先删了 —— 下一圈再看 */
				}
				continue;
			}
			if (Date.now() > deadline) throw new PageError(409, "page-locked", { lockFile, holder });
			await new Promise((r) => setTimeout(r, 25));
		}
	}
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM"; // 存在但不属于我
	}
}

// ── 原子写 ──────────────────────────────────────────────────────────────

/** 同目录临时文件 → fsync → rename（同 fs 上 rename 是原子的）。失败时清掉临时文件。 */
export function writeFileAtomic(abs, text, { encoding = "utf8" } = {}) {
	const dir = path.dirname(abs);
	const tmp = path.join(dir, `.${path.basename(abs)}.sopho-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
	let mode = null;
	try {
		mode = fs.statSync(abs).mode & 0o777;
	} catch {
		mode = null;
	}
	let fd = null;
	try {
		fd = fs.openSync(tmp, "w", mode ?? 0o644);
		fs.writeFileSync(fd, text, encoding);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = null;
		fs.renameSync(tmp, abs);
	} catch (e) {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw e;
	}
	// 目录 fsync（尽力而为：某些平台/文件系统不支持，失败不影响 rename 的原子性）
	try {
		const dfd = fs.openSync(dir, "r");
		fs.fsyncSync(dfd);
		fs.closeSync(dfd);
	} catch {
		/* ignore */
	}
	return { tmp, bytes: Buffer.byteLength(text, encoding) };
}

// ── 页面存储 ────────────────────────────────────────────────────────────

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 新块能不能渲染？不能 ⇒ 这是**调用方的输入问题**（400），而不是页面的问题。
 *  提前在计划阶段就拦下，免得 `renderBlock` 在 `applyPlan` 里抛一个生错误变成 500。 */
function renderableError(block) {
	try {
		renderBlock(block);
	} catch (e) {
		return String(e?.message ?? e);
	}
	if (typeof block.text === "string" && /<span\b|<\/span\s*>/.test(block.text)) return "正文里出现了 span 标签";
	return null;
}

export function createPageStore({ root, epubRoot, lockDir, maxAttempts = DEFAULT_MAX_ATTEMPTS, lockTimeoutMs = 3000 } = {}) {
	if (!root) throw new Error("createPageStore 需要 root");
	const pageRoot = path.resolve(root);
	const bookRoot = path.resolve(epubRoot ?? root);
	const locks = lockDir ?? path.join(os.tmpdir(), "sopho-page-locks");
	fs.mkdirSync(pageRoot, { recursive: true });
	fs.mkdirSync(bookRoot, { recursive: true });

	const resolvePage = (rel, opts) => resolveUnderRoot(pageRoot, rel, { ext: ".md", ...opts });
	const resolveEpub = (rel) => resolveUnderRoot(bookRoot, rel, { ext: null, mustExist: false });

	/** 锁的键一律用 **realpath**：同一份文件的不同写法（软链 / `./`）必须锁到同一个键。 */
	function lockKey(abs) {
		try {
			return fs.realpathSync(abs);
		} catch {
			return abs;
		}
	}

	/** 列根下所有 `.md`（最多 depth 层，避免把整棵大盘扫穿）。 */
	function listPages({ maxDepth = 8, limit = 2000 } = {}) {
		const out = [];
		const walk = (absDir, depth) => {
			if (depth > maxDepth || out.length >= limit) return;
			let ents;
			try {
				ents = fs.readdirSync(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of ents) {
				if (out.length >= limit) return;
				if (e.name.startsWith(".")) continue;
				const abs = path.join(absDir, e.name);
				if (e.isDirectory()) walk(abs, depth + 1);
				else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
					const st = fs.statSync(abs);
					out.push({ path: path.relative(pageRoot, abs), bytes: st.size, mtimeMs: Math.round(st.mtimeMs) });
				}
			}
		};
		walk(pageRoot, 1);
		out.sort((a, b) => a.path.localeCompare(b.path));
		return out;
	}

	/** 在 epub 根下按**文件名**找（工具用）：`srcId` 里只有文件名（`自我与本我.epub`），
	 *  而 API 要的是**根内相对路径**（`books/自我与本我.epub`）。找不到就如实回空数组。 */
	function findEpub(name) {
		const want = path.basename(String(name ?? "").trim());
		if (!want) return { found: [] };
		const out = [];
		const walk = (dir, depth) => {
			if (depth > 6 || out.length > 20) return;
			let ents;
			try {
				ents = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of ents) {
				if (e.name.startsWith(".")) continue;
				const abs = path.join(dir, e.name);
				if (e.isDirectory()) walk(abs, depth + 1);
				else if (e.isFile() && e.name === want) out.push(path.relative(bookRoot, abs));
			}
		};
		walk(bookRoot, 1);
		return { name: want, found: out };
	}

	/** 读一页 + 解析 + 指纹（**只读**）。 */
	function readPage(rel, { withText = true } = {}) {
		const r = resolvePage(rel, { mustExist: true });
		if (!r.ok) throw new PageError(r.status, r.reason, { detail: r.detail });
		const text = fs.readFileSync(r.abs, "utf8");
		const doc = parsePage(text);
		const st = fs.statSync(r.abs);
		return {
			path: r.rel,
			abs: r.abs,
			bytes: st.size,
			mtimeMs: Math.round(st.mtimeMs),
			pageFingerprint: pageFingerprint(text),
			errors: doc.errors,
			fields: listFields(doc),
			sources: listSources(doc),
			// 给前端渲染用（`text` 是**人读的那段字**：原文块不带标记行、助手块只给 span 里的正文）
			blocks: listBlocks(doc),
			stats: {
				lines: doc.lines.length - 1,
				blocks: doc.blocks.length,
				byKind: doc.blocks.reduce((m, b) => ((m[b.kind] = (m[b.kind] ?? 0) + 1), m), {}),
			},
			...(withText ? { text } : {}),
		};
	}

	/** 从 epub 抽一段（**只读**，不碰页面）。 */
	function extract(spec) {
		const er = resolveEpub(spec.epub);
		if (!er.ok) throw new PageError(er.status, er.reason === "outside-root" ? "epub-outside-root" : er.reason, { detail: er.detail });
		const r = extractParagraph({
			epubPath: er.abs,
			file: spec.file,
			paragraph: spec.paragraph,
			epubId: spec.epubId,
		});
		if (!r.ok) throw new PageError(400, `extract:${r.reason}`, r);
		return r;
	}

	/** **章节树**（只读）：spine 顺序 + 每份 xhtml 里"看着像标题"的段落。
	 *  给 `epub_outline` 工具用 —— 真实陪读会**向前引用**（"『原始部落』要到第十章"），
	 *  所以模型需要一个"这本书有哪几章、在哪一段"的索引，而不是自己去解 zip。 */
	function outlineOf(spec) {
		const er = resolveEpub(spec.epub);
		if (!er.ok) throw new PageError(er.status, er.reason === "outside-root" ? "epub-outside-root" : er.reason, { detail: er.detail });
		const book = openEpub(er.abs);
		const files = [];
		const chapters = [];
		for (const f of book.files) {
			const raw = book.entries.get(f.zipPath);
			if (!raw) continue;
			const ps = listParagraphs(raw.toString("utf8"));
			const name = srcIdFileName(book, f.zipPath);
			files.push({ file: name, zipPath: f.zipPath, paragraphs: ps.length });
			if (spec.file && name !== srcIdFileName(book, (resolveEpubFile(book, spec.file).file ?? {}).zipPath ?? "")) continue;
			for (const p of ps) {
				if (!p.warnings.some((w) => w.includes("标题"))) continue;
				chapters.push({ file: name, paragraph: p.index, cls: p.cls, text: p.text });
			}
		}
		return { epub: er.rel, epubSha256: book.sha256, epubId: spec.epubId ?? path.basename(book.epubPath), files, chapterCount: chapters.length, chapters };
	}

	/** **按关键词找段**（只读，逐段子串匹配）。给 `epub_search` 用：
	 *  "第十章哪里提到原始部落"这种问题，模型不该靠猜段号。 */
	function searchOf(spec) {
		const q = String(spec.q ?? "").trim();
		if (!q) throw new PageError(400, "search-needs-q");
		const limit = Math.max(1, Math.min(200, Number(spec.limit ?? 20)));
		const er = resolveEpub(spec.epub);
		if (!er.ok) throw new PageError(er.status, er.reason === "outside-root" ? "epub-outside-root" : er.reason, { detail: er.detail });
		const book = openEpub(er.abs);
		const want = q.toLowerCase();
		const hits = [];
		for (const f of book.files) {
			const raw = book.entries.get(f.zipPath);
			if (!raw) continue;
			const name = srcIdFileName(book, f.zipPath);
			for (const p of listParagraphs(raw.toString("utf8"))) {
				const at = p.text.toLowerCase().indexOf(want);
				if (at < 0) continue;
				hits.push({ file: name, paragraph: p.index, srcId: `${spec.epubId ?? path.basename(book.epubPath)}!${name}#p${p.index}`, cls: p.cls, at, text: p.text.slice(0, 160) });
				if (hits.length >= limit) return { epub: er.rel, q, count: hits.length, truncated: true, hits };
			}
		}
		return { epub: er.rel, q, count: hits.length, truncated: false, hits };
	}

	/** 列出某份 xhtml 的所有段落（**只读**）：帮人找到"第 n 个段落"是哪一段。
	 *  只给头部片段 + 长度，不把整本书吐出去。 */
	function listParagraphsOf(spec, { head = 60 } = {}) {
		const er = resolveEpub(spec.epub);
		if (!er.ok) throw new PageError(er.status, er.reason === "outside-root" ? "epub-outside-root" : er.reason, { detail: er.detail });
		const book = openEpub(er.abs);
		const fr = resolveEpubFile(book, spec.file);
		if (fr.error) throw new PageError(400, `extract:${fr.error}`, { known: fr.known, matches: fr.matches });
		const xhtml = book.entries.get(fr.file.zipPath).toString("utf8");
		const ps = listParagraphs(xhtml);
		const items = ps.map((p) => ({
			paragraph: p.index,
			cls: p.cls,
			length: p.text.length,
			head: p.text.slice(0, head),
			empty: p.text === "",
			stripped: strippedToString(p.stripped),
			// 人类 2026-09-15 拍板：按段落、**不做语义选择器** ⇒ 选到标题/脚注**不拒绝**，但要如实带 warning
			warnings: p.warnings,
		}));
		return {
			epub: er.rel,
			epubSha256: book.sha256,
			zipPath: fr.file.zipPath,
			file: srcIdFileName(book, fr.file.zipPath),
			count: items.length,
			items,
		};
	}

	/**
	 * 把 `spec.op` 描述的操作在一个**已经解析好的页面**上出计划（纯函数）。
	 * 返回 `{ ok, plan }` 或 `{ ok:false, reason, status, extra }`。
	 */
	function planFor(doc, spec) {
		const A = spec.address ?? {};
		switch (spec.op) {
			case "insert-block": {
				if (!spec.block) return { ok: false, status: 400, reason: "spec-missing-block" };
				const bad = renderableError(spec.block);
				if (bad) return { ok: false, status: 400, reason: "bad-block", detail: bad };
				const p = planInsertBlock(doc, { sourceId: spec.sourceId, section: spec.section, block: spec.block });
				return p.ok ? { ok: true, plan: p } : { ok: false, status: 409, reason: p.reason, extra: p };
			}
			case "materialize-source": {
				// 一个 / 一组段落（按顺序）：每一段都从 epub 抽 → 建成原文块 → 追加到锚点节末。
				if (!spec.section) return { ok: false, status: 400, reason: "spec-missing-section" };
				if (!spec.epub || !spec.file) return { ok: false, status: 400, reason: "spec-missing-epub" };
				const list = Array.isArray(spec.paragraphs) && spec.paragraphs.length ? spec.paragraphs : [spec.paragraph];
				const extractions = [];
				for (const n of list) {
					const r = extract({ epub: spec.epub, file: spec.file, paragraph: n, epubId: spec.epubId });
					const bad = renderableError({ kind: "原文", srcId: r.srcId, text: r.text });
					if (bad) throw new PageError(400, "bad-source-text", { srcId: r.srcId, detail: bad });
					extractions.push(r);
				}
				return { ok: true, extractions, materialize: true };
			}
			case "rebuild-source": {
				if (!spec.epub || !spec.file) return { ok: false, status: 400, reason: "spec-missing-epub" };
				const r = extract({ epub: spec.epub, file: spec.file, paragraph: spec.paragraph, epubId: spec.epubId });
				const p = planSourceRebuild(doc, { srcId: r.srcId, text: r.text, attrs: { stripped: r.stripped } });
				if (!p.ok) return { ok: false, status: 409, reason: p.reason, extra: p };
				return { ok: true, plan: p, extractions: [r] };
			}
			case "replace-field": {
				const p = planFieldReplace(doc, A, spec.lines, spec.expectedFingerprint);
				return p.ok ? { ok: true, plan: p } : { ok: false, status: 409, reason: p.reason, extra: p };
			}
			case "replace-field-line": {
				const p = planFieldLineReplace(doc, A, spec.match, spec.line, spec.expectedFingerprint);
				return p.ok ? { ok: true, plan: p } : { ok: false, status: 409, reason: p.reason, extra: p };
			}
			case "replace-block-text": {
				// 读者自己写的字（`A:` / 读者段落）。幂等：与当前文本一致 ⇒ `no-op`。
				const p = planReplaceBlockText(doc, spec);
				if (p.op === "no-op") return { ok: true, plan: p };
				return p.ok ? { ok: true, plan: p } : { ok: false, status: 409, reason: p.reason, extra: p };
			}
			default:
				return { ok: false, status: 400, reason: `unknown-op:${spec.op}` };
		}
	}

	/** 读 → 计划 → 校验 → 落盘。**拿锁 → 重读 → 出计划 → 应用**（冲突则重试）。
	 *  返回 `{ ok, wrote, attempts, plan?, extractions?, dryRun?, bytes? }`；失败抛 `PageError`。 */
	async function apply(rel, spec) {
		const r = resolvePage(rel, { mustExist: true });
		if (!r.ok) throw new PageError(r.status, r.reason, { detail: r.detail });
		return withInProcessLock(lockKey(r.abs), async () => {
			const release = await acquireFileLock(lockKey(r.abs), { lockDir: locks, timeoutMs: lockTimeoutMs });
			try {
				let lastConflict = null;
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					const before = fs.readFileSync(r.abs, "utf8");
					const doc = parsePage(before);
					// 解析错误由**计划层**判定（`planInsertBlock` / `planField*` 零容忍；
					// `planSourceRebuild` 只对**它自己那一块**的 source-hash-mismatch 开口子 ——
					// 那个 op 本来就是用来修复这种块的）。这里不再重复一刀切，否则修复路会被堵死。

					let planned = planFor(doc, spec);
					if (!planned.ok) throw new PageError(planned.status, planned.reason, planned.extra ?? {});

					// materialize：抽出若干段 → 逐段决策（**幂等**）→ 该插的插到锚点节末。
					// 决策在纯函数 `planMaterializeSource()` 里（三种情形写在那边、有契约测试钉）。
					if (planned.materialize) {
						let cur = before;
						const plans = [];
						const outcomes = [];
						for (const ex of planned.extractions) {
							const d = planMaterializeSource(parsePage(cur), {
								srcId: ex.srcId,
								text: ex.text,
								attrs: { stripped: ex.stripped },
								section: spec.section,
							});
							if (d.op === "already-present") {
								outcomes.push({ paragraph: ex.paragraph, srcId: ex.srcId, op: "already-present", wrote: false, attrsDiffer: d.attrsDiffer, detail: d.detail });
								continue;
							}
							if (d.op === "refuse") {
								// 拒绝就**整批不写**（`cur` 里已经拼进去的那些也丢掉）—— 半个批次比不写更坏。
								// 但"逐段结局"要把这一段也带上，否则调用方只看到错误、看不到到底是哪一段。
								outcomes.push({ paragraph: ex.paragraph, srcId: ex.srcId, op: "refuse", wrote: false, reason: d.reason, hint: d.detail?.hint ?? null });
								throw new PageError(d.status ?? 409, d.reason, { ...d.detail, outcomes, extraction: { paragraph: ex.paragraph, srcId: ex.srcId } });
							}
							const ap = applyPlan(cur, d.plan);
							if (!ap.ok) throw new PageError(409, ap.reason, { ...ap, outcomes, extraction: { paragraph: ex.paragraph, srcId: ex.srcId } });
							cur = ap.text;
							plans.push(d.plan);
							outcomes.push({ paragraph: ex.paragraph, srcId: ex.srcId, op: "insert", wrote: true, id: d.id });
						}
						// 一段都没插 = 要说清"它什么也没做"（而不是回一个模糊的 ok）
						const op = plans.length === 0 ? "already-present" : "materialize-source";
						if (spec.dryRun) return { ok: true, wrote: false, dryRun: true, attempt, op, plans, outcomes, extractions: planned.extractions, text: cur };
						if (plans.length === 0) {
							return { ok: true, wrote: false, attempt, op, outcomes, extractions: planned.extractions, detail: "每一段都已经在页面里、且正文与重抽结果一致 ⇒ 什么也不写" };
						}
						const w = writeFileAtomic(r.abs, cur);
						return { ok: true, wrote: true, attempt, op, plans, outcomes, extractions: planned.extractions, bytes: { before: Buffer.byteLength(before), after: w.bytes } };
					}

					if (planned.plan.op === "no-op") {
						return { ok: true, wrote: false, attempt, op: "no-op", plan: planned.plan, extractions: planned.extractions ?? null, detail: "抽出来的与文件里那份逐字节一致 ⇒ 什么也不写" };
					}

					const ap = applyPlan(before, planned.plan);
					if (!ap.ok) {
						// 锁外有写者（比如 Obsidian）：**重读重规划**，而不是重放计划
						if (ap.reason === "conflict" && attempt < maxAttempts) {
							lastConflict = ap;
							continue;
						}
						throw new PageError(409, ap.reason, ap);
					}
					// `op` 一定报出来：`no-op` 与 `replace-source` 都会走到这里，
					// 调用方必须能一眼看出「到底写了没有、是什么操作」。
					if (spec.dryRun) return { ok: true, wrote: false, dryRun: true, attempt, op: planned.plan.op, plan: planned.plan, extractions: planned.extractions ?? null, text: ap.text };
					const w = writeFileAtomic(r.abs, ap.text);
					return { ok: true, wrote: true, attempt, op: planned.plan.op, plan: planned.plan, extractions: planned.extractions ?? null, bytes: { before: Buffer.byteLength(before), after: w.bytes } };
				}
				throw new PageError(409, "conflict", { detail: `重试 ${maxAttempts} 次仍有人在这份文件上写`, last: lastConflict });
			} finally {
				release();
			}
		});
	}

	/** 一个块在消息里叫什么（`Q2 的回答` / `笔记（读者段落）`）。 */
	function labelFor(doc, range) {
		const blk = doc.blocks.find((b) => b.start === range[0] && b.end === range[1]);
		if (!blk) return `第 ${range[0] + 1} 行`;
		if (blk.kind === "answer") {
			let q = null;
			for (const b of doc.blocks) {
				if (b.start >= blk.start) break;
				if (b.kind === "question") q = b.label;
			}
			return q ? `${q} 的回答` : "回答";
		}
		if (blk.kind === "reader") return "笔记（读者段落）";
		return blk.kind;
	}

	/**
	 * **读者按一下**：一批"他自己写的字"的改动 —— **要么全写、要么一个字节不写**。
	 *
	 * 与 `apply()` 的差别只有两处：① 它走的是 `replace-block-text`（读者写的块）；
	 * ② 它把一批编辑**在内存里逐个叠上去、最后一次写盘** —— 不会出现"写了一半"。
	 * == 同一套**拿锁 → 重读 → 逐条出计划 → 应用**（冲突则重读重规划，最多 `maxAttempts` 次）。
	 */
	async function press(rel, { edits = [], dryRun = false } = {}) {
		const r = resolvePage(rel, { mustExist: true });
		if (!r.ok) throw new PageError(r.status, r.reason, { detail: r.detail });
		if (!Array.isArray(edits)) throw new PageError(400, "edits-not-an-array");
		return withInProcessLock(lockKey(r.abs), async () => {
			const release = await acquireFileLock(lockKey(r.abs), { lockDir: locks, timeoutMs: lockTimeoutMs });
			try {
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					const before = fs.readFileSync(r.abs, "utf8");
					let cur = before;
					const applied = [];
					const skipped = [];
					let conflict = null;
					for (const edit of edits) {
						const doc = parsePage(cur);
						const p = planReplaceBlockText(doc, edit);
						if (p.op === "no-op") {
							skipped.push({ range: edit.range ?? null, reason: "no-change", detail: p.detail });
							continue;
						}
						if (!p.ok) {
							if (p.reason === "conflict" && attempt < maxAttempts) {
								conflict = p;
								break;
							}
							throw new PageError(409, p.reason, { ...p, edit, applied, skipped });
						}
						const ap = applyPlan(cur, p);
						if (!ap.ok) {
							if (ap.reason === "conflict" && attempt < maxAttempts) {
								conflict = ap;
								break;
							}
							throw new PageError(409, ap.reason, { ...ap, edit, applied, skipped });
						}
						applied.push({ range: p.range, kind: p.kind, label: labelFor(doc, p.range), text: String(edit.text ?? "") });
						cur = ap.text;
					}
					if (conflict) continue; // 锁外有人写 → 重读重规划（**不重放计划**）
					const wrote = applied.length > 0;
					const bytesBefore = Buffer.byteLength(before);
					if (!wrote) {
						return { ok: true, wrote: false, wouldWrite: false, dryRun: !!dryRun, attempt, applied, skipped, pageFingerprint: pageFingerprint(before), bytes: { before: bytesBefore, after: bytesBefore } };
					}
					if (dryRun) {
						return { ok: true, wrote: false, wouldWrite: true, dryRun: true, attempt, applied, skipped, pageFingerprint: pageFingerprint(cur), bytes: { before: bytesBefore, after: Buffer.byteLength(cur) } };
					}
					const w = writeFileAtomic(r.abs, cur);
					return { ok: true, wrote: true, wouldWrite: true, attempt, applied, skipped, pageFingerprint: pageFingerprint(cur), bytes: { before: bytesBefore, after: w.bytes } };
				}
				throw new PageError(409, "conflict", { detail: `重试 ${maxAttempts} 次仍有人在这份文件上写` });
			} finally {
				release();
			}
		});
	}

	return { root: pageRoot, epubRoot: bookRoot, lockDir: locks, listPages, readPage, extract, listParagraphsOf, outlineOf, searchOf, findEpub, apply, press, resolvePage, resolveEpub };
}
