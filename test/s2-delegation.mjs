import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finishCleanup, listenerPid, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's2-delegation-'));
const home = path.join(sandbox, 'home');
const sessionsRoot = path.join(home, 'sessions');
const repo = path.join(sandbox, 'repo');
const plain = path.join(sandbox, 'plain');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const logPath = path.join(sandbox, 'base.log');
// A round on Windows takes seconds (worker start + runtime load), so a 500ms quiet window can
// elapse before the second round begins; that would turn a legitimate "round one settled and
// stayed quiet" notify into an early one. The window is widened so the gate still checks the
// same two facts (no notify before the window, notify after it) without racing process start.
const notifyQuietMs = process.platform === 'win32' ? 20000 : 500;
let provider;
let child;
let log;
let providerPort;
let basePort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 46000 + Math.floor(Math.random() * 12000); candidate < 63000; candidate += 1) {
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


async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text }; }
  return { statusCode: response.status, body: text, value };
}

async function poll(label, operation, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(35);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function waitForHttp() {
  return poll('base ready', () => api('/host').catch(() => null), (value) => value?.statusCode === 200, 15_000);
}

async function waitForIdle(sessionId) {
  return poll(`session ${sessionId} idle`, () => api(`/sessions/${sessionId}`), (response) => response.statusCode === 200
    && !response.value.runtime?.isStreaming
    && !response.value.runtime?.isCompacting
    && !response.value.runtime?.isRetrying, 15_000);
}

function usage() {
  return { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s2',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  };
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
}

async function startProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunkValue of request) raw += chunkValue;
    const body = JSON.parse(raw);
    const last = body.messages?.at(-1);
    const input = messageText(last);
    const record = { at: Date.now(), input, body };
    requests.push(record);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(`ack:${input.slice(0, 100)}`))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

async function createSession(cwd, name) {
  const response = await api('/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(response.statusCode, 201, response.body);
  return response.value.id;
}

async function messages(sessionId) {
  const response = await api(`/sessions/${sessionId}/messages`);
  assert.equal(response.statusCode, 200, response.body);
  return response.value;
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function descendantText(node) {
  return [node.textContent, ...node.children.flatMap((child) => descendantText(child))].join(' ');
}

function assistantMessageWithThinkingOnly() {
  return {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'private-only' }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-s2',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function seedZeroBodySession() {
  const id = randomUUID();
  const now = new Date().toISOString();
  const file = path.join(sessionsRoot, `zero-body_${id}.jsonl`);
  const entries = [
    { type: 'session', version: 3, id, timestamp: now, cwd: plain },
    { type: 'model_change', id: '20000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-s2' },
    { type: 'message', id: '20000002', parentId: '20000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'answer privately' }], timestamp: Date.now() } },
    { type: 'message', id: '20000003', parentId: '20000002', timestamp: now, message: assistantMessageWithThinkingOnly() },
    { type: 'session_info', id: '20000004', parentId: '20000003', timestamp: now, name: 'Zero Body' },
  ];
  await writeFile(file, `${entries.map(JSON.stringify).join('\n')}\n`);
  return id;
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(plain, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init', '-q']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 's2@example.invalid']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'S2 Test']);
  await writeFile(path.join(repo, 'README.md'), '# s2 sandbox\n');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-qm', 'seed']);
  await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted\n');

  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);
  const zeroBodyId = await seedZeroBodySession();

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-s2', name: 'S2 Fake', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-s2',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  provider = await startProvider();
  log = await open(logPath, 'w');
  child = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: repo,
      SOPHO_NOTIFY_QUIET_MS: String(notifyQuietMs),
      SOPHO_MAX_HOT: '16',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await waitForHttp();
  assert.equal(Number(await listenerPid(basePort)), child.pid);
  print('sandbox', { home, repo, plain, providerPort, basePort, notifyQuietMs, forbiddenPortsUsed: false });

  // 各臂独立报告：一臂红也要把其余臂跑完（从前的形状里，一条早失败会遮住后面所有覆盖）。
  // 跨臂状态（parent/conflict/共享 spawn/工作树 spawn/通知节点）提到外层。
  let parentId = null;
  let conflictId = null;
  let sharedSpawn = null;
  let worktreeSpawn = null;
  let targetId = null;
  let notifyTargetNode = null;
  let notifyParentNode = null;
  let firstSend = null;
  parentId = await createSession(repo, 'Parent');
  conflictId = await createSession(repo, 'Conflict Agent');

  const { failed } = await runArms([
    ['① 工具契约 preflight（四个工具都在，描述口径对）', async () => {
      const pluginPath = path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts');
      const loaded = await discoverAndLoadExtensions([pluginPath], repo, home);
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      for (const name of ['session_new', 'session_send', 'session_read', 'session_push']) assert.ok(extension.tools.has(name), `missing ${name} tool`);
      assert.match(extension.tools.get('session_new').definition.description, /nothing is created|nothing.*created/i);
      assert.match(extension.tools.get('session_new').definition.description, /non-git.*rejected/i);
      assert.match(extension.tools.get('session_send').definition.description, /quiet/i);
      print('tool contract preflight', {
        tools: [...extension.tools.keys()],
        sessionNewDescription: extension.tools.get('session_new').definition.description,
        sessionSendDescription: extension.tools.get('session_send').definition.description,
      });
      return [...extension.tools.keys()];
    }],

    ['② 工作树冲突被拒（409 workspace_conflict，节点数不变）', async () => {
      const beforeConflictTree = await api('/tree');
      const beforeCount = beforeConflictTree.value.sessions.length;
      const conflict = await api(`/sessions/${parentId}/spawn`, { method: 'POST', body: { task: 'must be refused', name: 'Rejected Child' } });
      const afterConflictTree = await api('/tree');
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.value.error, 'workspace_conflict');
      assert.equal(afterConflictTree.value.sessions.length, beforeCount);
      const blocker = conflict.value.details.conflicts.find((value) => value.id === conflictId);
      assert.ok(blocker, conflict.body);
      assert.equal(blocker.name, 'Conflict Agent');
      assert.equal(typeof blocker.running, 'boolean');
      assert.equal(blocker.isGit, true);
      assert.equal(blocker.gitRoot, repo);
      assert.equal(blocker.dirty, true);
      print('workspace conflict raw response and node count', {
        response: { statusCode: conflict.statusCode, body: conflict.value },
        treeNodesBefore: beforeCount,
        treeNodesAfter: afterConflictTree.value.sessions.length,
      });
      return { statusCode: conflict.statusCode, error: conflict.value.error };
    }],

    ['③ 显式 share:true 放行', async () => {
      sharedSpawn = await api(`/sessions/${parentId}/spawn`, {
        method: 'POST',
        body: { task: 'explicitly shared child', name: 'Shared Child', share: true, notify: false },
      });
      assert.equal(sharedSpawn.statusCode, 201, sharedSpawn.body);
      assert.equal(sharedSpawn.value.shared, true);
      assert.equal(sharedSpawn.value.cwd, repo);
      await waitForIdle(sharedSpawn.value.childSessionId);
      print('share escape accepted', { childSessionId: sharedSpawn.value.childSessionId, cwd: sharedSpawn.value.cwd, shared: sharedSpawn.value.shared });
      return { childSessionId: sharedSpawn.value.childSessionId, shared: sharedSpawn.value.shared };
    }],

    ['④ worktree:new 建出独立工作树 + 首条消息口径', async () => {
      worktreeSpawn = await api(`/sessions/${parentId}/spawn`, {
        method: 'POST',
        body: { task: 'work only in your owned tree', name: 'Worktree Child', worktree: 'new', notify: false },
      });
      assert.equal(worktreeSpawn.statusCode, 201, worktreeSpawn.body);
      targetId = worktreeSpawn.value.childSessionId;
      const worktreePath = worktreeSpawn.value.worktree.path;
      const worktreeBranch = worktreeSpawn.value.worktree.branch;
      assert.equal((await stat(worktreePath)).isDirectory(), true);
      assert.equal((await execFileAsync('git', ['-C', worktreePath, 'branch', '--show-current'])).stdout.trim(), worktreeBranch);
      const worktreeMessages = await poll('worktree first message', () => messages(targetId), (value) => value.messages.some((message) => message.role === 'user'));
      const firstUser = worktreeMessages.messages.find((message) => message.role === 'user');
      assert.match(firstUser.text, /你拥有这棵独立工作树/);
      assert.match(firstUser.text, /别碰主树/);
      await waitForIdle(targetId);
      print('worktree created', { path: worktreePath, branch: worktreeBranch, firstMessage: firstUser.text });
      return { path: worktreePath, branch: worktreeBranch };
    }],

    ['⑤ 非 git 目录 worktree:new 被拒（不许静默共享）', async () => {
      const plainParent = await createSession(plain, 'Plain Parent');
      const beforeNonGit = (await api('/tree')).value.sessions.length;
      const nonGit = await api(`/sessions/${plainParent}/spawn`, {
        method: 'POST',
        body: { task: 'must not silently share', worktree: 'new' },
      });
      const afterNonGit = (await api('/tree')).value.sessions.length;
      assert.equal(nonGit.statusCode, 409, nonGit.body);
      assert.equal(nonGit.value.error, 'worktree_requires_git');
      assert.match(nonGit.value.message, /refusing to silently share/);
      assert.equal(afterNonGit, beforeNonGit);
      print('non-git worktree refusal', { statusCode: nonGit.statusCode, body: nonGit.value, treeNodesBefore: beforeNonGit, treeNodesAfter: afterNonGit });
      return { statusCode: nonGit.statusCode, error: nonGit.value.error };
    }],

    ['⑥ notify 静默窗口（回合结束不许立刻通知；树行/前端标记也在这一臂）', async () => {
      firstSend = await api(`/sessions/${targetId}/send`, {
        method: 'POST',
        body: { fromSessionId: parentId, text: 'round-one', notify: true },
      });
      assert.equal(firstSend.statusCode, 202, firstSend.body);
      await poll('round one delivered', () => messages(targetId), (value) => value.extras.some((entry) => entry.text === 'round-one'));
      await waitForIdle(targetId);
      const firstSettledAt = Date.now();
      const notifyTree = await api('/tree');
      notifyTargetNode = notifyTree.value.sessions.find((session) => session.id === targetId);
      notifyParentNode = notifyTree.value.sessions.find((session) => session.id === parentId);
      assert.ok(notifyTargetNode.notify.notifies.some((entry) => entry.watcherSessionId === parentId));
      assert.ok(notifyParentNode.notify.waitingFor.some((entry) => entry.targetSessionId === targetId));
      const { renderTree } = await import(`${pathToFileURL(path.join(sourceRoot, 'web', 'render.js')).href}?s2=${Date.now()}`);
      const fakeDocument = new FakeDocument();
      const treeContainer = new FakeElement(fakeDocument, 'section');
      renderTree(treeContainer, notifyTree.value.sessions, () => {});
      const renderedNodes = descendants(treeContainer);
      const renderedTarget = renderedNodes.find((node) => node.dataset.sessionId === targetId);
      const renderedParent = renderedNodes.find((node) => node.dataset.sessionId === parentId);
      assert.ok(renderedTarget, `rendered target row missing: ${targetId}`);
      assert.ok(renderedParent, `rendered parent row missing: ${parentId}`);
      assert.equal(renderedTarget.dataset.notify, '1');
      assert.equal(renderedTarget.dataset.waiting, '');
      assert.equal(renderedParent.dataset.notify, '');
      assert.equal(renderedParent.dataset.waiting, '1');
      assert.match(descendantText(renderedTarget), /⇢1/);
      assert.match(descendantText(renderedParent), /⋯1/);
      assert.match(renderedTarget.title, /将通知 1 个会话/);
      assert.match(renderedParent.title, /等待 1 个子会话/);
      await sleep(Math.floor(notifyQuietMs * 0.1));
      const secondSend = await api(`/sessions/${targetId}/send`, {
        method: 'POST',
        body: { fromSessionId: parentId, text: 'round-two', notify: true },
      });
      assert.equal(secondSend.statusCode, 202, secondSend.body);
      await poll('round two delivered', () => messages(targetId), (value) => value.extras.some((entry) => entry.text === 'round-two'));
      await waitForIdle(targetId);
      const secondSettledAt = Date.now();
      await sleep(Math.floor(notifyQuietMs * 0.3));
      const parentBeforeQuiet = await messages(parentId);
      assert.equal(parentBeforeQuiet.extras.some((entry) => entry.details?.kind === 'notify'), false, 'must not notify at the first round end');
      const notified = await poll('parent notified after true quiet', () => messages(parentId), (value) => value.extras.some((entry) => entry.details?.kind === 'notify'), notifyQuietMs + 5000);
      const notifiedAt = Date.now();
      assert.ok(notifiedAt - secondSettledAt >= notifyQuietMs - 60, `notified too early: ${notifiedAt - secondSettledAt}ms`);
      const notifyEntry = notified.extras.find((entry) => entry.details?.kind === 'notify');
      print('notify quiet-window timeline', {
        firstSettledAt,
        secondSendAt: secondSettledAt,
        checkedNoNotifyAt: secondSettledAt + Math.floor(notifyQuietMs * 0.3),
        notifiedAt,
        quietAfterSecondMs: notifiedAt - secondSettledAt,
        configuredQuietMs: notifyQuietMs,
        notification: notifyEntry,
        treeWhileRegistered: { targetNotify: notifyTargetNode.notify, parentNotify: notifyParentNode.notify },
      });
      return { quietAfterSecondMs: notifiedAt - secondSettledAt, configuredQuietMs: notifyQuietMs };
    }],

    ['⑦ push 唤醒父会话 + send 回执', async () => {
      const push = await api(`/sessions/${targetId}/push`, { method: 'POST', body: { text: 'explicit child report' } });
      assert.equal(push.statusCode, 202, push.body);
      assert.equal(push.value.parentSessionId, parentId);
      const pushed = await poll('push wakes parent', () => messages(parentId), (value) => value.extras.some((entry) => entry.text === 'explicit child report'));
      assert.ok(pushed.extras.some((entry) => entry.details?.kind === 'push' && entry.details.fromSessionId === targetId));
      print('send/push wake proof', {
        sendResponse: firstSend.value,
        childReceived: ['round-one', 'round-two'],
        pushResponse: push.value,
        parentReceived: pushed.extras.filter((entry) => ['notify', 'push'].includes(entry.details?.kind)),
        providerRequestCount: provider.requests.length,
      });
      return { pushStatus: push.statusCode, parentId: push.value.parentSessionId };
    }],

    ['⑧ 正文长度为 0 的 session_read 必须明说', async () => {
      const zero = await api(`/sessions/${zeroBodyId}/session-read?lines=4`);
      assert.equal(zero.statusCode, 200, zero.body);
      assert.equal(zero.value.lastTurn.assistantBodyLength, 0);
      assert.equal(zero.value.lastTurn.emptyAssistantBody, true);
      assert.match(zero.value.lastTurn.note, /正文长度为 0/);
      print('zero-body session_read mark', zero.value);
      return { assistantBodyLength: zero.value.lastTurn.assistantBodyLength };
    }],

    ['⑨ 树上的父子关系与 notify 可见', async () => {
      const finalTree = await api('/tree');
      const childNode = finalTree.value.sessions.find((session) => session.id === targetId);
      assert.equal(childNode.parentId, parentId);
      assert.ok(childNode.notify);
      print('tree relation/notify visibility', { parentId: childNode.parentId, notify: childNode.notify });
      return { parentId: childNode.parentId };
    }],
  ], { title: 's2-delegation' });
  print('RESULT', failed.length === 0 ? 'S2 delegation PASS' : `S2 delegation FAIL（${failed.length} 臂红）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(child, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (provider?.server) {
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
  if (log) await log.close();
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  const output = await readFile(logPath, 'utf8').catch(() => '');
  if (output.trim()) print('base log', output.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
