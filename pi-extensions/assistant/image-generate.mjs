/**
 * image-generate —— 「真能生图」的那一层薄 adapter（读配置 / 发一次请求 / 有界解析）。
 *
 * ── 为什么自己发一次 HTTP，而不走 pi-ai 的 `generateImages()` ─────────────────────────────
 * pi 0.85.1 的 SDK 里确实有 ImagesModel/generateImages（`pi-ai/dist/images.js`），但它**只注册了
 * 一个 images api**：`openrouter-images`。那个 provider 实际发的是 `chat.completions` +
 * `modalities:["image"]`，并只认 `choices[].message.images[].image_url` 的 data: URL
 * （`pi-ai/dist/api/openrouter-images.js:12-100`）；apiKey 必须由调用方给，usage/cost 还要
 * `model.cost`。⇒ 那是 OpenRouter 的形状，不是「自定义 OpenAI 图片端点」的抽象；硬塞进去会让
 * 请求体、错误归因、字节上限都不可控。所以这一层只做**一次 fetch**，既不引依赖，也不做多 provider 架构。
 *
 * ── 纪律（改这里之前先读；每一条都是业主/派单的硬约束）────────────────────────────────────
 *  · 只要一张图、size **默认** 1024x1024（是**请求值**：上游可能回别的尺寸，回执 `dims` 才是事实）；
 *    在 responses 那条 body 里**根本没有 n 字段**（托管工具不接受它）⇒「多图」一律拒，不裁不挑；
 *    **不把 batch / 画质暴露给模型**（成本面不给模型碰）；
 *  · 一次工具调用**最多一次**上游请求：超时、中断、5xx、坏 JSON、空图都**不重放**（重放 = 重复计费）；
 *  · 只认 `data[0].b64_json`，或**与 endpoint 同源**的 url（禁止跟随重定向、同样字节上限）⇒ 不做任意
 *    URL 抓取器，也不碰内网未知地址；
 *  · mime **按字节魔数实测**，不信上游自己报的字段；解不开 / 非图片 / 超限 ⇒ 失败回执，
 *    **绝不**写 image 块、**绝不**截断成一张假图；
 *  · 回执里不出现 key（只说「从哪个 provider / 哪个 env 变量名读到」），也不出现 base64
 *    （base64 只出现在 toolResult 的 image 块里，一份）。
 *
 * 所有对外行为都在 `generateImage()` 的返回里：`{ receipt, image }`。
 * `image === null` ⇔ 这一次**本工具没拿到可返回的图片**（⇒ 上层只许如实说失败，不许在正文里写「已生成」）。
 * ⚠️ 但「没拿到」**不等于**「上游一定没生成」：超时/中断/网络断开时上游到底做没做生成动作我们不知道，
 * 回执用 `outcomeUnknown:true` 如实标出来 —— 不要把它读成「一定没生成」。
 */
import { createHash } from "node:crypto";
import { readFile as readFileOnDisk } from "node:fs/promises";
import path from "node:path";

/** sidecar 配置的固定文件名（放在 `$ASSIST_HOME` 下；调用时读盘 ⇒ 加配置不需要重启 A）。 */
export const CONFIG_FILE_NAME = "image-generation.json";
/** 请求体里的**默认**尺寸：保守、便宜、后端普遍支持。**不是**模型参数，也**不是**承诺 —— 上游可能回别的尺寸。 */
export const SIZE = "1024x1024";
/** 请求固定只要一张图。**不是**模型参数。 */
export const COUNT = 1;
export const MAX_PROMPT_CHARS = 4000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 180_000;
/** 解码后的图片上限（1024×1024 的 PNG/JPEG 通常 0.2–2 MB）。超限 = 明确失败，不截断。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MIN_IMAGE_BYTES = 1024 * 1024;
/**
 * 上游响应体上限：**先按流读、到顶就取消**（不先 `response.text()` 把无界正文读进来再判字节）。
 * 4 MiB 解码 ≈ 5.34 MiB base64，再加 JSON 外壳的余量 ⇒ 6 MiB。
 */
export const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
/** 从图片文件头读到的尺寸上限（防病态容器；真正解码的安全性仍由**字节上限**兜住）。 */
export const MAX_IMAGE_SIDE_PX = 8192;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
/** 配置允许的尺寸枚举（**只从配置来**，不是模型参数；默认 1024²）。 */
export const ALLOWED_SIZES = ["1024x1024", "512x512", "1536x1024", "1024x1536"];
/** 可选的「向上一游请求」参数（只在配置显式给时发；不支持的后端会自己拒，我们如实回失败）。 */
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
export const QUALITIES = ["low", "medium", "high"];
/**
 * 两条协议**互斥**选择一个（一次调用只走一条，**绝不** fallback 到另一条 —— 那是重复计费）。
 *  · `responses-image-tool`（**优先**，业主 2026-10-26 裁定）：`POST <endpoint>`（如 `/v1/responses`），
 *    body 带服务端托管工具 `{type:"image_generation"}`，由工具**自己** raw 解析
 *    `output[].type==="image_generation_call"` 的 `.result`（base64）—— 绕开 pi-ai 那个会静默丢
 *    `image_generation_call` 的解析器（诊断单 `67af4aa` F6/F7），不改 `node_modules`。
 *  · `images`：`POST <endpoint>`（如 `/v1/images/generations`），OpenAI 图片端点形状 `{data:[...]}`。
 *  ⇒ 默认仍是 `images`（不改变已有配置的行为）；要用托管工具那条就**显式**写 `"apiMode": "responses-image-tool"`。
 */
export const API_MODES = ["images", "responses-image-tool"];
/** 托管生图工具的强制方式：`image_generation` ⇒ `tool_choice:{type:"image_generation"}`（只产图、不放模型去做函数调用）。 */
export const TOOL_CHOICES = ["image_generation", "required", "auto"];

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function configPath(env) {
	return path.join(String(env?.ASSIST_HOME ?? ""), CONFIG_FILE_NAME);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
function isLoopbackHost(hostname) {
	return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

function text(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * 读并校验配置。**每一种「缺什么」都点名**（回执里给的是键名，不是值）。
 * @returns {{ok:true, config:object, path:string} | {ok:false, reason:string, missing:string[], path:string, message:string}}
 */
export async function readImageConfig({ env = process.env, readFile = readFileOnDisk } = {}) {
	const file = configPath(env);
	const home = text(env?.ASSIST_HOME);
	if (home === "") {
		return {
			ok: false,
			reason: "image_backend_not_configured",
			missing: ["$ASSIST_HOME"],
			path: file,
			message: "$ASSIST_HOME 没设，读不到配置；因此这一次没有生成任何图片。",
		};
	}
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		const missingFile = error && (error.code === "ENOENT" || error.code === "ENOTDIR");
		return {
			ok: false,
			reason: "image_backend_not_configured",
			missing: [`${file}（${missingFile ? "文件不存在" : "读不了"}: ${error instanceof Error ? error.message : String(error)}）`],
			path: file,
			message: "没有配置生图后端；因此这一次没有生成任何图片（不是失败重试就能好的那种错，先补配置）。",
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			reason: "image_config_invalid_json",
			missing: [],
			path: file,
			message: `配置不是合法 JSON（${error instanceof Error ? error.message : String(error)}）；这一次没有生成任何图片。`,
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			ok: false,
			reason: "image_config_invalid",
			missing: [],
			path: file,
			message: "配置必须是 JSON 对象；这一次没有生成任何图片。",
		};
	}

	const missing = [];
	const endpointRaw = text(parsed.endpoint);
	let endpoint = null;
	if (endpointRaw === "") missing.push("endpoint");
	else {
		try {
			const url = new URL(endpointRaw);
			// 只接受 http(s)；https 优先，明文 http **只**允许显式回环（本机沙箱/本地 litellm）。
			if (url.protocol !== "http:" && url.protocol !== "https:") missing.push(`endpoint（协议必须是 http/https，读到 ${url.protocol}）`);
			else if (url.username !== "" || url.password !== "") missing.push("endpoint（不许把凭据写进 URL）");
			else if (url.search !== "" || url.hash !== "") missing.push("endpoint（不许带 query/hash；凭据只能来自已有 provider / 已有 env 变量）");
			else if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) missing.push(`endpoint（明文 http 只允许回环地址，读到 ${url.hostname}；对非本机后端请用 https）`);
			else endpoint = url;
		} catch {
			missing.push("endpoint（不是绝对 URL）");
		}
	}
	const model = text(parsed.model);
	if (model === "") missing.push("model");
	else if (model.length > 200) missing.push("model（超过 200 字符）");

	let authProvider = null;
	if (parsed.authProvider !== undefined && parsed.authProvider !== null) {
		const value = text(parsed.authProvider);
		if (value === "") missing.push("authProvider（给了但是空的）");
		else authProvider = value;
	}
	let apiKeyEnv = null;
	if (parsed.apiKeyEnv !== undefined && parsed.apiKeyEnv !== null) {
		const value = text(parsed.apiKeyEnv);
		if (value === "") missing.push("apiKeyEnv（给了但是空的）");
		else if (!ENV_NAME.test(value)) missing.push(`apiKeyEnv（必须是环境变量名，读到 ${value.slice(0, 40)}）`);
		else apiKeyEnv = value;
	}
	if (authProvider !== null && apiKeyEnv !== null) {
		missing.push("authProvider 与 apiKeyEnv 只能给一个（两个都给会不知道用哪份凭据）");
	}

	let timeoutMs = DEFAULT_TIMEOUT_MS;
	let timeoutNote = null;
	if (parsed.timeoutMs !== undefined && parsed.timeoutMs !== null) {
		if (typeof parsed.timeoutMs !== "number" || !Number.isFinite(parsed.timeoutMs)) {
			timeoutNote = `timeoutMs 不是数字 ⇒ 用默认 ${DEFAULT_TIMEOUT_MS} ms`;
		} else {
			timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed.timeoutMs)));
			const clamped = timeoutMs !== Math.floor(parsed.timeoutMs);
			if (clamped) timeoutNote = `timeoutMs 被夹到 ${timeoutMs} ms（允许 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}）`;
		}
	}

	let size = SIZE;
	if (parsed.size !== undefined && parsed.size !== null) {
		const value = text(parsed.size);
		if (!ALLOWED_SIZES.includes(value)) missing.push(`size（只允许 ${ALLOWED_SIZES.join(" / ")}，读到 ${value.slice(0, 20)}）`);
		else size = value;
	}
	const apiModeRaw = text(parsed.apiMode) !== "" ? text(parsed.apiMode) : text(parsed.api);
	// 兼容两种写法（C 的口径里出现过 `api:"responses-image"`）：长名是正式值，短名只做归一化。
	const apiMode = apiModeRaw === "" ? "images" : apiModeRaw === "responses-image" ? "responses-image-tool" : apiModeRaw;
	if (!API_MODES.includes(apiMode)) missing.push(`apiMode（只允许 ${API_MODES.join(" / ")}，读到 ${apiMode.slice(0, 24)}）`);
	const toolChoice = text(parsed.toolChoice) === "" ? "image_generation" : text(parsed.toolChoice);
	if (!TOOL_CHOICES.includes(toolChoice)) missing.push(`toolChoice（只允许 ${TOOL_CHOICES.join(" / ")}，读到 ${toolChoice.slice(0, 24)}）`);
	// `response_format` **不默认发**：OpenAI 的 gpt-image 系列与 DALL·E 的形状不同（前者不接受该字段），
	// 所以这一项只能由配置显式给（等真实后端的 contract 定了再填），**不靠旧 DALL·E 形状硬猜**。
	let responseFormat = null;
	if (parsed.responseFormat !== undefined && parsed.responseFormat !== null) {
		const value = text(parsed.responseFormat);
		if (value !== "b64_json" && value !== "url") missing.push(`responseFormat（只允许 b64_json / url，读到 ${value.slice(0, 20)}）`);
		else responseFormat = value;
	}
	// 上游若支持，可以用 `output_format` / `quality` **请求**一张更小的图（例如 jpeg+low）——
	// 这是把成本压在上游一步，**不是**在本地静默改已生成的内容；上游不支持就会自己拒（我们如实回失败）。
	let outputFormat = null;
	if (parsed.outputFormat !== undefined && parsed.outputFormat !== null) {
		const value = text(parsed.outputFormat);
		if (!OUTPUT_FORMATS.includes(value)) missing.push(`outputFormat（只允许 ${OUTPUT_FORMATS.join(" / ")}，读到 ${value.slice(0, 20)}）`);
		else outputFormat = value;
	}
	let quality = null;
	if (parsed.quality !== undefined && parsed.quality !== null) {
		const value = text(parsed.quality);
		if (!QUALITIES.includes(value)) missing.push(`quality（只允许 ${QUALITIES.join(" / ")}，读到 ${value.slice(0, 20)}）`);
		else quality = value;
	}
	// 硬上限可从配置收紧（1 MiB–4 MiB），**不从模型参数来**；收紧后超限就明确失败，不截断。
	let maxImageBytes = MAX_IMAGE_BYTES;
	let maxImageBytesNote = null;
	if (parsed.maxImageBytes !== undefined && parsed.maxImageBytes !== null) {
		if (typeof parsed.maxImageBytes !== "number" || !Number.isFinite(parsed.maxImageBytes)) {
			missing.push("maxImageBytes（必须是数字）");
		} else {
			maxImageBytes = Math.min(MAX_IMAGE_BYTES, Math.max(MIN_IMAGE_BYTES, Math.floor(parsed.maxImageBytes)));
			if (maxImageBytes !== Math.floor(parsed.maxImageBytes)) maxImageBytesNote = `maxImageBytes 被夹到 ${maxImageBytes}（允许 ${MIN_IMAGE_BYTES}–${MAX_IMAGE_BYTES}）`;
		}
	}
	// 一个 worker 进程里最多发几次生成请求（**不从模型参数来**）：不写 ⇒ 环境变量 > 默认 20。
	// 本次真实验界在 sandbox 配置里写 1，把上限硬钉成 1；生产默认不是只 1 次。
	let maxRequestsPerRun = null;
	if (parsed.maxRequestsPerRun !== undefined && parsed.maxRequestsPerRun !== null) {
		if (typeof parsed.maxRequestsPerRun !== "number" || !Number.isFinite(parsed.maxRequestsPerRun)) {
			missing.push("maxRequestsPerRun（必须是数字）");
		} else {
			maxRequestsPerRun = Math.min(1000, Math.max(1, Math.floor(parsed.maxRequestsPerRun)));
		}
	}

	if (missing.length > 0) {
		return {
			ok: false,
			reason: "image_backend_not_configured",
			missing,
			path: file,
			message: `生图后端配置不完整（缺/坏：${missing.join("、")}）；这一次没有生成任何图片。`,
		};
	}
	return {
		ok: true,
		path: file,
		config: {
			// `endpoint` 供请求用；`shown` 供回执用（origin+pathname，**永不带 query/hash**）。
			endpoint: endpoint.href,
			origin: `${endpoint.protocol}//${endpoint.host}`,
			shown: `${endpoint.origin}${endpoint.pathname}`,
			model,
			size,
			apiMode,
			toolChoice,
			responseFormat,
			outputFormat,
			quality,
			maxImageBytes,
			maxImageBytesNote,
			maxRequestsPerRun,
			authProvider,
			apiKeyEnv,
			timeoutMs,
			timeoutNote,
		},
	};
}

/**
 * 解析凭据：**只读已有来源**。
 *  · `authProvider` ⇒ pi 自己的 provider 凭据（`ctx.modelRegistry.getProviderAuth`，只读，不落盘、不改配置）；
 *  · `apiKeyEnv` ⇒ 一个**已存在**的环境变量（只读它的值；回执里永远只出现变量名）。
 * 两个都没配 ⇒ 不带头（有些本地后端不需要鉴权）——**不猜**。
 */
export async function resolveAuth(config, { modelRegistry, env = process.env } = {}) {
	const headers = {};
	if (config.authProvider) {
		const registry = modelRegistry;
		const resolve = typeof registry?.getProviderAuth === "function" ? registry.getProviderAuth.bind(registry) : null;
		if (!resolve) {
			return { ok: false, reason: "image_auth_provider_unsupported", message: "这个 pi 版本没有 ctx.modelRegistry.getProviderAuth；因此没有凭据可用，也没有生成任何图片。" };
		}
		let result;
		try {
			result = await resolve(config.authProvider);
		} catch (error) {
			return { ok: false, reason: "image_auth_provider_unreadable", message: `读不到 provider「${config.authProvider}」的凭据（${error instanceof Error ? error.message : String(error)}）；没有生成任何图片。` };
		}
		if (!result || !result.auth) {
			return { ok: false, reason: "image_auth_provider_unreadable", source: config.authProvider, message: `provider「${config.authProvider}」没有可用凭据（未登录/未配置）；没有生成任何图片。` };
		}
		const apiKey = text(result.auth.apiKey);
		const providerHeaders = result.auth.headers && typeof result.auth.headers === "object" ? result.auth.headers : {};
		for (const [name, value] of Object.entries(providerHeaders)) {
			if (typeof value === "string" && value !== "") headers[name] = value;
		}
		if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
		return { ok: true, source: `provider:${config.authProvider}`, hasKey: apiKey !== "", headers };
	}
	if (config.apiKeyEnv) {
		const value = text(env?.[config.apiKeyEnv]);
		if (value === "") {
			return { ok: false, reason: "image_auth_env_missing", source: `env:${config.apiKeyEnv}`, message: `环境变量 ${config.apiKeyEnv} 是空的（只读已有 env；不新建、不落盘）；没有生成任何图片。` };
		}
		headers.authorization = `Bearer ${value}`;
		return { ok: true, source: `env:${config.apiKeyEnv}`, hasKey: true, headers };
	}
	return { ok: true, source: null, hasKey: false, headers };
}

/** 图片文件头 → mime。认不出就是 null（**不猜**）。 */
export function detectImageMime(bytes) {
	const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
	if (buffer === null) return null;
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
		&& buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6) {
		const head = buffer.subarray(0, 6).toString("ascii");
		if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	}
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

/**
 * 严格 base64 → 字节。Node 的 Buffer 对坏字符是宽容的（静默丢弃），所以这里除了字符集与长度，
 * 还要求 re-encode **逐字相等** —— 否则「看起来解开了」的垃圾会变成一张假图。
 * @returns {{ok:true, bytes:Buffer} | {ok:false, reason:string}}
 */
export function decodeBase64(value, maxBytes = MAX_IMAGE_BYTES) {
	if (typeof value !== "string") return { ok: false, reason: "image_base64_not_string" };
	const compact = value.replace(/[\s]+/g, "");
	if (compact === "") return { ok: false, reason: "image_base64_empty" };
	if (compact.length % 4 !== 0 || !BASE64.test(compact)) return { ok: false, reason: "image_base64_invalid" };
	// **先按编码长度预检**，再真解码：4 MiB 解码 ≈ 5.34 MiB base64（+ 余量），
	// 超了就不申请那块内存（真正解码的安全性仍由解码后字节上限兜住）。
	const maxEncoded = Math.ceil(maxBytes / 3) * 4;
	if (compact.length > maxEncoded) return { ok: false, reason: "image_too_large", stage: "encoded_length", encodedChars: compact.length, maxEncodedChars: maxEncoded };
	const bytes = Buffer.from(compact, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== compact) return { ok: false, reason: "image_base64_invalid" };
	if (bytes.length > maxBytes) return { ok: false, reason: "image_too_large", stage: "decoded", bytes: bytes.length, maxBytes };
	return { ok: true, bytes };
}

/** 从文件头读宽高（PNG/JPEG/GIF；WebP 的三种头只读最简单的那些）。读不出就是 null（**不猜**）。 */
export function imageDimensions(bytes, mimeType) {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
	try {
		if (mimeType === "image/png" && buffer.length >= 24) {
			return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
		}
		if (mimeType === "image/gif" && buffer.length >= 10) {
			return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
		}
		if (mimeType === "image/webp" && buffer.length >= 30) {
			const kind = buffer.subarray(12, 16).toString("ascii");
			if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
			if (kind === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
			if (kind === "VP8L") {
				const bits = buffer.readUInt32LE(21);
				return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
			}
			return null;
		}
		if (mimeType === "image/jpeg") {
			// 扫 SOFn 段（C0–CF 去掉 C4/C8/CC），里面就是宽高。
			let offset = 2;
			while (offset + 9 < buffer.length) {
				if (buffer[offset] !== 0xff) { offset += 1; continue; }
				const marker = buffer[offset + 1];
				if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
				if (marker === 0xd9 || marker === 0xda) return null;
				const length = buffer.readUInt16BE(offset + 2);
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
				}
				if (length < 2) return null;
				offset += 2 + length;
			}
			return null;
		}
	} catch {
		return null;
	}
	return null;
}

/** 上游 JSON → 「恰好一张图」的候选（b64 或同源 url）。多于一张 ⇒ 如实拒绝，不悄悄挑一张。 */
export function pickImagePayload(json) {
	if (json === null || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "image_response_not_object" };
	const data = json.data;
	if (!Array.isArray(data)) return { ok: false, reason: "image_response_missing_data", errorMessage: text(json.error?.message ?? json.message) || null };
	if (data.length === 0) return { ok: false, reason: "image_response_empty", errorMessage: text(json.error?.message ?? json.message) || null };
	if (data.length > 1) return { ok: false, reason: "image_response_multiple_images", count: data.length };
	const first = data[0];
	if (first && typeof first === "object") {
		if (typeof first.b64_json === "string" && first.b64_json.trim() !== "") return { ok: true, source: "b64_json", base64: first.b64_json };
		if (typeof first.url === "string" && first.url.trim() !== "") return { ok: true, source: "url", url: first.url.trim() };
	}
	return { ok: false, reason: "image_response_missing_image", errorMessage: text(json.error?.message ?? json.message) || null };
}

/** url 只允许与 endpoint **同源**（协议+主机+端口）；禁重定向由 fetch 的 `redirect:"error"` 兜住。 */
export function sameOriginUrl(url, origin) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: "image_url_invalid" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "image_url_unsupported_scheme" };
	if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "image_url_has_credentials" };
	const actual = `${parsed.protocol}//${parsed.host}`;
	if (actual !== origin) return { ok: false, reason: "image_url_not_same_origin", urlOrigin: actual, allowedOrigin: origin };
	return { ok: true, url: parsed.href };
}

/** 有界读响应体：上游可能回一整页 HTML，也可能有人喂一个无限流。 */
async function readBounded(response, maxBytes) {
	const body = response.body;
	if (!body || typeof body.getReader !== "function") {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length > maxBytes) return { ok: false, reason: "image_response_too_large", bytes: buffer.length };
		return { ok: true, bytes: buffer };
	}
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				try { await reader.cancel(); } catch { /* 取消失败不影响这次失败归因 */ }
				return { ok: false, reason: "image_response_too_large", bytes: total };
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		try { reader.releaseLock(); } catch { /* 已经释放/已取消 */ }
	}
	return { ok: true, bytes: Buffer.concat(chunks) };
}

/** 一次请求的取消/超时：**外部 abort 与超时要能分开归因**（回执里理由不同）。 */
function requestGuard(signal, timeoutMs) {
	const controller = new AbortController();
	const state = { timedOut: false, externallyAborted: false };
	const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	const onAbort = () => { state.externallyAborted = true; controller.abort(); };
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		state,
		dispose() {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		},
	};
}

function httpFailure(status) {
	// 只报安全元数据（status/reason）。**不**把后端正文放进回执：里面可能有凭据/内部地址。
	if (status === 401 || status === 403) return { reason: "image_backend_unauthorized", outcomeUnknown: false, message: "后端拒绝了凭据（401/403）：检查这具凭据是否覆盖该图片模型；这次只发了一次请求，没有重试，也没有拿到图片。" };
	if (status === 429) return { reason: "image_backend_rate_limited", outcomeUnknown: false, message: "后端限流（429）：这次**没有**重试（避免重复计费），没有拿到图片。" };
	if (status >= 500) return { reason: "image_backend_error", outcomeUnknown: true, message: "后端 5xx：这次没有重放请求，也没有拿到图片；上游是否已做过生成动作**未知**（不回放、也不猜）。" };
	return { reason: "image_backend_rejected", outcomeUnknown: false, message: "后端拒绝了这个请求（4xx）：没有重试，也没有拿到图片。" };
}

/** 读响应体时**保留 guard 的归因**：流被 abort/超时打断，不能说成「读不出来」再报「一定没生成」。 */
async function readBoundedGuarded(response, guard) {
	try {
		return await readBounded(response, MAX_RESPONSE_BYTES);
	} catch {
		const reason = guard.state.externallyAborted ? "aborted" : guard.state.timedOut ? "timeout" : "image_response_unreadable";
		return { ok: false, reason, guardAborted: guard.state.externallyAborted || guard.state.timedOut };
	}
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

// ── 预算：**只有操作者显式要求时**才给这个 worker 进程加累计上限 ───────────────────────────
// 为什么默认**不设**累计上限（业主 2026-10-26 纠正）：worker 是多会话常驻的；默认 20 意味着第 21 个用户
// 在 worker 重启前被永久挡住 —— 预算不该靠「重启续额度」。每条调用自身的界已经够了：
// 一次调用 = 最多一次请求（n=1）、超时/中断/5xx 都不重放。
// 所以只有**显式配置**才启用进程级 cap：配置 `maxRequestsPerRun`（锚 [1,1000]）> 环境变量
// `SOPHO_IMAGE_GEN_MAX_REQUESTS`（沙箱/演练，**本次真实验界就是 env=1 或 config=1**）> 否则不设 cap。
// 预算在**即将发请求那一刻**才扣，所以配置/凭据错误不白占额度；到顶就拒（**不发**下一个请求、不 fallback）。
const BUDGET_ENV = "SOPHO_IMAGE_GEN_MAX_REQUESTS";
let generationRequestsUsed = 0;
function budgetLimit(config) {
	if (config && Number.isFinite(config.maxRequestsPerRun)) return Math.min(1000, Math.max(1, Math.floor(config.maxRequestsPerRun)));
	const raw = Number(process.env[BUDGET_ENV]);
	if (Number.isFinite(raw) && raw >= 1) return Math.min(1000, Math.floor(raw));
	return null; // 不设累计进程上限（per-call n=1 与不重放已经兜住）
}
function takeGenerationBudget(config) {
	const max = budgetLimit(config);
	if (max !== null && generationRequestsUsed >= max) return { ok: false, max, used: generationRequestsUsed };
	generationRequestsUsed += 1;
	return { ok: true, max, used: generationRequestsUsed };
}
/** 给门用的接缝：把预算归零（它只是进程内的机械计数器，不是产品状态）。 */
export function resetGenerationBudget() {
	generationRequestsUsed = 0;
}

/**
 * 回执里的预算字段：**没有进程级 cap 就只说这一次调用的界**（scope:"call", max:1），
 * 不写一个会让读的人误以为「进程还能再生 20 张」的假数；有 cap 才写 process 的 used/max。
 */
function budgetReceipt(budget) {
	return budget.max === null
		? { scope: "call", max: 1 }
		: { scope: "process", max: budget.max, used: budget.used };
}

function baseReceipt(config) {
	return {
		ok: false,
		generated: false,
		// 请求是否已经发出、以及失败时上游到底做没做动作：**只有回执能说准的那一种才写 false**。
		requestSent: false,
		outcomeUnknown: false,
		tool: "image_generate",
		// `backend.api` 说明这一次走的是哪条协议；`backend.model` 是**内层**使用的模型（响应/图片端点那个，
		// 可能与发起调用的聊天模型不同、计费口径也不同）—— 回执里必须把它记下来，不能说成「聊天本身变像素」。
		backend: config ? { apiMode: config.apiMode, endpoint: config.shown, model: config.model } : null,
		size: config ? config.size : SIZE,
		count: COUNT,
		// 实际上的界限与「向上一游请求了什么」都写进回执：读的人不用猜这张图为什么这么大/这么小。
		limits: config ? { maxImageBytes: config.maxImageBytes, maxSidePx: MAX_IMAGE_SIDE_PX, maxPixels: MAX_IMAGE_PIXELS, count: COUNT } : null,
		requested: config ? { apiMode: config.apiMode, size: config.size, toolChoice: config.toolChoice, outputFormat: config.outputFormat, quality: config.quality, responseFormat: config.responseFormat } : null,
		image: null,
	};
}

/**
 * 字节 → 回执 + image 块（两条协议共用这一段）：大小/魔数/尺寸三道界都在这里，失败就零图。
 */
function finalizeImage(bytes, { receipt, config, status, source, extra = {}, startedAt, now }) {
	if (bytes.length > config.maxImageBytes) {
		return { receipt: { ...receipt, reason: "image_too_large", status, requestSent: true, outcomeUnknown: false, bytes: bytes.length, maxBytes: config.maxImageBytes, message: `后端给的图片有 ${bytes.length} 字节，超过上限 ${config.maxImageBytes}：明确失败，**不截断**成假图。` }, image: null };
	}
	const mimeType = detectImageMime(bytes);
	if (mimeType === null) {
		return { receipt: { ...receipt, reason: "image_not_an_image", status, requestSent: true, outcomeUnknown: false, bytes: bytes.length, message: "后端给的字节不是 PNG/JPEG/GIF/WebP（按文件头判定）：本轮没有拿到图片。" }, image: null };
	}
	const dimensions = imageDimensions(bytes, mimeType);
	if (dimensions !== null && (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0)) {
		return { receipt: { ...receipt, reason: "image_dimensions_invalid", status, requestSent: true, outcomeUnknown: false, bytes: bytes.length, width: dimensions.width, height: dimensions.height, message: "文件头读到的宽高不是正数（0/负/不可解析）：不把这张图当成功。" }, image: null };
	}
	if (dimensions !== null && (dimensions.width > MAX_IMAGE_SIDE_PX || dimensions.height > MAX_IMAGE_SIDE_PX || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS)) {
		return { receipt: { ...receipt, reason: "image_dimensions_too_large", status, requestSent: true, outcomeUnknown: false, bytes: bytes.length, width: dimensions.width, height: dimensions.height, maxSidePx: MAX_IMAGE_SIDE_PX, maxPixels: MAX_IMAGE_PIXELS, message: "后端给的图片尺寸不合理（文件头读到的宽高超过上限）：明确失败，不显示这张图。" }, image: null };
	}
	return {
		receipt: {
			...receipt,
			ok: true,
			generated: true,
			requestSent: true,
			status,
			source,
			...extra,
			// 告证字段（C 给的交付口径）：顶层就给 httpStatus/elapsedMs/mimeType/bytes/sha256/dims，
			// 不用读回执的人再去 `image` 里拆；`dims` 读不出就 null 并说明原因（不编）。
			httpStatus: status,
			elapsedMs: Math.max(0, now() - startedAt),
			mimeType,
			bytes: bytes.length,
			sha256: sha256(bytes),
			dims: dimensions === null ? null : { width: dimensions.width, height: dimensions.height },
			dimsNote: dimensions === null ? "文件头读不出宽高（可能是 WebP 变体或容器不完整）：未猜" : null,
			image: { mimeType, bytes: bytes.length, sha256: sha256(bytes), width: dimensions?.width ?? null, height: dimensions?.height ?? null },
			durationMs: Math.max(0, now() - startedAt),
			message: "真的拿到了一张图（这一块 image 就是它）。",
		},
		image: { type: "image", data: bytes.toString("base64"), mimeType },
	};
}

/** 
 * 从错误 JSON 里只挑一句**能见人的**错误文本：先抹掉疑似凭据的形状，再截到 300 字符。
 * 不抄 headers、不抄整段 body。
 */
function safeUpstreamMessage(bytes) {
	let text = "";
	try {
		const json = JSON.parse(bytes.toString("utf8"));
		const value = typeof json?.error?.message === "string" ? json.error.message : typeof json?.message === "string" ? json.message : "";
		text = value;
	} catch {
		return null;
	}
	const redacted = text
		.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
		.replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, "<redacted-key>")
		.replace(/\b(token|key|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=<redacted>")
		.replace(/\b[A-Za-z0-9+/=_-]{60,}\b/g, "<redacted-token>")
		.replace(/\s+/g, " ")
		.trim();
	if (redacted === "") return null;
	return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/** 只挑**安全**的错误字段（`type`/`code`/`param`）：不回显后端正文，也不回显任何疑似凭据。 */
function safeErrorFields(bytes) {
	try {
		const json = JSON.parse(bytes.toString("utf8"));
		const error = json && typeof json.error === "object" && json.error !== null ? json.error : {};
		const pick = (value) => (typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : null);
		return { errorType: pick(error.type), errorCode: pick(error.code), errorParam: pick(error.param) };
	} catch {
		return { errorType: null, errorCode: null, errorParam: null };
	}
}

/**
 * Responses 输出里的托管生图 item：`output[].type === "image_generation_call"`，像素在 `.result`（base64）。
 * 只要**恰好一张、状态 completed、result 非空**；多余/缺失/函数调用一律如实拒绝（不挑一张充数）。
 */
export function parseResponsesOutput(json) {
	const output = json && typeof json === "object" && Array.isArray(json.output) ? json.output : null;
	if (output === null) return { ok: false, reason: "responses_missing_output" };
	const outputTypes = output.map((item) => (item && typeof item.type === "string" ? item.type : "unknown"));
	const functionCalls = output.filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call");
	if (functionCalls.length > 0) return { ok: false, reason: "responses_inner_function_call", functionCalls: functionCalls.length, outputTypes };
	const images = output.filter((item) => item?.type === "image_generation_call");
	if (images.length === 0) return { ok: false, reason: "responses_no_image_generation_call", outputTypes };
	if (images.length > 1) return { ok: false, reason: "responses_multiple_images", count: images.length, outputTypes };
	const item = images[0];
	const imageStatus = typeof item.status === "string" ? item.status : null;
	// 合同是「只认 completed」：**缺 status / 空 status 也拒**（不能把没写状态的 result 当成功）。
	if (imageStatus !== "completed") return { ok: false, reason: "responses_image_not_completed", imageStatus, outputTypes };
	const result = typeof item.result === "string" ? item.result.trim() : "";
	if (result === "") return { ok: false, reason: "responses_image_missing_result", imageStatus, outputTypes };
	return { ok: true, result, imageStatus, outputTypes };
}

/** 托管 `image_generation` 那条路：一次 POST，自己 raw 解析（不过 pi-ai 的 Responses 解析器）。 */
async function generateViaResponses({ config, auth, promptText, signal, fetchImpl, receipt, startedAt, now }) {
	const headers = { "content-type": "application/json", accept: "application/json", ...auth.headers };
	// 工具对象只带**最小**支持参数：type + size（quality 只在配置显式给时才带）。
	const tool = { type: "image_generation", size: config.size };
	if (config.quality !== null) tool.quality = config.quality;
	// 按 C 的只读契约（cf218dc / 1.103.0 源码）：`input` 用**字符串**（最小 body；list 形式也合法但多一层形状争议），
	// **不带** n/response_format/parallel_tool_calls/max_output_tokens/instructions；`tools` 里**只有**托管生图这一条。
	const body = {
		model: config.model,
		input: promptText,
		tools: [tool],
		stream: false,
	};
	// 强制只产图：`tool_choice` 指向托管生图工具 ⇒ 不让模型改走函数调用（内层多 step 我们不会执行）。
	if (config.toolChoice === "image_generation") body.tool_choice = { type: "image_generation" };
	else if (config.toolChoice === "required") body.tool_choice = "required";

	const guard = requestGuard(signal, config.timeoutMs);
	let response;
	try {
		response = await fetchImpl(config.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: guard.signal, redirect: "error" });
	} catch {
		guard.dispose();
		const reason = guard.state.externallyAborted ? "aborted" : guard.state.timedOut ? "timeout" : "image_backend_unreachable";
		const message = reason === "aborted"
			? "这次调用被中断（abort）了：没有重试；上游是否已经做过生成动作**未知**，本轮没有拿到图片。"
			: reason === "timeout"
				? `后端在 ${config.timeoutMs} ms 内没有回应：没有重试（避免重复计费）；上游是否已经做过生成动作**未知**，本轮没有拿到图片。`
				: "连不上后端：没有重试；上游是否收到过这次请求**未知**，本轮没有拿到图片。";
		return { receipt: { ...receipt, reason, httpStatus: null, requestSent: true, outcomeUnknown: true, timeoutMs: config.timeoutMs, message }, image: null };
	}

	const raw = await readBoundedGuarded(response, guard);
	guard.dispose();
	const status = Number(response.status);
	const contentType = typeof response.headers?.get === "function" ? response.headers.get("content-type") : null;
	if (!response.ok) {
		const failure = httpFailure(status);
		const fields = raw.ok ? safeErrorFields(raw.bytes) : { errorType: null, errorCode: null, errorParam: null };
		// `upstreamError` 只是一个**抹过凭据、截到 300 字符**的一句，供交付时贴证据；不抄 headers、不抄整段 body。
		const upstreamError = raw.ok ? safeUpstreamMessage(raw.bytes) : null;
		return { receipt: { ...receipt, reason: failure.reason, status, httpStatus: status, requestSent: true, outcomeUnknown: failure.outcomeUnknown, ...fields, upstreamError, message: failure.message }, image: null };
	}
	if (!raw.ok) {
		return { receipt: { ...receipt, reason: raw.reason, status, httpStatus: status, requestSent: true, outcomeUnknown: raw.guardAborted === true, bytes: raw.bytes ?? null, message: raw.guardAborted === true ? "请求已发出、响应体读到一半被中断/超时：上游是否已产出**未知**，本轮没有拿到图片。" : "上游响应读不出来/超过响应体上限（不截断、不猜）：本轮没有拿到图片。" }, image: null };
	}
	if (contentType !== null && /text\/event-stream/i.test(contentType)) {
		return { receipt: { ...receipt, reason: "responses_unexpected_stream", status, httpStatus: status, requestSent: true, outcomeUnknown: false, contentType, message: "这里要的是非流式 JSON（stream:false），后端却回了 SSE：本轮没有拿到图片（也不去解析半个流）。" }, image: null };
	}

	let json;
	try {
		json = JSON.parse(raw.bytes.toString("utf8"));
	} catch {
		return { receipt: { ...receipt, reason: "image_backend_invalid_json", status, httpStatus: status, requestSent: true, outcomeUnknown: false, message: "后端回的不是 JSON：本轮没有拿到图片（也没有重试）。" }, image: null };
	}
	const parsed = parseResponsesOutput(json);
	if (!parsed.ok) {
		const reasons = {
			responses_missing_output: "响应里没有 output 数组：本轮没有拿到图片。",
			responses_inner_function_call: "内层模型改去发函数调用了（我们不会执行内层函数链）：本轮没有拿到图片。",
			responses_no_image_generation_call: "响应里没有 image_generation_call：托管生图工具可能没被接受/被执行：本轮没有拿到图片。",
			responses_multiple_images: "一次要 1 张，后端回了多张：不挑一张充数，本轮没有拿到图片。",
			responses_image_not_completed: "image_generation_call 的状态不是 completed：本轮没有拿到图片。",
			responses_image_missing_result: "image_generation_call 里没有 result（base64）：本轮没有拿到图片。",
		};
		return { receipt: { ...receipt, reason: parsed.reason, status, httpStatus: status, requestSent: true, outcomeUnknown: false, outputTypes: parsed.outputTypes ?? null, imageStatus: parsed.imageStatus ?? null, count: parsed.count ?? null, functionCalls: parsed.functionCalls ?? null, message: reasons[parsed.reason] ?? "响应形状不对：本轮没有拿到图片。" }, image: null };
	}

	const payload = parsed.result.startsWith("data:") ? parsed.result.replace(/^data:[^;,]*;base64,/, "") : parsed.result;
	const decoded = decodeBase64(payload, config.maxImageBytes);
	if (!decoded.ok) {
		const stage = decoded.stage ?? (decoded.reason === "image_too_large" ? "decoded" : null);
		const message = decoded.reason === "image_too_large"
			? `image_generation_call.result 超过上限（${stage === "encoded_length" ? "按编码长度预检" : "按解码后字节"}）：本轮没有拿到图片，**不截断**。`
			: "image_generation_call.result 不是规范 base64：本轮没有拿到图片。";
		return { receipt: { ...receipt, reason: decoded.reason, stage, status, httpStatus: status, requestSent: true, outcomeUnknown: false, encodedChars: decoded.encodedChars ?? null, bytes: decoded.bytes ?? null, maxBytes: config.maxImageBytes, message }, image: null };
	}
	return finalizeImage(decoded.bytes, {
		receipt, config, status, source: "image_generation_call.result", startedAt, now,
		extra: {
			authSource: auth.source,
			outputTypes: parsed.outputTypes,
			imageStatus: parsed.imageStatus,
			responseId: typeof json.id === "string" ? json.id : null,
			...(json && typeof json.usage === "object" && json.usage !== null ? { usage: json.usage } : {}),
			// 本地 litellm 用自己的按 token 价格表算成本（补丁 2：设了 LITELLM_IGNORE_UPSTREAM_RESPONSE_COST
			// 就忽略上游回传成本），而图像输出是按图像档计费 ⇒ 本地 cost 偏低/失真，真实账单在上游。
			costNote: "本地 litellm 用自己按 token 的价格表算，图像输出会偏低；真实费用在上游",
		},
	});
}

/**
 * 一次工具调用 = 最多一次上游请求。
 * @returns {{receipt:object, image:{type:"image",data:string,mimeType:string}|null}}
 */
export async function generateImage({
	prompt,
	signal,
	env = process.env,
	modelRegistry = null,
	fetchImpl = globalThis.fetch,
	readFile = readFileOnDisk,
	now = () => Date.now(),
} = {}) {
	const promptText = typeof prompt === "string" ? prompt.trim() : "";
	const startedAt = now();
	if (promptText === "") {
		return { receipt: { ...baseReceipt(null), reason: "empty_prompt", message: "prompt 是空的：没有发任何请求，也没有图片。" }, image: null };
	}
	if (promptText.length > MAX_PROMPT_CHARS) {
		return { receipt: { ...baseReceipt(null), reason: "prompt_too_long", promptChars: promptText.length, maxPromptChars: MAX_PROMPT_CHARS, message: `prompt 有 ${promptText.length} 字符，超过上限 ${MAX_PROMPT_CHARS}；没有发请求。` }, image: null };
	}

	const loaded = await readImageConfig({ env, readFile });
	if (!loaded.ok) {
		return {
			receipt: {
				...baseReceipt(null),
				reason: loaded.reason,
				missing: loaded.missing,
				configPath: loaded.path,
				message: `${loaded.message} 补齐后要重开拿到本工具的 runtime（插件工具面按代固化），配置本身不需要重启宿主。`,
			},
			image: null,
		};
	}
	const config = loaded.config;
	const receipt = baseReceipt(config);

	const auth = await resolveAuth(config, { modelRegistry, env });
	if (!auth.ok) {
		return { receipt: { ...receipt, reason: auth.reason, authSource: auth.source ?? null, message: auth.message }, image: null };
	}

	// 预算：到真正要发请求这一步才扣；超了就直接拒绝（**不**发第二个请求，也不换协议）。
	const budget = takeGenerationBudget(config);
	if (!budget.ok) {
		return {
			receipt: {
				...receipt,
				reason: "image_generation_budget_exhausted",
				requestSent: false,
				outcomeUnknown: false,
				budget: budgetReceipt(budget),
				message: `本次运行已经用掉了 ${budget.used}/${budget.max} 次生成请求（操作者显式设的 cap）：下一次不自动发（避免多计费）。`,
			},
			image: null,
		};
	}

	// 成功/失败回执都带同一个机械计数（`used/max`）：C 不用信任文字，读这两个数就知道本轮发了几次。
	receipt.budget = budgetReceipt(budget);

	// 两条协议**互斥**：一次调用只走配置说的那一条；这一轮**绝不** fallback 到另一条（那就是重复计费）。
	if (config.apiMode === "responses-image-tool") {
		return await generateViaResponses({ config, auth, promptText, signal, fetchImpl, receipt, startedAt, now });
	}

	const headers = { "content-type": "application/json", accept: "application/json", ...auth.headers };
	// 请求体只有这些字段。`response_format` 只在配置显式给了才带（gpt-image 系列不接受它，不靠旧 DALL·E 形状硬猜）。
	const requestBody = { model: config.model, prompt: promptText, n: COUNT, size: config.size };
	if (config.outputFormat !== null) requestBody.output_format = config.outputFormat;
	if (config.quality !== null) requestBody.quality = config.quality;
	if (config.responseFormat !== null) requestBody.response_format = config.responseFormat;
	const body = JSON.stringify(requestBody);
	const guard = requestGuard(signal, config.timeoutMs);
	// **一个 guard 管整段**（POST ＋ 同源 GET ＋ 两段 body 读）：到点统一取消，总时长 ≤ timeoutMs（不叠加）。
	try {
		let response;
		try {
			response = await fetchImpl(config.endpoint, { method: "POST", headers, body, signal: guard.signal, redirect: "error" });
		} catch (error) {
			const reason = guard.state.externallyAborted ? "aborted" : guard.state.timedOut ? "timeout" : "image_backend_unreachable";
			// 请求**已经发出**（或至少可能到了网络）而结果没拿到 ⇒ `outcomeUnknown:true`：
			// 不许写「一定没生成」—— 那是我们不知道的事。
			const message = reason === "aborted"
				? "这次调用被中断（abort）了：没有重试；上游是否已经做过生成动作**未知**，本轮没有拿到图片。"
				: reason === "timeout"
					? `后端在 ${config.timeoutMs} ms 内没有回应：没有重试（避免重复计费）；上游是否已经做过生成动作**未知**，本轮没有拿到图片。`
					: "连不上后端：没有重试；上游是否收到过这次请求**未知**，本轮没有拿到图片。";
			return { receipt: { ...receipt, reason, httpStatus: null, requestSent: true, outcomeUnknown: true, timeoutMs: config.timeoutMs, message }, image: null };
		}

		// —— 从这一刻起，无论成败都只读这一次响应；**不做任何重放** ——
		const raw = await readBoundedGuarded(response, guard);
		const status = Number(response.status);
		if (!response.ok) {
			const failure = httpFailure(status);
			return { receipt: { ...receipt, reason: failure.reason, status, requestSent: true, outcomeUnknown: failure.outcomeUnknown, message: failure.message }, image: null };
		}
		if (!raw.ok) {
			return { receipt: { ...receipt, reason: raw.reason, status, httpStatus: status, requestSent: true, outcomeUnknown: raw.guardAborted === true, bytes: raw.bytes ?? null, message: raw.guardAborted === true ? "请求已发出、响应体读到一半被中断/超时：上游是否已产出**未知**，本轮没有拿到图片。" : "上游响应读不出来/超过响应体上限（不截断、不猜）：本轮没有拿到图片。" }, image: null };
		}

		let json;
		try {
			json = JSON.parse(raw.bytes.toString("utf8"));
		} catch {
			return { receipt: { ...receipt, reason: "image_backend_invalid_json", status, httpStatus: status, requestSent: true, outcomeUnknown: false, message: "后端回的不是 JSON：本轮没有拿到图片（也没有重试）。" }, image: null };
		}
		const picked = pickImagePayload(json);
		if (!picked.ok) {
			return { receipt: { ...receipt, reason: picked.reason, status, requestSent: true, outcomeUnknown: false, count: picked.count ?? null, errorMessage: picked.errorMessage ?? null, message: "后端没有给出一张可用的图片：本轮没有拿到图片（也没有重试）。" }, image: null };
		}

		let bytes = null;
		if (picked.source === "b64_json") {
			const decoded = decodeBase64(picked.base64, config.maxImageBytes);
			if (!decoded.ok) {
				// 两种失败分开说：**编码长度预检超限**（未解码） vs **不是规范 base64**。
				const stage = decoded.stage ?? (decoded.reason === "image_too_large" ? "decoded" : null);
				const message = decoded.reason === "image_too_large"
					? `后端给的图片超过上限（${stage === "encoded_length" ? "按编码长度预检" : "按解码后字节"}）：本轮没有拿到图片，**不截断**。`
					: "后端给的 b64 不是规范 base64：本轮没有拿到图片。";
				return { receipt: { ...receipt, reason: decoded.reason, stage, status, httpStatus: status, requestSent: true, outcomeUnknown: false, encodedChars: decoded.encodedChars ?? null, bytes: decoded.bytes ?? null, maxBytes: config.maxImageBytes, message }, image: null };
			}
			bytes = decoded.bytes;
		} else {
			const safe = sameOriginUrl(picked.url, config.origin);
			if (!safe.ok) {
				return { receipt: { ...receipt, reason: safe.reason, status, requestSent: true, outcomeUnknown: false, urlOrigin: safe.urlOrigin ?? null, allowedOrigin: config.origin, message: "后端只给了图片 URL，而它不是与配置 endpoint 同源的地址：本工具**不抓任意 URL**，所以本轮没有拿到图片。" }, image: null };
			}
			let download;
			try {
				download = await fetchImpl(safe.url, { method: "GET", headers: { accept: "image/*", ...auth.headers }, signal: guard.signal, redirect: "error" });
			} catch {
				const reason = guard.state.externallyAborted ? "aborted" : guard.state.timedOut ? "timeout" : "image_url_unreachable";
				return { receipt: { ...receipt, reason, status, requestSent: true, outcomeUnknown: true, message: "同源图片下载失败：没有重试；本轮没有拿到图片。" }, image: null };
			}
			const downloaded = await readBoundedGuarded(download, guard);
			if (!download.ok) {
				const failure = httpFailure(Number(download.status));
				return { receipt: { ...receipt, reason: failure.reason, status: Number(download.status), requestSent: true, outcomeUnknown: failure.outcomeUnknown, message: `下载同源图片被拒（HTTP ${download.status}）：没有重试，本轮没有拿到图片。` }, image: null };
			}
			if (!downloaded.ok) {
				// 下载阶段同样要保留 guard 归因：被中断/超时 ⇒ 上游是否已产出**未知**（不能写 false）。
				return { receipt: { ...receipt, reason: downloaded.reason, status, httpStatus: status, requestSent: true, outcomeUnknown: downloaded.guardAborted === true, bytes: downloaded.bytes ?? null, message: downloaded.guardAborted === true ? "同源图片的响应体读到一半被中断/超时：上游是否已产出**未知**，本轮没有拿到图片。" : "同源图片太大/读不出来：本轮没有拿到图片（不截断）。" }, image: null };
			}
			bytes = downloaded.bytes;
		}

		return finalizeImage(bytes, { receipt, config, status, source: picked.source, extra: { authSource: auth.source }, startedAt, now });

	} finally {
		guard.dispose();
	}
}

/** index.ts 用：把 adapter 的返回拼成 pi 的 tool result（成功时 image 块排在回执文字之后）。 */
export function toolResultOf({ receipt, image }) {
	const content = [{ type: "text", text: JSON.stringify(receipt, null, 2) }];
	if (image !== null) content.push(image);
	return { content, details: receipt, isError: receipt.ok !== true };
}
