import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, processCommandLine, removeSandbox, stopOwnedListener } from './harness.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powershellExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

// A fresh worktree usually has no node_modules of its own (the host only installs
// the main tree). `test/win-serve.mjs` already links the main tree's copy on
// Windows; do the same here, *before* importing the pi packages, so `npm run
// test:s0b` can start from any worktree instead of dying on ERR_MODULE_NOT_FOUND.
const nodeModulesPath = path.join(sourceRoot, 'node_modules');
let madeNodeModulesLink = false;
if (process.platform === 'win32') {
  let hasLocalModules = true;
  try { await stat(nodeModulesPath); } catch { hasLocalModules = false; }
  if (!hasLocalModules) {
    const commonDir = execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const mainModules = path.join(path.dirname(path.resolve(sourceRoot, commonDir)), 'node_modules');
    try { await stat(mainModules); } catch {
      throw new Error(`no node_modules in this worktree (${nodeModulesPath}) and none to link at ${mainModules}; run npm ci here first`);
    }
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', nodeModulesPath, mainModules], { stdio: 'pipe' });
    madeNodeModulesLink = true;
    process.stdout.write(`node_modules: linked ${nodeModulesPath} -> ${mainModules} (worktree had none)\n`);
  }
}

// Loaded dynamically, after the node_modules fallback above: a static import would
// fail in a bare worktree before that fallback could run.
const { DefaultResourceLoader, discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');

const sandbox = await mkdtemp(path.join(os.tmpdir(), 's0b-proxy-'));
const sandboxRoot = path.join(sandbox, 'repo');
const sandboxHome = path.join(sandbox, 'home');
const sandboxTemp = path.join(sandbox, 'temp');
const appLogPath = path.join(sandbox, 'direct-app.log');
const scriptBaseLogPath = path.join(sandbox, 'script-base.log');
const scriptBaseErrLogPath = path.join(sandbox, 'script-base.err.log');
const scriptAppLogPath = path.join(sandbox, 'script-app.log');
const scriptAppErrLogPath = path.join(sandbox, 'script-app.err.log');
const appEntry = path.join(sandboxRoot, 'server', 'app.mjs');
let directApp;
let directAppLog;
let directAppPort;
let upstreamPort;
let scriptBasePort;
let scriptAppPort;
let scriptStarted = false;
let scriptPairAttempted = false;
let upstreamServer;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// The sandbox must not inherit the ambient instance's config: a leaked SOPHO_CWD
// would point the sandbox servers at the real repository, ASSIST_HOME /
// SOPHO_AGENT_DIR / PI_CODING_AGENT_DIR at the real profile, and the SOPHO_*_LOG
// paths at the live logs (a running base holds an fd on those, so writing there
// truncates them). Drop every SOPHO_/ASSIST_/PI_ variable; pin each one the
// sandbox needs explicitly.
function sandboxProcessEnv(overrides = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(SOPHO_|ASSIST_|PI_)/.test(key)),
  );
  return { ...inherited, HOME: sandboxHome, ...overrides };
}

function idFile(port) {
  return path.join(sandboxTemp, `sopho-pi-${port}.pid`);
}

async function readPidFile(port) {
  try {
    return Number((await readFile(idFile(port), 'utf8')).trim()) || undefined;
  } catch {
    return undefined;
  }
}

async function runPowerShell(script, args, env, { echo = false } = {}) {
  const result = await new Promise((resolve, reject) => {
    execFile(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], {
      cwd: sandboxRoot,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      // A non-zero exit is a result the caller decides about; anything else
      // (no powershell.exe, timeout, E2BIG...) is a hard failure here.
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout, stderr, status: error ? error.code : 0 });
    });
  });
  if (echo) print(`${path.basename(script)}`, `${result.stdout}${result.stderr}`.trim() || '(no output)');
  return result;
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 42000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

function requestHttp(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers,
    });
    request.once('error', reject);
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.end();
  });
}

async function waitForHttp(port, pathname) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return await requestHttp(port, pathname);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error(`port ${port} did not become ready`);
}

// Windows start/stop goes through the shipped native entry points
// (bin/serve-win.ps1 / bin/stop-win.ps1, G-01) rather than a launcher re-invented
// here: the gate then drives the same port -> pid -> pidfile -> cmdline path the
// deployment uses, and the entry cleans up its own partially started pair.
// The POSIX branch still drives bin/serve.sh / bin/stop.sh, unchanged.
function windowsEntryEnv(extra = {}) {
  return sandboxProcessEnv({
    TEMP: sandboxTemp,
    TMP: sandboxTemp,
    ASSIST_HOME: sandboxHome,
    SOPHO_AGENT_DIR: sandboxHome,
    PI_CODING_AGENT_DIR: sandboxHome,
    PI_OFFLINE: '1',
    SOPHO_CWD: sandboxRoot,
    SOPHO_HOST: '127.0.0.1',
    SOPHO_APP_HOST: '127.0.0.1',
    SOPHO_WEB_ROOT: path.join(sandboxRoot, 'web'),
    SOPHO_LOG: scriptBaseLogPath,
    SOPHO_ERR_LOG: scriptBaseErrLogPath,
    SOPHO_APP_LOG: scriptAppLogPath,
    SOPHO_APP_ERR_LOG: scriptAppErrLogPath,
    ...extra,
  });
}

async function serveWindowsPair() {
  scriptPairAttempted = true;
  const started = await runPowerShell(
    path.join(sandboxRoot, 'bin', 'serve-win.ps1'),
    ['-Port', scriptBasePort, '-AppPort', scriptAppPort, '-BindHost', '127.0.0.1', '-AppHost', '127.0.0.1'],
    windowsEntryEnv(),
    { echo: true },
  );
  assert.equal(started.status, 0, `serve-win.ps1 exited ${started.status}: ${`${started.stdout}${started.stderr}`.trim()}`);
  // From here on A+B are up, so a failed check below must still try to stop them.
  scriptStarted = true;

  // "listening" is not proof: the pid the port reports, the pid written to the
  // pidfile, and the pid the entry point claims must be the same process, and its
  // command line must be the sandbox entry we asked for.
  const basePidFile = await readPidFile(scriptBasePort);
  const appPidFile = await readPidFile(scriptAppPort);
  const baseListener = Number(await listenerPid(scriptBasePort)) || undefined;
  const appListener = Number(await listenerPid(scriptAppPort)) || undefined;
  print('A+B listener identity (Windows native entry)', { basePidFile, baseListener, appPidFile, appListener });
  assert.ok(baseListener, 'A must have a listener on its port');
  assert.ok(appListener, 'B must have a listener on its port');
  assert.equal(basePidFile, baseListener, 'A pidfile must equal the A listener pid');
  assert.equal(appPidFile, appListener, 'B pidfile must equal the B listener pid');
  assert.ok((await processCommandLine(baseListener)).includes(path.join(sandboxRoot, 'server', 'base.mjs')), 'A listener must be the sandbox base.mjs');
  assert.ok((await processCommandLine(appListener)).includes(path.join(sandboxRoot, 'server', 'app.mjs')), 'B listener must be the sandbox app.mjs');

  const host = JSON.parse((await waitForHttp(scriptBasePort, '/host')).body);
  const app = JSON.parse((await waitForHttp(scriptAppPort, '/app-host')).body);
  assert.equal(host.pid, baseListener, '/host pid must be the A listener pid');
  assert.equal(app.pid, appListener, '/app-host pid must be the B listener pid');
  return { stdout: `started pid=${host.pid} logicVersion=${host.logicVersion} startedAt=${host.startedAt} appPid=${app.pid} appVersion=${app.codeVersion}` };
}

async function killVerifiedListenerTree(port, entry) {
  const owner = Number(await listenerPid(port)) || undefined;
  if (!owner) return;
  const cmdline = await processCommandLine(owner);
  assert.ok(cmdline.includes(entry), `refusing to kill pid ${owner}: its command line is not ${entry}`);
  // taskkill /T: the verified A root owns the generation workers, and only this
  // exact tree may go — never a process-name scan.
  await execFileAsync('taskkill.exe', ['/PID', String(owner), '/T', '/F']);
}

async function stopWindowsPair() {
  const stopped = await runPowerShell(
    path.join(sandboxRoot, 'bin', 'stop-win.ps1'),
    ['-Port', scriptBasePort, '-AppPort', scriptAppPort],
    windowsEntryEnv(),
  );
  assert.equal(stopped.status, 0, `stop-win.ps1 exited ${stopped.status}: ${`${stopped.stdout}${stopped.stderr}`.trim()}`);
  assert.equal(await listenerPid(scriptBasePort), 0, 'A must release its port');
  assert.equal(await listenerPid(scriptAppPort), 0, 'B must release its port');
  return { stdout: stopped.stdout.trim() };
}

async function runScript(name) {
  if (process.platform === 'win32') {
    if (name === 'serve.sh') return serveWindowsPair();
    if (name === 'stop.sh') return stopWindowsPair();
  }
  return execFileAsync('bash', [path.join(sandboxRoot, 'bin', name)], {
    cwd: sandboxRoot,
    env: sandboxProcessEnv({
      ASSIST_HOME: sandboxHome,
      SOPHO_AGENT_DIR: sandboxHome,
      PI_CODING_AGENT_DIR: sandboxHome,
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(scriptBasePort),
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(scriptAppPort),
      SOPHO_LOG: scriptBaseLogPath,
      SOPHO_APP_LOG: scriptAppLogPath,
    }),
  });
}

function cacheProbeSource(version) {
  return `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "cache_probe",
    label: "Cache Probe",
    description: "Report probe version",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: ${JSON.stringify(version)} }], details: { version: ${JSON.stringify(version)} } };
    },
  });
}
`;
}

async function loadedToolVersion(extensionsResult, toolName) {
  const tool = extensionsResult.extensions[0]?.tools.get(toolName)?.definition;
  assert.ok(tool, `missing tool ${toolName}`);
  const result = await tool.execute('probe', {}, undefined, undefined, undefined);
  return result.details.version;
}

function makeProbeLoader(cwd, pluginPath, agentDir) {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [pluginPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

async function reloadProbeVersion(loader) {
  await loader.reload();
  return loadedToolVersion(loader.getExtensions(), 'cache_probe');
}

let primaryError;
try {
  await mkdir(sandboxRoot, { recursive: true });
  await mkdir(sandboxHome, { recursive: true });
  await mkdir(sandboxTemp, { recursive: true });
  for (const directory of ['server', 'bin', 'web', 'pi-extensions']) {
    await cp(path.join(sourceRoot, directory), path.join(sandboxRoot, directory), { recursive: true });
  }
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(sandboxRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  const usedPorts = new Set();
  directAppPort = await reserveHighPort(usedPorts); usedPorts.add(directAppPort);
  upstreamPort = await reserveHighPort(usedPorts); usedPorts.add(upstreamPort);
  scriptBasePort = await reserveHighPort(usedPorts); usedPorts.add(scriptBasePort);
  scriptAppPort = await reserveHighPort(usedPorts); usedPorts.add(scriptAppPort);
  print('sandbox', {
    root: sandboxRoot,
    home: sandboxHome,
    directAppPort,
    upstreamPort,
    scriptBasePort,
    scriptAppPort,
  });

  const served = await runScript('serve.sh');
  scriptStarted = true;
  print('A+B serve proof', served.stdout.trim());
  // S1b: the logic layer lives in a generation worker, so the version is the
  // generation id the host assigned (not the old in-process `source#sequence`).
  const pinnedGeneration = served.stdout.match(/logicVersion=([^ ]+)/)?.[1];
  assert.match(served.stdout, /started pid=\d+ logicVersion=g-[\d-]+ .* appPid=\d+/);
  assert.match(pinnedGeneration, /^g-[\d-]+$/);
  print('serve proof pinned', { generationId: pinnedGeneration });

  const pageFromScripts = await requestHttp(scriptAppPort, '/');
  assert.equal(pageFromScripts.statusCode, 200);
  assert.match(pageFromScripts.body, /<title>sopho-pi · 会话<\/title>/);
  assert.match(pageFromScripts.body, /class="tree-nav"/);
  const frontendJs = await requestHttp(scriptAppPort, '/app.js');
  assert.equal(frontendJs.statusCode, 200);
  assert.match(frontendJs.body, /fetch\('\/api\/host'/);
  const mentionsModule = await requestHttp(scriptAppPort, '/mentions.mjs');
  assert.equal(mentionsModule.statusCode, 200);
  assert.match(String(mentionsModule.headers['content-type']), /^text\/javascript/);
  assert.match(mentionsModule.body, /export function mountMentions/);
  const proxiedHost = await requestHttp(scriptAppPort, '/api/host');
  assert.equal(proxiedHost.statusCode, 200);
  const proxiedHostValue = JSON.parse(proxiedHost.body);
  assert.equal(typeof proxiedHostValue.pid, 'number');
  assert.equal(proxiedHostValue.logicVersion, pinnedGeneration, 'the proxied /host reports the same generation that serve.sh pinned');
  print('A+B page/proxy', {
    pageStatus: pageFromScripts.statusCode,
    frontendCalls: '/api/host',
    hostPid: proxiedHostValue.pid,
    logicVersion: proxiedHostValue.logicVersion,
  });

  const stopped = await runScript('stop.sh');
  scriptStarted = false;
  print('A+B stop proof', stopped.stdout.trim());
  assert.equal(await listenerPid(scriptBasePort), 0);
  assert.equal(await listenerPid(scriptAppPort), 0);

  let lastUpstreamPath;
  let slowStartedResolve;
  let slowClosedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  const slowClosed = new Promise((resolve) => { slowClosedResolve = resolve; });
  upstreamServer = http.createServer((request, response) => {
    lastUpstreamPath = request.url;
    if (request.url?.startsWith('/host')) {
      const body = `${JSON.stringify({ source: 'fake-A', path: request.url })}\n`;
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (request.url === '/slow') {
      let finished = false;
      response.once('finish', () => { finished = true; });
      request.socket.once('close', () => slowClosedResolve({ finished }));
      slowStartedResolve();
      setTimeout(() => {
        if (!response.destroyed) response.end('too late');
      }, 10_000).unref();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(upstreamPort, '127.0.0.1', resolve);
  });

  directAppLog = await open(appLogPath, 'w');
  directApp = spawn(process.execPath, [appEntry], {
    cwd: sandboxRoot,
    env: sandboxProcessEnv({
      ASSIST_HOME: sandboxHome,
      SOPHO_AGENT_DIR: sandboxHome,
      PI_CODING_AGENT_DIR: sandboxHome,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(directAppPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(upstreamPort),
      SOPHO_WEB_ROOT: path.join(sandboxRoot, 'web'),
    }),
    stdio: ['ignore', directAppLog.fd, directAppLog.fd],
  });
  directApp.once('error', (error) => { throw error; });
  await waitForHttp(directAppPort, '/');
  const appPidBefore = await listenerPid(directAppPort);
  assert.ok(appPidBefore);

  const indexPath = path.join(sandboxRoot, 'web', 'index.html');
  const indexBefore = await readFile(indexPath, 'utf8');
  const marker = `disk-refresh-${Date.now()}`;
  await writeFile(indexPath, indexBefore.replace('sopho-pi · 会话', marker));
  const changedPage = await requestHttp(directAppPort, '/');
  assert.match(changedPage.body, new RegExp(marker));
  assert.equal(await listenerPid(directAppPort), appPidBefore);
  print('static disk reread', { marker, appPid: Number(appPidBefore), pidUnchanged: true });

  const proxy = await requestHttp(directAppPort, '/api/host?probe=s0b');
  assert.equal(proxy.statusCode, 200);
  assert.deepEqual(JSON.parse(proxy.body), { source: 'fake-A', path: '/host?probe=s0b' });
  assert.equal(lastUpstreamPath, '/host?probe=s0b');
  print('proxy path', { downstream: '/api/host?probe=s0b', upstream: lastUpstreamPath });

  const abortingClient = http.request({
    host: '127.0.0.1',
    port: directAppPort,
    path: '/api/slow',
    headers: { connection: 'keep-alive' },
  });
  abortingClient.on('error', () => {});
  abortingClient.end();
  await slowStarted;
  const disconnectedAt = Date.now();
  abortingClient.destroy();
  const slowCloseProof = await Promise.race([
    slowClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stayed open after client disconnect')), 2000)),
  ]);
  assert.equal(slowCloseProof.finished, false);
  print('disconnect destroys upstream', {
    upstreamClosed: true,
    responseFinished: slowCloseProof.finished,
    elapsedMs: Date.now() - disconnectedAt,
  });

  await new Promise((resolve) => upstreamServer.close(resolve));
  upstreamServer = undefined;
  const sseFailure = await requestHttp(directAppPort, '/api/host', {
    headers: { accept: 'text/event-stream' },
  });
  assert.notEqual(sseFailure.statusCode, 502);
  assert.equal(sseFailure.statusCode, 200);
  assert.match(String(sseFailure.headers['content-type']), /^text\/event-stream/);
  assert.match(sseFailure.body, /retry: 1000/);
  const ordinaryFailure = await requestHttp(directAppPort, '/api/host');
  assert.equal(ordinaryFailure.statusCode, 502);
  print('SSE upstream-down soft failure', {
    statusCode: sseFailure.statusCode,
    contentType: sseFailure.headers['content-type'],
    body: sseFailure.body.trim(),
    ordinaryHttpStatus: ordinaryFailure.statusCode,
  });

  await stopOwnedListener(directAppPort, appEntry, directApp.pid);
  directApp = undefined;
  await directAppLog.close();
  directAppLog = undefined;

  const pluginPath = path.join(sandboxRoot, 'pi-extensions', 'assistant', 'index.ts');
  const pluginLoad = await discoverAndLoadExtensions([pluginPath], sandboxRoot, sandboxHome);
  assert.deepEqual(pluginLoad.errors, []);
  assert.equal(pluginLoad.extensions.length, 1);
  const pluginExtension = pluginLoad.extensions[0];
  // 2026-09-26：`s0b_plugin_probe` 与它的孪生命令 `/s0b-plugin-version` 一起退休（业主决定）。
  // 原先「探针存在 ＋ 真执行它拿到版本字符串 ＋ 命令 notify 同一句」那份证据，现由**等强度**的三条替代（已在回执里点名）：
  //   ① 插件 0 错误加载且恰好 1 个扩展（上面两条，保留）；
  //   ② **必备工具集**都在（不依赖任何版本字符串）；
  //   ③ 那条命令**不再存在**（反向断言：证明是真砍了，不是漏砍）。
  for (const name of ['session_new', 'session_send', 'question_ask', 'cwd']) {
    assert.ok(pluginExtension.tools.has(name), `assistant plugin must expose the ${name} tool`);
  }
  assert.equal(pluginExtension.commands.has('s0b-plugin-version'), false, 'the s0b-plugin-version command must be gone (retired with s0b_plugin_probe on 2026-09-26)');
  print('plugin loader preflight', {
    errors: pluginLoad.errors,
    tools: [...pluginExtension.tools.keys()],
    commands: [...pluginExtension.commands.keys()],
    requiredTools: ['session_new', 'session_send', 'question_ask', 'cwd'],
    retiredCommandAbsent: !pluginExtension.commands.has('s0b-plugin-version'),
  });

  const cachePluginPath = path.join(sandboxRoot, 'cache-probe.ts');
  const otherCwd = path.join(sandbox, 'other-cwd');
  const otherPluginPath = path.join(otherCwd, 'cache-probe.ts');
  await mkdir(otherCwd, { recursive: true });
  await writeFile(cachePluginPath, cacheProbeSource('probe-v1'));
  await writeFile(otherPluginPath, cacheProbeSource('probe-other-cwd'));

  const firstLoader = makeProbeLoader(sandboxRoot, cachePluginPath, sandboxHome);
  const firstLoadVersion = await reloadProbeVersion(firstLoader);
  assert.equal(firstLoadVersion, 'probe-v1');
  const firstRuntime = firstLoader.getExtensions();

  await writeFile(cachePluginPath, cacheProbeSource('probe-v2'));
  const freshLoaderSameCwd = makeProbeLoader(sandboxRoot, cachePluginPath, sandboxHome);
  const freshLoaderFirstReload = await reloadProbeVersion(freshLoaderSameCwd);
  assert.equal(freshLoaderFirstReload, 'probe-v1');

  const loadedLoaderReload = await reloadProbeVersion(firstLoader);
  const firstRuntimeStill = await loadedToolVersion(firstRuntime, 'cache_probe');
  assert.equal(loadedLoaderReload, 'probe-v2');
  assert.equal(firstRuntimeStill, 'probe-v1');

  const loaderAfterClear = makeProbeLoader(sandboxRoot, cachePluginPath, sandboxHome);
  const afterClearVersion = await reloadProbeVersion(loaderAfterClear);
  assert.equal(afterClearVersion, 'probe-v2');

  await writeFile(cachePluginPath, cacheProbeSource('probe-v3'));
  const loaderWhileStale = makeProbeLoader(sandboxRoot, cachePluginPath, sandboxHome);
  const staleFirstReload = await reloadProbeVersion(loaderWhileStale);
  assert.equal(staleFirstReload, 'probe-v2');

  const otherCwdLoader = makeProbeLoader(otherCwd, otherPluginPath, sandboxHome);
  const otherCwdVersion = await reloadProbeVersion(otherCwdLoader);
  assert.equal(otherCwdVersion, 'probe-other-cwd');
  const reloadBackInFirstCwd = await reloadProbeVersion(firstLoader);
  assert.equal(reloadBackInFirstCwd, 'probe-v3');

  print('plugin cwd cache probe', {
    diskAfterFirstLoad: 'probe-v1',
    firstLoadVersion,
    diskEditedTo: 'probe-v2',
    freshLoaderSameCwdFirstReload: freshLoaderFirstReload,
    alreadyLoadedLoaderReload: loadedLoaderReload,
    alreadyLoadedRuntimeStill: firstRuntimeStill,
    freshLoaderAfterThatClear: afterClearVersion,
    diskEditedToAgain: 'probe-v3',
    freshLoaderSameCwdWhileStale: staleFirstReload,
    differentCwdLoader: otherCwdVersion,
    reloadBackInFirstCwd,
  });

  print('RESULT', 'S0b static/proxy/plugin PASS');
} catch (error) {
  primaryError = error;
} finally {
  // Cleanup must never hide why the gate failed. A live child whose cwd sits inside
  // the sandbox makes `rm` fail with EBUSY on Windows; that used to replace the
  // real failure (an ECONNREFUSED from a server that never came up) and send the
  // reader chasing the wrong thing. Collect cleanup problems instead, keep the
  // primary error, and only fail on cleanup when the run itself passed.
  const cleanupProblems = [];
  if (scriptStarted) await cleanupStep(cleanupProblems, 'stop A+B', () => runScript('stop.sh'));
  if (directAppPort && directApp?.pid) await cleanupStep(cleanupProblems, 'stop direct app', () => stopOwnedListener(directAppPort, appEntry, directApp.pid));
  if (process.platform === 'win32' && scriptPairAttempted) {
    // Even with serve-win.ps1's measured 125s cap, a WMI-created launcher could
    // theoretically start its node after the caller has failed. Stop whatever now
    // holds the pair's ports *and* proves, by command line, to be the sandbox entry
    // — otherwise the gate leaks A+B and the EBUSY on `rm` hides it.
    for (const entry of ['base', 'app']) {
      const port = entry === 'base' ? scriptBasePort : scriptAppPort;
      await cleanupStep(cleanupProblems, `stop orphaned ${entry}`, () => killVerifiedListenerTree(port, path.join(sandboxRoot, 'server', `${entry}.mjs`)));
    }
  }
  if (directAppLog) { await cleanupStep(cleanupProblems, 'close direct app log', () => directAppLog.close()); directAppLog = undefined; }
  if (upstreamServer) {
    await cleanupStep(cleanupProblems, 'close upstream server', () => new Promise((resolve) => {
      upstreamServer.closeAllConnections();
      upstreamServer.close(resolve);
    }));
    upstreamServer = undefined;
  }
  await removeSandbox(sandbox, cleanupProblems);
  if (madeNodeModulesLink) await cleanupStep(cleanupProblems, 'remove node_modules link', () => execFileAsync('cmd.exe', ['/d', '/c', 'rmdir', nodeModulesPath]));
  finishCleanup(primaryError, cleanupProblems);
}
