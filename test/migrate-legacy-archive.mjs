import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, stopOwnedListener } from './harness.mjs';

// H-14：v2.1 的归档旧账（sidecar `archive.json`）能不能安全地搬进 v2.2 的会话内归档账
// （custom entry `sopho.archive`）。这个契约**只**靠合成 fixture 测不出来 ——
// 必须真的有一个「旧账里躺着、会话文件里没有 sopho.archive」的 home，才能证明：
// 只读兼容虽已让用户态不再泄漏，但 sidecar 义务仍需真正迁进会话新账。
//
// 断言分三层：
//   1. 工具的效果**落在会话文件里**（`sopho.archive` 这一行真的出现了，且是 pi 自己写的形状）；
//   2. 幂等（再跑一遍不改文件）；
//   3. 迁移后 `/tree` 的账对得上（归档数、活跃数、未读数都按 v2.1 的语义走）。

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolEntry = path.join(sourceRoot, 'bin', 'migrate-legacy-archive.mjs');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'migrate-legacy-archive-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'base.log');
const reportPath = path.join(sandbox, 'report.json');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
let providerServer;
let baseChild;
let baseLog;
let providerPort;
let basePort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function api(pathname) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, { headers: { accept: 'application/json' } });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, text };
}

async function waitForHttp() {
  let lastError;
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 600 : 200); attempt += 1) {
    try {
      const response = await api('/host');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError ?? new Error('A did not become ready');
}

function runTool(args) {
  return execFileAsync(process.execPath, [toolEntry, '--api', `http://127.0.0.1:${basePort}`, '--home', home, ...args], {
    cwd: sourceRoot,
    maxBuffer: 8 * 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );
}

// 从工具输出的最后一行 JSON 里取结果（工具把人类可读的进度行放在前面）。
function toolResult(run) {
  const lines = run.stdout.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  throw new Error(`tool printed no JSON result:\n${run.stdout}\n${run.stderr}`);
}

async function archiveEntries(sessionId) {
  const file = path.join(sessionsRoot, `${sessionId}.jsonl`);
  const text = await readFile(file, 'utf8');
  return text.split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === 'sopho.archive')
    .map((entry) => entry.data?.archived);
}
function sessionFile(id) {
  return path.join(sessionsRoot, `${id}.jsonl`);
}

function assistantMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-migrate',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function writeSeedSession(id, name, sessionCwd = cwd) {
  const now = new Date().toISOString();
  const lines = [
    { type: 'session', version: 3, id, timestamp: now, cwd: sessionCwd },
    { type: 'session_info', id: '00000001', parentId: null, timestamp: now, name },
    { type: 'message', id: '00000002', parentId: '00000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: `${name} question` }], timestamp: Date.now() } },
    { type: 'message', id: '00000003', parentId: '00000002', timestamp: now, message: assistantMessage(`${name} answer`) },
  ];
  await writeFile(sessionFile(id), `${lines.map(JSON.stringify).join('\n')}\n`);
}

async function startFakeProvider() {
  const server = http.createServer((request, response) => {
    // 本测试不发 prompt（只动元数据），这个 provider 只是为了让 settings.json 指得着东西。
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not used"}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server };
}

const alpha = randomUUID();
const beta = randomUUID();
const gamma = randomUUID();
const ghost = randomUUID(); // 旧账里有、会话文件不在（v2.1 里删过文件 / 挪过位置）
const deadCwd = randomUUID(); // 会话文件在、但仓库里记的 cwd 已经不在了（删掉的工作树）

let primaryError;
try {
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);

  await writeSeedSession(alpha, 'Alpha archived in legacy ledger');
  await writeSeedSession(beta, 'Beta archived in legacy ledger');
  await writeSeedSession(gamma, 'Gamma never archived');

  // v2.1 的账：键存在 = 已归档，值是毫秒时间戳。
  const ledgerText = `${JSON.stringify({ [alpha]: 1789290726235, [beta]: 1789290726240, [ghost]: 1789290726250 }, null, 1)}\n`;
  await writeFile(path.join(home, 'archive.json'), ledgerText);

  const settledAt = Date.now() - 60_000;
  await writeFile(path.join(home, 'settled.json'), `${JSON.stringify({ [alpha]: settledAt, [beta]: settledAt + 10, [gamma]: settledAt + 20 }, null, 2)}\n`);
  await writeFile(path.join(home, 'seen.json'), '{}\n');
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-migrate', name: 'Migrate Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-migrate',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  providerServer = await startFakeProvider();
  baseLog = await open(baseLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      SOPHO_PORT: String(basePort),
      SOPHO_HOST: '127.0.0.1',
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await waitForHttp();

  const help = await runTool(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--rotate-every <n>/);
  assert.match(help.stdout, /POST <api>\/reload-code（无 body）/);
  assert.match(help.stdout, /currentGenerationId 翻代/);

  // ── 兼容基线：旧账先只读回落，用户态不泄漏；但会话文件仍没有新账，所以迁移仍有事可做 ──
  const baseline = await api('/tree');
  const baselineArchived = baseline.value.sessions.filter((session) => session.archived === true).length;
  const baselineUnread = baseline.value.unread?.count ?? null;
  assert.equal(baselineArchived, 2, '兼容层应从 archive.json 回落出两个仍存在的归档会话');
  assert.equal(baselineUnread, 1, '旧归档会话经兼容层静音，只剩没进旧账的 gamma 未读');
  print('baseline (legacy ledger read fallback, new ledger not migrated)', { archivedInTree: baselineArchived, activeInTree: baseline.value.sessions.length - baselineArchived, unread: baselineUnread });
  assert.deepEqual(await archiveEntries(alpha), [], '只读回落不等于迁移：alpha 会话文件里本来没有 sopho.archive 条目');

  // ── dry-run：只报数，一个字节都不写 ──
  const dry = await runTool(['--dry-run']);
  assert.equal(dry.code, 0, `dry-run 应当成功：${dry.stderr}`);
  const dryResult = toolResult(dry);
  assert.equal(dryResult.mode, 'dry-run');
  assert.equal(dryResult.targeted, 3);
  assert.equal(dryResult.migrated, 2);
  assert.equal(dryResult.notFound, 1);
  assert.deepEqual(await archiveEntries(alpha), [], 'dry-run 不许写文件');
  assert.equal(await readFile(path.join(home, 'archive.json'), 'utf8'), ledgerText, 'dry-run 不许改旧账');
  print('dry-run', { targeted: dryResult.targeted, wouldMigrate: dryResult.migrated, notFound: dryResult.notFound });

  // ── 真迁移：每写 1 条就轮换一次，机械证明 reload + 等新 generation 的 procedure ──
  const run = await runTool(['--rotate-every', '1', '--report', reportPath]);
  assert.equal(run.code, 0, `迁移应当成功：${run.stdout}\n${run.stderr}`);
  const result = toolResult(run);
  assert.equal(result.migrated, 2);
  assert.equal(result.notFound, 1);
  assert.equal(result.busy, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.verification.allTargetsApplied, true);
  assert.equal(result.verification.treeArchivedTotal, 2);
  assert.equal(result.verification.treeActiveTotal, 1);
  assert.equal(result.rotation.endpoint, `http://127.0.0.1:${basePort}/reload-code`);
  assert.equal(result.rotation.method, 'POST');
  assert.equal(result.rotation.body, null);
  assert.equal(result.rotation.count, 2, '--rotate-every 1：两条写入必须各触发一次 reload');
  assert.deepEqual(result.rotation.events.map((event) => event.afterMigrated), [1, 2]);
  for (const event of result.rotation.events) {
    assert.notEqual(event.fromGenerationId, event.toGenerationId, '轮换必须等到 currentGenerationId 真翻代');
    assert.notEqual(event.fromWorkerPid, event.toWorkerPid, '轮换必须看到 currentWorkerPid 改变');
    assert.equal(event.hostPid, baseChild.pid, '轮换不许重启稳定宿主');
  }
  const hostAfterRotations = await api('/host');
  assert.equal(hostAfterRotations.value.currentGenerationId, result.rotation.events.at(-1).toGenerationId);
  assert.equal(hostAfterRotations.value.workerCount, 1, '工具继续前必须等 draining worker 收完，只留 1 代');
  print('rotate-every reload contract', {
    endpoint: result.rotation.endpoint,
    body: result.rotation.body,
    waitCriterion: result.rotation.waitCriterion,
    events: result.rotation.events,
  });
  print('migrate', result);

  // 效果落在会话文件里（pi 自己写的 custom entry，形状是 {type:'custom',customType:'sopho.archive',data:{archived:true}}）
  assert.deepEqual(await archiveEntries(alpha), [true], 'alpha 会话文件里应当出现 1 条 sopho.archive=true');
  assert.deepEqual(await archiveEntries(beta), [true], 'beta 会话文件里应当出现 1 条 sopho.archive=true');
  assert.deepEqual(await archiveEntries(gamma), [], 'gamma 没进旧账，不该被动');
  assert.equal(await readFile(path.join(home, 'archive.json'), 'utf8'), ledgerText, '工具只读旧账，不许改它');
  print('session files after migrate', { alpha: await archiveEntries(alpha), beta: await archiveEntries(beta), gamma: await archiveEntries(gamma) });

  // 迁移后账对得上：归档的**不算未读**（v2.1 的语义），只剩没进旧账的 gamma
  const afterTree = await api('/tree');
  const afterById = new Map(afterTree.value.sessions.map((session) => [session.id, session]));
  assert.equal(afterById.get(alpha).archived, true);
  assert.equal(afterById.get(beta).archived, true);
  assert.equal(afterById.get(gamma).archived, false);
  assert.equal(afterTree.value.unread?.count, 1, '归档会话不该再计入未读（v2.1 语义：归档 = 我不看了）');
  assert.equal(afterTree.value.unread?.oldestId, gamma);
  print('tree after migrate', { archived: afterTree.value.sessions.filter((session) => session.archived).length, unread: afterTree.value.unread });

  // ── 幂等：再跑一遍，一条也不加，也不为了“确认已归档”重新打开 runtime ──
  const acquireBeforeAgain = (await api('/host')).value.pool.counters.acquire;
  const again = await runTool([]);
  assert.equal(again.code, 0, `第二次运行应当成功：${again.stderr}`);
  const againResult = toolResult(again);
  assert.equal(againResult.migrated, 0);
  assert.equal(againResult.already, 2);
  assert.equal(againResult.notFound, 1);
  assert.equal((await api('/host')).value.pool.counters.acquire, acquireBeforeAgain, '重跑应直接用 /tree 跳过已就位会话，不重新 acquire runtime');
  assert.deepEqual(await archiveEntries(alpha), [true], '第二次运行不许重复追加条目');
  print('idempotent rerun', { already: againResult.already, migrated: againResult.migrated, notFound: againResult.notFound, extraRuntimeAcquires: 0 });

  // ── 反向（--undo）：写 archived:false（语义反转，不是删行）──
  const undo = await runTool(['--undo']);
  assert.equal(undo.code, 0, `undo 应当成功：${undo.stderr}`);
  const undoResult = toolResult(undo);
  assert.equal(undoResult.migrated, 2);
  assert.equal(undoResult.verification.treeArchivedTotal, 0);
  assert.deepEqual(await archiveEntries(alpha), [true, false], 'undo 应当**追加**一条 archived:false（pi 读最后一条）');
  assert.equal((await api('/tree')).value.sessions.filter((session) => session.archived === true).length, 0);
  assert.equal((await api('/tree')).value.unread?.count, 3, '取消归档后未读又回来 3 个');
  print('undo', { migrated: undoResult.migrated, entries: await archiveEntries(alpha), unread: (await api('/tree')).value.unread.count });

  // ── 坏账本：一个都不动（绝不猜）──
  await writeFile(path.join(home, 'archive.json'), '{ this is not json\n');
  const broken = await runTool([]);
  assert.equal(broken.code, 2, '旧账解析失败时必须以非零退出');
  assert.match(broken.stderr, /解析失败/);
  assert.deepEqual(await archiveEntries(alpha), [true, false], '坏账本时一条都不许写');
  print('malformed ledger refused', { exitCode: broken.code, stderr: broken.stderr.trim() });

  // ── 账本不存在：也算成功（没什么可迁的）──
  await rm(path.join(home, 'archive.json'));
  const missing = await runTool([]);
  assert.equal(missing.code, 0, '没有旧账时应当成功退出');
  assert.match(missing.stderr, /旧账不存在/);
  print('missing ledger tolerated', { exitCode: missing.code, stderr: missing.stderr.trim() });

  print('report file written', JSON.parse(await readFile(reportPath, 'utf8')).verification);

  // ── 「cwd 已消失」的会话：API 根本打不开（v2.2 的池在打开时就硬要求 cwd 存在）──
  // 这不是参数错、也不是忙，得单独归类（真实 profile 里这类占 76/299）。
  await writeSeedSession(deadCwd, 'Dead cwd', path.join(sandbox, 'this-cwd-was-deleted'));
  await writeFile(path.join(home, 'archive.json'), `${JSON.stringify({ [alpha]: 1789290726235, [beta]: 1789290726240, [ghost]: 1789290726250, [deadCwd]: 1789290726260 }, null, 1)}\n`);
  const withDead = await runTool([]);
  const deadResult = toolResult(withDead);
  assert.equal(withDead.code, 1, '有开不起来的会话时不许报成功（退出码非零）');
  assert.equal(deadResult.unopenable, 1);
  assert.equal(deadResult.migrated, 2);
  assert.equal(deadResult.notFound, 1);
  assert.deepEqual(deadResult.errors, [], '「cwd 消失」不该混进 errors');
  assert.equal(deadResult.verification.allTargetsApplied, false);
  assert.match(withDead.stderr, /开不起来/);
  assert.equal(deadResult.unopenableSample[0].cwd.endsWith('this-cwd-was-deleted'), true);
  print('dead-cwd session classified', { exitCode: withDead.code, unopenable: deadResult.unopenable, sample: deadResult.unopenableSample, stderr: withDead.stderr.trim().slice(0, 160) });

  print('RESULT', 'migrate-legacy-archive PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (basePort && baseChild?.pid) {
    try { await stopOwnedListener(basePort, baseEntry, baseChild.pid); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log', baseOutput.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
