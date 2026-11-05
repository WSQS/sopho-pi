import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readPort(name, fallback) {
  const raw = process.env[name] || fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

const APP_SOURCE_VERSION = 's0b-v1';
const startedAt = new Date();
// B（app）的宿主**不跟 A 走** —— 与 `bin/serve.sh` 的 `${SOPHO_APP_HOST:-0.0.0.0}` 和 `bin/serve-win.ps1`
// 的 `$AppHost = '0.0.0.0'` **同口径**：显式给 `SOPHO_APP_HOST` 才覆盖，否则默认对局域网；
// **故意不继承 `SOPHO_HOST`**（A 的宿主默认是回环，跟着它走正是「局域网里的浏览器连不上网页」——
// 业主 2026-09-23 裁定要修的那个现象；那条修法原先只覆盖了两个启动脚本，手起 `node server/app.mjs`
// 仍会落到继承上 ⇒ 2026-09-25 业主裁定「统一」，本行照此改）。
// ⚠️ B 是**零认证**的：只想要回环请显式给 `SOPHO_APP_HOST=127.0.0.1`（沙箱那条路仍然可用）。
const host = process.env.SOPHO_APP_HOST || '0.0.0.0';
const port = readPort('SOPHO_APP_PORT', '7321');
const upstreamHost = process.env.SOPHO_UPSTREAM_HOST || process.env.SOPHO_HOST || '127.0.0.1';
const upstreamPort = readPort('SOPHO_UPSTREAM_PORT', process.env.SOPHO_PORT || '7331');
const defaultWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const webRoot = path.resolve(process.env.SOPHO_WEB_ROOT || defaultWebRoot);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function send(response, statusCode, headers, body = '', { omitBody = false } = {}) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(omitBody ? undefined : body);
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  send(response, statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, body);
}

function isEventStreamContentType(value) {
  const raw = Array.isArray(value) ? value.join(',') : value || '';
  return /text\/event-stream/i.test(raw);
}

// ⚠️ 「这是不是 SSE」的**事实来源是上游响应的 `content-type`**，不是客户端的 `Accept` 头（2026-09-26）。
// 业主报的那条 aiohttp `TransferEncodingError`（`Response payload is not completed`）的根就在这里：
// **`Accept: */*` 是 aiohttp 的默认**，用 `Accept` 判就把一条 SSE 判成「不是 SSE」⇒ 上游死掉时
// 这个进程会 `response.destroy()` ⇒ 掐断一条 chunked 流。`/…/events` 这条路在 worker 侧由 `beginSse`
// **无条件**发 `text/event-stream` ⇒ 上游响应头比客户端请求头更接近事实。
// （`server/base.mjs` 里同名函数是它的**同口径拷贝** —— 两处必须一起改。）
function wantsEventStream(request) {
  return isEventStreamContentType(request.headers.accept);
}

function sendSseSoftFailure(response, error) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  const body = `retry: 1000\n: upstream unavailable (${detail.replaceAll('\n', ' ')})\n\n`;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  });
  response.end(body);
}

// ⚠️ 下游还开着的**长活 SSE 响应**的登记表（2026-09-26）。`server.close()` 只会**等**它们、
// `closeIdleConnections()` 也不会收「正在处理请求」的连接 ⇒ 收摊末尾那次 `process.exit(0)`
// 会把 chunked 流**直接切断**，客户端（aiohttp / EventSource）看到的不是干净收尾而是
// `TransferEncodingError`（门 `test/sse-truncation.mjs` 的臂 ⑤ 量的就是这个）。
// 登记用的是**上游响应的 content-type**（与本文件其余处同一个事实来源），不是客户端的 `Accept`。
const openSseResponses = new Set();

function proxyRequest(request, response, url) {
  // 上游还**没回话**时用（连接直接失败）—— 那时只能退回客户端想要的。
  // 一旦拿到上游响应，改看它的 content-type（下面的 `sseByUpstream`）。
  const sse = wantsEventStream(request);
  const upstreamPath = `${url.pathname.slice('/api'.length) || '/'}${url.search}`;
  const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
  // B is the only process that ever sees the real browser: host A and its generation
  // workers only ever see B over loopback. Forward the immediate peer so the logic
  // layer can make the loopback-only compression decision (see server/base-logic.mjs
  // `requestPeerAddress`). Overwrite, never append: a client-supplied x-forwarded-for
  // must not be able to steer the decision, and B is the edge here, not a hop in a chain.
  const peerAddress = request.socket?.remoteAddress ?? null;
  if (peerAddress) headers['x-forwarded-for'] = peerAddress;
  else delete headers['x-forwarded-for'];
  let settled = false;
  let upstreamResponse;

  const upstreamRequest = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: upstreamPath,
    headers,
  });

  const destroyUpstream = () => {
    const error = new Error('downstream client disconnected');
    if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy(error);
    if (!upstreamRequest.destroyed) upstreamRequest.destroy(error);
  };

  request.once('aborted', destroyUpstream);
  response.once('close', () => {
    if (!response.writableEnded) destroyUpstream();
  });

  upstreamRequest.once('response', (incomingResponse) => {
    settled = true;
    upstreamResponse = incomingResponse;
    upstreamResponse.once('error', (error) => {
      // ⚠️ 上游响应已经到手 ⇒ 判「是不是 SSE」以**上游响应的 content-type** 为准，而不是客户端的
      // `Accept` 头（`Accept: */*` 是 aiohttp 的默认；用 `Accept` 判就会 `response.destroy()` 掉一条
      // chunked 流 ⇒ 客户端看到 TransferEncodingError）。`|| sse` 只兜「上游没给 content-type」。
      const sseByUpstream = isEventStreamContentType(upstreamResponse.headers['content-type']) || sse;
      if (sseByUpstream) sendSseSoftFailure(response, error);
      else if (!response.headersSent) sendJson(response, 502, { error: 'upstream unavailable' });
      else response.destroy(error);
    });
    if (response.destroyed) {
      upstreamResponse.destroy();
      return;
    }
    if (isEventStreamContentType(upstreamResponse.headers['content-type'])) {
      openSseResponses.add(response);
      response.once('close', () => openSseResponses.delete(response));
    }
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstreamRequest.once('error', (error) => {
    if (settled || response.destroyed) return;
    if (sse) sendSseSoftFailure(response, error);
    else sendJson(response, 502, { error: 'upstream unavailable' });
  });

  request.pipe(upstreamRequest);
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: 'invalid URL encoding' });
    return true;
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(webRoot, `.${pathname}`);
  const relative = path.relative(webRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(response, 403, { error: 'forbidden' });
    return true;
  }

  try {
    const body = await readFile(filePath);
    const headers = {
      'content-type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'no-store',
    };
    // HEAD must report the length the equivalent GET would return, so compute it from the
    // body we actually read and only omit the body itself.
    if (request.method === 'HEAD') send(response, 200, headers, body, { omitBody: true });
    else send(response, 200, headers, body);
  } catch (error) {
    if (error && error.code === 'ENOENT') sendJson(response, 404, { error: 'not found' });
    else throw error;
  }
  return true;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://app.local');
    if (request.method === 'GET' && url.pathname === '/app-host') {
      sendJson(response, 200, {
        pid: process.pid,
        codeVersion: APP_SOURCE_VERSION,
        startedAt: startedAt.toISOString(),
        upstream: `http://${upstreamHost}:${upstreamPort}`,
        webRoot,
      });
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      proxyRequest(request, response, url);
      return;
    }
    if (await serveStatic(request, response, url)) return;
    sendJson(response, 405, { error: 'method not allowed' });
  } catch (error) {
    console.error('[app] request failed', error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
});

server.on('clientError', (error, socket) => {
  console.error('[app] client error', error);
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (error) => {
  console.error(`[app] server error on ${host}:${port}`, error);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] ${signal} received`);
  // 收摊第一步：把登记在册的下游 SSE **干净 end() 掉**（补上 chunked 终止块），再去关服务器。
  // 不先做这一步，后面那次 `process.exit(0)` 就是“硬切断”（客户端拿到 TransferEncodingError）。
  for (const response of [...openSseResponses]) {
    try { if (!response.destroyed && !response.writableEnded) response.end(); } catch { /* 已经走了 */ }
  }
  openSseResponses.clear();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: 'listening',
    host,
    port,
    pid: process.pid,
    upstream: `http://${upstreamHost}:${upstreamPort}`,
    webRoot,
  }));
});
