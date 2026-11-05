#!/usr/bin/env node
// 队列条的位置契约（真 Chromium + 假 API）。
//
// 为什么有这道门：v2.2 一度把「⏳ 排队中」条放进右栏 <header>（顶栏）里，于是它出现在
// 会话标题/用量/连接行下面 —— 而它描述的是**还没发出去的东西**，跟右上角的会话动作、
// 用量、连接状态不是一类事实，而且离输入框最远。用户口径：队列该贴着输入区上方。
//
// 这道门只钉几何，不钉实现：队列容器（#queue-status）必须在 composer **上方且相邻**，
// 水平与 composer 对齐，留在视口内，不压住正文区，宽/窄两种视口都得成立；同时不得
// 退回顶栏（header 里不许有它），槽语言（1 个 3px 左槽）、禁阴影/渐变的既有规矩照旧。
//
// 用法：CHROME_BIN=/usr/bin/chromium npm run test:queueposition
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-queuepos-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-queue-position');
const wideShotFile = path.join(artifactRoot, 'queue-above-composer-1200x760.png');
const narrowShotFile = path.join(artifactRoot, 'queue-above-composer-420x820.png');
const stressShotFile = path.join(artifactRoot, 'queue-above-composer-long-420x820.png');
const sessionId = '77777777-7777-4777-8777-777777777777';

// 两类各两条：插话（steering）与排队（followUp）必须在同一行里能分清。
const queueFixture = {
  steering: ['S-1 插话：先把这个测试跑完', 'S-2 插话：再补一条回归证据'],
  followUp: ['F-1 排队：跑完再更新文档', 'F-2 排队：最后提交这一批'],
};
const sessions = [
  { id: sessionId, name: '排队条位置', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-25T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
const messages = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `正文 ${index + 1}：这条会话在跑，队列里还压着四条。`.repeat(4) }));

// 门自己声明的容差：像素级几何在 headless 里可能抖动 1px（多会话并行时更明显）。
const TOLERANCE = 1;
// 窄屏下正文区至少还得能用：低于这个高度就说明队列把正文挤没了。
const MIN_MESSAGES_HEIGHT = 120;

const cleanupProblems = [];
let browser;
let chromium;
let server;
let sessionStream;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function waitFor(operation, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl, pageProblems) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          listeners.get(method).delete(listener);
          resolve(params);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

async function frames(count = 4) {
  await evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}

async function emit(name, data = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

// 一次量清所有几何：队列 / composer / 正文区 / 顶栏 + 槽语言 + 禁项 + 语义。
async function measure() {
  return evaluate(`(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top * 100) / 100, bottom: Math.round(rect.bottom * 100) / 100, left: Math.round(rect.left * 100) / 100, right: Math.round(rect.right * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 };
    };
    const queue = document.querySelector('#queue-status');
    const composer = document.querySelector('#composer');
    const messages = document.querySelector('#messages');
    const queueBox = box('#queue-status');
    const composerBox = box('#composer');
    const messagesBox = box('#messages');
    const headerBox = box('header');
    const style = getComputedStyle(queue);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      queue: queueBox,
      composer: composerBox,
      messages: messagesBox,
      header: headerBox,
      gapComposerTopMinusQueueBottom: Math.round((composerBox.top - queueBox.bottom) * 100) / 100,
      gapQueueTopMinusMessagesBottom: Math.round((queueBox.top - messagesBox.bottom) * 100) / 100,
      deltaLeft: Math.round((queueBox.left - composerBox.left) * 100) / 100,
      deltaRight: Math.round((queueBox.right - composerBox.right) * 100) / 100,
      inHeader: document.querySelector('header #queue-status') !== null,
      insideComposer: composer.contains(queue),
      queueHidden: queue.hidden,
      summary: document.querySelector('#queue-status strong')?.textContent ?? '',
      items: Array.from(document.querySelectorAll('#queue-status .queue-item')).map((node) => ({ type: node.dataset.queueType, text: node.textContent })),
      slotWidth: style.borderInlineStartWidth,
      slotStyleKind: style.borderInlineStartStyle,
      slotCountInQueue: [queue, ...queue.querySelectorAll('*')].filter((node) => getComputedStyle(node).borderInlineStartWidth === '3px').length,
      flexWrap: style.flexWrap,
      fontSize: style.fontSize,
      shadows: Array.from(document.querySelectorAll('*')).filter((node) => getComputedStyle(node).boxShadow !== 'none').map((node) => node.id || node.className || node.tagName),
      gradients: Array.from(document.querySelectorAll('*')).filter((node) => getComputedStyle(node).backgroundImage !== 'none').map((node) => node.id || node.className || node.tagName),
      promptDisabled: document.querySelector('#prompt').disabled,
      messagesScrollHeight: messages.scrollHeight,
      messagesClientHeight: messages.clientHeight,
      composerChildren: Array.from(composer.children).map((node) => node.id || node.tagName),
      paletteVisible: document.querySelector('#command-palette')?.hidden === false,
      palette: document.querySelector('#command-palette')?.hidden === false ? box('#command-palette') : null,
    };
  })()`);
}

function assertQueueRow(label, shot, state, { minMessagesHeight, expectedItems = 4 }) {
  print(`${label} 几何`, {
    viewport: state.viewport,
    顶栏底: state.header.bottom,
    队列: state.queue,
    composer: state.composer,
    正文区: state.messages,
    队列底到composer顶: state.gapComposerTopMinusQueueBottom,
    队列顶到正文区底: state.gapQueueTopMinusMessagesBottom,
    左端差: state.deltaLeft,
    右端差: state.deltaRight,
    screenshot: shot,
  });
  // 一次把所有违反项收集起来再断言：这道门的失败信息本身就是「队列现在量在哪」。
  const violations = [];
  const want = (ok, detail) => { if (!ok) violations.push(detail); };
  want(state.queueHidden === false, `队列 fixture 没显示（hidden=true）`);
  want(state.inHeader === false, `队列又在 <header> 顶栏里了（header #queue-status 存在）`);
  want(state.insideComposer === false, `队列被塞进 composer 表单里（应贴在它上方）`);
  want(state.items.length === expectedItems, `队列条目数=${state.items.length}（应为 ${expectedItems}）`);
  want(state.summary === `⏳ 排队中 · ${expectedItems} 条`, `摘要=${JSON.stringify(state.summary)}`);
  want(state.items.every((item) => item.type === 'steer' || item.type === 'follow-up'), `有条目没有 queue 类型：${JSON.stringify(state.items)}`);
  want(state.items.filter((item) => item.type === 'steer').length === expectedItems / 2, `插话条目数=${state.items.filter((item) => item.type === 'steer').length}`);
  want(state.items.filter((item) => item.type === 'follow-up').length === expectedItems / 2, `排队条目数=${state.items.filter((item) => item.type === 'follow-up').length}`);
  // 语义：插话与排队在文本上必须分得清（renderer 的 steer：/ follow-up： 前缀）。
  want(state.items.filter((item) => item.type === 'steer').every((item) => /^steer：/.test(item.text)), `插话条目没带 steer 前缀`);
  want(state.items.filter((item) => item.type === 'follow-up').every((item) => /^follow-up：/.test(item.text)), `排队条目没带 follow-up 前缀`);
  // 核心几何：队列底不得低于 composer 顶（+容差），且必须相邻。
  want(state.queue.bottom <= state.composer.top + TOLERANCE, `队列底 ${state.queue.bottom} 超过 composer 顶 ${state.composer.top}（容差 ${TOLERANCE}）`);
  want(Math.abs(state.gapComposerTopMinusQueueBottom) <= TOLERANCE, `队列与 composer 不相邻，间隔 ${state.gapComposerTopMinusQueueBottom}px`);
  // 水平对齐（同一列、同一左右边界）。
  want(Math.abs(state.deltaLeft) <= TOLERANCE && Math.abs(state.deltaRight) <= TOLERANCE, `队列与 composer 水平没对齐（左差 ${state.deltaLeft}，右差 ${state.deltaRight}）`);
  // 留在视口内、不压正文区。
  want(state.queue.top >= -TOLERANCE && state.queue.bottom <= state.viewport.height + TOLERANCE, `队列不在视口内（${state.queue.top}..${state.queue.bottom} / 视口高 ${state.viewport.height}）`);
  want(state.gapQueueTopMinusMessagesBottom >= -TOLERANCE, `队列不在正文区下方（队列顶 ${state.queue.top} < 正文区底 ${state.messages.bottom}）`);
  want(state.messages.height >= minMessagesHeight, `正文区被挤到 ${state.messages.height}px（下限 ${minMessagesHeight}px）`);
  // 视觉语言：1 个 3px 槽、无阴影/渐变、字号与既有 12px 行一致。
  want(state.slotWidth === '3px', `队列左槽宽 ${state.slotWidth}`);
  want(state.slotStyleKind === 'solid', `队列左槽样式 ${state.slotStyleKind}`);
  want(state.slotCountInQueue === 1, `队列这一行有 ${state.slotCountInQueue} 个 3px 槽（应恰好 1 个）`);
  want(state.shadows.length === 0, `阴影禁用（命中 ${JSON.stringify(state.shadows)}）`);
  want(state.gradients.length === 0, `渐变禁用（命中 ${JSON.stringify(state.gradients)}）`);
  want(state.fontSize === '12px', `队列字号 ${state.fontSize}`);
  want(state.flexWrap === 'wrap', `队列仍是可换行的行（flex-wrap=${state.flexWrap}）`);
  assert.deepEqual(violations, [], `[${label}] 队列几何契约未满足（${violations.length} 项）：\n  - ${violations.join('\n  - ')}`);
}

let port;
let stress;
const captured = [];
try {
  await mkdir(artifactRoot, { recursive: true });
  port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: '排队条位置', runtime: { isStreaming: true, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages, extras: [], compaction: { atIndex: null }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/commands`) return sendJson(response, 200, { streaming: true, commands: [] });
    if (url.pathname === `/api/sessions/${sessionId}/seen`) return sendJson(response, 200, { ok: true });
    if (url.pathname === `/api/sessions/${sessionId}/draft`) return sendJson(response, 200, { text: '' });
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: true, isCompacting: false, isRetrying: false, pendingMessages: 4 })}\n\n`);
      sessionStream = response;
      response.once('close', () => { if (sessionStream === response) sessionStream = null; });
      return;
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return result?.ok ? result.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), '会话行没渲染');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelectorAll('#messages .message').length === ${messages.length}`), '会话没打开');

  // 真 SSE 事件造出队列状态（照 live-dedup 的做法），而不是直接写 DOM。
  const setQueue = async (fixture) => {
    await emit('session.queue', fixture);
    const expected = fixture.steering.length + fixture.followUp.length;
    await waitFor(() => evaluate(`document.querySelectorAll('#queue-status .queue-item').length === ${expected} && document.querySelector('#queue-status').hidden === false`), `队列 fixture（${expected} 条）没渲染出来`);
    await frames();
  };

  // 每种视口都先量完、拍完再断言：这样几何错了时，一次运行就给出全部场景的数字和截图。
  const capture = async ({ label, width, height, file }) => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await frames();
    const state = await measure();
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    captured.push({ label, state, shot: file });
    return state;
  };

  await setQueue(queueFixture);
  const wide = await capture({ label: '宽屏 1200x760', width: 1200, height: 760, file: wideShotFile });
  const narrow = await capture({ label: '窄屏 420x820', width: 420, height: 820, file: narrowShotFile });

  assertQueueRow('宽屏 1200x760', wideShotFile, wide, { minMessagesHeight: MIN_MESSAGES_HEIGHT });
  assertQueueRow('窄屏 420x820', narrowShotFile, narrow, { minMessagesHeight: MIN_MESSAGES_HEIGHT });

  // 压力场景：队列很长（12 条）时也不能把正文区挤到不能用 —— 条自己滚，上限就是 max-height。
  // 同时把命令面板打开（它会占 composer 的第一行），确认面板不与队列叠印。
  await setQueue({
    steering: Array.from({ length: 6 }, (_, index) => `S-${index + 1} 插话：压满队列看正文还剩多少`),
    followUp: Array.from({ length: 6 }, (_, index) => `F-${index + 1} 排队：压满队列看正文还剩多少`),
  });
  stress = await capture({ label: '窄屏 420x820 + 12 条队列', width: 420, height: 820, file: stressShotFile });
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.focus(); input.value='/'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => evaluate(`document.querySelector('#command-palette') !== null && document.querySelector('#command-palette').hidden === false`), '命令面板没打开');
  await frames();
  const stressPalette = await measure();
  captured.push({ label: '窄屏 420x820 + 12 条队列 + 命令面板', state: stressPalette, shot: stressShotFile });

  assertQueueRow('窄屏 420x820 + 12 条队列', stressShotFile, stress, { minMessagesHeight: MIN_MESSAGES_HEIGHT, expectedItems: 12 });
  // 上限生效：队列不会无限长，超出部分自己滚。
  const cap = await evaluate(`(() => { const node=document.querySelector('#queue-status'); const style=getComputedStyle(node); return {height:node.getBoundingClientRect().height,maxHeight:parseFloat(style.maxHeight),scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,overflowY:style.overflowY}; })()`);
  assert.ok(cap.height <= cap.maxHeight + 1, `12 条队列超过 max-height：${JSON.stringify(cap)}`);
  assert.ok(cap.scrollHeight > cap.clientHeight, `12 条队列没有自滚（scrollHeight ${cap.scrollHeight} <= clientHeight ${cap.clientHeight}）`);
  assert.match(cap.overflowY, /^(auto|scroll)$/, `队列 overflow-y=${cap.overflowY}`);
  print('12 条队列的上限/自滚', cap);
  // 命令面板（composer 的第一行）不得与队列重叠；队列仍在 composer 上方。
  assert.equal(stressPalette.paletteVisible, true, '命令面板 fixture 没显示');
  assert.ok(stressPalette.palette.top >= stressPalette.queue.bottom - TOLERANCE, `命令面板压住了队列（面板顶 ${stressPalette.palette.top} < 队列底 ${stressPalette.queue.bottom}）`);
  assert.ok(stressPalette.queue.bottom <= stressPalette.composer.top + TOLERANCE, `命令面板打开后队列不再贴在 composer 上方（队列底 ${stressPalette.queue.bottom} / composer 顶 ${stressPalette.composer.top}）`);
  print('队列 + 命令面板同时打开', { queue: stressPalette.queue, palette: stressPalette.palette, composer: stressPalette.composer });

  // 空队列：那一行必须真的收成 0 高（auto 行收 0），否则 composer 上方会永久留一条缝。
  await emit('session.queue', { steering: [], followUp: [] });
  await waitFor(() => evaluate(`document.querySelector('#queue-status').hidden === true`), '空队列没隐藏');
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await frames();
  const cleared = await evaluate(`(() => { const queue=document.querySelector('#queue-status'); const messages=document.querySelector('#messages'); const composer=document.querySelector('#composer'); const queueRect=queue.getBoundingClientRect(); const messagesRect=messages.getBoundingClientRect(); const composerRect=composer.getBoundingClientRect(); return {hidden:queue.hidden, queueHeight:queueRect.height, queueDisplay:getComputedStyle(queue).display, messagesBottom:Math.round(messagesRect.bottom*100)/100, composerTop:Math.round(composerRect.top*100)/100, composerBottom:Math.round(composerRect.bottom*100)/100, viewportHeight:window.innerHeight, paletteHidden:document.querySelector('#command-palette').hidden}; })()`);
  assert.equal(cleared.hidden, true, `空队列后 #queue-status 没隐藏：${JSON.stringify(cleared)}`);
  assert.equal(cleared.queueDisplay, 'none', `空队列后那一行还在占位（display=${cleared.queueDisplay}）`);
  assert.equal(cleared.queueHeight, 0, `空队列后队列行高 ${cleared.queueHeight}（应为 0）`);
  assert.ok(Math.abs(cleared.messagesBottom - cleared.composerTop) <= TOLERANCE, `空队列后正文区底 ${cleared.messagesBottom} 与 composer 顶 ${cleared.composerTop} 之间留了缝`);
  assert.ok(Math.abs(cleared.composerBottom - cleared.viewportHeight) <= TOLERANCE, `composer 没贴住视口底（${cleared.composerBottom} / ${cleared.viewportHeight}）`);
  print('空队列时不留空行', cleared);

  assert.equal(pageProblems.length, 0, `页面未捕获异常/console.error：${JSON.stringify(pageProblems)}`);
  assert.equal(wide.composerChildren.includes('queue-status'), false, '队列不应成为 composer 的子节点');
  print('chromium', { product: version.Browser, executable: chrome, port, debugPort, forbiddenPortsUsed: false });
  print('screenshots', { wide: wideShotFile, narrow: narrowShotFile, longQueue: stressShotFile });
  print('RESULT', 'queue sits directly above the composer (wide + narrow + long queue) PASS');
} catch (error) {
  // 失败信息就是「队列量在哪」，所以先把量到的几何打出来再抛。
  for (const row of captured) print(`失败时 ${row.label} 几何`, row.state);
  print('失败时截图', Object.fromEntries(captured.map((row) => [row.label, row.shot])));
  throw error;
} finally {
  await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
  await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', async () => {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  if (server) {
    await cleanupStep(cleanupProblems, 'close server', async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(null, cleanupProblems);
}
