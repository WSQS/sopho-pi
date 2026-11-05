import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-tree-fold-'));
const ids = {
  live: '11111111-1111-4111-8111-111111111111',
  archivedParent: '22222222-2222-4222-8222-222222222222',
  archivedChild: '33333333-3333-4333-8333-333333333333',
  archivedGrandchild: '44444444-4444-4444-8444-444444444444',
  liveUnderArchive: '55555555-5555-4555-8555-555555555555',
  archivedUnderLive: '66666666-6666-4666-8666-666666666666',
  atticRoot: '77777777-7777-4777-8777-777777777777',
  atticChild: '88888888-8888-4888-8888-888888888888',
};
const sessions = [
  { id: ids.atticChild, name: 'Attic child', archived: true, parentId: ids.atticRoot, modifiedAt: '2026-09-18T01:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.archivedGrandchild, name: 'Archived grandchild', archived: true, parentId: ids.archivedChild, modifiedAt: '2026-09-18T03:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.liveUnderArchive, name: 'Live under archive', archived: false, parentId: ids.archivedParent, modifiedAt: '2026-09-18T05:00:00.000Z', hiddenByArchive: true, status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.archivedUnderLive, name: 'Archived under live child', archived: true, parentId: ids.liveUnderArchive, modifiedAt: '2026-09-18T04:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.archivedChild, name: 'Archived child', archived: true, parentId: ids.archivedParent, modifiedAt: '2026-09-18T06:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.archivedParent, name: 'Archived parent', archived: true, parentId: ids.live, modifiedAt: '2026-09-18T07:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true, cwd: 'C:/full/path', titleSource: 'auto' },
  { id: ids.atticRoot, name: 'Attic root', archived: true, parentId: null, modifiedAt: '2026-09-18T02:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: true },
  { id: ids.live, name: 'Live root', archived: false, parentId: null, modifiedAt: '2026-09-18T08:00:00.000Z', status: 'working', statusLabel: '工作中', unread: false },
].map((session) => ({ notify: { notifies: [], waitingFor: [] }, ...session }));
let browser;
let chromium;
let server;
let treeEventResponses = new Set();
let longRevision = 0;

function longTreeSessions() {
  const rows = [];
  for (let index = 0; index < 36; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const liveId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
    const atticId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`;
    rows.push(
      { id: liveId, name: `Live ${suffix}${index === 0 ? ` r${longRevision}` : ''}`, archived: false, parentId: null, modifiedAt: `2026-09-18T08:${suffix}:00.000Z`, status: 'idle', statusLabel: '闲置', unread: false },
      { id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`, name: `Live archived child ${suffix}`, archived: true, parentId: liveId, modifiedAt: `2026-09-18T07:${suffix}:00.000Z`, status: 'idle', statusLabel: '闲置', unread: false },
      { id: atticId, name: `Attic ${suffix}`, archived: true, parentId: null, modifiedAt: `2026-09-18T06:${suffix}:00.000Z`, status: 'idle', statusLabel: '闲置', unread: false },
      { id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`, name: `Attic child ${suffix}`, archived: true, parentId: atticId, modifiedAt: `2026-09-18T05:${suffix}:00.000Z`, status: 'idle', statusLabel: '闲置', unread: false },
    );
  }
  return rows.map((session) => ({ notify: { notifies: [], waitingFor: [] }, ...session }));
}

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

async function waitFor(fn, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl) {
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.result?.description || 'browser evaluation failed');
  return result.result.value;
}

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/test-long-tree') {
      longRevision += 1;
      sessions.splice(0, sessions.length, ...longTreeSessions());
      for (const stream of treeEventResponses) stream.write(`event: tree.session\ndata: ${JSON.stringify({ sessionId: sessions[0].id, reason: 'test' })}\n\n`);
      return sendJson(response, 200, { revision: longRevision });
    }
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeEventResponses.add(response);
      response.on('close', () => treeEventResponses.delete(response));
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen))?$/.exec(url.pathname);
    if (match) {
      const session = sessions.find((entry) => entry.id === match[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' });
      if (match[2] === 'messages') return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true });
      return sendJson(response, 200, { name: session.name, archived: session.archived, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
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
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${ids.live}"]') !== null`), 'active tree did not render');

  const visibleIds = () => evaluate(`Array.from(document.querySelectorAll('.tree-session')).map((node) => node.dataset.sessionId)`);
  const initialVisible = await visibleIds();
  assert.deepEqual(initialVisible, [ids.live]);
  assert.equal(await evaluate(`document.querySelector('[data-fold-id="${ids.live}"]').textContent`), '▸3');
  assert.equal(await evaluate(`document.querySelector('[data-attic-toggle="true"]').textContent`), '存档 ▸ 1');
  print('default archived chain hidden', { visibleIds: initialVisible, rootMark: '▸3', atticTopLevelCount: 1 });

  await evaluate(`document.querySelector('[data-fold-id="${ids.live}"]').click()`);
  const opened = await waitFor(async () => {
    const value = await evaluate(`({mark:document.querySelector('[data-fold-id="${ids.live}"]').textContent,ids:Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session')).map((node)=>node.dataset.sessionId),archived:Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session[data-archived="true"]')).map((node)=>node.dataset.sessionId)})`);
    return value.mark === '▾3' ? value : null;
  }, 'archived chain did not expand');
  assert.deepEqual(opened.archived, [ids.archivedParent, ids.archivedChild, ids.archivedGrandchild]);
  assert.equal(opened.archived.length, 3);
  assert.deepEqual(opened.ids, [ids.live, ids.archivedParent, ids.archivedChild, ids.archivedGrandchild, ids.liveUnderArchive]);
  assert.equal(await evaluate(`document.querySelector('[data-fold-id="${ids.liveUnderArchive}"]').textContent`), '▸1');
  assert.equal((await visibleIds()).includes(ids.archivedUnderLive), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-active-tree-list="true"] > .tree-session .unread-dot').length`), 0);
  const horizontalOverflow = await evaluate(`(() => { const aside=document.querySelector('aside.tree'); const list=document.querySelector('[data-active-tree-list="true"]'); const offenders=[aside,...aside.querySelectorAll('*')].filter((node)=>{const overflowX=getComputedStyle(node).overflowX;return (overflowX==='auto'||overflowX==='scroll')&&node.scrollWidth>node.clientWidth+1;}).map((node)=>({tag:node.tagName,id:node.id,className:node.className,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,overflowX:getComputedStyle(node).overflowX})); return {aside:{clientWidth:aside.clientWidth,scrollWidth:aside.scrollWidth},list:{clientWidth:list.clientWidth,scrollWidth:list.scrollWidth,overflowX:getComputedStyle(list).overflowX},offenders}; })()`);
  print('sidebar horizontal overflow audit', horizontalOverflow);
  assert.deepEqual(horizontalOverflow.aside, { clientWidth: 303, scrollWidth: 303 });
  // 会话列表那条 `clientWidth == scrollWidth` 是「没有横向溢出」的判据（真正的对象是下面那 3 条）——
  // 这里钉的具体宽度随产品走了：`web/index.html` 的 `#tree` 左内边距归零（业主 2026-09-25：
  // 「会话栏左侧那个空隙去掉，使其铺满一行，除了缩进行的情况」）之后，这条列表从 293 变成 298
  // （aside 303 − 右内边距 4.8 ⇒ 298.2，取整 298；原来还要再减左内边距 4.8）。**不是放宽**：
  // 钉的仍然是「两个数相等 + overflowX auto + 零个溢出节点」，只是那个数跟着左栏的内容宽走了。
  assert.deepEqual(horizontalOverflow.list, { clientWidth: 298, scrollWidth: 298, overflowX: 'auto' });
  assert.deepEqual(horizontalOverflow.offenders, []);
  print('fold count matches archived rows', { mark: opened.mark, archivedRowsOpened: opened.archived.length, visibleIds: opened.ids });
  print('live child does not inherit open state', { liveChild: ids.liveUnderArchive, ownMark: '▸1', archivedChildVisible: false });

  const descendantBefore = await evaluate(`document.querySelector('[data-fold-id="${ids.archivedParent}"]').textContent`);
  assert.equal(descendantBefore, '▾2');
  await evaluate(`document.querySelector('[data-fold-id="${ids.archivedParent}"]').click()`);
  const descendantClosed = await waitFor(async () => {
    const value = await evaluate(`({mark:document.querySelector('[data-fold-id="${ids.archivedParent}"]').textContent,ids:Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session')).map((node)=>node.dataset.sessionId)})`);
    return value.mark === '▸2' ? value : null;
  }, 'inherited-open descendant did not explicitly close');
  assert.deepEqual(descendantClosed.ids, [ids.live, ids.archivedParent, ids.liveUnderArchive]);
  await evaluate(`document.querySelector('[data-fold-id="${ids.archivedParent}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-fold-id="${ids.archivedParent}"]').textContent === '▾2'`), 'descendant did not reopen');
  print('ancestor-open descendant owns explicit close', { before: descendantBefore, closed: descendantClosed.mark, closedVisibleIds: descendantClosed.ids, reopened: '▾2' });

  const openSnapshot = await visibleIds();
  const markerIds = await evaluate(`Array.from(document.querySelectorAll('.fold-toggle')).map((node)=>node.dataset.foldId)`);
  for (const id of markerIds) {
    await evaluate(`document.querySelector('[data-fold-id="${id}"]').click()`);
    await evaluate(`document.querySelector('[data-fold-id="${id}"]').click()`);
  }
  assert.deepEqual(await visibleIds(), openSnapshot);
  print('all visible markers are reversible', { markerIds, visibleIds: openSnapshot });

  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  const attic = await waitFor(async () => {
    const value = await evaluate(`(() => { const button=document.querySelector('[data-attic-toggle="true"]'); const list=document.querySelector('[data-attic-list="true"]'); return {expanded:button.getAttribute('aria-expanded'),heading:document.querySelector('.attic-heading')?.textContent,ids:Array.from(list?.querySelectorAll('.tree-session')||[]).map((node)=>node.dataset.sessionId),below:list?.getBoundingClientRect().top >= button.getBoundingClientRect().bottom}; })()`);
    return value.expanded === 'true' ? value : null;
  }, 'attic did not expand');
  assert.equal(attic.heading, '存档箱 · 顶层 1 个（不在上面的树里）');
  assert.equal(attic.below, true);
  assert.deepEqual(attic.ids, [ids.atticRoot]);
  assert.equal(attic.ids.includes(ids.atticChild), false);
  await evaluate(`document.querySelector('[data-fold-id="${ids.atticRoot}"]').click()`);
  assert.deepEqual(await waitFor(async () => {
    const value = await evaluate(`Array.from(document.querySelectorAll('.attic-list .tree-session')).map((node)=>node.dataset.sessionId)`);
    return value.length === 2 ? value : null;
  }, 'attic child did not expand from its parent marker'), [ids.atticRoot, ids.atticChild]);
  assert.equal(await evaluate(`document.querySelectorAll('.attic-list .unread-dot').length`), 0);
  assert.equal(await evaluate(`document.querySelector('[data-session-id="${ids.archivedParent}"]').title.includes('${ids.archivedParent}')`), true);
  assert.equal(await evaluate(`document.querySelector('[data-session-id="${ids.archivedParent}"]').dataset.sessionId`), ids.archivedParent);
  print('attic roots only + archived subtree silent', attic);

  // 用户口径（2026-09-17）：展开后上下各半，且两个分区各有一条独立滚动轴；
  // 整条左栏自己不再当滚动条（分区的滚动独立性用溢出 fixture 在 test:slot 里量）。
  const wideAxes = await evaluate(`(() => { const aside=document.querySelector('aside.tree'); const active=document.querySelector('[data-active-tree-list="true"]'); const list=document.querySelector('[data-attic-list="true"]'); const axis=(node)=>({clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,overflowY:getComputedStyle(node).overflowY}); return {aside:axis(aside),tree:axis(document.querySelector('#tree')),active:axis(active),attic:axis(list),ratio:active.getBoundingClientRect().height/list.getBoundingClientRect().height}; })()`);
  assert.equal(wideAxes.aside.scrollHeight, wideAxes.aside.clientHeight, JSON.stringify(wideAxes));
  assert.match(wideAxes.active.overflowY, /^(auto|scroll)$/, JSON.stringify(wideAxes));
  assert.match(wideAxes.attic.overflowY, /^(auto|scroll)$/, JSON.stringify(wideAxes));
  assert.ok(Math.abs(wideAxes.ratio - 1) <= .2, JSON.stringify(wideAxes));
  print('wide opening owns two pane scroll axes', wideAxes);

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const narrow = await evaluate(`(() => { const aside=document.querySelector('aside.tree'); const tree=document.querySelector('#tree'); const active=document.querySelector('[data-active-tree-list="true"]'); const first=active.querySelector('.tree-session'); const attic=document.querySelector('[data-attic="true"]'); const list=document.querySelector('[data-attic-list="true"]'); const rect=(node)=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right};}; const activeRect=rect(active); const atticRect=rect(attic); const firstRect=rect(first); const atticFirstRect=rect(list.querySelector('.tree-session')); const siblings=[...aside.children].filter((node)=>getComputedStyle(node).display!=='none').map((node)=>({name:node.id||node.className,...rect(node)})); const overlaps=siblings.flatMap((left,index)=>siblings.slice(index+1).filter((right)=>Math.min(left.right,right.right)>Math.max(left.left,right.left)&&Math.min(left.bottom,right.bottom)>Math.max(left.top,right.top)).map((right)=>[left.name,right.name])); return {viewportHeight:aside.clientHeight,tree:rect(tree),active:activeRect,attic:atticRect,ratio:activeRect.height/atticRect.height,first:firstRect,atticFirst:atticFirstRect,siblingOverlaps:overlaps}; })()`);
  // 方向书要求展开后上下各半；窄屏给 #tree 108px 最小高度，必要时让整栏滚动，优先保证两边首行完整可用。
  assert.ok(narrow.active.height >= 52 && narrow.attic.height >= 52, `split panes collapsed: ${JSON.stringify(narrow)}`);
  assert.ok(Math.abs(narrow.ratio - 1) <= .2, `split panes are not approximately 1:1: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.first.top >= narrow.active.top && narrow.first.bottom <= narrow.active.bottom, `active first row is clipped: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.atticFirst.top >= narrow.attic.top && narrow.atticFirst.bottom <= narrow.attic.bottom + 1, `archive first row is clipped: ${JSON.stringify(narrow)}`);
  assert.deepEqual(narrow.siblingOverlaps, [], JSON.stringify(narrow));
  print('narrow 420x820 split pixels', narrow);

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await evaluate(`fetch('/api/test-long-tree')`);
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.tree-name')).some((node)=>node.textContent === 'Live 00 r1') && document.querySelectorAll('.active-tree-list > .tree-session').length === 36`), 'long tree did not render');
  const scrollFold = async (selector) => {
    const before = await evaluate(`(() => { const list=document.querySelector('${selector}'); list.scrollTop=Math.floor((list.scrollHeight-list.clientHeight)*.45); const fold=[...list.querySelectorAll('[data-fold-id][aria-expanded="false"]')].find((node)=>{const row=node.closest('.tree-session').getBoundingClientRect();const pane=list.getBoundingClientRect();return row.top>=pane.top&&row.bottom<=pane.bottom;}); return {scrollTop:list.scrollTop,id:fold?.dataset.foldId,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight}; })()`);
    assert.ok(before.id, `no visible fold in ${selector}: ${JSON.stringify(before)}`);
    await evaluate(`document.querySelector('${selector} [data-fold-id="${before.id}"]').click()`);
    const opened = await evaluate(`document.querySelector('${selector}').scrollTop`);
    assert.ok(Math.abs(opened - before.scrollTop) <= 2, `${selector} moved on expand: ${JSON.stringify({ before, opened })}`);
    await evaluate(`document.querySelector('${selector} [data-fold-id="${before.id}"]').click()`);
    const closed = await evaluate(`document.querySelector('${selector}').scrollTop`);
    assert.ok(Math.abs(closed - opened) <= 2, `${selector} moved on collapse: ${JSON.stringify({ before, opened, closed })}`);
    return { before: before.scrollTop, opened, closed, clientHeight: before.clientHeight, scrollHeight: before.scrollHeight };
  };
  const activeScroll = await scrollFold('.active-tree-list');
  const atticScroll = await scrollFold('.attic-list');
  const refreshBefore = await evaluate(`(() => { const active=document.querySelector('.active-tree-list'); const attic=document.querySelector('.attic-list'); active.scrollTop=211; attic.scrollTop=377; return {active:active.scrollTop,attic:attic.scrollTop}; })()`);
  await evaluate(`fetch('/api/test-long-tree')`);
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.tree-name')).some((node)=>node.textContent === 'Live 00 r2') && document.querySelectorAll('.active-tree-list > .tree-session').length === 36`), 'SSE tree refresh did not finish');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const refreshAfter = await evaluate(`({active:document.querySelector('.active-tree-list').scrollTop,attic:document.querySelector('.attic-list').scrollTop})`);
  assert.ok(Math.abs(refreshAfter.active - refreshBefore.active) <= 2, JSON.stringify({ refreshBefore, refreshAfter }));
  assert.ok(Math.abs(refreshAfter.attic - refreshBefore.attic) <= 2, JSON.stringify({ refreshBefore, refreshAfter }));
  print('tree pane scroll survives fold rerenders', { active: activeScroll, attic: atticScroll });
  print('tree pane scroll survives SSE refresh', { before: refreshBefore, after: refreshAfter });
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 v2.1 branch fold semantics PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
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
