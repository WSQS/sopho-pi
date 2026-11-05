#!/usr/bin/env node
// 投递回执的门（`npm run test:delivery`，2026-09-26 由 `test/spawn-delivery.mjs` 改名而来）：
// 2026-09-26 业主把 `spawn` 并入 `session_new` ⇒ 工具名换了，但「投递失败不许静默」这条契约不变：
// 非 2xx（这里是 409）必须回 `delivered:false` + `sessionId` + `statusCode` + `reason`，且子会话文件里
// `user` 消息数 = 0；201 必须回 `delivered:true` 且子会话文件里 `user` = 1（落盘对照）。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { finishCleanup, removeSandbox } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'session-new-delivery-'));
const home = path.join(sandbox, 'home');
const repo = path.join(sandbox, 'repo');
const sessions = path.join(home, 'sessions');
const parentId = randomUUID();
let mode = 'failure';
let failureId;
let successId;
let serverBase;

function print(label, value) {
  process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
}

function sessionFile(id) {
  return path.join(sessions, `${id}.jsonl`);
}

async function appendEntry(id, entry) {
  const file = sessionFile(id);
  const before = await readFile(file, 'utf8').catch(() => '');
  await writeFile(file, `${before}${JSON.stringify(entry)}\n`);
}

async function createChild(id) {
  await appendEntry(id, {
    type: 'session',
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: repo,
    parentSession: path.join(sessions, `${parentId}.jsonl`),
  });
}

async function roleCounts(id) {
  const lines = (await readFile(sessionFile(id), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return {
    user: lines.filter((entry) => entry.type === 'message' && entry.message?.role === 'user').length,
    assistant: lines.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').length,
  };
}

async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

await mkdir(home, { recursive: true });
await mkdir(repo, { recursive: true });
await mkdir(sessions, { recursive: true });

const server = http.createServer(async (request, response) => {
  const messageMatch = request.url?.match(/^\/sessions\/([^/]+)\/message$/);
  if (request.method === 'POST' && messageMatch) {
    const body = await bodyOf(request);
    if (mode === 'failure') {
      response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: 'session_streaming',
        message: 'stubbed /message returned 409: runtime pool refused task delivery',
      }));
      return;
    }
    await appendEntry(messageMatch[1], {
      type: 'message',
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: body.text }], timestamp: Date.now() },
    });
    response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }));
    return;
  }

  if (request.method !== 'POST' || request.url !== `/sessions/${parentId}/spawn`) {
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'not found' }));
    return;
  }
  const body = await bodyOf(request);
  const childSessionId = randomUUID();
  await createChild(childSessionId);
  if (mode === 'failure') failureId = childSessionId;
  else successId = childSessionId;

  // v2.2's stable host aggregates create + first-message delivery behind /spawn.
  // Keep /message as an explicit stub so the old swallowed-409 failure is still the mechanical fault injection.
  const delivery = await fetch(`${serverBase}/sessions/${childSessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: body.task }),
  });
  const deliveryValue = await delivery.json();
  if (!delivery.ok) {
    response.writeHead(delivery.status, { 'content-type': 'application/json' }).end(JSON.stringify({
      ...deliveryValue,
      childSessionId,
    }));
    return;
  }
  response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
    parentSessionId: parentId,
    childSessionId,
    child: { id: childSessionId },
    cwd: repo,
  }));
});

let primaryError;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  serverBase = `http://127.0.0.1:${address.port}`;
  process.env.SOPHO_DELEGATION_URL = serverBase;

  const pluginPath = path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts');
  const loaded = await discoverAndLoadExtensions([pluginPath], repo, home);
  assert.deepEqual(loaded.errors, []);
  const sessionNewTool = loaded.extensions[0].tools.get('session_new')?.definition;
  assert.ok(sessionNewTool, 'session_new tool missing');
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => parentId } };

  const failed = await sessionNewTool.execute('failure', { task: 'must remain absent', notify: false }, undefined, undefined, ctx);
  assert.equal(failed.details.delivered, false);
  assert.equal(failed.details.sessionId, failureId);
  assert.equal(failed.details.statusCode, 409);
  assert.match(failed.details.reason, /stubbed \/message returned 409/);
  assert.match(failed.content[0].text, /"delivered": false/);
  assert.doesNotMatch(failed.content[0].text, /Spawned/);
  assert.deepEqual(await roleCounts(failureId), { user: 0, assistant: 0 });
  print('failure receipt', failed.details);
  print('failure child role counts', await roleCounts(failureId));

  mode = 'success';
  const succeeded = await sessionNewTool.execute('success', { task: 'delivered task', notify: false }, undefined, undefined, ctx);
  assert.equal(succeeded.details.delivered, true);
  assert.equal(succeeded.details.sessionId, successId);
  assert.equal(succeeded.details.statusCode, 201);
  assert.deepEqual(await roleCounts(successId), { user: 1, assistant: 0 });
  print('success receipt', succeeded.details);
  print('success child role counts', await roleCounts(successId));
  print('RESULT', 'session_new delivery contract PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  delete process.env.SOPHO_DELEGATION_URL;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
