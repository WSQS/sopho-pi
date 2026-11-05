#!/usr/bin/env node
// test/name-kill-guard.mjs —— 「工具层拦下**按名字 / 按模式**杀进程」门（2026-10-14 宿主自杀事故的直接修法）。
//
// ── 为什么要有它（依据：`docs/plans/diagnosis-2026-10-14-host-exit.md`）────────────────────────
// 2026-10-14T13:42:51.380Z，一条子会话（`2715e86a`）只想清它自己为压测起的 3 个满载 node，
// 发了 `taskkill //F //IM node.exe //FI "PID ne $$"`：`//IM` 是**按镜像名**匹配 ⇒ `TerminateProcess`
// 掉**整机所有 `node.exe``** —— 宿主 A（`base.mjs`，36296）、应用 B（`app.mjs`，55924）、
// 连同**它自己那条命令的调用者**一起没了（那条 `toolCall` 永远没有 `toolResult`）。
// 这与 `AGENTS.md` 第 1 条「**绝不用 `pkill`** …一律按 pid 杀」是**同一形状**，只是整机尺度 ——
// 纪律写了、闸没有。本门钉住插件层那道形状闸：命中就**挡住这次 `bash` 调用**并给出可行动提示，
// 而**按 pid 杀必须放行**（那是纪律要求的正确做法，闸不许误伤）。
//
// ── 判据（跑**真插件文件** `pi-extensions/assistant/index.ts` ＋ 假 provider）──────────────────
// ⚠️ 安全前提：命令**永远不真的执行**。本门把一个**同名 `bash` 替身工具**通过 `customTools` 装进会话
//    （SDK custom tool 会盖住内置 bash，见 `AgentSession._refreshToolRegistry`），它只**记录**命令、
//    回一句 `STUB_BASH_EXECUTED::<命令>`，**绝不 spawn**。否则反证臂（闸被拆掉）会真的去跑
//    `taskkill /IM node.exe` —— 那正是要防的事故。
//   ① `taskkill //F //IM node.exe` ⇒ 被拒（`isError`），提示里含「按 pid」与「整机所有同名进程」；
//   ② `pkill node` ⇒ 被拒；
//   ③ `Stop-Process -Name node -Force` ⇒ 被拒；
//   ④ `taskkill /F /PID 1234` ⇒ **放行**（这条最重要：闸不许误伤按 pid）；
//   ⑤ `kill 1234` ⇒ **放行**；④'⑤' 同组的其它按-pid 写法（`taskkill /F /PID 1234 /T`、`kill -9 1234`、
//      `Stop-Process -Id 1234`）也一律放行；
//   ⑥ 无关命令（`ls -la`、`git status`）⇒ 不受影响、照常到达执行器；
//   ⑦ 余下形状（`taskkill -IM`、`Stop-Process` 位置参数、`Get-Process … | Stop-Process`、
//      `wmic … delete`、`sudo pkill`、`killall`）⇒ 各自被拒；而 `wmic … where processid=<n> delete`
//      是纯 pid 谓词 ⇒ 放行；
//   ⑧ **被拒的命令绝不抵达执行器**（替身里查不到那条命令）—— 闸挡在真正执行之前。
//
// ── 反证臂（本仓惯例；见文件尾 `ARM_SEAMS`）──────────────────────────────────────────────────
//   · `--reverse-arm=no-gate`：在**副本树**里把形状闸整段拆掉 ⇒ ①②③ 那组 + 提示断言必须红，
//     「按 pid 放行」那组仍绿；
//   · `--reverse-arm=blocks-pid-too`：在副本里把闸写成「连 /PID 也拦」（去掉 `/IM` 限定 ＋ 把
//     `kill` 也收进来）⇒ ④⑤ 必须红，①②③⑥ 仍绿。
//   红时原始输出见交付报告。
//
// 沙箱：临时 `ASSIST_HOME` ＋ 高位随机端口 ＋ 本地假 provider；不碰真 profile、不碰 7331/7321；
// 本进程里**不 spawn 任何被测命令**（替身工具）。
// 用法：node test/name-kill-guard.mjs [--reverse-arm=no-gate|blocks-pid-too]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

// ── 反证臂的接缝：`from`/`to` 是**成对声明**（本仓 arm-seams 门会机械核对：`from` 必须在
//    `pi-extensions/assistant/index.ts` 里**恰好出现 1 次**）⇒ 闸被改动时这里会先红，不会静默失效。
const ARM_SEAMS = [
	{
		arm: 'no-gate',
		what: '把形状闸整段拆掉（算出 refusal 也不 block）—— 回到「只靠纪律」的老行为',
		file: 'pi-extensions/assistant/index.ts',
		from: "const refusal = nameKillRefusal(event.input.command);\n\t\tif (refusal !== null) return { block: true, reason: refusal };",
		to: '// reverse-arm:no-gate —— 闸拆掉：算出 refusal 也不拦',
		expect: '① taskkill /IM、② pkill、③ Stop-Process -Name 全部失去拦截（这一组断言必须红）',
	},
	{
		arm: 'blocks-pid-too',
		what: '把闸写成「连 /PID 也拦」之一：`taskkill` 不再要求带 `/IM`（任何 taskkill 都拦）',
		file: 'pi-extensions/assistant/index.ts',
		from: 'TASKKILL_IMAGE_SWITCH.test(segment)',
		to: 'true',
		expect: '④ `taskkill /F /PID 1234` 被误伤（必须红）',
	},
	{
		arm: 'blocks-pid-too',
		what: '把闸写成「连 /PID 也拦」之二：`kill <pid>` 也被当成按名字杀',
		file: 'pi-extensions/assistant/index.ts',
		from: 'if (word === "pkill" || word === "killall") {',
		to: 'if (word === "pkill" || word === "killall" || word === "kill") {',
		expect: '⑤ `kill 1234` 被误伤（必须红）',
	},
];

const BLOCK_IDS = [
	'taskkill-im-by-image-name-is-blocked',
	'refusal-message-names-whole-machine-and-pid',
	'pkill-is-blocked',
	'stop-process-by-name-is-blocked',
	'taskkill-im-variants-are-blocked',
	'stop-process-positional-name-is-blocked',
	'get-process-pipe-stop-process-is-blocked',
	'wmic-delete-by-name-is-blocked',
	'pkill-with-launcher-is-blocked',
	'killall-is-blocked',
	'blocked-commands-never-reached-the-executor',
];
// 「按 pid 杀」那一组：`blocks-pid-too` 臂里全变红（闸被写成连 /PID 也拦）。
const PID_KILL_IDS = ['taskkill-by-pid-is-allowed', 'taskkill-by-pid-with-flags-is-allowed', 'kill-by-pid-is-allowed', 'kill-pid-with-signal-is-allowed'];
// 明确豁免的按-pid 写法：两条臂里都必须留绿（证明豁免不是偶然）。
const PID_EXEMPT_IDS = ['stop-process-by-id-is-allowed', 'wmic-pid-addressed-is-allowed'];
const ALLOW_IDS = [...PID_KILL_IDS, ...PID_EXEMPT_IDS, 'unrelated-commands-unaffected'];
const BASE_IDS = ['extension-loaded-without-errors'];

const ARM_EXPECT = {
	'no-gate': {
		what: '副本树里把形状闸整段拆掉 —— 回到「纪律写了、闸没有」的老行为',
		expect: BLOCK_IDS,
		expectGreen: [...BASE_IDS, ...ALLOW_IDS],
	},
	'blocks-pid-too': {
		what: '副本树里把闸写成「连 /PID 也拦」（taskkill 去掉 /IM 限定 ＋ kill 也收进来）',
		expect: PID_KILL_IDS,
		expectGreen: [...BASE_IDS, ...BLOCK_IDS, ...PID_EXEMPT_IDS, 'unrelated-commands-unaffected'],
	},
};
if (ARM && !ARM_EXPECT[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_EXPECT).join(' / ')}）`);
if (ARM && !ARM_SEAMS.some((seam) => seam.arm === ARM)) throw new Error(`反证臂 ${ARM} 没有对应的接缝声明`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_PATH = path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-namekill-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'cwd');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

let server = null;
let primaryError = null;
const cleanupProblems = [];
let pluginPath = PLUGIN_PATH;

// ── 同名 `bash` 替身（永不执行命令；只记录 + 回一句可核对的标记）────────────────────────────────
const stubCalls = [];
const stubBash = {
	name: 'bash',
	label: 'bash (test stub)',
	description: 'Test stub for the built-in bash tool: records the command and returns a marker. NEVER executes anything.',
	parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
	async execute(_toolCallId, params) {
		stubCalls.push(params.command);
		return { content: [{ type: 'text', text: `STUB_BASH_EXECUTED::${params.command}` }] };
	},
};

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
		model: 'fake-namekill',
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(includeUsage ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}),
	})}\n\n`);
}

const results = [];
const checks = { passed: 0, failed: 0 };
const check = (id, ok, detail) => {
	results.push({ id, ok });
	if (ok) { checks.passed += 1; process.stdout.write(`✓ ${id} —— ${detail}\n`); }
	else { checks.failed += 1; process.stdout.write(`✗ ${id}\n  实测：${detail}\n`); }
};

const plan = { toolCall: null };

function toolResultOf(session) {
	const branch = session.sessionManager.getBranch();
	const entry = branch.find((row) => row.type === 'message' && row.message?.role === 'toolResult');
	if (!entry) return null;
	return {
		isError: entry.message.isError === true,
		text: (entry.message.content ?? []).map((part) => part.text ?? '').join(''),
		blocked: entry.message.isError === true,
	};
}

try {
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });

	// 反证臂：在**副本树**里改插件（真树一个字节不动；与 `test/archive-worktree-hint.mjs` 同一写法）。
	if (ARM) {
		const tree = path.join(sandbox, 'reverse-tree');
		await mkdir(path.join(tree, 'pi-extensions'), { recursive: true });
		await cp(path.join(ROOT, 'pi-extensions', 'assistant'), path.join(tree, 'pi-extensions', 'assistant'), { recursive: true });
		await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
		const indexFile = path.join(tree, 'pi-extensions', 'assistant', 'index.ts');
		for (const seam of ARM_SEAMS.filter((entry) => entry.arm === ARM)) {
			const source = await readFile(indexFile, 'utf8');
			const hits = source.split(seam.from).length - 1;
			if (hits !== 1) throw new Error(`反证臂 ${ARM} 的接缝在 ${seam.file} 里出现 ${hits} 次（应为**恰好 1 次**）：\n  要找：${JSON.stringify(seam.from).slice(0, 180)}`);
			await writeFile(indexFile, source.replace(seam.from, seam.to));
		}
		pluginPath = indexFile;
		print('reverse-arm mutation', { arm: ARM, seams: ARM_SEAMS.filter((entry) => entry.arm === ARM).map((entry) => entry.what), tree });
	}

	// ── 假 provider（OpenAI-compatible SSE）：第一发打一个 `bash` 工具调用，第二发（带结果）收尾 ──
	const providerPort = await reserveHighPort();
	server = http.createServer(async (request, response) => {
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const hasToolResult = body.messages.some((message) => message.role === 'tool');
		response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
		if (!hasToolResult) {
			if (!plan.toolCall) throw new Error('假 provider 在模型没排工具调用时就收到了首发请求');
			sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: plan.toolCall.name, arguments: JSON.stringify(plan.toolCall.args) } }] });
			sse(response, {}, 'tool_calls', true);
		} else {
			sse(response, { role: 'assistant', content: 'NKG_TURN_DONE' });
			sse(response, {}, 'stop', true);
		}
		response.end('data: [DONE]\n\n');
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(providerPort, '127.0.0.1', resolve); });

	await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox',
		models: [{ id: 'fake-namekill', name: 'Fake Namekill', contextWindow: 8192, maxTokens: 512 }],
	} } }, null, 2)}\n`);
	await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
		defaultProvider: 'fake', defaultModel: 'fake-namekill', defaultThinkingLevel: 'off',
		compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
	}, null, 2)}\n`);

	// 跑的是**真插件文件**（与 `server/base-logic.mjs` 同一份 additionalExtensionPaths 机制）。
	const settingsManager = SettingsManager.create(cwd, home);
	const loader = new DefaultResourceLoader({ cwd, agentDir: home, settingsManager, additionalExtensionPaths: [pluginPath] });
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors ?? [];
	print('插件装载错误', extensionErrors);
	check('extension-loaded-without-errors', extensionErrors.length === 0,
		`loader.getExtensions().errors=${JSON.stringify(extensionErrors)}（真插件文件必须装得上，否则下面的判据是空跑）`);

	const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, 'auth.json'), modelsPath: path.join(home, 'models.json') });
	const model = modelRuntime.getModel('fake', 'fake-namekill');
	assert.ok(model, '假 provider 的模型没解析出来');

	// 每个场景 = 一条新会话 ＋ 一次带 bash 工具调用的回合；替身 `bash` 盖住内置 bash（命令永不真跑）。
	async function runScenario(command, label) {
		plan.toolCall = { name: 'bash', args: { command } };
		const before = stubCalls.length;
		const { session } = await createAgentSession({
			cwd, agentDir: home, modelRuntime, model, settingsManager, resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, path.join(sandbox, 'sessions')),
			customTools: [stubBash],
		});
		let watchdogFired = false;
		let promptError = null;
		let timer = null;
		const promptPromise = session.prompt(`NKG_${label ?? randomUUID()}`).catch((error) => { promptError = error; });
		try {
			await Promise.race([
				promptPromise,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__NKG_WATCHDOG__')), 15000); }),
			]);
		} catch (error) {
			if (!String(error?.message).includes('__NKG_WATCHDOG__')) throw error;
			watchdogFired = true;
		} finally {
			if (timer) clearTimeout(timer);
		}
		const result = toolResultOf(session);
		const reachedExecutor = stubCalls.length > before;
		await session.dispose();
		const reading = { command, watchdogFired, reachedExecutor, promptError: promptError ? String(promptError.message ?? promptError) : null, isError: result?.isError ?? null, tail: (result?.text ?? '').slice(-160) };
		print(`场景 ${label ?? command}`, reading);
		return { ...reading, text: result?.text ?? '' };
	}

	const isBlocked = (reading) => reading.watchdogFired === false && reading.isError === true;
	const isAllowed = (reading) => reading.watchdogFired === false && reading.isError === false && reading.reachedExecutor === true && reading.text.includes('STUB_BASH_EXECUTED');

	// ── ① taskkill 按镜像名（事故原样）⇒ 被拒 ＋ 提示可行动 ─────────────────────────────────────
	const s1 = await runScenario('taskkill //F //IM node.exe');
	check('taskkill-im-by-image-name-is-blocked', isBlocked(s1) && s1.reachedExecutor === false,
		JSON.stringify({ isError: s1.isError, reachedExecutor: s1.reachedExecutor, tail: s1.tail }));
	check('refusal-message-names-whole-machine-and-pid',
		s1.text.includes('整机所有同名进程') && s1.text.includes('按 pid') && s1.text.includes('AGENTS.md'),
		JSON.stringify({ '有整机所有同名进程': s1.text.includes('整机所有同名进程'), '有按pid': s1.text.includes('按 pid'), '有AGENTS.md': s1.text.includes('AGENTS.md') }));

	// ── ② pkill / killall ────────────────────────────────────────────────────────────────────
	const s2 = await runScenario('pkill node');
	check('pkill-is-blocked', isBlocked(s2) && s2.reachedExecutor === false,
		JSON.stringify({ isError: s2.isError, reachedExecutor: s2.reachedExecutor, tail: s2.tail }));

	// ── ③ PowerShell Stop-Process -Name ──────────────────────────────────────────────────────
	const s3 = await runScenario('Stop-Process -Name node -Force');
	check('stop-process-by-name-is-blocked', isBlocked(s3) && s3.reachedExecutor === false,
		JSON.stringify({ isError: s3.isError, reachedExecutor: s3.reachedExecutor, tail: s3.tail }));

	// ── ④ 按 pid 杀（taskkill）⇒ 必须放行 ─────────────────────────────────────────────────────
	const s4 = await runScenario('taskkill /F /PID 1234');
	check('taskkill-by-pid-is-allowed', isAllowed(s4),
		JSON.stringify({ isError: s4.isError, reachedExecutor: s4.reachedExecutor, tail: s4.tail }));

	// ── ⑤ 按 pid 杀（POSIX kill）⇒ 必须放行 ───────────────────────────────────────────────────
	const s5 = await runScenario('kill 1234');
	check('kill-by-pid-is-allowed', isAllowed(s5),
		JSON.stringify({ isError: s5.isError, reachedExecutor: s5.reachedExecutor, tail: s5.tail }));

	// ── ⑤' 按 pid 杀的其它写法 ⇒ 同样必须放行（闸不许误伤）───────────────────────────────────────
	const s5b = await runScenario('kill -9 1234');
	check('kill-pid-with-signal-is-allowed', isAllowed(s5b),
		JSON.stringify({ isError: s5b.isError, reachedExecutor: s5b.reachedExecutor, tail: s5b.tail }));
	const s4b = await runScenario('taskkill /F /PID 1234 /T');
	check('taskkill-by-pid-with-flags-is-allowed', isAllowed(s4b),
		JSON.stringify({ isError: s4b.isError, reachedExecutor: s4b.reachedExecutor, tail: s4b.tail }));
	const s4c = await runScenario('Stop-Process -Id 1234 -Force');
	check('stop-process-by-id-is-allowed', isAllowed(s4c),
		JSON.stringify({ isError: s4c.isError, reachedExecutor: s4c.reachedExecutor, tail: s4c.tail }));

	// ── ⑥ 无关命令 ⇒ 不受影响 ────────────────────────────────────────────────────────────────
	const s6a = await runScenario('ls -la');
	const s6b = await runScenario('git status');
	check('unrelated-commands-unaffected', isAllowed(s6a) && isAllowed(s6b),
		JSON.stringify({ ls: { isError: s6a.isError, reachedExecutor: s6a.reachedExecutor }, git: { isError: s6b.isError, reachedExecutor: s6b.reachedExecutor } }));

	// ── ⑦ 余下形状 ───────────────────────────────────────────────────────────────────────────
	const s7a = await runScenario('taskkill -F -IM notepad.exe');
	check('taskkill-im-variants-are-blocked', isBlocked(s7a) && s7a.reachedExecutor === false,
		JSON.stringify({ isError: s7a.isError, reachedExecutor: s7a.reachedExecutor, tail: s7a.tail }));
	const s7b = await runScenario('Stop-Process notepad');
	check('stop-process-positional-name-is-blocked', isBlocked(s7b) && s7b.reachedExecutor === false,
		JSON.stringify({ isError: s7b.isError, reachedExecutor: s7b.reachedExecutor, tail: s7b.tail }));
	const s7c = await runScenario('Get-Process node | Stop-Process');
	check('get-process-pipe-stop-process-is-blocked', isBlocked(s7c) && s7c.reachedExecutor === false,
		JSON.stringify({ isError: s7c.isError, reachedExecutor: s7c.reachedExecutor, tail: s7c.tail }));
	const s7d = await runScenario(`wmic process where "name='node.exe'" delete`);
	check('wmic-delete-by-name-is-blocked', isBlocked(s7d) && s7d.reachedExecutor === false,
		JSON.stringify({ isError: s7d.isError, reachedExecutor: s7d.reachedExecutor, tail: s7d.tail }));
	const s7e = await runScenario('sudo pkill node');
	check('pkill-with-launcher-is-blocked', isBlocked(s7e) && s7e.reachedExecutor === false,
		JSON.stringify({ isError: s7e.isError, reachedExecutor: s7e.reachedExecutor, tail: s7e.tail }));
	const s7f = await runScenario('killall node');
	check('killall-is-blocked', isBlocked(s7f) && s7f.reachedExecutor === false,
		JSON.stringify({ isError: s7f.isError, reachedExecutor: s7f.reachedExecutor, tail: s7f.tail }));
	// 明确豁免的按-pid 写法：`wmic` 的 where 谓词是**纯 processid** ⇒ 走的是按 pid 的写法，放行。
	const s7g = await runScenario('wmic process where processid=1234 delete');
	check('wmic-pid-addressed-is-allowed', isAllowed(s7g),
		JSON.stringify({ isError: s7g.isError, reachedExecutor: s7g.reachedExecutor, tail: s7g.tail }));

	// ── ⑧ 被拒的命令绝不抵达执行器（闸挡在真正执行之前）─────────────────────────────────────────
	const DANGEROUS = [
		'taskkill //F //IM node.exe',
		'pkill node',
		'Stop-Process -Name node -Force',
		'taskkill -F -IM notepad.exe',
		'Stop-Process notepad',
		'Get-Process node | Stop-Process',
		`wmic process where "name='node.exe'" delete`,
		'sudo pkill node',
		'killall node',
	];
	const leaked = DANGEROUS.filter((command) => stubCalls.includes(command));
	check('blocked-commands-never-reached-the-executor', leaked.length === 0,
		JSON.stringify({ 泄漏到执行器的: leaked, 替身记录总数: stubCalls.length, 替身记录: stubCalls }));
} catch (error) {
	primaryError = error;
	process.stdout.write(`\n✗ FAIL（异常，不是断言红）：${error?.stack || error}\n`);
} finally {
	if (server) await cleanupStep(cleanupProblems, 'close fake provider', () => new Promise((resolve) => server.close(resolve)));
	await cleanupStep(cleanupProblems, 'remove sandbox', () => removeSandbox(sandbox, cleanupProblems));

	const red = results.filter((row) => !row.ok).map((row) => row.id);
	if (ARM) {
		const arm = ARM_EXPECT[ARM];
		const notRed = arm.expect.filter((id) => !red.includes(id));
		const wronglyRed = (arm.expectGreen ?? []).filter((id) => red.includes(id));
		print(`反证臂 ${ARM} 结果`, { what: arm.what, expect: arm.expect, expectGreen: arm.expectGreen ?? [], actuallyRed: red });
		if (notRed.length === 0 && wronglyRed.length === 0 && cleanupProblems.length === 0 && primaryError === null) {
			print('RESULT', `反证臂 ${ARM} 红到位（这是**期望**的结果，不是缺陷）：该红的 ${arm.expect.length} 条都红了（${arm.expect.join(', ')}），其余 ${(arm.expectGreen ?? []).length} 条仍绿`);
		} else {
			print('RESULT', `反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}；本该留绿却红了 ${JSON.stringify(wronglyRed)}；异常 ${primaryError ? String(primaryError.message ?? primaryError) : '无'}；收尾问题 ${JSON.stringify(cleanupProblems)} ⇒ 这道门是个假门`);
			process.exitCode = 1;
		}
	} else {
		if (primaryError !== null) { process.exitCode = 1; print('RESULT', `按名字杀进程形状闸门 FAIL（异常，不是断言红）：${String(primaryError.message ?? primaryError)}`); }
		else if (cleanupProblems.length > 0) { process.exitCode = 1; print('RESULT', `收尾不干净：${JSON.stringify(cleanupProblems)}`); }
		else if (red.length > 0) { process.exitCode = 1; print('RESULT', `按名字杀进程形状闸门 FAIL：红了 ${JSON.stringify(red)}`); }
		else print('RESULT', `按名字杀进程形状闸门 PASS（${checks.passed} 项断言，全集 ${JSON.stringify(results.map((row) => row.id))}）`);
	}
	try { finishCleanup(primaryError, cleanupProblems); } catch (error) { process.stdout.write(`finishCleanup: ${error?.message || error}\n`); process.exitCode = 1; }
}
