#!/usr/bin/env node
// S0a regression under the S1b generation-worker host.
//
// The original S0a here reloaded an in-process logic module. Since S1b the host
// stays up and the logic layer lives in a replaceable generation worker
// (docs/design-runtime-isolation.md §3), so the facts this test pins are:
//   1. /host reports a host pid and a worker pid, and the listening socket belongs
//      to the host (the host pid never changes across reloads).
//   2. POST /reload-code swaps generations atomically and serially, keeps the host
//      pid and the HTTP keep-alive connection, and settles to exactly one worker.
//   3. A concurrent reload burst is serialized (unique versions, no lost reload).
//   4. bin/stop.sh only stops processes it can prove are ours, and stopping the
//      host takes its workers with it. On Windows, where v2.2 still has no native
//      start/stop scripts, the test harness applies the same exact-pid/cmdline rule.
//
// Sandbox only: a copied tree, a copy home, a high random port. No real profile,
// no 7331/7321, and processes are killed by the exact pid (never by name).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { finishCleanup, listenerPid, processCommandLine, removeSandbox } from './harness.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's0a-foundation-'));
const sandboxRoot = path.join(sandbox, 'repo');
const sandboxHome = path.join(sandbox, 'home');
const logPath = path.join(sandbox, 's0a-base.log');
let port;
let appPort;
let otherPort;
let started = false;
let windowsBase;
let windowsApp;
let windowsBaseLog;
let windowsAppLog;
let innocentServer;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort() {
  for (let candidate = 42000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

function request(agent, method, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, agent });
    request.once('error', reject);
    request.once('socket', (socket) => { request.__socket = socket; });
    request.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let value;
        try { value = JSON.parse(body); } catch (error) {
          reject(new Error(`invalid JSON from ${method} ${pathname}: ${body}`, { cause: error }));
          return;
        }
        resolve({ statusCode: response.statusCode, value, socket: request.__socket });
      });
    });
    request.end();
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function runScript(name, selectedPort = port) {
  if (process.platform === 'win32') {
    if (name === 'serve.sh') {
      windowsBaseLog = await open(logPath, 'w');
      windowsAppLog = await open(path.join(sandbox, 's0a-app.log'), 'w');
      const common = {
        ...process.env,
        HOME: sandboxHome,
        ASSIST_HOME: sandboxHome,
        SOPHO_AGENT_DIR: sandboxHome,
        PI_CODING_AGENT_DIR: sandboxHome,
        PI_OFFLINE: '1',
      };
      windowsBase = spawn(process.execPath, [path.join(sandboxRoot, 'server', 'base.mjs')], {
        cwd: sandboxRoot,
        env: { ...common, SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(port) },
        stdio: ['ignore', windowsBaseLog.fd, windowsBaseLog.fd],
      });
      windowsApp = spawn(process.execPath, [path.join(sandboxRoot, 'server', 'app.mjs')], {
        cwd: sandboxRoot,
        env: { ...common, SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort), SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(port), SOPHO_WEB_ROOT: path.join(sandboxRoot, 'web') },
        stdio: ['ignore', windowsAppLog.fd, windowsAppLog.fd],
      });
      const host = (await pollWorkerCount(1, 30_000));
      let app;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        try {
          const response = await new Promise((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port: appPort, path: '/app-host' }, (res) => {
              let body = '';
              res.on('data', (chunk) => { body += chunk; });
              res.on('end', () => resolve(JSON.parse(body)));
            });
            req.once('error', reject);
          });
          app = response;
          break;
        } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      if (!app) throw new Error('Windows app child did not become ready');
      return { stdout: `started pid=${host.pid} logicVersion=${host.logicVersion} startedAt=${host.startedAt} appPid=${app.pid} appVersion=${app.codeVersion}` };
    }
    if (name === 'stop.sh') {
      if (selectedPort !== port) {
        const foreignPid = await listenerPid(selectedPort);
        const commandLine = foreignPid ? await processCommandLine(foreignPid) : '';
        if (foreignPid && !commandLine.includes(path.join(sandboxRoot, 'server', 'base.mjs'))) {
          const error = new Error(`refusing to stop pid ${foreignPid}`);
          error.stderr = `refusing to stop pid ${foreignPid}: port ${selectedPort} owner cmdline is not ${path.join(sandboxRoot, 'server', 'base.mjs')}`;
          throw error;
        }
      }
      const appPid = windowsApp?.pid;
      const basePid = windowsBase?.pid;
      if (appPid && processAlive(appPid)) process.kill(appPid, 'SIGTERM');
      if (basePid && processAlive(basePid)) process.kill(basePid, 'SIGTERM');
      for (const pid of [appPid, basePid].filter(Boolean)) {
        for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await windowsBaseLog?.close(); windowsBaseLog = null;
      await windowsAppLog?.close(); windowsAppLog = null;
      windowsBase = null;
      windowsApp = null;
      return { stdout: `B stopped pid=${appPid} port=${appPort}\nA stopped pid=${basePid} port=${port}` };
    }
  }
  return execFileAsync('bash', [path.join(sandboxRoot, 'bin', name)], {
    cwd: sandboxRoot,
    env: {
      ...process.env,
      HOME: sandboxHome,
      ASSIST_HOME: sandboxHome,
      SOPHO_AGENT_DIR: sandboxHome,
      PI_CODING_AGENT_DIR: sandboxHome,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(selectedPort),
      SOPHO_APP_PORT: String(appPort),
      SOPHO_LOG: logPath,
      SOPHO_APP_LOG: path.join(sandbox, 's0a-app.log'),
    },
  });
}

async function pollWorkerCount(expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await request(undefined, 'GET', '/host');
      last = response.value;
      if (last.workerCount === expected && last.drainingGenerations.length === 0) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`worker count did not settle to ${expected}; last=${JSON.stringify(last)}`);
}

let primaryError;
try {
  await mkdir(sandboxRoot, { recursive: true });
  await mkdir(sandboxHome, { recursive: true });
  await cp(path.join(sourceRoot, 'server'), path.join(sandboxRoot, 'server'), { recursive: true });
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(sandboxRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await cp(path.join(sourceRoot, 'bin'), path.join(sandboxRoot, 'bin'), { recursive: true });
  await cp(path.join(sourceRoot, 'web'), path.join(sandboxRoot, 'web'), { recursive: true });
  port = await reserveHighPort();
  do {
    appPort = await reserveHighPort();
  } while (appPort === port);
  do {
    otherPort = await reserveHighPort();
  } while (otherPort === port || otherPort === appPort);
  print('sandbox', { root: sandboxRoot, home: sandboxHome, port, appPort, otherPort });

  const served = await runScript('serve.sh');
  started = true;
  print('serve proof', served.stdout.trim());
  assert.match(served.stdout, /started pid=\d+ logicVersion=g-[0-9-]+#?\d* .* appPid=\d+/);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const hostBefore = await request(agent, 'GET', '/host');
    assert.equal(hostBefore.statusCode, 200);
    const hostPid = hostBefore.value.pid;
    const workerPidBefore = hostBefore.value.currentWorkerPid;
    assert.equal(Number(await listenerPid(port)), hostPid, 'the host pid owns the public port');
    assert.ok(workerPidBefore > 0, '/host reports a real worker pid');
    assert.equal(hostBefore.value.workerCount, 1);
    assert.ok(hostBefore.value.workerRssBytes > 0, 'workerRssBytes is a measurement, not a constant 0');
    assert.equal(hostBefore.value.drainingGenerations.length, 0);
    assert.ok(Number.isFinite(Date.parse(hostBefore.value.startedAt)));
    assert.equal(typeof hostBefore.value.uptimeSeconds, 'number');
    print('V1 /host', {
      hostPid,
      workerPid: workerPidBefore,
      currentGenerationId: hostBefore.value.currentGenerationId,
      workerCount: hostBefore.value.workerCount,
      workerRssBytes: hostBefore.value.workerRssBytes,
      generationLimit: hostBefore.value.generationLimit,
    });

    const pingBefore = await request(agent, 'GET', '/ping');
    const persistentSocket = pingBefore.socket;
    assert.ok(persistentSocket && !persistentSocket.destroyed);
    print('V2 before', { ...pingBefore.value, hostPid, workerPid: workerPidBefore });

    const reload = await request(agent, 'POST', '/reload-code');
    assert.equal(reload.statusCode, 200);
    assert.equal(reload.value.pid, hostPid, 'reload must keep the host pid');
    assert.equal(reload.value.previousLogicVersion, hostBefore.value.logicVersion);
    assert.notEqual(reload.value.logicVersion, hostBefore.value.logicVersion);
    assert.strictEqual(reload.socket, persistentSocket, 'reload must not rebuild the client connection');
    print('V2 reload', reload.value);

    const settled = await pollWorkerCount(1);
    const hostAfter = await request(agent, 'GET', '/host');
    assert.equal(hostAfter.value.pid, hostPid);
    assert.equal(hostAfter.value.logicVersion, reload.value.logicVersion);
    assert.equal(hostAfter.value.workerCount, 1);
    assert.equal(hostAfter.value.drainingGenerations.length, 0);
    assert.notEqual(hostAfter.value.currentWorkerPid, workerPidBefore, 'the current worker really is a new process');
    assert.ok(await (async () => { for (let index = 0; index < 50; index += 1) { if (!processAlive(workerPidBefore)) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } return !processAlive(workerPidBefore); })()
      , 'the drained worker pid must exit');
    const pingAfter = await request(agent, 'GET', '/ping');
    assert.strictEqual(pingAfter.socket, persistentSocket);
    assert.equal(persistentSocket.destroyed, false);
    print('V2 after', {
      hostPid: hostAfter.value.pid,
      pidUnchanged: hostAfter.value.pid === hostPid,
      workerPidBefore,
      workerPidAfter: hostAfter.value.currentWorkerPid,
      workerCountAfterSettle: settled.workerCount,
      sameHttpSocket: pingAfter.socket === persistentSocket,
      oldWorkerGone: !processAlive(workerPidBefore),
    });
  } finally {
    agent.destroy();
  }

  const parallelAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  try {
    const reloads = await Promise.all([
      request(parallelAgent, 'POST', '/reload-code'),
      request(parallelAgent, 'POST', '/reload-code'),
      request(parallelAgent, 'POST', '/reload-code'),
      request(parallelAgent, 'POST', '/reload-code'),
    ]);
    const versions = reloads.map((entry) => entry.value.logicVersion);
    assert.equal(reloads.every((entry) => entry.statusCode === 200), true, `concurrent reloads must all succeed: ${JSON.stringify(reloads.map((entry) => entry.value))}`);
    assert.equal(new Set(versions).size, 4, 'each serialized reload must produce its own generation');
    assert.equal(reloads.every((entry) => entry.value.pid === reloads[0].value.pid), true);
    for (const entry of reloads) assert.equal(entry.value.previousLogicVersion !== entry.value.logicVersion, true);
    print('V2b concurrent reloads', { versions: [...versions].sort(), hostPidUnchanged: true });

    await pollWorkerCount(1);
    const hostFinal = await request(parallelAgent, 'GET', '/host');
    assert.equal(hostFinal.value.logicVersion, versions.at(-1));
    assert.equal(hostFinal.value.workerCount, 1);
    assert.equal(hostFinal.value.drainingGenerations.length, 0);
    assert.ok(hostFinal.value.lastReload.ok === true);
    print('V2b final', {
      logicVersion: hostFinal.value.logicVersion,
      workerCount: hostFinal.value.workerCount,
      lastReload: hostFinal.value.lastReload,
    });
  } finally {
    parallelAgent.destroy();
  }

  innocentServer = net.createServer((socket) => socket.end('innocent\n'));
  await new Promise((resolve, reject) => {
    innocentServer.once('error', reject);
    innocentServer.listen(otherPort, '127.0.0.1', resolve);
  });

  await assert.rejects(
    runScript('stop.sh', otherPort),
    (error) => {
      assert.match(error.stderr, /refusing to stop pid \d+:/);
      print('V3 foreign-owner refusal', error.stderr.trim());
      return true;
    },
  );
  assert.equal(innocentServer.listening, true);

  const hostBeforeStop = await request(undefined, 'GET', '/host');
  const hostPid = hostBeforeStop.value.pid;
  const workerPid = hostBeforeStop.value.currentWorkerPid;
  const stopped = await runScript('stop.sh');
  started = false;
  print('V3 stop', stopped.stdout.trim());
  assert.equal(await listenerPid(port), 0, 'host released its port');
  assert.equal(innocentServer.listening, true);
  const gone = await (async () => {
    for (let index = 0; index < 100; index += 1) {
      if (!processAlive(workerPid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !processAlive(workerPid);
  })();
  print('V3 no collateral kill', { otherPort, stillListening: innocentServer.listening, workerPid, workerExited: gone });
  assert.ok(gone, 'stopping the host must take its generation workers with it');

  const baseLog = await readFile(logPath, 'utf8').catch(() => '');
  print('base log tail', baseLog.trim().split('\n').slice(-6));
  print('RESULT', 'S0a V1/V2/V3 PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (started) {
    try {
      await runScript('stop.sh');
    } catch (error) {
      process.stderr.write(`cleanup stop failed: ${error.stderr || error.message}\n`);
    }
  }
  if (innocentServer) {
    await new Promise((resolve) => innocentServer.close(resolve));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
