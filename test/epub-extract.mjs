#!/usr/bin/env node
/**
 * 契约测试：epub 抽取器（`server/epub-extract.mjs`）。
 *
 * 钉住人类 2026-09-15 拍板的四条 + 一条更硬的性质：
 *   · **段选择器 = 按段落**：`#pN` = 这份 xhtml 里第 N 个 `<p>`（1 起、文档序），**空的 `<p>` 也占号**；
 *   · **原文块 = 单行纯文本**：行内标记剥掉；
 *   · **必须留痕**：剥掉了什么进 `stripped="a=2,sup=2"`（按 tag 名排序）；
 *     内容真丢了的（`<img>`）额外进 `warnings`；
 *   · **确定性**：同一 epub + 同一选择器 ⇒ **逐字节**同一结果（真 epub 上是钉死的哈希）。
 *
 * 自足：**自己造一个 zip（epub）**（stored + deflate 两种压缩法都覆盖），不依赖 `zip` 命令、不碰网络。
 * 真 epub（`/tmp/zhiwo-yubenwo.epub` 或 `SOPHO_REAL_EPUB`）在的话**也真跑**一遍，并把
 * 几个关键读数**写死在测试里**（抽取逻辑一漂就红）。
 *
 * 跑法：npm run test:extract
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
	extractParagraph,
	listParagraphs,
	openEpub,
	parseSrcId,
	readZipBuffer,
	resolveEpubFile,
	srcIdFileName,
	strippedToString,
} from "../server/epub-extract.mjs";

let failed = 0;
const ok = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  —— ${detail}` : ""}`);
const bad = (what, detail = "") => {
	failed++;
	console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ""}`);
};
const check = (c, what, detail = "") => (c ? ok(what, detail) : bad(what, detail));
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

// ── 自己造 zip（不依赖 zip 命令）──────────────────────────────────────────
function crc32(buf) {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [name, content, method = 8] of files) {
		const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
		const data = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
		const nameBuf = Buffer.from(name, "utf8");
		const crc = crc32(raw);
		const lfh = Buffer.alloc(30);
		lfh.writeUInt32LE(0x04034b50, 0);
		lfh.writeUInt16LE(20, 4);
		lfh.writeUInt16LE(0x0800, 6); // UTF-8 名字
		lfh.writeUInt16LE(method, 8);
		lfh.writeUInt32LE(crc, 14);
		lfh.writeUInt32LE(data.length, 18);
		lfh.writeUInt32LE(raw.length, 22);
		lfh.writeUInt16LE(nameBuf.length, 26);
		local.push(lfh, nameBuf, data);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(data.length, 20);
		cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, nameBuf);
		offset += lfh.length + nameBuf.length + data.length;
	}
	const cdBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cdBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, cdBuf, eocd]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sopho-epub-"));
const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">测试书</dc:title></metadata>
<manifest>
<item id="c" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="Styles/s.css" media-type="text/css"/>
</manifest>
<spine><itemref idref="c"/><itemref idref="c2"/></spine></package>`;
const CH1 = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<p class="title1">篇名</p>
<p class="normaltext">甲段：行内标记<sup class="suptext"><a id="f1" href="ch1.xhtml#z1">【1】</a></sup>要剥掉但留痕。</p>
<p class="normaltext">乙段：实体 &amp; &#20057; &#x4e19; 与 &lt;尖括号&gt;。</p>
<p class="normaltext"><br/></p>
<p class="picture"><img alt="alt" src="../Images/i.jpeg"/></p>
<p class="normaltext">丙段：折了行的
      中文<sup>①</sup>与结尾。</p>
<p class="normaltext">丁段：多空白  之间<sup>x</sup> 的空格。</p>
<p class="normaltext">最后一段。</p>
</body></html>`;
const CH2 = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><p class="normaltext">第二章的唯一一段。</p></body></html>`;
const DUP = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><p class="normaltext">同名文件甲。</p></body></html>`;
const DUP2 = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><p class="normaltext">同名文件乙。</p></body></html>`;

const mockPath = path.join(TMP, "mock.epub");
fs.writeFileSync(
	mockPath,
	makeZip([
		["mimetype", "application/epub+zip", 0], // stored（真实 epub 就是 stored）
		["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, 8],
		["OEBPS/content.opf", OPF, 8],
		["OEBPS/Text/ch1.xhtml", CH1, 8],
		["OEBPS/Text/ch2.xhtml", CH2, 8],
		["OEBPS/Styles/s.css", "p{}", 8],
	]),
);

// 另一份 epub：**同名两份**（`Text/ch1.xhtml` 与 `Sub/ch1.xhtml`）—— 用来钉"不许猜"。
const dupPath = path.join(TMP, "dup.epub");
fs.writeFileSync(
	dupPath,
	makeZip([
		["mimetype", "application/epub+zip", 0],
		["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, 8],
		[
			"OEBPS/content.opf",
			`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="b" href="Sub/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
			8,
		],
		["OEBPS/Text/ch1.xhtml", DUP, 8],
		["OEBPS/Sub/ch1.xhtml", DUP2, 8],
	]),
);

console.log("── 1. zip 读取（两种压缩法都要能读）───────────────────────────────");
{
	const entries = readZipBuffer(fs.readFileSync(mockPath));
	check(entries.size === 6, "6 个条目", [...entries.keys()].join(", "));
	check(entries.get("mimetype").toString() === "application/epub+zip", "stored（method 0）能读");
	check(entries.get("OEBPS/content.opf").toString().includes("<spine>"), "deflate（method 8）能读");
	let threw = null;
	try {
		readZipBuffer(Buffer.from("这不是 zip，只是普通文本".repeat(10)));
	} catch (e) {
		threw = e.message;
	}
	check(threw !== null, "不是 zip ⇒ 如实报错，不猜", threw ?? "");
}

console.log("\n── 2. 段落索引：`#pN` = 第 N 个 <p>（空的也占号）──────────────────");
const book = openEpub(mockPath);
let ps;
{
	ps = listParagraphs(book.entries.get("OEBPS/Text/ch1.xhtml").toString());
	check(ps.length === 8, "造出来 8 个 <p>", ps.map((p) => `${p.index}:${p.text.length}`).join(" "));
	check(ps[3].text === "" && ps[3].cls === "normaltext", "第 4 个是空的（`<p><br/></p>`）—— 它**仍然占号**", JSON.stringify(ps[3].cls));
	check(ps[7].text === "最后一段。" && ps[7].index === 8, "空段之后的编号没被压缩（第 8 个 = 最后一段）");
	check(ps[4].text === "" && ps[4].cls === "picture", "纯 <img> 的段也是空的（第 5 个）");
}

console.log("\n── 3. 剥离与留痕 ───────────────────────────────────────────────────");
{
	check(ps[1].text === "甲段：行内标记【1】要剥掉但留痕。", "行内 <sup><a> 剥掉、文字留下（不留空格）", ps[1].text);
	check(strippedToString(ps[1].stripped) === "a=1,sup=1", "留痕：`a=1,sup=1`", strippedToString(ps[1].stripped));
	check(ps[1].warnings.length === 0, "这不是内容丢失 ⇒ 无 warning");
	check(strippedToString(ps[4].stripped) === "img=1" && ps[4].warnings.includes("image-dropped"), "`<img>` 被剥 ⇒ 留痕 + **warning**（内容真丢了）", strippedToString(ps[4].stripped));
	check(ps[3].stripped.br === 1, "`<br/>` 也留痕", JSON.stringify(ps[3].stripped));
	check(ps[1].text.length > 0 && !ps[1].text.includes("\n"), "结果是**单行**（没有换行）");
}

console.log("\n── 4. 实体 / 折行 / 空白 ──────────────────────────────────────────");
{
	check(ps[2].text === "乙段：实体 & 乙 丙 与 <尖括号>。", "命名 + 十进制 + 十六进制实体都解了", ps[2].text);
	check(ps[5].text === "丙段：折了行的 中文①与结尾。", "折行（代码缩进）压成一个空格；<sup> 剥掉不插空格", JSON.stringify(ps[5].text));
	check(ps[6].text === "丁段：多空白 之间x 的空格。", "连续空白压成一个；剥掉的 <sup> **不插分隔符**", JSON.stringify(ps[6].text));
}

console.log("\n── 5. 文件解析与 srcId 形状 ────────────────────────────────────────");
{
	const r1 = resolveEpubFile(book, "ch1.xhtml");
	check(r1.file?.zipPath === "OEBPS/Text/ch1.xhtml", "basename 命中（唯一）", r1.file?.zipPath);
	const r2 = resolveEpubFile(book, "Text/ch1.xhtml");
	check(r2.file?.zipPath === "OEBPS/Text/ch1.xhtml", "相对 OPF 的路径命中");
	const r3 = resolveEpubFile(book, "OEBPS/Text/ch1.xhtml");
	check(r3.file?.zipPath === "OEBPS/Text/ch1.xhtml", "完整包内路径命中");
	check(srcIdFileName(book, "OEBPS/Text/ch1.xhtml") === "ch1.xhtml", "basename 唯一 ⇒ srcId 用 basename（人写的形状）");
	const err = resolveEpubFile(book, "不存在.xhtml");
	check(err.error === "file-not-found", "找不到 ⇒ 报错并列出候选", (err.known ?? []).length + " 个候选");

	// 同名两份：**不许猜**，要么给完整路径，要么报歧义
	const dup = openEpub(dupPath);
	const amb = resolveEpubFile(dup, "ch1.xhtml");
	check(amb.error === "file-ambiguous" && amb.matches.length === 2, "basename 不唯一 ⇒ **file-ambiguous**（绝不默认第一个）", JSON.stringify(amb.matches));
	const byPath = resolveEpubFile(dup, "OEBPS/Sub/ch1.xhtml");
	check(byPath.file?.zipPath === "OEBPS/Sub/ch1.xhtml", "给完整包内路径就能定位");
	check(srcIdFileName(dup, "OEBPS/Text/ch1.xhtml") === "OEBPS/Text/ch1.xhtml", "同名两份 ⇒ srcId 自动换成**完整包内路径**（不是 basename）");
	const da = extractParagraph({ epubPath: dupPath, epub: dup, file: "ch1.xhtml", paragraph: 1, epubId: "重名.epub" });
	check(!da.ok && da.reason === "file-ambiguous", "抽取也一样拒绝歧义", da.reason);
}

console.log("\n── 6. srcId 的解析 ─────────────────────────────────────────────────");
{
	const a = parseSrcId("自我与本我.epub!part0004.xhtml#p5");
	check(a && a.epubId === "自我与本我.epub" && a.file === "part0004.xhtml" && a.paragraph === 5, "basename 形状能解", JSON.stringify(a));
	const b = parseSrcId("书.epub!OEBPS/Text/ch1.xhtml#p12");
	check(b && b.file === "OEBPS/Text/ch1.xhtml" && b.paragraph === 12, "带目录的形状也能解", JSON.stringify(b));
	for (const badId of ["没有叹号#p1", "a.epub!x.xhtml", "a.epub!x.xhtml#p0", "a.epub!#p1", "a.epub!x.xhtml#p-1", "a.epub!x.xhtml#px"]) {
		check(parseSrcId(badId) === null, `坏形状返回 null：${badId}`);
	}
}

console.log("\n── 7. 抽取（三种拒绝都要出现）─────────────────────────────────────");
{
	const good = extractParagraph({ epubPath: mockPath, epub: book, file: "ch2.xhtml", paragraph: 1, epubId: "测试.epub" });
	check(good.ok && good.srcId === "测试.epub!ch2.xhtml#p1", "正常抽一段", good.srcId);
	check(good.text === "第二章的唯一一段。" && good.fingerprint.startsWith("sha256:"), "文本 + 指纹", good.fingerprint.slice(0, 20) + "…");

	const empty = extractParagraph({ epubPath: mockPath, epub: book, file: "ch1.xhtml", paragraph: 4, epubId: "测试.epub" });
	check(!empty.ok && empty.reason === "empty-paragraph", "抽到空段 ⇒ **拒绝**（别把占位段材料化成原文）", empty.reason);
	const oob = extractParagraph({ epubPath: mockPath, epub: book, file: "ch1.xhtml", paragraph: 99, epubId: "测试.epub" });
	check(!oob.ok && oob.reason === "paragraph-out-of-range" && oob.paragraphCount === 8, "越界 ⇒ 拒绝并报总数", `${oob.reason} count=${oob.paragraphCount}`);
	const nf = extractParagraph({ epubPath: mockPath, epub: book, file: "nope.xhtml", paragraph: 1, epubId: "测试.epub" });
	check(!nf.ok && nf.reason === "file-not-found", "文件找不到 ⇒ 拒绝", nf.reason);
}

console.log("\n── 8. 确定性（同一 epub + 同一选择器 ⇒ 逐字节同一结果）────────────");
{
	const a = extractParagraph({ epubPath: mockPath, file: "ch1.xhtml", paragraph: 2, epubId: "测试.epub" });
	const b = extractParagraph({ epubPath: mockPath, file: "ch1.xhtml", paragraph: 2, epubId: "测试.epub" });
	check(JSON.stringify(a) === JSON.stringify(b), "跑两次 JSON 逐字节相同");
	const withTag = extractParagraph({ epubPath: mockPath, file: "ch2.xhtml", paragraph: 1, epubId: "测试.epub" });
	const withPath = extractParagraph({ epubPath: mockPath, file: "OEBPS/Text/ch2.xhtml", paragraph: 1, epubId: "测试.epub" });
	check(withTag.file === withPath.file && withTag.srcId === withPath.srcId, "三种 file 写法给出**同一个** srcId、且都唯一", withTag.srcId);
}

console.log("\n── 9b. 「这段看着像什么」的提示（**不拒绝**，只如实报）────────────");
{
	// 人类 2026-09-15 拍板：按段落、别做语义选择器 ⇒ 选到标题/脚注**不拒绝**，但要如实带 warning。
	// mock 里：¶1 = title1（篇名）、¶8 = normaltext（正文）、¶5 = picture（纯图，空）、¶3 = 空段
	check(ps[0].warnings.some((w) => w.includes("标题") && w.includes("title1")), "¶1（class=title1）带「看着是标题」的提示（**含 class 名**）", JSON.stringify(ps[0].warnings));
	check(ps[7].warnings.length === 0, "¶8（class=normaltext）不背提示（别把提示变噪音）", JSON.stringify(ps[7].warnings));
	check(ps[4].warnings.includes("image-dropped"), "¶5（纯图）提示 image-dropped");
	check(!ps[2].warnings.some((w) => w.includes("标题")), "¶3（空段）不会被文字规则误判成标题", JSON.stringify(ps[2].warnings));

	// 书无关的第二刀：**短** 且以章节号/中文数字顿号开头
	const fake = listParagraphs(
		`<body><p class="x1">第二章 勒邦对集团心理的描述</p>` +
			`<p class="x1">第二章 勒邦对集团心理的描述，这一段的描述性内容很长，长到超过四十个字，所以不该被当成标题来提示。</p></body>`,
	);
	check(fake[0].warnings.some((w) => w.includes("标题")), "短 + 「第…章」开头 ⇒ 提示（书无关那一刀）", JSON.stringify(fake[0].warnings));
	check(fake[1].warnings.length === 0, "同一个开头但**长**了 ⇒ 不提示", JSON.stringify(fake[1].warnings));

	// 不拒绝：抽标题段照样给出文本
	const t = extractParagraph({ epubPath: mockPath, epub: book, file: "ch1.xhtml", paragraph: 1, epubId: "测试.epub" });
	check(t.ok && t.warnings.some((w) => w.includes("标题")), "抽标题段**成功返回** + 带提示（选到标题不是错误，是线索）", JSON.stringify(t.warnings));
}

// ── 真 epub（在的话真跑，关键读数写死）──────────────────────────────────
console.log("\n── 9. 真 epub（`/tmp/zhiwo-yubenwo.epub`，在的话真跑）──────────────");
const REAL = process.env.SOPHO_REAL_EPUB ?? "/tmp/zhiwo-yubenwo.epub";
if (!fs.existsSync(REAL)) {
	console.log(`  – 跳过：${REAL} 不在（设 SOPHO_REAL_EPUB 指过去）`);
} else {
	const real = openEpub(REAL);
	check(
		real.sha256 === "sha256:e3f798dbf1a87c175665a4c0f2185d26e9d97729e2b33bbed6af9dd0243516a3",
		"真 epub 的 sha256 与人类给的一致",
		real.sha256.slice(0, 24) + "…",
	);
	check(real.opfPath === "OEBPS/content.opf", "OPF 位置", real.opfPath);
	check(real.files.length === 10, "spine 里 10 份 xhtml", real.files.map((f) => path.posix.basename(f.zipPath)).join(","));

	const counts = {};
	let all = "";
	for (const f of real.files) {
		const list = listParagraphs(real.entries.get(f.zipPath).toString("utf8"));
		counts[path.posix.basename(f.zipPath)] = list.length;
		all += `${f.zipPath}\n${list.map((p) => `${p.index}\t${p.cls}\t${p.text}\t${strippedToString(p.stripped) ?? ""}\n`).join("")}`;
	}
	check(counts["part0004.xhtml"] === 293, "part0004（集体心理学…）有 **293** 个 <p>（与 design-intent 里那个数一致）", JSON.stringify(counts));
	// 这一条是"抽取逻辑整体没漂"的**总指纹**（任何一处改动都会让它变）
	const ALL_SHA = "72f22deac15b5da1d10e24e75dffa82632433ba50484ee45990311841b80cca7";
	check(sha(all) === ALL_SHA, "全部 10 份文件 859 段的「段文本+类名+剥离痕迹」总指纹与写死值一致", `${sha(all).slice(0, 16)}… / ${Buffer.byteLength(all)} B`);

	const p5 = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 5, epubId: "自我与本我.epub" });
	check(p5.ok, "抽 part0004 第 5 段");
	check(p5.cls === "normaltext" && p5.normalizedLength === 579, "第 5 段 = design-intent 里那个「579 字」的段落", `cls=${p5.cls} len=${p5.normalizedLength}`);
	check(
		p5.fingerprint === "sha256:062c51392a5b1015c4a3965cd308d4ae120f4cb4f846179d73e87b87cf184df9",
		"它的内容指纹 = 写死值（抽取逻辑一漂就红）",
		p5.fingerprint.slice(0, 24) + "…",
	);
	check(p5.stripped === "a=2,sup=2", "留痕：这一段剥掉了 2 个 <a> + 2 个 <sup>", p5.stripped);
	check(p5.text.startsWith("处在以上所谈的种种关系——与双亲") && p5.text.includes("许多人对某一个人同时产生的影响"), "文本对得上（首尾都在）");
	check(!p5.text.includes("\n"), "单行");

	const twice = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 5, epubId: "自我与本我.epub" });
	check(JSON.stringify(p5) === JSON.stringify(twice), "同一 epub 同一选择器跑两次 ⇒ 逐字节同一结果");

	const note = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 223, epubId: "自我与本我.epub" });
	check(note.ok && note.warnings.includes("image-dropped"), "第 223 段（脚注里带图）被剥出 warning —— **内容真丢了就不许静默**", note.warnings.join(","));
	const pic = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 127, epubId: "自我与本我.epub" });
	check(!pic.ok && pic.reason === "empty-paragraph", "第 127 段（纯图片页）⇒ 拒绝材料化（它是空的）", pic.reason);
	const oob = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 294, epubId: "自我与本我.epub" });
	check(!oob.ok && oob.paragraphCount === 293, "第 294 段越界 ⇒ 拒绝（总数 293）", oob.reason);

	// 提示（人类拍板：不拒绝，只如实报）
	const p1 = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 1, epubId: "自我与本我.epub" });
	check(p1.ok && p1.warnings.some((w) => w.includes("标题") && w.includes("title1")), "真 epub 的 ¶1（篇名）带「看着是标题」提示", JSON.stringify(p1.warnings));
	const p2 = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 2, epubId: "自我与本我.epub" });
	check(p2.ok && p2.warnings.some((w) => w.includes("标题") && w.includes("subtitle4")), "¶2（第一章标题）也带提示", JSON.stringify(p2.warnings));
	const noteP = extractParagraph({ epubPath: REAL, epub: real, file: "part0004.xhtml", paragraph: 209, epubId: "自我与本我.epub" });
	check(noteP.ok && noteP.warnings.some((w) => w.includes("脚注")), "¶209（注释）带「看着是脚注」提示", JSON.stringify(noteP.warnings));
	check(p5.warnings.length === 0, "¶5（正文）**不背**提示 —— 提示不是噪音", JSON.stringify(p5.warnings));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "✅" : "❌"} epub 抽取器契约：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
