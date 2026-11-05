// Title ledger (T-07 / A-05) end-to-end sandbox.
//
// It pins the v2.1 rule set on the v2.2 owner-worker architecture:
//   · `seed`  (L0 deterministic): an explicit create name, or the first line of the first user message;
//   · `auto`  (L1 model): `POST /sessions/{id}/title`, reached by the plugin `session_set_title` tool;
//   · `manual`(human): `PATCH /sessions/{id} {name}`, and it is never overwritten by `auto`;
//   · the real title still lives in the session file (pi session_info), written only by the owner worker;
//     `$ASSIST_HOME/titles.json` is only the "who gave it" ledger;
//   · the tree/detail report `titleSource` honestly, and a corrupt ledger is loud on the write/report
//     paths while `/tree` degrades honestly (`titles.ok:false`, titleSource null) instead of dying.
//
// Harness: copied home + high random ports + a local fake OpenAI-compatible provider. No real profile,
// no 7331/7321, no network model. `session_set_title` is exercised through a real plugin load and a real tool call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'title-'));
const home = path.join(sandbox, 'home');
const sessionsRoot = path.join(home, 'sessions');
const cwd = path.join(sandbox, 'workspace');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const logPath = path.join(sandbox, 'base.log');
const titlesFile = path.join(home, 'titles.json');
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
  for (let candidate = 45000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
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

async function poll(label, operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(40);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function waitForHttp() {
  return poll('base ready', () => api('/host').catch(() => null), (value) => value?.statusCode === 200);
}

async function waitIdle(sessionId) {
  return poll(`session ${sessionId} idle`, () => api(`/sessions/${sessionId}`), (reply) => reply.statusCode === 200
    && !reply.value.runtime?.isStreaming
    && !reply.value.runtime?.isCompacting
    && !reply.value.runtime?.isRetrying);
}

async function treeNode(sessionId) {
  const tree = await api('/tree');
  assert.equal(tree.statusCode, 200, tree.body);
  return tree.value.sessions.find((session) => session.id === sessionId);
}

async function createSession(name) {
  const response = await api('/sessions', { method: 'POST', body: name === undefined ? { cwd } : { cwd, name } });
  assert.equal(response.statusCode, 201, response.body);
  return response.value.id;
}

async function messages(sessionId) {
  const response = await api(`/sessions/${sessionId}/messages`);
  assert.equal(response.statusCode, 200, response.body);
  return response.value;
}

async function titles() {
  const response = await api('/titles');
  assert.equal(response.statusCode, 200, response.body);
  return response.value;
}

function usage() {
  return { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
}

function sse(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-title',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  })}\n\n`);
}

function latestUserText(messagesList = []) {
  for (let index = messagesList.length - 1; index >= 0; index -= 1) {
    if (messagesList[index]?.role !== 'user') continue;
    const content = messagesList[index].content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  }
  return '';
}

async function startProvider() {
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    const lastRole = body.messages?.at(-1)?.role ?? null;
    const prompt = latestUserText(body.messages).trim();
    requests.push({ prompt, lastRole, tools: (body.tools ?? []).map((tool) => tool.function?.name) });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    if (lastRole !== 'tool' && prompt === 'CALL_SET_TITLE') {
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-set-title', type: 'function', function: { name: 'session_set_title', arguments: JSON.stringify({ title: '模型起的标题' }) } }] });
      sse(response, {}, 'tool_calls', true);
    } else {
      sse(response, { role: 'assistant', content: `DONE:${prompt.slice(0, 60)}` });
      sse(response, {}, 'stop', true);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

function openSse(pathname) {
  const events = [];
  const waiters = new Set();
  let incomingResponse;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({ host: '127.0.0.1', port: basePort, path: pathname, headers: { accept: 'text/event-stream' } });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      incomingResponse = incoming;
      assert.equal(incoming.statusCode, 200);
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ event: currentEvent, data });
              for (const waiter of [...waiters]) waiter();
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.on('error', () => {});
      resolve();
    });
    request.end();
  });
  async function waitFor(predicate, timeoutMs = 10_000) {
    const found = events.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`SSE wait timed out: ${JSON.stringify(events)}`)); }, timeoutMs);
      const check = () => {
        const value = events.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      waiters.add(check);
    });
  }
  return { connected, events, waitFor, close() { incomingResponse?.destroy(); request.destroy(); } };
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-title', name: 'Title Fake', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-title',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  // ── migration pin: v2.2 must read the EXISTING v2.1 `$ASSIST_HOME/titles.json` as-is ──
  // v2.1 wrote it with `JSON.stringify(m, null, 1)` and records `{ title, source, at }` with
  // sources seed/auto/manual; v2.2 reads the same path with the same shape. Seed a ledger that
  // looks exactly like v2.1's output (indent 1, UUIDv7-style keys) plus cold session files, so a
  // future storage swap that forgot to read the old ledger would fail here (the archive.json leak).
  async function seedColdSession(name, entryPrefix) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const entries = [
      { type: 'session', version: 3, id, timestamp: now, cwd },
      { type: 'message', id: `${entryPrefix}0001`, parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'cold seed' }], timestamp: Date.now() } },
    ];
    if (name !== null) entries.push({ type: 'session_info', id: `${entryPrefix}0002`, parentId: `${entryPrefix}0001`, timestamp: now, name });
    await writeFile(path.join(sessionsRoot, `seed_${id}.jsonl`), `${entries.map(JSON.stringify).join('\n')}\n`);
    return id;
  }
  const legacySeedId = await seedColdSession('老账种子', '3100');
  const legacyAutoId = await seedColdSession('老账自动', '3200');
  const legacyManualId = await seedColdSession('老账手动', '3300');
  // This one's file name disagrees with the ledger: a hand edit / TUI rename after an auto title.
  const driftId = await seedColdSession('文件里的名字', '3400');
  await writeFile(titlesFile, `${JSON.stringify({
    [legacySeedId]: { title: '老账种子', source: 'seed', at: 1 },
    [legacyAutoId]: { title: '老账自动', source: 'auto', at: 2 },
    [legacyManualId]: { title: '老账手动', source: 'manual', at: 3 },
    [driftId]: { title: '账上旧标题', source: 'auto', at: 4 },
  }, null, 1)}\n`);

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
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_MAX_HOT: '16',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await waitForHttp();
  assert.equal(Number(await listenerPid(basePort)), child.pid);
  print('sandbox', { home, cwd, providerPort, basePort, forbiddenPortsUsed: false });

  // ── 0. plugin preflight: the tool really registers ──────────────────────────────
  const loaded = await discoverAndLoadExtensions([path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts')], cwd, home);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('session_set_title'), 'session_set_title tool missing');
  const setTitleDef = extension.tools.get('session_set_title').definition;
  assert.match(setTitleDef.description, /never overwritten/i);
  assert.match(setTitleDef.description, /≤20/);
  assert.equal(setTitleDef.parameters.properties.title.type, 'string');
  assert.deepEqual(setTitleDef.parameters.required, ['title']);
  print('plugin preflight', { tools: [...extension.tools.keys()], description: setTitleDef.description });

  // ── 1. seed: an explicit create name is recorded as seed ───────────────────────
  const id1 = await createSession('Seed 标题');
  const seeded = await treeNode(id1);
  assert.equal(seeded.name, 'Seed 标题');
  assert.equal(seeded.titleSource, 'seed');
  const id1Detail = await api(`/sessions/${id1}`);
  assert.equal(id1Detail.value.titleSource, 'seed');

  // ── 1b. the old v2.1 ledger is read directly (seed/auto/manual + drift⇒manual) ──────
  // /tree is read-only: it reports the ledger as-is per session, no reconcile.
  assert.equal((await treeNode(legacySeedId)).titleSource, 'seed');
  assert.equal((await treeNode(legacySeedId)).name, '老账种子');
  assert.equal((await treeNode(legacyAutoId)).titleSource, 'auto');
  assert.equal((await treeNode(legacyManualId)).titleSource, 'manual');
  assert.equal((await treeNode(driftId)).titleSource, 'auto'); // stale until reconciled

  // An old seed/auto record is honored AND still overridable by the model.
  const legacySeedOverride = await api(`/sessions/${legacySeedId}/title`, { method: 'POST', body: { title: '模型覆盖种子' } });
  assert.equal(legacySeedOverride.statusCode, 200, legacySeedOverride.body);
  assert.equal(legacySeedOverride.value.source, 'auto');
  assert.equal(legacySeedOverride.value.applied, true);
  const legacyAutoOverride = await api(`/sessions/${legacyAutoId}/title`, { method: 'POST', body: { title: '模型再改自动' } });
  assert.equal(legacyAutoOverride.statusCode, 200, legacyAutoOverride.body);

  // An old manual record locks the model out.
  const legacyManualRefused = await api(`/sessions/${legacyManualId}/title`, { method: 'POST', body: { title: '不许覆盖' } });
  assert.equal(legacyManualRefused.statusCode, 409, legacyManualRefused.body);
  assert.equal(legacyManualRefused.value.reason, 'manual');
  assert.equal(legacyManualRefused.value.name, '老账手动');

  // The drifted session: /tree shows the stale ledger until GET /titles reconciles it to manual.
  const driftItem = (await titles()).items.find((item) => item.id === driftId);
  assert.equal(driftItem.source, 'manual');
  assert.equal(driftItem.name, '文件里的名字');
  assert.equal((await treeNode(driftId)).titleSource, 'manual');
  const driftRefused = await api(`/sessions/${driftId}/title`, { method: 'POST', body: { title: '模型想改' } });
  assert.equal(driftRefused.statusCode, 409, driftRefused.body);
  assert.equal(driftRefused.value.reason, 'manual');
  assert.equal((await treeNode(driftId)).name, '文件里的名字');
  print('legacy v2.1 titles.json read directly', {
    seed: { read: 'seed', override: { statusCode: legacySeedOverride.statusCode, source: legacySeedOverride.value.source } },
    auto: { read: 'auto', override: { statusCode: legacyAutoOverride.statusCode } },
    manual: { read: 'manual', refusal: { statusCode: legacyManualRefused.statusCode, reason: legacyManualRefused.value.reason } },
    drift: { item: driftItem, refusal: { statusCode: driftRefused.statusCode, reason: driftRefused.value.reason } },
  });

  // ── 2. auto: POST /title overrides seed ────────────────────────────────────────
  const auto = await api(`/sessions/${id1}/title`, { method: 'POST', body: { title: '  auto 改的标题  ' } });
  assert.equal(auto.statusCode, 200, auto.body);
  assert.equal(auto.value.ok, true);
  assert.equal(auto.value.applied, true);
  assert.equal(auto.value.name, 'auto 改的标题');
  assert.equal(auto.value.source, 'auto');
  assert.equal((await treeNode(id1)).titleSource, 'auto');

  // ── 3. manual: PATCH {name} is the human path ──────────────────────────────────
  const patched = await api(`/sessions/${id1}`, { method: 'PATCH', body: { name: '人手写的标题' } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.value.name, '人手写的标题');
  const manualItem = (await titles()).items.find((item) => item.id === id1);
  assert.equal(manualItem.source, 'manual');
  assert.equal(manualItem.manual, true);
  assert.equal(manualItem.name, '人手写的标题');

  // ── 4. auto can never overwrite a manual title ─────────────────────────────────
  const refused = await api(`/sessions/${id1}/title`, { method: 'POST', body: { title: '模型再改一次' } });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.value.ok, false);
  assert.equal(refused.value.applied, false);
  assert.equal(refused.value.reason, 'manual');
  assert.equal(refused.value.name, '人手写的标题');
  const stillManual = await treeNode(id1);
  assert.equal(stillManual.name, '人手写的标题');
  assert.equal(stillManual.titleSource, 'manual');

  // ── 5. empty / command-only titles are refused honestly ────────────────────────
  const id2 = await createSession();
  const empty = await api(`/sessions/${id2}/title`, { method: 'POST', body: { title: '   ' } });
  assert.equal(empty.statusCode, 409, empty.body);
  assert.equal(empty.value.reason, 'empty-title');
  const command = await api(`/sessions/${id2}/title`, { method: 'POST', body: { title: '/compact' } });
  assert.equal(command.statusCode, 409, command.body);
  assert.equal(command.value.reason, 'empty-title');
  assert.equal((await treeNode(id2)).name, null);
  assert.equal((await treeNode(id2)).titleSource, null);

  // ── 6. seed from the first user message (L0) ───────────────────────────────────
  const id3 = await createSession();
  const sent = await api(`/sessions/${id3}/message`, { method: 'POST', body: { text: '第一行就是标题\n第二行不进标题' } });
  assert.equal(sent.statusCode, 202, sent.body);
  const seededNode = await poll('first message seeds a title', () => treeNode(id3), (node) => node?.name === '第一行就是标题');
  assert.equal(seededNode.titleSource, 'seed');
  await waitIdle(id3);

  // ── 7. the plugin tool really drives it end-to-end ────────────────────────────
  const id4 = await createSession();
  const toolTurn = await api(`/sessions/${id4}/message`, { method: 'POST', body: { text: 'CALL_SET_TITLE' } });
  assert.equal(toolTurn.statusCode, 202, toolTurn.body);
  await waitIdle(id4);
  const toolNode = await poll('session_set_title tool applied', () => treeNode(id4), (node) => node?.name === '模型起的标题');
  assert.equal(toolNode.titleSource, 'auto');
  const wire = await messages(id4);
  const toolPart = wire.messages.flatMap((message) => message.parts || []).find((part) => part.type === 'tool' && part.name === 'session_set_title');
  assert.ok(toolPart, 'no session_set_title tool part in the session messages');
  assert.equal(toolPart.status, 'done-success');
  assert.match(toolPart.result, /"ok": true/);
  assert.match(toolPart.result, /"source": "auto"/);
  print('plugin session_set_title tool call', { name: toolNode.name, titleSource: toolNode.titleSource, toolResult: toolPart.result });

  // ── 7b. delegation paths record their explicit name (or first-line seed) as seed ──
  const parent = await createSession('Spawn Parent');
  const spawned = await api(`/sessions/${parent}/spawn`, { method: 'POST', body: { task: '子会话任务第一行\n第二行不进标题', share: true, notify: false } });
  assert.equal(spawned.statusCode, 201, spawned.body);
  const spawnChild = spawned.value.childSessionId;
  const spawnNode = await poll('spawn child seeded from its first line', () => treeNode(spawnChild), (node) => node?.name === '子会话任务第一行');
  assert.equal(spawnNode.titleSource, 'seed');
  await waitIdle(spawnChild);
  const namedChild = await api(`/sessions/${parent}/session-new`, { method: 'POST', body: { cwd, name: '显式名字', firstMessage: '这条第一行不算标题', share: true } });
  assert.equal(namedChild.statusCode, 201, namedChild.body);
  const namedId = namedChild.value.childSessionId;
  const namedNode = await poll('session-new child uses its explicit name', () => treeNode(namedId), (node) => node?.name === '显式名字');
  assert.equal(namedNode.titleSource, 'seed');
  await waitIdle(namedId);
  print('delegation seed paths', { spawn: { id: spawnChild, name: spawnNode.name, source: spawnNode.titleSource }, sessionNew: { id: namedId, name: namedNode.name, source: namedNode.titleSource } });

  // ── 8. title events are honest on both SSE channels ───────────────────────────
  const id5 = await createSession('SSE Seed');
  const sessionStream = openSse(`/sessions/${id5}/events`);
  const treeStream = openSse('/tree/events');
  await Promise.all([sessionStream.connected, treeStream.connected]);
  await sessionStream.waitFor((event) => event.event === 'session.snapshot');
  await treeStream.waitFor((event) => event.event === 'tree.snapshot');
  const sseChange = await api(`/sessions/${id5}/title`, { method: 'POST', body: { title: 'SSE Auto' } });
  assert.equal(sseChange.statusCode, 200, sseChange.body);
  const titleEvent = await sessionStream.waitFor((event) => event.event === 'session.title' && event.data.name === 'SSE Auto');
  assert.equal(titleEvent.data.source, 'auto');
  await treeStream.waitFor((event) => event.event === 'tree.session' && event.data.sessionId === id5 && event.data.reason === 'title_changed');
  print('title SSE honesty', { sessionTitleEvent: titleEvent.data, treeReason: 'title_changed' });
  sessionStream.close();
  treeStream.close();

  // ── 9. the ledger on disk is the reconciliation source of truth ───────────────
  const ledger = JSON.parse(await readFile(titlesFile, 'utf8'));
  assert.equal(ledger[id1].source, 'manual');
  assert.equal(ledger[id1].title, '人手写的标题');
  assert.equal(ledger[id3].source, 'seed');
  assert.equal(ledger[id4].source, 'auto');
  const report = await titles();
  assert.equal(report.file, titlesFile);
  print('titles.json ledger', { keys: Object.keys(ledger).length, id1: ledger[id1], reportCount: report.count });

  // ── 10. a corrupt ledger is loud where it matters, honest on /tree ────────────
  await writeFile(titlesFile, '{broken json\n');
  const loudReport = await api('/titles');
  assert.equal(loudReport.statusCode, 500, loudReport.body);
  assert.equal(loudReport.value.error, 'titles_invalid');
  const loudWrite = await api(`/sessions/${id3}/title`, { method: 'POST', body: { title: '不许拿空账覆盖' } });
  assert.equal(loudWrite.statusCode, 500, loudWrite.body);
  assert.equal(loudWrite.value.error, 'titles_invalid');
  const degradedTree = await api('/tree');
  assert.equal(degradedTree.statusCode, 200, degradedTree.body);
  assert.equal(degradedTree.value.titles.ok, false);
  assert.match(degradedTree.value.titles.error, /titles\.json/);
  assert.equal(degradedTree.value.sessions.find((session) => session.id === id1).titleSource, null);
  // and the real title in the session file is untouched by the failed write.
  assert.equal((await api(`/sessions/${id3}`)).value.name, '第一行就是标题');
  print('corrupt ledger loud/degraded', {
    report: { statusCode: loudReport.statusCode, error: loudReport.value.error },
    write: { statusCode: loudWrite.statusCode, error: loudWrite.value.error },
    tree: degradedTree.value.titles,
  });

  print('RESULT', 'title ledger/seed/auto/manual PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (basePort && child?.pid) {
    try { await stopOwnedListener(basePort, baseEntry, child.pid); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (provider?.server) {
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
  if (log) await cleanupStep(cleanupProblems, 'close log', () => log.close());
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  const output = await readFile(logPath, 'utf8').catch(() => '');
  if (output.trim()) print('base log', output.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
