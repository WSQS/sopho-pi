import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';

// S-line gate for the Android release: media sending + thinking write.
// Runs against a real A (host + generation worker) and a real B proxy, with a copied
// ASSIST_HOME, high ports and a local OpenAI-compatible stub. It never touches the live
// 7331/7321 instance, the real profiles, a real provider, or the production session tree.

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'android-media-thinking-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'base.log');
const appLogPath = path.join(sandbox, 'app.log');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');
let providerServer;
let baseChild;
let appChild;
let baseLog;
let appLog;
let providerPort;
let basePort;
let appPort;

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_2X2 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==';
const PNG_BYTES = Buffer.byteLength(PNG_1X1, 'base64');
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const GROUPS = new Set((process.env.SOPHO_ANDROIDMEDIA_GROUPS ?? 'media,thinking').split(',').map((value) => value.trim()).filter(Boolean));
const mediaGroup = GROUPS.has('media');
const thinkingGroup = GROUPS.has('thinking');

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

async function request(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: text, value };
}

const api = (pathname, options) => request(appPort, `/api${pathname}`, options);
const apiBase = (pathname, options) => request(basePort, pathname, options);

async function waitForHttp() {
  let lastError;
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 600 : 160); attempt += 1) {
    try {
      const response = await api('/host');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError ?? new Error('A+B did not become ready');
}

async function poll(label, operation, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function usage() {
  return { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'stub-model',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  };
}

function createPlan(mode, text) {
  let startedResolve;
  let releaseResolve;
  return {
    mode,
    text,
    started: new Promise((resolve) => { startedResolve = resolve; }),
    release: () => releaseResolve?.(),
    released: new Promise((resolve) => { releaseResolve = resolve; }),
    markStarted: startedResolve,
  };
}

function lastUserContent(body) {
  for (let index = body.messages?.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message.role !== 'user') continue;
    return message.content;
  }
  return null;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.type === 'text' ? part.text : '').join('');
}

function oversizedPngHeader() {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(5000, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

function runtimeModelRef(runtime) {
  return runtime?.model ? `${runtime.model.provider}/${runtime.model.id}` : null;
}

async function startFakeProvider() {
  const plans = [];
  const requests = [];
  const server = http.createServer(async (request_, response) => {
    if (request_.url !== '/v1/chat/completions' || request_.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request_) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const plan = plans.shift() ?? createPlan('normal', `reply:${textOfContent(lastUserContent(body)).slice(0, 40)}`);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted({ request: body, text: plan.text });
    if (plan.mode === 'hold') await plan.released;
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
    plans,
    plan(mode, text) {
      const value = createPlan(mode, text);
      plans.push(value);
      return value;
    },
  };
}

async function waitForIdle(sessionId) {
  return poll('session idle', () => api(`/sessions/${sessionId}`), (response) => response.statusCode === 200
    && response.value.runtime.isStreaming === false
    && response.value.runtime.isCompacting === false
    && response.value.runtime.isRetrying === false);
}

function userMessage(messages, needle) {
  return messages.messages.find((message) => message.role === 'user' && message.text.includes(needle));
}

let primaryError;
try {
  for (const directory of [home, cwd, sessionsRoot]) await mkdir(directory, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);
  appPort = await reserveHighPort(used); used.add(appPort);

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          { id: 'stub-vision', name: 'Stub Vision', reasoning: true, input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024 },
          { id: 'stub-text', name: 'Stub Text', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024 },
        ],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'stub-vision',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  // Suggestions are a separate, non-blocking model call. This gate counts conversation requests,
  // so switch that side call off in the sandbox (its default is on).
  await writeFile(path.join(home, 'ui-settings.json'), `${JSON.stringify({ version: 1, values: { 'suggestions.enabled': false } }, null, 2)}\n`);
  const settingsBefore = await readFile(path.join(home, 'settings.json'), 'utf8');

  providerServer = await startFakeProvider();
  baseLog = await open(baseLogPath, 'w');
  appLog = await open(appLogPath, 'w');
  const childEnv = {
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
    SOPHO_NO_TOOLS: '1',
    SOPHO_MAX_HOT: '8',
  };
  baseChild = spawn(process.execPath, [baseEntry], { cwd: sourceRoot, env: childEnv, stdio: ['ignore', baseLog.fd, baseLog.fd] });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await waitForHttp();
  if (process.platform !== 'win32') {
    assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
    assert.equal(Number(await listenerPid(appPort)), appChild.pid);
  }
  print('sandbox', { home, cwd, providerPort, basePort, appPort, forbiddenPortsUsed: false });

  const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'Media Thinking Gate' } });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = created.value.id;

  // 1) text-only regression: {text} keeps the old wire, the old 202 receipt and reaches the model.
  if (mediaGroup) {
    const before = providerServer.requests.length;
    const sent = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '纯文本回归' } });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.deepEqual(Object.keys(sent.value).sort(), ['accepted', 'sessionId']);
    assert.equal(sent.value.accepted, true);
    assert.equal(sent.value.sessionId, sessionId);
    await waitForIdle(sessionId);
    assert.equal(providerServer.requests.length, before + 1);
    const parts = lastUserContent(providerServer.requests.at(-1));
    assert.deepEqual(parts, [{ type: 'text', text: '纯文本回归' }]);
    const messages = await api(`/sessions/${sessionId}/messages`);
    const row = userMessage(messages.value, '纯文本回归');
    assert.ok(row);
    assert.deepEqual(row.images, []);
    assert.equal(row.text, '纯文本回归');
    print('text-only regression', { receipt: sent.value, providerUserContent: parts, wire: { text: row.text, images: row.images } });
  }

  // 2) text + image reaches the SDK as a real image block and is echoed on the wire.
  if (mediaGroup) {
    const before = providerServer.requests.length;
    const sent = await api(`/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { text: '看图', images: [{ mimeType: 'image/png', data: PNG_1X1 }] },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.value.images, 1);
    await poll('image turn reached provider', () => providerServer.requests, (requests) => requests.length === before + 1);
    const parts = lastUserContent(providerServer.requests.at(-1));
    assert.ok(Array.isArray(parts));
    assert.deepEqual(parts[0], { type: 'text', text: '看图' });
    assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } });
    await waitForIdle(sessionId);
    const messages = await api(`/sessions/${sessionId}/messages`);
    const row = userMessage(messages.value, '看图');
    assert.ok(row, JSON.stringify(messages.value.messages.map((message) => ({ role: message.role, text: message.text }))));
    assert.deepEqual(row.images, [{ mimeType: 'image/png', bytes: PNG_BYTES }]);
    const imageBlock = row.content.find((block) => block.type === 'image');
    assert.deepEqual(imageBlock, { type: 'image', mimeType: 'image/png', data: PNG_1X1 });
    assert.match(row.text, /^看图\n\[图片：image\/png，70 字节/);
    print('text+image', { providerUserContent: parts, receipt: sent.value, wire: { text: row.text, images: row.images, contentTypes: row.content.map((block) => block.type) } });
  }

  // 3) pure image (no text at all) is legal; text stays a metadata marker, not lost content.
  if (mediaGroup) {
    const before = providerServer.requests.length;
    const sent = await api(`/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { images: [{ mimeType: 'image/png', data: PNG_1X1 }] },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.value.images, 1);
    await poll('pure-image turn reached provider', () => providerServer.requests, (requests) => requests.length === before + 1);
    const parts = lastUserContent(providerServer.requests.at(-1));
    assert.deepEqual(parts[0], { type: 'text', text: '' });
    assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } });
    await waitForIdle(sessionId);
    const messages = await api(`/sessions/${sessionId}/messages`);
    const rows = messages.value.messages.filter((message) => message.role === 'user' && message.text.includes('[图片：image/png，70 字节'));
    const row = rows.at(-1);
    assert.ok(row);
    assert.deepEqual(row.images, [{ mimeType: 'image/png', bytes: PNG_BYTES }]);
    assert.equal(row.content.filter((block) => block.type === 'image').length, 1);
    assert.deepEqual(row.content.find((block) => block.type === 'text'), { type: 'text', text: '' });
    print('pure image', { providerUserContent: parts, receipt: sent.value, wire: { text: row.text, images: row.images } });
  }

  // 3b) the Android output format (JPEG) must pass the same strict container check.
  if (mediaGroup) {
    const before = providerServer.requests.length;
    const jpegBytes = Buffer.byteLength(JPEG_2X2, 'base64');
    const sent = await api(`/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { text: 'jpeg 图', images: [{ mimeType: 'image/jpeg', data: JPEG_2X2 }] },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.value.images, 1);
    await poll('jpeg turn reached provider', () => providerServer.requests, (requests) => requests.length === before + 1);
    const parts = lastUserContent(providerServer.requests.at(-1));
    assert.ok(parts.some((part) => part.type === 'image_url' && part.image_url.url === `data:image/jpeg;base64,${JPEG_2X2}`));
    await waitForIdle(sessionId);
    const messages = await api(`/sessions/${sessionId}/messages`);
    const row = userMessage(messages.value, 'jpeg 图');
    assert.deepEqual(row.images, [{ mimeType: 'image/jpeg', bytes: jpegBytes }]);
    print('jpeg image', { bytes: jpegBytes, receipt: sent.value, wireImages: row.images });
  }

  // 4) steer carries an image through the real SDK while a turn is streaming.
  if (mediaGroup) {
    const before = providerServer.requests.length;
    const hold = providerServer.plan('hold', 'long-running');
    const started = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '长回合' } });
    assert.equal(started.statusCode, 202, started.body);
    await hold.started;
    const steered = await api(`/sessions/${sessionId}/steer`, {
      method: 'POST',
      body: { text: '插话图', images: [{ mimeType: 'image/png', data: PNG_1X1 }] },
    });
    assert.equal(steered.statusCode, 202, steered.body);
    assert.equal(steered.value.mode, 'steer');
    assert.equal(steered.value.images, 1);
    hold.release();
    await poll('steer turn reached provider', () => providerServer.requests, (requests) => requests.length >= before + 2, 15_000);
    const steeredRequest = providerServer.requests.at(-1);
    const parts = lastUserContent(steeredRequest);
    assert.equal(textOfContent(parts), '插话图');
    assert.ok(parts.some((part) => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${PNG_1X1}`), JSON.stringify(parts));
    await waitForIdle(sessionId);
    print('steer with image', { receipt: steered.value, providerUserContent: parts });
  }

  // 5) every malformed/oversized request is refused before enqueue; no provider call, nothing persisted.
  if (mediaGroup) {
    const beforeRequests = providerServer.requests.length;
    const beforeMessages = (await api(`/sessions/${sessionId}/messages`)).value.messages.length;
    const cases = [
      [{}, 400, 'invalid_text'],
      [{ text: '   ' }, 400, 'invalid_text'],
      [{ text: '坏图', images: 'not-an-array' }, 400, 'invalid_images'],
      [{ text: '坏图', images: [{ mimeType: 'image/png', data: 'not-base64!' }] }, 400, 'invalid_image_data'],
      [{ text: '坏图', images: [{ mimeType: 'image/jpeg', data: PNG_1X1 }] }, 400, 'invalid_image_data'],
      [{ text: '坏图', images: [{ mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') }] }, 400, 'invalid_image_data'],
      [{ text: '坏图', images: [{ mimeType: 'image/gif', data: PNG_1X1 }] }, 415, 'unsupported_image_type'],
      [{ text: '坏图', images: Array.from({ length: MAX_IMAGES + 1 }, () => ({ mimeType: 'image/png', data: PNG_1X1 })) }, 413, 'too_many_images'],
      [{ text: '坏图', images: [{ mimeType: 'image/png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }] }, 413, 'image_too_large'],
      [{ text: '坏图', images: [{ mimeType: 'image/png', data: oversizedPngHeader().toString('base64') }] }, 413, 'image_too_large'],
      [{ text: 'x'.repeat(MAX_TEXT_BYTES + 1) }, 413, 'body_too_large'],
    ];
    for (const [body, status, code] of cases) {
      const response = await api(`/sessions/${sessionId}/message`, { method: 'POST', body });
      assert.equal(response.statusCode, status, `${code}: ${response.body}`);
      assert.equal(response.value.error, code, response.body);
    }
    const badSteer = await api(`/sessions/${sessionId}/steer`, {
      method: 'POST',
      body: { text: '坏图 steer', images: [{ mimeType: 'image/gif', data: PNG_1X1 }] },
    });
    assert.equal(badSteer.statusCode, 415, badSteer.body);
    assert.equal(badSteer.value.error, 'unsupported_image_type');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(providerServer.requests.length, beforeRequests);
    const afterMessages = (await api(`/sessions/${sessionId}/messages`)).value.messages.length;
    assert.equal(afterMessages, beforeMessages);
    print('pre-enqueue media refusals', { cases: cases.map(([body, status, code]) => ({ text: body.text?.slice(0, 16) ?? null, status, code })), steer: badSteer.value, providerCalls: providerServer.requests.length - beforeRequests });
  }

  // 6) model catalog exposes capabilities; thinking write is session-only and honestly read back.
  if (thinkingGroup) {
    const models = await api(`/sessions/${sessionId}/models`);
    assert.equal(models.statusCode, 200, models.body);
    const vision = models.value.models.find((model) => model.id === 'stub-vision');
    const textOnly = models.value.models.find((model) => model.id === 'stub-text');
    assert.deepEqual(vision.input, ['text', 'image']);
    assert.equal(vision.supportsImages, true);
    assert.ok(vision.thinkingLevels.includes('high'));
    assert.deepEqual(textOnly.input, ['text']);
    assert.equal(textOnly.supportsImages, false);
    assert.deepEqual(textOnly.thinkingLevels, ['off']);
    assert.deepEqual(models.value.thinking, { current: 'off', levels: ['off', 'minimal', 'low', 'medium', 'high'] });

    const switchedThinking = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { thinkingLevel: 'high' } });
    assert.equal(switchedThinking.statusCode, 200, switchedThinking.body);
    assert.equal(switchedThinking.value.model, 'fake/stub-vision');
    assert.equal(switchedThinking.value.previousThinkingLevel, 'off');
    assert.equal(switchedThinking.value.thinkingLevel, 'high');
    assert.equal(switchedThinking.value.persist, false);
    assert.ok(switchedThinking.value.thinkingLevels.includes('high'));
    const afterThinking = await waitForIdle(sessionId);
    assert.equal(afterThinking.value.runtime.thinkingLevel, 'high');

    const invalidLevel = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { thinkingLevel: 'bogus' } });
    assert.equal(invalidLevel.statusCode, 400, invalidLevel.body);
    assert.equal(invalidLevel.value.error, 'invalid_thinking_level');
    const stillHigh = await api(`/sessions/${sessionId}`);
    assert.equal(stillHigh.value.runtime.thinkingLevel, 'high');

    const hold = providerServer.plan('hold', 'busy-thinking');
    const running = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'busy thinking' } });
    assert.equal(running.statusCode, 202, running.body);
    await hold.started;
    const busyWrite = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { thinkingLevel: 'low' } });
    assert.equal(busyWrite.statusCode, 409, busyWrite.body);
    assert.equal(busyWrite.value.error, 'session_streaming');
    hold.release();
    const afterBusy = await waitForIdle(sessionId);
    assert.equal(afterBusy.value.runtime.thinkingLevel, 'high');

    const combinedUnsupported = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { model: 'fake/stub-text', thinkingLevel: 'medium' } });
    assert.equal(combinedUnsupported.statusCode, 409, combinedUnsupported.body);
    assert.equal(combinedUnsupported.value.error, 'thinking_level_unsupported');
    const afterCombinedRefusal = await api(`/sessions/${sessionId}`);
    assert.equal(runtimeModelRef(afterCombinedRefusal.value.runtime), 'fake/stub-vision');
    assert.equal(afterCombinedRefusal.value.runtime.thinkingLevel, 'high');

    const toTextOnly = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { model: 'fake/stub-text' } });
    assert.equal(toTextOnly.statusCode, 200, toTextOnly.body);
    assert.equal(toTextOnly.value.model, 'fake/stub-text');
    assert.equal(toTextOnly.value.thinkingLevel, 'off');
    assert.equal(toTextOnly.value.previousThinkingLevel, 'high');
    assert.deepEqual(toTextOnly.value.thinkingLevels, ['off']);

    const beforeUnsupportedImage = providerServer.requests.length;
    const unsupportedImage = await api(`/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { text: '文本模型不能看图', images: [{ mimeType: 'image/png', data: PNG_1X1 }] },
    });
    assert.equal(unsupportedImage.statusCode, 409, unsupportedImage.body);
    assert.equal(unsupportedImage.value.error, 'model_does_not_support_images');
    assert.equal(providerServer.requests.length, beforeUnsupportedImage);

    const holdText = providerServer.plan('hold', 'text-only turn');
    const textTurn = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '文本模型回合' } });
    assert.equal(textTurn.statusCode, 202, textTurn.body);
    await holdText.started;
    const unsupportedSteerImage = await api(`/sessions/${sessionId}/steer`, {
      method: 'POST',
      body: { text: '文本模型 steer 图', images: [{ mimeType: 'image/png', data: PNG_1X1 }] },
    });
    assert.equal(unsupportedSteerImage.statusCode, 409, unsupportedSteerImage.body);
    assert.equal(unsupportedSteerImage.value.error, 'model_does_not_support_images');
    holdText.release();
    await waitForIdle(sessionId);

    const unsupportedLevel = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { thinkingLevel: 'high' } });
    assert.equal(unsupportedLevel.statusCode, 409, unsupportedLevel.body);
    assert.equal(unsupportedLevel.value.error, 'thinking_level_unsupported');
    const finalDetail = await api(`/sessions/${sessionId}`);
    assert.equal(finalDetail.value.runtime.thinkingLevel, 'off');

    const combinedOk = await api(`/sessions/${sessionId}/model`, { method: 'POST', body: { model: 'fake/stub-vision', thinkingLevel: 'high' } });
    assert.equal(combinedOk.statusCode, 200, combinedOk.body);
    assert.equal(combinedOk.value.model, 'fake/stub-vision');
    assert.equal(combinedOk.value.previous, 'fake/stub-text');
    assert.equal(combinedOk.value.previousThinkingLevel, 'off');
    assert.equal(combinedOk.value.thinkingLevel, 'high');
    assert.equal(combinedOk.value.partial, undefined);
    const afterCombined = await api(`/sessions/${sessionId}`);
    assert.equal(runtimeModelRef(afterCombined.value.runtime), 'fake/stub-vision');
    assert.equal(afterCombined.value.runtime.thinkingLevel, 'high');
    assert.equal(await readFile(path.join(home, 'settings.json'), 'utf8'), settingsBefore);
    print('model catalog + thinking write', {
      vision: { input: vision.input, supportsImages: vision.supportsImages, thinkingLevels: vision.thinkingLevels },
      textOnly: { input: textOnly.input, supportsImages: textOnly.supportsImages, thinkingLevels: textOnly.thinkingLevels },
      write: switchedThinking.value,
      combinedUnsupported: combinedUnsupported.value,
      refusalKeptModel: { model: runtimeModelRef(afterCombinedRefusal.value.runtime), thinkingLevel: afterCombinedRefusal.value.runtime.thinkingLevel },
      busyWrite: busyWrite.value,
      modelSwitch: toTextOnly.value,
      unsupportedImage: unsupportedImage.value,
      unsupportedSteerImage: unsupportedSteerImage.value,
      unsupportedLevel: unsupportedLevel.value,
      combined: combinedOk.value,
      finalThinkingLevel: afterCombined.value.runtime.thinkingLevel,
      globalSettingsUnchanged: true,
    });
  }

  // 7) Last: the whole-body cap. Sending a body past the readJson ceiling makes the client abort
  // the request stream, which can surface as one transient host 503 on the NEXT request; so this is
  // deliberately the final API call in the gate.
  if (mediaGroup) {
    const oversizedBody = await apiBase(`/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { text: 'body-limit', images: [{ mimeType: 'image/png', data: 'A'.repeat(MAX_REQUEST_BYTES + 1024) }] },
    });
    assert.equal(oversizedBody.statusCode, 413, oversizedBody.body);
    assert.equal(oversizedBody.value.error, 'body_too_large', oversizedBody.body);
    print('media body ceiling', oversizedBody.value);
  }

  print('RESULT', `android media + thinking contract PASS (${[...GROUPS].join(',')})`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (appPort) {
    try { await stopOwnedListener(appPort, appEntry, appChild?.pid); } catch (error) { process.stderr.write(`app cleanup failed: ${error.message}\n`); }
  }
  if (basePort) {
    try { await stopOwnedListener(basePort, baseEntry, baseChild?.pid); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await baseLog.close();
  if (appLog) await appLog.close();
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  if (appChild && appChild.exitCode === null) await new Promise((resolve) => appChild.once('exit', resolve));
  if (baseLogPath) {
    const output = await readFile(baseLogPath, 'utf8').catch(() => '');
    if (output.trim()) print('base log', output.trim());
  }
  if (appLogPath) {
    const output = await readFile(appLogPath, 'utf8').catch(() => '');
    if (output.trim()) print('app log', output.trim());
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
