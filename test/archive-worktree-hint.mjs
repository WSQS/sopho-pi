#!/usr/bin/env node
// 门：**归档回执里的 worktree 提示**（`session_archive` 的「只提示、绝不自动回收」那一段）。
//
// ── 为什么要有它（依据：`docs/plans/diagnosis-2026-10-09-subagent-management.md` §3④ ＋ §5 修法 4）──
// `archiveSession()` 只写一个 `sopho.archive` 标记：不读 worktree、不发通知、不关联分支；
// 而「跑完 ≠ 归档 ≠ 收树 ≠ 合分支」四个动作各走各的 —— **归档那一刻是唯一还看得见「它占着什么」的时刻**。
// 诊断单实测代价：25 个成功子会话里 23 个未归档、`reclaim_worktree` 调用 **0** 次、主仓挂着 12 棵 worktree、
// 一条未归档会话还把后来的派单挡成 `409 workspace_conflict`。本门钉住那一段提示的**形状与诚实**。
//
// ── 判据（跑的是**真插件文件** `pi-extensions/assistant/index.ts` ＋ 假 provider ＋ 假委派宿主）──────
//   · 真 git 沙箱仓 ＋ 真 worktree：分支**自己**比基点多 1 个提交 / 1 个文件改动，而**基点落后**
//     （`origin/master` 先被往前推 3 个提交）⇒ 「三点（它自己的改动）」与「两点（两条 tip 的差异）」
//     必然给出**不同**的数字（2026-10-11 修的那个 bug：老夹具里基点＝tip 的父提交 ⇒ 两种算法同结果、抓不到）；
//   · 会话文件（`$ASSIST_HOME/sessions/<ts>_<uuid>.jsonl`，**一手来源**）的 header `cwd` 指向它；
//   · 假 provider 让模型打一个 `session_archive {id}`，假宿主的 `POST /sessions/{id}/archive` 回 200；
//   · 然后逐条读回**真插件**吐出来的工具回执。
//   ① worktree 会话 ⇒ 回执里有 `worktreeHint.state==="worktree"` ＋ 路径/分支/未并入计数；
//   ①' 「未并入」那组数字必须描述**它自己的改动**（`commitsAhead` 两点 ＋ 文件数走 `origin/master...branch`
//       三点 = merge-base→tip），并另给 `mergeBase{sha,date}`；而「并进 master 会带来多少变化」（两条 tip 的差异）
//       另存 `vsMasterTwoDot`，**绝不**混进那组冒充「它自己的改动」（这三条是本单的**核心断言**）；
//   ② 同一段话点名 `reclaim_worktree`，并明说「**不会**自动收」；
//   ③ cwd = 主检出（普通目录／不是 worktree）⇒ 回执**什么都不加**（不要噪音）；
//   ④ cwd **不在任何 git 仓里** ⇒ 同样**什么都不加**（**确定它没占 worktree**，是成功判定不是失败；业主 2026-10-10 拍板）；
//   ⑤ 会话 header 里没有 cwd ⇒ **如实降级**（**判不出来**才说，不许猜）；
//   ⑤' git 不在（把 PATH 清成空目录）⇒ 同样**如实降级**；
//   ⑥ **任何分支**的回执都不许出现「已删除／已回收」这类话，也不许有任何回收副作用
//      （真 git 上复核：worktree 目录还在、`git worktree list` 还注册着、分支还在）。
//
// ── 反证臂 `--reverse-arm=no-hint`（本仓惯例）────────────────────────────────────────────────
// ① `--reverse-arm=no-hint`：把「查 worktree」整段拿掉（副本 `index.ts` 那句 `archiveWorktreeHint(params.id)`
//    换成 `null` —— 与「这段查询根本不存在」是**同一个行为**）⇒ ①②⑤⑤' 必须红，③④⑥ 仍绿。
// ② `--reverse-arm=non-git-degrades`：把「cwd 不在任何 git 仓里」退回旧行为（当成**判不出来** ⇒
//    降级文案）—— 那正是业主 2026-10-10 拍板否掉的形状 ⇒ ④ 必须红，其余仍绿（钉「④ 那条静默断言有牙」）。
// ③ `--reverse-arm=two-dot-stats`：在副本 `worktree-hint.mjs` 里把「它自己的改动」那步的**三点**
//    （`origin/master...branch` = merge-base→tip）退回**两点**（`origin/master..branch` = 两条 tip 的差异）
//    —— 就是本单修掉的那个 bug ⇒ ①①' 那三条（数字与文案）必须红，`mergeBase` 那条仍绿。
// 红时的原始输出见交付报告。
//
// 沙箱：临时 `ASSIST_HOME` ＋ 临时 git 仓 ＋ 高位随机端口 ＋ 假 provider／假委派宿主；
// 不碰真 profile、不碰 7331/7321、不碰真仓库的 worktree（`git worktree add` 只在本临时仓里做）。
// 用法：node test/archive-worktree-hint.mjs [--reverse-arm=no-hint|non-git-degrades|two-dot-stats]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
const SILENT_IDS = ['main-checkout-receipt-adds-nothing', 'non-git-cwd-receipt-is-silent', 'no-receipt-ever-claims-deletion-or-reclaim', 'worktree-and-branch-still-there-after-archiving', 'extension-loaded-without-errors'];
const ARM_EXPECT = {
	'no-hint': {
		what: '在**副本树**里把「查 worktree」整段拿掉（`index.ts` 直接 `const hint = null`）—— 回到「归档回执一个字都不加」的老行为',
		expect: ['worktree-receipt-names-path-branch-and-unmerged-counts', 'worktree-receipt-points-at-reclaim-worktree-and-says-it-will-not-reclaim', 'header-without-cwd-receipt-degrades-honestly', 'git-missing-receipt-degrades-honestly'],
		expectGreen: SILENT_IDS,
	},
	'non-git-degrades': {
		what: '在**副本树**里把「cwd 不在任何 git 仓里」退回旧行为（当成**判不出来** ⇒ 降级文案）—— 正是业主 2026-10-10 拍板否掉的形状',
		expect: ['non-git-cwd-receipt-is-silent'],
		expectGreen: [...SILENT_IDS.filter((id) => id !== 'non-git-cwd-receipt-is-silent'), 'worktree-receipt-names-path-branch-and-unmerged-counts', 'worktree-receipt-points-at-reclaim-worktree-and-says-it-will-not-reclaim', 'header-without-cwd-receipt-degrades-honestly', 'git-missing-receipt-degrades-honestly'],
	},
	'two-dot-stats': {
		what: '在**副本树**里把「它自己的改动」那步的**三点**（`origin/master...branch` = merge-base→tip）退回**两点**（`origin/master..branch` = 两条 tip 的差异）—— 就是本单修掉的那个 bug',
		expect: ['worktree-receipt-names-path-branch-and-unmerged-counts', 'unmerged-file-stats-describe-branch-own-changes', 'receipt-note-separates-own-changes-from-merge-impact'],
		expectGreen: [...SILENT_IDS, 'worktree-receipt-points-at-reclaim-worktree-and-says-it-will-not-reclaim', 'header-without-cwd-receipt-degrades-honestly', 'git-missing-receipt-degrades-honestly', 'unmerged-report-includes-merge-base-sha-and-date'],
	},
};
if (ARM && !ARM_EXPECT[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_EXPECT).join(' / ')}）`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_PATH = path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-archhint-'));
const HOME = path.join(sandbox, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(sandbox, 'cwd');
const MAIN_REPO = path.join(sandbox, 'mainrepo');
const PLAIN_DIR = path.join(sandbox, 'plain-no-git');
const EMPTY_PATH_DIR = path.join(sandbox, 'empty-path');
const WT_NAME = 'hintwt';
const WT_BRANCH = `wt/${WT_NAME}`;
const WT_PATH = path.join(sandbox, '.sopho-wt', WT_NAME);
// 基准比分支基点**往前推**这么多提交 ⇒ 「它自己的改动」（三点）与「两条 tip 的差异」（两点）必然不同。
const MASTER_EXTRA = 3;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const results = [];
const checks = { passed: 0, failed: 0 };
const check = (id, ok, detail) => {
	results.push({ id, ok });
	if (ok) { checks.passed += 1; process.stdout.write(`✓ ${id} —— ${detail}\n`); }
	else { checks.failed += 1; process.stdout.write(`✗ ${id}\n  实测：${detail}\n`); }
};

let providerServer = null;
let hostServer = null;
let primaryError = null;
const cleanupProblems = [];
const receipts = [];
// 反证臂改的是**副本**里的插件（与 `test/archive-session-tool.mjs` 同一写法）；正常跑就是真插件文件。
let pluginPath = PLUGIN_PATH;

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
		model: 'fake-archhint',
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(includeUsage ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}),
	})}\n\n`);
}

// ── 夹具 git 仓（**本门的沙箱里**，不碰真仓）──────────────────────────────────────────────────
function git(args, cwd) {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) return reject(new Error(`git ${args.join(' ')} (cwd=${cwd}) 失败：${String(stderr || error.message)}`));
			resolve(String(stdout));
		});
	});
}

async function setupGitFixture() {
	await mkdir(MAIN_REPO, { recursive: true });
	await git(['init', '-b', 'master'], MAIN_REPO).catch(async () => {
		await git(['init'], MAIN_REPO);
		await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], MAIN_REPO);
	});
	await git(['config', 'user.email', 'sandbox@example.invalid'], MAIN_REPO);
	await git(['config', 'user.name', 'Archhint Sandbox'], MAIN_REPO);
	await git(['config', 'commit.gpgsign', 'false'], MAIN_REPO);
	await writeFile(path.join(MAIN_REPO, 'base.txt'), 'base\n');
	await git(['add', 'base.txt'], MAIN_REPO);
	await git(['commit', '-m', 'base'], MAIN_REPO);
	const baseSha = (await git(['rev-parse', 'HEAD'], MAIN_REPO)).trim();
	const baseDate = (await git(['log', '-1', '--format=%ci', baseSha], MAIN_REPO)).trim();
	// 基准引用：主口径是 `origin/master`（`BASE_REF_CANDIDATES` 的第一位）—— 用一条 ref 直接建出来，
	// 不需要真远端（本门只量「未并入计数」，不 push）。
	await git(['update-ref', 'refs/remotes/origin/master', 'HEAD'], MAIN_REPO);
	// worktree 从**当前** HEAD 切出来（= 基点）；切完再把 master 往前推 ⇒ 分支的基点就**落后**了。
	await mkdir(path.dirname(WT_PATH), { recursive: true });
	await git(['worktree', 'add', '-b', WT_BRANCH, WT_PATH, 'HEAD'], MAIN_REPO);
	// 分支**自己**只改 1 个文件（提示要如实量出「它自己的改动」这两个数）。
	await writeFile(path.join(WT_PATH, 'base.txt'), 'base\nsandbox work\n');
	await git(['add', 'base.txt'], WT_PATH);
	await git(['commit', '-m', 'sandbox work'], WT_PATH);
	// ⚠️ 关键：让分支基点**落后**。老夹具里基点就是 tip 的父提交 ⇒ 「三点」与「两点」结果相同、抓不到
	// 「两种基准混在一起」这个 bug。这里先把 master 往前推 3 个提交（各一个只在基准侧存在的文件），
	// 再把 origin/master 指到 master 新 tip ⇒ `origin/master..branch` 仍是**这 1 个提交**，
	// 而 `diff origin/master branch`（两条 tip 的差异）会把这 3 个文件全算进来
	//（= 旧代码误导人的那个形状：实测 1 个提交 / 322 个文件）。
	for (let index = 1; index <= MASTER_EXTRA; index += 1) {
		await writeFile(path.join(MAIN_REPO, `master-only-${index}.txt`), `master only ${index}\n`);
		await git(['add', `master-only-${index}.txt`], MAIN_REPO);
		await git(['commit', '-m', `master-only ${index}`], MAIN_REPO);
	}
	await git(['update-ref', 'refs/remotes/origin/master', 'HEAD'], MAIN_REPO);
	// 夹具自己**分别**量两种算法 ＋ 分叉点：每条一行原始输出（本单「新旧对照」的一手证据）。
	const counts = {
		commits: (await git(['rev-list', '--count', `origin/master..${WT_BRANCH}`], WT_PATH)).trim(),
		ownThreeDot: (await git(['diff', '--numstat', `origin/master...${WT_BRANCH}`], WT_PATH)).trim(),
		twoTipTwoDot: (await git(['diff', '--numstat', `origin/master..${WT_BRANCH}`], WT_PATH)).trim(),
		mergeBaseSha: (await git(['merge-base', 'origin/master', WT_BRANCH], WT_PATH)).trim(),
		baseSha,
	};
	print('沙箱 git 夹具', { MAIN_REPO, WT_PATH, WT_BRANCH, MASTER_EXTRA, counts, worktrees: (await git(['worktree', 'list', '--porcelain'], MAIN_REPO)).split('\n').filter((line) => line.startsWith('worktree ')) });
	assert.equal(counts.mergeBaseSha, baseSha, '夹具自检：分支的分叉点必须还是老基点（否则这条夹具区分不了两种基准）');
	assert.notEqual(counts.ownThreeDot, counts.twoTipTwoDot, '夹具自检：三点/两点必须给出**不同**的数字（否则这条夹具抓不到 bug）');
	return { baseSha, baseDate, counts };
}

// ── 会话夹具：一手来源 = 会话文件自己的 header（`$ASSIST_HOME/sessions`）──────────────────────
async function writeSessionFixture(id, cwd) {
	const header = { type: 'session', id, cwd, timestamp: '2026-10-09T00:00:00.000Z', parentSession: null };
	if (cwd === null) delete header.cwd;
	await writeFile(path.join(SESSIONS, `2026-10-09T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify(header)}\n`);
	return id;
}

function lastToolResult(session) {
	const branch = session.sessionManager.getBranch();
	const rows = branch.filter((row) => row.type === 'message' && row.message?.role === 'toolResult');
	const entry = rows.at(-1);
	if (!entry) return null;
	const text = (entry.message.content ?? []).map((part) => part.text ?? '').join('');
	let receipt = null;
	try { receipt = JSON.parse(text); } catch { receipt = { unparsable: text }; }
	return { isError: entry.message.isError === true, receipt, text };
}

const plan = { args: null };

try {
	for (const directory of [HOME, SESSIONS, CWD, PLAIN_DIR, EMPTY_PATH_DIR]) await mkdir(directory, { recursive: true });
	const fixture = await setupGitFixture();
	if (ARM) {
		// 反证臂一律在**副本树**里改（与 `test/archive-session-tool.mjs` 同一写法），真树一个字节不动。
		const tree = path.join(sandbox, 'reverse-tree');
		await mkdir(path.join(tree, 'pi-extensions'), { recursive: true });
		await cp(path.join(ROOT, 'pi-extensions', 'assistant'), path.join(tree, 'pi-extensions', 'assistant'), { recursive: true });
		await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
		const indexFile = path.join(tree, 'pi-extensions', 'assistant', 'index.ts');
		const hintFile = path.join(tree, 'pi-extensions', 'assistant', 'worktree-hint.mjs');
		if (ARM === 'no-hint') {
			// 把「查 worktree」整段拿掉（`archiveWorktreeHint(params.id)` 调用换成 `null`）
			// ⇒ 回执里一个字都不加 ⇒ ①②⑤⑤' 必须红。
			const source = await readFile(indexFile, 'utf8');
			const from = '\t\t\tconst hint = ok && archived ? await archiveWorktreeHint(params.id) : null;';
			assert.ok(source.includes(from), '反证臂（no-hint）：要拿掉的那一行在插件里找得到（接缝形状变了？）');
			await writeFile(indexFile, source.replace(from, '\t\t\tconst hint = null; // reverse arm: 「查 worktree」整段拿掉'));
			print('reverse-arm mutation', { arm: ARM, mutation: 'index.ts：整段去掉 archiveWorktreeHint 调用（= 归档回执一个字都不加）', tree });
		} else if (ARM === 'non-git-degrades') {
			// 把「不在任何 git 仓里」退回旧行为（当成**判不出来** ⇒ 降级文案）⇒ ④ 必须红。
			const source = await readFile(hintFile, 'utf8');
			const from = '\t\tif (NOT_A_REPO.test(raw)) return { state: "not_worktree", note: null, reason: `cwd 不在任何 git 仓里（${raw}）⇒ 确定它没占 worktree`, cwd: cwdRaw };';
			assert.ok(source.includes(from), '反证臂（non-git-degrades）：要改的那一行在提示器里找得到（接缝形状变了？）');
			await writeFile(hintFile, source.replace(from, '\t\tif (NOT_A_REPO.test(raw)) return unknown("unknown", "reverse arm: 把「不在任何 git 仓里」当成判不出来", { cwd: cwdRaw, gitError: raw });'));
			print('reverse-arm mutation', { arm: ARM, mutation: 'worktree-hint.mjs：「不在任何 git 仓里」退回旧行为（降级文案）', tree });
		} else if (ARM === 'two-dot-stats') {
			// 把「它自己的改动」那一步的**三点**退回**两点**（= 本单修掉的那个 bug）⇒ ①①' 必须红。
			const source = await readFile(hintFile, 'utf8');
			const from = '\t\tconst own = await gitBounded(["diff", "--numstat", `${baseRef}...${branchRef}`], repo, budget);';
			const to = '\t\tconst own = await gitBounded(["diff", "--numstat", `${baseRef}..${branchRef}`], repo, budget); // reverse arm: 三点退回两点（两条 tip 的差异）';
			assert.ok(source.includes(from), '反证臂（two-dot-stats）：要改的那一行在提示器里找得到（接缝形状变了？）');
			await writeFile(hintFile, source.replace(from, to));
			print('reverse-arm mutation', { arm: ARM, mutation: 'worktree-hint.mjs：「它自己的改动」那步的三点（origin/master...branch）退回两点（origin/master..branch）', tree });
		}
		pluginPath = indexFile;
	}

	// ── 假委派宿主：唯一需要的路由是 `POST /sessions/{id}/archive`（工具是它的薄封装）────────────
	const hostPort = await reserveHighPort();
	const hostRequests = [];
	hostServer = http.createServer(async (request, response) => {
		let raw = '';
		for await (const chunk of request) raw += chunk;
		hostRequests.push({ method: request.method, url: request.url, body: raw === '' ? null : JSON.parse(raw) });
		const match = /^\/sessions\/([^/]+)\/archive$/.exec(request.url ?? '');
		if (request.method === 'POST' && match) {
			const id = decodeURIComponent(match[1]);
			const body = raw === '' ? {} : JSON.parse(raw);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ id, archived: body.archived ?? true, changed: true, by: body.by ?? null, at: Date.now() }));
			return;
		}
		response.writeHead(404, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: 'not_found', url: request.url }));
	});
	await new Promise((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(hostPort, '127.0.0.1', resolve); });

	// ── 假 provider：第一跳按 `plan.args` 打 `session_archive`，第二跳收尾 ──────────────────────────
	const providerPort = await reserveHighPort();
	providerServer = http.createServer(async (request, response) => {
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		// 只看**最后一条**是不是工具结果 —— 历史里已经躺着的 toolResult 不算（否则第二轮起就不再打工具了）。
		const hasToolResult = body.messages.at(-1)?.role === 'tool';
		response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
		if (!hasToolResult) {
			if (!plan.args) throw new Error('假 provider 在模型没排工具调用时就收到了首发请求');
			sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: 'session_archive', arguments: JSON.stringify(plan.args) } }] });
			sse(response, {}, 'tool_calls', true);
		} else {
			sse(response, { role: 'assistant', content: 'AH_TURN_DONE' });
			sse(response, {}, 'stop', true);
		}
		response.end('data: [DONE]\n\n');
	});
	await new Promise((resolve, reject) => { providerServer.once('error', reject); providerServer.listen(providerPort, '127.0.0.1', resolve); });

	await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox',
		models: [{ id: 'fake-archhint', name: 'Fake Archhint', contextWindow: 8192, maxTokens: 512 }],
	} } }, null, 2)}\n`);
	await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({
		defaultProvider: 'fake', defaultModel: 'fake-archhint', defaultThinkingLevel: 'off',
		compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
	}, null, 2)}\n`);

	// 插件读宿主地址与会话目录都走环境变量（与线上同一条式子）。
	process.env.SOPHO_DELEGATION_URL = `http://127.0.0.1:${hostPort}`;
	process.env.ASSIST_HOME = HOME;
	process.env.SOPHO_AGENT_DIR = HOME;
	process.env.PI_CODING_AGENT_DIR = HOME;
	process.env.PI_CODING_AGENT_SESSION_DIR = SESSIONS;

	const settingsManager = SettingsManager.create(CWD, HOME);
	const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: HOME, settingsManager, additionalExtensionPaths: [pluginPath] });
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors ?? [];
	print('插件装载错误', extensionErrors);
	check('extension-loaded-without-errors', extensionErrors.length === 0,
		`loader.getExtensions().errors=${JSON.stringify(extensionErrors)}（真插件文件必须装得上，否则下面的判据是空跑）`);

	const modelRuntime = await ModelRuntime.create({ authPath: path.join(HOME, 'auth.json'), modelsPath: path.join(HOME, 'models.json') });
	const model = modelRuntime.getModel('fake', 'fake-archhint');
	assert.ok(model, '假 provider 的模型没解析出来');
	const { session } = await createAgentSession({
		cwd: CWD, agentDir: HOME, modelRuntime, model, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.create(CWD, SESSIONS),
	});

	// ── 场景驱动器：一次归档 = 一个目标 id ＋ 一份会话文件夹具 ＋ 一次工具调用 ──────────────────────
	async function runArchiveScenario({ label, targetId, cwd }) {
		await writeSessionFixture(targetId, cwd);
		plan.args = { id: targetId };
		const startedAt = Date.now();
		let promptError = null;
		let timer = null;
		try {
			await Promise.race([
				session.prompt(`AH_SCENARIO ${label}`).catch((error) => { promptError = error; }),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__AH_WATCHDOG__')), 30_000); }),
			]);
		} catch (error) {
			if (!String(error?.message).includes('__AH_WATCHDOG__')) throw error;
			await session.abort();
			throw new Error(`场景 ${label} 超时（30 s）`);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (promptError) throw promptError;
		const result = lastToolResult(session);
		assert.ok(result, `场景 ${label}：拿不到工具回执`);
		const reading = { label, targetId, cwd, elapsedMs: Date.now() - startedAt, isError: result.isError, receipt: result.receipt };
		print(`场景 ${label}`, reading);
		receipts.push(reading);
		return reading;
	}

	const worktreeId = randomUUID();
	const plainId = randomUUID();
	const nonGitId = randomUUID();
	const noGitId = randomUUID();
	const noCwdId = randomUUID();

	// ① worktree 会话
	const scenarioWorktree = await runArchiveScenario({ label: 'worktree', targetId: worktreeId, cwd: WT_PATH });
	check('worktree-receipt-names-path-branch-and-unmerged-counts',
		scenarioWorktree.isError === false
			&& scenarioWorktree.receipt?.worktreeHint?.state === 'worktree'
			&& scenarioWorktree.receipt.worktreeHint.worktree === WT_PATH
			&& scenarioWorktree.receipt.worktreeHint.branch === WT_BRANCH
			&& scenarioWorktree.receipt.worktreeHint.unmerged?.commitsAhead === 1
			&& scenarioWorktree.receipt.worktreeHint.unmerged?.filesChanged === 1
			&& scenarioWorktree.receipt.worktreeHint.unmerged?.baseRef === 'origin/master'
			&& String(scenarioWorktree.receipt?.note ?? '').includes(WT_PATH)
			&& String(scenarioWorktree.receipt?.note ?? '').includes(WT_BRANCH),
		JSON.stringify({ state: scenarioWorktree.receipt?.worktreeHint?.state ?? null, worktree: scenarioWorktree.receipt?.worktreeHint?.worktree ?? null, branch: scenarioWorktree.receipt?.worktreeHint?.branch ?? null, unmerged: scenarioWorktree.receipt?.worktreeHint?.unmerged ?? null, note: scenarioWorktree.receipt?.note ?? null }));
	check('worktree-receipt-points-at-reclaim-worktree-and-says-it-will-not-reclaim',
		String(scenarioWorktree.receipt?.note ?? '').includes('reclaim_worktree') && String(scenarioWorktree.receipt?.note ?? '').includes('我不会自动收'),
		JSON.stringify({ note: scenarioWorktree.receipt?.note ?? null }));

	// ①' —— 本单的**核心断言**：「未并入」那组文件数必须与 `commitsAhead` 描述**同一件事**（它自己的改动），
	// 而不是**两条 tip 的差异**。夹具里基点落后 3 个提交（master 侧 3 个文件）⇒ 两种算法必然不同：
	//   它自己的改动（三点）= 1 个文件；两条 tip 的差异（两点）= 1 + MASTER_EXTRA 个文件。
	// 老夹具里两者相等 ⇒ 这条断言在旧代码上也能过（抓到不 bug）；基点落后了才有牙。
	const worktreeUnmerged = scenarioWorktree.receipt?.worktreeHint?.unmerged ?? null;
	const expectedOwnFiles = 1; // 分支自己只改了 base.txt 一个文件
	const expectedOwnAdditions = 1; // 'base\n' → 'base\nsandbox work\n'
	const expectedOwnDeletions = 0;
	const expectedTwoDotFiles = 1 + MASTER_EXTRA; // 它自己那 1 个文件 ＋ 只在基准侧的 3 个文件
	check('unmerged-file-stats-describe-branch-own-changes',
		worktreeUnmerged?.filesChanged === expectedOwnFiles
			&& worktreeUnmerged?.additions === expectedOwnAdditions
			&& worktreeUnmerged?.deletions === expectedOwnDeletions
			&& worktreeUnmerged?.commitsAhead === 1
			&& worktreeUnmerged?.vsMasterTwoDot?.files === expectedTwoDotFiles
			&& worktreeUnmerged?.vsMasterTwoDot?.additions === expectedOwnAdditions
			&& worktreeUnmerged?.vsMasterTwoDot?.deletions === MASTER_EXTRA
			&& worktreeUnmerged?.vsMasterTwoDot?.files !== worktreeUnmerged?.filesChanged,
		JSON.stringify({ unmerged: worktreeUnmerged, expected: { commitsAhead: 1, filesChanged: expectedOwnFiles, additions: expectedOwnAdditions, deletions: expectedOwnDeletions, vsMasterTwoDot: { files: expectedTwoDotFiles, additions: expectedOwnAdditions, deletions: MASTER_EXTRA } }, fixtureMeasured: { ownThreeDot: fixture.counts.ownThreeDot, twoTipTwoDot: fixture.counts.twoTipTwoDot, commits: fixture.counts.commits }, why: '「未并入」那组的文件数必须 = 分支自己那一笔（三点），不是两条 tip 的差异（两点）；其余差异另存 vsMasterTwoDot' }));

	// ①' —— 基点透明化：把「它有多旧」摊在明面上（sha ＋ 日期），读的人一眼知道数字为何是这样。
	check('unmerged-report-includes-merge-base-sha-and-date',
		worktreeUnmerged?.mergeBase?.sha === fixture.baseSha
			&& typeof worktreeUnmerged?.mergeBase?.date === 'string'
			&& worktreeUnmerged.mergeBase.date === fixture.baseDate
			&& worktreeUnmerged.mergeBase.date.length > 0,
		JSON.stringify({ mergeBase: worktreeUnmerged?.mergeBase ?? null, expected: { sha: fixture.baseSha, date: fixture.baseDate } }));

	// ①' —— 文案：读起来必须能分清「它自己的改动」与「合并会带来的变化」（不许混淆措辞）。
	const worktreeHintNote = String(scenarioWorktree.receipt?.worktreeHint?.note ?? '');
	check('receipt-note-separates-own-changes-from-merge-impact',
		worktreeHintNote.includes('这 1 个提交自己改了 1 个文件')
			&& worktreeHintNote.includes('不是它自己的改动')
			&& worktreeHintNote.includes(`并进 origin/master 会带来 ${expectedTwoDotFiles} 个文件的变化`),
		JSON.stringify({ note: worktreeHintNote, expectedSubstrings: ['这 1 个提交自己改了 1 个文件', '不是它自己的改动', `并进 origin/master 会带来 ${expectedTwoDotFiles} 个文件的变化`] }));

	// ③ cwd = 主检出（普通目录：在 git 仓里，但不是 worktree）⇒ 什么都不加
	const scenarioPlain = await runArchiveScenario({ label: 'main-checkout', targetId: plainId, cwd: MAIN_REPO });
	check('main-checkout-receipt-adds-nothing',
		scenarioPlain.isError === false
			&& scenarioPlain.receipt?.worktreeHint === undefined
			&& !/worktree/i.test(String(scenarioPlain.receipt?.note ?? ''))
			&& !String(scenarioPlain.receipt?.note ?? '').includes('reclaim_worktree'),
		JSON.stringify({ worktreeHint: scenarioPlain.receipt?.worktreeHint ?? null, note: scenarioPlain.receipt?.note ?? null }));

	// ④ cwd **不在任何 git 仓里** ⇒ 静默（**确定它没占 worktree**；业主 2026-10-10 拍板）
	const scenarioNonGit = await runArchiveScenario({ label: 'non-git-cwd', targetId: nonGitId, cwd: PLAIN_DIR });
	check('non-git-cwd-receipt-is-silent',
		scenarioNonGit.isError === false
			&& scenarioNonGit.receipt?.worktreeHint === undefined
			&& !/worktree|查不到/i.test(String(scenarioNonGit.receipt?.note ?? '')),
		JSON.stringify({ worktreeHint: scenarioNonGit.receipt?.worktreeHint ?? null, note: scenarioNonGit.receipt?.note ?? null }));

	// ⑤ git 不在（把 PATH 清成一个空目录）⇒ **判不出来** ⇒ 仍如实降级
	const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
	const savedPath = process.env[pathKey];
	process.env[pathKey] = EMPTY_PATH_DIR;
	let scenarioNoGit;
	try {
		scenarioNoGit = await runArchiveScenario({ label: 'git-missing', targetId: noGitId, cwd: PLAIN_DIR });
	} finally {
		process.env[pathKey] = savedPath;
	}
	check('git-missing-receipt-degrades-honestly',
		scenarioNoGit.isError === false
			&& scenarioNoGit.receipt?.worktreeHint?.state === 'unknown'
			&& String(scenarioNoGit.receipt?.worktreeHint?.note ?? '').includes('查不到它的 worktree 归属')
			&& String(scenarioNoGit.receipt?.worktreeHint?.reason ?? '').length > 0,
		JSON.stringify({ worktreeHint: scenarioNoGit.receipt?.worktreeHint ?? null, note: scenarioNoGit.receipt?.note ?? null }));

	// ⑤' 会话 header 里没有 cwd ⇒ 同样如实降级（不许猜）
	const scenarioNoCwd = await runArchiveScenario({ label: 'header-without-cwd', targetId: noCwdId, cwd: null });
	check('header-without-cwd-receipt-degrades-honestly',
		scenarioNoCwd.isError === false
			&& scenarioNoCwd.receipt?.worktreeHint?.state === 'unknown'
			&& String(scenarioNoCwd.receipt?.worktreeHint?.note ?? '').includes('查不到它的 worktree 归属'),
		JSON.stringify({ worktreeHint: scenarioNoCwd.receipt?.worktreeHint ?? null, note: scenarioNoCwd.receipt?.note ?? null }));

	// ⑥ 任何分支都不许出现「已删除/已回收」，也不许有任何回收副作用
	const forbidden = /已删除|已回收|deleted|removed|reclaimed/i;
	const offenders = receipts
		.map((row) => ({ label: row.label, hit: forbidden.exec(JSON.stringify(row.receipt))?.[0] ?? null }))
		.filter((row) => row.hit !== null);
	const worktreeListAfter = (await git(['worktree', 'list', '--porcelain'], MAIN_REPO)).replace(/\\/g, '/');
	const branchListAfter = await git(['branch', '--list', WT_BRANCH], MAIN_REPO);
	const dirStillThere = await readFile(path.join(WT_PATH, 'base.txt'), 'utf8').then(() => true).catch(() => false);
	const wtPathPosix = WT_PATH.replace(/\\/g, '/');
	check('no-receipt-ever-claims-deletion-or-reclaim', offenders.length === 0,
		JSON.stringify({ offenders, note: '提示只提示：回执里不许出现「已删除/已回收/deleted/removed/reclaimed」这种话' }));
	check('worktree-and-branch-still-there-after-archiving',
		dirStillThere === true && worktreeListAfter.includes(wtPathPosix) && branchListAfter.includes(WT_BRANCH),
		JSON.stringify({ dirStillThere, registered: worktreeListAfter.split('\n').filter((line) => line.startsWith('worktree ')), branch: branchListAfter.trim(), archivePosts: hostRequests.filter((row) => row.method === 'POST').length }));

	print('假宿主收到的请求', hostRequests);
	await session.dispose();
} catch (error) {
	primaryError = error;
	process.stdout.write(`\n✗ FAIL（异常，不是断言红）：${error?.stack || error}\n`);
} finally {
	for (const key of ['SOPHO_DELEGATION_URL', 'ASSIST_HOME', 'SOPHO_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']) delete process.env[key];
	if (providerServer) await cleanupStep(cleanupProblems, 'close fake provider', () => new Promise((resolve) => { providerServer.closeAllConnections(); providerServer.close(resolve); }));
	if (hostServer) await cleanupStep(cleanupProblems, 'close fake host', () => new Promise((resolve) => { hostServer.closeAllConnections(); hostServer.close(resolve); }));
	await cleanupStep(cleanupProblems, 'prune sandbox worktrees', () => git(['worktree', 'prune'], MAIN_REPO).catch(() => {}));
	await cleanupStep(cleanupProblems, 'remove sandbox', () => removeSandbox(sandbox, cleanupProblems));

	const red = results.filter((row) => !row.ok).map((row) => row.id);
	if (ARM) {
		const arm = ARM_EXPECT[ARM];
		const notRed = arm.expect.filter((id) => !red.includes(id));
		const wronglyRed = (arm.expectGreen ?? []).filter((id) => red.includes(id));
		print(`反证臂 ${ARM} 结果`, { what: arm.what, expect: arm.expect, expectGreen: arm.expectGreen ?? [], actuallyRed: red });
		if (notRed.length === 0 && wronglyRed.length === 0 && cleanupProblems.length === 0 && primaryError === null) {
			print('RESULT', `反证臂 ${ARM} 红到位（这是**期望**的结果，不是缺陷）：声明该红的 ${arm.expect.length} 条都红了（${arm.expect.join(", ")}），其余 ${(arm.expectGreen ?? []).length} 条仍绿`);
		} else {
			print('RESULT', `反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}；本该留绿却红了 ${JSON.stringify(wronglyRed)}；异常 ${primaryError ? String(primaryError.message ?? primaryError) : '无'}；收尾问题 ${JSON.stringify(cleanupProblems)} ⇒ 这道门是个假门`);
			process.exitCode = 1;
		}
	} else {
		if (primaryError !== null) { process.exitCode = 1; print('RESULT', `归档 worktree 提示门 FAIL（异常，不是断言红）：${String(primaryError.message ?? primaryError)}`); }
		else if (cleanupProblems.length > 0) { process.exitCode = 1; print('RESULT', `收尾不干净：${JSON.stringify(cleanupProblems)}`); }
		else if (red.length > 0) { process.exitCode = 1; print('RESULT', `归档 worktree 提示门 FAIL：红了 ${JSON.stringify(red)}`); }
		else print('RESULT', `归档 worktree 提示门 PASS（${checks.passed} 项断言，全集 ${JSON.stringify(results.map((row) => row.id))}）`);
	}
	try { finishCleanup(primaryError, cleanupProblems); } catch (error) { process.stdout.write(`finishCleanup: ${error?.message || error}\n`); process.exitCode = 1; }
}
