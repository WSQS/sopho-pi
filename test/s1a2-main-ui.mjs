import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-main-ui-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-main-ui');
const screenshots = {
  wideShown: path.join(artifactRoot, 'main-ui-jump-1200x760.png'),
  narrowShown: path.join(artifactRoot, 'main-ui-jump-420x820.png'),
  bottomHidden: path.join(artifactRoot, 'main-ui-bottom-hidden-1200x760.png'),
};
const sessionId = '11111111-1111-4111-8111-111111111111';
const longText = (label) => `${label}：${'这是一段用于撑开真实消息滚动区的中文内容。'.repeat(7)}`;
const messages = Array.from({ length: 36 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: longText(`历史消息 ${index + 1}`),
}));
const sessions = [{
  id: sessionId,
  name: '主界面滚动回归',
  parentId: null,
  archived: false,
  status: 'idle',
  statusLabel: '闲置',
  unread: false,
  modifiedAt: '2026-09-18T08:00:00.000Z',
  notify: { notifies: [], waitingFor: [] },
}];
const posted = [];
let browser;
let chromium;
let server;
let sessionStream;
let treeStream;
let checks = 0;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
    if (message.method === 'Runtime.exceptionThrown') {
      pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    }
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

async function screenshot(file) {
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
}

async function emit(name, data = {}) {
  await evaluate(`fetch('/api/test/event',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify({ name, data }))}}).then(r=>r.json())`);
}

async function frames(count = 2) {
  await evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}

async function state() {
  return evaluate(`(() => {
    const messages=document.querySelector('#messages');
    const button=document.querySelector('#jump');
    const pane=document.querySelector('.messages-pane');
    const mr=messages.getBoundingClientRect(); const br=button.getBoundingClientRect(); const pr=pane.getBoundingClientRect();
    return {
      dist:Math.round(messages.scrollHeight-messages.scrollTop-messages.clientHeight),
      top:Math.round(messages.scrollTop),scrollHeight:messages.scrollHeight,clientHeight:messages.clientHeight,
      button:{show:button.classList.contains('show'),display:getComputedStyle(button).display,width:Math.round(br.width),height:Math.round(br.height),slot:getComputedStyle(button).borderLeftColor,expectedSlot:getComputedStyle(document.documentElement).getPropertyValue('--slot-idle').trim(),background:getComputedStyle(button).backgroundColor,expectedBackground:getComputedStyle(document.documentElement).getPropertyValue('--raised').trim()},
      geometry:{inside:br.left>=mr.left-1&&br.right<=mr.right+1&&br.top>=mr.top-1&&br.bottom<=mr.bottom+1,fromRight:Math.round(mr.right-br.right),fromBottom:Math.round(mr.bottom-br.bottom),paneRight:Math.round(pr.right-br.right),paneBottom:Math.round(pr.bottom-br.bottom)},
      liveLength:document.querySelector('.live-message .message-body')?.textContent.length||0
    };
  })()`);
}

async function navigate(url) {
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'session row did not render');
}

async function openSession() {
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelectorAll('#messages .message').length === ${messages.length}`), 'session messages did not open');
  await frames(3);
}

async function runTreeFoldGate(chrome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/s1a2-tree-fold.mjs'], {
      cwd: root,
      env: { ...process.env, CHROME_BIN: chrome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`tree-fold 子门失败（exit ${code}）\n${stdout}\n${stderr}`));
      const result = stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT:')) || 'RESULT line missing';
      print('tree-fold reused gate', result);
      resolve(result);
    });
  });
}

let primaryError;
try {
  await mkdir(artifactRoot, { recursive: true });
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: sessions[0].name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages, extras: [], compaction: { atIndex: null }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/commands`) return sendJson(response, 200, { streaming: false, commands: [] });
    if (url.pathname === `/api/sessions/${sessionId}/seen`) return sendJson(response, 200, { ok: true });
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      sessionStream = response;
      return;
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const { name, data } = JSON.parse(await requestBody(request));
      if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream is not connected' });
      sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname.startsWith(`/api/sessions/${sessionId}/`) && request.method === 'POST') {
      posted.push({ path: url.pathname, body: JSON.parse(await requestBody(request) || '{}') });
      return sendJson(response, 202, { accepted: true });
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
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });

  await navigate(`http://127.0.0.1:${port}/`);
  await openSession();
  const opened = await state();
  check('冷启动打开会话后直接到底、按钮隐藏', opened.dist <= 4 && !opened.button.show && opened.button.display === 'none', `距底 ${opened.dist}px；按钮 show=${opened.button.show} display=${opened.button.display}`);

  await emit('session.start', { role: 'assistant' });
  for (let index = 0; index < 5; index += 1) await emit('session.delta', { channel: 'text', delta: longText(`流式预热 ${index}`) });
  await frames(3);
  const beforeUp = await state();
  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=Math.max(0,node.scrollTop-60); node.dispatchEvent(new Event('scroll')); })()`);
  await frames(2);
  const scrolled = await state();
  check('流式前确实贴着底', beforeUp.dist <= 4, `距底 ${beforeUp.dist}px`);
  check('往上滚 60px 确实滚开了', scrolled.dist >= 50 && scrolled.dist <= 70, `距底 ${scrolled.dist}px`);
  check('按钮浮出且落在消息区内右下', scrolled.button.show && scrolled.button.display !== 'none' && scrolled.geometry.inside, `show=${scrolled.button.show}；尺寸 ${scrolled.button.width}×${scrolled.button.height}px；距右 ${scrolled.geometry.fromRight}px；距底 ${scrolled.geometry.fromBottom}px；inside=${scrolled.geometry.inside}`);
  check('按钮颜色只走现有槽与抬升面 token', scrolled.button.slot === 'rgb(77, 80, 88)' && scrolled.button.expectedSlot === '#4d5058' && scrolled.button.background === 'rgb(22, 23, 28)' && scrolled.button.expectedBackground === '#16171c', `槽 ${scrolled.button.slot} ← ${scrolled.button.expectedSlot}；背景 ${scrolled.button.background} ← ${scrolled.button.expectedBackground}`);
  await screenshot(screenshots.wideShown);

  const samples = [];
  for (let index = 0; index < 12; index += 1) {
    await emit('session.delta', { channel: 'text', delta: longText(`继续流式 ${index}`) });
    await frames(1);
    samples.push((await state()).dist);
  }
  const stayedAway = await state();
  check('不贴底时流式追加 12 次仍不跟随', Math.min(...samples) > 50 && samples.every((value, index) => index === 0 || value >= samples[index - 1] - 1), `距底采样 ${JSON.stringify(samples)}；直播长度 ${stayedAway.liveLength}`);

  await evaluate(`document.querySelector('#jump').click()`);
  await frames(3);
  const jumped = await state();
  check('点击回到底部后按钮消失', jumped.dist <= 4 && !jumped.button.show && jumped.button.display === 'none', `距底 ${jumped.dist}px；按钮 show=${jumped.button.show} display=${jumped.button.display}`);
  await screenshot(screenshots.bottomHidden);
  const liveBeforeFollow = jumped.liveLength;
  for (let index = 0; index < 3; index += 1) await emit('session.delta', { channel: 'text', delta: longText(`恢复跟随 ${index}`) });
  await frames(3);
  const followed = await state();
  check('继续流式仍贴着底（自动跟随恢复）', followed.dist <= 4 && !followed.button.show && followed.liveLength > liveBeforeFollow, `距底 ${followed.dist}px；直播文本 ${liveBeforeFollow} → ${followed.liveLength}`);

  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=node.scrollHeight-node.clientHeight-2; node.dispatchEvent(new Event('scroll')); })()`);
  await frames(2);
  const twoPixels = await state();
  await emit('session.delta', { channel: 'text', delta: longText('两像素阈值后继续') });
  await frames(3);
  const twoPixelsAfter = await state();
  check('2px 视为贴底：不显示按钮、继续跟到底', twoPixels.dist === 2 && !twoPixels.button.show && twoPixelsAfter.dist <= 4 && !twoPixelsAfter.button.show, `追加前距底 ${twoPixels.dist}px/show=${twoPixels.button.show}；追加后距底 ${twoPixelsAfter.dist}px/show=${twoPixelsAfter.button.show}`);

  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=Math.max(0,node.scrollTop-90); node.dispatchEvent(new Event('scroll')); })()`);
  await frames(2);
  const beforeSend = await state();
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='滚开后发送也要回到底部'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#send').click(); })()`);
  await waitFor(() => posted.length > 0, 'message request was not captured');
  await frames(3);
  const afterSend = await state();
  check('发消息前确实处于「不跟随」', beforeSend.dist > 50 && beforeSend.button.show, `距底 ${beforeSend.dist}px；按钮 show=${beforeSend.button.show}`);
  check('发消息后直接到底、按钮消失', afterSend.dist <= 4 && !afterSend.button.show, `距底 ${afterSend.dist}px；按钮 show=${afterSend.button.show}；请求 ${JSON.stringify(posted.at(-1))}`);

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=node.scrollHeight; node.dispatchEvent(new Event('scroll')); node.scrollTop=Math.max(0,node.scrollTop-80); node.dispatchEvent(new Event('scroll')); })()`);
  await frames(3);
  const narrow = await state();
  check('420×820 窄屏按钮仍在消息区右下且不盖出边界', narrow.dist >= 70 && narrow.button.show && narrow.geometry.inside && narrow.geometry.fromRight >= 7 && narrow.geometry.fromBottom >= 7, `距底 ${narrow.dist}px；尺寸 ${narrow.button.width}×${narrow.button.height}px；距右 ${narrow.geometry.fromRight}px；距底 ${narrow.geometry.fromBottom}px；inside=${narrow.geometry.inside}`);
  await screenshot(screenshots.narrowShown);

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  treeStream?.destroy();
  sessionStream?.destroy();
  await navigate(`http://127.0.0.1:${port}/?cold=1`);
  await openSession();
  const reopened = await state();
  check('重新加载后打开会话仍直接到底、按钮隐藏', reopened.dist <= 4 && !reopened.button.show, `距底 ${reopened.dist}px；按钮 show=${reopened.button.show}`);
  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  const foldResult = await runTreeFoldGate(chrome);
  check('折叠与存档箱沿用现有真实 Chromium 契约', foldResult.includes('PASS'), foldResult);

  print('关键实测值', {
    wideButton: { size: `${scrolled.button.width}x${scrolled.button.height}`, fromRight: scrolled.geometry.fromRight, fromBottom: scrolled.geometry.fromBottom },
    narrowButton: { size: `${narrow.button.width}x${narrow.button.height}`, fromRight: narrow.geometry.fromRight, fromBottom: narrow.geometry.fromBottom },
    threshold: { before: twoPixels.dist, afterAppend: twoPixelsAfter.dist },
    notFollowingSamples: samples,
    followedAfterAppend: followed.dist,
    afterSend: afterSend.dist,
  });
  print('screenshots', screenshots);
  print('chromium', { product: version.Browser, chrome, port, debugPort, forbiddenPortsUsed: false });
  print('checks', checks);
  print('RESULT', 'S1a-2 main UI phase 1 PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  treeStream?.destroy();
  sessionStream?.destroy();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
