#!/usr/bin/env node
// 「同一代里、**同 cwd** 的新会话拿到的工具面必须是**当前插件文件**」的验收门。
//
// 判据（一句话）：`GET /debug/instances` 里那条**新建会话**的 `active`，去掉内建工具之后，必须**逐字等于**
// `pi-extensions/assistant/index.ts` 里 `pi.registerTool({ name: "..." })` 解析出来的名字集合。
// 名字集合是**从沙箱那份插件文件当场读出来的**（不是硬编码 15 条）⇒ 门判的是「面 vs 盘上那份文件」。
//
// 为什么需要这道门（它钉的是我们自己的一个口径差，2026-10-04）：
//   pi 的插件模块缓存是**进程级**的（`pi-coding-agent/dist/core/extensions/loader.js:115-131`），
//   而 `DefaultResourceLoader.reload()` **只在 `this.loaded === true` 时**才 `clearExtensionCache()`
//   （`…/dist/core/resource-loader.js:263-267`）⇒ **新建 loader 的第一次 reload 不清缓存**。
//   于是「同 cwd 再开一条 runtime」会命中上一次加载的旧工厂 ⇒ 工具面是旧插件的：
//   改完插件（增/删工具）后，同 cwd 的新会话仍拿旧面（研究单 `docs/plans/research-pi-dynamic-tools.md`
//   §3.3 步骤 ③/⑦ 的实测形状）。`server/base-logic.mjs` 的 `prepareRuntime` 修法是**对同一个 loader
//   reload 两次**（第二次进来 `loaded` 已为 true ⇒ 真 clear ⇒ 从磁盘重读；`clearExtensionCache`
//   没有从包根导出，那条路走不通 —— 见那份注释）。
//
// 本门走的是**端到端**：真起沙箱宿主（副本树 + 副本 home + 高位随机端口）＋ 真开 runtime，
// 然后在沙箱那份插件文件上**增 / 删**一条探针工具，看同 cwd 的新会话跟不跟。
//
// 两个 cwd 家族（d1 / d2）**各自连成一段**（中间不换 cwd）—— 这是让**两个方向**都有牙的关键：
// pi 的缓存同一时刻只认一个 cwd，换了 cwd 就会清（`loader.js:125-128`）⇒ 旧行为下「命中旧缓存」的**唯一**形状
// 是「**连着**在同一个 cwd 再开一条」，而它拿到的正是**这一段第一次加载**的那一版。所以要让两个方向各自可判，
// 就得有**两段**、且两段第一次加载的分别是两版：
//   · 段一（d1）第一次加载 **v0（无探针）** ⇒ 盘上**加**探针之后，同 cwd 的新会话必须带上它（方向 A：新增要出现）；
//   · 段二（d2）第一次加载 **v1（有探针）** ⇒ 盘上**删**探针之后，同 cwd 的新会话必须不再带它（方向 B：已删要消失）。
// 两个方向各自都能在旧行为下打红 —— 见 `--reverse-arm=stale-cache` 的实测（`reverseArm redLines` 里两条判据都在）。
//
// 断言分组（每一组都登记进 `failures`，跑到最后一起判 —— 目的就是**两个方向都亮出来**，
// 不是第一处红就收工；`test/harness.mjs` 的反证臂只会看见第一行红，但门输出里两条都在）：
//   ① 基线：S1（cwd d1，盘上是 v0）的面 = 盘上那份插件 ＋ 内建若干；内建集合就此**校准**出来。
//   ② 正向对照：**异 cwd**（d2）首次加载本来就是新鲜的（旧行为下也对）—— 它是「读数有能力看出新鲜」的对照，
//      同时把段二（d2）的缓存钉在 v1。
//   ③ 方向 A（d1，段一缓存装的是 v0）：盘上加探针 ⇒ **连着**同 cwd 的新会话必须已带上它。
//   ④ 方向 B（d2，段二缓存装的是 v1）：盘上删探针 ⇒ **连着**同 cwd 的新会话不许再带着它。
//   ⑤ 回访 d1（盘上又加回探针）：修好后必须是 v1（旧行为下回访会被 cwd 切换自己清掉缓存、判不出牙，故只作读数）。
//   ⑥ 「已热会话不受影响」这条既有语义没被动过：S1 的面自始至终是它建的时候那份，
//      且 `identicalRegisteredAcrossLiveSessions` 如实报 `false`（同一代里几个面不一致，端点自己说出来了）。
//
// 铁律（与 test/debug-instances.mjs 同口径）：
//   · 只起**自己 spawn** 的沙箱，只按**精确 pid** 停，**绝不 pkill / pgrep -f**；
//   · 端口绝不 7331/7321（`reserveHighPort` 显式避开）；日志写沙箱自己的目录；
//   · 沙箱只碰**副本树**（`pi-extensions/assistant/index.ts` 要在里面增删探针）——真树一个字节不动；
//   · 会话 id 一律完整 uuid；**绝不碰真 profile**（副本 home）。
//
// 用法：
//   node test/plugin-cache-freshness.mjs
//   node test/plugin-cache-freshness.mjs --reverse-arm=stale-cache   # 反证臂：改回「只 reload 一次」⇒ 本门必须红
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runGateOnMutatedCopy, stopSpawnedListener } from './harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用它指向「改过一处的副本」；正常跑就是真树。
const sourceRoot = process.env.SOPHO_CACHE_GATE_ROOT ? path.resolve(process.env.SOPHO_CACHE_GATE_ROOT) : repoRoot;
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const FORBIDDEN_PORTS = new Set([7321, 7331]);
// 两个方向共用的那句判据名（反证臂按它点名「红在哪条判据上」）。
const CRITERION = 'same-cwd new session must load the current plugin file';

let sandbox;
let codeRoot;
let home;
let workspace;
let sessionsRoot;
let baseLogPath;
let baseEntry;
let baseChild;
let baseLog;
let basePort;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sorted = (names) => [...names].sort();

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (FORBIDDEN_PORTS.has(candidate) || excluded.has(candidate)) continue;
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
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, raw: text };
}

async function poll(label, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(120);
  }
  throw new Error(`${label} timed out; last = ${JSON.stringify(last)}`);
}

// ── 插件文件：探针工具的增 / 删（都只动沙箱那份副本）────────────────────────────
const PLUGIN_REL = path.join('pi-extensions', 'assistant', 'index.ts');
const FACTORY_ANCHOR = 'export default function (pi: ExtensionAPI) {\n';
const PROBE_NAME = 'probe_cache_freshness';
const PROBE_BLOCK = `\tpi.registerTool({
\t\tname: "${PROBE_NAME}",
\t\tlabel: "Probe: plugin cache freshness",
\t\tdescription: "sandbox probe tool inserted by test/plugin-cache-freshness.mjs",
\t\tparameters: Type.Object({}),
\t\tasync execute() { return toolResult({ probe: true }); },
\t});

`;

/** 盘上那份插件声明的工具名（**当场从源文件解析**，不是硬编码清单）。 */
function pluginToolNames(source) {
  return [...source.matchAll(/pi\.registerTool\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** 写回插件文件，并**读回来对字节**：不许「写了但没落到盘上」当证据。 */
async function writePlugin(text) {
  await writeFile(path.join(codeRoot, PLUGIN_REL), text, 'utf8');
  const readBack = await readFile(path.join(codeRoot, PLUGIN_REL), 'utf8');
  assert.equal(readBack, text, 'the sandbox plugin file on disk is not the text we wrote');
  const names = pluginToolNames(readBack);
  assert.equal(new Set(names).size, names.length, `duplicate tool names on disk: ${JSON.stringify(names)}`);
  return names;
}

async function pluginWithProbe() {
  const text = await readFile(path.join(codeRoot, PLUGIN_REL), 'utf8');
  assert.equal(text.includes(FACTORY_ANCHOR), true, 'plugin factory anchor is missing');
  assert.equal(text.includes(PROBE_NAME), false, 'the probe tool is already in the sandbox plugin');
  const next = text.replace(FACTORY_ANCHOR, `${FACTORY_ANCHOR}${PROBE_BLOCK}`);
  assert.notEqual(next, text, 'inserting the probe tool changed nothing');
  return writePlugin(next);
}

async function pluginWithoutProbe() {
  const text = await readFile(path.join(codeRoot, PLUGIN_REL), 'utf8');
  assert.equal(text.includes(PROBE_BLOCK), true, 'the probe block we meant to remove is not in the sandbox plugin');
  const next = text.replace(PROBE_BLOCK, '');
  assert.notEqual(next, text, 'removing the probe tool changed nothing');
  assert.equal(next.includes(PROBE_NAME), false, 'the probe tool survived the removal');
  return writePlugin(next);
}

// ── 读数 ────────────────────────────────────────────────────────────────
async function createSession(cwd, name) {
  const startedAt = Date.now();
  const reply = await api('/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(reply.statusCode, 201, `POST /sessions failed: ${reply.raw}`);
  assert.ok(reply.value?.id, `POST /sessions returned no id: ${reply.raw}`);
  return { id: reply.value.id, createMs: Date.now() - startedAt };
}

/** 某条会话的面（`active` 是**会话级**的：端点 `tools.scope` 里写明了）。 */
async function surfaceOf(sessionId) {
  const reply = await api('/debug/instances');
  assert.equal(reply.statusCode, 200, reply.raw);
  const row = (reply.value.tools.activeBySession ?? []).find((entry) => entry.sessionId === sessionId);
  assert.ok(row, `session ${sessionId} has no tool surface in GET /debug/instances: ${reply.raw.slice(0, 400)}`);
  return { row, tools: reply.value.tools };
}

/** 非内建的那部分（＝插件工具）。内建集合由基线那次**校准**出来，之后一直用它。 */
const pluginPart = (active, builtins) => active.filter((name) => !builtins.has(name)).sort();

async function runGate() {
  let primaryError;
  sandbox = await mkdtemp(path.join(repoRoot, '.sopho-cachefresh-sandbox-'));
  codeRoot = path.join(sandbox, 'code');
  home = path.join(sandbox, 'home');
  workspace = path.join(sandbox, 'workspace');
  sessionsRoot = path.join(home, 'sessions');
  baseLogPath = path.join(sandbox, 'base.log');
  baseEntry = path.join(codeRoot, 'server', 'base.mjs');
  // 每一组断言都登记进来、跑到最后一起判：本门要**两个方向**都亮出来（见文件头）。
  const failures = [];
  const check = (label, body) => {
    try { body(); } catch (error) { failures.push(`${label}: ${error.message}`); }
  };
  try {
    // 副本树（必须在仓库根**里面**：`node_modules` 靠向上查找解析）。
    await mkdir(codeRoot, { recursive: true });
    for (const directory of ['server', 'pi-extensions', 'web']) {
      await cp(path.join(sourceRoot, directory), path.join(codeRoot, directory), { recursive: true });
    }
    for (const directory of [home, sessionsRoot, workspace]) await mkdir(directory, { recursive: true });
    const d1 = path.join(workspace, 'd1');
    const d2 = path.join(workspace, 'd2');
    for (const directory of [d1, d2]) await mkdir(directory, { recursive: true });

    // 副本 home：够开 runtime 就行，本门**不跑任何模型回合**（`POST /sessions` 就走 `withSession{create:true}` ⇒ 真开 runtime）。
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
      baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      apiKey: 'sandbox',
      models: [{ id: 'fake-cache-freshness', name: 'Cache Freshness Fake', contextWindow: 4096, maxTokens: 512 }],
    } } }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
      defaultProvider: 'fake', defaultModel: 'fake-cache-freshness', defaultThinkingLevel: 'off',
      compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    }, null, 2)}\n`);

    const used = new Set();
    basePort = await reserveHighPort(used); used.add(basePort);
    assert.equal(FORBIDDEN_PORTS.has(basePort), false);

    baseLog = await open(baseLogPath, 'w');
    baseChild = spawn(process.execPath, [baseEntry], {
      cwd: codeRoot,
      env: {
        ...process.env,
        HOME: home,
        ASSIST_HOME: home,
        SOPHO_AGENT_DIR: home,
        PI_CODING_AGENT_DIR: home,
        PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
        PI_OFFLINE: '1',
        SOPHO_HOST: '127.0.0.1',
        SOPHO_PORT: String(basePort),
        SOPHO_DEFAULT_CWD: d1,
        // 全场会话都留着热（本门读的就是热 runtime 的面）：不设上限 ＋ 长 TTL。
        SOPHO_MAX_HOT: 'off',
        SOPHO_IDLE_TTL_MS: '900000',
      },
      stdio: ['ignore', baseLog.fd, baseLog.fd],
    });
    await poll('base ready', () => api('/host'), (reply) => reply.statusCode === 200);
    const hostReply = (await api('/host')).value;
    assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
    print('sandbox', {
      sandbox: path.relative(repoRoot, sandbox), codeRoot: path.relative(repoRoot, codeRoot), home,
      basePort, basePid: baseChild.pid, workerPid: hostReply.currentWorkerPid, forbiddenPortsUsed: false,
    });

    // ── ① 基线：S1（cwd d1，盘上是 v0）⇒ 段一（d1）的缓存先装 v0 ──────────
    const diskV0 = pluginToolNames(await readFile(path.join(codeRoot, PLUGIN_REL), 'utf8'));
    assert.equal(diskV0.length > 0, true, 'parsed no pi.registerTool({name:...}) out of the sandbox plugin');
    assert.equal(diskV0.includes(PROBE_NAME), false, 'the probe tool is in the plugin before we insert it');
    print('pluginOnDisk v0', { tools: diskV0.length, names: sorted(diskV0) });

    const s1 = await createSession(d1, 'cache-freshness-s1');
    const s1First = await surfaceOf(s1.id);
    // 内建集合就此校准：基线会话的面里，不属于盘上 v0 的那部分就是内建。
    const builtins = new Set(s1First.row.active.filter((name) => !diskV0.includes(name)));
    check('① baseline: d1 session surface == plugin file on disk (v0)', () => {
      assert.equal(builtins.size > 0, true, `no built-in tools observed next to the plugin tools: ${JSON.stringify(s1First.row.active)}`);
      assert.deepEqual(pluginPart(s1First.row.active, builtins), sorted(diskV0), 'the baseline session tool surface does not match the plugin file on disk');
    });
    print('S1 baseline (d1, v0)', {
      sessionId: s1.id, activeCount: s1First.row.activeCount, createMs: s1.createMs,
      builtins: sorted([...builtins]), pluginTools: sorted(diskV0).length,
    });

    // ── ② 盘上**加**探针（v1）⇒ ③ 方向 A：**连着**在 d1 再开一条必须已带上它 ──
    const diskV1 = await pluginWithProbe();
    assert.deepEqual(sorted(diskV1), sorted([...diskV0, PROBE_NAME]), 'the probe insert did not land as expected');
    const s2 = await createSession(d1, 'cache-freshness-s2');
    const s2Surface = await surfaceOf(s2.id);
    const s2Part = pluginPart(s2Surface.row.active, builtins);
    check('③ direction A (tool added on disk must appear in a same-cwd new session)', () => {
      assert.deepEqual(s2Part, sorted(diskV1), `${CRITERION} (a tool added to the file must show up in a same-cwd new session)`);
      assert.equal(s2Part.includes(PROBE_NAME), true, `${CRITERION} (the added probe tool must be active)`);
    });
    print('S2 same cwd (d1) after the tool was added to disk', {
      sessionId: s2.id, activeCount: s2Surface.row.activeCount, createMs: s2.createMs,
      probePresent: s2Part.includes(PROBE_NAME), pluginTools: s2Part.length,
    });

    // ── ③ 正向对照 ＋ 把段二（d2）的缓存钉在 v1（异 cwd 首次加载本来就新鲜，旧行为下也对）──
    const s3 = await createSession(d2, 'cache-freshness-s3');
    const s3Surface = await surfaceOf(s3.id);
    const s3Part = pluginPart(s3Surface.row.active, builtins);
    check('② positive control (a fresh cwd sees v1)', () => {
      assert.deepEqual(s3Part, sorted(diskV1), 'a new session at a fresh cwd must load the plugin file on disk');
      assert.equal(s3Part.includes(PROBE_NAME), true, 'the fresh-cwd session did not get the probe tool');
    });
    print('S3 fresh cwd (d2, v1)', {
      sessionId: s3.id, activeCount: s3Surface.row.activeCount, createMs: s3.createMs,
      probePresent: s3Part.includes(PROBE_NAME), pluginTools: s3Part.length,
    });

    // ── ④ 盘上**删**探针（v0）⇒ ④ 方向 B：**连着**在 d2 再开一条不许再带着它 ──
    const diskV0Again = await pluginWithoutProbe();
    assert.deepEqual(sorted(diskV0Again), sorted(diskV0), 'the probe removal did not restore the original plugin text');
    const s4 = await createSession(d2, 'cache-freshness-s4');
    const s4Surface = await surfaceOf(s4.id);
    const s4Part = pluginPart(s4Surface.row.active, builtins);
    check('④ direction B (tool removed on disk must disappear from a same-cwd new session)', () => {
      assert.deepEqual(s4Part, sorted(diskV0Again), `${CRITERION} (a tool deleted from the file must not linger in a same-cwd new session)`);
      assert.equal(s4Part.includes(PROBE_NAME), false, `${CRITERION} (the deleted probe tool must not be active)`);
    });
    print('S4 same cwd (d2) after the tool was deleted from disk', {
      sessionId: s4.id, activeCount: s4Surface.row.activeCount, createMs: s4.createMs,
      probePresent: s4Part.includes(PROBE_NAME), pluginTools: s4Part.length,
    });

    // ── ⑤ 盘上再加回探针（v1）⇒ 回访 d1：修好后必须是 v1（旧行为下这一步会被 cwd 切换自己清掉缓存）──
    const diskV1Again = await pluginWithProbe();
    assert.deepEqual(sorted(diskV1Again), sorted(diskV1), 'the probe re-insert did not land as expected');
    const s5 = await createSession(d1, 'cache-freshness-s5');
    const s5Surface = await surfaceOf(s5.id);
    const s5Part = pluginPart(s5Surface.row.active, builtins);
    check('⑤ back at d1 after the tool was added again', () => {
      assert.deepEqual(s5Part, sorted(diskV1Again), `${CRITERION} (re-visiting d1 must also load the file as it is now)`);
    });
    print('S5 back at d1 after the tool was added again', {
      sessionId: s5.id, activeCount: s5Surface.row.activeCount, createMs: s5.createMs,
      probePresent: s5Part.includes(PROBE_NAME), pluginTools: s5Part.length,
    });

    // ── ⑥ 「已热会话不受影响」没被动过：S1 仍是它建的时候那份，端点如实报几个面不一致 ──
    const last = await surfaceOf(s1.id);
    check('⑥ an already-hot session keeps the surface it was opened with', () => {
      assert.deepEqual(pluginPart(last.row.active, builtins), sorted(diskV0), 'a session that was already hot must keep the tool surface it was opened with');
      assert.equal(pluginPart(last.row.active, builtins).includes(PROBE_NAME), false, 'the already-hot session changed under us');
      assert.equal(last.tools.identicalRegisteredAcrossLiveSessions, false, 'the endpoint must honestly report that live sessions in this worker disagree about the registered tool set');
      assert.equal(last.tools.liveSessionCount, 5, `expected 5 live sessions, got ${last.tools.liveSessionCount}`);
    });
    print('S1 still hot & unchanged', {
      sessionId: s1.id, activeCount: last.row.activeCount, probePresent: false,
      identicalRegisteredAcrossLiveSessions: last.tools.identicalRegisteredAcrossLiveSessions,
      liveSessionCount: last.tools.liveSessionCount,
    });

    print('RESULT', {
      keyFinding: 'a new session at the SAME cwd as a previous one loads the plugin file as it is on disk right now',
      directionA_addedToolAppears: !failures.some((entry) => entry.startsWith('③')),
      directionB_deletedToolDisappears: !failures.some((entry) => entry.startsWith('④')),
      alreadyHotSessionUnchanged: !failures.some((entry) => entry.startsWith('⑥')),
      passed: failures.length === 0,
      // 这里只点**哪几组**失败：失败的完整原文（含 node 的 diff）由最后那条断言如实吐出，
      // 免得这份 JSON 与本门的红行糊在一起（反证臂按 `- ③ ...` 那种行点名）。
      failedChecks: failures.map((entry) => entry.split(':')[0]),
    });
    assert.deepEqual(failures, [], `plugin cache freshness gate failed:\n${failures.map((entry) => `- ${entry}`).join('\n')}`);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupProblems = [];
    if (baseChild) {
      try { await stopSpawnedListener(baseChild, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
    }
    if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
    if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
    const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
    if (baseOutput.trim()) print('base log', baseOutput.trim());
    if (sandbox) await removeSandbox(sandbox, cleanupProblems);
    finishCleanup(primaryError, cleanupProblems);
  }
}

// ── 常驻反证臂（本仓惯例：把交付物**副本**改一处，再拿**真门**去打那份副本，断言必红）────────────
// 机械在 `test/harness.mjs` 的 `runGateOnMutatedCopy()`：副本建在仓库根里的 `.sopho-cachearm-sandbox-*/`
// （必须在仓内：`node_modules` 靠向上查找解析），跑完收敛式删除。
// 这条臂改的是**本单的接缝本身**：把 `prepareRuntime` 里那第二次 reload 去掉 ⇒ 回到旧行为
// （新建 loader 的第一次 reload 不清进程级插件缓存）⇒ 同 cwd 的新会话又拿陈旧面 ⇒ ③ / ④ 两条判据都必红。
const ARM_MUTANTS = {
  'stale-cache': {
    what: '去掉 prepareRuntime 的第二次 reload（回到「新建 loader 只 reload 一次」的旧行为）',
    file: 'server/base-logic.mjs',
    from: '    await resourceLoader.reload();\n    await resourceLoader.reload();\n    const extensionErrors = resourceLoader.getExtensions().errors;',
    to: '    await resourceLoader.reload(); // reverse-arm:stale-cache\n    const extensionErrors = resourceLoader.getExtensions().errors;',
    expect: 'same-cwd new session must load the current plugin file',
  },
};

async function runReverseArm(name) {
  const arm = ARM_MUTANTS[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  process.stdout.write(`反证臂 ${name}：${arm.what}\n`);
  const result = await runGateOnMutatedCopy({
    root: repoRoot,
    tag: 'cachearm',
    dirs: ['server', 'pi-extensions', 'web'],
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    envKey: 'SOPHO_CACHE_GATE_ROOT',
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.file);
      const text = await readFile(file, 'utf8');
      if (!text.includes(arm.from)) {
        throw new Error(`反证臂 ${name} 的改写**没命中**（接缝形状变了？）：${arm.file}\n  要找：${JSON.stringify(arm.from)}`);
      }
      await writeFile(file, text.replace(arm.from, arm.to), 'utf8');
    },
  });
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine });
  // 这条臂要的是「两个方向都红」：把门输出里登记的那两条判据行都点名出来（harness 只看得见第一行）。
  const redLines = result.output.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && line.includes(CRITERION));
  print('reverseArm redLines', [...new Set(redLines)].slice(0, 8));
  if (result.problems.length > 0) {
    process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine}\n`);
}

if (ARM) await runReverseArm(ARM);
else await runGate();
