#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-cwd-v22-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const REPO = path.join(TMP, 'repo');
const BASE_LOG = path.join(TMP, 'base.log');
const BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let provider;
let base;
let baseLog;
let providerPort;
let basePort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function reservePort(excluded = new Set()) {
  for (let candidate = 42000 + Math.floor(Math.random() * 12000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error('no high test port available');
}

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, value: raw ? JSON.parse(raw) : {}, raw };
}

async function pollReady() {
  let last;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const reply = await request('/host');
      if (reply.status === 200 && reply.value.currentWorkerPid) return reply.value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last ?? new Error('base did not become ready');
}

async function git(args) {
  return (await execFileAsync('git', ['-C', REPO, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function filesUnder(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push(path.relative(root, target));
    }
  }
  await visit(root);
  return result.sort();
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`pid ${child.pid} did not exit`)), 5000)),
  ]);
}

let primaryError;
try {
  await mkdir(SESSIONS, { recursive: true });
  await mkdir(REPO, { recursive: true });
  await execFileAsync('git', ['-C', REPO, 'init', '-q', '-b', 'main']);
  await execFileAsync('git', ['-C', REPO, 'config', 'user.email', 'cwd@test.invalid']);
  await execFileAsync('git', ['-C', REPO, 'config', 'user.name', 'cwd contract']);
  await writeFile(path.join(REPO, 'AGENTS.md'), '# fixture\n');
  await writeFile(path.join(REPO, 'tracked.txt'), 'clean\n');
  await execFileAsync('git', ['-C', REPO, 'add', 'AGENTS.md', 'tracked.txt']);
  await execFileAsync('git', ['-C', REPO, 'commit', '-q', '-m', 'fixture']);

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  provider = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'cwd test does not ask the model to generate text' }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(providerPort, '127.0.0.1', resolve);
  });
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-cwd', name: 'Fake cwd', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-cwd', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false } }, null, 2)}\n`);

  baseLog = await open(BASE_LOG, 'w');
  base = spawn(process.execPath, [BASE_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME,
      ASSIST_HOME: HOME,
      SOPHO_AGENT_DIR: HOME,
      PI_CODING_AGENT_DIR: HOME,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: REPO,
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const host = await pollReady();
  print('sandbox', { tmp: TMP, basePort, providerPort, basePid: base.pid, workerPid: host.currentWorkerPid });

  const created = await request('/sessions', { method: 'POST', body: { cwd: REPO, name: 'cwd contract' } });
  assert.equal(created.status, 201, created.raw);
  const sessionId = created.value.id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const peer = await request('/sessions', { method: 'POST', body: { cwd: REPO, name: 'same cwd peer' } });
  assert.equal(peer.status, 201, peer.raw);

  const ledger = [];
  for (let index = 0; index < 15; index += 1) {
    const cwd = index === 0 ? REPO : path.join(TMP, `recent-${index}`);
    ledger.push({ cwd, at: 10_000 - index });
  }
  await writeFile(path.join(HOME, 'cwd-recents.json'), `${JSON.stringify(ledger, null, 2)}\n`);

  const api = await request('/cwd-recents?limit=3');
  assert.equal(api.status, 200, api.raw);
  assert.equal(api.value.exists, true);
  assert.equal(api.value.error, null);
  assert.equal(api.value.recents.length, 3);
  assert.deepEqual(api.value.recents[0], { cwd: REPO, at: 10_000 });
  print('GET /cwd-recents', api.value);

  process.env.SOPHO_PORT = String(basePort);
  const loaded = await discoverAndLoadExtensions([path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts')], REPO, HOME);
  assert.deepEqual(loaded.errors, []);
  const cwdTool = loaded.extensions[0].tools.get('cwd')?.definition;
  assert.ok(cwdTool, 'cwd tool must be registered');

  const statusBefore = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  const filesBefore = await filesUnder(REPO);
  const result = await cwdTool.execute('cwd-contract', {}, undefined, undefined, {
    cwd: REPO,
    sessionManager: { getSessionId: () => sessionId },
  });
  const statusAfter = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  const filesAfter = await filesUnder(REPO);

  assert.equal(statusBefore, '');
  assert.equal(statusAfter, statusBefore, 'cwd tool must not change git status');
  assert.deepEqual(filesAfter, filesBefore, 'cwd tool must not create files in the inspected repository');
  assert.equal(result.details.cwd, REPO);
  assert.equal(result.details.readOnly, true);
  assert.equal(result.details.git.isRepository, true);
  assert.equal(result.details.git.root, REPO);
  assert.equal(result.details.git.branch, 'main');
  assert.equal(result.details.git.dirty, false);
  assert.equal(result.details.agentsMd, path.join(REPO, 'AGENTS.md'));
  assert.deepEqual(result.details.sessions, [{ id: peer.value.id, name: 'same cwd peer', status: 'idle' }]);
  assert.equal(result.details.recentDirectories.length, 12, 'tool recents are capped at 12');
  assert.deepEqual(result.details.recentDirectories[0], { cwd: REPO, at: 10_000 });
  assert.deepEqual(result.details.recents, { exists: true, error: null, limit: 12 });
  print('TOOL REAL RETURN', result.details);
  print('read-only proof', { gitStatusBefore: statusBefore, gitStatusAfter: statusAfter, filesBefore, filesAfter });

  await writeFile(path.join(HOME, 'cwd-recents.json'), '{broken json\n');
  const broken = await request('/cwd-recents');
  assert.equal(broken.status, 500);
  assert.equal(broken.value.error, 'cwd_recents_invalid');
  assert.match(broken.value.message, /cwd-recents\.json is invalid/);
  print('broken cwd-recents loud response', broken);
  const brokenTool = await cwdTool.execute('cwd-broken-recents', {}, undefined, undefined, {
    cwd: REPO,
    sessionManager: { getSessionId: () => sessionId },
  });
  assert.deepEqual(brokenTool.details.recentDirectories, []);
  assert.equal(brokenTool.details.recents.exists, null);
  assert.match(brokenTool.details.recents.error, /cwd-recents\.json is invalid/);
  assert.equal(brokenTool.details.cwd, REPO);
  assert.equal(brokenTool.details.readOnly, true);
  print('TOOL BROKEN RECENTS RETURN', brokenTool.details);

  const sidecarFiles = await readdir(HOME);
  assert.equal(sidecarFiles.some((name) => name.includes('cwd-recents.json.') && name.endsWith('.tmp')), false);
  assert.equal((await stat(REPO)).isDirectory(), true);
  print('RESULT', 'cwd tool + /env + v2.2 array cwd-recents PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  try { await stopChild(base); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await removeSandbox(TMP, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
