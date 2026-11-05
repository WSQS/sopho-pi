#!/usr/bin/env node
// host-ipc-crash —— 宿主**不许**因为「给正在退出的 worker 发 IPC」而整体退出。
//
// 现场（2026-09-21，本轮报告 §A）：一次 `POST /reload-code` 之后**并发**多个 `GET /tree`，
// 宿主进程直接退出 —— 真机上就是整个实例（所有会话）都没了。机制：
//   · `/tree` 每次都会给 draining 代发一条 live-facts（`drainingRunningSessionIds` → `callWorker` → `child.send`）；
//   · worker 退出时它的 IPC 通道会被关掉，而 host 侧的 'exit' 事件（把 `record.child` 置 null）还没到
//     ⇒ 那个窗口里的 `send()` 会**异步**以 EPIPE 收场（同步那份被 try/catch 挡住了）；
//   · Node 对**没有监听者的 'error' 事件**的处理是**终止进程**；而原来只有 startWorker 里一个
//     `once('error')`（只吃得下第一个）⇒ 并发多个 send 落在窗口里时，第 2 个 'error' 就没人接。
// 修法（server/base.mjs，三处，缺一不可）：
//   ① `callWorker` 的 `child.send(..., cb)` 带 callback（失败走 callback，不再发 'error' 事件，且把失败
//      如实报给调用方）；② worker 上挂**常驻** `child.on('error', …)`（任何 send/spawn 失败只记日志）；
//   ③ draining 代的通道已断就不再发（`worker.child?.connected`）。
//
// 这道门钉两件：
//   (1) 正向：在**沙箱实例**上制造那个窗口（reload + 并发 /tree，多轮）⇒ 宿主进程必须**一直活着**、
//       `/host` 一直答、`/tree` 一直答 200、日志里**不许**出现 `Unhandled 'error' event`；
//   (2) 反向（突变）：把上面三处修法从**一份 server/ 副本**里机械地拿掉，同样的窗口 ⇒
//       **必须**能看到崩溃（宿主非零退出 + 日志里的 unhandled 横幅）。窗口是真的，由这一臂证明；
//       两臂合起来才能说明「修法是那个不死的原因」。
// 门的失败**不互相遮挡**：每臂独立报告，跑完所有臂再汇总失败（含两边的日志尾部）。
//
// 自足：临时 home/目录 + 高位随机端口 + 自己 spawn 的 pid 收尾；绝不 pkill（按精确 pid）；
// 绝不碰 7331/7321、绝不碰真 profile。
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
import { finishCleanup, processEnvironment, processTable, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CYCLES = Number(process.env.SOPHO_IPC_CRASH_CYCLES ?? 14);
const CONCURRENCY = Number(process.env.SOPHO_IPC_CRASH_CONCURRENCY ?? 60);
const SESSION_FILES = Number(process.env.SOPHO_IPC_CRASH_SESSIONS ?? 6);

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const spawned = new Set();

async function step(label, fn) {
  try {
    await fn();
    process.stdout.write(`✓ ${label}\n`);
  } catch (error) {
    failures.push({ label, error });
    process.stdout.write(`✗ ${label} —— ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

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
        resolve({ statusCode: response.statusCode, value, body: raw.slice(0, 200) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

async function stop(child) {
  if (!child) return;
  spawned.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)).then(() => true),
    sleep(15000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}
async function stopAll() { for (const child of [...spawned]) await stop(child); }

// 一份可启动的「宿主源码树」：`<dir>/server/*` + `web/` + `node_modules` 软链 + package.json
async function materializeHostTree(dir, { mutate }) {
  await mkdir(dir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(dir, 'web'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (!mutate) return { dir, mutated: [] };
  // ── 反向臂：把 A 的三处修法机械地拿掉（每一处都**核实**真的拿掉了）──────────────
  const file = path.join(dir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  const mutated = [];
  const removeEnclosing = (marker, startAnchor) => {
    const at = text.indexOf(marker);
    assert.ok(at >= 0, `mutation anchor not found: ${marker}`);
    const start = text.lastIndexOf(startAnchor, at);
    assert.ok(start >= 0, `mutation start anchor not found: ${startAnchor}`);
    const end = text.indexOf('\n  });\n', at);
    assert.ok(end > at, 'mutation end anchor not found');
    text = `${text.slice(0, start)}  // (mutation: 这一段被拿掉了)\n${text.slice(end + '\n  });\n'.length)}`;
  };
  removeEnclosing('process error (IPC/spawn, ignored)', "\n  child.on('error', (error) => {");
  mutated.push({ what: "常驻 child.on('error')", gone: !text.includes('process error (IPC/spawn, ignored)') });
  const sendWithCallback = /      child\.send\(\{ \.\.\.message, requestId \}, \(error\) => \{\n        if \(error\) done\(reject[^\n]*\n      \}\);/;
  assert.ok(sendWithCallback.test(text), 'mutation anchor not found: callWorker send callback');
  text = text.replace(sendWithCallback, '      child.send({ ...message, requestId });');
  mutated.push({ what: 'callWorker send 的 callback', gone: !text.includes('child.send({ ...message, requestId },') });
  assert.ok(text.includes('    if (!worker.child?.connected) continue;'), 'mutation anchor not found: connected guard');
  text = text.replace('    if (!worker.child?.connected) continue;', '    if (!worker.child) continue;');
  mutated.push({ what: 'connected 守卫', gone: !text.includes('worker.child?.connected') });
  await writeFile(file, text);
  assert.ok(mutated.every((item) => item.gone), `mutation did not apply: ${JSON.stringify(mutated)}`);
  return { dir, mutated };
}

async function startSandboxHost({ treeDir, home, sessionsRoot, workspace, logFile, env = {} }) {
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
      ...env,
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  spawned.add(child);
  const state = { child, port, logFile, pid: child.pid, exited: null, workers: new Set() };
  child.once('exit', (code, signal) => { state.exited = { code, signal }; });
  for (let attempt = 0; attempt < 200 && state.exited === null; attempt += 1) {
    try {
      const response = await request(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) {
        for (const worker of response.value.workers ?? []) if (worker.pid) state.workers.add(worker.pid);
        return state;
      }
    } catch {}
    await sleep(100);
  }
  const tail = await tailOf(logFile);
  throw new Error(`sandbox host did not become ready on ${port} (exited=${JSON.stringify(state.exited)})\n${tail}`);
}

async function tailOf(file, lines = 14) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').slice(-lines).join('\n');
}

/** 制造那个窗口：reload 之后**并发**打 /tree（多轮），并把每一轮的结果如实收回来。 */
async function probeWindow(state) {
  const rounds = [];
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    if (state.exited !== null) { rounds.push({ cycle, diedBeforeReload: state.exited }); break; }
    const reload = await request(state.port, '/reload-code', { method: 'POST', body: {} }).catch((error) => ({ statusCode: 0, body: error.message, value: null }));
    // ⚠️ `POST /reload-code` 回的是 `pid`（不是 workerPid）—— 字段名写错的代价就是：宿主被打死之后
    // 它的 worker 变成孤儿却不在我的名单里（实测漏过 3 个）。
    if (reload.value?.pid) state.workers.add(reload.value.pid);
    const batch = await Promise.all(Array.from({ length: CONCURRENCY }, () => request(state.port, '/tree').catch((error) => ({ statusCode: 0, body: error.message }))));
    const bad = batch.filter((item) => item.statusCode !== 200);
    const alive = state.exited === null;
    rounds.push({
      cycle,
      reload: reload.statusCode,
      ok: batch.length - bad.length,
      bad: bad.length,
      firstBad: bad[0] ? { status: bad[0].statusCode, body: bad[0].body } : null,
      alive,
      diedAt: state.exited,
    });
    if (!alive) break;
  }
  return rounds;
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'host-ipc-crash-'));
const cleanupProblems = [];
let primaryError = null;
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  for (let index = 0; index < SESSION_FILES; index += 1) {
    const id = randomUUID();
    const at = new Date(Date.UTC(2026, 8, 18) + index * 1000).toISOString();
    await writeFile(path.join(sessionsRoot, `s${index}_${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: workspace })}\n${JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: `a${index}` }] } })}\n`);
  }
  print('fixture', { sandbox, sessions: SESSION_FILES, cycles: CYCLES, concurrency: CONCURRENCY });

  // ── (1) 正向：修法在场 ⇒ 宿主必须一直活着 ───────────────────────────────────────
  let fixedState = null;
  let fixedRounds = [];
  await step('正向臂：沙箱宿主起得来（修法在场的源码树）', async () => {
    fixedState = await startSandboxHost({
      treeDir: await materializeHostTree(path.join(sandbox, 'fixed'), { mutate: false }).then((entry) => entry.dir),
      home, sessionsRoot, workspace, logFile: path.join(sandbox, 'fixed.log'),
    });
  });
  await step(`正向臂：${CYCLES} 轮 reload + ${CONCURRENCY} 并发 /tree —— 宿主不死、每个请求都答 200`, async () => {
    assert.ok(fixedState, 'the fixed sandbox host must be up');
    fixedRounds = await probeWindow(fixedState);
    const died = fixedRounds.find((round) => round.alive === false);
    assert.ok(!died, `the host died during the probe window: ${JSON.stringify(died)}`);
    assert.equal(fixedRounds.length, CYCLES, `all ${CYCLES} rounds must have run: ${JSON.stringify(fixedRounds)}`);
    const bads = fixedRounds.filter((round) => round.bad > 0);
    assert.deepEqual(bads, [], `every concurrent /tree must answer 200 while the old generation is dying: ${JSON.stringify(bads)}`);
  });
  await step('正向臂：日志里不许出现 unhandled error（那一条就是「宿主会退出」的前兆）', async () => {
    assert.ok(fixedState, 'the fixed sandbox host must be up');
    const text = await readFile(fixedState.logFile, 'utf8').catch(() => '');
    assert.equal(/Unhandled 'error' event/.test(text), false, `host log must not contain an unhandled error event:\n${text.split('\n').slice(-14).join('\n')}`);
    assert.equal(fixedState.exited, null, `the host process must still be alive: exited=${JSON.stringify(fixedState.exited)}`);
  });
  await step('正向臂：窗口之后仍然正常服务（/host + /tree）', async () => {
    assert.ok(fixedState, 'the fixed sandbox host must be up');
    const host = await request(fixedState.port, '/host');
    assert.equal(host.statusCode, 200, `GET /host after the window: ${JSON.stringify(host.body)}`);
    const tree = await request(fixedState.port, '/tree');
    assert.equal(tree.statusCode, 200, `GET /tree after the window: ${JSON.stringify(tree.body)}`);
    assert.ok(Array.isArray(tree.value?.sessions) && tree.value.sessions.length === SESSION_FILES, `the tree must be complete after the window: ${JSON.stringify(tree.body)}`);
  });
  print('fixed-arm rounds', fixedRounds);

  // ── (2) 反向臂（突变）：拿掉那三处修法 ⇒ 同样的窗口必须能看到崩溃 ─────────────────
  let mutatedState = null;
  let mutatedRounds = [];
  await step('反向臂：突变过的源码树也能起得来（证明下面看到的崩溃不是「起不来」）', async () => {
    const tree = await materializeHostTree(path.join(sandbox, 'mutated'), { mutate: true });
    print('mutation', tree.mutated);
    mutatedState = await startSandboxHost({ treeDir: tree.dir, home, sessionsRoot, workspace, logFile: path.join(sandbox, 'mutated.log') });
  });
  await step('反向臂：同样的窗口 ⇒ 宿主**必须**崩溃（非零退出 / unhandled error 横幅）', async () => {
    assert.ok(mutatedState, 'the mutated sandbox host must be up');
    mutatedRounds = await probeWindow(mutatedState);
    const text = await readFile(mutatedState.logFile, 'utf8').catch(() => '');
    const unhandled = /Unhandled 'error' event/.test(text);
    const crashed = mutatedState.exited !== null && mutatedState.exited.code !== 0;
    assert.ok(crashed || unhandled, `with the fix removed the host must die here (exited=${JSON.stringify(mutatedState.exited)}, unhandled=${unhandled}):\n${JSON.stringify(mutatedRounds)}\n${text.split('\n').slice(-14).join('\n')}`);
    print('mutated-arm crash evidence', {
      exited: mutatedState.exited,
      unhandledErrorBanner: unhandled,
      epipeLines: (text.match(/EPIPE/g) ?? []).length,
      rounds: mutatedRounds.slice(0, 3),
      logTail: text.split('\n').slice(-12).join('\n'),
    });
  });
  print('mutated-arm rounds', mutatedRounds);

  // 反向臂里那个宿主是被打死的 ⇒ 它的 worker 会**变成孤儿**（宿主死了没人收它）：按精确 pid 收掉。
  // ① 名单里的 pid：逐个核实真的停了（停不掉就记一条失败 —— 门不许静默留下进程）。
  for (const state of [fixedState, mutatedState]) {
    if (!state) continue;
    for (const pid of state.workers) {
      try { process.kill(pid, 0); } catch { continue; }   // 已经没了
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await sleep(300);
      try { process.kill(pid, 0); } catch { continue; }
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await sleep(300);
      try {
        process.kill(pid, 0);
        failures.push({ label: `沙箱收尾：worker pid ${pid} 没停掉`, error: new Error('still alive after SIGKILL') });
      } catch { /* 停掉了 */ }
    }
  }
  // ② 兜底扫描：宿主被打死之后它的 worker 会**变成孤儿**（实测漏过：名单只收 boot 那一个，
  //    reload 回的是 `pid` 而我当时读错了字段）。这里按「HOME 指向本沙箱」认进程，并按
  //    **精确 pid** 停掉。看进程一律经过 `test/harness.mjs`（`processTable` / `processEnvironment`）
  //    —— 平台分叉只住那一个文件，本文件里不出现 procfs 字面量。别的平台读不到别的进程的
  //    环境（`processEnvironment` 如实返回 null）⇒ 这条兜底不会命中，与今天一致；① 才是主路。
  for (const row of await processTable({ withCommandLine: false }).catch(() => [])) {
    if (row.pid === process.pid) continue;
    const environment = await processEnvironment(row.pid);
    if (!environment?.includes(`HOME=${home}`)) continue;
    try { process.kill(row.pid, 'SIGTERM'); } catch { continue; }
    await sleep(300);
    try { process.kill(row.pid, 'SIGKILL'); } catch {}
    await sleep(300);
    try { process.kill(row.pid, 0); failures.push({ label: `沙箱收尾：孤儿 pid ${row.pid} 没停掉`, error: new Error('still alive after SIGKILL') }); } catch {}
  }
} catch (error) {
  primaryError = error;
} finally {
  await stopAll();
  if (failures.length > 0) {
    for (const failure of failures) {
      print('FAILED ARM', { label: failure.label, error: failure.error instanceof Error ? failure.error.message : String(failure.error) });
    }
    print('log tails', {
      fixed: await tailOf(path.join(sandbox, 'fixed.log')),
      mutated: await tailOf(path.join(sandbox, 'mutated.log')),
    });
  }
  await removeSandbox(sandbox, cleanupProblems);
  if (primaryError) throw primaryError;
  if (failures.length > 0) {
    throw new Error(`${failures.length} arm(s) failed: ${failures.map((failure) => failure.label).join(' | ')}`);
  }
  finishCleanup(null, cleanupProblems);
}
print('RESULT', { ok: true, cycles: CYCLES, concurrency: CONCURRENCY, arms: 6 });
process.stdout.write('RESULT: host-ipc-crash PASS\n');
