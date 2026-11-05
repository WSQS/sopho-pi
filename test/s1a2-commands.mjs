import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-commands-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseEntry = path.join(root, 'server', 'base.mjs');
const baseLogPath = path.join(sandbox, 'base.log');
let provider;
let base;
let baseLog;
let providerPort;
let basePort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, body: text };
}

async function poll(label, operation, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function chunk(content, finishReason = null, usage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-commands',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(usage ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
  };
}

async function startProvider() {
  let hold = null;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = '';
    for await (const part of request) raw += part;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify(chunk('provider-reply'))}\n\n`);
    if (hold) {
      const pending = hold;
      hold = null;
      pending.started();
      await pending.released;
    }
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    holdNext() {
      let startedResolve;
      let releaseResolve;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      const released = new Promise((resolve) => { releaseResolve = resolve; });
      hold = { started: startedResolve, released };
      return { started, release: releaseResolve };
    },
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`pid ${child.pid} did not exit`)), 8000)),
  ]);
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  providerPort = await reservePort();
  basePort = await reservePort();
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          { id: 'fake-commands', name: 'Fake Commands', contextWindow: 4096, maxTokens: 1024 },
          { id: 'fake-other', name: 'Fake Other', contextWindow: 8192, maxTokens: 1024 },
        ],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-commands',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  provider = await startProvider();
  baseLog = await open(baseLogPath, 'w');
  base = spawn(process.execPath, [baseEntry], {
    cwd: root,
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
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => api('/host'), (response) => response.statusCode === 200, 20000);

  const created = await api('/sessions', { method: 'POST', body: { cwd } });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = created.value.id;
  const listed = await api(`/sessions/${sessionId}/commands`);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.value.sessionId, sessionId);
  assert.equal(typeof listed.value.streaming, 'boolean');
  assert.equal(listed.value.streaming, false);
  assert.equal(listed.value.compacting, false);
  assert.equal(listed.value.canRun, true);
  assert.ok(Array.isArray(listed.value.commands));
  assert.equal(listed.value.builtinError, null);
  assert.equal(typeof listed.value.builtinHow, 'string');
  const compact = listed.value.commands.find((command) => command.name === 'compact');
  const settings = listed.value.commands.find((command) => command.name === 'settings');
  const cwdCommand = listed.value.commands.find((command) => command.name === 'cwd');
  assert.deepEqual({ runnable: compact.runnable, via: compact.via, builtin: compact.builtin }, { runnable: true, via: 'compact', builtin: true });
  assert.equal(settings.runnable, false);
  assert.match(settings.reason, /TUI/);
  assert.equal(cwdCommand.source, 'extension');
  assert.equal(cwdCommand.runnable, true);
  print('commands shape', {
    streaming: listed.value.streaming,
    compact,
    settings: { runnable: settings.runnable, reason: settings.reason, tag: settings.tag },
    cwd: { source: cwdCommand.source, runnable: cwdCommand.runnable },
    builtinHow: listed.value.builtinHow,
  });

  const models = await api(`/sessions/${sessionId}/models`);
  assert.equal(models.statusCode, 200, models.body);
  assert.equal(models.value.models[0].current, true);
  assert.equal(models.value.models[0].ref, 'fake/fake-commands');
  const switched = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { model: 'fake/fake-other' } });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(switched.value.model, 'fake/fake-other');
  print('model candidates + switch', { currentFirst: models.value.models[0], switched: switched.value });

  const held = provider.holdNext();
  const start = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '开始长回复' } });
  assert.equal(start.statusCode, 202, start.body);
  await held.started;
  await poll('session streaming', () => api(`/sessions/${sessionId}`), (response) => response.value?.runtime?.isStreaming === true);

  const ordinary = await api(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: '流式中的普通中文文本' } });
  assert.equal(ordinary.statusCode, 202, ordinary.body);
  const slashText = await api(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: '/tmp/project is a path, not a command' } });
  assert.equal(slashText.statusCode, 202, slashText.body);

  const knownViaMessage = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '/cwd' } });
  assert.equal(knownViaMessage.statusCode, 409, knownViaMessage.body);
  assert.equal(knownViaMessage.value.error, 'command_while_streaming');
  assert.match(knownViaMessage.value.message, /不能插话也不能排队/);
  const knownViaSteer = await api(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: '/cwd' } });
  assert.equal(knownViaSteer.statusCode, 409, knownViaSteer.body);
  assert.equal(knownViaSteer.value.error, 'command_while_streaming');
  print('streaming guard', {
    ordinary: ordinary.value,
    slashText: slashText.value,
    knownViaMessage: knownViaMessage.value,
    knownViaSteer: knownViaSteer.value,
    v21Semantics: 'only names present in the real command list are commands; other slash-prefixed text stays ordinary text',
  });

  held.release();
  await poll('session settled', () => api(`/sessions/${sessionId}`), (response) => response.statusCode === 200 && response.value.runtime?.isStreaming === false, 15000);
  print('RESULT', 'S1a-2 commands API + streaming guard PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await stopChild(base).catch((error) => print('base cleanup error', error.message));
  if (provider?.server) await new Promise((resolve) => provider.server.close(resolve));
  await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog?.close());
  const log = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (log) print('base log tail', log.slice(-1200));
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
