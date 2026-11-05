#!/usr/bin/env node
// test/live-tool-details.mjs —— 「直播工具卡在 tool_end 到达时就带上 `details`（diff）与结构化 `content`（图片块）」
// 这条缺口的机械门（服务端臂 + 前端臂）。
//
// 为什么要有它：`docs/tui-parity.md` 里 M-25 / M-31 那两行的「仍然缺」写着——
//   「SSE 直播路拿不到 `details` 与图片块（`session.tool_end` 的 `result` 走 `contentText()`，
//    两类都掉在服务端那一侧）—— 直播卡要等这一轮正文刷新才补上。」
// 本门把修后的事实钉成机械可复现的数字（**append-only**：老字段一个没动）：
//
//   ① 服务端臂（真 A+B + 假上游 + **真工具**）：
//      · 跑一次真 `edit`（产出 `details={diff,firstChangedLine}`）与一次真 `read`（读一张真 PNG，
//        产出含 `{type:'image',data,mimeType}` 的 `content`）；
//      · 断言 `session.tool_end` 帧里 `details` 与 `content` 都在、形状对得上，**且 `result` 文本仍在**
//        （append-only 的证据：`result === content 里所有 text 块的拼接`）。
//   ② 前端臂（真 Chromium + 假 API）：`session.tool_end` 一到达（**不刷新正文、不发 session.end**）⇒
//      直播卡里**已经**出现 `.tool-diff`（逐行 +/-）与 `.message-image`（`<img data:…>`）；
//      `tool_start` 那一刻**还没有**这两块（证明是 tool_end 带来的，不是历史里本来就有的）。
//   ③ 红绿对照：在**副本**上把这次的新字段去掉（退回 `result` 单字段）⇒ 这两条臂**必须红**。
//      副本用 `git apply -R` 打回本次 3 个文件的改动（见报告里的复跑命令）。
//
// 沙箱一律高位随机端口 + 临时 ASSIST_HOME/日志；不使用 7331/7321；不碰真实 profile；
// 不 pkill（只杀自己 spawn 的进程/浏览器）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/live-tool-details.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-livetooldetails-'));

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
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

async function waitFor(operation, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// ── 一张合法 PNG（真 `read` 工具会 processImage/编码成 base64，必须是真的图）─────────────
// 尺寸取 48×32 且逐像素变化（不是纯色）—— 压缩后 base64 有几 KB，这样「帧字节数」的测量
// 才能看出 `content` 里图片块的真实量级（纯色小图会 deflate 到几十字节，量不出东西）。
const PNG_W = 48;
const PNG_H = 32;
function pngBytes(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * 7 + y * 13) & 0xff;
      raw[row + 2 + x * 3] = (x * 29 + y * 3) & 0xff;
      raw[row + 3 + x * 3] = (x * 11 + y * 47) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────────── ① 真沙箱：原始 SSE 帧（edit 产 details + read 产图片） ─────────────────────────────

const TEXT_BEFORE = '先改一处，再看一张图。';
const TEXT_AFTER = '两件都做完了。';
const OLD_LINE = 'ALPHA_MARKER_LINE';
const NEW_LINE = 'BETA_MARKER_LINE';
const EDIT_CALL_ID = 'call_edit_details';
const READ_CALL_ID = 'call_read_image';

async function runServerArm({ providerPort, basePort, appPort }) {
  const home = path.join(sandbox, 'server-home');
  const cwd = path.join(sandbox, 'server-cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  // 真工具要动的两个文件：一个可 edit 的文本、一张可 read 的真 PNG。
  await writeFile(path.join(cwd, 'note.txt'), `HEADER LINE\n${OLD_LINE}\nFOOTER LINE\n`);
  await writeFile(path.join(cwd, 'pic.png'), pngBytes(PNG_W, PNG_H));
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions', apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-tools', name: 'Fake Tools', contextWindow: 8192, maxTokens: 2048 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-tools',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const providerChunk = (delta, finishReason = null) => ({
    id: `chatcmpl-${finishReason ?? 'delta'}`, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'fake-tools',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!hasToolResult) {
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', content: TEXT_BEFORE }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', tool_calls: [
        { index: 0, id: EDIT_CALL_ID, type: 'function', function: { name: 'edit', arguments: JSON.stringify({ path: 'note.txt', edits: [{ oldText: OLD_LINE, newText: NEW_LINE }] }) } },
        { index: 1, id: READ_CALL_ID, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'pic.png' }) } },
      ] }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', content: TEXT_AFTER }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({}, 'stop'))}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

  const baseLog = await open(path.join(sandbox, 'base.log'), 'w');
  const appLog = await open(path.join(sandbox, 'app.log'), 'w');
  const base = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
      PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd, SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const app = spawn(process.execPath, [path.join(root, 'server', 'app.mjs')], {
    cwd: root,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: webRoot,
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
  try {
    await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 20_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'live tool details' } });
    assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
    const sessionId = created.value.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

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

    const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '改一处并看一张图' } });
    assert.equal(accepted.statusCode, 202);
    await waitFor(() => frames.filter((frame) => frame.event === 'session.end').length >= 2, 'no two session.end frames', 40_000);
    request.destroy();

    const toolEnds = frames.filter((frame) => frame.event === 'session.tool_end');
    print('服务端臂原始 tool_end 帧（逐帧原样）', toolEnds.map((frame) => JSON.stringify(frame.data)));

    assert.equal(toolEnds.length, 2, `必须收到两条 session.tool_end（edit + read），实测 ${toolEnds.length}`);
    const editEnd = toolEnds.find((frame) => frame.data.name === 'edit');
    const readEnd = toolEnds.find((frame) => frame.data.name === 'read');
    assert.ok(editEnd, '缺少 edit 的 tool_end');
    assert.ok(readEnd, '缺少 read 的 tool_end');

    // ── edit：details（diff）必须在，且 result 文本仍在（append-only）─────────────────────
    assert.ok(editEnd.data.details && typeof editEnd.data.details === 'object',
      `edit 的 tool_end.details 必须是一个对象（实测 ${JSON.stringify(editEnd.data.details)}）`);
    assert.equal(typeof editEnd.data.details.diff, 'string', 'edit 的 details.diff 必须是字符串');
    assert.match(editEnd.data.details.diff, new RegExp(NEW_LINE), 'edit 的 details.diff 必须含新行');
    assert.match(editEnd.data.details.diff, new RegExp(OLD_LINE), 'edit 的 details.diff 必须含旧行');
    assert.ok(Array.isArray(editEnd.data.content), `edit 的 tool_end.content 必须是块数组（实测 ${JSON.stringify(editEnd.data.content)}）`);
    assert.equal(typeof editEnd.data.result, 'string', 'edit 的 result 文本必须仍在（append-only）');
    assert.ok(editEnd.data.result.length > 0, 'edit 的 result 文本不得为空');
    // 纯文本 result 仍然 == content 里 text 块的拼接（老消费者的口径一字未变）。
    const textOfBlocks = (blocks) => (Array.isArray(blocks) ? blocks : []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
    assert.equal(editEnd.data.result, textOfBlocks(editEnd.data.content), 'edit 的 result 必须仍等于 content 里 text 块的拼接');

    // ── read：content 里必须有 image 块（真图片），且 result 文本仍在 ─────────────────────
    assert.ok(Array.isArray(readEnd.data.content), `read 的 tool_end.content 必须是块数组（实测 ${JSON.stringify(readEnd.data.content)}）`);
    const imageBlocks = readEnd.data.content.filter((block) => block?.type === 'image');
    assert.equal(imageBlocks.length, 1, `read 的 content 必须含 1 个 image 块，实测 ${imageBlocks.length}`);
    assert.match(String(imageBlocks[0].mimeType), /^image\//, `image 块的 mimeType 必须是 image/*（实测 ${imageBlocks[0].mimeType}）`);
    assert.ok(typeof imageBlocks[0].data === 'string' && imageBlocks[0].data.length > 0, 'image 块必须带 base64 data');
    assert.equal(typeof readEnd.data.result, 'string', 'read 的 result 文本必须仍在（append-only）');
    assert.ok(readEnd.data.result.includes('Read image file'), `read 的 result 必须仍带「Read image file」文本（实测 ${JSON.stringify(readEnd.data.result)}）`);

    // ── B：帧字节数（追加字段的代价量级）─────────────────────────────────
    // 口径：`sseWrite()` 写的是 `data: ${JSON.stringify(data)}\n\n` ⇒ 这里量 `JSON.stringify(data)` 的 UTF-8 字节数，
    // 并拿一份「只保留这次之前的 5 个字段（= contentText 单字段时代）」的同形对象作对照。
    const frameBytes = (data) => Buffer.byteLength(JSON.stringify(data), 'utf8');
    const resultOnlyBytes = (data) => frameBytes({
      toolCallId: data.toolCallId, name: data.name, isError: data.isError, result: data.result, endedAt: data.endedAt,
    });
    const editBytes = { full: frameBytes(editEnd.data), resultOnly: resultOnlyBytes(editEnd.data) };
    const readBytes = { full: frameBytes(readEnd.data), resultOnly: resultOnlyBytes(readEnd.data) };
    print('session.tool_end 帧字节数（data JSON，UTF-8）', { edit: editBytes, read: readBytes });
    print('帧字节数增量（新增 details+content 的代价）', {
      edit: { deltaBytes: editBytes.full - editBytes.resultOnly, ratio: Number((editBytes.full / editBytes.resultOnly).toFixed(3)) },
      read: { deltaBytes: readBytes.full - readBytes.resultOnly, ratio: Number((readBytes.full / readBytes.resultOnly).toFixed(3)) },
      imageBase64Chars: imageBlocks[0].data.length,
    });

    const messages = await api(`/sessions/${sessionId}/messages`);
    const assistant = (messages.value.messages || []).find((message) => message.role === 'assistant');
    const toolParts = (assistant?.parts || []).filter((part) => part.type === 'tool');
    print('落盘 /messages 的工具 parts（对照）', toolParts.map((part) => ({ name: part.name, status: part.status, detailsStatus: part.details?.status ?? null, resultChars: (part.result || '').length })));
    const editPart = toolParts.find((part) => part.name === 'edit');
    assert.equal(editPart?.details?.status, 'known', '/messages 那条路的 edit 卡仍应带 details（回归：老路没被这次改动碰坏）');

    return { sessionId, toolEnds: toolEnds.length, editDiff: editEnd.data.details.diff, imageBytes: imageBlocks[0].data.length, frameBytes: { edit: editBytes, read: readBytes } };
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
    baseLog.close();
    appLog.close();
  }
}

// ───────────────────────────── ② 真前端：tool_end 一到就画 diff / 图片 ─────────────────────────────

const SESSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HISTORY_TEXT = '一段用来把正文渲染出来的历史。';
const LIVE_RESULT = 'File edited successfully.';
// pi `generateDiffString` 那一种行形（前缀 + 行号 + 空格 + 内容；`...` 是省略行）。
const EDIT_DIFF = ['     ...', '-  2 ALPHA_MARKER_LINE', '+  2 BETA_MARKER_LINE', '  3 FOOTER LINE'].join('\n');
const PNG_BASE64 = pngBytes(PNG_W, PNG_H).toString('base64');
const PNG_BYTES = Buffer.byteLength(PNG_BASE64, 'base64');

function makeRows() {
  return [{ id: SESSION_ID, name: '直播详情卡', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-21T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];
}

// 起一套「真 Chromium + 假 API」并选中会话 —— 两条前端臂（主臂 + 只能一次臂）各自独立起一份。
async function bootFrontend() {
  const rows = makeRows();
  const historyMessages = [{ entryId: 'h1', role: 'user', text: HISTORY_TEXT, content: [{ type: 'text', text: HISTORY_TEXT }], images: [] }];
  const session = { messages: historyMessages, streaming: false, stream: null };

  const ui = await boot({
    routes: async (request, response, url) => {
      if (url.pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
      if (url.pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
      if (url.pathname === '/api/tree') { sendJson(response, 200, { sessions: rows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }); return true; }
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
        return true;
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
      if (match) {
        const row = rows.find((item) => item.id === match[1]);
        if (!row) { sendJson(response, 404, { message: 'not found' }); return true; }
        const action = match[2] ?? null;
        if (action === null) { sendJson(response, 200, { name: row.name, runtime: { isStreaming: session.streaming, isCompacting: false, isRetrying: false }, observability: null }); return true; }
        if (action === 'messages') { sendJson(response, 200, { messages: session.messages, extras: [], compaction: { atIndex: null }, observability: null }); return true; }
        if (action === 'commands') { sendJson(response, 200, { streaming: session.streaming, commands: [] }); return true; }
        if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
        if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: session.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
          session.stream = response;
          response.once('close', () => { if (session.stream === response) session.stream = null; });
          return true;
        }
      }
      if (url.pathname === '/api/test/event' && request.method === 'POST') {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!session.stream || session.stream.destroyed) { sendJson(response, 409, { message: 'session stream unavailable' }); return true; }
        if (name === 'session.start') session.streaming = true;
        if (name === 'session.end' && data?.stopReason !== 'toolUse') session.streaming = false;
        session.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        sendJson(response, 200, { ok: true });
        return true;
      }
      return false;
    },
  });

  await uiWaitFor(() => ui.evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_ID}"]')`), 'page did not load', 15_000);
  await ui.evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
  await uiWaitFor(() => session.stream !== null, 'session events stream did not connect');
  await uiWaitFor(() => ui.evaluate(`document.querySelector('#prompt')?.disabled === false`), 'composer did not enable');
  return { ui, session, historyMessages };
}

async function runFrontendArm() {
  const { ui, session, historyMessages } = await bootFrontend();
  try {

    const card = () => ui.evaluate(`(() => {
      const live = document.querySelector('#messages .live-message');
      const root = live ?? document.querySelector('#messages');
      const node = root ? root.querySelector('.tool-card') : null;
      if (!node) return { live: !!live, card: false };
      const diff = node.querySelector('.tool-diff');
      const image = node.querySelector('.message-image');
      const img = image ? image.querySelector('img') : null;
      const resultNode = node.querySelector('.tool-result');
      const children = Array.from(node.querySelector('.tool-output')?.children ?? []).map((child) => child.className);
      return {
        live: !!live,
        card: true,
        state: node.dataset.state,
        collapsed: node.dataset.collapsed,
        outputChildren: children,
        result: resultNode ? resultNode.textContent : null,
        diff: diff ? {
          added: diff.dataset.added, removed: diff.dataset.removed,
          head: diff.querySelector('.tool-diff-head')?.textContent ?? null,
          lines: Array.from(diff.querySelectorAll('.tool-diff-line')).map((line) => line.textContent),
        } : null,
        image: image ? {
          state: image.dataset.state, mime: image.querySelector('figcaption')?.textContent ?? null,
          src: img ? img.getAttribute('src') : null,
          srcPrefix: img ? (img.getAttribute('src')?.slice(0, 30) ?? null) : null,
        } : null,
        cards: document.querySelectorAll('#messages .tool-card').length,
        liveCards: document.querySelectorAll('#messages .live-message .tool-card').length,
      };
    })()`);

    const checks = [];
    const check = (name, ok, detail) => {
      if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
      checks.push(name);
      print(`✓ ${name}`, detail);
    };

    await ui.emit('session.start', { role: 'assistant' });
    await ui.emit('session.tool_start', { toolCallId: EDIT_CALL_ID, name: 'edit', args: { path: 'note.txt' } });
    await ui.waitFor(async () => (await card()).state === 'running', 'live tool card did not appear', 8000);
    const running = await card();
    // 起点对照：tool_start 那一刻，直播卡里**没有** diff / 图片（它们只能来自 tool_end）。
    check('tool_start 时直播卡里还没有 diff / 图片（对照）', running.diff === null && running.image === null && running.result === '⎿ 运行中…', JSON.stringify({ diff: running.diff, image: running.image, result: running.result }));

    // ── 关键：tool_end 到达（不刷新正文、不发 session.end）⇒ diff + 图片**当场**出现 ──────────────
    await ui.emit('session.tool_end', {
      toolCallId: EDIT_CALL_ID, name: 'edit', isError: false,
      result: LIVE_RESULT,
      details: { diff: EDIT_DIFF, firstChangedLine: 2 },
      content: [
        { type: 'text', text: LIVE_RESULT },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      ],
    });
    await ui.waitFor(async () => (await card()).state === 'done-success', 'live card did not flip to done-success', 8000);
    // 先看 diff（details）—— 它在 tool_end 那一刻就已经可以断言；图片的解码是异步的，单独等。
    const done = await card();
    check('tool_end 一到：直播卡里已有 `.tool-diff`（逐行 +/- 与统计都对）',
      done.diff !== null && done.diff.added === '1' && done.diff.removed === '1'
      && done.diff.lines.some((line) => line.includes(`+  2 ${NEW_LINE}`))
      && done.diff.lines.some((line) => line.includes(`-  2 ${OLD_LINE}`)),
      JSON.stringify(done.diff));
    check('append-only：result 文本仍在直播卡里（老消费者一字未变）', done.result === LIVE_RESULT, JSON.stringify(done.result));
    await ui.waitFor(async () => (await card()).image?.state === 'loaded', 'live card image did not load', 8000);
    const doneWithImage = await card();
    check('tool_end 一到：直播卡里已有 `.message-image`（真 `<img data:image/png;base64,…>` 且已解码）',
      doneWithImage.image !== null && doneWithImage.image.srcPrefix?.startsWith('data:image/png;base64,') && doneWithImage.image.state === 'loaded' && /image\/png/.test(doneWithImage.image.mime),
      JSON.stringify({ srcPrefix: doneWithImage.image?.srcPrefix, state: doneWithImage.image?.state, mime: doneWithImage.image?.mime, srcChars: doneWithImage.image?.src?.length ?? 0 }));
    check('没有刷新正文：从头到尾只有这一张直播卡，历史里没有多出卡', doneWithImage.cards === 1 && doneWithImage.liveCards === 1, JSON.stringify({ cards: doneWithImage.cards, liveCards: doneWithImage.liveCards }));
    check('extras 都在 `.tool-output` 里（diff 在结果文本之后、图片再之后）',
      JSON.stringify(doneWithImage.outputChildren) === JSON.stringify(['tool-result', 'tool-diff', 'message-image']),
      JSON.stringify(doneWithImage.outputChildren));

    check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));
    return { checks, running, done, chromium: ui.version.Browser };
  } finally {
    session.stream?.destroy();
    await ui.close();
  }
}

// ── C：交接 / 重连只能一次（diff 与图片各只出现一次，不重影）─────────────────────────
// **独立一条前端臂**（不与主臂共用状态）：主臂一红也照跑 —— 红绿对照时要能看到 C 自己红。
// 最易重影的一下：直播块里已经画着 diff+图片，此时正文刷新（重连对账 / 结束交接）把同一条
// 工具以正式卡的形式又拉回来 —— 一遍错就会看到两份。这里把那一份**与 /messages 修后给的一模一样**
// 的历史塞进去（part.details 走 `detailsWire` 壳，图片在配对的 toolResult message 的 `content` 里）。
async function runFrontendOnlyOnceArm() {
  const { ui, session, historyMessages } = await bootFrontend();
  const checks = [];
  const check = (name, ok, detail) => {
    if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
    checks.push(name);
    print(`✓ ${name}`, detail);
  };
  try {
    const counts = () => ui.evaluate(`(() => {
      const root = document.querySelector('#messages');
      const inLive = (sel) => root.querySelectorAll('.live-message ' + sel).length;
      const all = (sel) => root.querySelectorAll(sel).length;
      const diffs = all('.tool-diff');
      const images = all('.message-image');
      return {
        cards: all('.tool-card'), liveCards: inLive('.tool-card'),
        diffs, images, liveDiffs: inLive('.tool-diff'), liveImages: inLive('.message-image'),
        live: root.querySelectorAll('.live-message').length,
        historyDiffs: diffs - inLive('.tool-diff'), historyImages: images - inLive('.message-image'),
      };
    })()`);
    const liveImageState = () => ui.evaluate(`document.querySelector('#messages .live-message .message-image')?.dataset.state ?? null`);

    await ui.emit('session.start', { role: 'assistant' });
    await ui.emit('session.tool_start', { toolCallId: EDIT_CALL_ID, name: 'edit', args: { path: 'note.txt' } });
    await ui.waitFor(async () => (await counts()).liveCards === 1, 'live tool card did not appear', 8000);
    await ui.emit('session.tool_end', {
      toolCallId: EDIT_CALL_ID, name: 'edit', isError: false, result: LIVE_RESULT,
      details: { diff: EDIT_DIFF, firstChangedLine: 2 },
      content: [{ type: 'text', text: LIVE_RESULT }, { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
    });
    await ui.waitFor(async () => { const value = await counts(); return value.liveDiffs === 1 && value.liveImages === 1; }, 'live card did not render diff+image', 8000);
    await ui.waitFor(async () => (await liveImageState()) === 'loaded', 'live image did not load', 8000);
    const beforeRefresh = await counts();
    check('C-0 刷新前：直播块里 diff / 图片各 1 份（对照）', beforeRefresh.liveDiffs === 1 && beforeRefresh.liveImages === 1 && beforeRefresh.diffs === 1 && beforeRefresh.images === 1, JSON.stringify(beforeRefresh));

    session.messages = [
      ...historyMessages,
      { entryId: 'a1', role: 'assistant', content: [], parts: [
        { type: 'tool', toolCallId: EDIT_CALL_ID, name: 'edit', args: { path: 'note.txt' }, status: 'done-success', result: LIVE_RESULT,
          details: { status: 'known', value: { diff: EDIT_DIFF, firstChangedLine: 2 }, bytes: 120, truncated: false, note: null, preview: null } },
      ] },
      { entryId: 'r1', role: 'toolResult', toolCallId: EDIT_CALL_ID, toolName: 'edit', isError: false, text: LIVE_RESULT,
        content: [{ type: 'text', text: LIVE_RESULT }, { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
        images: [{ mimeType: 'image/png', bytes: PNG_BYTES }] },
    ];
    // 重连：`session.snapshot` 就是 SSE 初连/重连的对账点，会让正文刷新、历史接管与直播逐字相同的前缀。
    await ui.emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false, pendingMessages: 0 });
    await ui.waitFor(async () => { const value = await counts(); return value.historyDiffs === 1 && value.historyImages === 1; }, 'history did not take over with diff+image', 10_000);
    await ui.frames();
    const afterRefresh = await counts();
    check('C-1 重连刷新后：diff / 图片仍各只 1 份（直播块不重影）',
      afterRefresh.diffs === 1 && afterRefresh.images === 1 && afterRefresh.cards === 1 && afterRefresh.liveDiffs === 0 && afterRefresh.liveImages === 0,
      JSON.stringify(afterRefresh));

    // 交接：terminal end 收尾（live-tools.mjs 的收尾辞）。
    await ui.emit('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
    await ui.waitFor(async () => (await counts()).live === 0, 'terminal end did not clear the live block', 10_000);
    await ui.frames();
    const afterEnd = await counts();
    check('C-2 结束交接后：diff / 图片仍各只 1 份（不重复、也不丢）',
      afterEnd.diffs === 1 && afterEnd.images === 1 && afterEnd.cards === 1 && afterEnd.live === 0,
      JSON.stringify(afterEnd));

    check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));
    return { checks, chromium: ui.version.Browser };
  } finally {
    session.stream?.destroy();
    await ui.close();
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

const used = new Set();
const providerPort = await reserveHighPort(used); used.add(providerPort);
const basePort = await reserveHighPort(used); used.add(basePort);
const appPort = await reserveHighPort(used); used.add(appPort);

let primaryError;
try {
  // 两条臂**各自独立**跑：一条红了另一条照跑 —— 红绿对照时要能同时看到「服务端没带字段」与
  // 「前端没画出来」两个独立证据，而不是第一条臂一红就再也看不到第二条。
  const armResults = {};
  const armErrors = [];
  try {
    armResults.server = await runServerArm({ providerPort, basePort, appPort });
    print('服务端臂结论', { toolEnds: armResults.server.toolEnds, editDiffLines: armResults.server.editDiff.split('\n').length, imageBase64Chars: armResults.server.imageBytes });
  } catch (error) {
    armErrors.push(['服务端臂', error]);
    print('服务端臂失败', String(error?.message ?? error));
  }
  try {
    armResults.frontend = await runFrontendArm();
    print('前端臂结论', { checks: armResults.frontend.checks.length, chromium: armResults.frontend.chromium });
  } catch (error) {
    armErrors.push(['前端臂', error]);
    print('前端臂失败', String(error?.message ?? error));
  }
  try {
    armResults.onlyOnce = await runFrontendOnlyOnceArm();
    print('只能一次臂结论', { checks: armResults.onlyOnce.checks.length, chromium: armResults.onlyOnce.chromium });
  } catch (error) {
    armErrors.push(['只能一次臂', error]);
    print('只能一次臂失败', String(error?.message ?? error));
  }
  print('沙箱', { home: sandbox, ports: { providerPort, basePort, appPort }, forbiddenPortsUsed: false });
  if (armErrors.length > 0) {
    primaryError = new Error(`${armErrors.length} 条臂红了：${armErrors.map(([name, error]) => `${name}（${error?.message ?? error}）`).join('；')}`);
  } else {
    print('RESULT', `live tool details PASS（服务端 tool_end 带 details+content 各 ${armResults.server.toolEnds} 帧；前端 ${armResults.frontend.checks.length} 项检查；只能一次 ${armResults.onlyOnce.checks.length} 项检查）`);
  }
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
