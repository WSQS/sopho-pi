import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, quiesceCdpPage } from './harness.mjs';

// 这道门钉两个真机缺陷（都不是「观感」而是「少了一条线 / 少了一次高亮」）：
//   ① .tree-nav 的「搜索 / 新会话」左边缘会长出「3px 槽 + 伪元素竖线」两条，入口右移；
//   ② 选中会话在会话树里没有任何高亮（v2.1 的 .sess.active 在 v2.2 丢了）。
// 两条都靠真 chromium 的实际几何与计算样式断言，不看 CSS 源码字符串。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-tree-selected-'));
const screenshotMain = '/tmp/child-04c2c762-nav-single-rule.png';
const screenshotSelected = '/tmp/child-04c2c762-tree-selected.png';
const screenshotNarrow = '/tmp/child-04c2c762-tree-selected-420x820.png';

const ids = {
  idle: '11111111-1111-4111-8111-111111111111',
  working: '22222222-2222-4222-8222-222222222222',
  unread: '33333333-3333-4333-8333-333333333333',
  archivedChild: '44444444-4444-4444-8444-444444444444',
  archivedRoot: '55555555-5555-4555-8555-555555555555',
};
const sessions = [
  { id: ids.idle, name: 'Idle root', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.archivedChild, name: 'Folded archived child', status: 'idle', statusLabel: '闲置', archived: true, parentId: ids.idle, notify: { notifies: [], waitingFor: [] } },
  { id: ids.working, name: 'Working delegate', status: 'working', statusLabel: '工作中', archived: false, parentId: null, notify: { notifies: [ids.idle], waitingFor: [] } },
  { id: ids.unread, name: 'Unread session', status: 'unread', statusLabel: '未读', unread: true, archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.archivedRoot, name: 'Archived root', status: 'idle', statusLabel: '闲置', archived: true, parentId: null, notify: { notifies: [], waitingFor: [] } },
];
const payload = {
  messages: [
    { role: 'user', text: '用户消息' },
    { role: 'assistant', parts: [{ type: 'text', text: '助手消息' }] },
  ],
  extras: [],
  compaction: null,
  observability: null,
};
let browser;
let chromium;
let server;
let treeStream;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}
function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
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
async function screenshot(file) {
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
}

// 左边缘只有一条竖线的判据：元素左边缘到「第一个真实字符」的距离，
// 必须正好等于 borderLeftWidth（槽）+ paddingLeft。伪元素竖线会把字符再往右推一段。
const EDGE_PROBE = `(() => {
  const measure = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const before = getComputedStyle(element, '::before');
    const border = parseFloat(style.borderLeftWidth) || 0;
    return {
      beforeContent: before.content,
      beforeWidth: before.width,
      borderLeft: border,
      borderStyle: style.borderLeftStyle,
      borderColor: style.borderLeftColor,
      paddingLeft: parseFloat(style.paddingLeft),
      contentOffset: Math.round((text.left - (rect.left + border)) * 100) / 100,
      slotNodes: [element, ...element.querySelectorAll('*')].filter((node) => getComputedStyle(node).borderLeftWidth === '3px').length,
      height: Math.round(rect.height),
    };
  };
  const selectors = ['.tree-nav h1', '#tree-search-toggle', '#new-session-toggle'];
  return Object.fromEntries(selectors.map((selector) => [selector, measure(document.querySelector(selector))]));
})()`;

try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 1, oldestId: ids.archivedRoot, oldestName: 'Archived root' } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [{ name: 'lab', host: 'lab.local', lastProbe: { ok: true } }] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(\/(messages|commands|models|events|draft|seen))?$/);
    if (sessionRoute) {
      const id = sessionRoute[1];
      const kind = sessionRoute[3];
      const session = sessions.find((entry) => entry.id === id);
      if (!session) return sendJson(response, 404, { error: 'unknown session' });
      if (!kind) return sendJson(response, 200, { name: session.name, archived: session.archived === true, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
      if (kind === 'messages') return sendJson(response, 200, payload);
      if (kind === 'draft') return sendJson(response, 200, { text: '' });
      if (kind === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (kind === 'models') return sendJson(response, 200, { models: [], current: null });
      if (kind === 'seen') return sendJson(response, 200, { ok: true });
      if (kind === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
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
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelector('[data-session-id="${ids.working}"]') !== null`), 'tree did not render');

  // ① 三个导航入口：左边缘只允许「3px 槽」一条竖线。
  const nav = await evaluate(EDGE_PROBE);
  for (const [selector, row] of Object.entries(nav)) {
    assert.equal(row.beforeContent, 'none', `::before 竖线没删掉 ${selector}: ${JSON.stringify(row)}`);
    assert.equal(row.borderLeft, 3, JSON.stringify(row));
    assert.equal(row.borderStyle, 'solid', JSON.stringify(row));
    assert.equal(row.slotNodes, 1, JSON.stringify(row));
    assert.ok(Math.abs(row.contentOffset - row.paddingLeft) <= 1, `字符起点被多余竖线推开了 ${selector}: ${JSON.stringify(row)}`);
  }
  // 「会话」h1 从来没有竖线 —— 参照组，证明这条线是 #tree-search-toggle / #new-session-toggle 独有的多出来的东西。
  assert.equal(nav['.tree-nav h1'].contentOffset, nav['.tree-nav h1'].paddingLeft, JSON.stringify(nav));
  assert.equal(nav['#tree-search-toggle'].paddingLeft, nav['#new-session-toggle'].paddingLeft, JSON.stringify(nav));
  await screenshot(screenshotMain);
  print('nav left edge single rule pixels', nav);

  const backLoaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await backLoaded;
  await waitFor(() => evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelector('[data-session-id="${ids.working}"]') !== null`), 'tree did not re-render');

  // ③ 选中高亮：点一行，那一行必须被点亮，且只点亮一行。
  const before = await evaluate(`(() => {
    const rows = Object.fromEntries(Array.from(document.querySelectorAll('.tree-session')).map((row) => [row.dataset.sessionId, { background: getComputedStyle(row).backgroundColor, color: getComputedStyle(row).color, slot: getComputedStyle(row).borderLeftColor, height: row.getBoundingClientRect().height }]));
    return { rows, selected: document.querySelectorAll('.tree-session.selected').length, ariaCurrent: document.querySelectorAll('.tree-session[aria-current]').length };
  })()`);
  assert.equal(before.selected, 0, JSON.stringify(before));
  assert.equal(before.ariaCurrent, 0, JSON.stringify(before));
  assert.equal(before.rows[ids.idle].slot, 'rgb(77, 80, 88)', JSON.stringify(before.rows[ids.idle]));

  await evaluate(`document.querySelector('[data-session-id="${ids.idle}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent.startsWith('Idle root') && document.querySelector('[data-session-id="${ids.idle}"].selected') !== null`), 'selection highlight did not appear');
  const selected = await evaluate(`(() => {
    const selectedRows = Array.from(document.querySelectorAll('.tree-session.selected'));
    const row = selectedRows[0];
    const others = Array.from(document.querySelectorAll('.tree-session')).filter((node) => node !== row);
    const panel = getComputedStyle(document.querySelector('.tree-session'));
    return {
      count: selectedRows.length,
      id: row?.dataset.sessionId,
      ariaCurrent: row?.getAttribute('aria-current'),
      ariaCurrentCount: document.querySelectorAll('.tree-session[aria-current]').length,
      background: row ? getComputedStyle(row).backgroundColor : null,
      color: row ? getComputedStyle(row).color : null,
      slot: row ? getComputedStyle(row).borderLeftColor : null,
      borderLeft: row ? getComputedStyle(row).borderLeftWidth : null,
      boxShadow: row ? getComputedStyle(row).boxShadow : null,
      backgroundImage: row ? getComputedStyle(row).backgroundImage : null,
      height: row ? row.getBoundingClientRect().height : null,
      othersBackgrounds: Array.from(new Set(others.map((node) => getComputedStyle(node).backgroundColor))),
      othersAriaCurrent: others.filter((node) => node.hasAttribute('aria-current')).length,
      hoverRaised: document.documentElement ? getComputedStyle(document.documentElement).getPropertyValue('--raised').trim() : null,
      idleSlotVar: getComputedStyle(document.documentElement).getPropertyValue('--slot-idle').trim(),
      forbidden: {
        gradients: Array.from(document.querySelectorAll('*')).filter((node) => getComputedStyle(node).backgroundImage !== 'none').length,
        shadows: Array.from(document.querySelectorAll('*')).filter((node) => getComputedStyle(node).boxShadow !== 'none').length,
        slowTransitions: Array.from(document.querySelectorAll('*')).filter((node) => getComputedStyle(node).transitionDuration.split(',').some((value) => parseFloat(value) > 0.15)).length,
      },
      rowHeights: Array.from(new Set(Array.from(document.querySelectorAll('.tree-session')).map((node) => node.getBoundingClientRect().height))),
      panelBackground: panel.backgroundColor,
    };
  })()`);
  assert.equal(selected.count, 1, JSON.stringify(selected));
  assert.equal(selected.id, ids.idle, JSON.stringify(selected));
  assert.equal(selected.ariaCurrent, 'true', JSON.stringify(selected));
  assert.equal(selected.ariaCurrentCount, 1, JSON.stringify(selected));
  assert.equal(selected.othersAriaCurrent, 0, JSON.stringify(selected));
  // 选中高亮必须来自 CSS 的 background+color，不许是 box-shadow / 渐变（v2.2 两处闸门钉死）。
  assert.equal(selected.boxShadow, 'none', JSON.stringify(selected));
  assert.equal(selected.backgroundImage, 'none', JSON.stringify(selected));
  assert.notEqual(selected.background, before.rows[ids.idle].background, JSON.stringify({ before, selected }));
  assert.ok(selected.othersBackgrounds.every((color) => color !== selected.background), JSON.stringify(selected));
  assert.equal(selected.color, 'rgb(227, 232, 228)', JSON.stringify(selected));
  assert.notEqual(selected.color, before.rows[ids.idle].color, JSON.stringify({ before, selected }));
  // 选中不许吃掉槽位：状态色必须还是 idle 槽。
  assert.equal(selected.slot, before.rows[ids.idle].slot, JSON.stringify(selected));
  assert.equal(selected.borderLeft, '3px', JSON.stringify(selected));
  assert.deepEqual(selected.rowHeights, [26], JSON.stringify(selected));
  assert.deepEqual(selected.forbidden, { gradients: 0, shadows: 0, slowTransitions: 0 });
  await screenshot(screenshotSelected);
  print('selected row highlight pixels', selected);

  // ④ 选中态要能被 /tree 的重渲染保住（selectedId 传进去了，不是只在点击那一刻加的 class）。
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  treeStream?.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
  const rerefreshed = await waitFor(async () => {
    const value = await evaluate(`(() => { const rows=Array.from(document.querySelectorAll('.tree-session.selected')); return {count:rows.length,id:rows[0]?.dataset.sessionId,ariaCurrent:rows[0]?.getAttribute('aria-current'),background:rows[0]?getComputedStyle(rows[0]).backgroundColor:null}; })()`);
    return value.count === 1 ? value : null;
  }, 'highlight lost after tree snapshot re-render');
  assert.equal(rerefreshed.id, ids.idle, JSON.stringify(rerefreshed));
  assert.equal(rerefreshed.background, selected.background, JSON.stringify(rerefreshed));
  print('highlight survives tree snapshot re-render', rerefreshed);

  // ⑤ 切到另一行：高亮必须跟着走，同一时刻只有一行亮。
  await evaluate(`document.querySelector('[data-session-id="${ids.unread}"] .tree-select').click()`);
  const switched = await waitFor(async () => {
    const value = await evaluate(`(() => { const rows=Array.from(document.querySelectorAll('.tree-session.selected')); const idle=document.querySelector('[data-session-id="${ids.idle}"]'); return {count:rows.length,ids:rows.map((node)=>node.dataset.sessionId),id:rows[0]?.dataset.sessionId,oldBackground:idle?getComputedStyle(idle).backgroundColor:null,newSlot:rows[0]?getComputedStyle(rows[0]).borderLeftColor:null,newBackground:rows[0]?getComputedStyle(rows[0]).backgroundColor:null,title:document.querySelector('#session-title').textContent,rowCount:document.querySelectorAll('.tree-session').length}; })()`);
    return value.count === 1 && value.id === ids.unread ? value : null;
  }, 'highlight did not move to the newly selected row');
  assert.equal(switched.oldBackground, before.rows[ids.idle].background, JSON.stringify(switched));
  // 未读行的槽位是红色 —— 选中不许把它压成别的颜色。
  assert.equal(switched.newSlot, 'rgb(214, 93, 93)', JSON.stringify(switched));
  assert.equal(switched.newBackground, selected.background, JSON.stringify(switched));
  print('highlight follows selection switch', switched);

  // ⑥ 边界：选中的会话被藏起来时，高亮根本渲染不出来（如实钉住这个已知边界）。
  //    先试折叠：展开 idle 的存档支 → 选中支里的孩子 → 收起 → 行没了，高亮也就没了。
  await evaluate(`document.querySelector('[data-fold-id="${ids.idle}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${ids.archivedChild}"]') !== null`), 'archived branch did not expand');
  await evaluate(`document.querySelector('[data-session-id="${ids.archivedChild}"] .tree-select').click()`);
  const childSelected = await waitFor(async () => {
    const value = await evaluate(`(() => { const rows=Array.from(document.querySelectorAll('.tree-session.selected')); return {count:rows.length,id:rows[0]?.dataset.sessionId,ariaCurrent:rows[0]?.getAttribute('aria-current')}; })()`);
    return value.count === 1 && value.id === ids.archivedChild ? value : null;
  }, 'archived child row did not take the highlight');
  assert.equal(childSelected.ariaCurrent, 'true', JSON.stringify(childSelected));
  await evaluate(`document.querySelector('[data-fold-id="${ids.idle}"]').click()`);
  const hiddenByFold = await waitFor(async () => {
    const value = await evaluate(`({rows:document.querySelectorAll('.tree-session').length,selected:document.querySelectorAll('.tree-session.selected').length,treeHasChild:document.querySelector('[data-session-id="${ids.archivedChild}"]')!==null,title:document.querySelector('#session-title').textContent})`);
    return value.treeHasChild === false ? value : null;
  }, 'fold did not hide the archived child');
  assert.equal(hiddenByFold.selected, 0, JSON.stringify(hiddenByFold));
  assert.match(hiddenByFold.title, /Folded archived child/, JSON.stringify(hiddenByFold));
  print('boundary: selected row hidden by fold has no highlight to render', { childSelected, hiddenByFold });

  //    再展开一次：选中的还是它，高亮必须自己回来。
  await evaluate(`document.querySelector('[data-fold-id="${ids.idle}"]').click()`);
  const restored = await waitFor(async () => {
    const value = await evaluate(`(() => { const rows=Array.from(document.querySelectorAll('.tree-session.selected')); return {count:rows.length,id:rows[0]?.dataset.sessionId}; })()`);
    return value.count === 1 ? value : null;
  }, 'highlight did not come back after unfolding');
  assert.equal(restored.id, ids.archivedChild, JSON.stringify(restored));
  print('unfold restores the highlight', restored);

  //    另一半：选中的是顶层存档会话，而存档箱是关着的时候，行不在 DOM 里。
  //    （「N 个会话有新东西 →」汇总条已删；改用深链 hash 打开一个「树上没有行」的会话。）
  await evaluate(`location.hash = '#${ids.archivedRoot}'`);
  const atticClosed = await waitFor(async () => {
    const value = await evaluate(`({title:document.querySelector('#session-title').textContent,selected:document.querySelectorAll('.tree-session.selected').length,treeHasRow:document.querySelector('[data-session-id="${ids.archivedRoot}"]')!==null,atticOpen:document.querySelector('#tree').dataset.atticOpen})`);
    return value.title.startsWith('Archived root') ? value : null;
  }, 'deep link did not open the archived root');
  assert.equal(atticClosed.treeHasRow, false, JSON.stringify(atticClosed));
  assert.equal(atticClosed.selected, 0, JSON.stringify(atticClosed));
  assert.equal(atticClosed.atticOpen, 'false', JSON.stringify(atticClosed));
  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  const atticOpened = await waitFor(async () => {
    const value = await evaluate(`(() => { const rows=Array.from(document.querySelectorAll('.tree-session.selected')); return {count:rows.length,id:rows[0]?.dataset.sessionId,inside:rows[0]?.closest('[data-attic-list="true"]')!==null,ariaCurrent:rows[0]?.getAttribute('aria-current')}; })()`);
    return value.count === 1 ? value : null;
  }, 'opening the attic did not reveal the highlight');
  assert.equal(atticOpened.id, ids.archivedRoot, JSON.stringify(atticOpened));
  assert.equal(atticOpened.inside, true, JSON.stringify(atticOpened));
  assert.equal(atticOpened.ariaCurrent, 'true', JSON.stringify(atticOpened));
  print('boundary: attic closed hides the row (highlight cannot render), opening it reveals the highlight', { atticClosed, atticOpened });

  // ⑦ 窄屏不许因为高亮把行挤爆（密度 26px / 无横向溢出）。
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const narrow = await evaluate(`(() => {
    const aside=document.querySelector('aside.tree');
    const selectedRow=document.querySelector('.tree-session.selected');
    const rows=Array.from(document.querySelectorAll('.tree-session'));
    const heights=Array.from(new Set(rows.map((node)=>node.getBoundingClientRect().height)));
    return {
      selectedId: selectedRow?.dataset.sessionId,
      selectedBackground: selectedRow?getComputedStyle(selectedRow).backgroundColor:null,
      heights,
      noHorizontalScroll: document.documentElement.scrollWidth<=document.documentElement.clientWidth && document.body.scrollWidth<=document.body.clientWidth,
      asideWidth: aside.getBoundingClientRect().width,
      shadows: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).boxShadow!=='none').length,
      gradients: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).backgroundImage!=='none').length,
      rowOverflow: rows.filter((node)=>node.getBoundingClientRect().right > aside.getBoundingClientRect().right + .5).length,
      navEdges: Object.fromEntries(['.tree-nav h1','#tree-search-toggle','#new-session-toggle'].map((selector)=>{const element=document.querySelector(selector); const style=getComputedStyle(element); const rect=element.getBoundingClientRect(); const range=document.createRange(); range.selectNodeContents(element); const text=range.getBoundingClientRect(); const border=parseFloat(style.borderLeftWidth)||0; return [selector,{borderLeft:border,paddingLeft:parseFloat(style.paddingLeft),contentOffset:Math.round((text.left-(rect.left+border))*100)/100}];})),
    };
  })()`);
  assert.equal(narrow.selectedId, ids.archivedRoot, JSON.stringify(narrow));
  assert.deepEqual(narrow.heights, [26], JSON.stringify(narrow));
  assert.equal(narrow.noHorizontalScroll, true, JSON.stringify(narrow));
  assert.equal(narrow.rowOverflow, 0, JSON.stringify(narrow));
  assert.equal(narrow.shadows, 0, JSON.stringify(narrow));
  assert.equal(narrow.gradients, 0, JSON.stringify(narrow));
  for (const [selector, row] of Object.entries(narrow.navEdges)) {
    assert.equal(row.borderLeft, 3, `${selector} ${JSON.stringify(row)}`);
    assert.ok(Math.abs(row.contentOffset - row.paddingLeft) <= 1, `${selector} ${JSON.stringify(row)}`);
  }
  await screenshot(screenshotNarrow);
  print('narrow 420x820 keeps density + single left rule', narrow);

  print('screenshots', { main: screenshotMain, selected: screenshotSelected, narrow: screenshotNarrow });
  print('chromium', { product: version.Browser, chrome, port, debugPort, forbiddenPortsUsed: false });
  print('RESULT', 'S1a-2 tree selected highlight + single left rule PASS');
} finally {
  await quiesceCdpPage(browser);
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // chromium 退出后 user-data-dir 里还有残余，rm 会抢跑报 ENOTEMPTY —— 重试几轮，
  // 并且绝不让清理失败掩盖掉真正的断言失败。
  try {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch (error) {
    process.stderr.write(`sandbox cleanup failed (ignored): ${error.message}\n`);
  }
}
