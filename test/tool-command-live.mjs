#!/usr/bin/env node
// 门：工具/bash 块的**两件事**（业主 2026-09-22 原话缺陷①与②）——
//   ① 「bash 工具的命令是不是只有一行？展开时应该显示命令的全部内容」
//   ② 「bash 工具的结果是不是不是实时更新的？」
//
// 修前的事实（先核实过，改前逐字）：
//   · `web/render.js` 的 `argSummary()`：`args.command.split('\n')[0].slice(0, 240)` ⇒
//     多行命令**只显示第一行**、第一行超 240 字也被切，而且**没有任何"看完整命令"的路**；
//   · 服务端 `server/base-logic.mjs` 的 `eventPayload()` 只映射 `tool_execution_start`/`end`，
//     `tool_execution_update` **故意不转**（老注释逐字：「`tool_execution_update`（partialResult）
//     故意不转 —— v2.1 的契约也只有 start/end，结果在 end 一次给全（未转 partial 是已知缺口）」）
//     ⇒ 任务单里「服务端发 …tool_execution_update…」那句**是对 2900/2902/2909 三行的误读**：
//     2902 正是那句「故意不转」的注释本身。所以②的修法是**两侧**：服务端新增 `session.tool_update`，
//     前端才画得出来。这条门把两侧都钉住。
//
// 覆盖：
//   甲 · 真沙箱（A `server/base.mjs` + B `server/app.mjs` + 假 provider + **真跑一个慢 bash**）：
//        原始 SSE 帧里必须按 start → update+ → end 出现，且 `text` 是**累积快照**（逐帧只增不减），
//        末帧 `session.tool_end.result` 才是正式结果；`/messages` 落盘的只有最终结果（边界证据）。
//   乙 · 真 Chromium + 假 API：
//        · 命令门 —— 多行且 >240 字的 bash 调用 ⇒ 折叠态**一行** ＋ 「N 行 · M 字」；
//          展开 ⇒ `.tool-command` 里是**逐字全文**（断言 `===` 全文、含 `\n`、且结尾若干字符在）；
//          复制按钮把**逐字原文**送进剪贴板（真读回来比，不是比属性）；
//        · 增量门 —— start ⇒ N 个 update ⇒ end：跑的过程中块里已有前几行增量、「已输出 N 行」诚实；
//          end 到了用**正式结果替换**那段实时尾（**不是叠加**）；没增量事件的工具**一个元素都不加**。
//   丙 · 两条反证臂（都在**副本树**上做同一件事的退路，各自必红）：
//        `--reverse-arm=firstline`：展开态也只给首行 ⇒ ① 必红；
//        `--reverse-arm=noupdate` ：前端忽略 `session.tool_update` ⇒ ② 必红。
//
// 已知边界（**如实写进报告与 docs/handoff.md**）：落盘的消息只存**最终结果** ⇒ 刷新页面/重连后
// 看不到中途输出（实时尾是纯 SSE 的东西，一条都不落盘）。
//
// 沙箱纪律：临时目录 + 随机高位端口（不用 7331/7321）、真 Chromium + 假 API、不碰真实 profile、
// 不 pkill（只按自己 spawn 的精确 pid 收尾）、日志落自己的沙箱。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/tool-command-live.mjs
//   CHROME_BIN=... node test/tool-command-live.mjs --reverse-arm=firstline   # ⇒ ① 必红
//   CHROME_BIN=... node test/tool-command-live.mjs --reverse-arm=noupdate    # ⇒ ② 必红
//   SOPHO_TOOLCMD_WEB=<把修前的 web/ 拷一份> —— 量「修前」那一半（截图用），断言照旧不许放宽。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sendJson, readBody, waitFor, WEB_ROOT, ROOT } from './ui-harness.mjs';

const SANDBOX = await mkdtemp(path.join(os.tmpdir(), 'sopho-toolcmd-'));
const REVERSE = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').slice('--reverse-arm='.length) || null;
const SHOT_DIR = process.env.SOPHO_TOOLCMD_SHOT_DIR ? path.resolve(process.env.SOPHO_TOOLCMD_SHOT_DIR) : path.join(SANDBOX, 'shots');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

// ── 反证臂：在**副本树**上做那件事的退路（改一处、只改一处；门不许依赖环境变量做手脚）──────────
/** 返回这一臂该用的 webRoot，以及「改了什么」的可读说明。 */
async function webRootForArm() {
  if (process.env.SOPHO_TOOLCMD_WEB) {
    return { webRoot: path.resolve(process.env.SOPHO_TOOLCMD_WEB), note: 'SOPHO_TOOLCMD_WEB（外部给的 web/ 副本）' };
  }
  if (REVERSE === null) return { webRoot: WEB_ROOT, note: '工作树里的 web/（修后）' };
  const copy = path.join(SANDBOX, 'web-reverse');
  await cp(WEB_ROOT, copy, { recursive: true });
  if (REVERSE === 'firstline') {
    // 退回「只显示第一行」：**展开态也只给首行**（`argSummary()` 的修前行为）。
    const file = path.join(copy, 'render.js');
    const source = await readFile(file, 'utf8');
    const needle = '    commandNode.textContent = command;\n';
    assert.ok(source.includes(needle), '反证臂没找到那行（render.js 变过？）');
    await writeFile(file, source.replace(needle, '    commandNode.textContent = command.split(\'\\n\')[0];\n'));
    return { webRoot: copy, note: '反证臂 firstline：展开态也只给首行（`command.split(\'\\n\')[0]`）' };
  }
  if (REVERSE === 'noupdate') {
    // 忽略 `tool_execution_update`：把前端那个监听的**事件名改掉**（语法仍合法，监听器等于没了）。
    const file = path.join(copy, 'app.js');
    const source = await readFile(file, 'utf8');
    const needle = "  sessionEvents.addEventListener('session.tool_update', (event) => {";
    assert.ok(source.includes(needle), '反证臂没找到那个监听器（app.js 变过？）');
    await writeFile(file, source.replace(needle, "  sessionEvents.addEventListener('session.tool_update.disabled', (event) => {"));
    return { webRoot: copy, note: '反证臂 noupdate：前端不再监听 `session.tool_update`' };
  }
  throw new Error(`unknown --reverse-arm=${REVERSE}`);
}

// ── 夹具：多行且超长的 bash 命令（业主原话就是「命令是不是只有一行」）──────────────────────
// 先想清要钉的是**两个独立的截断**，所以夹具同时踩中两个：
//   (a) 多行 ⇒ 修前只显示第一行；
//   (b) 第一行本身就 > 240 字 ⇒ 修前连那一行也 `slice(0, 240)` 过。
// ⇒ 折叠态那一行必须**逐字等于** `firstLine.slice(0, 240)`（证明折叠态行为没变），
//    展开态必须**逐字等于**全文（证明两个截断在展开态都没被用上）。
const LONG_FIRST_LINE = `set -euo pipefail; export PROJECT_ROOT="/srv/${'p'.repeat(200)}"; cd "$PROJECT_ROOT"`;
const LONG_COMMAND = [
  LONG_FIRST_LINE,
  'for f in */; do',
  '  echo "== $f"',
  '  rg -n --hidden --glob "!node_modules" -e "PREFIX_ONLY" "$f" | tee out.txt',
  'done',
].join('\n');
const LONG_COMMAND_LINES = LONG_COMMAND.split('\n').length;          // 5
const LONG_COMMAND_CHARS = [...LONG_COMMAND].length;
const LONG_COMMAND_TAIL = LONG_COMMAND.slice(-24);
const COLLAPSED_SUMMARY = LONG_FIRST_LINE.slice(0, 240);
// 只断言前缀不算数（派单原话）⇒ 结尾这一小段必须一起断；另钉两个截断真的都在夹具里。
assert.ok(LONG_COMMAND.includes('\n') && LONG_FIRST_LINE.length > 240 && LONG_COMMAND_TAIL.length === 24
  && COLLAPSED_SUMMARY !== LONG_FIRST_LINE, `夹具没同时踩中两个截断：lines=${LONG_COMMAND_LINES} firstLine=${LONG_FIRST_LINE.length} chars=${LONG_COMMAND_CHARS}`);

const HISTORY_RESULT = 'HISTORY-RESULT';
const ONLINE_RESULT = 'ONLINE-RESULT-BODY';

const SESSION = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const LIVE_CALL = 'call-live-1';
const QUIET_CALL = 'call-quiet-1';

const sessions = [{
  id: SESSION, name: '命令全文与实时输出', parentId: null, archived: false, status: 'working', statusLabel: '工作中',
  unread: false, modifiedAt: '2026-09-22T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];

// 一条已完成的 bash 工具卡（历史那一路：命令全文/复制/展开都在这里量）。
const historyMessages = [
  { entryId: 'u-1', parentId: null, timestamp: '2026-09-22T08:00:01.000Z', kind: 'message', role: 'user', content: [{ type: 'text', text: '跑一下' }], text: '跑一下', images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] },
  {
    entryId: 'a-1', parentId: 'u-1', timestamp: '2026-09-22T08:00:02.000Z', kind: 'message', role: 'assistant',
    content: [], text: '', images: [], stopReason: 'toolUse', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'tool', toolCallId: 'call-history-1', name: 'bash', args: { command: LONG_COMMAND }, status: 'done-success', isError: false, result: HISTORY_RESULT },
      // 第二条：**短单行**命令（今天的常见形状）⇒ 三样新元素**一个都不许加**。
      { type: 'tool', toolCallId: 'call-history-2', name: 'bash', args: { command: 'echo hi' }, status: 'done-success', isError: false, result: 'hi' },
    ],
  },
  { entryId: 't-1', parentId: 'a-1', timestamp: '2026-09-22T08:00:03.000Z', kind: 'message', role: 'toolResult', content: [{ type: 'text', text: HISTORY_RESULT }], text: HISTORY_RESULT, images: [], stopReason: null, errorMessage: null, toolCallId: 'call-history-1', toolName: 'bash', isError: false, aborted: false, extras: [] },
];

// ───────────────────────────── 甲 · 真沙箱：原始 SSE 帧（真跑一个慢 bash）─────────────────────────────

const SLOW_LINES = ['LINE-1', 'LINE-2', 'LINE-3', 'LINE-4', 'LINE-5'];
// 慢**且多行**的命令：多行是为了让直播卡上也能量到「命令全文」那条路（同一个 `toolCard()`）。
const SLOW_COMMAND = ['for i in 1 2 3 4 5; do', '  echo LINE-$i', '  sleep 0.35', 'done'].join('\n');

async function runServerArm() {
  const home = path.join(SANDBOX, 'server-home');
  const cwd = path.join(SANDBOX, 'server-cwd');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const providerPort = await reservePort();
  const basePort = await reservePort(new Set([providerPort]));
  const appPort = await reservePort(new Set([providerPort, basePort]));

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions', apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-slow', name: 'Fake Slow', contextWindow: 8192, maxTokens: 2048 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-slow',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const chunk = (delta, finishReason = null) => ({
    id: `chatcmpl-${finishReason ?? 'delta'}`, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'fake-slow',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    const body = JSON.parse(await readBody(request));
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!hasToolResult) {
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '先跑个慢命令。' }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-server-slow', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: SLOW_COMMAND }) } }] }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '跑完了。' }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

  const baseLog = await open(path.join(SANDBOX, 'base.log'), 'w');
  const appLog = await open(path.join(SANDBOX, 'app.log'), 'w');
  const base = spawn(process.execPath, [path.join(ROOT, 'server', 'base.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
      PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd, SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server', 'app.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: WEB_ROOT,
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { statusCode: response.status, value };
  };

  let request;
  const report = { note: 'realtime:false（未走到）' };
  try {
    await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 25_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'live tool updates' } });
    assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
    const sessionId = created.value.id;

    request = http.request({ host: '127.0.0.1', port: appPort, path: `/api/sessions/${sessionId}/events`, headers: { accept: 'text/event-stream' } });
    const frames = [];
    let buffer = '';
    await new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (incoming) => {
        assert.equal(incoming.statusCode, 200, `SSE status ${incoming.statusCode}`);
        incoming.setEncoding('utf8');
        incoming.on('data', (text) => {
          buffer += text;
          let separator;
          while ((separator = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (eventLine && dataLine) frames.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
          }
        });
        resolve();
      });
      request.end();
    });
    await waitFor(() => frames.some((frame) => frame.event === 'session.snapshot'), 'no session.snapshot frame');

    const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '跑一个慢工具' } });
    assert.equal(accepted.statusCode, 202);
    await waitFor(() => frames.filter((frame) => frame.event === 'session.end').length >= 2, 'no two session.end frames', 45_000);
    request.destroy();

    const updates = frames.filter((frame) => frame.event === 'session.tool_update');
    const starts = frames.filter((frame) => frame.event === 'session.tool_start');
    const ends = frames.filter((frame) => frame.event === 'session.tool_end');
    const startIndex = frames.findIndex((frame) => frame.event === 'session.tool_start');
    const endIndex = frames.findIndex((frame) => frame.event === 'session.tool_end');

    print('SSE 工具帧（服务端原样，逐帧）', frames.filter((frame) => frame.event.startsWith('session.tool_')).map((frame) => `${frame.event} ${JSON.stringify(frame.data)}`));
    print('SSE 工具帧统计', { tool_start: starts.length, tool_update: updates.length, tool_end: ends.length, startIndex, endIndex });

    assert.equal(starts.length, 1, '服务端必须转发一次 session.tool_start');
    assert.equal(ends.length, 1, '服务端必须转发一次 session.tool_end');
    assert.ok(updates.length >= 1, `服务端必须转发 ≥1 次 session.tool_update（实测 ${updates.length}）—— 修前这里恒为 0`);
    assert.ok(starts[0].data.toolCallId === 'call-server-slow' && ends[0].data.toolCallId === 'call-server-slow');
    assert.ok(updates.every((frame) => frame.data.toolCallId === 'call-server-slow'));
    // 顺序：start 之后、end 之前（而且 endIndex 之前的每一帧 update 都排在 start 之后）。
    const firstUpdateIndex = frames.findIndex((frame) => frame.event === 'session.tool_update');
    assert.ok(startIndex >= 0 && firstUpdateIndex > startIndex && endIndex > firstUpdateIndex,
      `顺序必须是 start < update < end（实测 ${startIndex} < ${firstUpdateIndex} < ${endIndex}）`);
    for (const frame of updates) {
      assert.ok(Number.isFinite(Date.parse(frame.data.at)), `session.tool_update 必须带可解析的 at（实测 ${JSON.stringify(frame.data.at)}）`);
      assert.equal(typeof frame.data.text, 'string');
    }
    // **累积快照**（不是 delta）：逐帧只增不减，且**不是**把 delta 拼起来的产物。
    // 这条判据的意义：前端若把它当 delta append，串起来的文本会长过末帧 —— 必然会多出内容。
    const texts = updates.map((frame) => frame.data.text);
    for (let index = 1; index < texts.length; index += 1) {
      assert.ok(texts[index].length >= texts[index - 1].length, `增量帧必须是累积快照（第 ${index} 帧短于第 ${index - 1} 帧）`);
      assert.ok(texts[index].startsWith(texts[index - 1].slice(0, Math.min(texts[index - 1].length, 60))), `第 ${index} 帧必须与上一帧同源（前缀一致）`);
    }
    assert.ok(texts[texts.length - 1].includes(SLOW_LINES[0]), `末帧必须已经含第一行（实测 ${JSON.stringify(texts[texts.length - 1].slice(0, 80))}）`);
    // 真慢命令 ⇒ 中途那一帧**不可能**已有全部 5 行（否则就不是"实时"，是"结束才给"）。
    assert.ok(texts.some((text) => !SLOW_LINES.every((line) => text.includes(line))),
      `必须存在一帧还没跑完（否则这一相就不是实时的）：${JSON.stringify(texts)}`);
    const concatenated = texts.join('');
    print('增量帧行数（累积快照逐帧）', texts.map((text) => text.trim() === '' ? 0 : text.trim().split('\n').length));
    assert.ok(concatenated.length > texts[texts.length - 1].length, '（对照）把累积快照当 delta 拼会得到更长的串 —— 前端不许这么干');
    // 末帧的 totalLines 是**真实总行数**（bash 快照自带），不是这一帧的行数。
    const lastTruncation = updates[updates.length - 1].data;
    print('增量帧的行数说法（末帧）', { totalLines: lastTruncation.totalLines, emittedLines: lastTruncation.emittedLines, truncated: lastTruncation.truncated });
    assert.ok(lastTruncation.totalLines === null || Number.isFinite(lastTruncation.totalLines));
    assert.equal(lastTruncation.truncated, false, '5 行远没到截断阈值 ⇒ truncated 必须是 false（不许凭空说被截断）');
    // pi 的 bash 只在截断时给 `truncation` ⇒ 未被截断的帧必须标成「这一帧就是全部」（行数可精确算）。
    assert.equal(lastTruncation.complete, true,
      `未被截断的帧必须 complete:true（pi 的 details 在、里面没有 truncation）—— 实测 ${JSON.stringify({ complete: lastTruncation.complete, truncated: lastTruncation.truncated })}`);

    // 正式结果：`session.tool_end.result` 是**全部输出**（与实时尾同源，但这一份是定稿）。
    for (const line of SLOW_LINES) assert.ok(ends[0].data.result.includes(line), `session.tool_end.result 必须含 ${line}`);
    assert.equal(ends[0].data.isError, false);

    // **边界证据**：落盘的只有**最终结果** —— 中途那些增量一个字都不在会话文件里。
    const messages = await api(`/sessions/${sessionId}/messages`);
    const assistant = (messages.value.messages || []).find((message) => message.role === 'assistant');
    const toolPart = (assistant?.parts || []).find((part) => part.type === 'tool');
    assert.ok(toolPart, '落盘历史里必须有这条工具卡');
    assert.equal(toolPart.status, 'done-success');
    for (const line of SLOW_LINES) assert.ok(toolPart.result.includes(line));
    const partialOnly = updates[0].data.text;
    print('边界：落盘那份 vs 第一帧增量', { 落盘字符数: toolPart.result.length, 第一帧增量字符数: partialOnly.length, '落盘里有实时尾字段吗': ['partial', 'live', 'tool_update'].filter((key) => key in toolPart) });
    assert.ok(!('partial' in toolPart) && !('live' in toolPart) && !('tool_update' in toolPart),
      '落盘的 tool part 上不许有任何"实时尾"字段（实时输出是纯 SSE 的东西，一条都不落盘）');

    report.note = `realtime:true（tool_update ${updates.length} 帧，累积快照 ${texts.map((text) => text.length).join('→')} 字节）`;
    return { frameCounts: { start: starts.length, update: updates.length, end: ends.length }, report };
  } finally {
    try { request?.destroy(); } catch {}
    for (const child of [app, base]) {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await baseLog.close();
    await appLog.close();
  }
}

// ───────────────────────────── 丙 · 帧成本（诚实披露）─────────────────────────────
//
// `session.tool_update` 的 `text` 是**整段累积快照**（不是 delta）⇒ 一帧就要重发整段尾部。
// pi 的 bash 快照本来就截断到「最后 2000 行 / 50KB」（`truncate.js` 的 DEFAULT_MAX_*），
// 所以单帧上界是 ~50KB；节流 100ms ⇒ 理论尖尖是 ~65KB × 10/s。
// 这一臂把那个上界**量出来**（不写阈值，只断言「确实被截住了」）—— 本件不把「帧很大」
// 写成「没问题」。拿真实大头输出跑一遍，数字进报告。
const BIG_LINES = 2600;
const BIG_COMMAND = `for i in $(seq 1 ${BIG_LINES}); do echo "BIGLINE-$i-${'z'.repeat(40)}"; done`;

async function runFrameCostArm() {
  const home = path.join(SANDBOX, 'cost-home');
  const cwd = path.join(SANDBOX, 'cost-cwd');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const providerPort = await reservePort();
  const basePort = await reservePort(new Set([providerPort]));
  const appPort = await reservePort(new Set([providerPort, basePort]));
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox-key', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: 'fake-big', name: 'Fake Big', contextWindow: 8192, maxTokens: 2048 }] } },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-big', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);

  const chunk = (delta, finishReason = null) => ({ id: `chatcmpl-${finishReason ?? 'delta'}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-big', choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    const body = JSON.parse(await readBody(request));
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!hasToolResult) {
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-cost', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: BIG_COMMAND }) } }] }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'done' }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

  const baseLog = await open(path.join(SANDBOX, 'cost-base.log'), 'w');
  const appLog = await open(path.join(SANDBOX, 'cost-app.log'), 'w');
  const base = spawn(process.execPath, [path.join(ROOT, 'server', 'base.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'), PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort), SOPHO_DEFAULT_CWD: cwd, SOPHO_MAX_HOT: '4' },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server', 'app.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort), SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: WEB_ROOT },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, { method, headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    try { return { statusCode: response.status, value: text ? JSON.parse(text) : null }; } catch { return { statusCode: response.status, value: text }; }
  };
  let request;
  try {
    await waitFor(async () => (await api('/host')).statusCode === 200, 'cost sandbox did not become ready', 25_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'frame cost' } });
    assert.equal(created.statusCode, 201);
    const sessionId = created.value.id;
    request = http.request({ host: '127.0.0.1', port: appPort, path: `/api/sessions/${sessionId}/events`, headers: { accept: 'text/event-stream' } });
    const sizes = [];
    let buffer = '';
    await new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (incoming) => {
        incoming.setEncoding('utf8');
        incoming.on('data', (text) => {
          buffer += text;
          let separator;
          while ((separator = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            if (block.includes('event: session.tool_update')) sizes.push(Buffer.byteLength(block, 'utf8'));
          }
        });
        resolve();
      });
      request.end();
    });
    assert.equal((await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '大头输出' } })).statusCode, 202);
    await waitFor(() => sizes.length > 0, 'no tool_update frame to measure', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    request.destroy();
    const total = sizes.reduce((sum, value) => sum + value, 0);
    const report = { frames: sizes.length, maxBytesPerFrame: Math.max(...sizes), totalBytes: total, avgBytes: Math.round(total / sizes.length) };
    print('丙 · 一帧 session.tool_update 的字节数（原样 SSE 块，含 event:/data: 行）', { ...report, first: sizes.slice(0, 3), last: sizes.slice(-3) });
    assert.ok(report.maxBytesPerFrame < 96 * 1024, `单帧必须被 pi 的 50KB 截断上界控住（实测最大 ${report.maxBytesPerFrame} 字节）`);
    print('丙 · 诚实披露', `${BIG_LINES} 行输出 ⇒ ${report.frames} 帧、总量 ${(total / 1024).toFixed(1)} KB、单帧最大 ${(report.maxBytesPerFrame / 1024).toFixed(1)} KB（累积快照，帧与输出量成平方量级；pi 的 2000 行/50KB 截断把它截住了）`);
    return report;
  } finally {
    try { request?.destroy(); } catch {}
    for (const child of [app, base]) {
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await baseLog.close();
    await appLog.close();
  }
}

// ───────────────────────────── 乙 · 真 Chromium + 假 API ─────────────────────────────

async function runFrontendArm({ webRoot }) {
  const state = { stream: null, streaming: false };
  const routes = async (request, response, url) => {
    if (url.pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
    if (url.pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
    if (url.pathname === '/api/tree') { sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }); return true; }
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
    if (match) {
      if (match[1] !== SESSION) { sendJson(response, 404, { message: 'not found' }); return true; }
      const action = match[2] ?? null;
      if (action === null) { sendJson(response, 200, { name: sessions[0].name, runtime: { isStreaming: state.streaming, isCompacting: false, isRetrying: false }, observability: null }); return true; }
      if (action === 'messages') { sendJson(response, 200, { messages: historyMessages, extras: [], compaction: { atIndex: null }, observability: null }); return true; }
      if (action === 'commands') { sendJson(response, 200, { streaming: state.streaming, commands: [] }); return true; }
      if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
      if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: state.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
        state.stream = response;
        response.once('close', () => { if (state.stream === response) state.stream = null; });
        return true;
      }
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const { name, data } = JSON.parse(await readBody(request));
      if (!state.stream || state.stream.destroyed) { sendJson(response, 409, { message: 'session stream unavailable' }); return true; }
      if (name === 'session.start') state.streaming = true;
      state.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      sendJson(response, 200, { ok: true });
      return true;
    }
    return false;
  };

  const ui = await boot({ routes, webRoot, width: 1200, height: 760 });
  const failures = [];
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(name);
    if (ok) { print(`✓ ${name}`, detail); return; }
    failures.push(`${name}｜${detail}`);
    print(`✗ ${name}`, detail);
  };
  const evaluate = ui.evaluate;
  try {
    await ui.browser.send('Browser.grantPermissions', {
      origin: `http://127.0.0.1:${ui.port}`,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
    await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION}"]')`), 'page did not load');
    await evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
    await waitFor(() => state.stream !== null, 'session events stream did not connect');
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .tool-card[data-tool-call-id="call-history-1"]').length === 1`), 'history tool card did not render');
    await mkdir(SHOT_DIR, { recursive: true });

    // ── 甲：命令可展开成逐字全文（历史卡那一路）─────────────────────────────────────
    const collapsed = await evaluate(`(() => {
      const card = document.querySelector('#messages .tool-card[data-tool-call-id="call-history-1"]');
      const row = card.querySelector('.tool-call');
      const args = card.querySelector('.tool-args');
      const full = card.querySelector('.tool-command');
      const toggle = card.querySelector('.tool-args-toggle');
      const copy = card.querySelector('.tool-copy');
      const meta = card.querySelector('.tool-args-meta');
      return {
        rowHeight: Math.round(row.getBoundingClientRect().height),
        // 「没被新增元素撑高」的机械做法：量一次 → 摘掉三样新元素（连 data-command-clip 也摘掉，
        // 那才是修前的 DOM）→ 再量一次。
        rowHeightWithoutExtras: (() => {
          const summary = args.querySelector('.tool-args-summary');
          const marker = document.createComment('probe');
          const anchorNode = summary ?? args.firstChild;
          args.insertBefore(marker, anchorNode ? anchorNode.nextSibling : null);
          const extras = Array.from(args.children).filter((child) => child !== summary);
          for (const child of extras) child.remove();
          const saved = args.getAttribute('data-command-clip');
          args.removeAttribute('data-command-clip');
          const height = Math.round(row.getBoundingClientRect().height);
          if (saved !== null) args.setAttribute('data-command-clip', saved);
          for (const child of extras) args.insertBefore(child, marker);
          marker.remove();
          return height;
        })(),
        // 折叠态「恰好一行」的证据：摘要是 nowrap + ellipsis 且**真的被裁了**（scrollWidth > clientWidth）。
        summaryClip: (() => {
          const summary = args.querySelector('.tool-args-summary');
          if (!summary) return null;
          const style = getComputedStyle(summary);
          return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflow, clipped: summary.scrollWidth > summary.clientWidth + 1, height: Math.round(summary.getBoundingClientRect().height), width: Math.round(summary.getBoundingClientRect().width) };
        })(),
        summary: card.querySelector('.tool-args-summary')?.textContent ?? null,
        // 诊断：哪一项把行撑到了 37px。
        argsHeight: Math.round(args.getBoundingClientRect().height),
        childHeights: Array.from(args.children).map((child) => [child.className || child.tagName.toLowerCase(), Math.round(child.getBoundingClientRect().height)]),
        rowItemHeights: Array.from(row.children).map((child) => [child.className || child.tagName.toLowerCase(), Math.round(child.getBoundingClientRect().height), getComputedStyle(child).alignSelf]),
        meta: meta?.textContent ?? null,
        hasToggle: !!toggle, hasCopy: !!copy, hasFull: !!full,
        fullHidden: full ? full.hidden : null,
        fullText: full ? full.textContent : null,
        toggleLabel: toggle?.textContent ?? null,
        copyLabel: copy?.textContent ?? null,
        argsChildren: Array.from(args.children).map((child) => child.tagName.toLowerCase() + '.' + child.className),
        rowChildren: Array.from(row.children).map((child) => child.tagName.toLowerCase() + '.' + child.className),
        cardChildren: Array.from(card.children).map((child) => child.tagName.toLowerCase() + '.' + child.className),
        // 短单行命令那一张卡（对照：三样新元素一个都不该有）。
        shortArgsChildren: Array.from(document.querySelector('#messages .tool-card[data-tool-call-id="call-history-2"] .tool-args')?.children ?? []).map((child) => child.tagName.toLowerCase() + '.' + child.className),
        shortSummary: document.querySelector('#messages .tool-card[data-tool-call-id="call-history-2"] .tool-args-summary')?.textContent ?? null,
        shortRowHeight: Math.round(document.querySelector('#messages .tool-card[data-tool-call-id="call-history-2"] .tool-call')?.getBoundingClientRect().height ?? -1),
      };
    })()`);
    print('修后 · 折叠态（历史卡）', collapsed);
    await ui.screenshot(path.join(SHOT_DIR, 'after-command-collapsed.png'));

    check('折叠态：命令那一段**恰好一行**，而且没比修前高（26px 单行语言）',
      collapsed.rowHeight <= 26 && collapsed.rowHeight <= collapsed.rowHeightWithoutExtras,
      JSON.stringify({ withExtras: collapsed.rowHeight, withoutExtras: collapsed.rowHeightWithoutExtras }));
    check('折叠态「一行」是真的一行：摘要 `nowrap + ellipsis` 且**真的被裁了**（撑不下就省略，全文在展开里）',
      collapsed.summaryClip?.whiteSpace === 'nowrap' && collapsed.summaryClip?.textOverflow === 'ellipsis' && collapsed.summaryClip?.clipped === true,
      JSON.stringify(collapsed.summaryClip));
    check('折叠态：那一行是**一条逻辑行**（没有换行符），且逐字等于 `argSummary()` 的**首行 + 240 字上限**摘要（既有行为未改）',
      collapsed.summary !== null && !String(collapsed.summary).includes('\n') && collapsed.summary === COLLAPSED_SUMMARY,
      JSON.stringify({ got: collapsed.summary === null ? null : collapsed.summary.length, want: COLLAPSED_SUMMARY.length, equal: collapsed.summary === COLLAPSED_SUMMARY, hasNewline: String(collapsed.summary).includes('\n') }));
    check('折叠态：标出「后面还有」的行数/字数',
      collapsed.meta === `${LONG_COMMAND_LINES} 行 · ${LONG_COMMAND_CHARS} 字`, JSON.stringify({ meta: collapsed.meta, want: `${LONG_COMMAND_LINES} 行 · ${LONG_COMMAND_CHARS} 字` }));
    check('展开态默认**收起**（`hidden`），全文节点已经在 DOM 里但也藏起来',
      collapsed.hasFull === true && collapsed.fullHidden === true, JSON.stringify({ hasFull: collapsed.hasFull, hidden: collapsed.fullHidden }));
    check('展开/复制两个按钮都在，且入口挂在 `.tool-args` **里面**（`.tool-call` 的直接子元素形状没变）',
      collapsed.hasToggle && collapsed.hasCopy
      && JSON.stringify(collapsed.rowChildren) === JSON.stringify(['strong.tool-name', 'span.tool-args', 'button.tool-toggle'])
      && JSON.stringify(collapsed.cardChildren) === JSON.stringify(['div.message-role', 'div.tool-call', 'div.tool-output', 'div.annotate']),
      JSON.stringify({ rowChildren: collapsed.rowChildren, cardChildren: collapsed.cardChildren }));
    check('短单行命令：三样新元素**一个都不加**（与今天逐字一致，且仍是 26px 单行）',
      JSON.stringify(collapsed.shortArgsChildren) === JSON.stringify(['span.tool-args-summary'])
      && collapsed.shortSummary === 'echo hi' && collapsed.shortRowHeight <= 26,
      JSON.stringify({ children: collapsed.shortArgsChildren, summary: collapsed.shortSummary, rowHeight: collapsed.shortRowHeight }));

    // 展开 ⇒ 逐字全文（断言**整段相等** ＋ 含 `\n` ＋ 结尾若干字符都在 —— 只断前缀不算数）。
    const expanded = await evaluate(`(() => {
      document.querySelector('#messages .tool-card[data-tool-call-id="call-history-1"] .tool-args-toggle')?.click();
      const card = document.querySelector('#messages .tool-card[data-tool-call-id="call-history-1"]');
      const full = card.querySelector('.tool-command');
      if (!full) return { hidden: null, text: null, whiteSpace: null, maxHeight: null, overflow: null, label: null, rowHeight: Math.round(card.querySelector('.tool-call').getBoundingClientRect().height) };
      return { hidden: full.hidden, text: full.textContent, whiteSpace: getComputedStyle(full).whiteSpace, maxHeight: getComputedStyle(full).maxHeight, overflow: getComputedStyle(full).overflow, label: card.querySelector('.tool-args-toggle').textContent, rowHeight: Math.round(card.querySelector('.tool-call').getBoundingClientRect().height) };
    })()`);
    print('修后 · 展开态（历史卡）', { ...expanded, text: `${String(expanded.text).slice(0, 40)} … ${String(expanded.text).slice(-24)}`, length: expanded.text === null ? null : expanded.text.length });
    await ui.screenshot(path.join(SHOT_DIR, 'after-command-expanded.png'));

    check('展开 ⇒ 全文节点显示出来了', expanded.hidden === false, JSON.stringify({ hidden: expanded.hidden }));
    check('展开 ⇒ DOM 里是**逐字全文**（整段相等，不是前缀）',
      expanded.text === LONG_COMMAND, JSON.stringify({ got: expanded.text === null ? null : expanded.text.length, want: LONG_COMMAND.length, equal: expanded.text === LONG_COMMAND }));
    check('展开 ⇒ 保留换行与空格（`white-space: pre-wrap`，`\\n` 真在文本里）',
      expanded.whiteSpace === 'pre-wrap' && String(expanded.text).includes('\n') && String(expanded.text).split('\n').length === LONG_COMMAND_LINES,
      JSON.stringify({ whiteSpace: expanded.whiteSpace, lines: String(expanded.text).split('\n').length }));
    check('展开 ⇒ 结尾若干字符也在（只断前缀会漏掉尾部被切）',
      String(expanded.text).endsWith(LONG_COMMAND_TAIL), JSON.stringify({ tail: String(expanded.text).slice(-24), want: LONG_COMMAND_TAIL }));
    check('展开 ⇒ 限高 + 内部滚动（不撑爆布局）',
      expanded.maxHeight !== 'none' && /auto|scroll/.test(expanded.overflow), JSON.stringify({ maxHeight: expanded.maxHeight, overflow: expanded.overflow }));
    check('展开 ⇒ 按钮文案翻成「收起命令」', expanded.label === '收起命令', JSON.stringify(expanded.label));

    // 复制 ⇒ **逐字原文**（真从剪贴板读回来比，不只看属性）。
    const copyResult = await evaluate(`(async () => {
      const card = document.querySelector('#messages .tool-card[data-tool-call-id="call-history-1"]');
      const copy = card.querySelector('.tool-copy');
      if (!copy) return { clipLength: null, error: null, label: null, fullLength: null, rawCrlf: null, rawLf: null, normalized: null, missing: true };
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      let clip = null; let error = null;
      try { clip = await navigator.clipboard.readText(); } catch (thrown) { error = String(thrown && thrown.message || thrown); }
      // 换行一律用 fromCharCode 拼，**不在表达式里写反斜杠转义**（模板字符串会先把它们吃一遍）。
      const LF = String.fromCharCode(10);
      const CR = String.fromCharCode(13);
      return { clipLength: clip === null ? null : clip.length, error, label: copy.textContent, fullLength: card.querySelector('.tool-command')?.textContent.length ?? null,
        rawCrlf: clip === null ? null : (clip.split(CR + LF).length - 1), rawLf: clip === null ? null : (clip.split(LF).length - 1),
        normalized: clip === null ? null : clip.split(CR + LF).join(LF) };
    })()`);
    // Windows 的剪贴板把 LF 规范化成 CRLF（实测 382 = 378 + 4 个换行）—— 这是 OS 的行为，不是应用的。
    // 比对前**归一化换行**，其余逐字比；把原始两个数字一起打出来（不藏）。
    copyResult.newlineNote = `raw CRLF ${copyResult.rawCrlf} / LF ${copyResult.rawLf}（源文只有 ${LONG_COMMAND.split('\n').length - 1} 个 LF）`;
    print('复制按钮（真读剪贴板）', { clipLength: copyResult.clipLength, error: copyResult.error, label: copyResult.label, 换行: copyResult.newlineNote, equalNormalized: copyResult.normalized === LONG_COMMAND });
    check('复制 ⇒ 剪贴板里是**逐字原文**（整段相等；不是首行、不是那个 240 字摘要）',
      copyResult.normalized !== null && copyResult.normalized === LONG_COMMAND && copyResult.normalized !== COLLAPSED_SUMMARY,
      JSON.stringify({ clipLength: copyResult.clipLength, want: LONG_COMMAND.length, error: copyResult.error, missing: copyResult.missing === true, equalNormalized: copyResult.normalized === LONG_COMMAND, 换行规范化: copyResult.newlineNote }));

    // 窄屏：展开态不许把 #messages 顶出横向滚动（长命令靠 pre-wrap 换行，不靠横向滚）。
    await ui.resize(420, 820);
    const narrow = await evaluate(`(() => {
      const root = document.querySelector('#messages');
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    })()`);
    await ui.screenshot(path.join(SHOT_DIR, 'after-command-expanded-narrow.png'));
    await ui.resize(1200, 760);
    check('窄屏（420px）展开态没有横向溢出', narrow.scrollWidth <= narrow.clientWidth + 1, JSON.stringify(narrow));

    // ── 乙：实时输出（增量帧 ⇒ 跑的过程中就有，结束被正式结果**替换**）───────────────
    const partText = (callId) => evaluate(`(() => {
      const card = document.querySelector('#messages .live-message .tool-card[data-tool-call-id="${callId}"]');
      if (!card) return null;
      const output = card.querySelector('.tool-output');
      return {
        live: !!card.querySelector('.tool-live'),
        liveBody: card.querySelector('.tool-live-body')?.textContent ?? null,
        liveMeta: card.querySelector('.tool-live-meta')?.textContent ?? null,
        result: card.querySelector('.tool-result')?.textContent ?? null,
        outputChildren: Array.from(output?.children ?? []).map((child) => child.className),
        outputText: output?.textContent ?? null,
        state: card.dataset.state,
      };
    })()`);

    await ui.emit('session.start', { role: 'assistant' });
    await ui.frames(1);
    await ui.emit('session.tool_start', { toolCallId: LIVE_CALL, name: 'bash', args: { command: SLOW_COMMAND }, startedAt: new Date().toISOString() });
    await ui.frames(2);
    const beforeAnyUpdate = await partText(LIVE_CALL);
    check('没有增量事件时**一个元素都不加**（行为与今天一致，不造假进度）',
      beforeAnyUpdate !== null && beforeAnyUpdate.live === false
      // 卡正文第一句是「本机缺省 bash 超时」那行注记（`tool-timeout-note`，2026-10-10 加）——
      // 它与「增量帧」无关（没有 `tool_update` 就**没有** `.tool-live`），所以这里把**那行注记**算进去、
      // 仍然断言：除了注记与结果，**一个元素都不加**。
      && JSON.stringify(beforeAnyUpdate.outputChildren) === JSON.stringify(['tool-timeout-note', 'tool-result'])
      && beforeAnyUpdate.liveMeta === null,
      JSON.stringify(beforeAnyUpdate));

    // N 个增量帧（累积快照，逐帧变长）。
    const SNAPSHOTS = ['LINE-1\n', 'LINE-1\nLINE-2\n', 'LINE-1\nLINE-2\nLINE-3\n'];
    for (const snapshot of SNAPSHOTS) {
      await ui.emit('session.tool_update', {
        toolCallId: LIVE_CALL, name: 'bash', text: snapshot,
        truncated: false, truncatedBy: null, totalLines: null, emittedLines: null, lastLinePartial: false, complete: true,
        at: new Date().toISOString(),
      });
      await ui.frames(2);
    }
    const midRun = await partText(LIVE_CALL);
    print('修后 · 跑的过程中（第 3 帧增量后）', midRun);
    await ui.screenshot(path.join(SHOT_DIR, 'after-live-running.png'));
    check('跑的过程中：块里**已经有**前几行增量（修前恒为 0）',
      midRun.live === true && midRun.liveBody.includes('LINE-1') && midRun.liveBody.includes('LINE-3'),
      JSON.stringify({ live: midRun.live, body: midRun.liveBody }));
    check('跑的过程中：实时尾就是**最新那份累积快照**（不是把帧拼起来 —— 拼起来 LINE-1 会出现 3 次）',
      midRun.liveBody === SNAPSHOTS[SNAPSHOTS.length - 1] && (midRun.liveBody.match(/LINE-1/g) || []).length === 1,
      JSON.stringify({ body: midRun.liveBody, LINE1Count: (String(midRun.liveBody).match(/LINE-1/g) || []).length }));
    check('跑的过程中：行数**诚实**（「已输出 3 行」）',
      midRun.liveMeta === '实时 · 已输出 3 行', JSON.stringify({ meta: midRun.liveMeta }));

    // 截断那一档：总数与这一帧的行数都要说清（不许把尾部当全部）。
    await ui.emit('session.tool_update', {
      toolCallId: LIVE_CALL, name: 'bash', text: 'TAIL-A\nTAIL-B\nTAIL-C\n',
      truncated: true, truncatedBy: 'lines', totalLines: 50, emittedLines: 3, lastLinePartial: false, complete: false, at: new Date().toISOString(),
    });
    await ui.frames(2);
    const truncatedView = await partText(LIVE_CALL);
    check('快照被截断时说清「共 N 行 / 这一帧只给尾部 M 行」（不把尾部当全部）',
      truncatedView.liveMeta === '实时 · 已输出 50 行（这一帧只给了尾部 3 行）', JSON.stringify({ meta: truncatedView.liveMeta }));

    // 服务端**没说**是不是全部（`complete` 不是 true）⇒ 只能说**下界**，绝不把「未知」画成「0 行」。
    await ui.emit('session.tool_update', {
      toolCallId: LIVE_CALL, name: 'bash', text: 'X-1\nX-2\n',
      truncated: false, truncatedBy: null, totalLines: null, emittedLines: null, lastLinePartial: false, complete: false, at: new Date().toISOString(),
    });
    await ui.frames(2);
    const unknownView = await partText(LIVE_CALL);
    check('服务端没说「这一帧是不是全部」时说「至少 N 行」（不编 0，也不假称精确）',
      unknownView.liveMeta === '实时 · 至少 2 行（服务端没说这一帧是不是全部）', JSON.stringify({ meta: unknownView.liveMeta }));

    // 跑着的卡上命令全文那条路也在（同一个 `toolCard()`）。
    const liveCommand = await evaluate(`(() => {
      const card = document.querySelector('#messages .live-message .tool-card[data-tool-call-id="${LIVE_CALL}"]');
      return { meta: card?.querySelector('.tool-args-meta')?.textContent ?? null, hasFull: !!card?.querySelector('.tool-command'), full: card?.querySelector('.tool-command')?.textContent ?? null };
    })()`);
    check('直播卡上命令全文那条路也在（直播与历史共用同一个 `toolCard()`）',
      liveCommand.hasFull === true && liveCommand.full === SLOW_COMMAND, JSON.stringify({ hasFull: liveCommand.hasFull, full: liveCommand.full }));

    // 结束：正式结果**替换**实时尾（不是叠加）。
    await ui.emit('session.tool_end', { toolCallId: LIVE_CALL, name: 'bash', isError: false, result: ONLINE_RESULT, details: null, content: [{ type: 'text', text: ONLINE_RESULT }], endedAt: new Date().toISOString() });
    await ui.frames(3);
    const afterEnd = await partText(LIVE_CALL);
    print('修后 · 结束之后', afterEnd);
    await ui.screenshot(path.join(SHOT_DIR, 'after-live-ended.png'));
    check('结束 ⇒ 实时尾**被正式结果替换**（不是叠加）',
      afterEnd.live === false && afterEnd.result === ONLINE_RESULT
      && !String(afterEnd.outputText).includes('X-1') && !String(afterEnd.outputText).includes('TAIL-A')
      && JSON.stringify(afterEnd.outputChildren) === JSON.stringify(['tool-timeout-note', 'tool-result']),
      JSON.stringify({ live: afterEnd.live, result: afterEnd.result, outputChildren: afterEnd.outputChildren }));
    check('结束 ⇒ 卡面状态翻成 done-success', afterEnd.state === 'done-success', JSON.stringify({ state: afterEnd.state }));

    // 没增量的那一张卡：结束前后都不该有实时尾（与今天逐字一致）。
    await ui.emit('session.tool_start', { toolCallId: QUIET_CALL, name: 'read', args: { path: 'a.txt' }, startedAt: new Date().toISOString() });
    await ui.frames(2);
    await ui.emit('session.tool_end', { toolCallId: QUIET_CALL, name: 'read', isError: false, result: 'quiet', details: null, content: [{ type: 'text', text: 'quiet' }], endedAt: new Date().toISOString() });
    await ui.frames(2);
    const quiet = await partText(QUIET_CALL);
    check('一次增量都没收到的工具：全程没有实时尾元素（无 `tool_update` ⇒ 与今天逐字一致）',
      quiet !== null && quiet.live === false && JSON.stringify(quiet.outputChildren) === JSON.stringify(['tool-result']), JSON.stringify(quiet));

    check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));
    return { failures, checks, screenshots: SHOT_DIR };
  } finally {
    await ui.close();
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

const { webRoot, note } = await webRootForArm();
print('webRoot', `${webRoot}（${note}）`);
print('REVERSE', REVERSE ?? '(无 —— 正向)');

const serverArm = await runServerArm();
print('甲 · 真沙箱结果', serverArm.report);

const frameCost = await runFrameCostArm();
print('丙 · 帧成本汇总', frameCost);

const frontendArm = await runFrontendArm({ webRoot });
print('乙 · 截图', frontendArm.screenshots);
print('乙 · 通过', `${frontendArm.checks.length - frontendArm.failures.length}/${frontendArm.checks.length}`);

if (REVERSE === null) {
  if (frontendArm.failures.length > 0) {
    process.stdout.write(`\n✗ 正向模式下 ${frontendArm.failures.length} 条断言红了：\n${frontendArm.failures.map((line) => `  · ${line}`).join('\n')}\n`);
    process.exit(1);
  }
  print('RESULT', `tool-command-live PASS（${frontendArm.checks.length} checks；甲 tool_update=${serverArm.frameCounts.update} 帧）`);
} else {
  // 反证臂：这一臂的**退路必须让对应的断言红**。红了才证明门有牙齿。
  const expected = REVERSE === 'firstline'
    ? '展开 ⇒ DOM 里是**逐字全文**（整段相等，不是前缀）'
    : '跑的过程中：块里**已经有**前几行增量（修前恒为 0）';
  const hit = frontendArm.failures.filter((line) => line.startsWith(expected));
  if (hit.length === 0) {
    process.stdout.write(`\n✗ 反证臂 ${REVERSE} **没有红** —— 门没有牙齿。失败的断言是：${JSON.stringify(frontendArm.failures)}\n`);
    process.exit(1);
  }
  print(`RESULT`, `反证臂 ${REVERSE} 确实红了（命中「${expected}」）`);
  process.stdout.write(`\n（--reverse-arm=${REVERSE}：这一臂就是那句退路的证据）\n${frontendArm.failures.map((line) => `  · ${line}`).join('\n')}\n`);
}
