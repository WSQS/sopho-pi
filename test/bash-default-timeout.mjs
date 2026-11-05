#!/usr/bin/env node
// test/bash-default-timeout.mjs —— 「内置 bash 的**缺省超时安全网**」门（v2.1 那层，v2.2 补回来）。
//
// ── 为什么要有它（依据：`docs/plans/diagnosis-2026-10-09-tool-timeout-interrupt.md` 提案①）──────────
// pi 的内置 bash 工具 `timeout` 是**可选、无默认**（schema 原文 "Timeout in seconds (optional, no
// default timeout)"）—— 模型不传 `timeout`，那条命令就**没有上限**（诊断单 §2.4：一条 `node -e`
// 在 60 s 时还在跑、`prompt()` 不 resolve；残留物活了 ~15–25 分钟）。v2.1 在**插件层**补过一层缺省
// 1800 s 的安全网（`pi.on("tool_call")` 补 `event.input.timeout`，常量名 `SOPHO_BASH_TIMEOUT`），
// **v2.2 没把它带过来**。本门把那层钉住。
//
// ── 判据（真会话 ＋ 假 provider，跑的是**真插件文件** `pi-extensions/assistant/index.ts`）──────────
//   A. **没给 timeout 的调用被兜住**：把 `SOPHO_BASH_TIMEOUT` 覆盖成很小（本门用 **2** 秒），模型不传
//      `timeout` 的那条**不会自己结束**的命令 ⇒ 断言「被终止 ＋ 有部分输出 ＋ 归因是 timeout」。
//   B. **调用方给了 timeout 就以调用方为准**：env 仍是 2 秒，但模型显式给 `timeout: 6` ⇒ 结果必须写
//      `after 6 seconds`（缺省**不许覆盖**显式值）。
//   C. **快命令一字不动**：env 仍是 2 秒，一条几十毫秒就退出的命令必须正常完成（安全网不许误杀）。
//   D. **用户主动打断 ≠ 超时**：env 放大到 600 秒，跑一条挂住的命令、1.8 s 时真按「停止」（`session.abort()`）
//      ⇒ 结果必须是 `Command aborted` 而**不是** `Command timed out`（两种归因分开）。
//
// ── 到点后的行为**必须走 pi 已有的那条路**（诊断单 §2.1/§2.3 实测是好的）：本门不打桩那套 kill，
//    只量结果 —— 部分输出保留、末尾一行如实写 `Command timed out after N seconds`。
//
// ── 反证臂 `--reverse-arm=no-default`（本仓惯例）────────────────────────────────────────────────
// 把缺省**拿掉**（用产品自己的逃生口 `SOPHO_BASH_TIMEOUT=off`，它让 `bashTimeoutDefault()` 返回 null，
// 与「代码里没有这层」是**同一个行为**）⇒ 本门的 A 那组断言**必须红**，而 B / C / D 必须仍绿
// （它们不依赖缺省）。红时的原始输出见交付报告。
// ⚠️ `A` 组里「有部分输出」那条（`no-timeout-call-keeps-partial-output`）在反证臂里**仍会绿** ——
// 因为 abort 也保留部分输出，它本就不依赖缺省；本门如实把它列在 `expectGreen` 里，不假装它会红。
//
// 沙箱：临时 `ASSIST_HOME`（`agentDir`）＋ 高位随机端口 ＋ 本地假 provider；不碰真 profile、不碰
// 7331/7321；命令是**本进程树里 pi 的 bash 工具**起的（到点由 pi 杀树，本门不自己 kill）。
// 用法：node test/bash-default-timeout.mjs [--reverse-arm=no-default]

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_EXPECT = {
	'no-default': {
		what: '把缺省超时拿掉（SOPHO_BASH_TIMEOUT=off）—— 回到「没超时」的老行为',
		expect: ['no-timeout-call-is-bounded', 'no-timeout-call-attribution-is-timeout'],
		expectGreen: ['no-timeout-call-keeps-partial-output', 'caller-timeout-is-not-overridden', 'fast-command-completes-normally', 'user-abort-is-not-attributed-as-timeout', 'extension-loaded-without-errors'],
	},
};
if (ARM && !ARM_EXPECT[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_EXPECT).join(' / ')}）`);

// 反证臂的全部变异就是这一个环境变量：`off` ⇒ 安全网关掉（缺省被拿掉）。
const ENV_ARM = ARM === 'no-default' ? 'off' : null;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(root, 'pi-extensions', 'assistant', 'index.ts');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-bashtimeout-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'cwd');
const hangScript = path.join(sandbox, 'hang.mjs');
const fastScript = path.join(sandbox, 'fast.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const toPosix = (p) => p.split(path.sep).join('/');

let server = null;
let primaryError = null;
const cleanupProblems = [];

function reserveHighPort() {
	return new Promise((resolve, reject) => {
		const listener = net.createServer();
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', () => {
			const { port } = listener.address();
			listener.close(() => resolve(port));
		});
	});
}

function sse(response, delta, finishReason = null, includeUsage = false) {
	response.write(`data: ${JSON.stringify({
		id: `chatcmpl-${randomUUID()}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: 'fake-bashtimeout',
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(includeUsage ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}),
	})}\n\n`);
}

// ── 检查（不抛错，逐条记账）：反证臂要按 id 分辨「哪条红」────────────────────────────────────────
const results = [];
const checks = { passed: 0, failed: 0 };
const check = (id, ok, detail) => {
	results.push({ id, ok });
	if (ok) { checks.passed += 1; process.stdout.write(`✓ ${id} —— ${detail}\n`); }
	else { checks.failed += 1; process.stdout.write(`✗ ${id}\n  实测：${detail}\n`); }
};

const plan = { toolCall: null };
const requests = [];

function toolResultOf(session) {
	const branch = session.sessionManager.getBranch();
	const entry = branch.find((row) => row.type === 'message' && row.message?.role === 'toolResult');
	if (!entry) return null;
	return {
		isError: entry.message.isError === true,
		text: (entry.message.content ?? []).map((part) => part.text ?? '').join(''),
	};
}

try {
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });
	// 两条夹具命令：一条挂住（setInterval 永不返回）＋ 先打两行部分输出；一条几十毫秒就退出。
	await writeFile(hangScript, 'console.log("BT_PARTIAL_ONE");\nconsole.log("BT_PARTIAL_TWO");\nsetInterval(() => {}, 1e9);\n');
	await writeFile(fastScript, 'console.log("BT_FAST_OK");\n');
	const hangCommand = `node "${toPosix(hangScript)}"`;
	const fastCommand = `node "${toPosix(fastScript)}"`;

	// ── 假 provider（OpenAI-compatible SSE）：第一发给一个 bash 工具调用，第二发（带工具结果）收尾 ──
	const providerPort = await reserveHighPort();
	server = http.createServer(async (request, response) => {
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const hasToolResult = body.messages.some((message) => message.role === 'tool');
		requests.push({ toolNames: body.tools?.map((tool) => tool.function?.name) ?? [], hasToolResult });
		response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
		if (!hasToolResult) {
			if (!plan.toolCall) throw new Error('假 provider 在模型没排工具调用时就收到了首发请求');
			sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: plan.toolCall.name, arguments: JSON.stringify(plan.toolCall.args) } }] });
			sse(response, {}, 'tool_calls', true);
		} else {
			sse(response, { role: 'assistant', content: 'BT_TURN_DONE' });
			sse(response, {}, 'stop', true);
		}
		response.end('data: [DONE]\n\n');
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(providerPort, '127.0.0.1', resolve); });

	await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox',
		models: [{ id: 'fake-bashtimeout', name: 'Fake Bashtimeout', contextWindow: 8192, maxTokens: 512 }],
	} } }, null, 2)}\n`);
	await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
		defaultProvider: 'fake', defaultModel: 'fake-bashtimeout', defaultThinkingLevel: 'off',
		compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
	}, null, 2)}\n`);

	// 跑的是**真插件文件**（与 `server/base-logic.mjs:5007` 同一份 additionalExtensionPaths 机制）。
	const settingsManager = SettingsManager.create(cwd, home);
	const loader = new DefaultResourceLoader({ cwd, agentDir: home, settingsManager, additionalExtensionPaths: [pluginPath] });
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors ?? [];
	print('插件装载错误', extensionErrors);
	check('extension-loaded-without-errors', extensionErrors.length === 0,
		`loader.getExtensions().errors=${JSON.stringify(extensionErrors)}（真插件文件必须装得上，否则下面的判据是空跑）`);

	const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, 'auth.json'), modelsPath: path.join(home, 'models.json') });
	const model = modelRuntime.getModel('fake', 'fake-bashtimeout');
	assert.ok(model, '假 provider 的模型没解析出来');

	const newSession = () => createAgentSession({
		cwd, agentDir: home, modelRuntime, model, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, path.join(sandbox, 'sessions')),
	});

	// ── 一个场景 = 一条会话 ＋ 一次带工具调用的回合（watchdog 上限只是「本门等多久」，不是被测行为）──
	async function runScenario({ label, args, envDefault, watchdogMs }) {
		process.env.SOPHO_BASH_TIMEOUT = ENV_ARM ?? String(envDefault);
		plan.toolCall = { name: 'bash', args };
		const { session } = await newSession();
		const startedAt = Date.now();
		let watchdogFired = false;
		let promptError = null;
		let timer = null;
		const promptPromise = session.prompt(`BT_SCENARIO_${label}`).catch((error) => { promptError = error; });
		try {
			await Promise.race([
				promptPromise,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__BT_WATCHDOG__')), watchdogMs); }),
			]);
		} catch (error) {
			if (!String(error?.message).includes('__BT_WATCHDOG__')) throw error;
			watchdogFired = true;
		} finally {
			if (timer) clearTimeout(timer);
		}
		const elapsedMs = Date.now() - startedAt;
		let killedByWatchdog = false;
		if (watchdogFired) {
			killedByWatchdog = true;
			await session.abort();
			await sleep(2000);
		}
		const result = toolResultOf(session);
		await session.dispose();
		const reading = { label, envDefault: ENV_ARM ?? envDefault, args, watchdogFired: killedByWatchdog, elapsedMs, promptError: promptError ? String(promptError.message ?? promptError) : null, result };
		print(`场景 ${label}`, reading);
		return reading;
	}

	// ── D：用户主动打断（不是 watchdog；本门自己按停止）────────────────────────────────────────────
	async function runAbortScenario({ label, command, envDefault }) {
		process.env.SOPHO_BASH_TIMEOUT = ENV_ARM ?? String(envDefault);
		plan.toolCall = { name: 'bash', args: { command } };
		const { session } = await newSession();
		const startedAt = Date.now();
		const promptPromise = session.prompt(`BT_SCENARIO_${label}`).catch(() => {});
		await sleep(1800);
		const abortStartedAt = Date.now();
		await session.abort();
		await sleep(2000);
		const result = toolResultOf(session);
		await session.dispose();
		const promptSettled = await Promise.race([promptPromise.then(() => true), sleep(50).then(() => false)]);
		const reading = { label, envDefault: ENV_ARM ?? envDefault, command, abortAtMs: abortStartedAt - startedAt, elapsedMs: Date.now() - startedAt, promptSettled, result };
		print(`场景 ${label}`, reading);
		return reading;
	}

	// ── A：没给 timeout ⇒ 被缺省兜住 ────────────────────────────────────────────────────────────
	const scenarioA = await runScenario({ label: 'A_no_timeout', args: { command: hangCommand }, envDefault: 2, watchdogMs: 9000 });
	check('no-timeout-call-is-bounded',
		scenarioA.watchdogFired === false && scenarioA.result?.isError === true && /Command timed out after 2 seconds/.test(scenarioA.result?.text ?? ''),
		JSON.stringify({ watchdogFired: scenarioA.watchdogFired, elapsedMs: scenarioA.elapsedMs, isError: scenarioA.result?.isError ?? null, tail: (scenarioA.result?.text ?? '').slice(-120) }));
	check('no-timeout-call-attribution-is-timeout',
		/Command timed out after 2 seconds/.test(scenarioA.result?.text ?? '') && !/Command aborted/.test(scenarioA.result?.text ?? ''),
		JSON.stringify({ 归因原文: (scenarioA.result?.text ?? '').split('\n').filter((line) => line.includes('Command')).join(' ｜ ') }));
	check('no-timeout-call-keeps-partial-output',
		scenarioA.result?.text?.includes('BT_PARTIAL_ONE') === true && scenarioA.result?.text?.includes('BT_PARTIAL_TWO') === true,
		JSON.stringify({ 有第一行: scenarioA.result?.text?.includes('BT_PARTIAL_ONE') ?? null, 有第二行: scenarioA.result?.text?.includes('BT_PARTIAL_TWO') ?? null }));

	// ── B：模型自己给了 timeout ⇒ 以模型为准（缺省不许覆盖）──────────────────────────────────────
	const scenarioB = await runScenario({ label: 'B_caller_timeout', args: { command: hangCommand, timeout: 6 }, envDefault: 2, watchdogMs: 12000 });
	check('caller-timeout-is-not-overridden',
		scenarioB.result?.isError === true && /Command timed out after 6 seconds/.test(scenarioB.result?.text ?? '') && !/after 2 seconds/.test(scenarioB.result?.text ?? ''),
		JSON.stringify({ elapsedMs: scenarioB.elapsedMs, tail: (scenarioB.result?.text ?? '').slice(-120) }));

	// ── C：快命令不受影响 ───────────────────────────────────────────────────────────────────────
	const scenarioC = await runScenario({ label: 'C_fast_command', args: { command: fastCommand }, envDefault: 2, watchdogMs: 6000 });
	check('fast-command-completes-normally',
		scenarioC.watchdogFired === false && scenarioC.result?.isError === false && (scenarioC.result?.text ?? '').includes('BT_FAST_OK'),
		JSON.stringify({ watchdogFired: scenarioC.watchdogFired, isError: scenarioC.result?.isError ?? null, text: scenarioC.result?.text ?? null }));

	// ── D：用户主动打断 ⇒ 归因是 aborted，不是 timeout ───────────────────────────────────────────
	const scenarioD = await runAbortScenario({ label: 'D_user_abort', command: hangCommand, envDefault: 600 });
	check('user-abort-is-not-attributed-as-timeout',
		scenarioD.result?.isError === true && /Command aborted/.test(scenarioD.result?.text ?? '') && !/timed out/i.test(scenarioD.result?.text ?? ''),
		JSON.stringify({ isError: scenarioD.result?.isError ?? null, 归因原文: (scenarioD.result?.text ?? '').split('\n').filter((line) => line.includes('Command')).join(' ｜ ') }));

	print('假 provider 收到的请求', requests);
} catch (error) {
	primaryError = error;
	process.stdout.write(`\n✗ FAIL（异常，不是断言红）：${error?.stack || error}\n`);
} finally {
	delete process.env.SOPHO_BASH_TIMEOUT;
	if (server) await cleanupStep(cleanupProblems, 'close fake provider', () => new Promise((resolve) => server.close(resolve)));
	await cleanupStep(cleanupProblems, 'remove sandbox', () => removeSandbox(sandbox, cleanupProblems));

	const red = results.filter((row) => !row.ok).map((row) => row.id);
	if (ARM) {
		const arm = ARM_EXPECT[ARM];
		const notRed = arm.expect.filter((id) => !red.includes(id));
		const wronglyRed = (arm.expectGreen ?? []).filter((id) => red.includes(id));
		print(`反证臂 ${ARM} 结果`, { what: arm.what, expect: arm.expect, expectGreen: arm.expectGreen ?? [], actuallyRed: red });
		if (notRed.length === 0 && wronglyRed.length === 0 && cleanupProblems.length === 0 && primaryError === null) {
			print('RESULT', `反证臂 ${ARM} 红到位（这是**期望**的结果，不是缺陷）：缺省一拿掉，A 那组里该红的两条都红了，其余腿仍绿`);
		} else {
			print('RESULT', `反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}；本该留绿却红了 ${JSON.stringify(wronglyRed)}；异常 ${primaryError ? String(primaryError.message ?? primaryError) : '无'}；收尾问题 ${JSON.stringify(cleanupProblems)} ⇒ 这道门是个假门`);
			process.exitCode = 1;
		}
	} else {
		if (primaryError !== null) { process.exitCode = 1; print('RESULT', `bash 缺省超时安全网门 FAIL（异常，不是断言红）：${String(primaryError.message ?? primaryError)}`); }
		else if (cleanupProblems.length > 0) { process.exitCode = 1; print('RESULT', `收尾不干净：${JSON.stringify(cleanupProblems)}`); }
		else if (red.length > 0) { process.exitCode = 1; print('RESULT', `bash 缺省超时安全网门 FAIL：红了 ${JSON.stringify(red)}`); }
		else print('RESULT', `bash 缺省超时安全网门 PASS（${checks.passed} 项断言，全集 ${JSON.stringify(results.map((row) => row.id))}）`);
	}
	try { finishCleanup(primaryError, cleanupProblems); } catch (error) { process.stdout.write(`finishCleanup: ${error?.message || error}\n`); process.exitCode = 1; }
}
