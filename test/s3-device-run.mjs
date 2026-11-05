// S3-2 sandbox: device_run executes one command on a configured remote device.
// Copied home + high ports + a fake `ssh` in front of PATH; the real winbox is never touched.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { finishCleanup, installShellCommand, listenerPid, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's3-device-run-'));
const home = path.join(sandbox, 'home');
const fakeBin = path.join(sandbox, 'fake-bin');
const sshLog = path.join(sandbox, 'ssh.log');
const devicesFile = path.join(home, 'devices.json');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const baseLogPath = path.join(sandbox, 'base.log');
const sleepPidFile = path.join(sandbox, 'sleep.pid');
const runTimeoutMs = process.platform === 'win32' ? 2500 : 400;
const runMaxBytes = 64;
let provider;
let providerPort;
let basePort;
let child;
let log;

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

async function poll(label, operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(40);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

// One tool call, then a final text: enough to prove device_run is reachable as a real
// tool and that its receipt (host annotation included) lands in the session messages.
function startToolProvider() {
  const requests = [];
  const chunk = (delta, finishReason) => ({
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s3-run',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const sawToolResult = (body.messages || []).some((message) => message.role === 'tool');
    if (!sawToolResult) {
      response.write(`data: ${JSON.stringify(chunk({
        tool_calls: [{
          index: 0,
          id: 'call_device_run',
          type: 'function',
          function: { name: 'device_run', arguments: JSON.stringify({ name: 'good', command: 'hostname; pwd' }) },
        }],
      }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(chunk({ content: 'ran the device command' }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function deviceConfig() {
  return {
    good: {
      host: 'good.example',
      user: 'bot',
      mode: 'tools',
      cwdRoot: '/srv/repo',
      repoHints: ['/srv/repo'],
      note: 'successful fake device',
      addedAt: 1000,
      lastProbe: null,
    },
    homedir: {
      host: 'good.example',
      user: 'bot',
      mode: 'tools',
      cwdRoot: '~/code/x',
      addedAt: 1500,
      lastProbe: null,
    },
    ambiguous: {
      host: 'good.example',
      user: 'bot',
      mode: 'tools',
      cwdRoot: '/srv/a',
      repoHints: ['~/b'],
      addedAt: 1750,
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
if [[ "$target" != "bot@good.example" ]]; then
  printf '%s\\n' "unexpected target: $target" >&2
  exit 65
fi
case "$command" in
  *"hostname; pwd")
    printf '%s\\n' 'fake-good' '/srv/repo'
    ;;
  *"make failing")
    printf '%s\\n' 'compiling...'
    printf '%s\\n' 'error: broken' >&2
    exit 2
    ;;
  *"sleep 30")
    printf '%s' "$$" > "${sleepPidFile}"
    exec sleep 30
    ;;
  *"seq 1 500")
    seq 1 500
    ;;
  *"noisy"*)
    printf 'e%.0s' $(seq 1 200) >&2
    ;;
  *)
    printf '%s\\n' "$command"
    ;;
esac
`);

  basePort = await reserveHighPort();
  providerPort = await reserveHighPort();
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-s3-run', name: 'S3 Run Fake', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-s3-run',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  provider = await startToolProvider();
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
      SOPHO_DEFAULT_CWD: sourceRoot,
      SOPHO_DEVICE_RUN_TIMEOUT_MS: String(runTimeoutMs),
      SOPHO_DEVICE_RUN_MAX_BYTES: String(runMaxBytes),
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await waitForHttp();
  assert.equal(Number(await listenerPid(basePort)), child.pid);
  print('sandbox', { home, basePort, fakeBin, runTimeoutMs, runMaxBytes, forbiddenPortsUsed: false });

  await writeFile(devicesFile, `${JSON.stringify(deviceConfig(), null, 2)}\n`);

  // 各臂独立报告：一臂红也要把其余臂跑完（从前的形状里，一条早失败会遮住后面所有覆盖）。
  const { failed } = await runArms([
    ['① 远程 run 成功：远端 stdout 原样带回 + “ran on …” 注解', async () => {
      const success = await api('/devices/good/run', { method: 'POST', body: { command: 'hostname; pwd' } });
      assert.equal(success.statusCode, 200, success.body);
      assert.equal(success.value.name, 'good');
      assert.equal(success.value.target, 'bot@good.example');
      assert.equal(success.value.exitCode, 0);
      assert.equal(success.value.ok, true);
      assert.equal(success.value.stdout, 'fake-good\n/srv/repo\n');
      assert.equal(success.value.stderr, '');
      assert.match(success.value.ranOn, /ran on good\.example \(bot@good\.example\) over ssh/);
      assert.equal(success.value.detachedFromLocalProcessTree, true);
      assert.match(success.value.detachedNotice, /not part of the local process tree/);
      assert.match(success.value.detachedNotice, /interrupt \/ process-tree kill cannot reach it/);
      assert.deepEqual(success.value.cwd, { local: null, remote: '/srv/repo', rule: 'device-default-root' });
      assert.equal(success.value.remoteCommand, "cd '/srv/repo' && hostname; pwd");
      print('remote run succeeds and returns remote stdout', success.value);
      return { exitCode: success.value.exitCode, stdout: success.value.stdout };
    }],

    ['② 非零退出码与 stderr 都保住（不静默算成功）', async () => {
      const failing = await api('/devices/good/run', { method: 'POST', body: { command: 'make failing' } });
      assert.equal(failing.statusCode, 200, failing.body);
      assert.equal(failing.value.exitCode, 2);
      assert.equal(failing.value.ok, false);
      assert.equal(failing.value.stdout, 'compiling...\n');
      assert.equal(failing.value.stderr, 'error: broken\n');
      print('non-zero exit keeps its code and stderr', failing.value);
      return { exitCode: failing.value.exitCode, stderr: failing.value.stderr };
    }],

    ['③ 每次 run 恰好一条 ssh 调用（不重试、不叠加）', async () => {
      const sshCalls = (await readFile(sshLog, 'utf8')).trim().split('\n');
      assert.deepEqual(sshCalls, [
        "bot@good.example\tcd '/srv/repo' && hostname; pwd",
        "bot@good.example\tcd '/srv/repo' && make failing",
      ]);
      print('every run was exactly one ssh invocation', sshCalls);
      return { sshCalls: sshCalls.length };
    }],

    ['④ 超时：报出来、而且真的把 ssh 客户端收掉', async () => {
      const timeoutStarted = Date.now();
      const timedOut = await api('/devices/good/run', { method: 'POST', body: { command: 'sleep 30' } });
      const timeoutElapsedMs = Date.now() - timeoutStarted;
      assert.equal(timedOut.statusCode, 200, timedOut.body);
      assert.equal(timedOut.value.timedOut, true);
      assert.equal(timedOut.value.ok, false);
      assert.equal(timedOut.value.exitCode, null);
      assert.equal(timedOut.value.timeoutMs, runTimeoutMs);
      assert.match(timedOut.value.timedOutNotice, new RegExp(`timed out after ${runTimeoutMs}ms`));
      assert.match(timedOut.value.timedOutNotice, /still be running on good\.example/);
      assert.ok(timeoutElapsedMs < runTimeoutMs + 3000, `device run timeout took ${timeoutElapsedMs}ms`);
      const sleepPid = process.platform === 'win32' ? null : Number(await readFile(sleepPidFile, 'utf8'));
      let sleepAlive = false;
      if (sleepPid) {
        sleepAlive = true;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try { process.kill(sleepPid, 0); } catch { sleepAlive = false; break; }
          await sleep(40);
        }
        assert.equal(sleepAlive, false, `timed-out ssh process ${sleepPid} is still alive`);
      }
      print('timeout terminates the ssh client and is reported, never silent success', {
        elapsedMs: timeoutElapsedMs,
        sleepPid,
        sleepAlive,
        response: timedOut.value,
      });
      return { elapsedMs: timeoutElapsedMs, sleepPid, sleepAlive };
    }],

    ['⑤ stdout 截断：封顶 + 明说收到了多少', async () => {
      const truncated = await api('/devices/good/run', { method: 'POST', body: { command: 'seq 1 500' } });
      assert.equal(truncated.statusCode, 200, truncated.body);
      assert.equal(truncated.value.ok, true, truncated.body);
      assert.equal(truncated.value.truncated.stdout, true);
      assert.equal(truncated.value.truncated.stderr, false);
      assert.equal(Buffer.byteLength(truncated.value.stdout), runMaxBytes);
      assert.ok(truncated.value.stdoutBytes > runMaxBytes, `stdoutBytes=${truncated.value.stdoutBytes}`);
      assert.ok(truncated.value.stdout.startsWith('1\n2\n3\n'));
      assert.match(truncated.value.truncatedNotice, /stdout output truncated at 64 bytes/);
      assert.match(truncated.value.truncatedNotice, /received stdout \d+ bytes/);
      print('output truncation is capped and explicitly reported', {
        stdoutPrefix: JSON.stringify(truncated.value.stdout.slice(0, 12)),
        keptBytes: Buffer.byteLength(truncated.value.stdout),
        receivedBytes: truncated.value.stdoutBytes,
        notice: truncated.value.truncatedNotice,
      });
      return { keptBytes: Buffer.byteLength(truncated.value.stdout), receivedBytes: truncated.value.stdoutBytes };
    }],

    ['⑥ stderr 截断也报（同一条 absorb 路，各自的流）', async () => {
      const noisy = await api('/devices/good/run', { method: 'POST', body: { command: 'noisy' } });
      assert.equal(noisy.statusCode, 200, noisy.body);
      assert.equal(noisy.value.exitCode, 0);
      assert.equal(noisy.value.ok, true);
      assert.equal(noisy.value.truncated.stderr, true);
      assert.equal(noisy.value.truncated.stdout, false);
      assert.equal(Buffer.byteLength(noisy.value.stderr), runMaxBytes);
      assert.ok(noisy.value.stderrBytes > runMaxBytes, `stderrBytes=${noisy.value.stderrBytes}`);
      assert.match(noisy.value.truncatedNotice, /stderr output truncated at 64 bytes/);
      print('stderr truncation is reported too (same absorb path, own stream)', {
        keptBytes: Buffer.byteLength(noisy.value.stderr),
        receivedBytes: noisy.value.stderrBytes,
        notice: noisy.value.truncatedNotice,
      });
      return { keptBytes: Buffer.byteLength(noisy.value.stderr), receivedBytes: noisy.value.stderrBytes };
    }],

    ['⑦ POSIX cwd 映射（镜像的声明根 + 远程 ~ 路径）', async () => {
      if (process.platform === 'win32') {
        print('remote POSIX cwd mapping', { skipped: true, remainingDependency: 'Windows path.resolve rewrites /srv and ~/ remote-only cwd inputs before mapping' });
        return 'SKIP（win32）';
      }
      const mirrored = await api('/devices/good/run', { method: 'POST', body: { command: 'pwd', cwd: '/srv/repo/src' } });
      assert.equal(mirrored.statusCode, 200, mirrored.body);
      assert.equal(mirrored.value.cwd.remote, '/srv/repo/src');
      assert.match(mirrored.value.cwd.rule, /mirrored declared root/);
      assert.equal(mirrored.value.remoteCommand, "cd '/srv/repo/src' && pwd");
      print('local cwd on a mirrored declared root keeps the same remote path', mirrored.value.cwd);

      const homeCwd = await api('/devices/homedir/run', { method: 'POST', body: { command: 'pwd', cwd: '~/code/x/sub' } });
      assert.equal(homeCwd.statusCode, 200, homeCwd.body);
      assert.equal(homeCwd.value.cwd.remote, '~/code/x/sub');
      assert.match(homeCwd.value.cwd.rule, /remote path under declared root/);
      assert.equal(homeCwd.value.remoteCommand, "cd '~/code/x/sub' && pwd");
      print('remote ~ path under a declared root is accepted as-is', homeCwd.value.cwd);
      return { mirrored: mirrored.value.cwd.remote, home: homeCwd.value.cwd.remote };
    }],

    ['⑧ 映射不到的 cwd 在 ssh 之前就被拒（ssh 日志不动）', async () => {
      const beforeUnmapped = (await readFile(sshLog, 'utf8')).trim().split('\n').length;
      const unmapped = await api('/devices/good/run', { method: 'POST', body: { command: 'rm -rf /', cwd: '/tmp/elsewhere' } });
      assert.equal(unmapped.statusCode, 400, unmapped.body);
      assert.equal(unmapped.value.error, 'cwd_not_mapped');
      assert.match(unmapped.value.message, /refusing to guess a remote path/);
      const afterUnmapped = (await readFile(sshLog, 'utf8')).trim().split('\n').length;
      assert.equal(afterUnmapped, beforeUnmapped, 'unmappable cwd must not reach ssh at all');
      print('unmappable cwd is refused before ssh runs anything', { response: unmapped.value, sshCallsUnchanged: true });
      return { status: unmapped.statusCode, error: unmapped.value.error };
    }],

    ['⑨ 声明根之外的远程路径 / 歧义的本地路径都拒', async () => {
      const remoteOutsideRoot = await api('/devices/good/run', { method: 'POST', body: { command: 'pwd', cwd: '~/elsewhere' } });
      assert.equal(remoteOutsideRoot.statusCode, 400, remoteOutsideRoot.body);
      assert.equal(remoteOutsideRoot.value.error, 'cwd_not_mapped');
      assert.match(remoteOutsideRoot.value.message, /pass a path under a declared root/);
      const ambiguous = await api('/devices/ambiguous/run', { method: 'POST', body: { command: 'pwd', cwd: path.join(sourceRoot, 'server') } });
      assert.equal(ambiguous.statusCode, 400, ambiguous.body);
      assert.equal(ambiguous.value.error, 'cwd_not_mapped');
      assert.match(ambiguous.value.message, process.platform === 'win32' ? /declares roots/ : /needs exactly one declared root/);
      print('a remote path outside the roots and an ambiguous local path are both refused', {
        remoteOutsideRoot: remoteOutsideRoot.value.message,
        ambiguous: ambiguous.value.message,
      });
      return { remoteOutsideRoot: remoteOutsideRoot.value.error, ambiguous: ambiguous.value.error };
    }],

    ['⑩ 未知设备 404；body 里夹带的 host/target 一律不用', async () => {
      const unknownDevice = await api('/devices/ghost/run', { method: 'POST', body: { command: 'hostname' } });
      assert.equal(unknownDevice.statusCode, 404, unknownDevice.body);
      assert.equal(unknownDevice.value.error, 'device_not_found');
      const smuggled = await api('/devices/good/run', { method: 'POST', body: { command: 'hostname; pwd', host: 'evil.example', target: 'evil.example' } });
      assert.equal(smuggled.statusCode, 200, smuggled.body);
      assert.equal(smuggled.value.target, 'bot@good.example');
      assert.equal(smuggled.value.host, 'good.example');
      const afterSmuggle = await readFile(sshLog, 'utf8');
      assert.doesNotMatch(afterSmuggle, /evil\.example/);
      print('unknown device is 404 and a body-supplied host is ignored, never used', {
        unknownDevice: unknownDevice.value.message,
        smuggledTarget: smuggled.value.target,
        sshSawEvilHost: false,
      });
      return { unknownDevice: unknownDevice.statusCode, smuggledTarget: smuggled.value.target };
    }],

    ['⑪ devices.json 里的非法 host：ssh 之前就拒，且原文件不改写', async () => {
      const unsafeConfigText = `${JSON.stringify({ unsafe: { host: 'bad host; touch /tmp/no', mode: 'tools', addedAt: 4000, lastProbe: null } }, null, 2)}\n`;
      const goodConfigText = await readFile(devicesFile, 'utf8');
      await writeFile(devicesFile, unsafeConfigText);
      try {
        const unsafeHost = await api('/devices/unsafe/run', { method: 'POST', body: { command: 'hostname' } });
        assert.equal(unsafeHost.statusCode, 500, unsafeHost.body);
        assert.equal(unsafeHost.value.error, 'devices-config-invalid');
        assert.match(unsafeHost.value.message, /host must match/);
        assert.equal(await readFile(devicesFile, 'utf8'), unsafeConfigText, 'invalid host config must not be rewritten');
        assert.doesNotMatch(await readFile(sshLog, 'utf8'), /bad host/);
        print('an invalid host in devices.json is refused before ssh and left untouched', { response: unsafeHost.value, sshReceivedUnsafeHost: false });
        return { status: unsafeHost.statusCode, error: unsafeHost.value.error };
      } finally {
        await writeFile(devicesFile, goodConfigText);
      }
    }],

    ['⑫ 插件 device_run 工具（描述口径 + 真跑一次）', async () => {
      const pluginPath = path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts');
      const loaded = await discoverAndLoadExtensions([pluginPath], sourceRoot, home);
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      assert.ok(extension.tools.has('device_run'), 'missing device_run tool');
      const runDescription = extension.tools.get('device_run').definition.description;
      assert.match(runDescription, /remote shell/);
      assert.match(runDescription, /not part of the local process tree/);
      assert.match(runDescription, /interrupt \/ process-tree kill cannot reach it/);
      assert.match(runDescription, /ssh target comes from devices\.json only/);
      assert.match(runDescription, /reports a timeout or an output truncation explicitly/);
      assert.match(runDescription, /never guessed/);
      const previousPort = process.env.SOPHO_PORT;
      process.env.SOPHO_PORT = String(basePort);
      try {
        const toolRun = await extension.tools.get('device_run').definition.execute('run', { name: 'good', command: 'hostname; pwd' }, undefined, undefined, undefined);
        assert.equal(toolRun.details.exitCode, 0);
        assert.equal(toolRun.details.stdout, 'fake-good\n/srv/repo\n');
        print('plugin device_run tool', { description: extension.tools.get('device_run').definition.description, details: toolRun.details });
        return { exitCode: toolRun.details.exitCode };
      } finally {
        if (previousPort === undefined) delete process.env.SOPHO_PORT;
        else process.env.SOPHO_PORT = previousPort;
      }
    }],

    ['⑬ 模型驱动的工具调用：带主机注解的回执落到会话消息里（webui 看见的那份）', async () => {
      const sessionResponse = await api('/sessions', { method: 'POST', body: { cwd: sourceRoot, name: 'Device Run' } });
      assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
      const sessionId = sessionResponse.value.id;
      const sent = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'which machine did it run on?' } });
      assert.equal(sent.statusCode, 202, sent.body);
      const settled = await poll('session idle', () => api(`/sessions/${sessionId}`), (response) => response.statusCode === 200
        && !response.value.runtime?.isStreaming
        && !response.value.runtime?.isCompacting
        && !response.value.runtime?.isRetrying);
      assert.equal(settled.value.runtime?.isStreaming, false);
      const payload = (await api(`/sessions/${sessionId}/messages`)).value;
      const toolMessage = payload.messages.find((message) => message.toolName === 'device_run');
      assert.ok(toolMessage, JSON.stringify(payload.messages.map((message) => [message.role, message.toolName])));
      assert.match(toolMessage.text, /ran on good\.example \(bot@good\.example\) over ssh/);
      assert.match(toolMessage.text, /not part of the local process tree/);
      assert.match(toolMessage.text, /fake-good/);
      const finalAssistant = payload.messages.filter((message) => message.role === 'assistant').at(-1);
      assert.match(finalAssistant.text, /ran the device command/);
      const frontend = await readFile(path.join(sourceRoot, 'web', 'app.js'), 'utf8');
      const renderer = await readFile(path.join(sourceRoot, 'web', 'render.js'), 'utf8');
      // 意图断言（不是字面量）：webui 拉正文那条请求「打到 /messages，且带着尾部增量查询串」。
      // 为什么不钉字面量：df0dae7（09-19 12:28「大会话每回合只拉尾部增量」）把这条 URL 从
      //   `await api(`/sessions/${id}/messages`)` 改成 `await api(`/sessions/${id}/messages${query}`)`，
      // 上游那条 `/\/messages`\)/` 匹配的是**改前**的源码文本 ⇒ 它变红不是产品回归，是断言陈旧。
      // 现在改为**真去渲染**那条 URL 模板（把它的 `${...}` 插值填上代表值），核两件事：
      //   ① 请求打到 `/messages` —— 页面拉正文的唯一入口（上面那份 payload 里就带着这条 device_run
      //      回执，所以「webui 会看见它」这句话才成立）；
      //   ② 尾部增量查询串是**原样追加**在路径后的：无游标 ⇒ URL 逐字等于改前那份（客户端这边不动
      //      服务端的缺省整份行为），有游标 ⇒ `?after=<entryId>` 真的落到 URL 上（增量那条路活着）。
      const messagesFetch = frontend.match(/api\(\s*`([^`]*\/messages\$\{[^`]*)`/);
      assert.ok(messagesFetch, 'web/app.js must GET session messages from the /messages endpoint');
      const renderMessagesUrl = (values) => messagesFetch[1].replace(/\$\{([^}]*)\}/g, (_, expression) => values[expression]);
      assert.equal(renderMessagesUrl({ id: 's-1', query: '' }), '/sessions/s-1/messages');
      assert.equal(renderMessagesUrl({ id: 's-1', query: '?after=entry-7' }), '/sessions/s-1/messages?after=entry-7');
      // 那个被追加的 `query` 必须是「尾部增量游标」本身：只在有游标时才是 `?after=<最后一条已定稿
      // 消息的 entryId>`、否则空串（⇒ 客户端走「整份」那条老路）。
      const tailQuery = frontend.split('\n').find((line) => line.includes('const query =') && line.includes('after='));
      assert.ok(tailQuery, 'web/app.js must build the /messages tail cursor query');
      assert.match(tailQuery, /base \?/, 'the cursor query must be optional (no cursor => no query parameter)');
      assert.match(tailQuery, /: ''/, "the no-cursor branch must be an empty string, keeping the full-fetch default");
      assert.match(tailQuery, /\?after=\$\{encodeURIComponent\(base\.cursor\.entryId\)\}/, 'the cursor query must be ?after=<last known entryId>');
      assert.match(renderer, /item\.text/);
      assert.equal(provider.requests.some((body) => (body.messages || []).some((message) => message.role === 'tool')), true);
      print('model-driven tool call: receipt with the host annotation reaches session messages (what the webui renders)', {
        providerRequests: provider.requests.length,
        toolMessage: { toolName: toolMessage.toolName, isError: toolMessage.isError, text: toolMessage.text },
        finalAssistant: finalAssistant.text,
        webuiSourceSeesMessages: true,
        webuiMessagesRequest: {
          withoutCursor: renderMessagesUrl({ id: '<id>', query: '' }),
          withCursor: renderMessagesUrl({ id: '<id>', query: '?after=<cursor>' }),
        },
      });
      return { providerRequests: provider.requests.length, toolName: toolMessage.toolName };
    }],
  ], { title: 's3-device-run' });
  print('RESULT', failed.length === 0 ? 'S3 device_run PASS' : `S3 device_run FAIL（${failed.length} 臂红）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(child, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (provider?.server) {
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
  if (log) await log.close();
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  const output = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (output.trim()) print('base log', output.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
