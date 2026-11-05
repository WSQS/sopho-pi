import assert from 'node:assert/strict';
import { boot, sendJson, waitFor } from './ui-harness.mjs';

// I-53 的机械门：URL 深链 `#<完整 uuid>` / 刷新保持当前会话 / hashchange 前进后退 / 非法 hash。
//
// 它钉住的是**真浏览器的地址栏行为**（location / history / hashchange），不是「源码里有
// replaceState 这个词」—— 四条都走真 Chromium：
//   ① 点会话后 URL 带该 uuid，且**不新增历史条目**（replaceState，与 v2.1 一致）；
//   ② 拿这个 URL **跨文档重新加载**（Page.navigate，先落 about:blank 再进目标 URL）后，仍是那个
//      会话、正文已渲染、树行仍选中、会话 SSE 已连上；
//   ③ hashchange（用户改地址 / 别的页面带 hash 进来）跟随切换，`history.back()`/`forward()`
//      在真历史条目之间来回切；
//   ④ `#foo` / 空 `#` / uuid 片段 / 非法百分号转义 / 合法但服务端 404 的 uuid，一条都不许炸。
//
// 「深链必须走 selectSession 同一条路」不做源码断言，而用两件可复算的事证明：
//   · 深链打开 idle 与点树行打开 idle 打出去的 `/api/sessions/{id}(...)?` 请求**逐一点相同**；
//   · 只读 / 已归档这两个只有 selectSession 才有的副作用各验一条（深链进只读会话 = 正文可见 +
//     输入框 disabled + 「工作目录已不存在」；深链进归档会话 = 标题带「已归档」）。

const ids = {
  idle: '11111111-1111-4111-8111-111111111111',
  unread: '33333333-3333-4333-8333-333333333333',
  archived: '44444444-4444-4444-8444-444444444444',
  readonly: '55555555-5555-4555-8555-555555555555',
  // 合法 uuid，但**不在树里**：服务端 404，用来验「会话不存在」的降级。
  missing: '99999999-9999-4999-8999-999999999999',
};
const missingCwd = '/gone/from/this/test';
const sessions = [
  { id: ids.idle, name: 'Idle root', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.unread, name: 'Unread session', status: 'unread', statusLabel: '未读', unread: true, archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.archived, name: 'Archived session', status: 'idle', statusLabel: '闲置', archived: true, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.readonly, name: 'Readonly session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
];

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const requests = [];          // { path, method, at }
const sessionStreams = [];    // 打开过会话 SSE 的 id（按时间）
const bodyFor = (session) => ({
  messages: [
    { role: 'user', text: `用户消息 · ${session.name}` },
    { role: 'assistant', parts: [{ type: 'text', text: `正文：${session.name}` }] },
  ],
  extras: [],
  compaction: null,
  observability: null,
});

const routes = async (request, response, url) => {
  requests.push({ path: url.pathname, method: request.method, at: Date.now() });
  if (url.pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
  if (url.pathname === '/api/tree') { sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null } }); return true; }
  if (url.pathname === '/api/devices') { sendJson(response, 200, { exists: false, devices: [] }); return true; }
  if (url.pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
    return true;
  }
  const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|commands|models|draft|seen))?$/.exec(url.pathname);
  if (!match) return false;
  const session = sessions.find((entry) => entry.id === match[1]);
  if (!session) { sendJson(response, 404, { error: `session not found: ${match[1]}` }); return true; }
  if (match[2] === 'messages') { sendJson(response, 200, bodyFor(session)); return true; }
  if (match[2] === 'draft') { sendJson(response, 200, { text: '' }); return true; }
  if (match[2] === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
  if (match[2] === 'models') { sendJson(response, 200, { models: [], current: null }); return true; }
  if (match[2] === 'seen') { sendJson(response, 200, { ok: true }); return true; }
  if (match[2] === 'events') {
    sessionStreams.push(session.id);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
    return true;
  }
  sendJson(response, 200, {
    name: session.name,
    archived: session.archived === true,
    readOnly: session.id === ids.readonly,
    cwdMissing: session.id === ids.readonly ? missingCwd : null,
    runtime: { isStreaming: false, isCompacting: false, isRetrying: false },
    observability: null,
  });
  return true;
};

const harness = await boot({ routes });
const { browser, evaluate, pageProblems } = harness;
const home = `http://127.0.0.1:${harness.port}/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 跨文档导航：先落 about:blank 再进目标 URL —— 保证是**真的重新加载**（新 document、模块重跑），
// 而不是同文档换 hash。这才是「刷新 / 贴链接」的真实形状。
const goto = async (url) => {
  const blankLoaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: 'about:blank' });
  await blankLoaded;
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url });
  await loaded;
};
const state = () => evaluate(`(() => ({
  href: location.href,
  hash: location.hash,
  title: document.querySelector('#session-title').textContent,
  messages: document.querySelector('#messages').textContent,
  notice: document.querySelector('#notice').textContent,
  noticeError: document.querySelector('#notice').dataset.level === 'error',
  promptDisabled: document.querySelector('#prompt').disabled,
  selectedRows: Array.from(document.querySelectorAll('.tree-session.selected')).map((node) => node.dataset.sessionId),
  sessionConnected: document.querySelector('#session-connection').textContent,
  historyLength: history.length,
}))()`);
// 打开**某一个**会话会打出去的请求集。只看这个 id：换页/切会话时旧 document 的 visibilitychange
// 会顺手 PUT 上一个会话的草稿（keepalive），那是导航残留，不属于「打开」这条路径。
// /seen 也不在内：它由树 SSE 触发，看时机。
const openRequests = (id) => [...new Set(requests
  .map((entry) => entry.path)
  .filter((path) => new RegExp(`^/api/sessions/${id}/(messages|draft|events|commands|models)$`).test(path)))].sort();
// 「打开」这条路的请求集必须**取全**再比：`selectSession` 把正文画上之后还会继续发 fire-and-forget
// 的请求（`restoreDraft` → `setComposerAvailable` → `void loadCommands`，见 web/app.js:1857-1861 与
// :412-419）。在「正文刚出现」那一刻就取集合，会随机漏掉 1–3ms 后才到达的那一条（实测同一台机器上
// 10 次里 9 次漏 `/commands`，晚到 0–3ms）—— 那不是「深链与点树行请求集不同」，是**采样太早**。
// 所以取集合前先等这条会话的请求流静默（连续两次探测计数不变 / 约 150ms 没有新请求）。
// ⚠️ 断言本身仍是 `deepEqual` 逐点全等 —— 这里只修**观察时机**，没有放宽任何期望。
const settledOpenRequests = async (id) => {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const count = requests.filter((entry) => entry.path.startsWith(`/api/sessions/${id}/`)).length;
    stable = count === previous ? stable + 1 : 0;
    if (stable >= 2) break;
    previous = count;
    await sleep(50);
  }
  return openRequests(id);
};
const waitForTitle = (title, message) => waitFor(async () => {
  const value = await state();
  return value.title === title ? value : null;
}, message);

try {
  // ── ① 点会话后 URL 带该 uuid，且不新增历史条目 ─────────────────────────────────────────
  await waitFor(() => evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelector('[data-session-id="${ids.idle}"]') !== null`), 'tree did not render');
  const beforeClick = await evaluate('({ hash: location.hash, length: history.length })');
  assert.equal(beforeClick.hash, '', JSON.stringify(beforeClick));
  requests.length = 0;
  await evaluate(`document.querySelector('[data-session-id="${ids.idle}"] .tree-select').click()`);
  const clickedIdle = await waitFor(async () => {
    const value = await state();
    return value.title === 'Idle root' && value.messages.includes('正文：Idle root') ? value : null;
  }, 'clicking a tree row did not open the session');
  const clickOpenRequests = await settledOpenRequests(ids.idle);
  const afterClick = await evaluate('({ hash: location.hash, length: history.length })');
  assert.equal(afterClick.hash, `#${ids.idle}`, JSON.stringify(afterClick));
  assert.equal(afterClick.length, beforeClick.length, `选会话污染了后退栈: ${JSON.stringify({ beforeClick, afterClick })}`);
  assert.deepEqual(clickedIdle.selectedRows, [ids.idle], JSON.stringify(clickedIdle));
  print('① click writes #uuid with replaceState (history entry count unchanged)', { beforeClick, afterClick, clickOpenRequests });

  // ── ② 用那个 URL 重新加载后：仍是那个会话、正文已渲染、树行仍选中、SSE 已连 ────────────────
  await evaluate(`document.querySelector('[data-session-id="${ids.unread}"] .tree-select').click()`);
  await waitForTitle('Unread session', 'unread session did not open');
  const href = await evaluate('location.href');
  assert.equal(href, `${home}#${ids.unread}`, href);
  const streamsBefore = sessionStreams.length;
  pageProblems.length = 0;
  await goto(href);
  const reloaded = await waitFor(async () => {
    const value = await state();
    return value.title === 'Unread session' && value.messages.includes('正文：Unread session') ? value : null;
  }, 'reloading the deep link did not restore the session and its body');
  assert.equal(reloaded.hash, `#${ids.unread}`, JSON.stringify(reloaded));
  assert.deepEqual(reloaded.selectedRows, [ids.unread], JSON.stringify(reloaded));
  assert.match(reloaded.sessionConnected, /● 已连接/, JSON.stringify(reloaded));
  assert.equal(reloaded.promptDisabled, false, JSON.stringify(reloaded));
  const deepStreams = sessionStreams.slice(streamsBefore).filter((id) => id === ids.unread).length;
  assert.ok(deepStreams >= 1, `深链没有打开会话 SSE: ${JSON.stringify(sessionStreams.slice(streamsBefore))}`);
  await sleep(200);
  assert.deepEqual(pageProblems, [], `深链首屏报错: ${JSON.stringify(pageProblems)}`);
  print('② deep-link reload restores session + body + tree selection + SSE', { reloaded, deepStreams });

  // ── ③ 深链走的是 selectSession 同一条路（请求集逐一点相同） + hashchange/back/forward ─────
  requests.length = 0;
  await goto(`${home}#${ids.idle}`);
  const deepIdle = await waitFor(async () => {
    const value = await state();
    return value.title === 'Idle root' && value.messages.includes('正文：Idle root') ? value : null;
  }, 'deep link to idle did not open');
  const deepOpenRequests = await settledOpenRequests(ids.idle);
  assert.deepEqual(deepOpenRequests, clickOpenRequests, `深链与点树行打出去的请求集不同: ${JSON.stringify({ deepOpenRequests, clickOpenRequests })}`);
  assert.deepEqual(deepIdle.selectedRows, [ids.idle], JSON.stringify(deepIdle));
  print('③a deep link and a tree click open a session through the identical request set', { deepOpenRequests });

  await evaluate(`location.hash = '#${ids.unread}'; true`);
  await waitForTitle('Unread session', 'hashchange did not follow to unread');
  assert.equal(await evaluate('location.hash'), `#${ids.unread}`);
  await evaluate('history.back(); true');
  const backed = await waitFor(async () => {
    const value = await state();
    return value.title === 'Idle root' && value.hash === `#${ids.idle}` ? value : null;
  }, 'history.back() did not return to the previous session');
  await evaluate('history.forward(); true');
  const forwarded = await waitFor(async () => {
    const value = await state();
    return value.title === 'Unread session' && value.hash === `#${ids.unread}` ? value : null;
  }, 'history.forward() did not move on to the next session');
  print('③b hashchange follows an external URL change; history.back()/forward() switch sessions', { backed: { title: backed.title, hash: backed.hash }, forwarded: { title: forwarded.title, hash: forwarded.hash } });

  // ── ④ 非法 hash：跨文档加载与页内 hashchange 两条路都不许炸、不许动当前会话 ──────────────
  const illegal = ['#foo', '#11111111', `#${ids.idle}-extra`, '#%zz', `#${ids.idle}x`];
  for (const bad of illegal) {
    pageProblems.length = 0;
    await goto(`${home}${bad}`);
    await waitFor(() => evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelector('[data-session-id="${ids.idle}"]') !== null`), `tree did not render for ${bad}`);
    const value = await state();
    assert.equal(value.title, '请选择会话', `${bad} 被当成了会话 id: ${JSON.stringify(value)}`);
    assert.equal(value.promptDisabled, true, JSON.stringify(value));
    assert.deepEqual(value.selectedRows, [], JSON.stringify(value));
    await sleep(120);
    assert.deepEqual(pageProblems, [], `${bad} 抛出异常: ${JSON.stringify(pageProblems)}`);
  }
  print('④a illegal/partial/malformed hashes load cleanly and open nothing', { illegal });

  // 页内 hashchange（用户手改地址栏的形状）：先装一个计数器，证明浏览器真的派了 hashchange
  //（否则「没变化」就是废话），再逐一确认应用静默忽略。
  await goto(`${home}#${ids.idle}`);
  // 等正文也渲染完再取基准：`selectSession` 先写标题、后拉正文，只等标题会抓到一个半成品的快照。
  const healthyInPage = await waitFor(async () => {
    const value = await state();
    return value.title === 'Idle root' && value.messages.includes('正文：Idle root') ? value : null;
  }, 'idle deep link did not open before the hashchange probes');
  await evaluate(`window.__hashEvents = []; window.addEventListener('hashchange', () => window.__hashEvents.push(location.hash)); true`);
  pageProblems.length = 0;
  for (const bad of ['#foo', '#%zz', '#11111111', '']) {
    await evaluate(`location.hash = ${JSON.stringify(bad)}; true`);
    await sleep(180);
    const value = await state();
    assert.equal(value.title, healthyInPage.title, `页内非法 hash ${JSON.stringify(bad)} 动了当前会话: ${JSON.stringify(value)}`);
    assert.equal(value.messages, healthyInPage.messages, `页内非法 hash ${JSON.stringify(bad)} 换了正文: ${JSON.stringify(value)}`);
  }
  const hashEvents = await evaluate('window.__hashEvents');
  assert.ok(hashEvents.length >= 3, `hashchange 根本没派出来，这条断言是空的: ${JSON.stringify(hashEvents)}`);
  assert.deepEqual(pageProblems, [], `页内非法 hash 抛出异常: ${JSON.stringify(pageProblems)}`);
  print('④b in-page illegal hashes fire hashchange but are ignored (no crash, session untouched)', { hashEvents, pageProblems });

  // 合法 uuid 但服务端 404（会话已被删）：可读提示 + 清掉死 id + 不炸；刷新后不再重试
  pageProblems.length = 0;
  await goto(`${home}#${ids.missing}`);
  const missing = await waitFor(async () => {
    const value = await state();
    return value.notice.includes('不存在') ? value : null;
  }, 'deep link to a missing session did not degrade readably');
  assert.match(missing.notice, new RegExp(ids.missing), JSON.stringify(missing));
  assert.equal(missing.noticeError, true, JSON.stringify(missing));
  assert.equal(missing.hash, '', JSON.stringify(missing));
  assert.equal(missing.promptDisabled, true, JSON.stringify(missing));
  assert.match(missing.title, /（打不开）/, JSON.stringify(missing));
  await sleep(150);
  assert.deepEqual(pageProblems, [], `不存在的会话抛出异常: ${JSON.stringify(pageProblems)}`);
  print('④c deep link to a missing session degrades: readable notice + dead hash removed', missing);

  // ── ⑤ 边界：只读 / 已归档 / 大写 uuid / 切换很快 ───────────────────────────────────────
  await goto(`${home}#${ids.readonly}`);
  const readonly = await waitFor(async () => {
    const value = await state();
    return value.messages.includes('正文：Readonly session') ? value : null;
  }, 'deep link to a read-only session did not render its history');
  assert.match(readonly.title, /只读/, JSON.stringify(readonly));
  assert.match(readonly.notice, /工作目录已不存在/, JSON.stringify(readonly));
  assert.equal(readonly.promptDisabled, true, JSON.stringify(readonly));
  assert.equal(readonly.hash, `#${ids.readonly}`, JSON.stringify(readonly));
  await goto(`${home}#${ids.readonly}`);
  const readonlyAgain = await waitFor(async () => {
    const value = await state();
    return value.messages.includes('正文：Readonly session') ? value : null;
  }, 'read-only deep link did not survive a reload');
  assert.equal(readonlyAgain.hash, `#${ids.readonly}`, JSON.stringify(readonlyAgain));
  print('⑤a read-only (cwd gone) deep link: history visible, composer disabled, hash kept, survives reload', { title: readonlyAgain.title, hash: readonlyAgain.hash });

  await goto(`${home}#${ids.archived}`);
  const archived = await waitFor(async () => {
    const value = await state();
    return value.messages.includes('正文：Archived session') ? value : null;
  }, 'deep link to an archived session did not render');
  assert.match(archived.title, /已归档/, JSON.stringify(archived));
  assert.equal(archived.hash, `#${ids.archived}`, JSON.stringify(archived));
  assert.equal(archived.promptDisabled, false, JSON.stringify(archived));
  print('⑤b archived deep link opens the session (title says 已归档)', { title: archived.title, hash: archived.hash });

  await goto(`${home}#${ids.idle.toUpperCase()}`);
  const upper = await waitForTitle('Idle root', 'uppercase uuid deep link did not open');
  assert.equal(upper.hash, `#${ids.idle}`, JSON.stringify(upper));
  print('⑤c uppercase uuid deep link opens and the address bar is normalised to lowercase', { hash: upper.hash });

  pageProblems.length = 0;
  await goto(`${home}#${ids.idle}`);
  await waitForTitle('Idle root', 'idle deep link did not open before the rapid switch');
  await evaluate(`document.querySelector('[data-session-id="${ids.readonly}"] .tree-select').click(); document.querySelector('[data-session-id="${ids.unread}"] .tree-select').click(); true`);
  await waitForTitle('Unread session', 'rapid switching did not settle on the last session');
  await sleep(350);
  const settled = await state();
  assert.equal(settled.title, 'Unread session', `快速切换后落到了别的会话: ${JSON.stringify(settled)}`);
  assert.equal(settled.messages.includes('正文：Unread session'), true, JSON.stringify(settled));
  assert.equal(settled.hash, `#${ids.unread}`, JSON.stringify(settled));
  assert.deepEqual(settled.selectedRows, [ids.unread], JSON.stringify(settled));
  assert.deepEqual(pageProblems, [], `快速切换抛出异常: ${JSON.stringify(pageProblems)}`);
  print('⑤d rapid session switching settles on the last one; address bar and highlight agree', settled);

  print('chromium', { product: harness.version.Browser, chrome: harness.chrome, port: harness.port, debugPort: harness.debugPort, forbiddenPortsUsed: false });
  print('RESULT', 'I-53 session deep link (#uuid / reload / back-forward / illegal hash) PASS');
} finally {
  await harness.close();
}
