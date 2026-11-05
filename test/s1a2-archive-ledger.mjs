import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, listenerPid, processCommandLine, removeSandbox, stopOwnedListener } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-archive-ledger-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const archiveFile = path.join(home, 'archive.json');
const baseEntry = path.join(root, 'server', 'base.mjs');
const appEntry = path.join(root, 'server', 'app.mjs');
const baseLogPath = path.join(sandbox, 'base.log');
const appLogPath = path.join(sandbox, 'app.log');
const ids = {
  active: '11111111-1111-4111-8111-111111111111',
  archived: '22222222-2222-4222-8222-222222222222',
  archivedParent: '33333333-3333-4333-8333-333333333333',
  hiddenChild: '44444444-4444-4444-8444-444444444444',
  explicitFalse: '55555555-5555-4555-8555-555555555555',
  missingCwd: '66666666-6666-4666-8666-666666666666',
  newLedgerOnly: '77777777-7777-4777-8777-777777777777',
};
let basePort;
let appPort;
let baseChild;
let appChild;
let baseLog;
let appLog;
let chromium;
let browser;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reservePort(excluded = new Set()) {
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
  const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, { headers: { accept: 'application/json' } });
  const text = await response.text();
  return { statusCode: response.status, value: text ? JSON.parse(text) : null };
}

async function waitFor(operation, predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function sessionLines(id, name, { parentSession = null, archive = undefined, sessionCwd = cwd } = {}) {
  const timestamp = new Date().toISOString();
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd: sessionCwd, ...(parentSession ? { parentSession } : {}) },
    { type: 'message', id: `${id.slice(0, 8)}-message`, parentId: null, timestamp, message: { role: 'user', content: 'fixture', timestamp: Date.now() } },
    { type: 'session_info', id: `${id.slice(0, 8)}-title`, parentId: `${id.slice(0, 8)}-message`, timestamp, name },
  ];
  if (archive !== undefined) lines.push({ type: 'custom', id: `${id.slice(0, 8)}-archive`, parentId: `${id.slice(0, 8)}-title`, timestamp, customType: 'sopho.archive', data: { archived: archive } });
  return lines;
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          listeners.get(method).delete(listener);
          resolve(params);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.result?.description || 'browser evaluation failed');
  return result.result.value;
}

let primaryError;
try {
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const files = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, path.join(sessionsRoot, `${key}_${id}.jsonl`)]));
  await writeFile(files.active, `${sessionLines(ids.active, 'Active').map(JSON.stringify).join('\n')}\n`);
  await writeFile(files.archived, `${sessionLines(ids.archived, 'Legacy archived').map(JSON.stringify).join('\n')}\n`);
  await writeFile(files.archivedParent, `${sessionLines(ids.archivedParent, 'Legacy archived parent').map(JSON.stringify).join('\n')}\n`);
  await writeFile(files.hiddenChild, `${sessionLines(ids.hiddenChild, 'Active child under legacy archive', { parentSession: files.archivedParent }).map(JSON.stringify).join('\n')}\n`);
  await writeFile(files.explicitFalse, `${sessionLines(ids.explicitFalse, 'Explicitly restored', { archive: false }).map(JSON.stringify).join('\n')}\n`);
  // The 76 real-world shape: the session file is still on disk with a legacy archive key, but its
  // recorded cwd (a deleted worktree / /tmp probe directory) is gone. The pool refuses to open
  // such a session, so read-only fallback is the only thing that can still archive it.
  const goneWorktree = path.join(sandbox, 'gone-worktree', 'deleted');
  await writeFile(files.missingCwd, `${sessionLines(ids.missingCwd, 'Legacy archived, cwd gone', { sessionCwd: goneWorktree }).map(JSON.stringify).join('\n')}\n`);
  await writeFile(files.newLedgerOnly, `${sessionLines(ids.newLedgerOnly, 'New ledger only', { archive: true }).map(JSON.stringify).join('\n')}\n`);

  const settledBase = Date.now() - 60_000;
  await writeFile(path.join(home, 'settled.json'), `${JSON.stringify(Object.fromEntries(Object.values(ids).map((id, index) => [id, settledBase + index * 1000])), null, 2)}\n`);
  await writeFile(path.join(home, 'seen.json'), `${JSON.stringify({ [ids.active]: Date.now() }, null, 2)}\n`);
  const legacyLedger = { [ids.archived]: Date.now() - 3000, [ids.archivedParent]: Date.now() - 2000, [ids.explicitFalse]: Date.now() - 1000, [ids.missingCwd]: Date.now() - 500 };
  await writeFile(archiveFile, `${JSON.stringify(legacyLedger, null, 2)}\n`);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'sandbox-key', models: [{ id: 'fake', name: 'Fake', contextWindow: 4096, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake', defaultThinkingLevel: 'off' }, null, 2)}\n`);

  const used = new Set();
  basePort = await reservePort(used); used.add(basePort);
  appPort = await reservePort(used);
  baseLog = await open(baseLogPath, 'w');
  appLog = await open(appLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: root,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessionsRoot, PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort), SOPHO_DEFAULT_CWD: cwd, SOPHO_NO_TOOLS: '1' },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: root,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort), SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: path.join(root, 'web') },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  try {
    await waitFor(() => api('/host'), (result) => result.statusCode === 200, 'A+B did not become ready');
  } catch (error) {
    print('base log', await readFile(baseLogPath, 'utf8').catch(() => '(missing)'));
    print('app log', await readFile(appLogPath, 'utf8').catch(() => '(missing)'));
    throw error;
  }
  print('sandbox', { home, basePort, appPort, forbiddenPortsUsed: false });

  const initial = await api('/tree');
  assert.equal(initial.statusCode, 200);
  const initialById = new Map(initial.value.sessions.map((session) => [session.id, session]));
  assert.equal(initialById.get(ids.archived).archived, true);
  assert.equal(initialById.get(ids.archivedParent).archived, true);
  assert.equal(initialById.get(ids.explicitFalse).archived, false);
  assert.equal(initialById.get(ids.hiddenChild).hiddenByArchive, true);
  assert.equal(initialById.get(ids.archived).unread, false);
  // New ledger alone (no legacy key) must archive; the legacy key must still work when the
  // recorded cwd no longer exists, and neither may throw or count as unread.
  assert.equal(initialById.get(ids.newLedgerOnly).archived, true);
  assert.equal(initialById.get(ids.missingCwd).archived, true);
  assert.equal(initialById.get(ids.missingCwd).unread, false);
  assert.equal(initialById.get(ids.missingCwd).cwd, path.join(sandbox, 'gone-worktree', 'deleted'));
  assert.equal(initial.value.unread.count, 1);
  assert.equal(initial.value.unread.oldestId, ids.explicitFalse);
  print('legacy ledger fallback + explicit false override + cwd-gone archive + new-ledger-only', { archived: initial.value.sessions.filter((session) => session.archived).map((session) => session.id), unread: initial.value.unread });

  await writeFile(archiveFile, '{broken json\n');
  const broken = await api('/tree');
  assert.equal(broken.statusCode, 200);
  assert.deepEqual(broken.value.sessions.filter((session) => session.archived).map((session) => session.id), [ids.newLedgerOnly]);
  print('malformed legacy ledger is empty (new ledger still wins)', { statusCode: broken.statusCode, archived: [ids.newLedgerOnly] });

  await unlink(archiveFile);
  const missing = await api('/tree');
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.value.sessions.filter((session) => session.archived).map((session) => session.id), [ids.newLedgerOnly]);
  print('missing legacy ledger is empty (new ledger still wins)', { statusCode: missing.statusCode, archived: [ids.newLedgerOnly] });

  await writeFile(archiveFile, `${JSON.stringify(legacyLedger, null, 2)}\n`);
  const restored = await api('/tree');
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.value.sessions.filter((session) => session.archived).length, 4);
  print('mtime cache invalidated after restore', { archived: restored.value.sessions.filter((session) => session.archived).map((session) => session.id) });

  const detail = await api(`/sessions/${ids.archived}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.value.archived, true);
  const restoredDetail = await api(`/sessions/${ids.explicitFalse}`);
  assert.equal(restoredDetail.value.archived, false);
  // A cwd-gone session cannot be opened by the pool, so its detail is an honest 404/failure;
  // the tree above is what must keep working.
  const missingCwdDetail = await api(`/sessions/${ids.missingCwd}`);
  print('cwd-gone session detail (tree fallback already asserted)', { statusCode: missingCwdDetail.statusCode, value: missingCwdDetail.value });

  const debugPort = await reservePort(new Set([basePort, appPort]));
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, (value) => Boolean(value), 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${appPort}/`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await loaded;
  // 左栏现在是 v2.1 的「分支折叠 + 底部存档箱」（第五个 landing 取代了当初的全局归档抽屉），
  // 但这条契约要证的事实没变：旧账兑着的会话不进活跃树、归档静音、被恢复的会话回到活跃树。
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-attic-toggle="true"]'))`), (value) => value === true, 'attic toggle did not appear');
  const snapshot = (extra = '') => `(() => {
    const restored = document.querySelector('[data-session-id="${ids.explicitFalse}"]');
    return {
      activeIds: Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session')).map((node) => node.dataset.sessionId),
      hiddenChildVisible: !!document.querySelector('[data-session-id="${ids.hiddenChild}"]'),
      missingCwdVisible: !!document.querySelector('[data-active-tree-list="true"] > [data-session-id="${ids.missingCwd}"]'),
      restoredId: restored?.dataset.sessionId || null,
      restoredTitle: restored?.title || '',
      unreadRows: Array.from(document.querySelectorAll('.tree-session.unread')).map((node) => node.dataset.sessionId),
      ${extra}
    };
  })()`;
  // 默认（存档箱还没打开）：旧账兑着的归档根一个个都不在活跃树里，被归档父藏着的活跃子也不在。
  const dom = await waitFor(async () => evaluate(snapshot(`atticToggle: document.querySelector('[data-attic-toggle="true"]')?.textContent || ''`)),
    (value) => value.activeIds.length === 2, 'active tree did not reflect the legacy ledger');
  assert.deepEqual(dom.activeIds.sort(), [ids.active, ids.explicitFalse].sort());
  assert.equal(dom.atticToggle, '存档 ▸ 4');
  assert.equal(dom.hiddenChildVisible, false);
  assert.equal(dom.missingCwdVisible, false);
  assert.equal(dom.restoredId, ids.explicitFalse);
  assert.match(dom.restoredTitle, new RegExp(ids.explicitFalse));
  // 未读汇总条已删（用户裁定，docs/interaction-parity.md I-46）；这里改钉树行自己的未读记号，
  // 服务端未读语义仍由上面的 /tree 断言覆盖。
  assert.deepEqual(dom.unreadRows, [ids.explicitFalse]);
  print('frontend active tree (attic closed)', dom);

  // 打开底部存档箱：四个旧账兑着的顶层归档根都该在里面（这就是 v2.1 的「存档箱」）。
  // 被归档父带着的活跃子会跟着它那支一起出现在箱内（v2.1 `v2.1-final:web/app.mjs:245` 的口径：
  // 只有归档子会被折起来，活跃子归它自己那支），所以这里不想当然地只数 4 行。
  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  const attic = await waitFor(async () => evaluate(`(() => ({
    toggle: document.querySelector('[data-attic-toggle="true"]')?.textContent || '',
    listIds: Array.from(document.querySelectorAll('[data-attic-list="true"] > .tree-session')).map((node) => node.dataset.sessionId),
  }))()`), (value) => value.listIds.length >= 4, 'attic did not reflect the legacy ledger');
  assert.equal(attic.toggle, '存档 ▾ 4');
  for (const id of [ids.archived, ids.archivedParent, ids.missingCwd, ids.newLedgerOnly]) {
    assert.ok(attic.listIds.includes(id), `attic is missing legacy-archived ${id}: ${JSON.stringify(attic)}`);
  }
  print('frontend archive attic', attic);
  print('chromium', { product: version.Browser, chrome, debugPort });
  print('RESULT', 'S1a-2 v2.1 archive ledger compatibility PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (appPort) await stopOwnedListener(appPort, appEntry, appChild?.pid).catch(() => {});
  if (basePort) await stopOwnedListener(basePort, baseEntry, baseChild?.pid).catch(() => {});
  await baseLog?.close().catch(() => {});
  await appLog?.close().catch(() => {});
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
