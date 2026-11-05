#!/usr/bin/env node
// android/fake-api/server.mjs —— 原型用的**本地假 API**（零依赖，只在本机跑）。
//
// 它说它是什么：**演示数据**。不是真实实例、不连真服务、不发任何写请求到别处。
// 形状照真实服务端（`server/base-logic.mjs` 的 /tree、/sessions/{id}/messages、/sessions/{id}/events），
// 只实现原型要读的那几样：
//   GET  /api/tree
//   GET  /api/sessions/{uuid}/messages
//   GET  /api/sessions/{uuid}/events     —— SSE：首帧 session.snapshot，然后 delta → end
//   POST /api/sessions/{uuid}/message    —— 与真服务端一致：202 `{accepted,sessionId}`；忙 409 session_streaming
//   POST /api/sessions/{uuid}/steer      —— 202 `{accepted,mode:'steer'}`；已闲 409 session_not_streaming
//   GET  /health
// （除这两条 POST 之外一律 405 —— 不假装支持 abort/compact/archive/…）
//
// 它故意做的事（为了能看见「前台更新 / 断线恢复」）：
//   · 订阅后先发一帧 `session.snapshot`（与真服务端语义一致：**首连必发**）；
//   · 之后按脚本推 `session.delta`（channel=text），最后 `session.end`；
//   · **每 30 秒主动掐一次正在推的那条流**，用来演示「断线 → 重连 → 按快照对账」；
//   · 心跳 15 s（注释帧），与真服务端一致（客户端靠它判死）；
//   · 一条会话（`演示 · 慢响应 A`）的 `/messages` **故意慢 5 s**：用来验「A 的迟到正文不许盖掉 B」。
//
// 夹具里的树形状（给 `SessionForest` 用；不是产品功能）：每条会话可以带 `parentId`，
// 形成 0→1→2→3 的多层链，另有一条**已归档父 + 未归档子**（验“隐藏父不得连带吞掉未归档子”）。
//
// ⚠️ App 的**界面已经没有「演示」选项**（2026-10-22 删）。要用这套夹具：起这个服务，
// 然后在 App 里用「直连（HTTP）」把地址指向 `http://10.0.2.2:7399`。
//
// 用法：node android/fake-api/server.mjs [--port 7399] [--host 127.0.0.1]

import http from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(readArg('port', '7399'));
const HOST = readArg('host', '127.0.0.1');
const HEARTBEAT_MS = 15_000;
const DROP_AFTER_MS = 30_000;

const nowIso = () => new Date().toISOString();

const sessions = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    // 忙：`POST /message` 会 409 `session_streaming`，`POST /steer` 才接受（与网页的忙闲选择一致）。
    sendBehavior: 'busy',
    // 忙会话不推演示回合：真忙的会话不会发 session.end，否则客户端刚收到 end 就会把“忙”判成“闲”。
    noTurns: true,
    name: '演示 · 助手在跑',
    status: 'working',
    cwd: 'C:\\Users\\demo\\sopho-pi',
    archived: false,
    messages: [
      { entryId: 'm-1', role: 'user', text: '帮我看一下安卓原型的连接页要显示什么。', timestamp: '2026-10-21T10:00:00.000Z' },
      {
        entryId: 'm-2',
        role: 'assistant',
        text: '我建议最小集合是三项：服务器地址、运行模式、以及 ZeroTier 的节点 ID（可复制）与授权状态 —— 其余都等原型能跑起来再说。',
        timestamp: '2026-10-21T10:00:05.000Z',
      },
    ],
  },
  {
    // 「额外消息穿插」（2026-10-24 本单）：`messages` 与 `extras` 是两个数组，位置靠锚算 ——
    // 用来直观看「额外消息不再堆到最后」。形状照真实 `/messages`（`server/base-logic.mjs` 的 messageWire）：
    // 正文带 `parentId / timestamp`，工具结果也在 `messages` 里占一个下标（只是不单独成行），
    // extra 带 `entryId / parentId / timestamp`，另有一条**没有任何锚**的（回落到末尾）。
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: '演示 · 额外消息穿插',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\extras-order',
    archived: false,
    noTurns: true,
    messages: [
      { entryId: 'x-1', parentId: null, role: 'user', text: '把三条子会话回话插回正文里（不要堆到最后）。', timestamp: '2026-10-24T09:00:00.000Z' },
      { entryId: 'x-2', parentId: 'x-1', role: 'assistant', text: '收到：一条锚在工具结果之后，一条锚在这条回复之后，没有锚的那条按回落留在最后。', timestamp: '2026-10-24T09:00:02.000Z' },
      { entryId: 'x-3', parentId: 'x-2', role: 'toolResult', text: '（工具结果：不单独成行，但占一个锚下标）', timestamp: '2026-10-24T09:00:03.000Z' },
      { entryId: 'x-4', parentId: 'x-3', role: 'user', text: '第二问：再补一句。', timestamp: '2026-10-24T09:00:05.000Z' },
      { entryId: 'x-5', parentId: 'x-4', role: 'assistant', text: '第二答：这条之后还有一条锚在它上面的子会话回话。', timestamp: '2026-10-24T09:00:07.000Z' },
    ],
    extras: [
      { entryId: 'e-1', parentId: 'x-3', timestamp: '2026-10-24T09:00:00.500Z', customType: 'sopho.delegation', text: '子会话回话 ①：父是工具结果 —— 时间戳比正文都早，但仍应落在助手回复 ① 之后。' },
      { entryId: 'e-2', parentId: 'x-5', timestamp: '2026-10-24T09:00:07.500Z', customType: 'sopho.delegation', text: '子会话回话 ②：父是助手回复 ② —— 应落在它后面。' },
      { entryId: 'e-3', parentId: null, timestamp: null, customType: 'sopho.notice', text: '子会话回话 ③：没有任何锚 ⇒ 回落到末尾（这是回落路径，不是正常路径）。' },
    ],
    compaction: { entryId: null, atIndex: null, note: '没有压缩过' },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    parentId: '11111111-1111-4111-8111-111111111111',
    name: '演示 · 未读回复',
    status: 'unread',
    cwd: 'C:\\Users\\demo\\sopho-pi',
    archived: false,
    // 竞态试验的「安静 B」：不推演示回合（否则它自己的 session.end 会把 A 的迟到结果盖回去，
    // 那一刻的状态会被“治好”，实验就看不见问题了）。
    noTurns: true,
    messages: [
      { entryId: 'm-3', role: 'user', text: 'B · 快会话正文标记：断线之后应该怎么办？', timestamp: '2026-10-21T09:10:00.000Z' },
      {
        entryId: 'm-4',
        role: 'assistant',
        text: '服务端不读 Last-Event-ID，所以重连不能续播：重连之后按 session.snapshot 对账，再重拉一次正文。event id 只当帧序号看，不当重放保证。',
        timestamp: '2026-10-21T09:10:04.000Z',
      },
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    parentId: '22222222-2222-4222-8222-222222222222',
    name: '演示 · 长正文（截断检查）',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\notes',
    archived: false,
    messages: [
      { entryId: 'm-5', role: 'user', text: '来一段长一点的正文，看换行与滚动。', timestamp: '2026-10-21T08:30:00.000Z' },
      {
        entryId: 'm-6',
        role: 'assistant',
        text: Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段：安卓原型的正文卡片沿用左槽原语，1px 描边＋最左 3px 语义色槽，不引入阴影与渐变。`).join('\n'),
        timestamp: '2026-10-21T08:30:03.000Z',
      },
    ],
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    parentId: '33333333-3333-4333-8333-333333333333',
    name: '演示 · 慢响应 A（竞态用）',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\race',
    archived: false,
    // 故意慢：用来验「A 的迟到正文不许盖掉 B」—— 切到 B 之后，这一发结果必须被丢掉。
    slowMessagesMs: 5000,
    messages: [
      { entryId: 'm-8', role: 'user', text: 'A · 慢会话正文标记（5 s 才回来的那一份）', timestamp: '2026-10-21T07:00:00.000Z' },
    ],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: '演示 · 已归档',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\sopho-pi',
    archived: true,
    messages: [
      { entryId: 'm-7', role: 'user', text: '这条归档会话只用来检查左槽最暗档。', timestamp: '2026-10-20T22:00:00.000Z' },
    ],
  },
  {
    // 已归档的父：默认隐藏时，它下面未归档的子必须仍然可见（被提升出来）。
    id: '66666666-6666-4666-8666-666666666666',
    name: '演示 · 已归档的父',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\archived-parent',
    archived: true,
    messages: [
      { entryId: 'm-9', role: 'user', text: '父已归档：开关关着时这一行不该出现。', timestamp: '2026-10-20T20:00:00.000Z' },
    ],
  },
  {
    id: '77777777-7777-4777-8777-777777777777',
    name: '演示 · 未归档的子（父已归档）',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\archived-parent',
    archived: false,
    parentId: '66666666-6666-4666-8666-666666666666',
    noTurns: true,
    messages: [
      { entryId: 'm-10', role: 'user', text: '父归档了，但这一行没归档 —— 必须仍然可见，并标明“父已隐藏，已提升”。', timestamp: '2026-10-20T20:05:00.000Z' },
    ],
  },
  {
    // 发送报 500：用来验“5xx = 结果不确定、草稿保留、不自动重发”。
    id: '88888888-8888-4888-8888-888888888888',
    name: '演示 · 发送报 500',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\send-error',
    archived: false,
    noTurns: true,
    sendBehavior: 'serverError',
    messages: [
      { entryId: 'm-11', role: 'user', text: '给这条会话发东西，服务端会回 500。', timestamp: '2026-10-20T19:00:00.000Z' },
    ],
  },
  {
    // 发了不回：用来验“超时 ⇒ 结果未知、不自动重发”。
    id: '99999999-9999-4999-8999-999999999999',
    name: '演示 · 发送挂住（超时）',
    status: 'idle',
    cwd: 'C:\\Users\\demo\\send-hang',
    archived: false,
    noTurns: true,
    sendBehavior: 'hang',
    messages: [
      { entryId: 'm-12', role: 'user', text: '给这条会话发东西，服务端会收下请求但不回。', timestamp: '2026-10-20T19:05:00.000Z' },
    ],
  },
];

const byId = new Map(sessions.map((session) => [session.id, session]));

/** 当前活着的 SSE 订阅者（发送成功后把回复推给它们，用来验“前台回复更新”）。 */
const subscribers = new Map(); // sessionId -> Set<response>

const rowOf = (session) => ({
  id: session.id,
  name: session.name,
  status: session.status,
  statusLabel: { working: '工作中', unread: '未读', idle: '闲置' }[session.status] ?? '闲置',
  archived: session.archived,
  cwd: session.cwd,
  parentSessionPath: null,
  createdAt: session.messages[0]?.timestamp ?? null,
  modifiedAt: session.messages[session.messages.length - 1]?.timestamp ?? null,
  parentId: session.parentId ?? null,
  titleSource: null,
  context: null,
});

const sendJson = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-sopho-demo': '1',
  });
  response.end(body);
};

/** 一条「回合」脚本：先 delta 后 end，并把结果落回内存里的会话（下一次 GET /messages 就能看到）。 */
function runTurn(session, response) {
  if (response.writableEnded || response.destroyed) return;
  const chunks = [
    '（演示）这一条是假 API 推来的流式正文。',
    '它的作用只有一个：证明客户端在前台能收到 session.delta 并按块追加，',
    '收到 session.end 之后再用 GET /messages 对账。',
  ];
  let index = 0;
  let text = '';
  const timer = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      clearInterval(timer);
      return;
    }
    if (index < chunks.length) {
      const delta = chunks[index];
      index += 1;
      text += delta;
      writeEvent(response, 'session.delta', { channel: 'text', delta });
      return;
    }
    clearInterval(timer);
    writeEvent(response, 'session.end', { stopReason: 'end', errorMessage: null, text });
    session.messages.push({
      entryId: `demo-${Date.now()}`,
      role: 'assistant',
      text,
      timestamp: nowIso(),
    });
    // 忙夹具（sendBehavior='busy'）要保持“正在跑”，否则列表会把忙会话显示成未读、客户端就会去发 message。
    if (session.sendBehavior !== 'busy') session.status = 'unread';
    response.turnTimer = null;
  }, 700);
  response.turnTimer = timer;
}

function writeEvent(response, event, data) {
  if (response.writableEnded || response.destroyed) return;
  response.write(`id: ${++response.seq}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleEvents(session, request, response) {
  console.log(`[demo] SSE 连上 ${session.id}`);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-sopho-demo': '1',
  });
  response.seq = 0;
  response.write('retry: 1000\n\n');

  if (!subscribers.has(session.id)) subscribers.set(session.id, new Set());
  subscribers.get(session.id).add(response);

  // 首帧就是权威快照（真服务端 `sessionEvents` 连上必发这一帧）。
  writeEvent(response, 'session.snapshot', {
    sessionId: session.id,
    streaming: session.status === 'working',
    isStreaming: session.status === 'working',
    queue: { steering: [], followUp: [] },
    demo: true,
  });

  const heartbeat = setInterval(() => {
    if (response.destroyed) return;
    response.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  // 演示用：过一会儿开始推一条「回合」，再过一个周期把它推下一轮。
  // `noTurns` 的会话只发快照与心跳，不推演示回合 —— 竞态试验用它当“安静的 B”，
  // 否则 B 自己的 `session.end` 会把 A 的迟到结果再盖回去，实验就看不见了。
  const turnStart = session.noTurns ? null : setTimeout(() => runTurn(session, response), 1200);
  const nextTurn = session.noTurns ? null : setInterval(() => runTurn(session, response), 20_000);

  // 演示用：故意掐一次流（客户端应自动重连并按快照重新对账）。
  const drop = setTimeout(() => {
    console.log(`[demo] 主动掐断 ${session.id} 的 SSE（模拟断线）`);
    response.destroy();
  }, DROP_AFTER_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(nextTurn);
    clearTimeout(turnStart);
    clearTimeout(drop);
    if (response.turnTimer) clearInterval(response.turnTimer);
    subscribers.get(session.id)?.delete(response);
    if (!cleanup.done) {
      cleanup.done = true;
      console.log(`[demo] SSE 断开 ${session.id}（客户端走了）`);
    }
  };
  request.on('close', cleanup);
  response.on('close', cleanup);
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

/**
 * 「发送」这件事在夹具里的全部花样（与真服务端的码一致）：
 * - 空文本 ⇒ 400 `invalid_text`；
 * - `sendBehavior: 'busy'` ⇒ `message` 409 `session_streaming`，`steer` 接受（与网页的忙闲选择一致）；
 * - 其他会话 ⇒ `message` 接受、`steer` 409 `session_not_streaming`；
 * - `serverError` ⇒ 500（= 结果不确定，客户端不得自动重发）；
 * - `hang` ⇒ 收下请求但**不回**（= 超时，客户端不得自动重发）。
 * 接受时把这句话**当成一条 user 消息落进 provider 侧内存**（GET /messages 见得到，带 sendMode）。
 */
async function handleSend(request, response, session, route) {
  const body = await readJsonBody(request);
  const text = typeof body.text === 'string' ? body.text : '';
  console.log(`[demo] POST /${session.id.slice(0, 8)}/${route} body=${JSON.stringify(body)}`);
  if (text.trim() === '') {
    sendJson(response, 400, { error: 'invalid_text', detail: 'text must be a non-empty string' });
    return;
  }
  const behavior = session.sendBehavior ?? 'ok';
  if (behavior === 'serverError') {
    console.log('[demo] 回 500（模拟服务端报错：结果不确定）');
    sendJson(response, 500, { error: 'demo_internal_error', detail: 'fake server error' });
    return;
  }
  if (behavior === 'hang') {
    console.log('[demo] 挂住不回（模拟超时：客户端应判“结果未知”）');
    request.on('close', () => console.log('[demo] 挂住的那条请求已被客户端断开'));
    return;
  }
  if (route === 'message' && behavior === 'busy') {
    sendJson(response, 409, { error: 'session_streaming', detail: 'session is streaming' });
    return;
  }
  if (route === 'steer' && behavior !== 'busy') {
    sendJson(response, 409, { error: 'session_not_streaming', detail: 'not currently processing' });
    return;
  }
  session.messages.push({
    entryId: `u-${Date.now()}`,
    role: 'user',
    text,
    timestamp: nowIso(),
    sendMode: route,
  });
  session.status = 'working';
  console.log(`[demo] 接受（202）· provider 侧已见到这条 user 消息 · sendMode=${route}`);
  sendJson(
    response,
    202,
    route === 'steer'
      ? { accepted: true, mode: 'steer', sessionId: session.id }
      : { accepted: true, sessionId: session.id },
  );
  replyToSend(session, route, text);
}

/** 假 provider 的回复：有订阅者就走 SSE（验“前台回复更新”），同时落进 /messages。 */
function replyToSend(session, route, text) {
  const answer = route === 'steer'
    ? `（假 provider）收到插话：「${text.slice(0, 40)}」—— 插在当前这一轮之后。`
    : `（假 provider）收到新消息：「${text.slice(0, 40)}」—— 这是一条回复。`;
  const half = Math.ceil(answer.length / 2);
  const chunks = [answer.slice(0, half), answer.slice(half)];
  let index = 0;
  const timer = setInterval(() => {
    const listeners = subscribers.get(session.id) ?? new Set();
    if (index < chunks.length) {
      for (const listener of listeners) {
        writeEvent(listener, 'session.delta', { channel: 'text', delta: chunks[index] });
      }
      index += 1;
      return;
    }
    clearInterval(timer);
    for (const listener of listeners) {
      writeEvent(listener, 'session.end', { stopReason: 'end', errorMessage: null, text: answer });
    }
    session.messages.push({ entryId: `a-${Date.now()}`, role: 'assistant', text: answer, timestamp: nowIso() });
    // 忙夹具（sendBehavior='busy'）要保持“正在跑”，否则列表会把忙会话显示成未读、客户端就会去发 message。
    if (session.sendBehavior !== 'busy') session.status = 'unread';
    console.log(`[demo] 回复已${listeners.size > 0 ? '经 SSE 推送' : '（无订阅者，只落盘）'}：${answer.slice(0, 30)}`);
  }, 600);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  // ── 写路径：只有这两条，形状与真服务端一致（body `{text}`，成功 202）──
  const sendMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(message|steer)$/);
  if (request.method === 'POST' && sendMatch) {
    const session = byId.get(sendMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'session_not_found' });
      return;
    }
    handleSend(request, response, session, sendMatch[2]);
    return;
  }
  if (request.method !== 'GET') {
    // 除了上面那两条，假 API 不收写：不假装支持 abort/compact/archive/…
    sendJson(response, 405, {
      error: 'demo_api_write_not_supported',
      detail: '假 API 只实现 POST /message 与 POST /steer',
    });
    return;
  }
  if (url.pathname === '/health') {
    sendJson(response, 200, { ok: true, demo: true, at: nowIso() });
    return;
  }
  if (url.pathname === '/api/tree') {
    sendJson(response, 200, {
      sessions: sessions.map(rowOf),
      generatedAt: nowIso(),
      titles: { ok: true, exists: true, error: null },
      demo: true,
    });
    return;
  }
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const session = byId.get(messagesMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'session_not_found' });
      return;
    }
    const respond = () => {
      if (response.writableEnded || response.destroyed) return;
      sendJson(response, 200, {
        sessionId: session.id,
        messages: session.messages.map((message) => ({
          entryId: message.entryId,
          // 锚用的两列：`parentId` / `timestamp`（真服务端每条 message 都带）。
          parentId: message.parentId ?? null,
          role: message.role,
          text: message.text,
          timestamp: message.timestamp,
          parts: [{ type: 'text', text: message.text }],
          stopReason: message.role === 'assistant' ? 'end' : null,
          // 夹具专用：让“这条是不是 steer 进来的”可被对账（真服务端不返回这个字段）。
          ...(message.sendMode ? { sendMode: message.sendMode } : {}),
        })),
        // 额外消息（`custom_message`）：**不在** `messages` 里，位置靠自己的锚。
        extras: (session.extras ?? []).map((extra) => ({
          entryId: extra.entryId,
          parentId: extra.parentId ?? null,
          timestamp: extra.timestamp ?? null,
          customType: extra.customType ?? 'extension',
          display: true,
          content: [{ type: 'text', text: extra.text }],
          text: extra.text,
        })),
        compaction: session.compaction ?? { entryId: null, atIndex: null, note: '没有压缩过' },
        demo: true,
      });
    };
    if (session.slowMessagesMs) {
      console.log(`[demo] 慢响应：${session.id} 的 /messages 将等 ${session.slowMessagesMs} ms`);
      setTimeout(respond, session.slowMessagesMs);
    } else {
      respond();
    }
    return;
  }
  const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (eventsMatch) {
    const session = byId.get(eventsMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'session_not_found' });
      return;
    }
    handleEvents(session, request, response);
    return;
  }
  sendJson(response, 404, { error: 'not found', path: url.pathname, demo: true });
});

server.listen(PORT, HOST, () => {
  console.log(`[demo] 假 API 在 http://${HOST}:${PORT}（演示数据，不是真实实例）`);
  console.log('[demo] 路由：GET /api/tree、/api/sessions/{uuid}/messages、/api/sessions/{uuid}/events、/health');
});
