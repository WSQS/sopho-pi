#!/usr/bin/env node
// test/tree-running-slot.mjs —— I-56：会话树行的「在跑」记号（**一个槽位、在跑优先于未读**）。
//
// 用户 2026-09-19 的裁定（`docs/interaction-parity.md` 的 I-56 行）：
//   · 只在树行**既有**的那个状态位置加「在跑」，**不新增元素**、不做顶栏「● 正在跑」；
//   · **在跑优先**：在跑 ⇒ 显示在跑态；不在跑且未读 ⇒ 未读态；都不满足 ⇒ 现状；
//   · 零位移、同宽（状态切换不许改变行宽/文字起点）；颜色只走既有 `--slot` 体系。
//
// 这道门把上面每一条都变成机械判据，且**只看真 Chromium 的计算样式与几何**，不看 CSS 源码字符串：
//   ① 四态槽色：在跑 / 在跑且未读 / 未读不在跑 / 闲置 —— 在跑与「在跑且未读」必须同色（在跑优先），
//      且与未读、闲置三者互不相同（一个槽位区分三种状态）；
//   ② 那个圆点（`.status-dot`）必须仍然 `display:none` —— v2.2 的可见记号是行左 3px 槽：
//      把它显示出来就是新增视觉要素，而且会让行宽随状态变（`test/s1a2-unread.mjs` / `test/s1a2-slot.mjs`
//      对它的断言必须继续成立）；
//   ③ 零位移同宽：同一行在 idle → working → unread 之间翻转，行的几何快照逐字段相同；
//   ④ 更新时机：记号只跟**运行级**事实走 —— 服务端 `/tree` 的 `status`，以及运行级事件
//      （树流的 `tree.session`，服务端只在 session.start/end/settled 这类状态转换才发）。
//      **消息级**帧（session.delta / tool_start / tool_end）既不许改记号、也不许多打一次 `/tree`；
//      服务端事实变了但没事件时也不许前端自己猜。
//
// 纪律：随机高位端口、临时 user-data-dir、只按本次 spawn 的 pid 停、不 pkill、不碰真 profile、
//       不用 7331/7321。假 API 只在 127.0.0.1 上监听随机口。
import assert from 'node:assert/strict';
import { boot, readBody, sendJson } from './ui-harness.mjs';

const ids = {
  working: '10000000-0000-4000-8000-000000000001',
  workingUnread: '10000000-0000-4000-8000-000000000002',
  unread: '10000000-0000-4000-8000-000000000003',
  idle: '10000000-0000-4000-8000-000000000004',
};
const order = [ids.working, ids.workingUnread, ids.unread, ids.idle];
// 与 `server/base.mjs` 的 decorateUnreadTree 同一口径：
// status = working ? 'working' : unread ? 'unread' : 'idle'（在跑优先的**服务端**一半）。
const flags = new Map([
  [ids.working, { working: true, unread: false, name: '在跑（已读）' }],
  [ids.workingUnread, { working: true, unread: true, name: '在跑且未读' }],
  [ids.unread, { working: false, unread: true, name: '未读不在跑' }],
  [ids.idle, { working: false, unread: false, name: '闲置' }],
]);
const screenshot = '/tmp/i56-tree-running-slot-1200x760.png';
let treeFetches = 0;
const treeStreams = new Set();
const sessionStreams = new Map();
const messages = { messages: [{ role: 'user', text: '问题' }, { role: 'assistant', parts: [{ type: 'text', text: '回答' }] }], extras: [], compaction: null, observability: null };

function sessions() {
  return order.map((id) => {
    const flag = flags.get(id);
    return {
      id,
      name: flag.name,
      archived: false,
      parentId: null,
      cwd: '/tmp/i56-tree-running',
      createdAt: '2026-09-19T00:00:00.000Z',
      modifiedAt: '2026-09-19T00:00:00.000Z',
      settledAt: flag.unread ? 1_700_000_000_000 : null,
      seenAt: null,
      unread: flag.unread,
      hiddenByArchive: false,
      status: flag.working ? 'working' : flag.unread ? 'unread' : 'idle',
      statusLabel: flag.working ? '工作中' : flag.unread ? '未读' : '闲置',
      notify: { notifies: [], waitingFor: [] },
    };
  });
}

function treePayload() {
  const rows = sessions();
  const visible = rows.filter((row) => row.unread);
  return {
    sessions: rows,
    generatedAt: new Date().toISOString(),
    titles: { ok: true, exists: true, error: null },
    unread: { count: visible.length, oldestId: visible[0]?.id ?? null, oldestName: visible[0]?.name ?? null, oldestAt: visible[0]?.settledAt ?? null },
  };
}

function broadcastTree(reason) {
  const data = JSON.stringify({ type: 'tree.session', sessionId: ids.working, reason });
  for (const stream of treeStreams) stream.write(`event: tree.session\ndata: ${data}\n\n`);
}

function broadcastSession(id, name, data) {
  const stream = sessionStreams.get(id);
  if (!stream || stream.destroyed) throw new Error(`session ${id} stream is not connected`);
  stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 逐行几何快照：行/文字/时间戳的位置与尺寸 + 槽宽 + 槽色。状态翻转前后**几何逐字段相同**
// 才是「零位移、同宽」；槽色本来就应该变，所以它不进 geometryOnly()。
const GEOMETRY = `(() => {
  const out = {};
  for (const row of document.querySelectorAll('.tree-session')) {
    const rect = row.getBoundingClientRect();
    const select = row.querySelector('.tree-select');
    const name = row.querySelector('.tree-name');
    const time = row.querySelector('.tree-time');
    const label = row.querySelector('.tree-label');
    const style = getComputedStyle(row);
    const round = (value) => Math.round(value * 1000) / 1000;
    out[row.dataset.sessionId] = {
      className: row.className,
      row: [round(rect.left), round(rect.top), round(rect.width), round(rect.height)],
      nameLeft: round(name.getBoundingClientRect().left),
      nameWidth: round(name.getBoundingClientRect().width),
      labelRight: round(label.getBoundingClientRect().right),
      timeRight: time ? round(time.getBoundingClientRect().right) : null,
      grid: getComputedStyle(select).gridTemplateColumns,
      slotWidth: style.borderLeftWidth,
      slotStyle: style.borderLeftStyle,
      slotColor: style.borderLeftColor,
      dotDisplay: getComputedStyle(row.querySelector('.status-dot')).display,
      title: row.title,
    };
  }
  return out;
})()`;

function geometryOnly(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([id, row]) => [id, {
    row: row.row, nameLeft: row.nameLeft, nameWidth: row.nameWidth, labelRight: row.labelRight,
    timeRight: row.timeRight, grid: row.grid, slotWidth: row.slotWidth, slotStyle: row.slotStyle,
  }]));
}

const harness = await boot({
  width: 1200,
  height: 760,
  routes: async (request, response, url) => {
    if (url.pathname === '/api/tree') {
      treeFetches += 1;
      sendJson(response, 200, treePayload());
      return true;
    }
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ type: 'tree.snapshot', ...treePayload() })}\n\n`);
      treeStreams.add(response);
      response.once('close', () => treeStreams.delete(response));
      return true;
    }
    if (url.pathname === '/api/test/tree-event' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      broadcastTree(body.reason || 'test');
      sendJson(response, 200, { ok: true, treeFetches });
      return true;
    }
    if (url.pathname === '/api/test/flags' && request.method === 'POST') {
      // 只改服务端事实、**不发任何事件**：用来看前端会不会自己猜（不该）。
      const body = JSON.parse(await readBody(request));
      flags.set(body.id, { ...flags.get(body.id), ...(body.working === undefined ? {} : { working: body.working }), ...(body.unread === undefined ? {} : { unread: body.unread }) });
      sendJson(response, 200, { ok: true, treeFetches });
      return true;
    }
    if (url.pathname === '/api/test/session-event' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      broadcastSession(body.id, body.name, body.data || {});
      sendJson(response, 200, { ok: true, treeFetches });
      return true;
    }
    if (url.pathname === '/api/test/tree-fetches') {
      sendJson(response, 200, { treeFetches });
      return true;
    }
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true, worker: null }), true;
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(\/(messages|commands|models|draft|seen|events))?$/);
    if (sessionRoute) {
      const id = sessionRoute[1];
      const kind = sessionRoute[3];
      if (!flags.has(id)) return sendJson(response, 404, { error: 'unknown session' }), true;
      if (!kind) return sendJson(response, 200, { id, name: flags.get(id).name, archived: false, readOnly: false, runtime: { isStreaming: flags.get(id).working, isCompacting: false, isRetrying: false }, observability: null }), true;
      if (kind === 'messages') return sendJson(response, 200, messages), true;
      if (kind === 'draft') return sendJson(response, 200, { text: '', at: null }), true;
      if (kind === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
      if (kind === 'models') return sendJson(response, 200, { models: [], current: null }), true;
      if (kind === 'seen') return sendJson(response, 200, { ok: true, seenAt: Date.now() }), true;
      if (kind === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: flags.get(id).working, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
        sessionStreams.set(id, response);
        response.once('close', () => { if (sessionStreams.get(id) === response) sessionStreams.delete(id); });
        return true;
      }
    }
    return false;
  },
});

let primaryError = null;
try {
  const { evaluate, waitFor, frames, pageProblems } = harness;
  const control = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!response.ok) throw new Error(`${path} failed ${response.status}`);
    return response.json();
  };
  const treeFetchTotal = async () => (await (await fetch(`http://127.0.0.1:${harness.port}/api/test/tree-fetches`)).json()).treeFetches;
  // 等 /tree 的请求数安静下来：开门初期（首帧 + 首连 tree.snapshot + 选中会话后的补拉）会连打几次，
  // 不先等稳，下面「消息级帧没有多打一次 /tree」的差值断言会把噪音算进去。
  const quietFetches = async (stableMs = 350) => {
    let last = await treeFetchTotal();
    for (;;) {
      await sleep(stableMs);
      const now = await treeFetchTotal();
      if (now === last) return now;
      last = now;
    }
  };
  const sessionEvent = (name, data) => control('/api/test/session-event', { id: ids.working, name, data });
  const color = (hex) => {
    const value = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  };

  await waitFor(() => evaluate(`document.querySelectorAll('.tree-session').length === ${order.length}`), 'tree rows did not render');
  await frames(2);
  const initial = await evaluate(GEOMETRY);
  const palette = await evaluate(`(() => { const probe=document.createElement('i'); document.body.append(probe); const read=(name)=>{probe.style.color='var('+name+')'; return getComputedStyle(probe).color;}; const out={working:read('--slot-working'),unread:read('--slot-unread'),idle:read('--slot-idle')}; probe.remove(); return out; })()`);

  // ① 四态槽色
  assert.equal(initial[ids.working].slotColor, palette.working, JSON.stringify(initial[ids.working]));
  assert.equal(initial[ids.workingUnread].slotColor, palette.working, `在跑且未读没有显示在跑态：${JSON.stringify(initial[ids.workingUnread])}`);
  assert.equal(initial[ids.unread].slotColor, palette.unread, JSON.stringify(initial[ids.unread]));
  assert.equal(initial[ids.idle].slotColor, palette.idle, JSON.stringify(initial[ids.idle]));
  assert.equal(new Set([palette.working, palette.unread, palette.idle]).size, 3, `三种状态色必须互不相同：${JSON.stringify(palette)}`);
  assert.equal(initial[ids.workingUnread].className.includes('unread'), true, '「在跑且未读」这一行本身仍是 unread（未读事实没被抹掉）');
  // ② 圆点仍不可见（零新增视觉要素）
  const dots = order.map((id) => initial[id].dotDisplay);
  assert.deepEqual(dots, ['none', 'none', 'none', 'none'], JSON.stringify(dots));
  // 行左槽宽度恒定 3px、实线
  for (const id of order) {
    assert.equal(initial[id].slotWidth, '3px', JSON.stringify(initial[id]));
    assert.equal(initial[id].slotStyle, 'solid', JSON.stringify(initial[id]));
  }
  print('四态槽色（真 Chromium 计算样式）', {
    palette,
    rows: order.map((id) => ({ id, className: initial[id].className, slot: initial[id].slotColor, dot: initial[id].dotDisplay })),
  });
  // tooltip 要把两个事实都说清（槽只有一个，读者不能被误导成「未读丢了」）
  assert.match(initial[ids.workingUnread].title, /工作中/, initial[ids.workingUnread].title);
  assert.match(initial[ids.workingUnread].title, /未读/, initial[ids.workingUnread].title);
  assert.match(initial[ids.workingUnread].title, /槽位显示在跑/, initial[ids.workingUnread].title);
  assert.match(initial[ids.unread].title, /未读/, initial[ids.unread].title);
  print('行 tooltip（在跑且未读）', initial[ids.workingUnread].title.split('\n').at(-1));

  // ③ 零位移、同宽：同一行 idle → working → unread → idle 翻三遍，几何快照必须逐字段相同。
  const flips = [
    { id: ids.idle, working: true, unread: false, expect: palette.working, label: '闲置 → 在跑' },
    { id: ids.idle, working: false, unread: true, expect: palette.unread, label: '在跑 → 落定未读' },
    { id: ids.idle, working: false, unread: false, expect: palette.idle, label: '未读 → 已读闲置' },
  ];
  const geometryReport = [];
  for (const flip of flips) {
    const before = await evaluate(GEOMETRY);
    await control('/api/test/flags', { id: flip.id, working: flip.working, unread: flip.unread });
    await control('/api/test/tree-event', { reason: flip.working ? 'session.start' : 'session.settled' });
    const observed = await waitFor(async () => {
      const value = await evaluate(GEOMETRY);
      return value[flip.id].slotColor === flip.expect ? value : null;
    }, `${flip.label}: 槽色没有跟到 ${flip.expect}`);
    assert.deepEqual(geometryOnly(observed), geometryOnly(before), `${flip.label}: 状态切换改变了行的几何`);
    assert.equal(observed[flip.id].className.includes('status-working'), flip.working, `${flip.label}: status-working 类不对`);
    geometryReport.push({ step: flip.label, slot: observed[flip.id].slotColor, row: observed[flip.id].row, nameLeft: observed[flip.id].nameLeft, nameWidth: observed[flip.id].nameWidth, timeRight: observed[flip.id].timeRight, grid: observed[flip.id].grid });
  }
  print('零位移同宽（每次翻转前后几何逐字段相同）', geometryReport);
  const displacement = await evaluate(`(() => {
    const row = document.querySelector('[data-session-id="${ids.idle}"]');
    const before = row.getBoundingClientRect();
    return { rowWidth: before.width, rowLeft: before.left, rowHeight: before.height, nameLeft: row.querySelector('.tree-name').getBoundingClientRect().left, timeRight: row.querySelector('.tree-time').getBoundingClientRect().right };
  })()`);
  print('行几何实测（1200×760）', displacement);

  // ④ 更新时机
  //   (a) 消息级帧：会话流上的 session.delta / tool_start / tool_end 不许改记号、也不许多打一次 /tree。
  await evaluate(`document.querySelector('[data-session-id="${ids.working}"] .tree-select').click()`);
  await waitFor(() => sessionStreams.get(ids.working) !== undefined, 'session stream did not connect');
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent.startsWith('在跑（已读）')`), 'session did not open');
  const fetchesBeforeDelta = await quietFetches();
  const beforeDelta = await evaluate(GEOMETRY);
  // 服务端**同时**在此时改口（事实翻转）—— 但如果只来消息级帧，前端必须看不见。
  await control('/api/test/flags', { id: ids.working, working: false, unread: false });
  await sessionEvent('session.delta', { channel: 'text', delta: '正文增量' });
  await sessionEvent('session.tool_start', { toolCallId: 't1', toolName: 'bash' });
  await sessionEvent('session.tool_end', { toolCallId: 't1', toolName: 'bash', isError: false, result: 'ok' });
  await sleep(400);
  const afterMessages = await evaluate(GEOMETRY);
  const fetchesAfterMessages = await treeFetchTotal();
  assert.equal(afterMessages[ids.working].slotColor, beforeDelta[ids.working].slotColor, '消息级帧改变了树行记号（运行级真值被消息级事件带偏）');
  assert.equal(afterMessages[ids.working].className, beforeDelta[ids.working].className, '消息级帧改变了树行的状态类');
  assert.equal(fetchesAfterMessages, fetchesBeforeDelta, `消息级帧多打了 ${fetchesAfterMessages - fetchesBeforeDelta} 次 /tree`);
  print('消息级帧（delta/tool_start/tool_end）不改记号、不多拉 /tree', { treeFetches: fetchesAfterMessages, slot: afterMessages[ids.working].slotColor, className: afterMessages[ids.working].className });

  //   (b) 没有事件时不许自己猜：事实变了但没人通知，记号必须原地不动。
  await sleep(400);
  const afterSilentFact = await evaluate(GEOMETRY);
  assert.equal(afterSilentFact[ids.working].slotColor, beforeDelta[ids.working].slotColor, '没有任何事件时前端自己改了记号（说明在猜，而不是跟服务端事实）');
  print('服务端事实变了但没有事件 → 记号不动（不猜）', { slot: afterSilentFact[ids.working].slotColor });

  //   (c) 运行级事件：树流的 tree.session（服务端在 session.start/end/settled 才发）→ 记号跟到新事实。
  await control('/api/test/flags', { id: ids.working, working: true, unread: false });
  const fetchesBeforeStart = await quietFetches();
  await control('/api/test/tree-event', { reason: 'session.start' });
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${ids.working}"]').classList.contains('status-working')`), 'session.start 的树事件没有把行变成在跑');
  const fetchesAfterStart = await treeFetchTotal();
  assert.ok(fetchesAfterStart > fetchesBeforeStart, '运行级树事件没有重新读 /tree');
  const running = await evaluate(GEOMETRY);
  assert.equal(running[ids.working].slotColor, palette.working, JSON.stringify(running[ids.working]));
  print('运行级事件（tree.session reason=session.start）→ 记号变在跑', { treeFetches: fetchesAfterStart, slot: running[ids.working].slotColor });

  //   (d) 落定：树流的 session.settled → 记号跟到「未读」（服务端在 settled 之后把 unread 置真）。
  await control('/api/test/flags', { id: ids.working, working: false, unread: true });
  await control('/api/test/tree-event', { reason: 'session.settled' });
  const settled = await waitFor(async () => {
    const value = await evaluate(GEOMETRY);
    return value[ids.working].slotColor === palette.unread ? value : null;
  }, '落定之后记号没有变成未读');
  assert.equal(settled[ids.working].className.includes('status-working'), false, JSON.stringify(settled[ids.working]));
  assert.equal(settled[ids.working].dotDisplay, 'none', JSON.stringify(settled[ids.working]));
  print('落定（tree.session reason=session.settled）→ 记号交回未读', { slot: settled[ids.working].slotColor, className: settled[ids.working].className });

  await harness.screenshot(screenshot);
  assert.deepEqual(pageProblems, [], `页面在跑门里报了错：${pageProblems.join(' | ')}`);
  print('chromium', { product: harness.version.Browser, chrome: harness.chrome, port: harness.port, debugPort: harness.debugPort, forbiddenPortsUsed: false });
  print('截图', screenshot);
  print('RESULT', 'I-56 树行在跑记号（一个槽位 / 在跑优先 / 零位移同宽 / 只跟运行级事实）PASS');
} catch (error) {
  primaryError = error;
  try { await harness.screenshot(screenshot); } catch {}
} finally {
  await harness.close();
}
if (primaryError) throw primaryError;
