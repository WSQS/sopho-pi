#!/usr/bin/env node
// test/notify-stale-watchdog.mjs —— 宿主「子会话静默看门狗」的门（`SOPHO_NOTIFY_STALE_MS`）。
//
// 判据出处：`docs/plans/diagnosis-2026-10-09-subagent-management.md` §3③ / §5 修法③；
// 2026-10-30 业主改判（一手：子会话 798f25d9 单回合跑 13.5 分钟，02:15:15 喊过一次，02:18:51 落定后
// **没有任何落定通知**）—— 看门狗改成「按**无进展**计时、**可重复**、落定唤醒**永不被吞**」。
// 这一门钉的就是重做后的语义：
//
//   臂 stale             登记之后一直不落定 ⇒ 到点给父会话发一条**如实**的唤醒消息（说清「自上次有进展起
//                        已静默 N、回合仍在跑、这是第 k 次提醒、不代表它失败」），并把这条登记在 `/tree` 上
//                        标成 `state:"stale"` + `staleForMs`（从**上次进展**算）+ `staleWakes`（次数）。
//   臂 settled           子会话在到点之前就落定 ⇒ **不**发 stale 消息（只走原有的 20 s 静默窗那条路）；
//                        登记被清掉、看门狗被取消（等到**超过**阈值再断言一次，证明它真的被取消了）。
//   臂 off               `SOPHO_NOTIFY_STALE_MS=off` ⇒ `staleMs:null`、**什么都不发**、登记永不变 stale。
//   臂 badvalue          `SOPHO_NOTIFY_STALE_MS` 是坏值 ⇒ **绝不抛**、退回默认 10 分钟（`600000`）。
//   臂 settle-after-stale 先 stale 后落定 ⇒ **两条唤醒都必须到**（旧版在这里把落定唤醒吞掉了）；
//                        落定那条保留正文前缀「已落定，并持续静默 <quietMs>ms。」并**如实**追加
//                        「（先前报过仍未落定）」。
//   臂 repeat            一个回合挂住跨过**两个**阈值 ⇒ 至少两次唤醒，计数递增（第 1 次、第 2 次），
//                        第二次报的「已静默」比第一次长；全程不许出现「已落定」。
//   臂 progress-resets   阈值之间会话文件有新内容 ⇒ 基线被重置：**不按登记时刻**在第一个阈值喊，
//                        而是在「上次新内容 + 一个阈值」才喊，且报的「已静默」小于「距登记」的时长。
//   臂 idle-no-wake      登记在那儿、但目标**没有在飞的回合** ⇒ 一个阈值也不唤醒（闲着等用户不是「卡住」）。
//
// 形状：真沙箱宿主（`test/sandbox-guard.mjs` 包起 `server/base.mjs`）+ 真 generation worker + 真会话 +
// 假 OpenAI 兼容 provider（可「挂住」某一轮不返回，用来造「登记后一直没落定 / 无进展」）。
// 断言走宿主真路由（`POST /sessions`、`POST /sessions/{id}/spawn`、`GET /tree`、
// `GET /sessions/{id}/messages`、`GET /sessions/{id}/notify`），不碰内部函数。
//
// 反证臂（`--reverse-arm=<名字>`，本仓既有写法：在**副本**上改一处，再拿副本里的**真门**打它，
// 断言它必红；真树一个字节不动）：
//   · `stale-watchdog-removed`：把 `server/base.mjs` 里那一行 `armStaleWatchdog(record);` 换成
//     `record.staleTimer = null;` ⇒ 登记之后再不会有到点唤醒 ⇒「/tree 上可见为 stale」那条必红。
//   · `stale-ms-off`：把这一门自己的 stale 阈值环境变量设为 `off` ⇒ 同一条断言必红
//     （证明这条臂不是空转：看门狗只要被关掉，门就红）。这条臂的接缝是一个**环境变量**，没有字节级
//     from/to 可以去仓库里逐字找 ⇒ 它进不了 `bin/check-arm-seams.mjs` 的扫描，按 `partial` 登记在
//     `bin/arm-seam-coverage.json`（同文件里其它 copy-patch 臂是进扫描的那几条）。
//   · `stale-early-return`：把旧版那条「已经喊过 stale 就抹掉登记、不再兑现落定唤醒」的早退**加回**
//     `noteNotifyLifecycle` 的 settled 分支 ⇒「先 stale 后落定，两条唤醒都必须到」必红。
//   · `timing-from-registered`：把看门狗的「已静默」改回从 `registeredAt` 起算 ⇒
//     「progress-resets 在第一个阈值**不**唤醒」必红（它恰好会在登记时刻的倍数上喊）。
//   · `only-once`：兑现之后**不再重新武装**（改回旧版的「一条登记最多喊一次」）⇒「repeat 第二次唤醒」必红。
//   · `running-gate-removed`：不再看「目标到底在不在跑」⇒「idle-no-wake」必红。
//
// 沙箱纪律（照 `test/annotate-notify.mjs`）：只起**自己 spawn** 的沙箱（副本 home + 高位随机端口 +
// 假 provider + 守卫包起的宿主）；只按**精确 pid** 停；绝不 `pkill`；端口绝不 7321/7331（`reserveHighPort`
// 已经排除）；日志写在沙箱自己的目录；真 profile 一个字节都不碰；绝不用 `git stash`。
//
// 跑法：npm run test:notifystale
//       npm run test:notifystale:reverse-watchdog-removed
//       npm run test:notifystale:reverse-ms-off
//       npm run test:notifystale:reverse-early-return
//       npm run test:notifystale:reverse-timing
//       npm run test:notifystale:reverse-only-once
//       npm run test:notifystale:reverse-running-gate
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runGateOnMutatedCopy, stopOwnedListener } from './harness.mjs';
import { poll, request as libRequest, reserveHighPort, sleep } from './perf-verify-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂要拿**副本**里的真门打副本里的产品 ⇒ 门自己必须能从环境变量拿到「产品在哪棵树」。
// 正题不设它 ⇒ 就是本仓（`REPO_ROOT`）。
const CODE_ROOT = process.env.SOPHO_NOTIFY_STALE_GATE_ROOT || REPO_ROOT;
const GUARD_ENTRY = path.join(REPO_ROOT, 'test', 'sandbox-guard.mjs');
const CODE_ENTRIES = ['server', 'web', 'pi-extensions', 'package.json'];
const SANDBOX_ROOT = path.join(REPO_ROOT, '.probe-sandbox');
// 所有臂的 home / cwd / 日志都落在**同一个** `mkdtemp` 子目录里，门尾一次 `removeSandbox(TMP)` 收干净
//（只建在仓内 `.probe-sandbox/`，它已在 .gitignore；见 `test/annotate-notify.mjs` 同一条）。
// 反证臂不跑臂 ⇒ 不建（免得留下一个没人用的目录）。
let TMP = null;

// 这一门自己用的阈值（可被反证臂 `stale-ms-off` 改成 `off`，从而把正题那条断言打红）。
const ARM_STALE_MS = process.env.SOPHO_NOTIFY_STALE_ARM_MS ?? '700';
const STALE_ARM_QUIET_MS = '150';   // 短静默窗：让落定唤醒在毫秒级内可见
const SETTLED_ARM_STALE_MS = '4000';   // 足够长：子会话的正常一轮一定在它之前落定
const REPEAT_STALE_MS = '500';   // 短阈值：一个挂住的回合能跨过好几个阈值
const PROGRESS_STALE_MS = '1200';   // 够宽：能在「第一个阈值之前」造一次新内容
const BAD_VALUE_STALE_MS = 'definitely-not-a-number';
const DEFAULT_STALE_MS = 10 * 60_000;
const HOLD_MARKER = 'HOLD-FOR-WATCHDOG-PROBE';
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 6 * 60 * 1000;

// 反证臂那条**进扫描**的接缝：`{what,file,from,to}` 成对声明 ⇒ `bin/check-arm-seams.mjs` 会逐字核它
// 在 `server/base.mjs` 里**恰好一处**。真树一个字节不动，副本上才施加。
const STALE_WATCHDOG_SEAM = {
  what: '把静默看门狗的定时器那一行拿掉（登记之后永远没有到点唤醒）⇒「/tree 上可见为 stale」那条断言必红',
  file: 'server/base.mjs',
  // ⚠️ 接缝必须是**唯一**的一段：单行 `armStaleWatchdog(record);` 在 `runStaleWatchdog` 里还出现 4 次
  // （缩进更深，但仍含这串）⇒ `String.replace` 配字符串只会改第一处，臂就可能改到**别处**而看上去「跑了」。
  // 所以钉在这两行上（`watchers.set` 那一行只在这里出现）。
  from: '  watchers.set(watcherSessionId, record);\n  armStaleWatchdog(record);',
  to: '  watchers.set(watcherSessionId, record);\n  record.staleTimer = null;   // (mutation: 静默看门狗定时器被拿掉 —— 门必须变红)',
};

// 落定分支里那句注释定的位置就在循环开头（`staleWakes` 归零之前）：在它前面塞回旧版的早退，
// 就是业主实测到的那条缺陷。
const SETTLE_ARM_SEAM = {
  what: '把旧版的「已经喊过 stale ⇒ 抹掉登记、不再兑现落定唤醒」早退加回去 ⇒「先 stale 后落定，两条唤醒都必须到」必红',
  file: 'server/base.mjs',
  from: '    // ⚠️ 下面这里**曾经**是 `if (record.staleAt !== null) { clearNotifyRegistration(...); continue; }`：',
  to: '    if (record.staleWakes > 0) {   // (mutation: 旧版的早退 —— 落定唤醒被吞掉)\n'
    + '      clearNotifyRegistration(record.targetSessionId, record.watcherSessionId);\n'
    + '      continue;\n'
    + '    }\n'
    + '    // ⚠️ 下面这里**曾经**是 `if (record.staleAt !== null) { clearNotifyRegistration(...); continue; }`：',
};

const TIMING_SEAM = {
  what: '把「已静默」的计时改回从 `registeredAt` 起算（旧版语义）⇒「progress-resets 在第一个阈值不唤醒」必红',
  file: 'server/base.mjs',
  from: '  const silentMs = Date.now() - baselineMs;',
  to: '  const silentMs = Date.now() - Date.parse(record.registeredAt);   // (mutation: 计时改回登记时刻)',
};

const ONLY_ONCE_SEAM = {
  what: '兑现之后不再重新武装（改回旧版的「一条登记最多喊一次」）⇒「repeat 第二次唤醒」必红',
  file: 'server/base.mjs',
  from: '  if (notifyRegistrationLive(record)) armStaleWatchdog(record);',
  to: '  // (mutation: 只喊一次 —— 兑现之后不再重新武装 —— 门必须变红)',
};

const RUNNING_GATE_SEAM = {
  what: '不再看「目标到底在不在跑」（去掉 running 闸门）⇒「idle-no-wake」必红',
  file: 'server/base.mjs',
  from: '  if (facts.running !== true) {',
  to: '  if (false) {   // (mutation: 不再看有没有在飞的回合 —— 门必须变红)',
};

const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

/** copy-patch 形状的反证臂：`seam` 里的 from/to 在副本上施加（真树不动），expect 是必须变红的那条 id。 */
const COPY_PATCH_ARMS = {
  'stale-watchdog-removed': { seam: STALE_WATCHDOG_SEAM, expect: 'notify:tree-stale-visible' },
  'stale-early-return': { seam: SETTLE_ARM_SEAM, expect: 'notify:settle-after-stale-wake-arrives' },
  'timing-from-registered': { seam: TIMING_SEAM, expect: 'notify:progress-no-wake-from-registered-at' },
  'only-once': { seam: ONLY_ONCE_SEAM, expect: 'notify:repeat-second-wake' },
  'running-gate-removed': { seam: RUNNING_GATE_SEAM, expect: 'notify:idle-no-wake' },
};
const ARM_NAMES = new Set(['stale-ms-off', ...Object.keys(COPY_PATCH_ARMS)]);

let checks = 0;
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

/** 一条断言：过了就记一条 id 并变绿；不过就把 id 连同实测值打出来并**抛**。 */
function expect(id, condition, detail) {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (condition) {
    checks += 1;
    process.stdout.write(`✓ ${id} —— ${text}\n`);
    return;
  }
  const message = `${id} —— ${text}`;
  process.stdout.write(`✗ ${message}\n`);
  throw new Error(message);
}

/** 轮询到谓词成立；到点不成立 ⇒ 用**同一条 id** 走 `expect` 变红（反证臂就红在这个 id 上）。 */
async function until(id, description, operation, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) {
      expect(id, true, `${description}；实测=${JSON.stringify(last)?.slice(0, 300)}`);
      return last;
    }
    await sleep(100);
  }
  return expect(id, false, `${description}（${timeoutMs}ms 内没成立）；last=${JSON.stringify(last)?.slice(0, 400)}`);
}

const api = (arm, pathname, { method = 'GET', body } = {}) => libRequest(arm.basePort, pathname, {
  method,
  timeoutMs: 30_000,
  body: body === undefined ? null : JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// 假 provider：只回一句话；含 `HOLD_MARKER` 的那一轮**挂住不返回**，直到门显式放行。
// ---------------------------------------------------------------------------

function sseChunk(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-notify-stale',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
  })}\n\n`);
}

function lastUserText(body) {
  for (let index = body.messages?.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text ?? '').join('');
  }
  return '';
}

async function startProvider(port, state) {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空体就按没有用户文本处理 */ }
    state.requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sseChunk(response, { role: 'assistant', content: '' });
    if (lastUserText(body).includes(HOLD_MARKER)) {
      const held = { release: null };
      held.released = new Promise((resolve) => { held.release = resolve; });
      state.held.push(held);
      await held.released;
    }
    if (response.destroyed) return;
    sseChunk(response, { content: 'FAKE_NOTIFY_STALE_OK' });
    sseChunk(response, {}, 'stop', true);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

// ---------------------------------------------------------------------------
// 沙箱起停（经 `test/sandbox-guard.mjs`：同生共死 + 寿命上限；只按精确 pid 停）
// ---------------------------------------------------------------------------

const liveLogHandles = new Set();

async function startArm({ name, staleMs, quietMs, withProvider = true }) {
  const home = path.join(TMP, `home-${name}`);
  const sessionsDir = path.join(home, 'sessions');
  const cwd = path.join(TMP, `cwd-${name}`);
  for (const dir of [home, sessionsDir, cwd]) await mkdir(dir, { recursive: true });
  const providerPort = withProvider ? await reserveHighPort() : null;
  const basePort = await reserveHighPort();
  const providerState = { requests: 0, held: [] };
  const provider = withProvider ? await startProvider(providerPort, providerState) : null;
  const modelsFile = withProvider
    ? { providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-notify-stale', name: 'Fake Notify Stale', contextWindow: 8192, maxTokens: 1024 }] } } }
    : { providers: {} };
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify(modelsFile, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-notify-stale', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  const logPath = path.join(TMP, `base-${name}.log`);
  const log = await open(logPath, 'w');
  liveLogHandles.add(log);
  const env = {
    ...process.env,
    HOME: home,
    ASSIST_HOME: home,
    SOPHO_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_OFFLINE: '1',
    SOPHO_HOST: '127.0.0.1',
    SOPHO_PORT: String(basePort),
    SOPHO_DEFAULT_CWD: cwd,
    SOPHO_MAX_HOT: '16',
    SOPHO_NOTIFY_QUIET_MS: String(quietMs),
    SOPHO_NOTIFY_STALE_MS: String(staleMs),
  };
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(CODE_ROOT, 'server', 'base.mjs'),
    '--label', `notify-stale-${name}-${basePort}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
    '--watch-stdin',
  ], { cwd: CODE_ROOT, env, stdio: ['pipe', log.fd, log.fd, 'ipc'], detached: true });
  const exited = new Promise((resolve) => guard.once('exit', (code, signal) => resolve({ code, signal })));
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: 守卫没有报出 sandbox-start`)), 30_000);
    guard.on('message', (message) => {
      if (message?.type !== 'sandbox-start') return;
      clearTimeout(timer);
      resolve(message);
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${name}: 宿主起来之前守卫就退了（code=${code} signal=${signal}）`));
    });
  });
  await poll(`${name}: 宿主就绪（GET /host）`, () => api({ basePort }, '/host'), (reply) => reply.statusCode === 200, 90_000);
  assert.equal(await listenerPid(basePort), started.pid, `${name}: 监听端口的必须是我 spawn 的沙箱根 pid`);
  print('sandbox host（经 test/sandbox-guard.mjs 包起）', { arm: name, basePort, guardPid: guard.pid, hostPid: started.pid, staleMs, quietMs, providerPort, logPath, codeRoot: CODE_ROOT });
  return { name, home, sessionsDir, cwd, basePort, providerPort, provider, providerState, guard, exited, log, logPath, hostPid: started.pid };
}

function releaseHeld(arm) {
  let released = 0;
  for (const held of arm.providerState.held.splice(0)) { released += 1; held.release(); }
  return released;
}

async function stopArm(arm, problems) {
  await cleanupStep(problems, `${arm.name}: 放行挂住的 provider 轮`, async () => { releaseHeld(arm); });
  if (arm.provider) await cleanupStep(problems, `${arm.name}: 关 provider`, () => new Promise((resolve) => { arm.provider.closeAllConnections?.(); arm.provider.close(resolve); }));
  await cleanupStep(problems, `${arm.name}: 停沙箱根（精确 pid + 入口核对）`, () => stopOwnedListener(arm.basePort, path.join(CODE_ROOT, 'server', 'base.mjs'), arm.hostPid));
  await cleanupStep(problems, `${arm.name}: 收守树`, async () => {
    const settled = await Promise.race([arm.exited, sleep(15_000).then(() => null)]);
    if (settled === null && arm.guard?.pid) {
      try { process.kill(arm.guard.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      await arm.exited;
    }
  });
  await cleanupStep(problems, `${arm.name}: 关日志`, async () => {
    liveLogHandles.delete(arm.log);
    await arm.log?.close();
  });
}

async function createSession(arm, name, cwd = arm.cwd) {
  const reply = await api(arm, '/sessions', { method: 'POST', body: { cwd, name } });
  expect('notify:session-created', reply.statusCode === 201 && typeof reply.value?.id === 'string', `${arm.name}: POST /sessions → ${reply.statusCode} ${reply.raw?.slice(0, 200)}`);
  const id = reply.value.id;
  // 打开一次 ⇒ 这条会话进本代 pool（`/spawn` 要求父会话是「活」的）。
  await poll(`${arm.name}: 父会话进 pool`, () => api(arm, `/sessions/${id}/commands`), (reply2) => reply2.statusCode === 200, 20_000);
  return id;
}

/** 起一个**挂住**的子会话（那一轮不许结束），返回 childId。 */
async function spawnHeldChild(arm, parentId, name) {
  const created = await api(arm, `/sessions/${parentId}/spawn`, { method: 'POST', body: { task: `${HOLD_MARKER}：这一轮请一直别结束（门要造一个「登记后一直没有新动静」的形状）。`, name } });
  expect(`${arm.name}:spawn-201`, created.statusCode === 201, `spawn → ${created.statusCode} ${created.raw?.slice(0, 300)}`);
  const childId = created.value?.childSessionId;
  expect(`${arm.name}:registered`, created.value?.notify === true && typeof childId === 'string', JSON.stringify({ notify: created.value?.notify, childSessionId: childId ?? null }));
  return childId;
}

function childRegistration(tree, childId) {
  const row = (tree?.sessions ?? []).find((session) => session.id === childId);
  const record = (row?.notify?.notifies ?? [])[0] ?? null;
  return {
    present: record !== null,
    state: record?.state ?? null,
    staleAt: record?.staleAt ?? null,
    staleForMs: record?.staleForMs ?? null,
    staleMs: record?.staleMs ?? null,
    staleWakes: record?.staleWakes ?? null,
  };
}

async function treeRegistration(arm, childId) {
  const reply = await api(arm, '/tree');
  return childRegistration(reply.value, childId);
}

async function delegationMessages(arm, sessionId) {
  const reply = await api(arm, `/sessions/${sessionId}/messages`);
  return (reply.value?.extras ?? [])
    .filter((entry) => entry.customType === 'sopho.delegation')
    .map((entry) => ({ text: entry.text, kind: entry.details?.kind ?? null, from: entry.details?.fromSessionId ?? null }));
}

const isStaleWake = (message) => message.text.includes('不代表它失败') && message.text.includes('回合仍在跑');
const isSettledWake = (message) => message.text.includes('已落定');
const staleNumber = (message) => {
  const match = /这是第 (\d+) 次提醒/.exec(message.text);
  return match === null ? null : Number(match[1]);
};
const reportedSilentMs = (message) => {
  const match = /已静默 (\d+)ms/.exec(message.text);
  return match === null ? null : Number(match[1]);
};

/** 子会话的 `.jsonl` 落盘文件（沙箱自己的 sessions 目录里找名字含该 id 的那个）。 */
async function sessionFileFor(arm, sessionId) {
  const stack = [arm.sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (entry.name.includes(sessionId)) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 臂 1：登记之后一直没落定 ⇒ 到点发一条如实的唤醒 + /tree 上可见为 stale
// ---------------------------------------------------------------------------

async function armStale(problems) {
  const arm = await startArm({ name: 'stale', staleMs: ARM_STALE_MS, quietMs: STALE_ARM_QUIET_MS });
  try {
    const parentId = await createSession(arm, '父会话（stale 臂）');
    const childId = await spawnHeldChild(arm, parentId, 'stale-child');

    const registration = await until('notify:tree-stale-visible', '子会话的登记在 /tree 上可见为 stale', () => treeRegistration(arm, childId), (value) => value.state === 'stale', 20_000);
    expect('notify:stale-for-ms', registration.staleAt !== null && typeof registration.staleForMs === 'number' && registration.staleForMs > 0,
      JSON.stringify(registration));
    expect('notify:stale-count-visible', typeof registration.staleWakes === 'number' && registration.staleWakes >= 1, JSON.stringify(registration));

    const messages = await until('notify:stale-wake-arrives', '父会话收到那条静默唤醒', () => delegationMessages(arm, parentId), (value) => value.length >= 1, 20_000);
    const wake = messages[0];
    expect('notify:stale-wake-says-which-session', wake.text.includes(childId) && wake.kind === 'notify' && wake.from === childId, JSON.stringify(wake));
    expect('notify:stale-wake-honest', wake.text.includes('静默') && wake.text.includes('不代表它失败') && wake.text.includes('回合仍在跑'), JSON.stringify(wake.text));
    expect('notify:stale-wake-numbered', staleNumber(wake) === 1, JSON.stringify(wake.text));
    expect('notify:stale-wake-no-fake-settled', !/已落定|finished|settled/i.test(wake.text), JSON.stringify(wake.text));
    // 放行那一轮 ⇒ 子会话落定（这一臂不断言落定唤醒，那是 settle-after-stale 臂的事）；登记到此收回。
    const released = releaseHeld(arm);
    expect('notify:stale-child-settle-released', released >= 1, `放行了 ${released} 个挂住的 provider 轮`);
    await until('notify:stale-registration-cleared', '子会话落定后这条登记被收掉', () => treeRegistration(arm, childId), (value) => value.present === false, 20_000);
    print('arm stale', { childId, registration, wake: wake.text });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 2：子会话在到点之前就落定 ⇒ 不发 stale（只走原有静默窗），看门狗被取消
// ---------------------------------------------------------------------------

async function armSettled(problems) {
  const arm = await startArm({ name: 'settled', staleMs: SETTLED_ARM_STALE_MS, quietMs: STALE_ARM_QUIET_MS });
  try {
    const parentId = await createSession(arm, '父会话（settled 臂）');
    const created = await api(arm, `/sessions/${parentId}/spawn`, { method: 'POST', body: { task: '回一句就停（这一轮不要挂住）。', name: 'settled-child' } });
    expect('notify:settled-spawn-201', created.statusCode === 201, `spawn → ${created.statusCode} ${created.raw?.slice(0, 300)}`);
    const childId = created.value?.childSessionId;
    const t0 = Date.now();

    const messages = await until('notify:settled-quiet-wake', '走原有静默窗那条路：父会话收到「已落定」唤醒', () => delegationMessages(arm, parentId), (value) => value.length >= 1, 20_000);
    expect('notify:settled-wake-says-settled', messages[0].text.includes('已落定'), JSON.stringify(messages[0].text));
    expect('notify:settled-wake-has-no-stale-marker', !messages[0].text.includes('先前报过'), JSON.stringify(messages[0].text));

    const cleared = await until('notify:settled-registration-gone', '登记被收掉', () => treeRegistration(arm, childId), (value) => value.present === false, 20_000);
    expect('notify:settled-never-stale-visible', cleared.state !== 'stale' && cleared.staleAt === null, JSON.stringify(cleared));

    // 等到**超过** stale 阈值再看一次：登记已经没了（落定唤醒投递成功就清掉）⇒ 看门狗不可能再迟到地兑现。
    const waitMs = Math.max(0, t0 + Number(SETTLED_ARM_STALE_MS) + 1000 - Date.now());
    await sleep(waitMs);
    const after = await delegationMessages(arm, parentId);
    expect('notify:settled-no-stale-after-deadline', after.length === messages.length && !after.some((message) => isStaleWake(message)),
      JSON.stringify({ before: messages.length, after: after.length, texts: after.map((message) => message.text) }));
    print('arm settled', { childId, waitedPastDeadlineMs: waitMs, messages: after.map((message) => message.text) });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 3：`SOPHO_NOTIFY_STALE_MS=off` ⇒ 什么都不发
// ---------------------------------------------------------------------------

async function armOff(problems) {
  const arm = await startArm({ name: 'off', staleMs: 'off', quietMs: '20000' });
  try {
    const parentId = await createSession(arm, '父会话（off 臂）');
    const childId = await spawnHeldChild(arm, parentId, 'off-child');
    const knob = await api(arm, `/sessions/${childId}/notify`);
    expect('notify:off-knob-null', knob.statusCode === 200 && knob.value?.staleMs === null, `GET .../notify → ${knob.statusCode} staleMs=${JSON.stringify(knob.value?.staleMs)}`);

    await sleep(1500);
    const registration = await treeRegistration(arm, childId);
    expect('notify:off-never-stale', registration.state !== 'stale' && registration.staleAt === null, JSON.stringify(registration));
    const messages = await delegationMessages(arm, parentId);
    expect('notify:off-sends-nothing', messages.length === 0, JSON.stringify(messages.map((message) => message.text)));
    print('arm off', { childId, registration, messages: messages.length });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 4：坏值 ⇒ 绝不抛、退回默认
// ---------------------------------------------------------------------------

async function armBadValue(problems) {
  const arm = await startArm({ name: 'badvalue', staleMs: BAD_VALUE_STALE_MS, quietMs: '20000', withProvider: false });
  try {
    const reply = await api(arm, `/sessions/${randomUUID()}/notify`);
    expect('notify:badvalue-does-not-throw', reply.statusCode === 200, `GET .../notify → ${reply.statusCode} ${reply.raw?.slice(0, 200)}`);
    expect('notify:badvalue-falls-back-to-default', reply.value?.staleMs === DEFAULT_STALE_MS, `staleMs=${JSON.stringify(reply.value?.staleMs)}（默认应为 ${DEFAULT_STALE_MS}）`);
    print('arm badvalue', { requested: BAD_VALUE_STALE_MS, staleMs: reply.value?.staleMs });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 5：先 stale 后落定 ⇒ 两条唤醒都必须到（旧版在这里吞掉落定唤醒）
// ---------------------------------------------------------------------------

async function armSettleAfterStale(problems) {
  const arm = await startArm({ name: 'settle-after-stale', staleMs: ARM_STALE_MS, quietMs: STALE_ARM_QUIET_MS });
  try {
    const parentId = await createSession(arm, '父会话（settle-after-stale 臂）');
    const childId = await spawnHeldChild(arm, parentId, 'settle-after-stale-child');

    const first = await until('notify:settle-after-stale-first-wake', '先到一条 stale 唤醒', () => delegationMessages(arm, parentId), (value) => value.some((message) => isStaleWake(message)), 20_000);
    const staleCountBefore = first.filter((message) => isStaleWake(message)).length;
    expect('notify:settle-after-stale-first-wake-is-honest', first.find((message) => isStaleWake(message)).text.includes('第 1 次提醒'), JSON.stringify(first.map((message) => message.text)));

    const released = releaseHeld(arm);
    expect('notify:settle-after-stale-released', released >= 1, `放行了 ${released} 个挂住的 provider 轮`);

    // 旧版那条缺陷就在这里：已经喊过 stale ⇒ 落定被当作「结局」，父会话**一条落定唤醒也收不到**。
    const both = await until('notify:settle-after-stale-wake-arrives', '落定之后仍然收到那条「已落定」唤醒（落定唤醒永不被吞）',
      () => delegationMessages(arm, parentId), (value) => value.some((message) => isSettledWake(message)), 30_000);
    const settledMessage = both.find((message) => isSettledWake(message));
    expect('notify:settle-after-stale-text-prefix', settledMessage.text.startsWith(`会话 ${childId} 已落定，并持续静默 ${STALE_ARM_QUIET_MS}ms。`), JSON.stringify(settledMessage.text));
    expect('notify:settle-after-stale-text-marks-prior-stale', settledMessage.text.includes('（先前报过仍未落定）'), JSON.stringify(settledMessage.text));
    expect('notify:settle-after-stale-order', both.indexOf(settledMessage) > both.findIndex((message) => isStaleWake(message)), JSON.stringify(both.map((message) => message.text)));
    expect('notify:settle-after-stale-stale-count', staleCountBefore >= 1, `落定之前收到的 stale 唤醒条数=${staleCountBefore}`);

    // 落定之后看门狗必须停：再等一个阈值 + 静默窗，不该再多出一条 stale 唤醒。
    await sleep(Number(ARM_STALE_MS) + Number(STALE_ARM_QUIET_MS) + 800);
    const after = await delegationMessages(arm, parentId);
    expect('notify:settle-after-stale-no-late-stale', after.filter((message) => isStaleWake(message)).length === staleCountBefore,
      JSON.stringify({ staleBefore: staleCountBefore, texts: after.map((message) => message.text) }));
    await until('notify:settle-after-stale-registration-gone', '登记被收掉', () => treeRegistration(arm, childId), (value) => value.present === false, 20_000);
    print('arm settle-after-stale', { childId, staleCountBefore, texts: after.map((message) => message.text) });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 6：回合挂住跨过两个阈值 ⇒ 至少两次唤醒、计数递增、报的「已静默」越来越长
// ---------------------------------------------------------------------------

async function armRepeat(problems) {
  const arm = await startArm({ name: 'repeat', staleMs: REPEAT_STALE_MS, quietMs: STALE_ARM_QUIET_MS });
  try {
    const parentId = await createSession(arm, '父会话（repeat 臂）');
    const childId = await spawnHeldChild(arm, parentId, 'repeat-child');

    const first = await until('notify:repeat-first-wake', '第一次无进展唤醒', () => delegationMessages(arm, parentId), (value) => value.filter((message) => isStaleWake(message)).length >= 1, 20_000);
    expect('notify:repeat-first-numbered', staleNumber(first.find((message) => isStaleWake(message))) === 1, JSON.stringify(first.map((message) => message.text)));

    const two = await until('notify:repeat-second-wake', '挂住跨过第二个阈值 ⇒ 第二次无进展唤醒（不是只喊一次）',
      () => delegationMessages(arm, parentId), (value) => value.filter((message) => isStaleWake(message)).length >= 2, 20_000);
    const stale = two.filter((message) => isStaleWake(message));
    expect('notify:repeat-counts-increment', staleNumber(stale[0]) === 1 && staleNumber(stale[1]) === 2, JSON.stringify(stale.map((message) => message.text)));
    expect('notify:repeat-elapsed-grows', reportedSilentMs(stale[1]) > reportedSilentMs(stale[0]), JSON.stringify({ first: reportedSilentMs(stale[0]), second: reportedSilentMs(stale[1]) }));
    expect('notify:repeat-no-fake-settled', !two.some((message) => isSettledWake(message)), JSON.stringify(two.map((message) => message.text)));

    const registration = await treeRegistration(arm, childId);
    expect('notify:repeat-tree-count', typeof registration.staleWakes === 'number' && registration.staleWakes >= 2, JSON.stringify(registration));
    expect('notify:repeat-tree-stale', registration.state === 'stale' && registration.staleForMs > 0, JSON.stringify(registration));

    releaseHeld(arm);
    await until('notify:repeat-registration-cleared', '放行后落定、登记被收掉', () => treeRegistration(arm, childId), (value) => value.present === false, 20_000);
    print('arm repeat', { childId, registration, texts: stale.map((message) => message.text) });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 7：阈值之间会话文件有新内容 ⇒ 基线被重置（不按登记时刻算）
// ---------------------------------------------------------------------------

async function armProgressResets(problems) {
  const staleMs = Number(PROGRESS_STALE_MS);
  const arm = await startArm({ name: 'progress', staleMs: PROGRESS_STALE_MS, quietMs: '20000' });
  try {
    // 目标必须是「**有落盘文件**、且有在飞回合」的会话：这个沙箱里 pi 的会话文件是**回合收尾才刷盘**的
    // （挂住的回合连文件都还没有），所以这里不用 spawn 出来的子会话，而用一条**已经打开过**的会话 ——
    // 它的 `.jsonl` 在盘上，mtime 就是「上次写盘」这个事实。
    const targetId = await createSession(arm, '目标会话（progress-resets 臂）');
    const watcherId = await createSession(arm, '父会话（progress-resets 臂）');
    // pi 是**回合收尾才刷盘**的（刚建的会话也还没文件）⇒ 先跑一个瞬时回合把 `.jsonl` 落到盘上。
    const warm = await api(arm, `/sessions/${targetId}/send`, { method: 'POST', body: { fromSessionId: watcherId, text: '回一句就停（先把会话文件刷到盘上）。', notify: false } });
    expect('notify:progress-warm-turn-accepted', warm.statusCode === 202, `POST /sessions/{id}/send → ${warm.statusCode} ${warm.raw?.slice(0, 300)}`);
    const targetFile = await until('notify:progress-target-file-visible', '目标会话的落盘文件可见（看门狗 stat 的就是它）',
      () => sessionFileFor(arm, targetId), (value) => typeof value === 'string', 30_000);
    await until('notify:progress-target-idle-again', '瞬时回合收尾、目标重新闲着（下一个回合才该被计时）',
      () => api(arm, '/tree'), (reply) => (reply.value?.sessions ?? []).some((row) => row.id === targetId && row.status !== 'working'), 30_000);

    const t0 = Date.now();
    const sent = await api(arm, `/sessions/${targetId}/send`, { method: 'POST', body: { fromSessionId: watcherId, text: `${HOLD_MARKER}：这一轮挂住不返回（门要量「无进展」的计时）。`, notify: true } });
    expect('notify:progress-send-accepted', sent.statusCode === 202 && sent.value?.notify === true, `POST /sessions/{id}/send → ${sent.statusCode} ${sent.raw?.slice(0, 300)}`);
    await until('notify:progress-target-running', '目标确实有在飞的回合（/tree 上是 working）',
      () => api(arm, '/tree'), (reply) => (reply.value?.sessions ?? []).some((row) => row.id === targetId && row.status === 'working'), 20_000);

    // 让看门狗先跑几轮、把会话文件的观测基线立起来（第一次观测只立基线，不算进展）。
    await sleep(500);
    const now = new Date();
    await utimes(targetFile, now, now);
    const bumpedAt = Date.now();
    expect('notify:progress-bump-inside-window', bumpedAt - t0 < staleMs, `新内容落在第一个阈值之内：+${bumpedAt - t0}ms（阈值 ${staleMs}ms）`);

    // 若计时是从**登记**算的，这里（登记 + 一个阈值 + 余量）必定已经喊过一次 —— 那正是旧语义。
    const waitTo = t0 + staleMs + 500 - Date.now();
    if (waitTo > 0) await sleep(waitTo);
    const early = await delegationMessages(arm, watcherId);
    expect('notify:progress-no-wake-from-registered-at', early.filter((message) => isStaleWake(message)).length === 0,
      `登记后 ${Date.now() - t0}ms（阈值 ${staleMs}ms，新内容在 +${bumpedAt - t0}ms）收到 ${early.length} 条唤醒：${JSON.stringify(early.map((message) => message.text))}`);

    const wake = await until('notify:progress-wake-after-baseline', '基线（新内容时刻）+ 一个阈值之后才唤醒',
      () => delegationMessages(arm, watcherId), (value) => value.some((message) => isStaleWake(message)), 20_000);
    const first = wake.find((message) => isStaleWake(message));
    const silent = reportedSilentMs(first);
    const sinceRegistration = Date.now() - t0;
    expect('notify:progress-elapsed-from-new-content', silent !== null && silent >= staleMs && silent < sinceRegistration - 400,
      JSON.stringify({ reportedSilentMs: silent, staleMs, sinceRegistration, bumpedAtOffset: bumpedAt - t0, text: first.text }));
    print('arm progress-resets', { targetId, watcherId, targetFile, staleMs, bumpedAtOffset: bumpedAt - t0, reportedSilentMs: silent, sinceRegistration, text: first.text });
    releaseHeld(arm);
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 8：登记在那儿、但目标**没有在飞的回合** ⇒ 一个阈值也不唤醒
//
// 怎么造出「有登记但没在跑」：这个沙箱 home **没有任何模型**（`models.json` 里 providers 为空）⇒
// `POST /sessions/{id}/send` 先登记 notify、再投递；投递在后台失败，pi 起了一轮又马上收了 ⇒ 登记留在
// 树上（静默窗内）、目标一直是闲的。这正是「纯闲置等用户」那个形状：看门狗必须看 `running` 这个
// **事实**，而不是「等够时间就喊」。
// ⚠️ 这一臂能不能真的抓到错，靠的是配套的 `running-gate-removed` 反证臂：把 running 闸门去掉，
// 它必须变红（也就是说「猜看门狗没武装/已撒销」这种假绿会当场被拆穿）。
// ---------------------------------------------------------------------------

async function armIdleNoWake(problems) {
  const arm = await startArm({ name: 'idle', staleMs: REPEAT_STALE_MS, quietMs: '20000', withProvider: false });
  try {
    const targetId = await createSession(arm, '目标会话（idle 臂）');
    const watcherId = await createSession(arm, '父会话（idle 臂）');
    const sent = await api(arm, `/sessions/${targetId}/send`, { method: 'POST', body: { fromSessionId: watcherId, text: '这条起不来回合（沙箱里没有模型）。', notify: true } });
    expect('notify:idle-send-accepted', sent.statusCode === 202 && sent.value?.notify === true, `POST /sessions/{id}/send → ${sent.statusCode} ${sent.raw?.slice(0, 300)}`);

    const registration = await until('notify:idle-registration-armed', '登记挂在树上（这就是「有登记、目标没在跑」）',
      () => api(arm, `/sessions/${targetId}/notify`), (reply) => (reply.value?.registrations ?? []).length === 1, 20_000);
    expect('notify:idle-target-not-running', registration.value.registrations[0].state !== 'stale', JSON.stringify(registration.value.registrations));
    const idle = await until('notify:idle-target-idle', '目标确实没在跑（/tree 上不是 working）',
      () => api(arm, '/tree'), (reply) => (reply.value?.sessions ?? []).some((row) => row.id === targetId && row.status !== 'working'), 20_000);
    expect('notify:idle-tree-row-idle', (idle.value.sessions ?? []).find((row) => row.id === targetId)?.status !== 'working', JSON.stringify((idle.value.sessions ?? []).find((row) => row.id === targetId)));

    // 跨过**两个**阈值（staleMs 远小于静默窗）：若看门狗不看 running，这里必定已经喊过。
    await sleep(Number(REPEAT_STALE_MS) * 2 + 900);
    const messages = await delegationMessages(arm, watcherId);
    expect('notify:idle-no-wake', messages.length === 0, `跨过两个阈值（${Number(REPEAT_STALE_MS) * 2 + 900}ms）后父会话收到 ${messages.length} 条：${JSON.stringify(messages.map((message) => message.text))}`);
    const later = await api(arm, `/sessions/${targetId}/notify`);
    expect('notify:idle-never-stale', (later.value?.registrations ?? []).every((entry) => entry.state !== 'stale' && entry.staleAt === null), JSON.stringify(later.value?.registrations));
    print('arm idle-no-wake', { targetId, watcherId, registration: later.value?.registrations, messages: messages.length });
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 反证臂
// ---------------------------------------------------------------------------

async function runReverseArm(name) {
  if (name === 'stale-ms-off') {
    // 把**这一门自己**的 stale 阈值关掉（环境变量）⇒ 「/tree 上可见为 stale」那条断言必红。
    const output = await new Promise((resolve) => {
      execFile(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, SOPHO_NOTIFY_STALE_ARM_MS: 'off' },
        maxBuffer: 64 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, text: `${stdout}\n${stderr}` }));
    });
    const expectId = 'notify:tree-stale-visible';
    const redLine = output.text.split('\n').find((line) => line.includes(expectId)) ?? null;
    if (output.exitCode === 0) throw new Error(`反证臂 stale-ms-off 是假的：把看门狗关掉之后这一门居然还是绿的（退出码 0）`);
    if (redLine === null) throw new Error(`反证臂 stale-ms-off 红是红了（退出码 ${output.exitCode}），但没红在预期那条 ${expectId} 上：\n${output.text.slice(-3000)}`);
    print('reverseArm', { name, exitCode: output.exitCode, redLine: redLine.trim() });
    process.stdout.write(`✓ 反证臂 stale-ms-off 红到位（这是**期望**的结果，不是缺陷）：${redLine.trim()}\n`);
    return;
  }
  const arm = COPY_PATCH_ARMS[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${[...ARM_NAMES].join(' / ')}）`);
  const result = await runGateOnMutatedCopy({
    root: REPO_ROOT,
    tag: 'notifystale',
    dirs: CODE_ENTRIES,
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    envKey: 'SOPHO_NOTIFY_STALE_GATE_ROOT',
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.seam.file);
      const text = await readFile(file, 'utf8');
      if (!text.includes(arm.seam.from)) {
        throw new Error(`反证臂 ${name} 的改写**没命中**（接缝形状变了？）：${arm.seam.file}\n  要找：${JSON.stringify(arm.seam.from)}`);
      }
      const hits = text.split(arm.seam.from).length - 1;
      assert.equal(hits, 1, `接缝必须在 ${arm.seam.file} 里恰好 1 处，实际 ${hits} 处`);
      await writeFile(file, text.replace(arm.seam.from, arm.seam.to), 'utf8');
      await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => (error ? reject(new Error(`突变过的 base.mjs 连解析都过不了：${stderr || stdout || error.message}`)) : resolve())));
    },
  });
  if (result.problems.length > 0) process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine.trim() });
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine.trim()}\n`);
}

// ---------------------------------------------------------------------------

// 排障用：`SOPHO_NOTIFY_STALE_ONLY=repeat,progress` 只跑点名的臂（默认跑全部 —— 正题/反证臂都不设它）。
const ONLY = (process.env.SOPHO_NOTIFY_STALE_ONLY || '').split(',').map((entry) => entry.trim()).filter(Boolean);

const ARMS = [
  ['stale', armStale],
  ['settled', armSettled],
  ['off', armOff],
  ['badvalue', armBadValue],
  ['settle-after-stale', armSettleAfterStale],
  ['repeat', armRepeat],
  ['progress', armProgressResets],
  ['idle', armIdleNoWake],
];

if (ARM) {
  if (!ARM_NAMES.has(ARM)) throw new Error(`不认识的反证臂：${ARM}（可选：${[...ARM_NAMES].join(' / ')}）`);
  await runReverseArm(ARM);
} else {
  await mkdir(SANDBOX_ROOT, { recursive: true });
  TMP = await mkdtemp(path.join(SANDBOX_ROOT, 'notify-stale-'));
  const problems = [];
  let primaryError = null;
  try {
    print('sandbox', { tmp: TMP, codeRoot: CODE_ROOT, armStaleMs: ARM_STALE_MS, repeatStaleMs: REPEAT_STALE_MS, progressStaleMs: PROGRESS_STALE_MS, defaults: { staleMs: DEFAULT_STALE_MS }, only: ONLY });
    for (const [name, run] of ARMS) {
      if (ONLY.length > 0 && !ONLY.includes(name)) continue;
      await run(problems);
    }
    print('RESULT', { ok: true, checks });
  } catch (error) {
    primaryError = error;
  } finally {
    await removeSandbox(TMP, problems, 'notify-stale sandbox');
    finishCleanup(primaryError, problems);
  }
  process.stdout.write('RESULT: notify-stale-watchdog PASS\n');
}
