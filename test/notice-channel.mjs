// M-41 服务端门：插件 `ctx.ui.notify` 必须真的到达该会话的 SSE 订阅者。
//
// 契约见 `docs/notice-channel-plan.md`。这道门用**真 A + 真 B + 假 provider + 一个自写的测试扩展**
// （落在沙箱 home 的 `extensions/` 里，由 pi 的 user-extension 自动发现加载；**不改用户的插件**）：
//   · `/notice-probe hasui`   ⇒ 订阅者收到 `session.notice`，文本里 `hasUI:true`、`mode:"rpc"`（绑定生效）
//   · `/notice-probe basic`   ⇒ level=warning，形状 {type,sessionId,level,text,at,source,seq}
//   · `/notice-probe multiline` ⇒ 换行原样保留
//   · `/notice-probe long`    ⇒ 超长被截断且带标记
//   · `/notice-probe dialog`  ⇒ confirm/select 返回默认值**且**收到 warning notice（不静默）
//   · 无订阅者时发通知        ⇒ 不抛错（HTTP 202）
//   · 以上全程会话文件**不新增任何条目**（瞬时，不落盘）
//
// 反证臂：把 `server/base-logic.mjs` 里 `setUIContext(...)` 那一行注释掉 ⇒ 本门必须在第一条断言就红
// （notify 不再到达订阅者）。报告里贴了那次红。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox, stopOwnedListener } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'notice-channel-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'notice-base.log');
const appLogPath = path.join(sandbox, 'notice-app.log');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');
const cleanupProblems = [];
const MARK = '\n…（通知过长，已截断）';
let providerServer;
let baseChild;
let appChild;
let baseLog;
let appLog;
let providerPort;
let basePort;
let appPort;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
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
  const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, body: text };
}

async function waitForHttp() {
  let lastError;
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 600 : 160); attempt += 1) {
    try {
      const response = await api('/host');
      if (response.statusCode === 200) return response;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError ?? new Error('A+B did not become ready');
}

function openSse(pathname) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({
    host: '127.0.0.1',
    port: appPort,
    path: `/api${pathname}`,
    headers: { accept: 'text/event-stream' },
  });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      response = incoming;
      assert.equal(incoming.statusCode, 200);
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ event: currentEvent, data });
              for (const waiter of [...waiters]) waiter();
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.on('error', () => {});
      resolve();
    });
    request.end();
  });

  async function waitFor(predicate, timeoutMs = 8000) {
    const found = events.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`SSE wait timed out: ${JSON.stringify(events)}`));
      }, timeoutMs);
      const check = () => {
        const value = events.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      waiters.add(check);
    });
  }

  return {
    connected,
    events,
    waitFor,
    close() { response?.destroy(); request.destroy(); },
  };
}

await mkdir(sessionsRoot, { recursive: true });
await mkdir(cwd, { recursive: true });
await mkdir(path.join(home, 'extensions'), { recursive: true });

// ── 自写的测试扩展（只有一条命令；用来触发 notify / 对话框）─────────────────────────
const probeSource = `
export default function (pi) {
  pi.registerCommand("notice-probe", {
    description: "M-41 notice channel probe",
    handler: async (args, ctx) => {
      const mode = String(args || "").trim();
      if (mode === "hasui") {
        ctx.ui.notify(JSON.stringify({ hasUI: ctx.hasUI, mode: ctx.mode }), "info");
      } else if (mode === "basic") {
        ctx.ui.notify("插件通知-probe", "warning");
      } else if (mode === "multiline") {
        ctx.ui.notify("第一行\\n第二行\\n第三行", "info");
      } else if (mode === "long") {
        ctx.ui.notify("x".repeat(9000), "error");
      } else if (mode === "dialog") {
        const confirmed = await ctx.ui.confirm("标题", "确认吗？");
        const picked = await ctx.ui.select("选一个", ["a", "b"]);
        ctx.ui.notify("confirm=" + JSON.stringify(confirmed) + " select=" + JSON.stringify(picked), "info");
      }
    },
  });
}
`;
await writeFile(path.join(home, 'extensions', 'notice-probe.ts'), probeSource, 'utf8');

// ── 种子会话（有名字，免得第一条消息触发种子标题写成文件条目）───────────────────────
const sessionId = randomUUID();
const now = new Date().toISOString();
const seedLines = [
  { type: 'session', version: 3, id: sessionId, timestamp: now, cwd },
  { type: 'model_change', id: '00000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-notice' },
  { type: 'thinking_level_change', id: '00000002', parentId: '00000001', timestamp: now, thinkingLevel: 'off' },
  { type: 'message', id: '00000003', parentId: '00000002', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'seed' }], timestamp: Date.now() } },
  { type: 'session_info', id: '00000004', parentId: '00000003', timestamp: now, name: 'Notice Probe Session' },
];
const sessionFile = path.join(sessionsRoot, `seed-notice_${sessionId}.jsonl`);
await writeFile(sessionFile, `${seedLines.map(JSON.stringify).join('\n')}\n`);

const used = new Set();
providerPort = await reserveHighPort(used); used.add(providerPort);
basePort = await reserveHighPort(used); used.add(basePort);
appPort = await reserveHighPort(used); used.add(appPort);

await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
  providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      api: 'openai-completions',
      apiKey: 'sandbox-key',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: 'fake-notice', name: 'Notice Fake', contextWindow: 4096, maxTokens: 512 }],
    },
  },
}, null, 2)}\n`);
await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
  defaultProvider: 'fake',
  defaultModel: 'fake-notice',
  defaultThinkingLevel: 'off',
  compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}, null, 2)}\n`);

providerServer = http.createServer((request, response) => { response.writeHead(404).end(); });
await new Promise((resolve, reject) => { providerServer.once('error', reject); providerServer.listen(providerPort, '127.0.0.1', resolve); });

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};

let primaryError = null;
try {
  baseLog = await open(baseLogPath, 'w');
  appLog = await open(appLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
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
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await waitForHttp();
  print('sandbox', { home, cwd, providerPort, basePort, appPort, forbiddenPortsUsed: false });

  const sub = openSse(`/sessions/${sessionId}/events`);
  await sub.connected;
  await sub.waitFor((entry) => entry.event === 'session.snapshot');
  // SSE 连上后先落一份会话文件基线（同一次 open 期间，命令**不该**再写任何条目）。
  const before = await readFile(sessionFile, 'utf8');

  const send = async (text) => {
    const response = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text } });
    assert.equal(response.statusCode, 202, `send ${text} → ${response.statusCode} ${response.body}`);
    return response;
  };

  // ── 0. 绑定生效：ctx.hasUI === true、mode === 'rpc' ─────────────────────────────
  await send('/notice-probe hasui');
  const hasui = await sub.waitFor((entry) => entry.event === 'session.notice' && typeof entry.data?.text === 'string' && entry.data.text.includes('hasUI'));
  const hasuiValue = JSON.parse(hasui.data.text);
  check('绑定生效：插件看到 ctx.hasUI === true / ctx.mode === "rpc"',
    hasuiValue.hasUI === true && hasuiValue.mode === 'rpc',
    JSON.stringify(hasuiValue));

  // ── 1. 事件形状（type/sessionId/level/text/at/source/seq）────────────────────────
  await send('/notice-probe basic');
  const basic = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.text === '插件通知-probe');
  check('notify ⇒ SSE `session.notice`，形状正确（type/sessionId/level/text/at/source/seq）',
    basic.data.type === 'session.notice'
    && basic.data.sessionId === sessionId
    && basic.data.level === 'warning'
    && basic.data.text === '插件通知-probe'
    && basic.data.source === 'extension'
    && typeof basic.data.at === 'string' && !Number.isNaN(Date.parse(basic.data.at))
    && Number.isInteger(basic.data.seq),
    basic.data);

  // ── 2. 多行原样保留 ─────────────────────────────────────────────────────────────
  await send('/notice-probe multiline');
  const multi = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.text?.includes('第二行'));
  check('多行文本换行原样保留（\\n 一字节不改）',
    multi.data.text === '第一行\n第二行\n第三行' && multi.data.level === 'info',
    JSON.stringify(multi.data.text));

  // ── 3. 超长截断且带标记 ─────────────────────────────────────────────────────────
  await send('/notice-probe long');
  const long = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.level === 'error');
  check('超长通知被截断到 8000 字符 + 明确标记，level 保持 error',
    long.data.text.length > 8000
    && long.data.text.slice(0, 8000) === 'x'.repeat(8000)
    && long.data.text.endsWith(MARK),
    { length: long.data.text.length, tail: long.data.text.slice(-24) });

  // ── 4. 对话框：返回默认值且**不静默**（两条 warning + 一条 info 回执）─────────────
  await send('/notice-probe dialog');
  const confirmWarn = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.text?.includes('对话框（confirm）'));
  const selectWarn = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.text?.includes('对话框（select）'));
  const dialogResult = await sub.waitFor((entry) => entry.event === 'session.notice' && entry.data?.text?.startsWith('confirm='));
  check('confirm/select ⇒ 返回默认值（false / undefined）且各发一条 warning（不静默）',
    confirmWarn.data.level === 'warning' && selectWarn.data.level === 'warning'
    && dialogResult.data.text === 'confirm=false select=undefined',
    { confirm: confirmWarn.data.text, select: selectWarn.data.text, result: dialogResult.data.text });

  sub.close();
  await new Promise((resolve) => setTimeout(resolve, 120));

  // ── 5. 无订阅者：不抛错（HTTP 202）──────────────────────────────────────────────
  const noSub = await send('/notice-probe basic');
  check('没有 SSE 订阅者时发通知不抛错（HTTP 202）', noSub.statusCode === 202, noSub.statusCode);

  // ── 6. 会话文件不新增任何条目（瞬时，不落盘）────────────────────────────────────
  const after = await readFile(sessionFile, 'utf8');
  check('全程会话文件一字未增（notify 不落盘）', after === before,
    { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) });

  print('checks', checks);
} catch (error) {
  primaryError = error;
} finally {
  if (appChild) await new Promise((resolve) => { appChild.once('exit', resolve); stopOwnedListener(appPort, appEntry, appChild.pid).then(resolve, resolve); });
  if (baseChild) await new Promise((resolve) => { baseChild.once('exit', resolve); stopOwnedListener(basePort, baseEntry, baseChild.pid).then(resolve, resolve); });
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  await appLog?.close();
  await baseLog?.close();
  await removeSandbox(sandbox, cleanupProblems);
  if (primaryError) {
    process.stderr.write(`base log: ${baseLogPath}\napp log: ${appLogPath}\n`);
    finishCleanup(primaryError, cleanupProblems);
  }
  finishCleanup(null, cleanupProblems);
  process.stdout.write('notice-channel: PASS\n');
}
