import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { finishCleanup, installShellCommand, listenerPid, removeSandbox, stopSpawnedListener } from './harness.mjs';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's3-devices-'));
const home = path.join(sandbox, 'home');
const fakeBin = path.join(sandbox, 'fake-bin');
const sshLog = path.join(sandbox, 'ssh.log');
const devicesFile = path.join(home, 'devices.json');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const baseLogPath = path.join(sandbox, 'base.log');
let basePort;
let child;
let log;
const probeTimeoutMs = process.platform === 'win32' ? 2500 : 250;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveHighPort() {
  for (let candidate = 48000 + Math.floor(Math.random() * 12000); candidate < 64000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
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

async function waitForHttp() {
  let lastError;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await api('/host');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(40);
  }
  throw lastError ?? new Error('base did not become ready');
}

function deviceConfig() {
  return {
    good: {
      host: 'good.example',
      user: 'bot',
      mode: 'tools',
      repoHints: ['/srv/repo'],
      note: 'successful fake device',
      addedAt: 1000,
      lastProbe: null,
    },
    down: {
      host: 'down.example',
      mode: 'session',
      cwdRoot: '/srv/down-repo',
      addedAt: 2000,
      lastProbe: null,
    },
    slow: {
      host: 'slow.example',
      mode: 'tools',
      addedAt: 3000,
      lastProbe: null,
    },
  };
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeSsh = await installShellCommand(fakeBin, 'ssh', `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "--" ]]; then shift; fi
target="\${1:-}"
command="\${2:-}"
printf '%s\\t%s\\n' "$target" "$command" >> "${sshLog}"
case "$target" in
  bot@good.example)
    case "$command" in
      "uname -a") printf '%s\\n' 'Linux fake-good 6.8.0 #1 SMP' ;;
      *"rev-parse --show-toplevel") printf '%s\\n' '/srv/repo' ;;
      *"branch --show-current") printf '%s\\n' 'main' ;;
      *"status --porcelain") printf '%s\\n' ' M tracked.txt' ;;
      *) printf '%s\\n' "unexpected command: $command" >&2; exit 64 ;;
    esac
    ;;
  down.example)
    printf '%s\\n' 'ssh: connect to host down.example port 22: Connection refused' >&2
    exit 255
    ;;
  slow.example)
    exec sleep 30
    ;;
  *)
    printf '%s\\n' "unexpected target: $target" >&2
    exit 65
    ;;
esac
`);

  basePort = await reserveHighPort();
  log = await open(baseLogPath, 'w');
  child = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
      PI_OFFLINE: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEVICE_PROBE_TIMEOUT_MS: String(probeTimeoutMs),
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await waitForHttp();
  assert.equal(Number(await listenerPid(basePort)), child.pid);
  print('sandbox', { home, basePort, fakeBin, probeTimeoutMs, forbiddenPortsUsed: false });

  const missing = await api('/devices');
  assert.equal(missing.statusCode, 200, missing.body);
  assert.deepEqual(missing.value, { devices: [], exists: false, error: null });
  print('missing devices.json', missing.value);

  await writeFile(devicesFile, `${JSON.stringify(deviceConfig(), null, 2)}\n`);
  const listed = await api('/devices');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.value.exists, true);
  assert.equal(listed.value.error, null);
  assert.deepEqual(listed.value.devices.map((device) => device.name), ['down', 'good', 'slow']);
  assert.equal(listed.value.devices.find((device) => device.name === 'good').lastProbe, null);
  print('device list', listed.value);

  const success = await api('/devices/good/probe', { method: 'POST', body: {} });
  print('successful probe raw', success.value);
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(success.value.ok, true);
  assert.equal(success.value.name, 'good');
  assert.equal(success.value.target, 'bot@good.example');
  assert.equal(success.value.uname, 'Linux fake-good 6.8.0 #1 SMP');
  assert.deepEqual(success.value.git, { repo: '/srv/repo', branch: 'main', dirty: true });
  const afterSuccess = JSON.parse(await readFile(devicesFile, 'utf8'));
  assert.equal(afterSuccess.good.lastProbe.ok, true);
  assert.equal(afterSuccess.good.lastProbe.uname, success.value.uname);
  assert.equal(afterSuccess.good.lastProbe.error, null);
  assert.equal(Number.isInteger(afterSuccess.good.lastProbe.at), true);
  assert.deepEqual((await readdir(home)).filter((name) => name.startsWith('.devices.json.')), []);
  print('successful probe and persisted lastProbe', { response: success.value, persisted: afterSuccess.good.lastProbe });

  const failed = await api('/devices/down/probe', { method: 'POST', body: {} });
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.name, 'down');
  assert.match(failed.value.error, /device down \(down\.example\)/);
  assert.match(failed.value.error, /Connection refused/);
  const afterFailure = JSON.parse(await readFile(devicesFile, 'utf8'));
  assert.equal(afterFailure.down.lastProbe.ok, false);
  assert.match(afterFailure.down.lastProbe.error, /down\.example/);
  print('failed probe is named and persisted', { response: failed.value, persisted: afterFailure.down.lastProbe });

  const timeoutStarted = Date.now();
  const timedOut = await api('/devices/slow/probe', { method: 'POST', body: {} });
  const timeoutElapsedMs = Date.now() - timeoutStarted;
  assert.equal(timedOut.statusCode, 200, timedOut.body);
  assert.equal(timedOut.value.ok, false);
  assert.equal(timedOut.value.name, 'slow');
  assert.match(timedOut.value.error, new RegExp(`timed out after ${probeTimeoutMs}ms`));
  assert.ok(timeoutElapsedMs < probeTimeoutMs + 3000, `fake ssh timeout took ${timeoutElapsedMs}ms`);
  const afterTimeout = JSON.parse(await readFile(devicesFile, 'utf8'));
  assert.equal(afterTimeout.slow.lastProbe.ok, false);
  assert.match(afterTimeout.slow.lastProbe.error, /timed out/);
  print('timeout is honest and persisted', { elapsedMs: timeoutElapsedMs, response: timedOut.value, persisted: afterTimeout.slow.lastProbe });

  const [concurrentGood, concurrentDown] = await Promise.all([
    api('/devices/good/probe', { method: 'POST', body: {} }),
    api('/devices/down/probe', { method: 'POST', body: {} }),
  ]);
  assert.equal(concurrentGood.value.ok, true, concurrentGood.body);
  assert.equal(concurrentDown.value.ok, false, concurrentDown.body);
  const afterConcurrent = JSON.parse(await readFile(devicesFile, 'utf8'));
  assert.equal(afterConcurrent.good.lastProbe.ok, true);
  assert.equal(afterConcurrent.down.lastProbe.ok, false);
  print('probe writes are serialized without lost lastProbe', {
    goodAt: afterConcurrent.good.lastProbe.at,
    downAt: afterConcurrent.down.lastProbe.at,
    bothPresent: true,
  });

  const missingName = await api('/devices/not-there/probe', { method: 'POST', body: {} });
  assert.equal(missingName.statusCode, 404, missingName.body);
  assert.equal(missingName.value.error, 'device_not_found');
  assert.match(missingName.value.message, /not-there/);
  print('missing named device is distinct from connection failure', missingName.value);

  const pluginPath = path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts');
  const loaded = await discoverAndLoadExtensions([pluginPath], sourceRoot, home);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  for (const name of ['device_list', 'device_probe']) assert.ok(extension.tools.has(name), `missing ${name} tool`);
  assert.ok(extension.commands.has('device'), 'missing /device command');
  assert.match(extension.tools.get('device_probe').definition.description, /git\.repo/);
  const previousPort = process.env.SOPHO_PORT;
  process.env.SOPHO_PORT = String(basePort);
  try {
    const toolProbe = await extension.tools.get('device_probe').definition.execute('probe', { name: 'good' }, undefined, undefined, undefined);
    assert.equal(toolProbe.details.ok, true);
    assert.deepEqual(toolProbe.details.git, { repo: '/srv/repo', branch: 'main', dirty: true });
    const toolList = await extension.tools.get('device_list').definition.execute('list', {}, undefined, undefined, undefined);
    assert.equal(toolList.details.devices.length, 3);
    assert.deepEqual(toolList.details.probes.map((probe) => [probe.name, probe.ok]), [['down', false], ['good', true], ['slow', false]]);
    assert.match(toolList.details.probes.find((probe) => probe.name === 'down').error, /Connection refused/);
    const notifications = [];
    await extension.commands.get('device').handler('', { ui: { notify: (message, level) => notifications.push({ message, level }) } });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /good: ok/);
    print('plugin tools and /device command', {
      tools: [...extension.tools.keys()].filter((name) => name.startsWith('device_')),
      commands: [...extension.commands.keys()].filter((name) => name === 'device'),
      probe: toolProbe.details,
      listProbeSummary: toolList.details.probes.map((probe) => ({ name: probe.name, ok: probe.ok, error: probe.error })),
      commandNotification: notifications[0],
    });
  } finally {
    if (previousPort === undefined) delete process.env.SOPHO_PORT;
    else process.env.SOPHO_PORT = previousPort;
  }

  const invalidJson = '{\n  "good": {\n';
  await writeFile(devicesFile, invalidJson);
  const badList = await api('/devices');
  assert.equal(badList.statusCode, 500, badList.body);
  assert.equal(badList.value.exists, true);
  assert.equal(badList.value.error.code, 'devices-config-invalid');
  assert.match(badList.value.message, /line 3/);
  const badProbe = await api('/devices/good/probe', { method: 'POST', body: {} });
  assert.equal(badProbe.statusCode, 500, badProbe.body);
  assert.equal(badProbe.value.error, 'devices-config-invalid');
  assert.equal(await readFile(devicesFile, 'utf8'), invalidJson, 'invalid JSON must not be overwritten');
  print('invalid JSON is loud and preserved', { list: badList.value, probe: badProbe.value, bytesPreserved: true });

  const invalidHostConfig = {
    unsafe: {
      host: 'bad host; touch /tmp/no',
      mode: 'tools',
      addedAt: 4000,
      lastProbe: null,
    },
  };
  const invalidHostText = `${JSON.stringify(invalidHostConfig, null, 2)}\n`;
  await writeFile(devicesFile, invalidHostText);
  const invalidHost = await api('/devices/unsafe/probe', { method: 'POST', body: {} });
  assert.equal(invalidHost.statusCode, 500, invalidHost.body);
  assert.equal(invalidHost.value.error, 'devices-config-invalid');
  assert.match(invalidHost.value.message, /host must match/);
  assert.equal(await readFile(devicesFile, 'utf8'), invalidHostText, 'invalid host config must not be rewritten');
  const sshCalls = await readFile(sshLog, 'utf8');
  assert.doesNotMatch(sshCalls, /bad host/);
  print('invalid host refused before ssh/write', { response: invalidHost.value, bytesPreserved: true, sshReceivedUnsafeHost: false });

  await unlink(devicesFile);
  const missingAgain = await api('/devices');
  assert.equal(missingAgain.statusCode, 200, missingAgain.body);
  assert.equal(missingAgain.value.exists, false);
  assert.equal(missingAgain.value.error, null);
  print('missing versus invalid remains distinct', { invalidStatus: badList.statusCode, invalidError: badList.value.error, missingStatus: missingAgain.statusCode, missing: missingAgain.value });

  const frontend = await readFile(path.join(sourceRoot, 'web', 'app.js'), 'utf8');
  const page = await readFile(path.join(sourceRoot, 'web', 'index.html'), 'utf8');
  assert.match(frontend, /api\('\/devices'\)/);
  assert.match(frontend, /lastProbe/);
  assert.match(page, /id="devices"/);
  print('minimal frontend visibility', { endpoint: '/api/devices', showsLastProbe: true });

  print('RESULT', 'S3 devices PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(child, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (log) await log.close();
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  const output = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (output.trim()) print('base log', output.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
