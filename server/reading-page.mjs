/**
 * 阅读页（reading page）：**页面格式 + 写入协议**的纯函数实现。
 *
 * 契约：**这份代码就是阅读页契约的可执行版本**（原先有一份独立的契约文档，未随本快照公开）。
 *
 * 这个文件**只吃文本、吐文本** —— 不读 fs、不碰网络、不知道 epub 在哪。
 * 于是它能被服务端 import，也能被测试直接喂字符串。
 *
 * ── 三条硬性质（协议的全部意义所在）─────────────────────────────────────
 * 1. **绝不错位插入**：插入点不是"第 N 行"，而是"某个原文块之后"。
 *    定位靠**内容**（`<!-- src: <id> sha256:<hex> -->` 标记 + 标记里的哈希复核正文），
 *    所以人在上方增删改**不会**平移插入点；目标块找不到 / 不唯一 / 哈希不符 ⇒ **拒绝**。
 * 2. **写前重读 + 指纹校验**：`plan*` 在读过之后把要改的**那一段字节**的指纹钉进 plan；
 *    `applyPlan` 会**重新解析**当前文本、重算同一段指纹，不符就**拒绝并如实报**（半字节都不写）。
 * 3. **人写的东西只读**：助手只写 (a) 原文块之后的"挂段末"区域里的**自己的块**，
 *    (b) 两个指定字段（`阅读位置` / `论述运动`）里的**指定行**。其余块一律不碰。
 *
 * ── 危险输入一律拒绝，而不是尽力而为 ────────────────────────────────────
 * 页面里只要有任何一个解析错误（未闭合注释 / 嵌套 span / 多行 span 没闭合 / 原文哈希不符 /
 * srcId 重复 / 原文块空正文 / front-matter 未闭合），**所有写操作都拒绝**（`page-has-errors`）。
 * 理由："尽力而为地猜"正是错位插入的来源。
 */

import { createHash } from "node:crypto";

export const PROTOCOL = "reading-page/1";

// ── 指纹 ────────────────────────────────────────────────────────────────

const sha256Hex = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** 整页指纹（只用于报告 / 日志，**不**当写门闸用 —— 见 docs 里的论证）。 */
export function pageFingerprint(text) {
	return `sha256:${sha256Hex(text)}`;
}

/**
 * 指纹函数（协议的一部分，务必与 docs 一致）：
 *   finger(lines, start, end, eol) = "sha256:" + sha256( lines[start..end].join(eol) )
 *   · 闭区间；`start > end` = **空区间** ⇒ sha256(空串)，不是报错；
 *   · **不带**结尾换行（把"多不多一个 \n"排除在指纹之外，免得末行差异把整个校验搅浑）。
 *
 * ⚠️ 页面里**任何**解析错误 ⇒ 所有写入拒绝（`page-has-errors`）。错误清单见各个 `pushError` 调用点。
 */
export function fingerprintLines(lines, start, end, eol = "\n") {
	return `sha256:${sha256Hex(lines.slice(start, end + 1).join(eol))}`;
}

/**
 * 原文正文的规范化 —— 只为了让"从 epub 重抽"与"文件里的副本"能对得上：
 *   NFC → **删掉所有空白字符**。
 * 为什么是"删"而不是"压成一个空格"：折行/缩进会**凭空插入**一个空格（"甲\n乙" → "甲 乙"），
 * 于是同一段字换个折行就过不了校验。删空白让**空白完全不进指纹**。
 * 代价（明确接受）：两段原文只差空格/换行时指纹相同 ⇒ 重建判据会判 no-op（不动文件）。
 * 收益：任何**字符级**的增删改都会让指纹变 —— 那正是我们要抓的（勘误 / 换译本 / 被人手改）。
 */
export function normalizeSourceText(s) {
	return String(s).normalize("NFC").replace(/\s+/g, "");
}

export function sourceFingerprint(s) {
	return `sha256:${sha256Hex(normalizeSourceText(s))}`;
}

// ── 标记 / 识别 ─────────────────────────────────────────────────────────

/**
 * 原文块标记：`<!-- src: <srcId> sha256:<64hex> [k="v"]* -->`（整行）。
 *
 * `sha256:` 后面可以跟任意个 `名字="值"` 属性（机器可判、可审计）。现在只用两个：
 *   · `stripped="a=2,sup=2"` —— 抽取器剥掉了什么行内元素（人类 2026-09-15 拍的：**必须留痕**）；
 *   · 以后要加随便加（未知属性**照原样保留**，见 `replace-source`）。
 */
export const SRC_MARKER_RE = /^<!--\s*src:\s*(\S+)\s+sha256:([0-9a-f]{64})((?:\s+[A-Za-z][-A-Za-z0-9_]*="[^"]*")*)\s*-->\s*$/;

/** 把标记尾巴上的 `k="v"` 串解成对象（顺序无关）。 */
export function parseMarkerAttrs(s) {
	const attrs = {};
	const re = /([A-Za-z][-A-Za-z0-9_]*)="([^"]*)"/g;
	let m;
	while ((m = re.exec(String(s ?? "")))) attrs[m[1]] = m[2];
	return attrs;
}

/** 确定性序列化：按名字排序。空值（`null` / `""`）不写。 */
export function markerAttrsToString(attrs) {
	return Object.keys(attrs ?? {})
		.filter((k) => attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== "")
		.sort()
		.map((k) => ` ${k}="${attrs[k]}"`)
		.join("");
}

/** 助手块的四种 kind（见 skill：追问 / 整理 / 补充资料 / 回顾）。 */
export const ASSISTANT_KINDS = ["助手追问", "助手整理", "补充资料", "回顾"];

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+/;
const QUESTION_RE = /^(Q\d+)\s*[:：]/;
const ANSWER_RE = /^A\s*[:：]/;
const DIVIDER_RE = /^(?:-{3,}|\*{3,}|\_{3,})$/;

/** 旧块没有 `data-kind` 时，从文字前缀反推（保持向后兼容，永不改写旧块）。 */
export function inferKind(body) {
	if (/^助手追问/.test(body)) return "助手追问";
	if (/^助手整理/.test(body)) return "助手整理";
	if (/^补充资料/.test(body)) return "补充资料";
	if (/^(?:讨论后回顾|回顾)/.test(body)) return "回顾";
	return "助手块";
}

function parseSpanAttrs(tag) {
	const attrs = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
	let m;
	while ((m = re.exec(tag))) attrs[m[1]] = m[2];
	return attrs;
}

/**
 * 扫一个"助手 span 块"：必须是**恰好一层** span，且 span 之后没有别的 span。
 * 多行（含空行以外的一切换行）没问题；**嵌套** / **未闭合** / 尾部再挂一个 span ⇒ error。
 */
function scanAssistantSpan(s) {
	const open = s.match(/^<span\b[^>]*>/);
	if (!open) return { error: "assistant-block-does-not-start-with-span" };
	const attrs = parseSpanAttrs(open[0]);
	const re = /<span\b[^>]*>|<\/span\s*>/g;
	let depth = 0;
	let closeAt = -1;
	let closeEnd = -1;
	let m;
	while ((m = re.exec(s))) {
		if (m[0].startsWith("</")) {
			depth--;
			if (depth === 0) {
				closeAt = m.index;
				closeEnd = m.index + m[0].length;
				break;
			}
		} else {
			depth++;
			if (depth > 1) return { error: "nested-span" };
		}
	}
	if (closeAt < 0) return { error: "unterminated-span" };
	if (/<\/?span\b/.test(s.slice(closeEnd))) return { error: "trailing-span" };
	const body = s.slice(open[0].length, closeAt);
	if (/<span\b|<\/span\s*>/.test(body)) return { error: "nested-span" };
	return {
		author: attrs["data-author"] ?? null,
		kind: attrs["data-kind"] ?? inferKind(body),
		id: attrs["data-id"] ?? null,
		body,
	};
}

/** 字段的定位键（助手只认这两个；其余标题即使带列表也**不可写**）。 */
export function fieldKey(headingText) {
	const t = headingText.trim();
	if (t === "阅读位置" || t.endsWith("阅读位置")) return "阅读位置";
	if (t.endsWith("论述运动")) return "论述运动";
	return null;
}

/** 助手**允许**写正文的字段键；`选书记录` 等一律只读。 */
export const WRITABLE_FIELDS = ["阅读位置", "论述运动"];

// ── 解析 ────────────────────────────────────────────────────────────────

/** 从 `from` 起（跳过空行）解析一个 bullet list；不是 list 就返回 null。 */
function parseBulletList(lines, from) {
	let i = from;
	while (i < lines.length && lines[i].trim() === "") i++;
	if (i >= lines.length || !BULLET_RE.test(lines[i])) return null;
	let start = i;
	let end = i;
	while (i < lines.length) {
		const l = lines[i];
		if (l.trim() === "") {
			i++;
			continue;
		}
		if (BULLET_RE.test(l) || /^\s+\S/.test(l)) {
			end = i;
			i++;
			continue;
		}
		break;
	}
	return { start, end };
}

function pushError(errors, code, line, extra = {}) {
	errors.push({ code, line, ...extra });
}

/**
 * 把整页切成块。行区间一律是 **0 基、闭区间**。
 * 返回 `{ eol, lines, blocks, errors }` —— `lines` 就是 `text` 按 `eol` 切出来的（可无损回拼）。
 */
export function parsePage(text) {
	const eol = /\r\n/.test(text) ? "\r\n" : "\n";
	const lines = text.split(/\r\n|\n/);
	const errors = [];
	const blocks = [];
	const add = (b) => {
		blocks.push(b);
		return b;
	};
	const seenSrc = new Set();

	let i = 0;

	// front-matter（允许 UTF-8 BOM —— 这份笔记在 Windows 上被编辑，别在 BOM 上翻车）
	if (lines[0].replace(/^\uFEFF/, "") === "---") {
		let j = 1;
		while (j < lines.length && lines[j] !== "---") j++;
		if (j < lines.length) {
			add({ kind: "frontmatter", start: 0, end: j });
			i = j + 1;
		} else {
			pushError(errors, "unterminated-frontmatter", 0);
			i = lines.length;
		}
	}

	while (i < lines.length) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}
		const line = lines[i];

		// ── 原文块：标记行 + 紧邻（不留空行）的正文 ──
		const sm = line.match(SRC_MARKER_RE);
		if (sm) {
			let j = i + 1;
			while (j < lines.length && lines[j].trim() !== "") j++;
			const bodyStart = i + 1;
			const bodyEnd = j - 1;
			const srcId = sm[1];
			const blk = add({
				kind: "source",
				start: i,
				end: j - 1,
				markerLine: i,
				bodyStart,
				bodyEnd,
				srcId,
				storedHash: `sha256:${sm[2]}`,
				markerAttrs: parseMarkerAttrs(sm[3]),
			});
			if (bodyEnd < bodyStart) {
				pushError(errors, "empty-source-body", i, { srcId });
			} else {
				blk.textFingerprint = sourceFingerprint(lines.slice(bodyStart, bodyEnd + 1).join(eol));
				if (blk.textFingerprint !== blk.storedHash) {
					pushError(errors, "source-hash-mismatch", i, {
						srcId,
						storedHash: blk.storedHash,
						actualHash: blk.textFingerprint,
					});
				}
			}
			if (seenSrc.has(srcId)) pushError(errors, "duplicate-source-id", i, { srcId });
			seenSrc.add(srcId);
			i = j;
			continue;
		}

		// ── HTML 注释（可跨行；src 标记已在上面拦掉）──
		if (line.startsWith("<!--")) {
			let j = i;
			if (!line.includes("-->")) {
				j = i + 1;
				while (j < lines.length && !lines[j].includes("-->")) j++;
				if (j >= lines.length) {
					pushError(errors, "unterminated-comment", i);
					j = lines.length - 1;
				}
			}
			add({ kind: "comment", start: i, end: j });
			// 一个漏了 `-->` 的 `<!--` 会**吞掉**后面的原文标记（注释一直吃到下一个 `-->`）——
			// 那时原文块根本没被解析出来，而页面看上去"没坏"。这条专门堵这个洞。
			for (let k = i; k <= j; k++) {
				if (SRC_MARKER_RE.test(lines[k])) pushError(errors, "src-marker-inside-comment", k);
			}
			i = j + 1;
			continue;
		}

		// ── 分隔线 ──
		if (DIVIDER_RE.test(line.trim())) {
			add({ kind: "divider", start: i, end: i });
			i++;
			continue;
		}

		// ── 标题；后面紧跟 bullet list 的话，整块算一个「字段」 ──
		const hm = line.match(HEADING_RE);
		if (hm) {
			const level = hm[1].length;
			const text = hm[2];
			const body = parseBulletList(lines, i + 1);
			const key = fieldKey(text);
			if (body) {
				add({
					kind: "field",
					name: text,
					fieldKey: key,
					level,
					start: i,
					end: body.end,
					headingLine: i,
					bodyStart: body.start,
					bodyEnd: body.end,
					writable: key !== null && WRITABLE_FIELDS.includes(key),
				});
				i = body.end + 1;
			} else {
				add({ kind: "heading", level, text, fieldKey: key, start: i, end: i });
				i++;
			}
			continue;
		}

		// ── 助手 span 块 ──
		if (/^<span\b/.test(line)) {
			let j = i;
			while (j + 1 < lines.length && lines[j + 1].trim() !== "") j++;
			const raw = lines.slice(i, j + 1).join(eol);
			const scanned = scanAssistantSpan(raw);
			if (scanned.error) {
				pushError(errors, scanned.error, i);
				add({ kind: "assistant", start: i, end: j, malformed: true, body: raw });
			} else {
				add({
					kind: "assistant",
					start: i,
					end: j,
					author: scanned.author,
					dataKind: scanned.kind,
					dataId: scanned.id,
					body: scanned.body,
				});
			}
			i = j + 1;
			continue;
		}

		// ── 问题 / 答案 / 读者内容（读者内容**没有标记**，靠"不是别的东西"识别）──
		const groupEnd = (from) => {
			let j = from;
			while (j + 1 < lines.length && lines[j + 1].trim() !== "") j++;
			return j;
		};
		const qm = line.match(QUESTION_RE);
		if (qm) {
			const j = groupEnd(i);
			add({ kind: "question", label: qm[1], start: i, end: j });
			i = j + 1;
			continue;
		}
		if (ANSWER_RE.test(line)) {
			const j = groupEnd(i);
			add({ kind: "answer", start: i, end: j });
			i = j + 1;
			continue;
		}
		const jr = groupEnd(i);
		add({ kind: "reader", start: i, end: jr });
		i = jr + 1;
	}

	return { text, eol, lines, blocks, errors, protocol: PROTOCOL };
}

/** 源块的幂等键：**由 srcId 派生**（`src-<sha256(srcId)[0:16]>`）。
 *
 * ⚠️ 它**不是**第二个真相：判定一律按 **`srcId`**（那才是身份），这个 id 只是写在标记里的"账面幂等键"，
 * 让源块与助手块在账上长得一样（UI / 审计都能直接读）。两者不一致时**不静默** ——
 * `listSources()` 会报 `idConsistent: false`（但**不**把它当页级错误，否则页面会被一个手改的 id brick 死）。
 */
export function sourceIdForKey(srcId) {
	return `src-${sha256Hex(String(srcId)).slice(0, 16)}`;
}

/**
 * `materialize-source` 的**三种情形**（写死在这里，调用方不要再判一遍）：
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 1. 同 `srcId` 已存在、**正文指纹一致** | `{op:"already-present"}` —— **不写**（`attrsDiffer` 只作提示） |
 * | 2. 同 `srcId` 已存在、**正文不同** | `{op:"refuse", reason:"source-exists-different"}` —— **拒绝并指路** `rebuild-source`；**绝不覆盖、也绝不许插第二份** |
 * | 3. 不存在 | `{op:"insert", plan}` —— 照常插入（带 `attrs.id = sourceIdForKey(srcId)`） |
 *
 * 为什么情形 2 选"拒绝"而不是自动 `replace-source`：materialize 是**追加**语义（和 §4.1 那句
 * "只追加、从不改写已存在的块"一致）；改写已存在的正文是另一个爆炸半径，得让调用方**显式**叫
 * `rebuild-source`（那个 op 有自己的哈希 + 区域指纹双门）。
 */
export function planMaterializeSource(doc, { srcId, text, attrs, section }) {
	const dup = doc.blocks.filter((b) => b.kind === "source" && b.srcId === srcId);
	if (dup.length > 1) {
		return {
			op: "refuse",
			reason: "source-id-duplicated",
			status: 409,
			detail: {
				srcId,
				ranges: dup.map((b) => [b.markerLine, b.bodyEnd]),
				hint: "页面里已经有 ≥2 份这个 srcId —— 这是页面级错误，先手工清成一份",
			},
		};
	}

	const id = sourceIdForKey(srcId);
	const wanted = { ...(attrs ?? {}), id };

	if (dup.length === 1) {
		// ⚠️ "已存在"的两个分支必须在 `doc.errors` 检查**之前**：
		// 正文被人手改过时，页面正好会报 `source-hash-mismatch` —— 而那种情形恰恰要给
		// `source-exists-different`（指路 rebuild），不是一个笼统的 `page-has-errors`。
		// （这两个分支本来就不写字节，所以"页面有错就别写"对它们不适用。）
		const s = dup[0];
		const fresh = sourceFingerprint(text);
		if (fresh === s.textFingerprint) {
			const keys = new Set([...Object.keys(s.markerAttrs ?? {}), ...Object.keys(wanted)]);
			const attrsDiffer = [...keys].filter((k) => (s.markerAttrs?.[k] ?? null) !== (wanted[k] ?? null)).sort();
			return {
				op: "already-present",
				srcId,
				id,
				attrsDiffer,
				detail: {
					srcId,
					range: [s.markerLine, s.bodyEnd],
					textFingerprint: s.textFingerprint,
					storedHash: s.storedHash,
					attrsDiffer,
				},
			};
		}
		return {
			op: "refuse",
			reason: "source-exists-different",
			status: 409,
			detail: {
				srcId,
				existing: { range: [s.markerLine, s.bodyEnd], textFingerprint: s.textFingerprint, storedHash: s.storedHash, consistent: s.storedHash === s.textFingerprint },
				fresh: { fingerprint: fresh },
				hint: '这一块已经在页面里、但正文与重抽结果不同 —— materialize-source 永不覆盖。要重建它请用 op:"rebuild-source"（它有哈希 + 区域指纹双门）',
			},
		};
	}

	// 到这一步就是"不存在 ⇒ 要插"了 —— 这时页面必须干净（插入会重排行号）。
	if (doc.errors.length) return { op: "refuse", reason: "page-has-errors", status: 409, detail: { errors: doc.errors } };

	const plan = planInsertBlock(doc, { section, block: { kind: "原文", srcId, text, attrs: wanted } });
	if (!plan.ok) return { op: "refuse", reason: plan.reason, status: 409, detail: plan };
	return { op: "insert", plan, srcId, id };
}

/** 人能写的块的 kind（**读者自己按一下**时才走这条路；助手的路是 `insert-block` / `field-*`）。
 *  [0m
 *  只允许 `answer`（`A:`）与 `reader`（笔记 / 读者段落）—— 原文 / 问题 / 助手块 / 字段都不能从这里改，
 *  否则"按一下"就变成了一个能改写一切的通道。 */
export const READER_WRITABLE_KINDS = ["answer", "reader"];

/**
 * **读者写的字**：把一个已经存在的块（`A:` 或读者段落）换成新文本。
 *
 * 为什么不能用 `insert-block`：`renderBlock` 对 `笔记`/`答案`/`读者内容` **直接抛**（S1 就把这条闸钉死了）——
 * 助手不替人写笔记。但读者自己打字必须能落盘，于是单开这一个 op：它只改**已存在**的人写块，
 * 靠 `range` + `fingerprint` 双重确认（`range` 说"哪一块"，指纹说"你读到的就是它"）。
 *
 * 幂等：新文本与当前文本**逐字一致** ⇒ `no-op`（**先比内容、再看指纹** —— 这样"按一下就发送"
 * 连点两次不会变成 409 冲突，而是一个干净的空操作，于是也不会重复投递）。
 */
export function planReplaceBlockText(doc, { range, text, expectedFingerprint, keepPrefix = false }) {
	if (doc.errors.length) return { ok: false, reason: "page-has-errors", errors: doc.errors };
	if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
		return { ok: false, reason: "bad-range", range };
	}
	const [s, e] = range;
	const blk = doc.blocks.find((b) => b.start === s && b.end === e);
	if (!blk) return { ok: false, reason: "block-not-found", range };
	if (!READER_WRITABLE_KINDS.includes(blk.kind)) {
		return { ok: false, reason: "not-reader-writable", kind: blk.kind, range, hint: "这个 op 只能改「答案」与「读者段落」—— 原文 / 问题 / 助手块 / 字段不走这里" };
	}
	const body = String(text ?? "");
	// 段内不许有空行：那会把一个块**劈成两个**，而这里的模型是"一块 = 一个行区间"。
	if (/\n[ \t]*\n/.test(body)) return { ok: false, reason: "blank-line-in-block", hint: "一个块里不许出现空行（那会把一块劈成两块）—— 想分段就另开一个笔记块" };

	let newLines;
	if (keepPrefix) {
		const m = /^(A\s*[:：])\s*/.exec(doc.lines[s] ?? "");
		const prefix = m ? m[1] : "A:";
		newLines = body.trim() === "" ? [prefix] : `${prefix} ${body}`.split("\n");
	} else {
		newLines = body.split("\n");
	}

	const cur = doc.lines.slice(s, e + 1).join(doc.eol);
	const fp = fingerprintLines(doc.lines, s, e, doc.eol);
	const want = newLines.join(doc.eol);
	// ① 幂等前置：已经就是这一份 ⇒ 不写（连点两次 = 干净的空操作）
	if (cur === want) return { op: "no-op", range, kind: blk.kind, fingerprint: fp, detail: "要写的就是现在这一份" };
	// ② 写前校验：你读到的得还是这一块
	if (expectedFingerprint !== undefined && fp !== expectedFingerprint) {
		return { ok: false, reason: "conflict", detail: "这一块在你读之后变过", expected: expectedFingerprint, actual: fp, range };
	}
	return {
		ok: true,
		op: "replace-block-text",
		protocol: PROTOCOL,
		range: [s, e],
		kind: blk.kind,
		before: { range: [s, e], fingerprint: fp },
		newLines,
	};
}

/**
 * 给前端用的**块列表**（`GET /pages` 报出去）。只报渲染与寻址需要的东西：
 *   `{kind, range, fingerprint, text, …}` —— `text` 是**人读的那段字**（原文块不带标记行、助手块只给 span 里的正文）。
 * 前端一律 `textContent` 渲染（**不用 innerHTML**）⇒ 页面里就算有 HTML 也只会当字显示。
 */
export function listBlocks(doc) {
	return doc.blocks
		.filter((b) => b.kind !== "frontmatter")
		.map((b) => {
			const raw = doc.lines.slice(b.start, b.end + 1).join(doc.eol);
			const item = { kind: b.kind, range: [b.start, b.end], fingerprint: fingerprintLines(doc.lines, b.start, b.end, doc.eol), raw };
			if (b.kind === "source") Object.assign(item, { srcId: b.srcId, markerAttrs: b.markerAttrs ?? {}, text: doc.lines.slice(b.bodyStart, b.bodyEnd + 1).join(doc.eol) });
			else if (b.kind === "assistant") Object.assign(item, { dataKind: b.dataKind ?? null, dataId: b.dataId ?? null, text: b.body ?? "", malformed: !!b.malformed });
			else if (b.kind === "field") Object.assign(item, { name: b.name, level: b.level, writable: !!b.writable, bodyRange: [b.bodyStart, b.bodyEnd], text: doc.lines.slice(b.bodyStart, b.bodyEnd + 1).join(doc.eol) });
			else if (b.kind === "heading") Object.assign(item, { level: b.level, text: b.text, fieldName: b.fieldKey ?? null });
			else if (b.kind === "question") Object.assign(item, { label: b.label, text: raw });
			else Object.assign(item, { text: raw });
			return item;
		});
}

/** 页面里所有原文块（`GET` 要把它们报出去：srcId / 标记属性 / 两个指纹 / 行区间）。 */
export function listSources(doc) {
	return doc.blocks
		.filter((b) => b.kind === "source")
		.map((b) => ({
			srcId: b.srcId,
			markerAttrs: b.markerAttrs ?? {},
			id: b.markerAttrs?.id ?? null,
			// null = 那块没写 id（S2.1 之前的块）；不一致不静默，但也不当页级错误
			idConsistent: b.markerAttrs?.id == null ? null : b.markerAttrs.id === sourceIdForKey(b.srcId),
			storedHash: b.storedHash,
			textFingerprint: b.textFingerprint ?? null,
			selfConsistent: b.storedHash === b.textFingerprint,
			range: [b.markerLine, b.bodyEnd],
		}));
}

/** 只想看结构对不对时用（报告 / 断言用），不参与写协议。 */
export function describePage(doc) {
	return doc.blocks.map((b) => ({
		kind: b.kind,
		label:
			b.kind === "source"
				? b.srcId
				: b.kind === "field" || b.kind === "heading"
					? (b.name ?? b.text)
					: b.kind === "question"
						? b.label
						: (b.dataKind ?? null),
		range: [b.start, b.end],
	}));
}

/** 人写的东西的行区间（`答案` + `读者内容`）—— 用来证明"一字未动"。 */
export function humanOwnedRanges(doc) {
	return doc.blocks
		.filter((b) => b.kind === "answer" || b.kind === "reader")
		.map((b) => ({ kind: b.kind, range: [b.start, b.end], text: doc.lines.slice(b.start, b.end + 1).join(doc.eol) }));
}

// ── 字段 ────────────────────────────────────────────────────────────────

/** 字段地址：`{ section, heading }`；`section` = 最近的 level-≤2 祖先标题（顶层为 null）。 */
export function fieldAddress(doc, f) {
	if (f.level <= 2) return { section: null, heading: f.name };
	let section = null;
	for (const b of doc.blocks) {
		if (b.start >= f.start) break;
		if ((b.kind === "heading" || b.kind === "field") && b.level === 2) section = b.kind === "field" ? b.name : b.text;
	}
	return { section, heading: f.name };
}

export function listFields(doc) {
	return doc.blocks
		.filter((b) => b.kind === "field")
		.map((f) => ({
			...fieldAddress(doc, f),
			key: f.fieldKey ?? null,
			writable: !!f.writable,
			range: [f.bodyStart, f.bodyEnd],
			// 指纹必须报出来：调用方（UI）拿它当 `expectedFingerprint` 回传，
			// 否则**写前校验就等于没有**（传 undefined = 不校验）。
			fingerprint: fingerprintLines(doc.lines, f.bodyStart, f.bodyEnd, doc.eol),
		}));
}

function findField(doc, address) {
	const want = (f) => {
		const a = fieldAddress(doc, f);
		if (a.heading !== address.heading) return false;
		if (address.section !== undefined && a.section !== address.section) return false;
		return true;
	};
	return doc.blocks.filter((b) => b.kind === "field" && want(b));
}

/** 读一个字段的正文（bullet list）。 */
export function readField(doc, address) {
	const found = findField(doc, address);
	if (found.length === 0) return { ok: false, reason: "field-not-found", address, known: listFields(doc) };
	if (found.length > 1) return { ok: false, reason: "field-ambiguous", address };
	const f = found[0];
	return {
		ok: true,
		address: fieldAddress(doc, f),
		writable: !!f.writable,
		range: [f.bodyStart, f.bodyEnd],
		lines: doc.lines.slice(f.bodyStart, f.bodyEnd + 1),
		fingerprint: fingerprintLines(doc.lines, f.bodyStart, f.bodyEnd, doc.eol),
	};
}

// ── 锚点 ────────────────────────────────────────────────────────────────

/** 挂段末：原文块**之后**、直到下一个结构边界（标题 / 注释 / 原文 / 字段 / 分隔线）之前。 */
function attachedRegion(doc, sourceBlock) {
	let end = sourceBlock.end;
	for (const b of doc.blocks) {
		if (b.start <= sourceBlock.end) continue;
		if (
			b.kind === "field" ||
			b.kind === "heading" ||
			b.kind === "comment" ||
			b.kind === "source" ||
			b.kind === "frontmatter" ||
			b.kind === "divider"
		) {
			break;
		}
		end = b.end;
	}
	return { start: sourceBlock.end + 1, end };
}

/** 追加到某个标题节的末尾（节尾 = 下一个 level ≤ 它的标题之前）。材料化原文 / 开新单元用。 */
function sectionTail(doc, { level, heading }) {
	const hits = doc.blocks.filter(
		(b) => (b.kind === "heading" || b.kind === "field") && b.level === level && (b.kind === "field" ? b.name : b.text) === heading,
	);
	if (hits.length === 0) return { error: "anchor-not-found" };
	if (hits.length > 1) return { error: "anchor-ambiguous" };
	const h = hits[0];
	let last = null;
	for (const b of doc.blocks) {
		if (b.start <= h.end) continue;
		if ((b.kind === "heading" || b.kind === "field") && (b.level ?? 99) <= level) break;
		last = b;
	}
	if (!last) return { error: "section-empty" };
	return { last, insertAt: last.end + 1 };
}

/**
 * 解析一个插入锚点。两种：
 *   `{ sourceId }`              —— 挂在某个原文块的段末（**主用法**）
 *   `{ section:{level,heading} }` —— 追加到某个标题节的末尾
 * 返回 `{ error }` 就是"拒绝"（找不到 / 不唯一 / 原文哈希不符 / 节是空的）。
 */
export function resolveAnchor(doc, anchor) {
	if (anchor && anchor.sourceId !== undefined) {
		const srcs = doc.blocks.filter((b) => b.kind === "source" && b.srcId === anchor.sourceId);
		if (srcs.length === 0) return { error: "anchor-not-found", anchor };
		if (srcs.length > 1) return { error: "anchor-ambiguous", anchor };
		const s = srcs[0];
		if (s.storedHash !== s.textFingerprint) {
			return { error: "source-hash-mismatch", anchor, storedHash: s.storedHash, actualHash: s.textFingerprint };
		}
		const region = attachedRegion(doc, s);
		return {
			anchor,
			kind: "after-source",
			srcId: s.srcId,
			sourceBlock: s,
			region,
			insertAt: region.end + 1,
			sourceTextFingerprint: s.textFingerprint,
		};
	}
	// ⚠️ 顺序要紧：`{question, section}` 是"某单元里的某道题"，**不是** `{section:{level,heading}}`
	// （那个 section 是对象）。所以 question 这一支必须排在 section 分支**前面**，
	// 否则"带 section 的题锚点"会掉进节末分支、报一个莫名其妙的 anchor-not-found。
	if (anchor && anchor.question !== undefined) {
		// **挂在某道题之后**：区域 = 那道题 + 紧跟它的「答案 / 助手块 / 读者段落」，直到下一个问题或结构边界。
		// 于是"给 Q2 补一条追问/整理"落在 Q2 的答卷之后、Q3 之前 —— 与文件里既有的排布一致。
		const want = String(anchor.question).trim();
		// 同一个页面里每个学习单元都有自己的 Q1/Q2/Q3 ⇒ **同名很正常**。
		// 所以要么给 `section`（哪个 `##` 单元），要么就必须唯一 —— 歧义时**拒绝**并把人名报回去，
		// 绝不"猜第一个"（猜错的后果是把一条追问插到另一个单元的答卷后面）。
		const inSection = (b) => {
			if (!anchor.section) return true;
			let sec = null;
			for (const x of doc.blocks) {
				if (x.start >= b.start) break;
				if ((x.kind === "heading" || x.kind === "field") && x.level === 2) sec = x.kind === "field" ? x.name : x.text;
			}
			return sec === anchor.section;
		};
		const all = doc.blocks.filter((b) => b.kind === "question" && (b.label === want || `${b.label}:` === want));
		const qs = all.filter(inSection);
		if (qs.length === 0) {
			return {
				error: "anchor-not-found",
				anchor,
				known: all.map((b) => ({ label: b.label, section: (() => { let sec = null; for (const x of doc.blocks) { if (x.start >= b.start) break; if ((x.kind === "heading" || x.kind === "field") && x.level === 2) sec = x.kind === "field" ? x.name : x.text; } return sec; })() })),
			};
		}
		if (qs.length > 1) {
			return {
				error: "anchor-ambiguous",
				anchor,
				hint: "这一页有多个单元，每个单元都有同名的题 —— 请带 `section`（那个 `##` 单元的标题）再调一次",
				matches: qs.map((b) => b.start),
			};
		}
		const q = qs[0];
		let end = q.end;
		for (const b of doc.blocks) {
			if (b.start <= q.end) continue;
			if (b.kind === "answer" || b.kind === "assistant" || b.kind === "reader") {
				end = b.end;
				continue;
			}
			break; // 问题 / 标题 / 字段 / 注释 / 原文 / 分隔线 ⇒ 到界
		}
		return { anchor, kind: "after-question", label: q.label, region: { start: q.start, end }, insertAt: end + 1 };
	}
	if (anchor && anchor.section) {
		const t = sectionTail(doc, anchor.section);
		if (t.error) return { error: t.error, anchor };
		return { anchor, kind: "section-end", region: { start: t.last.start, end: t.last.end }, insertAt: t.insertAt };
	}
	return { error: "anchor-unknown", anchor };
}

export const fingerprintRange = (doc, region) => fingerprintLines(doc.lines, region.start, region.end, doc.eol);

// ── 渲染新块 ────────────────────────────────────────────────────────────

/**
 * 把 `{kind, text, id, srcId}` 渲染成要写进文件的**块文本**（可能多行，行分隔符一律 `\n`）。
 * kind 的取值就是页面格式里的块类型名（中文），见 docs。
 */
export function renderBlock(block) {
	const kind = block.kind;
	const text = block.text ?? "";
	if (ASSISTANT_KINDS.includes(kind)) {
		if (/<span\b|<\/span\s*>/.test(text)) throw new Error("助手块的正文里不许出现 span 标签（会把块边界搅坏）");
		if (text.includes("\n")) throw new Error("助手块正文必须是单行（协议要求）");
		const attrs = ["data-author=\"assistant\"", `data-kind="${kind}"`];
		if (block.id) attrs.push(`data-id="${block.id}"`);
		attrs.push('style="color: #2563eb;"');
		return `<span ${attrs.join(" ")}>${text}</span>`;
	}
	if (kind === "原文") {
		if (!block.srcId) throw new Error("原文块必须给 srcId");
		if (/\n/.test(text)) throw new Error("原文块正文必须是单行（换行差异由规范化吃掉，但不许写进来）");
		return `<!-- src: ${block.srcId} ${sourceFingerprint(text)}${markerAttrsToString(block.attrs)} -->\n${text}`;
	}
	if (kind === "问题") return `${text}\n\nA:`;
	if (kind === "笔记" || kind === "答案" || kind === "读者内容") {
		// 不是技术做不到，是**不许**："人写的区域"助手一字不写（skill：Keep the reader's unmarked Markdown intact）。
		throw new Error(`助手不许插入「${kind}」块 —— 那个区域是人的`);
	}
	throw new Error(`未知块类型：${kind}`);
}

const renderBlockLines = (block) => renderBlock(block).split("\n");

// ── 计划（纯粹数据，可序列化；apply 时重读再校验）────────────────────────

function planInsert(doc, { anchor, block }) {
	if (doc.errors.length) return { ok: false, reason: "page-has-errors", errors: doc.errors };
	if (block.id) {
		const dup = doc.blocks.filter((b) => b.kind === "assistant" && b.dataId === block.id);
		if (dup.length) return { ok: false, reason: "already-present", id: block.id, range: [dup[0].start, dup[0].end] };
	}
	const a = resolveAnchor(doc, anchor);
	if (a.error) return { ok: false, reason: a.error, anchor };
	return {
		ok: true,
		op: "insert-block",
		protocol: PROTOCOL,
		anchor,
		block,
		rendered: renderBlock(block),
		expect: {
			anchorKind: a.kind,
			srcId: a.srcId ?? null,
			sourceTextFingerprint: a.sourceTextFingerprint ?? null,
			regionRange: [a.region.start, a.region.end],
			regionFingerprint: fingerprintRange(doc, a.region),
			insertAtLine: a.insertAt,
		},
	};
}

/** 挂段末插入一个块（主用法：`{sourceId}`）；也可以 `{section}`（追加到节末）或 `{question}`（挂在某道题之后）。 */
export function planInsertBlock(doc, { sourceId, section, question, block }) {
	const anchor = sourceId !== undefined ? { sourceId } : question !== undefined ? { question, section: section?.heading } : { section };
	return planInsert(doc, { anchor, block });
}

/** ② 换掉一个**指定字段的整段正文**（`阅读位置` / `论述运动`）。 */
export function planFieldReplace(doc, address, newLines, expectedFingerprint) {
	if (doc.errors.length) return { ok: false, reason: "page-has-errors", errors: doc.errors };
	const r = readField(doc, address);
	if (!r.ok) return r;
	if (!r.writable) return { ok: false, reason: "field-not-writable", address: r.address };
	if (expectedFingerprint !== undefined && r.fingerprint !== expectedFingerprint) {
		return { ok: false, reason: "conflict", detail: "字段正文与你读到的不是同一份", expected: expectedFingerprint, actual: r.fingerprint };
	}
	return {
		ok: true,
		op: "replace-lines",
		protocol: PROTOCOL,
		mode: "body",
		address: r.address,
		before: { range: r.range, fingerprint: r.fingerprint },
		newLines: [...newLines],
	};
}

/**
 * ③ 只换**指定字段里的某一行**（按 `match` 前缀唯一匹配）—— 帮手少写、爆炸半径最小。
 * `match` 必须在该字段正文里**恰好命中一行**，否则拒绝（0 → `line-not-found`，>1 → `line-ambiguous`）。
 */
export function planFieldLineReplace(doc, address, match, newLine, expectedFingerprint) {
	if (doc.errors.length) return { ok: false, reason: "page-has-errors", errors: doc.errors };
	const r = readField(doc, address);
	if (!r.ok) return r;
	if (!r.writable) return { ok: false, reason: "field-not-writable", address: r.address };
	const hits = r.lines.map((l, k) => (l.startsWith(match) ? r.range[0] + k : -1)).filter((k) => k >= 0);
	if (hits.length === 0) return { ok: false, reason: "line-not-found", address: r.address, match };
	if (hits.length > 1) return { ok: false, reason: "line-ambiguous", address: r.address, match, lines: hits };
	if (expectedFingerprint !== undefined && r.fingerprint !== expectedFingerprint) {
		return { ok: false, reason: "conflict", detail: "字段正文与你读到的不是同一份", expected: expectedFingerprint, actual: r.fingerprint };
	}
	return {
		ok: true,
		op: "replace-lines",
		protocol: PROTOCOL,
		mode: "line",
		address: r.address,
		match,
		before: { range: r.range, fingerprint: r.fingerprint },
		newLine,
	};
}

/**
 * ④ 原文块的**确定性重建**：给定"从 epub 重抽出来的那段文字"，决定要不要动文件。
 * 判据（见 docs）：重抽 → `normalizeSourceText` → `sourceFingerprint`；
 *   · 与标记里的哈希一致 ⇒ `no-op`（文件里那份就是重抽结果，**不写**）；
 *   · 不一致 ⇒ 产出一个 `replace-source` 计划（整块替换正文并更新标记哈希）—— 但仍要过指纹门。
 */
export function planSourceRebuild(doc, { srcId, text, attrs }) {
	// ⚠️ **例外**：这个 op 就是为了修一个"正文被人改过"的块 —— 它自己那一块的
	// `source-hash-mismatch` 不能把修复路堵死（其余任何解析错误照旧一律拒绝）。
	const fatal = doc.errors.filter((e) => !(e.code === "source-hash-mismatch" && e.srcId === srcId));
	if (fatal.length) return { ok: false, reason: "page-has-errors", errors: fatal };
	const srcs = doc.blocks.filter((b) => b.kind === "source" && b.srcId === srcId);
	if (srcs.length === 0) return { ok: false, reason: "anchor-not-found", srcId };
	if (srcs.length > 1) return { ok: false, reason: "anchor-ambiguous", srcId };
	const s = srcs[0];
	const fresh = sourceFingerprint(text);
	// 标记属性：**保留**现有的，再套上这次的 patch（patch 里值为 null ⇒ 删掉那个键）。
	const merged = { ...(s.markerAttrs ?? {}) };
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === null || v === undefined || v === "") delete merged[k];
		else merged[k] = v;
	}
	const attrsChanged = markerAttrsToString(merged) !== markerAttrsToString(s.markerAttrs ?? {});
	if (fresh === s.textFingerprint && fresh === s.storedHash && !attrsChanged) {
		return { ok: true, op: "no-op", srcId, fingerprint: fresh, markerAttrs: merged };
	}
	return {
		ok: true,
		op: "replace-source",
		protocol: PROTOCOL,
		srcId,
		text,
		attrs: merged,
		before: { range: [s.bodyStart, s.bodyEnd], fingerprint: s.textFingerprint, storedHash: s.storedHash },
		expect: { regionRange: [s.markerLine, s.bodyEnd], regionFingerprint: fingerprintLines(doc.lines, s.markerLine, s.bodyEnd, doc.eol) },
	};
}

// ── 执行（重读 → 校验 → 拼接；任何不符 ⇒ 拒绝）─────────────────────────

const spliceLines = (lines, at, ins) => [...lines.slice(0, at), ...ins, ...lines.slice(at)];

function withSeparation(lines, at, ins) {
	const out = [];
	if (at > 0 && lines[at - 1] !== undefined && lines[at - 1].trim() !== "") out.push("");
	out.push(...ins);
	if (at < lines.length && lines[at].trim() !== "") out.push("");
	return out;
}

/**
 * 把 plan 落到 `text` 上。**纯函数**：不写盘。
 * 内部会重新 `parsePage(text)` —— 这就是"写前重读"；任何指纹不符 ⇒ `{ok:false, reason:"conflict"}`。
 * 调用方拿到 `{ok:true, text}` 之后应该**原子写盘**（临时文件 + rename）。
 */
export function applyPlan(text, plan) {
	if (!plan || plan.protocol !== PROTOCOL) return { ok: false, reason: "plan-protocol-mismatch" };
	const doc = parsePage(text);
	// 同样给 `replace-source` 开那个口子（只免它自己那块）；其余 op 一律零容忍。
	const fatal = doc.errors.filter((e) => !(plan.op === "replace-source" && e.code === "source-hash-mismatch" && e.srcId === plan.srcId));
	if (fatal.length) return { ok: false, reason: "page-has-errors", errors: fatal };

	if (plan.op === "insert-block") {
		if (plan.block.id) {
			const dup = doc.blocks.filter((b) => b.kind === "assistant" && b.dataId === plan.block.id);
			if (dup.length) return { ok: false, reason: "already-present", id: plan.block.id, range: [dup[0].start, dup[0].end] };
		}
		const a = resolveAnchor(doc, plan.anchor);
		if (a.error) return { ok: false, reason: a.error, anchor: plan.anchor };
		if (plan.expect.sourceTextFingerprint && a.sourceTextFingerprint !== plan.expect.sourceTextFingerprint) {
			return { ok: false, reason: "conflict", detail: "锚点原文块的内容变了", expected: plan.expect.sourceTextFingerprint, actual: a.sourceTextFingerprint };
		}
		const fp = fingerprintRange(doc, a.region);
		if (fp !== plan.expect.regionFingerprint) {
			return {
				ok: false,
				reason: "conflict",
				detail: "锚点后面的区域被改过（你之外还有写者）—— 拒绝，绝不覆盖",
				expected: plan.expect.regionFingerprint,
				actual: fp,
			};
		}
		const ins = withSeparation(doc.lines, a.insertAt, renderBlockLines(plan.block));
		return { ok: true, op: plan.op, text: spliceLines(doc.lines, a.insertAt, ins).join(doc.eol), insertAtLine: a.insertAt };
	}

	if (plan.op === "replace-lines") {
		const r = readField(doc, plan.address);
		if (!r.ok) return r;
		if (r.fingerprint !== plan.before.fingerprint) {
			return {
				ok: false,
				reason: "conflict",
				detail: "字段正文与你读到的不是同一份 —— 拒绝，绝不覆盖",
				expected: plan.before.fingerprint,
				actual: r.fingerprint,
			};
		}
		if (plan.mode === "body") {
			const [s, e] = r.range;
			return {
				ok: true,
				op: plan.op,
				text: [...doc.lines.slice(0, s), ...plan.newLines, ...doc.lines.slice(e + 1)].join(doc.eol),
			};
		}
		const hits = r.lines.map((l, k) => (l.startsWith(plan.match) ? r.range[0] + k : -1)).filter((k) => k >= 0);
		if (hits.length !== 1) return { ok: false, reason: hits.length ? "line-ambiguous" : "line-not-found", match: plan.match };
		const out = [...doc.lines];
		out[hits[0]] = plan.newLine;
		return { ok: true, op: plan.op, text: out.join(doc.eol), replacedLine: hits[0] };
	}

	if (plan.op === "replace-source") {		const srcs = doc.blocks.filter((b) => b.kind === "source" && b.srcId === plan.srcId);
		if (srcs.length !== 1) return { ok: false, reason: srcs.length ? "anchor-ambiguous" : "anchor-not-found", srcId: plan.srcId };
		const s = srcs[0];
		const fp = fingerprintLines(doc.lines, s.markerLine, s.bodyEnd, doc.eol);
		if (fp !== plan.expect.regionFingerprint) {
			return { ok: false, reason: "conflict", detail: "原文块（标记+正文）在你读之后变了", expected: plan.expect.regionFingerprint, actual: fp };
		}
		const replacement = renderBlockLines({ kind: "原文", srcId: plan.srcId, text: plan.text, attrs: plan.attrs });
		return {
			ok: true,
			op: plan.op,
			text: [...doc.lines.slice(0, s.markerLine), ...replacement, ...doc.lines.slice(s.bodyEnd + 1)].join(doc.eol),
		};
	}

	if (plan.op === "no-op") return { ok: true, op: "no-op", text };

	if (plan.op === "replace-block-text") {
		const blk = doc.blocks.find((b) => b.start === plan.range[0] && b.end === plan.range[1]);
		if (!blk) return { ok: false, reason: "block-not-found", range: plan.range };
		if (!READER_WRITABLE_KINDS.includes(blk.kind)) return { ok: false, reason: "not-reader-writable", kind: blk.kind, range: plan.range };
		const fp = fingerprintLines(doc.lines, plan.range[0], plan.range[1], doc.eol);
		if (fp !== plan.before.fingerprint) {
			return { ok: false, reason: "conflict", detail: "这一块在你读之后变过", expected: plan.before.fingerprint, actual: fp };
		}
		return {
			ok: true,
			op: plan.op,
			text: [...doc.lines.slice(0, plan.range[0]), ...plan.newLines, ...doc.lines.slice(plan.range[1] + 1)].join(doc.eol),
		};
	}

	return { ok: false, reason: `unknown-op:${plan.op}` };
}

// ── 小工具（报告 / 断言用）──────────────────────────────────────────────

/** 单个 hunk 的差异（共同前缀 + 后缀夹出中间那一块）；够用且**没有"猜"**。 */
export function diffHunk(a, b) {
	const al = a.split(/\r\n|\n/);
	const bl = b.split(/\r\n|\n/);
	let p = 0;
	while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
	let s = 0;
	while (s < al.length - p && s < bl.length - p && al[al.length - 1 - s] === bl[bl.length - 1 - s]) s++;
	return {
		aRange: [p, al.length - s - 1],
		bRange: [p, bl.length - s - 1],
		removed: al.slice(p, al.length - s),
		added: bl.slice(p, bl.length - s),
	};
}
