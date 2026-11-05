/**
 * epub 抽取器：给定 epub + 段选择器 ⇒ **单行纯文本** + `srcId` + **剥离痕迹**。
 *
 * 为什么自己写 zip 读：① 不引入新依赖（仓库只依赖 pi）；② **确定性**要能自己保证 ——
 * 解压库的实现/默认参数一变，抽出来的字就可能变，而我们的指纹钉在文件里。
 * 只实现 epub 实际用到的那一小块：EOCD → 中央目录 → 本地头 → `inflateRawSync`。
 * 遇到 zip64 / 加密 / 没见过的压缩法 ⇒ **如实报错**，绝不猜。
 *
 * ── 人类 2026-09-15 拍板的四条（本模块就是照它们写的）────────────────────
 * 1. **段选择器 = 按段落**（`#pN` = 这份 xhtml 里第 N 个 `<p>`，1 起，文档序）。
 *    **不做语义选择器** —— 找到/找不到都由 # 决定，别猜"这三段大概是一章"。
 * 2. **原文粒度 = 段落**。
 * 3. **原文块 v1 = 单行纯文本**：行内标记（`<a>`/`<sup>`/`<span>`/`<br>`/`<img>`…）**剥离**，
 *    但**必须留痕**（`stripped="a=2,sup=2"`，按 tag 名排序）。理由（人类原话）：
 *    "原样写进 md 且哈希自洽 ⇒ 没人会发现" —— 这是最危险的一类错。
 * 4. `#pN` 的 N 是**绝对**下标：**空的 `<p>`（比如只有 `<br/>` 的占位段）也占一个号**。
 *    跳号会让"第 n 段"依赖抽取器版本，而它已经写进 md 了。
 *
 * ⚠️ 本模块**不写文件、不碰网络**：只读 epub，返回数据。写盘在 `page-store.mjs`。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { normalizeSourceText, sourceFingerprint } from "./reading-page.mjs";

// ── 极简 zip 读取 ────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

function findEocd(buf) {
	for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - MAX_COMMENT; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	}
	return -1;
}

/** 读一个 zip（epub 就是 zip）成 `Map<内部路径, Buffer>`。 */
export function readZipBuffer(buf) {
	const eocd = findEocd(buf);
	if (eocd < 0) throw new Error("不是 zip/epub：找不到 EOCD（文件结尾没有中央目录）");
	const count = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (cdOffset === 0xffffffff) throw new Error("zip64 不支持（中央目录偏移是 0xffffffff）");
	const entries = new Map();
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new Error(`中央目录第 ${i} 条损坏`);
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const usize = buf.readUInt32LE(p + 24);
		const nlen = buf.readUInt16LE(p + 28);
		const elen = buf.readUInt16LE(p + 30);
		const clen = buf.readUInt16LE(p + 32);
		const lho = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nlen);
		if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new Error(`zip64 不支持（条目 ${name}）`);
		if (buf.readUInt32LE(lho) !== LFH_SIG) throw new Error(`本地头损坏：${name}`);
		const lnlen = buf.readUInt16LE(lho + 26);
		const lelen = buf.readUInt16LE(lho + 28);
		const dataStart = lho + 30 + lnlen + lelen;
		const raw = buf.subarray(dataStart, dataStart + csize);
		if (method === 0) entries.set(name, Buffer.from(raw));
		else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
		else throw new Error(`不支持的压缩法 method=${method}（条目 ${name}）`);
		p += 46 + nlen + elen + clen;
	}
	return entries;
}

/** 打开一个 epub：解出条目 + 定位 OPF + 列出 spine 里的 xhtml。 */
export function openEpub(epubPath) {
	const buf = fs.readFileSync(epubPath);
	const sha256 = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
	const entries = readZipBuffer(buf);

	const containerRaw = entries.get("META-INF/container.xml");
	if (!containerRaw) throw new Error("不是合法 epub：没有 META-INF/container.xml");
	const opfPath = /<rootfile[^>]*\bfull-path\s*=\s*"([^"]+)"/.exec(containerRaw.toString("utf8"))?.[1];
	if (!opfPath) throw new Error("container.xml 里找不到 rootfile/@full-path");
	const opfRaw = entries.get(opfPath);
	if (!opfRaw) throw new Error(`container.xml 指的 OPF 不在包里：${opfPath}`);
	const opf = opfRaw.toString("utf8");
	const opfDir = path.posix.dirname(opfPath);

	// manifest：id → {zipPath, mediaType}
	const manifest = new Map();
	for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
		const id = /\bid\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
		const href = /\bhref\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
		const mediaType = /\bmedia-type\s*=\s*"([^"]*)"/.exec(m[0])?.[1] ?? "";
		if (!id || !href) continue;
		const zipPath = href.startsWith("/") ? href.slice(1) : path.posix.normalize(path.posix.join(opfDir, href));
		manifest.set(id, { zipPath, mediaType });
	}
	// spine：阅读顺序（只收 xhtml）
	const files = [];
	for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
		const idref = /\bidref\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
		const it = idref ? manifest.get(idref) : null;
		if (it) files.push({ id: idref, zipPath: it.zipPath, mediaType: it.mediaType });
	}
	if (files.length === 0) for (const [id, it] of manifest) files.push({ id, zipPath: it.zipPath, mediaType: it.mediaType });

	const baseNames = new Map();
	for (const f of files) {
		const b = path.posix.basename(f.zipPath);
		baseNames.set(b, (baseNames.get(b) ?? 0) + 1);
	}
	return { epubPath, sha256, opfPath, opfDir, files, entries, baseNames };
}

/** 把调用方给的 `file` 解析成包内路径。接受：完整包内路径 / 相对 OPF 的路径 / 唯一的 basename。 */
export function resolveEpubFile(epub, file) {
	const want = String(file ?? "").replace(/^\.\//, "").replace(/^\/+/, "");
	if (!want) return { error: "file-empty" };
	const exact = epub.files.filter((f) => f.zipPath === want);
	const rel = epub.files.filter((f) => f.zipPath === path.posix.normalize(path.posix.join(epub.opfDir, want)));
	const base = epub.files.filter((f) => path.posix.basename(f.zipPath) === path.posix.basename(want));
	const pick = exact.length ? exact : rel.length ? rel : base;
	if (pick.length === 0) return { error: "file-not-found", known: epub.files.map((f) => f.zipPath) };
	// basename **不唯一**（比如 `Text/ch1.xhtml` 与 `Sub/ch1.xhtml`）时**不许猜** ——
	// 猜哪一个，就是一个静默的错文件。要么给完整包内路径，要么就是歧义。
	if (pick.length > 1) return { error: "file-ambiguous", matches: pick.map((f) => f.zipPath) };
	return { file: pick[0] };
}

/** `srcId` 里那个文件名：basename 唯一就用 basename（人写的形状），否则用完整包内路径。 */
export function srcIdFileName(epub, zipPath) {
	const base = path.posix.basename(zipPath);
	return (epub.baseNames.get(base) ?? 0) === 1 ? base : zipPath;
}

// ── xhtml → 段落 ────────────────────────────────────────────────────────

/**
 * 极小的 xhtml 记号切分。**只够用**：注释 / 声明 / 标签 / 文本。
 * 不做 DOM、不做容错修复 —— 出不来东西就如实报"抽不出段落"。
 */
export function* htmlTokens(html) {
	let i = 0;
	const n = html.length;
	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			yield { type: "text", text: html.slice(i) };
			return;
		}
		if (lt > i) yield { type: "text", text: html.slice(i, lt) };
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			const stop = end < 0 ? n : end + 3;
			yield { type: "comment" };
			i = stop;
			continue;
		}
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			const stop = end < 0 ? n : end + 1;
			yield { type: "decl" };
			i = stop;
			continue;
		}
		const end = html.indexOf(">", lt);
		if (end < 0) {
			yield { type: "text", text: html.slice(lt) };
			return;
		}
		const raw = html.slice(lt, end + 1);
		const closing = raw.startsWith("</");
		const selfClose = /\/\s*>$/.test(raw);
		const name = (/^<\/?\s*([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(raw)?.[1] ?? "").toLowerCase();
		yield { type: "tag", name, closing, selfClose, raw };
		i = end + 1;
	}
}

/** 实体解码：XML 那 5 个 + `&nbsp;` + 数字实体（十进制 / 十六进制）。认不出的原样留下。 */
export function decodeEntities(s) {
	const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
		}
		return named[body.toLowerCase()] ?? m;
	});
}

/** 一份 xhtml 里所有 `<p>`（文档序，1 起），每个都抽成单行纯文本 + 剥离痕迹。 */
export function listParagraphs(xhtml) {
	const out = [];
	let cur = null;
	const flush = () => {
		if (!cur) return;
		const { text, stripped } = flatten(cur.inner);
		out.push({ index: out.length + 1, cls: cur.cls, text, stripped, warnings: paragraphWarnings({ cls: cur.cls, text, stripped }) });
		cur = null;
	};
	for (const t of htmlTokens(xhtml)) {
		if (t.type === "comment" || t.type === "decl") {
			continue;
		}
		if (t.type === "tag") {
			if (t.name === "p") {
				if (t.closing) flush();
				else if (t.selfClose) {
					flush();
					cur = { cls: clsOf(t.raw), inner: [] };
					flush();
				} else {
					if (cur) flush(); // <p> 里嵌 <p>：不合法，按"上一段到此为止"处理
					cur = { cls: clsOf(t.raw), inner: [] };
				}
				continue;
			}
			if (cur) cur.inner.push(t);
			continue;
		}
		if (cur) cur.inner.push(t);
	}
	flush();
	return out;
}

function clsOf(rawTag) {
	return /\bclass\s*=\s*"([^"]*)"/.exec(rawTag)?.[1] ?? null;
}

// ── 段落"看着像什么"的**提示**（不是判定！）────────────────────────────────
//
// 人类 2026-09-15 拍板：段选择器**按段落**、"别做语义选择器" ⇒ 选到标题 / 脚注**不拒绝**，
// 但必须**如实带 warning**（带 class 名，让人自己判）。纯空 / 纯图另外走硬拒绝（见 extractParagraph）。
//
// 为什么这两条规则长得这么"土"：class 名每本书都不一样（这本是 `title1`/`subtitle4`/`normaltext`/`note1`），
// 任何"更聪明"的判定都是把猜测写进事实。这两条只是"把证据推到他眼前"，错了也不亏。
const HEADING_CLS_RE = /(?:^|[^a-z])(?:head|h[1-6]|chapter|chap|section)|title/i;
const NOTE_CLS_RE = /(?:^|[^a-z])(?:note|footnote|endnote|annotation|comment)/i;
/** 书无关的补一刀：**短**且以章节号 / 中文数字顿号开头 —— 看着像标题。 */
const HEADING_TEXT_RE = /^(?:第[〇零一二三四五六七八九十百千两0-9]+[章节课节篇部]|[一二三四五六七八九十]+[、.．]|[0-9]+[、.．])/;

export function paragraphWarnings({ cls, text, stripped }) {
	const out = [];
	// `<img>` 被剥 = **内容真丢了** ⇒ 进 warnings（不只是计数）
	if (stripped?.img) out.push("image-dropped");
	const c = String(cls ?? "").toLowerCase();
	if (HEADING_CLS_RE.test(c)) out.push(`这段看着是标题/小标题（class=${cls}）`);
	else if (NOTE_CLS_RE.test(c)) out.push(`这段看着是脚注/注释（class=${cls}）`);
	else if (text && text.length <= 40 && HEADING_TEXT_RE.test(text)) out.push(`这段看着是标题（很短、且以章节号开头：共 ${text.length} 字）`);
	return out;
}

/**
 * 一个 `<p>` 的内部 → 单行纯文本。
 * 规则（**协议的一部分**）：
 *   · 所有标签剥掉；**纯空白的文本节点丢掉**（否则代码缩进会往中文里插空格）；
 *   · 其余文本节点的连续空白压成一个空格；文本节点之间**直接拼接**（不插分隔符）；
 *   · 最后整段再压一次空白 + 去首尾；
 *   · `stripped` = 被剥掉的**元素**计数（按 tag 名排序后写成 `a=2,sup=1`）；
 *   · "看着像什么"的提示归 `paragraphWarnings()`（在 `listParagraphs` 里合并），这里只出 `{text, stripped}`。
 */
export function flatten(inner) {
	const parts = [];
	const stripped = {};
	for (const t of inner) {
		if (t.type === "tag") {
			if (t.closing) continue;
			stripped[t.name] = (stripped[t.name] ?? 0) + 1;
			continue;
		}
		const s = decodeEntities(t.text).replace(/\s+/g, " ");
		if (s.trim() === "") continue;
		parts.push(s);
	}
	const text = parts.join("").replace(/\s+/g, " ").trim();
	return { text, stripped };
}

/** `stripped` 的**确定性**序列化。 */
export function strippedToString(stripped) {
	const keys = Object.keys(stripped ?? {}).sort();
	return keys.length ? keys.map((k) => `${k}=${stripped[k]}`).join(",") : null;
}

// ── srcId ───────────────────────────────────────────────────────────────

/** `srcId` 的形状：`<epubId>!<文件名>#p<N>`（`<文件名>` 可能是完整包内路径 —— 见 srcIdFileName）。 */
export function parseSrcId(srcId) {
	const s = String(srcId ?? "");
	const bang = s.indexOf("!");
	const m = /#p(\d+)$/.exec(s);
	if (bang <= 0 || !m || m.index <= bang + 1) return null;
	const n = Number(m[1]);
	if (!Number.isInteger(n) || n < 1) return null;
	return { epubId: s.slice(0, bang), file: s.slice(bang + 1, m.index), paragraph: n };
}

// ── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 抽取一段。**不写文件**。
 * 返回 `{ ok:true, srcId, text, fingerprint, … }` 或 `{ ok:false, reason, … }`。
 * 确定性：同一 epub + 同一 `(file, paragraph, epubId)` ⇒ 逐字节同一结果。
 */
export function extractParagraph({ epubPath, file, paragraph, epubId, epub }) {
	const book = epub ?? openEpub(epubPath);
	const r = resolveEpubFile(book, file);
	if (r.error) return { ok: false, reason: r.error, known: r.known, matches: r.matches };
	const n = Number(paragraph);
	if (!Number.isInteger(n) || n < 1) return { ok: false, reason: "paragraph-not-a-positive-integer", paragraph };
	const xhtml = book.entries.get(r.file.zipPath);
	if (!xhtml) return { ok: false, reason: "entry-missing", zipPath: r.file.zipPath };
	const ps = listParagraphs(xhtml.toString("utf8"));
	if (n > ps.length) return { ok: false, reason: "paragraph-out-of-range", paragraph: n, paragraphCount: ps.length };
	const p = ps[n - 1];
	if (p.text === "") {
		return { ok: false, reason: "empty-paragraph", paragraph: n, cls: p.cls, paragraphCount: ps.length, detail: "这一段剥完标签是空的（多半是 `<p><br/></p>` 之类的占位段）—— 别把它当原文材料化" };
	}
	const srcFile = srcIdFileName(book, r.file.zipPath);
	const id = epubId ?? path.basename(epubPath);
	return {
		ok: true,
		srcId: `${id}!${srcFile}#p${n}`,
		epubId: id,
		file: srcFile,
		zipPath: r.file.zipPath,
		paragraph: n,
		paragraphCount: ps.length,
		cls: p.cls,
		text: p.text,
		fingerprint: sourceFingerprint(p.text),
		normalizedLength: normalizeSourceText(p.text).length,
		stripped: strippedToString(p.stripped),
		strippedRaw: p.stripped,
		warnings: p.warnings,
		epubSha256: book.sha256,
	};
}
