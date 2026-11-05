#!/usr/bin/env node
// 透传 4xx/5xx 的**契约门**（不是 F1 的复现臂）。
//
// 契约（默认跑，硬断言）：宿主把 worker 的**非 2xx**（这里是 409 `session_cwd_missing`，
// 即 `/sessions/*` 上**除** `session_not_owned_by_generation` 之外的那种透传）原样交给客户端时，
//   ① 状态码与 JSON body 与**直连 worker**一字不差；
//   ② 这一发请求必须在**有限时间**内完整结束（客户端拿到 'end'，不是靠超时收场）；
//   ③ 宿主进程一直活着（不是「响应结束但宿主崩了」）。
//
// 为什么没有「把 end() 改回 pipe()」那种反证臂（本仓 2026-09-21 的教训）：
//   审查报告曾把 `incoming.pipe(response)`（读完 body 之后）判成「响应永不结束」的真 bug（F1）→ `7a882eb`
//   把它改成显式 `response.end()`。**实测推翻了这个定位**：`Readable.prototype.pipe()` 对**已经 emit 过
//   'end'** 的源会 `process.nextTick(onend)` ⇒ `dest.end()` 照常被调用（Node 源码里的 `kEndEmitted` 分支）。
//   实测环境：活宿主用的 `/usr/bin/node` v26.9.0 ＋ 本机另一份 v22.5.1，两者都有那个分支；
//   在**真树副本**上把 `end()` 改回 `pipe()`，这一发 409 仍然是 6–8ms 就结束 ⇒ 那种反证臂**判不到东西**。
//   所以 `7a882eb` 的代码改动已**撤回**（回到 `pipe()`），而这条门留下来当契约门。
//   ⇒ 想验「这条门真的能红吗」请用自检臂（`--self-test`）：它把两处透传改成「**既不 end 也不 pipe**
//   且去掉 content-length（变 chunked）」⇒ 客户端**必须**挂住（否则就是拿一条永远绿的门在自欺）。
//
// 沙箱：副本 home + 端口 net 自留；进程一律**按精确 pid** 杀（绝不 pkill）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SELF_TEST = process.argv.includes('--self-test');
const CLIENT_DEADLINE_MS = 2000;
const ROUNDS = 3;

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
  });
}

function request(port, pathname, { method = 'GET', body = null, headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const startedAt = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { accept: 'application/json', connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = JSON.parse(text); } catch {}
        resolve({ statusCode: response.statusCode, headers: response.headers, value, body: text, elapsedMs: Date.now() - startedAt, timedOut: false });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.once('error', (error) => {
      if (String(error.message).startsWith('timeout after')) {
        resolve({ statusCode: null, headers: null, value: null, body: null, elapsedMs: Date.now() - startedAt, timedOut: true, error: error.message });
        return;
      }
      reject(error);
    });
    req.end(payload ?? undefined);
  });
}

// 副本：自检臂的突变只落在副本里（真树一个字不改）。突变锚不到就**报错**（不静默）。
// 突变 = 「两处透传既不 end 也不 pipe，且去掉 content-length（变成 chunked）」⇒ 响应永不结束。
async function materialize(treeDir, { noEnding }) {
  await mkdir(treeDir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(treeDir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(treeDir, 'web'), { recursive: true });
  await cp(path.join(root, 'pi-extensions'), path.join(treeDir, 'pi-extensions'), { recursive: true });
  await writeFile(path.join(treeDir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(treeDir, 'node_modules'), 'dir');
  if (!noEnding) return { dir: treeDir, mutated: null };
  const file = path.join(treeDir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  const sites = [
    { indent: '          ', seen: 0 },
    { indent: '        ', seen: 0 },
  ];
  for (const site of sites) {
    const anchor = [
      `${site.indent}response.writeHead(incoming.statusCode || 502, incoming.headers);`,
      `${site.indent}if (raw.length > 0) response.write(raw);`,
      `${site.indent}incoming.pipe(response);`,
    ].join('\n');
    const mutated = [
      `${site.indent}{ const mutatedHeaders = { ...incoming.headers }; delete mutatedHeaders["content-length"]; delete mutatedHeaders["transfer-encoding"]; response.writeHead(incoming.statusCode || 502, mutatedHeaders); }   // (mutation: 去 content-length ⇒ chunked)`,
      `${site.indent}if (raw.length > 0) response.write(raw);`,
      `${site.indent}/* (mutation: 既不 end 也不 pipe ⇒ 这一发永不结束) */`,
    ].join('\n');
    site.seen = text.split(anchor).length - 1;
    assert.equal(site.seen, 1, `mutation must find exactly one non-2xx passthrough site at indent ${site.indent.length}, found ${site.seen}`);
    text = text.split(anchor).join(mutated);
  }
  await writeFile(file, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
    if (error) reject(new Error(`mutated base.mjs does not even parse: ${stderr || error.message}`));
    else resolve();
  }));
  return { dir: treeDir, mutated: 'the two non-2xx passthrough sites neither end nor pipe (content-length dropped ⇒ chunked)' };
}

async function startHost({ treeDir, home, sessionsRoot, workspace, logFile }) {
  const port = await reservePort();
  const log = await open(logFile, 'w');
  const child = spawn(process.execPath, [path.join(treeDir, 'server', 'base.mjs')], {
    cwd: treeDir,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot, PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port), SOPHO_DEFAULT_CWD: workspace, SOPHO_NO_TOOLS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
      SOPHO_GENERATION_WAIT_MS: '500',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await request(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return { child, port, logFile, hostStatus: response.value };
    } catch {}
    await sleep(100);
  }
  const tail = await readFile(logFile, 'utf8').catch(() => '(log unreadable)');
  throw new Error(`sandbox host did not become ready on ${port}\n--- log tail ---\n${tail.split('\n').slice(-14).join('\n')}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise((resolve) => child.once('exit', resolve)).then(() => true), sleep(15000).then(() => false)]);
  if (!exited && child.exitCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
}

async function workerPorts(logFile) {
  const text = await readFile(logFile, 'utf8');
  return [...text.matchAll(/\{"event":"worker_ready"[^}]*\}/g)].map((match) => JSON.parse(match[0]));
}
const workerToken = (hostPid, generationId, reason) => createHash('sha256').update(`${hostPid}:${generationId}:${reason}`).digest('hex');

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'proxy-409-'));
const problems = [];
let primaryError = null;
const hosts = [];
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  const sessionCwd = path.join(sandbox, 'session-cwd');
  for (const dir of [sessionsRoot, workspace, sessionCwd]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  // 一条**cwd 已经被删掉**的会话：worker 对它的任何写动作都回 409 `session_cwd_missing`（不是 ownership 那条）。
  const sessionId = randomUUID();
  const at = '2026-09-18T00:00:00.000Z';
  await writeFile(path.join(sessionsRoot, `s_${sessionId}.jsonl`), `${[
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: at, cwd: sessionCwd }),
    JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: at, name: 'cwd 已消失的会话' }),
    JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
  ].join('\n')}\n`);
  print('fixture', { sandbox, sessionId, sessionCwd, selfTest: SELF_TEST, clientDeadlineMs: CLIENT_DEADLINE_MS, rounds: ROUNDS });

  const treeDir = SELF_TEST ? (await materialize(path.join(sandbox, 'mutated'), { noEnding: true })).dir : root;
  if (SELF_TEST) print('mutation', 'the two non-2xx passthrough sites neither end nor pipe (content-length dropped ⇒ chunked)');
  const host = await startHost({ treeDir, home, sessionsRoot, workspace, logFile: path.join(sandbox, `${SELF_TEST ? 'mutated' : 'fixed'}.log`) });
  hosts.push(host.child);
  const generationId = host.hostStatus.currentGenerationId;
  const ports = await workerPorts(host.logFile);
  const first = ports.find((entry) => entry.generationId === generationId);
  assert.ok(first?.port, `worker_ready for ${generationId} must be in the host log: ${JSON.stringify(ports)}`);
  const token = workerToken(host.hostStatus.pid, generationId, 'boot');
  print('direct-to-worker', { generationId, workerPort: first.port, tokenPrefix: token.slice(0, 12) });

  // cwd 真的消失 ⇒ worker 对它的一切写动作都必须回 409 `session_cwd_missing`（不是 ownership 那条）。
  // · 挑 `/message` 当代表：它是**内容写**（要「继续用这条会话」）⇒ 照旧 409。
  // （不再用 `/archive`：2026-09-22 起归档只在会话文件里追加一条元数据、不过 cwd 门 ⇒ 它现在会 200。）
  await rm(sessionCwd, { recursive: true, force: true });
  // ① 直连 worker 的对照（同一条请求、同一个 body）。
  const directAfter = await request(first.port, `/sessions/${sessionId}/message`, {
    method: 'POST', body: { text: 'must not run' },
    headers: { host: 'worker.local', 'x-sopho-worker-token': token, 'x-sopho-current-generation': generationId },
    timeoutMs: 5000,
  });
  assert.equal(directAfter.statusCode, 409, `direct worker must answer 409 for a session whose cwd is gone: ${directAfter.statusCode} ${directAfter.body}`);
  assert.equal(directAfter.value?.error, 'session_cwd_missing', `direct worker error code: ${directAfter.body}`);
  print('direct-to-worker 409 (verbatim)', { statusCode: directAfter.statusCode, body: directAfter.body.trim(), headers: { 'content-length': directAfter.headers?.['content-length'], 'transfer-encoding': directAfter.headers?.['transfer-encoding'] } });

  // ② 经宿主的同一发请求。
  const rounds = [];
  for (let index = 0; index < ROUNDS; index += 1) {
    const viaHost = await request(host.port, `/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'must not run' }, timeoutMs: CLIENT_DEADLINE_MS });
    rounds.push({ round: index + 1, schema: viaHost.timedOut ? 'CLIENT TIMEOUT' : 'completed', statusCode: viaHost.statusCode, elapsedMs: viaHost.elapsedMs, body: viaHost.timedOut ? null : viaHost.body.trim() });
    print(`via host round ${index + 1}`, rounds.at(-1));
    if (SELF_TEST) {
      // 自检臂的**期望**：既不 end 也不 pipe 且变成 chunked ⇒ 客户端**必须**挂住。
      // （不挂 ⇒ 这条门没有牙 —— 一条永远绿的门在自欺。）
      assert.ok(viaHost.timedOut, `SELF-TEST: a passthrough that neither ends nor pipes must hang the client (${CLIENT_DEADLINE_MS}ms) —— 它却在 ${viaHost.elapsedMs}ms 里回完了（${viaHost.statusCode}）⇒ 这条门判不到东西`);
      print(`self-test round ${index + 1}`, { verdict: 'HUNG as expected (the gate has teeth)', elapsedMs: viaHost.elapsedMs });
    } else {
      assert.equal(viaHost.timedOut, false, `round ${index + 1}: the host must end this 409 inside ${CLIENT_DEADLINE_MS}ms (an unfinished passthrough must not hang)`);
      assert.equal(viaHost.statusCode, 409, `round ${index + 1}: host status: ${viaHost.statusCode} ${viaHost.body}`);
      assert.equal(viaHost.value?.error, 'session_cwd_missing', `round ${index + 1}: host error code: ${viaHost.body}`);
      assert.equal(viaHost.body, directAfter.body, `round ${index + 1}: the host body must be byte-identical to the direct worker body`);
      assert.deepEqual(viaHost.value, directAfter.value, `round ${index + 1}: the host JSON must equal the direct worker JSON`);
      assert.ok(viaHost.elapsedMs < CLIENT_DEADLINE_MS, `round ${index + 1}: elapsed ${viaHost.elapsedMs}ms`);
    }
    // ③ 宿主活着（同一 pid 的 /host 仍然 200）。
    const alive = await request(host.port, '/host', { timeoutMs: 3000 });
    assert.equal(alive.statusCode, 200, `round ${index + 1}: the host process must stay alive`);
    assert.equal(alive.value.pid, host.hostStatus.pid, `round ${index + 1}: host pid must not change`);
  }
  print('RESULT', { ok: true, mode: SELF_TEST ? 'self-test' : 'positive', rounds: rounds.length, contract: SELF_TEST ? 'a passthrough that neither ends nor pipes must hang (gate self-test)' : 'non-2xx passthrough ends in bounded time, verbatim, host alive' });
  process.stdout.write(`RESULT: proxy-409-passthrough ${SELF_TEST ? 'SELF-TEST' : ''} PASS\n`);
} catch (error) {
  primaryError = error;
} finally {
  for (const child of hosts) await stop(child);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
