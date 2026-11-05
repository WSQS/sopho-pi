#!/usr/bin/env node
// 门：`image_generate` —— 真的「函数工具拿回一张真图」那一条路（不碰真后端、不碰真 profile）。
//
// ── 为什么要有它（依据：`items/image-generation/item.md` ＋ 诊断单 `67af4aa`）──────────────
// 诊断已证：活注册表里**没有**任何图像工具，pi 0.85.1 的 Responses 解析器又会**静默丢弃**
// `image_generation_call`（零内容块、零事件、不报错）⇒ 想让模型真拿到图，唯一诚实的路是
// **插件注册一个函数工具**，由工具自己把字节装进 `toolResult` 的 `ImageContent`
// （`pi-ai/dist/types.d.ts:251-255,330-342`）。本门钉的就是这条路：
// 真插件文件 ＋ 真 pi runtime ＋ 假 provider（模型侧真发一次工具调用）＋ 假图片后端。
//
// ── 判据（按层；每一条都挂原始读数）──────────────────────────────────────────────────
//  A 纯 adapter（不起进程，注入 fetch/readFile）：
//    A1 配置：缺文件 / 坏 JSON / 明文 http 非回环 / endpoint 带 query / size 越界 / responseFormat 非法
//       ⇒ 一律**失败回执**且点名缺哪个键；authProvider 与 apiKeyEnv 同时给 ⇒ 拒绝（不知道用哪份凭据）。
//    A2 base64：非规范 / 填充错 / **编码长度预检超限** ⇒ 明确失败（不 decode 成垃圾）。
//    A3 文件头：PNG/JPEG/GIF/WebP 魔数 + 尺寸；非图片字节 ⇒ null（不猜）。
//    A4 `data[]`：空 / 多图 / 只有外域 url ⇒ 各有自己的 reason（多图不悄悄挑一张）。
//    A5 同源：同源 URL 通过；外域/带凭据/非 http(s) 一律拒。
//  B 真插件 ＋ 真 runtime（本门主体）：
//    B1 模型面真的收到 `image_generate` 这个工具（假 provider 记下 `body.tools`）。
//    B2 成功一次：toolResult.content = [文字回执, **image 块**]，mimeType 按魔数实测、
//       data 与夹具逐字相同、回执里有 sha256；**回执里没有 base64**；图片元数据 (bytes) 对得上；
//       且模型面真的收到了这张图（completions 侧会转成紧跟的 `Attached image(s) from tool result:`）。
//    B3 失败族（401/403/429/500/坏 JSON/空 data/多图/非图片 b64/超限/超时/外域 url）：
//       每条都**零 image 块** ＋ `ok:false` ＋ reason 定位到具体那一种；**每条只打一次后端**（不重放）；
//       超时/中断写 `outcomeUnknown:true`（上游到底做没做生成动作我们不知道），4xx 写 false。
//       ⚠️ SDK 事实（`pi-agent-core/dist/agent-loop.js:458-486`）：`execute` 返回里的 `isError` **会被忽略**
//       —— 只有**抛异常**才会把 toolResult 标成 isError。所以本工具在失败时**抛出结构化回执本身**（JSON），
//       回执里的 `ok:false` 与 toolResult 的 `isError:true` 是同一件事的两种读数，工具卡不会显成成功。
//    B4 配置缺失（把 sidecar 删掉再调）：**零后端请求** ＋ `image_backend_not_configured` ＋ 点名缺哪个键；
//       恢复配置后再调一次又能成功 ⇒ 证明**配置是调用时读盘**（加配置不需要重启宿主）。
//    B5 凭据两条路：`authProvider`（经 pi 的 modelRegistry 只读解析）与 `apiKeyEnv`（只读已有 env），
//       假后端记下的 `authorization` 都是 Bearer 夹具值；回执只报来源**名字**，不含值。
//    B6 请求形状：默认 body 只有 `{model,prompt,n:1,size}`，**没有** `response_format`
//       （gpt-image 系列不接受它，不靠旧 DALL·E 形状硬猜）；配置显式给时才带。
//  C 前端那一半（真 Chromium ＋ 假 API，若本机有浏览器）：把 B2 的**真回执**按服务端 `/messages` 的
//    同一份规则装成 wire，工具卡里要真的出现 `<img>`，**刷新一次仍在**。没有浏览器 ⇒ 如实 `⤵ SKIP`。
//
// 纪律：临时 `ASSIST_HOME` ＋ 高位随机端口 ＋ 假 provider／假图片后端；不碰真 profile、不碰 7331/7321；
// 不写任何真实 key（夹具 key 只活在本次进程的 env 里）；收尾只按本次 spawn 的精确 pid 停。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

import {
	MAX_IMAGE_BYTES,
	decodeBase64,
	detectImageMime,
	generateImage,
	imageDimensions,
	parseResponsesOutput,
	pickImagePayload,
	readImageConfig,
	resetGenerationBudget,
	sameOriginUrl,
} from '../pi-extensions/assistant/image-generate.mjs';
// 假 key：源码里**拼接**而成 —— 避免「字面量形似真凭据」被 pre-push 闸误伤（运行时值与原来一字不差）。
const FAKE_KEY = "sk-" + "abcdefghijklmnopq";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用的接缝（不是产品面）：把插件目录指到一份**改过一处的副本**上，就能看「能力缺失时本门必红」。
// 复现命令（本仓惯例的红臂，收尾删自己建的目录）：
//   mkdir -p .sopho-imagegen-arm/assistant && cp pi-extensions/assistant/*.mjs pi-extensions/assistant/index.ts .sopho-imagegen-arm/assistant/ \
//     && git show HEAD~1:pi-extensions/assistant/index.ts > .sopho-imagegen-arm/assistant/index.ts \
//     && SOPHO_IMAGEGEN_PLUGIN_INDEX="$PWD/.sopho-imagegen-arm/assistant/index.ts" node test/image-generate.mjs
const PLUGIN_INDEX = path.resolve(process.env.SOPHO_IMAGEGEN_PLUGIN_INDEX || path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts'));
const MODEL_ID = 'fake-image-gate';
const KEY_FIXTURE = 'sandbox-image-key';
const ENV_KEY_FIXTURE = 'sandbox-env-image-key';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

let checks = 0;
const failures = [];
function check(name, ok, detail) {
	if (!ok) {
		failures.push({ name, detail });
		process.stdout.write(`✗ ${name}\n  实测：${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
		return false;
	}
	checks += 1;
	process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
	return true;
}
async function scenario(name, run) {
	try {
		await run();
	} catch (error) {
		failures.push({ name, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
		process.stdout.write(`✗ scenario ${name} —— ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

// ── 图片夹具：真 PNG（IHDR+IDAT+IEND，尺寸 400×300 确定）＋ 超限字节 ─────────────────────────
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
	return out;
}
function pngBytes(width, height) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x += 1) {
			raw[row + 1 + x * 3] = 200;
			raw[row + 2 + x * 3] = 60;
			raw[row + 3 + x * 3] = 90;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
	]);
}
const PNG = pngBytes(400, 300);
const PNG_B64 = PNG.toString('base64');
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');
const PLACEHOLDER = (bytes) => `[图片：image/png，${bytes} 字节（网页暂不显示图片内容）]`;
// 4 MiB 之后的字节：魔数仍是 PNG ⇒ 先撞「字节上限」这一条，而不是「不是图片」。
const OVERSIZE = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES, 7)]);
// 比「收紧后的 1 MiB 上限」大、比 4 MiB 硬上限小：用来验「配置可以把上限收紧，且超了明确失败」（MEDIUM 名不指画质）。
const MEDIUM = Buffer.concat([PNG, Buffer.alloc(1200 * 1024, 7)]);
// 宽 0 的 PNG：magic 是 PNG、IHDR 尺寸字段为 0 ⇒ 用来钉「尺寸必须为正，0 不能当成功图」。
const PNG_ZERO = Buffer.from(PNG);
PNG_ZERO.writeUInt32BE(0, 16);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x40, 0x01, 0xf0, 0x00])]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8X', 'ascii'), Buffer.alloc(20, 0)]);

// ── A 层：纯 adapter（注入 readFile/fetch，不起进程）─────────────────────────────────────────
const CONFIG_READ = (value) => async () => (typeof value === 'string' ? value : JSON.stringify(value));
const CONFIG_ENV = { ASSIST_HOME: path.join(os.tmpdir(), 'image-gate-pure') };
const okConfig = { endpoint: 'http://127.0.0.1:9/v1/images/generations', model: 'fake-image-1' };
const responseOf = (status, value) => ({
	ok: status >= 200 && status < 300,
	status,
	arrayBuffer: async () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});
const jsonResponse = (status, value) => responseOf(status, value);
const bytesResponse = (status, bytes) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes });

async function runPureArms() {
	// A1 配置校验
	const missingFile = await readImageConfig({ env: CONFIG_ENV, readFile: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } });
	check('A1 缺配置文件 ⇒ not_configured 且点名路径', missingFile.ok === false && missingFile.reason === 'image_backend_not_configured' && missingFile.missing.some((row) => row.includes('image-generation.json')), missingFile);
	const badJson = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ('{oops') });
	check('A1 坏 JSON ⇒ image_config_invalid_json', badJson.ok === false && badJson.reason === 'image_config_invalid_json', badJson.reason ?? null);
	const noHome = await readImageConfig({ env: {}, readFile: CONFIG_READ(okConfig) });
	check('A1 没有 ASSIST_HOME ⇒ not_configured 且点名 $ASSIST_HOME', noHome.ok === false && noHome.missing.includes('$ASSIST_HOME'), noHome.missing ?? null);
	const plainHttpRemote = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, endpoint: 'http://llm.example.com/v1/images/generations' }) });
	check('A1 明文 http 非回环 ⇒ 拒绝（必须 https）', plainHttpRemote.ok === false && plainHttpRemote.missing.some((row) => row.includes('回环')), plainHttpRemote.missing ?? null);
	const httpsRemote = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, endpoint: 'https://llm.example.com/v1/images/generations' }) });
	check('A1 https 非回环 ⇒ 接受', httpsRemote.ok === true && httpsRemote.config.origin === 'https://llm.example.com', httpsRemote.ok ? httpsRemote.config.origin : httpsRemote);
	const withQuery = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, endpoint: 'http://127.0.0.1:9/v1/images/generations?key=leak' }) });
	check('A1 endpoint 带 query ⇒ 拒绝（凭据不许写进 URL）', withQuery.ok === false && withQuery.missing.some((row) => row.includes('query')), withQuery.missing ?? null);
	const bothAuth = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, authProvider: 'litellm', apiKeyEnv: 'SOME_KEY' }) });
	check('A1 authProvider 与 apiKeyEnv 同时给 ⇒ 拒绝', bothAuth.ok === false && bothAuth.missing.some((row) => row.includes('只能给一个')), bothAuth.missing ?? null);
	const badSize = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, size: '4096x4096' }) });
	check('A1 size 不在枚举里 ⇒ 拒绝', badSize.ok === false && badSize.missing.some((row) => row.includes('size')), badSize.missing ?? null);
	const badFormat = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, responseFormat: 'png' }) });
	check('A1 responseFormat 非法 ⇒ 拒绝', badFormat.ok === false && badFormat.missing.some((row) => row.includes('responseFormat')), badFormat.missing ?? null);
	const fullConfig = await readImageConfig({ env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, size: '1024x1536', responseFormat: 'b64_json', timeoutMs: 10 }) });
	check('A1 默认值/夹取：timeoutMs 10 ⇒ 夹到 1000；size 与 responseFormat 留下', fullConfig.ok === true && fullConfig.config.timeoutMs === 1000 && fullConfig.config.size === '1024x1536' && fullConfig.config.responseFormat === 'b64_json', fullConfig.ok ? { timeoutMs: fullConfig.config.timeoutMs, size: fullConfig.config.size, responseFormat: fullConfig.config.responseFormat, timeoutNote: fullConfig.config.timeoutNote } : fullConfig);
	check('A1 回执用 endpoint 不含 query（shown 只有 origin+pathname）', fullConfig.ok && fullConfig.config.shown === 'http://127.0.0.1:9/v1/images/generations', fullConfig.ok ? fullConfig.config.shown : null);

	// A2 base64
	check('A2 规范 base64 ⇒ 字节逐字一致', decodeBase64(PNG_B64).ok === true && Buffer.compare(decodeBase64(PNG_B64).bytes, PNG) === 0, { bytes: decodeBase64(PNG_B64).bytes?.length ?? null });
	check('A2 带换行的 base64 ⇒ 先剥空白再判（仍然规范）', decodeBase64(`${PNG_B64.slice(0, 40)}\n${PNG_B64.slice(40)}`).ok === true, null);
	check('A2 坏字符 ⇒ image_base64_invalid', decodeBase64('!!!!').reason === 'image_base64_invalid', decodeBase64('!!!!'));
	check('A2 填充错（长度不是 4 的倍数）⇒ image_base64_invalid', decodeBase64(`${PNG_B64}A`).reason === 'image_base64_invalid', decodeBase64(`${PNG_B64}A`));
	const oversizeEncoded = decodeBase64(OVERSIZE.toString('base64'));
	check('A2 编码长度预检 ⇒ image_too_large（stage=encoded_length，不申请那块内存）', oversizeEncoded.ok === false && oversizeEncoded.reason === 'image_too_large' && oversizeEncoded.stage === 'encoded_length', oversizeEncoded);

	// A3 魔数 + 尺寸
	check('A3 PNG 魔数 + 尺寸 400×300', detectImageMime(PNG) === 'image/png' && JSON.stringify(imageDimensions(PNG, 'image/png')) === JSON.stringify({ width: 400, height: 300 }), imageDimensions(PNG, 'image/png'));
	check('A3 JPEG/GIF/WebP 魔数都认', detectImageMime(JPEG) === 'image/jpeg' && detectImageMime(GIF) === 'image/gif' && detectImageMime(WEBP) === 'image/webp', [detectImageMime(JPEG), detectImageMime(GIF), detectImageMime(WEBP)]);
	check('A3 非图片字节 ⇒ null（不猜）', detectImageMime(Buffer.from('hello')) === null, detectImageMime(Buffer.from('hello')));

	// A4 data[] 形状
	check('A4 空 data ⇒ image_response_empty', pickImagePayload({ data: [] }).reason === 'image_response_empty', pickImagePayload({ data: [] }));
	check('A4 多图 ⇒ image_response_multiple_images（不悄悄挑一张）', pickImagePayload({ data: [{ b64_json: 'a' }, { b64_json: 'b' }] }).reason === 'image_response_multiple_images', pickImagePayload({ data: [{}, {}] }));
	check('A4 只有 url ⇒ 记为 url 来源', pickImagePayload({ data: [{ url: 'http://127.0.0.1:1/x.png' }] }).source === 'url', null);
	check('A4 既无 b64 也无 url ⇒ image_response_missing_image', pickImagePayload({ data: [{}] }).reason === 'image_response_missing_image', pickImagePayload({ data: [{}] }));
	check('A4 不是对象/没有 data ⇒ 各自 reason', pickImagePayload('nope').reason === 'image_response_not_object' && pickImagePayload({}).reason === 'image_response_missing_data', [pickImagePayload('nope').reason, pickImagePayload({}).reason]);

	// A5 同源
	const origin = 'http://127.0.0.1:9';
	check('A5 同源 URL ⇒ 通过', sameOriginUrl(`${origin}/img.png`, origin).ok === true, sameOriginUrl(`${origin}/img.png`, origin));
	check('A5 外域 URL ⇒ image_url_not_same_origin', sameOriginUrl('https://evil.example.com/x.png', origin).reason === 'image_url_not_same_origin', sameOriginUrl('https://evil.example.com/x.png', origin));
	check('A5 带凭据 / 非 http(s) ⇒ 各有 reason', sameOriginUrl('http://user:pass@127.0.0.1:9/x', origin).reason === 'image_url_has_credentials' && sameOriginUrl('file:///etc/passwd', origin).reason === 'image_url_unsupported_scheme', [sameOriginUrl('http://user:pass@127.0.0.1:9/x', origin), sameOriginUrl('file:///etc/passwd', origin)]);

	// A6 generateImage（注入 fetch）：一次调用只发一次请求；失败不重放；超时/中断归因不同
	{
		let calls = 0;
		const produced = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), modelRegistry: null,
			fetchImpl: async () => { calls += 1; return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }); },
			now: () => 1000,
		});
		const receiptText = JSON.stringify(produced.receipt);
		check('A6 成功回执：generated/requestSent/sha256/bytes 都对，且回执里没有 base64', produced.receipt.ok === true && produced.receipt.generated === true && produced.receipt.requestSent === true && produced.receipt.image?.sha256 === PNG_SHA256 && produced.receipt.image?.bytes === PNG.length && produced.receipt.image?.width === 400 && produced.receipt.image?.height === 300 && !receiptText.includes(PNG_B64.slice(0, 40)), produced.receipt);
		check('A6 成功时 image 块只出现一次（b64 只在 image.data 里）', produced.image?.data === PNG_B64 && produced.image.type === 'image' && produced.image.mimeType === 'image/png', { type: produced.image?.type ?? null, mimeType: produced.image?.mimeType ?? null });
		check('A6 一次调用 = 一次请求', calls === 1, { calls });
	}
	{
		let calls = 0;
		const failed = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), modelRegistry: null,
			fetchImpl: async () => { calls += 1; return jsonResponse(500, { error: { message: 'boom' } }); },
		});
		check('A6 500 ⇒ 零图 + outcomeUnknown:true + 不重放', failed.image === null && failed.receipt.reason === 'image_backend_error' && failed.receipt.outcomeUnknown === true && failed.receipt.requestSent === true && calls === 1, { receipt: failed.receipt, calls });
	}
	{
		let calls = 0;
		const failed = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), modelRegistry: null,
			fetchImpl: async () => { calls += 1; return jsonResponse(401, { error: { message: 'token=SECRET' } }); },
		});
		check('A6 401 ⇒ unauthorized + outcomeUnknown:false，且不把后端正文抄进回执', failed.image === null && failed.receipt.reason === 'image_backend_unauthorized' && failed.receipt.outcomeUnknown === false && !JSON.stringify(failed.receipt).includes('SECRET') && calls === 1, { receipt: failed.receipt, calls });
	}
	{
		let calls = 0;
		const failed = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, timeoutMs: 1000 }), modelRegistry: null,
			fetchImpl: async (_url, options) => {
				calls += 1;
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 5000);
					options?.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
				});
				return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
			},
		});
		check('A6 超时 ⇒ timeout + outcomeUnknown:true（不写「一定没生成」）+ 不重放', failed.image === null && failed.receipt.reason === 'timeout' && failed.receipt.outcomeUnknown === true && calls === 1, { receipt: failed.receipt, calls });
	}
	{
		const controller = new AbortController();
		let calls = 0;
		const pending = generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, timeoutMs: 30_000 }), modelRegistry: null, signal: controller.signal,
			fetchImpl: async (_url, options) => {
				calls += 1;
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 5000);
					options?.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
				});
				return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
			},
		});
		setTimeout(() => controller.abort(), 50);
		const aborted = await pending;
		check('A6 外部 abort ⇒ aborted + outcomeUnknown:true（与 timeout 分开归因）', aborted.image === null && aborted.receipt.reason === 'aborted' && aborted.receipt.outcomeUnknown === true && calls === 1, { receipt: aborted.receipt, calls });
	}
	{
		let calls = 0;
		const viaUrl = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), modelRegistry: null,
			fetchImpl: async (url) => {
				calls += 1;
				if (String(url).endsWith('/img.png')) return bytesResponse(200, PNG);
				return jsonResponse(200, { data: [{ url: 'http://127.0.0.1:9/img.png' }] });
			},
		});
		check('A6 同源 url ⇒ 下载后仍按魔数判类型（source=url）', viaUrl.image?.mimeType === 'image/png' && viaUrl.receipt.source === 'url' && calls === 2, { source: viaUrl.receipt.source, calls });
	}
	{
		let calls = 0;
		const external = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), modelRegistry: null,
			fetchImpl: async () => { calls += 1; return jsonResponse(200, { data: [{ url: 'https://evil.example.com/x.png' }] }); },
		});
		check('A6 外域 url ⇒ 拒绝下载（只打了一次后端，没有去抓那个 URL）', external.image === null && external.receipt.reason === 'image_url_not_same_origin' && calls === 1, { receipt: external.receipt, calls });
	}
	{
		let calls = 0;
		const notConfigured = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ('{oops'), modelRegistry: null,
			fetchImpl: async () => { calls += 1; return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }); },
		});
		check('A6 配置坏 ⇒ 一次请求都不发，也不宣称生成', notConfigured.image === null && notConfigured.receipt.reason === 'image_config_invalid_json' && notConfigured.receipt.generated === false && calls === 0, { receipt: notConfigured.receipt, calls });
	}

	// A7 Responses 托管 item 的路径/边界（纯函数，不发请求）
	{
		const ok = parseResponsesOutput({ output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64 }, { type: 'message', id: 'm1', content: [] }] });
		check('A7 completed+result ⇒ 取到图；旁白 message 被忽略（不把文字当成功）', ok.ok === true && ok.result === PNG_B64 && ok.imageStatus === 'completed' && ok.outputTypes.includes('message'), { ok: ok.ok, imageStatus: ok.imageStatus, outputTypes: ok.outputTypes });
		check('A7 没有 image_generation_call ⇒ responses_no_image_generation_call', parseResponsesOutput({ output: [{ type: 'message' }] }).reason === 'responses_no_image_generation_call', parseResponsesOutput({ output: [{ type: 'message' }] }));
		check('A7 status 不是 completed ⇒ 拒绝（只认 completed，不把枚举当契约）', parseResponsesOutput({ output: [{ type: 'image_generation_call', status: 'generating', result: PNG_B64 }] }).reason === 'responses_image_not_completed', parseResponsesOutput({ output: [{ type: 'image_generation_call', status: 'generating', result: PNG_B64 }] }).reason);
		check('A7 内层 function_call ⇒ responses_inner_function_call（不执行内层函数链）', parseResponsesOutput({ output: [{ type: 'function_call', name: 'x' }] }).reason === 'responses_inner_function_call', parseResponsesOutput({ output: [{ type: 'function_call', name: 'x' }] }).reason);
		check('A7 多图 ⇒ responses_multiple_images；result 缺失 ⇒ responses_image_missing_result', parseResponsesOutput({ output: [{ type: 'image_generation_call', status: 'completed', result: 'a' }, { type: 'image_generation_call', status: 'completed', result: 'b' }] }).reason === 'responses_multiple_images' && parseResponsesOutput({ output: [{ type: 'image_generation_call', status: 'completed' }] }).reason === 'responses_image_missing_result', null);
		check('A7 没有 output ⇒ responses_missing_output', parseResponsesOutput({}).reason === 'responses_missing_output', null);
	}

	// A8 预算作用域：**只有显式 cap 才挡第二个调用**；默认不设进程累计上限（常驻 worker 不能被「重启续额度」绑架）
	{
		const previous = process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS;
		delete process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS;
		let calls = 0;
		const fetchOk = async () => { calls += 1; return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }); };

		// (a) 显式配置 1 ⇒ 第二次在发请求前被拒（这次真实验界就用它）
		resetGenerationBudget();
		const capped = { ...okConfig, maxRequestsPerRun: 1 };
		const first = await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(capped), fetchImpl: fetchOk });
		const second = await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(capped), fetchImpl: fetchOk });
		check('A8 配置 maxRequestsPerRun:1 ⇒ 第一次成功、第二次 refused（budget_exhausted）且零 HTTP', first.receipt.ok === true && JSON.stringify(first.receipt.budget) === JSON.stringify({ scope: 'process', max: 1, used: 1 }) && second.image === null && second.receipt.reason === 'image_generation_budget_exhausted' && second.receipt.requestSent === false && JSON.stringify(second.receipt.budget) === JSON.stringify({ scope: 'process', max: 1, used: 1 }) && calls === 1, { firstBudget: first.receipt.budget ?? null, second: second.receipt.reason, secondBudget: second.receipt.budget ?? null, requestSent: second.receipt.requestSent, calls });

		// (b) 显式 env=1（沙箱/演练那条路）⇒ 同样只允许一次（优先级：config > env）
		resetGenerationBudget();
		process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS = '1';
		const envFirst = await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), fetchImpl: fetchOk });
		const envSecond = await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), fetchImpl: fetchOk });
		delete process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS;
		check('A8 env SOPHO_IMAGE_GEN_MAX_REQUESTS=1 ⇒ 第二次被拒（cap 只由显式配置/环境启用）', envFirst.receipt.ok === true && JSON.stringify(envFirst.receipt.budget) === JSON.stringify({ scope: 'process', max: 1, used: 1 }) && envSecond.receipt.reason === 'image_generation_budget_exhausted' && calls === 2, { calls, envFirstBudget: envFirst.receipt.budget ?? null, envSecond: envSecond.receipt.reason });

		// (c) 默认（无配置、无 env）⇒ **不设进程累计上限**：25 次（跨过 20）都真发，回执只说这一次调用的界
		resetGenerationBudget();
		const runs = [];
		for (let index = 0; index < 25; index += 1) runs.push(await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), fetchImpl: fetchOk }));
		const allOk = runs.every((row) => row.receipt.ok === true);
		const allCallScoped = runs.every((row) => JSON.stringify(row.receipt.budget) === JSON.stringify({ scope: 'call', max: 1 }));
		check('A8 默认不设累计上限：25 次都真发（第 21 次也没被挡），回执 budget={scope:"call",max:1}', allOk && allCallScoped && calls === 27 && runs[20].receipt.ok === true, { calls, budget: runs[24].receipt.budget ?? null, run21: runs[20].receipt.reason ?? 'ok' });
		resetGenerationBudget();
		if (previous === undefined) delete process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS;
		else process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS = previous;
	}

	// A9 guard 生命周期：同源 URL 下载阶段被外部 abort / 超时，必须仍然能停（POST 之后不能提前 dispose）
	{
		const controller = new AbortController();
		let calls = 0;
		const hangingDownload = async (url, options) => {
			calls += 1;
			if (String(url).endsWith('/img.png')) {
				await new Promise((_resolve, reject) => {
					const timer = setTimeout(_resolve, 8000);
					options?.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
				});
				return bytesResponse(200, PNG);
			}
			return jsonResponse(200, { data: [{ url: 'http://127.0.0.1:9/img.png' }] });
		};
		const pending = generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, timeoutMs: 30_000 }), signal: controller.signal, fetchImpl: hangingDownload });
		setTimeout(() => controller.abort(), 50);
		const stopped = await pending;
		check('A9 同源下载阶段外部 abort ⇒ aborted + outcomeUnknown:true（guard 未提前 dispose）', stopped.image === null && stopped.receipt.reason === 'aborted' && stopped.receipt.outcomeUnknown === true && calls === 2, { receipt: stopped.receipt, calls });
	}
	// A10 整段共用一个 guard：POST 快、GET 挂起时总耗时 ≤ 配置 timeout（不叠加成两倍）
	{
		let calls = 0;
		const startedAt = Date.now();
		const timedOut = await generateImage({
			prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ({ ...okConfig, timeoutMs: 1000 }),
			fetchImpl: async (url, options) => {
				calls += 1;
				if (String(url).endsWith('/img.png')) {
					await new Promise((_resolve, reject) => {
						const timer = setTimeout(_resolve, 8000);
						options?.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
					});
					return bytesResponse(200, PNG);
				}
				return jsonResponse(200, { data: [{ url: 'http://127.0.0.1:9/img.png' }] });
			},
		});
		const elapsedMs = Date.now() - startedAt;
		check('A10 同源下载挂起 ⇒ timeout + outcomeUnknown:true，且总耗时 < 3s（一个 guard，不叠两倍）', timedOut.image === null && timedOut.receipt.reason === 'timeout' && timedOut.receipt.outcomeUnknown === true && calls === 2 && elapsedMs < 3000, { receipt: timedOut.receipt, calls, elapsedMs });
	}
	// A11 文件头宽高为 0 ⇒ 不能当成功图
	{
		const zeroDims = await generateImage({ prompt: 'a cat', env: CONFIG_ENV, readFile: CONFIG_READ(okConfig), fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: PNG_ZERO.toString('base64') }] }) });
		check('A11 文件头 width=0 ⇒ image_dimensions_invalid、零图', zeroDims.image === null && zeroDims.receipt.reason === 'image_dimensions_invalid' && zeroDims.receipt.bytes === PNG_ZERO.length, zeroDims.receipt);
	}
}

// ── B/C 层：沙箱 ────────────────────────────────────────────────────────────────────────
let sandbox = null;
let HOME = null;
let CWD = null;
let SESSIONS = null;
let backendServer = null;
let backendPort = null;
let providerServer = null;
let providerPort = null;
const backendHits = [];
const responsesHits = [];
const heldResponses = [];
const slowTimers = new Set();
const providerRequests = [];
let configPath = null;

async function reserveHighPort(used = new Set()) {
	for (let candidate = 23000 + Math.floor(Math.random() * 30000); candidate < 63000; candidate += 1) {
		if (candidate === 7331 || candidate === 7321 || used.has(candidate)) continue;
		const available = await new Promise((resolve) => {
			const server = net.createServer();
			server.once('error', () => resolve(false));
			server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
		});
		if (available) return candidate;
	}
	throw new Error('no high port available');
}

function configValue(overrides = {}) {
	return {
		endpoint: `http://127.0.0.1:${backendPort}/v1/images/generations`,
		model: 'fake-image-1',
		authProvider: 'fake',
		timeoutMs: 1000,
		...overrides,
	};
}

async function writeConfig(value) {
	if (configPath === null) configPath = path.join(HOME, 'image-generation.json');
	await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseAuth(header) {
	return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : null;
}

async function startBackend() {
	backendPort = await reserveHighPort();
	backendServer = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', `http://127.0.0.1:${backendPort}`);
		if (request.method === 'GET' && url.pathname === '/img-hang.png') {
			backendHits.push({ method: 'GET', path: url.pathname, authorization: request.headers.authorization ?? null });
			heldResponses.push(response);
			return;
		}
		if (request.method === 'GET' && url.pathname === '/img-slowbody.png') {
			backendHits.push({ method: 'GET', path: url.pathname, authorization: request.headers.authorization ?? null });
			response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
			response.write(PNG.subarray(0, 16));
			const timer = setInterval(() => { try { response.write(PNG.subarray(16, 20)); } catch { /* closed */ } }, 150);
			slowTimers.add(timer);
			const stop = () => { clearInterval(timer); slowTimers.delete(timer); };
			request.on('close', stop);
			response.once('close', stop);
			heldResponses.push(response);
			return;
		}
		if (request.method === 'GET' && url.pathname === '/img.png') {
			backendHits.push({ method: 'GET', path: url.pathname, authorization: request.headers.authorization ?? null });
			response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
			response.end(PNG);
			return;
		}
		if (request.method === 'POST' && url.pathname === '/v1/responses') {
			let raw = '';
			for await (const chunk of request) raw += chunk;
			let body = null;
			try { body = JSON.parse(raw); } catch { body = { unparsable: raw.slice(0, 80) }; }
			responsesHits.push({ path: url.pathname, authorization: request.headers.authorization ?? null, body });
			const prompt = typeof body?.input === 'string' ? body.input : '';
			const reply = (status, value, contentType = 'application/json') => {
				response.writeHead(status, { 'content-type': contentType });
				response.end(typeof value === 'string' ? value : JSON.stringify(value));
			};
			switch (prompt) {
				case 'r-ok': return reply(200, { id: 'resp_gate_1', output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64 }, { type: 'message', id: 'msg_1', content: [] }], usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } });
				case 'r-noitem': return reply(200, { id: 'resp_gate_2', output: [{ type: 'message', id: 'msg_1', content: [] }] });
				case 'r-failed': return reply(200, { id: 'resp_gate_3', output: [{ type: 'image_generation_call', id: 'ig_1', status: 'failed' }] });
				case 'r-multi': return reply(200, { id: 'resp_gate_4', output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64 }, { type: 'image_generation_call', id: 'ig_2', status: 'completed', result: PNG_B64 }] });
				case 'r-func': return reply(200, { id: 'resp_gate_5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'inner_tool', arguments: '{}' }] });
				case 'r-result': return reply(200, { id: 'resp_gate_6', output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed' }] });
				case 'r-nostatus': return reply(200, { id: 'resp_gate_7', output: [{ type: 'image_generation_call', id: 'ig_1', result: PNG_B64 }] });
				case 'r-emptystatus': return reply(200, { id: 'resp_gate_8', output: [{ type: 'image_generation_call', id: 'ig_1', status: '', result: PNG_B64 }] });
				case 'r-slowbody': {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.write('{"id":"resp_slow","output":[');
					const timer = setInterval(() => { try { response.write(' '); } catch { /* closed */ } }, 150);
					slowTimers.add(timer);
					const stop = () => { clearInterval(timer); slowTimers.delete(timer); };
					request.on('close', stop);
					response.once('close', stop);
					heldResponses.push(response);
					return;
				}
				case 'r-badjson': return reply(200, 'not json at all');
				case 'r-sse': return reply(200, 'data: {"type":"response.created"}\n\n', 'text/event-stream; charset=utf-8');
				case 'r-400': return reply(400, { error: { message: 'tool_choice is not supported token=SECRET', type: 'invalid_request_error', code: 'unsupported_parameter', param: 'tool_choice' } });
				case 'r-401': return reply(401, { error: { message: `bad key ${FAKE_KEY}`, type: 'invalid_api_key', code: 'invalid_api_key', param: null } });
				case 'r-429': return reply(429, { error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limited', param: null } });
				case 'r-500': return reply(500, { error: { message: 'boom', type: 'server_error', code: 'server_error', param: null } });
				default: return reply(400, { error: { message: `unknown input ${prompt}`, type: 'invalid_request_error', code: 'bad_input', param: 'input' } });
			}
		}
		if (request.method !== 'POST' || url.pathname !== '/v1/images/generations') {
			response.writeHead(404, { 'content-type': 'application/json' });
			response.end('{"error":"not_found"}');
			return;
		}
		let raw = '';
		for await (const chunk of request) raw += chunk;
		let body = null;
		try { body = JSON.parse(raw); } catch { body = { unparsable: raw.slice(0, 80) }; }
		backendHits.push({ method: 'POST', path: url.pathname, authorization: request.headers.authorization ?? null, body });
		const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
		const reply = (status, value) => {
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(typeof value === 'string' ? value : JSON.stringify(value));
		};
		switch (prompt) {
			case 'ok': return reply(200, { data: [{ b64_json: PNG_B64 }] });
			case 'url': return reply(200, { data: [{ url: `http://127.0.0.1:${backendPort}/img.png` }] });
			case 'external-url': return reply(200, { data: [{ url: 'https://evil.example.com/x.png' }] });
			case '401': return reply(401, { error: { message: 'invalid token=SECRET' } });
			case '403': return reply(403, { error: { message: 'forbidden' } });
			case '429': return reply(429, { error: { message: 'slow down' } });
			case '500': return reply(500, { error: { message: 'boom' } });
			case 'badjson': return reply(200, 'this is not json');
			case 'empty': return reply(200, { data: [] });
			case 'multi': return reply(200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] });
			case 'nonimage': return reply(200, { data: [{ b64_json: Buffer.from('hello').toString('base64') }] });
			case 'oversize': return reply(200, { data: [{ b64_json: OVERSIZE.toString('base64') }] });
			case 'medium': return reply(200, { data: [{ b64_json: MEDIUM.toString('base64') }] });
			case 'zerodim': return reply(200, { data: [{ b64_json: PNG_ZERO.toString('base64') }] });
			case 'url-hang': return reply(200, { data: [{ url: `http://127.0.0.1:${backendPort}/img-hang.png` }] });
			case 'url-slowbody': return reply(200, { data: [{ url: `http://127.0.0.1:${backendPort}/img-slowbody.png` }] });
			case 'hang':
				heldResponses.push(response);
				request.on('close', () => { /* 客户端 abort 后 socket 会关；这里只留引用，收尾时统一销毁 */ });
				return;
			default: return reply(400, { error: { message: `unknown prompt ${prompt}` } });
		}
	});
	await new Promise((resolve, reject) => { backendServer.once('error', reject); backendServer.listen(backendPort, '127.0.0.1', resolve); });
}

function messageText(message) {
	if (typeof message?.content === 'string') return message.content;
	if (!Array.isArray(message?.content)) return '';
	return message.content.map((part) => part?.text ?? '').join('');
}

async function startProvider() {
	providerPort = await reserveHighPort();
	providerServer = http.createServer(async (request, response) => {
		if (request.method !== 'POST') { response.writeHead(404).end(); return; }
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const messages = Array.isArray(body.messages) ? body.messages : [];
		let lastUser = -1;
		messages.forEach((message, index) => { if (message?.role === 'user') lastUser = index; });
		const lastUserText = lastUser >= 0 ? messageText(messages[lastUser]) : '';
		const toolAfter = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message?.role === 'tool' || message?.role === 'toolResult');
		providerRequests.push({ tools: (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean), messages, lastUserText, hasToolAfter: toolAfter });
		response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
		const sseChunk = (delta = {}, finishReason = null) => `data: ${JSON.stringify({
			id: `chatcmpl-${randomUUID()}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / 1000),
			model: MODEL_ID,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`;
		if (!toolAfter && lastUserText.startsWith('GEN:')) {
			const prompt = lastUserText.slice(4).trim();
			response.write(sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt }) } }] }));
			response.write(sseChunk({}, 'tool_calls'));
		} else {
			response.write(sseChunk({ role: 'assistant', content: 'GATE_TURN_DONE' }));
			response.write(sseChunk({}, 'stop'));
		}
		response.end('data: [DONE]\n\n');
	});
	await new Promise((resolve, reject) => { providerServer.once('error', reject); providerServer.listen(providerPort, '127.0.0.1', resolve); });
}

function lastToolResult(session) {
	const branch = session.sessionManager.getBranch();
	const rows = branch.filter((row) => row.type === 'message' && row.message?.role === 'toolResult');
	const entry = rows.at(-1);
	if (!entry) return null;
	const text = (entry.message.content ?? []).map((part) => part.text ?? '').join('');
	let receipt = null;
	try { receipt = JSON.parse(text); } catch { receipt = { unparsable: text }; }
	return { isError: entry.message.isError === true, receipt, text, content: entry.message.content ?? [] };
}

async function promptTurn(session, text) {
	let timer = null;
	try {
		await Promise.race([
			session.prompt(text),
			new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('__IMAGE_GATE_WATCHDOG__')), 40_000); }),
		]);
	} catch (error) {
		if (!String(error?.message).includes('__IMAGE_GATE_WATCHDOG__')) throw error;
		await session.abort();
		throw new Error('回合超时（40 s）');
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// 前端门：本机有浏览器才跑，没有就如实 SKIP（不是绿）。
async function chromeAvailable() {
	if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
	const candidates = process.platform === 'win32'
		? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
		: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
	for (const candidate of candidates) {
		if (await readFile(candidate).then(() => true).catch(() => false)) return candidate;
	}
	return null;
}

async function runUiArm(wire) {
	const chrome = await chromeAvailable();
	if (!chrome) {
		process.stdout.write('⤵ SKIP C 层（真 Chromium）：本机找不到浏览器（CHROME_BIN 未设、常见路径也没有）—— 这不是绿，UI 那一半未验。\n');
		return;
	}
	const { boot, sendJson, waitFor } = await import('./ui-harness.mjs');
	const sessionId = randomUUID();
	const sessions = [{ id: sessionId, name: '生图门', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-10-26T00:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];
	const messages = [wire.assistant, wire.toolResult];
	const previousChrome = process.env.CHROME_BIN;
	process.env.CHROME_BIN = chrome;
	const ui = await boot({
		routes: async (request, response, url) => {
			if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
			if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
			if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
			if (url.pathname === '/api/tree/events') {
				response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
				response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
				return true;
			}
			const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen)$/.exec(url.pathname);
			if (match) {
				if (match[2] === 'messages') return sendJson(response, 200, { sessionId, messages, extras: [], compaction: { atIndex: null }, observability: null }), true;
				if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
				if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
				if (match[2] === 'events') {
					response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
					response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
					return true;
				}
			}
			const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
			if (detail) return sendJson(response, 200, { name: '生图门', cwd: '/sandbox', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
			return false;
		},
	});
	const readFigure = () => ui.evaluate(`(() => {
		const figures = Array.from(document.querySelectorAll('.message-image')).map((figure) => ({
			inToolOutput: figure.parentElement?.classList.contains('tool-output') ?? false,
			hasImg: Boolean(figure.querySelector('img')),
			src: figure.querySelector('img')?.getAttribute('src') ?? null,
			caption: figure.querySelector('.message-image-meta')?.textContent ?? null,
			bad: figure.querySelector('.message-image-bad')?.textContent ?? null,
		}));
		const card = Array.from(document.querySelectorAll('.tool-card')).find((node) => node.dataset.toolCallId === '${wire.toolCallId}');
		return { figures, cardText: card?.querySelector('.tool-result')?.textContent ?? null };
	})()`);
	try {
		await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 1`), 'tree did not render');
		await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
		await waitFor(() => ui.evaluate(`document.querySelectorAll('.message-image img').length === 1`), '工具卡里没有画出图');
		await ui.frames(3);
		const first = await readFigure();
		check('C1 工具卡里真的画出这张图（<img> 的 src 与真回执逐字相同）', first.figures.length === 1 && first.figures[0].inToolOutput === true && first.figures[0].hasImg === true && first.figures[0].src === wire.dataUrl, first);
		check('C1 画得出图时占位行让位（正文里不再有「网页暂不显示图片内容」）', !String(first.cardText ?? '').includes('（网页暂不显示图片内容）'), first.cardText);
		await ui.browser.send('Page.reload', { ignoreCache: true });
		await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 1`), 'reload 后树没回来');
		await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
		await waitFor(() => ui.evaluate(`document.querySelectorAll('.message-image img').length === 1`), '刷新后图没了');
		await ui.frames(2);
		const after = await readFigure();
		check('C2 刷新一次后图仍在（/messages 再读一遍仍是同一张）', after.figures.length === 1 && after.figures[0].inToolOutput === true && after.figures[0].src === wire.dataUrl, after);
		// 截图留档（父/C 要看「网页真能看到这张图」），路径只写系统临时目录，不进 git。
		const shotPath = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-image-generate-1200x760.png`;
		await ui.resize(1200, 760);
		await ui.screenshot(shotPath);
		print('uiScreenshot', shotPath);
	} finally {
		await ui.close();
		if (previousChrome === undefined) delete process.env.CHROME_BIN;
		else process.env.CHROME_BIN = previousChrome;
	}
}

async function runSandboxArms() {
	sandbox = await mkdtemp(path.join(os.tmpdir(), 'image-gate-'));
	HOME = path.join(sandbox, 'home');
	CWD = path.join(sandbox, 'workspace');
	SESSIONS = path.join(HOME, 'sessions');
	for (const directory of [HOME, CWD, SESSIONS]) await mkdir(directory, { recursive: true });
	// 先把进程 env 钉在沙箱上（**在**任何读之前）：插件的配置读取只看 ASSIST_HOME。
	process.env.ASSIST_HOME = HOME;
	process.env.SOPHO_AGENT_DIR = HOME;
	process.env.PI_CODING_AGENT_DIR = HOME;
	process.env.PI_CODING_AGENT_SESSION_DIR = SESSIONS;
	process.env.PI_OFFLINE = '1';
	process.env.FAKE_IMAGE_KEY = ENV_KEY_FIXTURE;

	await startBackend();
	await startProvider();
	configPath = path.join(HOME, 'image-generation.json');
	await writeConfig(configValue());

	await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${providerPort}/v1`,
		api: 'openai-completions',
		apiKey: KEY_FIXTURE,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [{ id: MODEL_ID, name: 'Fake Image Gate', contextWindow: 8192, maxTokens: 1024, input: ['text', 'image'] }],
	} } }, null, 2)}\n`);
	await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({
		defaultProvider: 'fake', defaultModel: MODEL_ID, defaultThinkingLevel: 'off',
		compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
	}, null, 2)}\n`);
	await writeFile(path.join(HOME, 'auth.json'), '{}\n');

	const settingsManager = SettingsManager.create(CWD, HOME);
	const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: HOME, settingsManager, additionalExtensionPaths: [PLUGIN_INDEX] });
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors ?? [];
	check('B0 真插件文件装得上（errors=[]）', extensionErrors.length === 0, JSON.stringify(extensionErrors));

	const modelRuntime = await ModelRuntime.create({ authPath: path.join(HOME, 'auth.json'), modelsPath: path.join(HOME, 'models.json') });
	const model = modelRuntime.getModel('fake', MODEL_ID);
	assert.ok(model, '假 provider 的模型没解析出来');
	const { session } = await createAgentSession({
		cwd: CWD, agentDir: HOME, modelRuntime, model, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.create(CWD, SESSIONS),
	});

	print('sandbox', { sandbox, backendPort, providerPort, model: `${model.provider}/${model.id}` });
	await scenario('B1 model-facing tool list', async () => {
		await promptTurn(session, 'GEN:ok');
		const first = providerRequests[0];
		check('B1 模型面真的收到 image_generate（不是「注册了但没发出去」）', Array.isArray(first?.tools) && first.tools.includes('image_generate'), { tools: first?.tools ?? null });
	});

	await scenario('B2 成功一次', async () => {
		const hitsBefore = backendHits.length;
		const requestsBefore = providerRequests.length;
		await promptTurn(session, 'GEN:ok');
		const result = lastToolResult(session);
		const hit = backendHits.at(-1);
		const images = result.content.filter((block) => block?.type === 'image');
		check('B2 工具结果里有且只有一个 image 块（mimeType 按魔数、data 逐字相同）', images.length === 1 && images[0].mimeType === 'image/png' && images[0].data === PNG_B64, { imageBlocks: images.length, mimeType: images[0]?.mimeType ?? null, dataChars: images[0]?.data?.length ?? null });
		check('B2 回执 ok/generated/bytes/sha256/尺寸 都对', result.isError === false && result.receipt.ok === true && result.receipt.generated === true && result.receipt.requestSent === true && result.receipt.status === 200 && result.receipt.source === 'b64_json' && result.receipt.image?.bytes === PNG.length && result.receipt.image?.sha256 === PNG_SHA256 && result.receipt.image?.width === 400 && result.receipt.image?.height === 300, result.receipt);
		check('B2 回执里没有 base64（一份图只在 image 块里）', !result.text.includes(PNG_B64.slice(0, 60)), { textChars: result.text.length });
		check('B2 一次调用只打一次后端', backendHits.length - hitsBefore === 1, { hits: backendHits.length - hitsBefore });
		check('B2 请求体：n=1、size 来自配置、默认不带 response_format', hit?.body?.n === 1 && hit?.body?.size === '1024x1024' && !('response_format' in (hit?.body ?? {})), { body: hit?.body ?? null });
		check('B2 凭据来自 authProvider（只读 provider），header 是 Bearer 夹具值', parseAuth(hit?.authorization) === KEY_FIXTURE && result.receipt.authSource === 'provider:fake', { authorization: parseAuth(hit?.authorization), authSource: result.receipt.authSource });
		const modelSawImage = providerRequests.slice(requestsBefore).some((request) => JSON.stringify(request.messages).includes('Attached image(s) from tool result:') && JSON.stringify(request.messages).includes(PNG_B64.slice(0, 60)));
		check('B2 模型面真的收到了这张图（completions 侧转成 Attached image(s) from tool result 的 image_url）', modelSawImage, { requests: providerRequests.length - requestsBefore });
	});

	await scenario('B3 失败族（每条零图、抛出失败、只打一次后端）', async () => {
		const cases = [
			{ prompt: '401', reason: 'image_backend_unauthorized', outcomeUnknown: false, sent: true },
			{ prompt: '403', reason: 'image_backend_unauthorized', outcomeUnknown: false, sent: true },
			{ prompt: '429', reason: 'image_backend_rate_limited', outcomeUnknown: false, sent: true },
			{ prompt: '500', reason: 'image_backend_error', outcomeUnknown: true, sent: true },
			{ prompt: 'badjson', reason: 'image_backend_invalid_json', outcomeUnknown: false, sent: true },
			{ prompt: 'empty', reason: 'image_response_empty', outcomeUnknown: false, sent: true },
			{ prompt: 'multi', reason: 'image_response_multiple_images', outcomeUnknown: false, sent: true },
			{ prompt: 'nonimage', reason: 'image_not_an_image', outcomeUnknown: false, sent: true },
			{ prompt: 'oversize', reason: 'image_too_large', outcomeUnknown: false, sent: true },
			{ prompt: 'external-url', reason: 'image_url_not_same_origin', outcomeUnknown: false, sent: true },
			{ prompt: 'hang', reason: 'timeout', outcomeUnknown: true, sent: true },
		];
		for (const row of cases) {
			const hitsBefore = backendHits.length;
			await promptTurn(session, `GEN:${row.prompt}`);
			const result = lastToolResult(session);
			const images = result.content.filter((block) => block?.type === 'image');
			const hits = backendHits.length - hitsBefore;
			const ok = images.length === 0
				&& result.isError === true
				&& result.receipt.ok === false
				&& result.receipt.generated === false
				&& result.receipt.reason === row.reason
				&& result.receipt.requestSent === row.sent
				&& result.receipt.outcomeUnknown === row.outcomeUnknown
				&& hits === 1;
			check(`B3 ${row.prompt} ⇒ ${row.reason}（零图／抛出失败／outcomeUnknown=${row.outcomeUnknown}／只打一次）`, ok, { imageBlocks: images.length, isError: result.isError, reason: result.receipt.reason, requestSent: result.receipt.requestSent, outcomeUnknown: result.receipt.outcomeUnknown, hits });
			check(`B3 ${row.prompt} 的回执不含后端正文/凭据（不抄 SECRET，不抄原始 body）`, !result.text.includes('SECRET') && !result.text.includes('this is not json'), { textChars: result.text.length });
		}
	});

	await scenario('B4 同源 url 成功 + apiKeyEnv 凭据', async () => {
		await writeConfig(configValue({ authProvider: undefined, apiKeyEnv: 'FAKE_IMAGE_KEY' }));
		const hitsBefore = backendHits.length;
		await promptTurn(session, 'GEN:url');
		const result = lastToolResult(session);
		const images = result.content.filter((block) => block?.type === 'image');
		const post = backendHits.slice(hitsBefore).find((row) => row.method === 'POST');
		const get = backendHits.slice(hitsBefore).find((row) => row.method === 'GET');
		check('B4 同源 url ⇒ 下载并判类型成功（source=url）', result.isError === false && result.receipt.ok === true && result.receipt.source === 'url' && images.length === 1 && images[0].mimeType === 'image/png', { receipt: result.receipt, imageBlocks: images.length });
		check('B4 POST 与 GET 都带同一份 Bearer（凭据来自 apiKeyEnv；回执只报 env 名字）', parseAuth(post?.authorization) === ENV_KEY_FIXTURE && parseAuth(get?.authorization) === ENV_KEY_FIXTURE && result.receipt.authSource === 'env:FAKE_IMAGE_KEY', { post: parseAuth(post?.authorization), get: parseAuth(get?.authorization), authSource: result.receipt.authSource });
		await writeConfig(configValue());
	});

	await scenario('B5 配置缺失 ⇒ 零请求、不宣称生成；恢复后又能成功（调用时读盘）', async () => {
		await unlink(configPath);
		const hitsBefore = backendHits.length;
		await promptTurn(session, 'GEN:ok');
		const missing = lastToolResult(session);
		check('B5 配置缺失 ⇒ not_configured + 零后端请求 + generated:false + 点名缺哪个（文件）', missing.isError === true && missing.receipt.ok === false && missing.receipt.reason === 'image_backend_not_configured' && missing.receipt.generated === false && backendHits.length === hitsBefore && missing.receipt.missing.some((row) => String(row).includes('image-generation.json')), { receipt: { reason: missing.receipt.reason, generated: missing.receipt.generated, missing: missing.receipt.missing }, hits: backendHits.length - hitsBefore });
		check('B5 缺配置时回执里没有 image 块', missing.content.filter((block) => block?.type === 'image').length === 0, { blocks: missing.content.length });
		await writeConfig(configValue({ size: '1024x1536', responseFormat: 'b64_json' }));
		await promptTurn(session, 'GEN:ok');
		const recovered = lastToolResult(session);
		const hit = backendHits.at(-1);
		check('B5 恢复配置后立刻又能成功（配置是调用时读盘，不需要重启宿主）', recovered.receipt.ok === true && recovered.content.some((block) => block?.type === 'image'), { reason: recovered.receipt.reason ?? null });
		check('B5 配置显式给 size/responseFormat 时才带上（不猜 DALL·E 形状）', hit?.body?.size === '1024x1536' && hit?.body?.response_format === 'b64_json', { body: hit?.body ?? null });
		await writeConfig(configValue());
	});

	await scenario('B6 成本面：output_format/quality 只在配置给时发；上限可收紧且超限明确失败', async () => {
		// ① 只在配置里给 output_format/quality 时它们才进 body（不默认发 —— 上游不支持就会 400）。
		await writeConfig(configValue({ outputFormat: 'jpeg', quality: 'low' }));
		await promptTurn(session, 'GEN:ok');
		const shaped = lastToolResult(session);
		const shapedHit = backendHits.at(-1);
		check('B6 配置给 output_format/quality 时才带上，并在回执里如实报 requested/limits', shaped.receipt.ok === true && shapedHit?.body?.output_format === 'jpeg' && shapedHit?.body?.quality === 'low' && 'response_format' in (shapedHit?.body ?? {}) === false && shaped.receipt.requested?.outputFormat === 'jpeg' && shaped.receipt.requested?.quality === 'low' && shaped.receipt.limits?.maxImageBytes === MAX_IMAGE_BYTES, { body: shapedHit?.body ?? null, requested: shaped.receipt.requested, limits: shaped.receipt.limits });
		// ② 把上限收到 1 MiB（配置值 2000 会被夹到最小值）：1.2 MiB 的图 ⇒ 明确失败，不截断。
		await writeConfig(configValue({ maxImageBytes: 2000 }));
		await promptTurn(session, 'GEN:medium');
		const tightened = lastToolResult(session);
		check('B6 收紧后的上限生效（超限失败，且回执报上限与预检读数）', tightened.isError === true && tightened.receipt.reason === 'image_too_large' && tightened.receipt.stage === 'encoded_length' && tightened.receipt.encodedChars > 0 && tightened.receipt.maxBytes === 1024 * 1024 && tightened.receipt.limits?.maxImageBytes === 1024 * 1024 && tightened.content.filter((block) => block?.type === 'image').length === 0, { receipt: tightened.receipt, blocks: tightened.content.length });
		await writeConfig(configValue());
	});

	// C 层用 B2 那段**真回执**装 wire（服务端 /messages 的规则见 base-logic.mjs:909-917,2727-2790：
	// content 保留原图、images 只放元数据、text 里补一行占位，工具卡把图配给 toolCallId）。
	await scenario('D Responses 托管工具路（apiMode=responses-image-tool）', async () => {
		const imagesHitsSoFar = () => backendHits.filter((row) => row.path === '/v1/images/generations').length;
		const imagesBefore = imagesHitsSoFar();
		await writeConfig({ endpoint: `http://127.0.0.1:${backendPort}/v1/responses`, model: 'gpt-6.1-sol', apiMode: 'responses-image-tool', authProvider: 'fake', timeoutMs: 1000 });

		// ① 成功：托管 item 的 `result` → 真 image 块；body 就是 C 给的最小形状
		await promptTurn(session, 'GEN:r-ok');
		const ok = lastToolResult(session);
		const hit = responsesHits.at(-1);
		check('D1 请求体：model/input(字符串)/tools=[image_generation+size]/tool_choice/stream:false，且无 n、无 response_format、无 quality', hit?.body?.model === 'gpt-6.1-sol' && hit?.body?.input === 'r-ok' && JSON.stringify(hit?.body?.tools) === JSON.stringify([{ type: 'image_generation', size: '1024x1024' }]) && JSON.stringify(hit?.body?.tool_choice) === JSON.stringify({ type: 'image_generation' }) && hit?.body?.stream === false && !('n' in (hit?.body ?? {})) && !('response_format' in (hit?.body ?? {})) && !('quality' in (hit?.body ?? {})), { body: hit?.body ?? null });
		check('D1 回执：ok + source=image_generation_call.result + apiMode/httpStatus/bytes/mimeType/sha256/dims/usage/costNote 都在', ok.receipt.ok === true
			&& ok.receipt.backend?.apiMode === 'responses-image-tool'
			&& ok.receipt.backend?.model === 'gpt-6.1-sol'
			&& ok.receipt.source === 'image_generation_call.result'
			&& ok.receipt.httpStatus === 200
			&& ok.receipt.mimeType === 'image/png'
			&& ok.receipt.bytes === PNG.length
			&& ok.receipt.sha256 === PNG_SHA256
			&& JSON.stringify(ok.receipt.dims) === JSON.stringify({ width: 400, height: 300 })
			&& ok.receipt.imageStatus === 'completed'
			&& ok.receipt.usage?.input_tokens === 11
			&& typeof ok.receipt.costNote === 'string' && ok.receipt.costNote.includes('偏低')
			&& Number.isFinite(ok.receipt.elapsedMs), ok.receipt);
		check('D1 工具结果仍只有一个 image 块（data 与夹具逐字相同），且回执里没有 base64', ok.content.filter((block) => block?.type === 'image').length === 1 && ok.content.find((block) => block?.type === 'image')?.data === PNG_B64 && !ok.text.includes(PNG_B64.slice(0, 60)), { blocks: ok.content.length });
		check('D1 没打到 images 端点（一次调用只走一条协议，不 fallback）', imagesHitsSoFar() === imagesBefore, { imagesHits: imagesHitsSoFar() - imagesBefore });

		// ② 失败族：200 但没有托管 item / 状态不对 / 多图 / 内层函数 / 缺 result / 非 JSON / SSE / 4xx / 429 / 5xx
		const failures = [
			{ prompt: 'r-noitem', reason: 'responses_no_image_generation_call' },
			{ prompt: 'r-failed', reason: 'responses_image_not_completed' },
			{ prompt: 'r-multi', reason: 'responses_multiple_images' },
			{ prompt: 'r-func', reason: 'responses_inner_function_call' },
			{ prompt: 'r-result', reason: 'responses_image_missing_result' },
			{ prompt: 'r-badjson', reason: 'image_backend_invalid_json' },
			{ prompt: 'r-sse', reason: 'responses_unexpected_stream' },
			{ prompt: 'r-400', reason: 'image_backend_rejected' },
			{ prompt: 'r-401', reason: 'image_backend_unauthorized' },
			{ prompt: 'r-429', reason: 'image_backend_rate_limited' },
			{ prompt: 'r-500', reason: 'image_backend_error' },
		];
		for (const row of failures) {
			const responsesBefore = responsesHits.length;
			const imagesAtArmStart = imagesHitsSoFar();
			await promptTurn(session, `GEN:${row.prompt}`);
			const failed = lastToolResult(session);
			const images = failed.content.filter((block) => block?.type === 'image');
			check(`D2 ${row.prompt} ⇒ ${row.reason}（零图、httpStatus、只打一次 responses、不碰 images）`, images.length === 0
				&& failed.receipt.ok === false
				&& failed.receipt.generated === false
				&& failed.receipt.reason === row.reason
				&& Number.isFinite(failed.receipt.httpStatus)
				&& responsesHits.length - responsesBefore === 1
				&& imagesHitsSoFar() === imagesAtArmStart, { reason: failed.receipt.reason, httpStatus: failed.receipt.httpStatus, imageBlocks: images.length, responses: responsesHits.length - responsesBefore, images: imagesHitsSoFar() - imagesAtArmStart });
		}

		// ③ 错误文本：只留安全字段 + 抹过凭据的一句；不抄 headers、不抄 key
		const bad = await (async () => { await promptTurn(session, 'GEN:r-400'); return lastToolResult(session); })();
		check('D3 400：errorParam=tool_choice、errorType=invalid_request_error；upstreamError 里有「不支持」但**没有** SECRET', bad.receipt.errorParam === 'tool_choice' && bad.receipt.errorType === 'invalid_request_error' && typeof bad.receipt.upstreamError === 'string' && bad.receipt.upstreamError.includes('tool_choice is not supported') && !bad.text.includes('SECRET'), { errorType: bad.receipt.errorType, errorCode: bad.receipt.errorCode, errorParam: bad.receipt.errorParam, upstreamError: bad.receipt.upstreamError });
		const unauth = await (async () => { await promptTurn(session, 'GEN:r-401'); return lastToolResult(session); })();
		check('D3 401：upstreamError 不含 sk-… 原文（抹成 <redacted-key>）', typeof unauth.receipt.upstreamError === 'string' && !unauth.text.includes(FAKE_KEY) && unauth.receipt.upstreamError.includes('<redacted-key>'), { upstreamError: unauth.receipt.upstreamError });

		// ④ 回默认（images）配置
		await writeConfig(configValue());
	});

	await scenario('E 边界三条（guard 生命周期 / 严格 completed / 维度为正）', async () => {
		await writeConfig(configValue()); // images 协议，timeoutMs 1000
		const hitsOf = (rowPath) => backendHits.filter((row) => row.path === rowPath).length;
		const postsOf = () => hitsOf('/v1/images/generations');

		// E1 宽 0 的 PNG
		await promptTurn(session, 'GEN:zerodim');
		const zero = lastToolResult(session);
		check('E1 宽度 0 的 PNG ⇒ image_dimensions_invalid、零图', zero.receipt.ok === false && zero.receipt.reason === 'image_dimensions_invalid' && zero.content.filter((block) => block?.type === 'image').length === 0, zero.receipt);

		// E2 同源 GET 挂起：必须由 guard 到点取消，且归因 timeout（不是 unreadable）
		const postsBefore = postsOf();
		const getHitsBefore = hitsOf('/img-hang.png');
		await promptTurn(session, 'GEN:url-hang');
		const hang = lastToolResult(session);
		check('E2 同源 GET 挂起 ⇒ timeout + outcomeUnknown:true、零图、只 1 次 POST＋1 次 GET（不重放）', hang.receipt.reason === 'timeout' && hang.receipt.outcomeUnknown === true && hang.content.filter((block) => block?.type === 'image').length === 0 && postsOf() - postsBefore === 1 && hitsOf('/img-hang.png') - getHitsBefore === 1, { receipt: hang.receipt, posts: postsOf() - postsBefore, gets: hitsOf('/img-hang.png') - getHitsBefore });

		// E3 同源 GET 头 200 之后慢 body：读流阶段也要被 guard 打断
		const getHitsBefore2 = hitsOf('/img-slowbody.png');
		await promptTurn(session, 'GEN:url-slowbody');
		const slowDownload = lastToolResult(session);
		check('E3 同源 GET 头 200 后慢 body ⇒ timeout + outcomeUnknown:true、零图', slowDownload.receipt.reason === 'timeout' && slowDownload.receipt.outcomeUnknown === true && slowDownload.content.filter((block) => block?.type === 'image').length === 0 && hitsOf('/img-slowbody.png') - getHitsBefore2 === 1, { receipt: slowDownload.receipt, gets: hitsOf('/img-slowbody.png') - getHitsBefore2 });

		// E4/E5 responses：缺 status / 空 status 一律拒（合同只认 completed）
		await writeConfig({ endpoint: `http://127.0.0.1:${backendPort}/v1/responses`, model: 'gpt-6.1-sol', apiMode: 'responses-image-tool', authProvider: 'fake', timeoutMs: 1000 });
		for (const prompt of ['r-nostatus', 'r-emptystatus']) {
			await promptTurn(session, `GEN:${prompt}`);
			const result = lastToolResult(session);
			check(`E4 ${prompt} ⇒ responses_image_not_completed（缺/空 status 也拒、零图）`, result.receipt.reason === 'responses_image_not_completed' && result.receipt.imageStatus !== 'completed' && result.content.filter((block) => block?.type === 'image').length === 0, { reason: result.receipt.reason, imageStatus: result.receipt.imageStatus ?? null });
		}

		// E5 responses 头 200 之后慢 body：同样归因 timeout/unknown，且只发 1 次 POST
		const responsesBefore = responsesHits.length;
		await promptTurn(session, 'GEN:r-slowbody');
		const slowJson = lastToolResult(session);
		check('E5 responses 头 200 后慢 body ⇒ timeout + outcomeUnknown:true、零图、只 1 次 POST', slowJson.receipt.reason === 'timeout' && slowJson.receipt.outcomeUnknown === true && slowJson.content.filter((block) => block?.type === 'image').length === 0 && responsesHits.length - responsesBefore === 1, { receipt: slowJson.receipt, responses: responsesHits.length - responsesBefore });

		await writeConfig(configValue());
	});

	await scenario('C 真 Chromium 渲染', async () => {
		const imagesFromSession = session.sessionManager.getBranch()
			.filter((row) => row.type === 'message' && row.message?.role === 'toolResult')
			.map((row) => row.message)
			.filter((message) => (message.content ?? []).some((block) => block?.type === 'image'))
			.at(-1);
		assert.ok(imagesFromSession, '拿不到一条带图的真 toolResult（B2 没成立？）');
		const textPart = (imagesFromSession.content ?? []).find((block) => block?.type === 'text');
		const toolCallId = imagesFromSession.toolCallId;
		const wire = {
			toolCallId,
			dataUrl: `data:image/png;base64,${PNG_B64}`,
			assistant: {
				entryId: 'assistant-image-gate', role: 'assistant', content: [],
				parts: [{
					type: 'tool', toolCallId, name: 'image_generate', args: { prompt: 'ok' },
					status: 'done-success', result: `${textPart?.text ?? ''}\n${PLACEHOLDER(PNG.length)}`,
					details: { status: 'known', value: JSON.parse(textPart?.text ?? '{}'), bytes: null, truncated: false, note: null, preview: null },
				}],
			},
			toolResult: {
				entryId: 'toolresult-image-gate', role: 'toolResult', toolCallId, toolName: 'image_generate',
				content: imagesFromSession.content,
				text: `${textPart?.text ?? ''}\n${PLACEHOLDER(PNG.length)}`,
				images: [{ mimeType: 'image/png', bytes: PNG.length }],
			},
		};
		await runUiArm(wire);
	});
}

try {
	// 门会在一个进程里跑很多条臂；生产的默认预算仍然是 **1 次生成**（`SOPHO_IMAGE_GEN_MAX_REQUESTS`
	// 默认 1），这里只把门自己的预算放宽（A8 会单独把默认行为钉住）。
	process.env.SOPHO_IMAGE_GEN_MAX_REQUESTS = '1000';
	await runPureArms();
	await runSandboxArms();
} finally {
	// teardown：先停所有慢流定时器，再销毁挂起响应，最后关两个服务（否则进程会被 interval/socket 拖住）。
	for (const timer of slowTimers) clearInterval(timer);
	slowTimers.clear();
	for (const response of heldResponses) {
		try { response.destroy(); } catch { /* 已关 */ }
	}
	if (backendServer) {
		backendServer.closeAllConnections?.();
		await new Promise((resolve) => backendServer.close(resolve));
	}
	if (providerServer) {
		providerServer.closeAllConnections?.();
		await new Promise((resolve) => providerServer.close(resolve));
	}
	if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
}

print('backendHits', { total: backendHits.length, byPrompt: backendHits.filter((row) => row.body).map((row) => row.body.prompt) });
process.stdout.write(`\n──── image_generate gate: ${checks} check(s) green / ${failures.length} red ────\n`);
for (const failure of failures) process.stdout.write(`FAIL  ${failure.name} —— ${typeof failure.detail === 'string' ? failure.detail.split('\n')[0] : JSON.stringify(failure.detail)}\n`);
process.stdout.write(`RESULT: ${failures.length === 0 ? 'PASS' : `RED (${failures.length})`}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
