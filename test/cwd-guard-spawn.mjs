#!/usr/bin/env node
// cwd-guard-spawn —— 会话创建（宿主 `session-new`）的 cwd 占用守卫：
//   (1) 正向：**创建之前**就查占用，而且判据覆盖「刚建出来、还没热」的会话（只看活快照是看不到的）；
//   (2) 冲突回执的**元素形状有契约**：`{id, name, running, sessionFile?, parentSessionId?, source}` ——
//       调用方据此能认出「哪条是我自己刚建出来的」⇒ 自己认领（`docs/manager-toolkit-plan.md` §11 会话创建 ②）。
//   (3) 反证臂：把「查落盘投影」这一步从一份 server/ 副本里拿掉 ⇒ 同一发请求**必须**不再 409（门变红）。
// 不硬编码平台：路径走 os.tmpdir()/path.join，端口 net 自留，收尾按**精确 pid**（绝不 pkill）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
  });
}
function request(port, pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { accept: 'application/json', connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = JSON.parse(raw); } catch {}
        resolve({ statusCode: response.statusCode, value, body: raw.slice(0, 300) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}
async function materialize(dir, { mutate }) {
  await mkdir(dir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(dir, 'web'), { recursive: true });
  await cp(path.join(root, 'pi-extensions'), path.join(dir, 'pi-extensions'), { recursive: true });   // worker 会从 <tree>/pi-extensions 载入扩展
  await writeFile(path.join(dir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (!mutate) return { dir, mutated: null };
  const file = path.join(dir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  const anchor = 'async function persistedSessionFacts(targetCwd) {';
  assert.ok(text.includes(anchor), 'mutation anchor not found (persistedSessionFacts)');
  text = text.replace(anchor, `${anchor}\n  return [];   // (mutation: 落盘投影那一步被拿掉了 —— 只留下活快照那条判据)`);
  assert.ok(text.includes('return [];   // (mutation:'), 'mutation did not apply');
  await writeFile(file, text);
  // 突变过的文件必须是**能跑的**：不然「门变红」会红在语法错误上，等于什么都没验到。
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
    if (error) reject(new Error(`mutated base.mjs does not even parse: ${stderr || error.message}`));
    else resolve();
  }));
  return { dir, mutated: 'persistedSessionFacts merge removed' };
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
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return { child, port, logFile, workerPid: response.value.currentWorkerPid };
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

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'cwd-guard-'));
const problems = [];
let primaryError = null;
const hosts = [];
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const parentCwd = path.join(sandbox, 'parent-cwd');
  const targetCwd = path.join(sandbox, 'target-cwd');
  for (const dir of [sessionsRoot, parentCwd, targetCwd]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const writeSession = async (cwd, name) => {
    const id = randomUUID();
    const at = '2026-09-18T00:00:00.000Z';
    await writeFile(path.join(sessionsRoot, `s_${id}.jsonl`), `${[
      JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd }),
      JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: at, name }),
      JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
    ].join('\n')}\n`);
    return id;
  };
  const parentId = await writeSession(parentCwd, '父会话');
  // ⭐「刚建出来、还没被打开过」的那条：只在盘上，不在任何活 runtime 快照里。
  const ghostId = await writeSession(targetCwd, '上一次创建留下的那条');
  print('fixture', { sandbox, parentId, ghostId, parentCwd, targetCwd });

  const host = await startHost({ treeDir: root, home, sessionsRoot, workspace: parentCwd, logFile: path.join(sandbox, 'fixed.log') });
  hosts.push(host.child);
  const parentHot = await request(host.port, `/sessions/${parentId}/commands`);
  assert.equal(parentHot.statusCode, 200, `the parent must be openable (this makes it live): ${parentHot.body}`);

  // ── 正向：目标 cwd 上有一条**只在盘上**的会话 ⇒ 必须在**创建之前**挡住，且回执列出它
  const refused = await request(host.port, `/sessions/${parentId}/session-new`, { method: 'POST', body: { cwd: targetCwd, name: 'guard-arm' } });
  assert.equal(refused.statusCode, 409, `session-new must refuse a cwd already used by an on-disk session: ${refused.statusCode} ${refused.body}`);
  assert.equal(refused.value?.error, 'workspace_conflict', `error code: ${refused.body}`);
  const conflicts = refused.value?.details?.conflicts;
  assert.ok(Array.isArray(conflicts) && conflicts.length === 1, `details.conflicts must list exactly the on-disk session: ${refused.body}`);
  const conflict = conflicts[0];
  assert.equal(conflict.id, ghostId.toLowerCase(), `the conflict must be the on-disk session: ${refused.body}`);
  for (const key of ['id', 'name', 'running', 'parentSessionId']) {
    assert.ok(Object.hasOwn(conflict, key), `conflict element must carry ${key} (contract): ${JSON.stringify(conflict)}`);
  }
  assert.equal(conflict.name, '上一次创建留下的那条', `conflict name: ${JSON.stringify(conflict)}`);
  assert.equal(conflict.running, false, `an untouched on-disk session is not running: ${JSON.stringify(conflict)}`);
  assert.equal(conflict.source, 'disk', `the conflict must say where it came from: ${JSON.stringify(conflict)}`);
  assert.ok(typeof refused.value?.details?.cwd === 'string' && refused.value.details.cwd.endsWith(path.basename(targetCwd)),
    `details.cwd must name the target directory: ${refused.body}`);
  print('positive arm', { statusCode: refused.statusCode, code: refused.value?.error, conflicts });
  // 反向（同一台宿主）：share:true 仍然放行（守卫只挡「未声明共享」的那条路）
  const shared = await request(host.port, `/sessions/${parentId}/session-new`, { method: 'POST', body: { cwd: targetCwd, name: 'guard-arm-shared', share: true } });
  assert.equal(shared.statusCode, 201, `share:true must still be honored: ${shared.statusCode} ${shared.body}`);
  print('share:true still allowed', { statusCode: shared.statusCode });
  await stop(host.child);

  // ── 反证臂（突变）：把「查落盘投影」拿掉 ⇒ 同一发请求**不再** 409（门因此变红）
  const mutated = await materialize(path.join(sandbox, 'mutated'), { mutate: true });
  print('mutation', mutated.mutated);
  const ghostOnlyHome = path.join(sandbox, 'home-mutated');
  await mkdir(ghostOnlyHome, { recursive: true });
  await writeFile(path.join(ghostOnlyHome, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(ghostOnlyHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const mutatedHost = await startHost({ treeDir: mutated.dir, home: ghostOnlyHome, sessionsRoot, workspace: parentCwd, logFile: path.join(sandbox, 'mutated.log') });
  hosts.push(mutatedHost.child);
  const mutatedParent = await request(mutatedHost.port, `/sessions/${parentId}/commands`);
  assert.equal(mutatedParent.statusCode, 200, `mutated host: parent must be openable: ${mutatedParent.body}`);
  const mutatedResult = await request(mutatedHost.port, `/sessions/${parentId}/session-new`, { method: 'POST', body: { cwd: targetCwd, name: 'guard-arm-mutated' } });
  assert.notEqual(mutatedResult.statusCode, 409, `with the on-disk check removed the guard must NOT refuse (that is the vacancy this door closes): ${mutatedResult.statusCode} ${mutatedResult.body}`);
  print('reverse arm (mutation)', { statusCode: mutatedResult.statusCode, note: '拿掉落盘投影那一步 ⇒ 不再 409 ⇒ 门变红' });
  print('RESULT', { ok: true, checks: 12 });
  process.stdout.write('RESULT: cwd-guard-spawn PASS\n');
} catch (error) {
  primaryError = error;
} finally {
  for (const child of hosts) await stop(child);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
