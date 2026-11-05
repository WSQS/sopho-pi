// P1（manager toolkit）网页那半的门：右栏视图切换（会话 ⇄ 问题）+ 问题页 + 答题/关闭 + 失败臂 + 不变量。
// 契约：`docs/manager-toolkit-plan.md` §3（4 个端点）/ §5（界面口径）/ §9（已定八条）。
//
// 真 Chromium + 假 API。假 API **只**实现契约里网页要用的两个端点（`ask` —— 即不带 op 的那条
// `POST …/questions` —— 在 agent 侧，网页不调）：
//   GET  /sessions/{id}/questions?status=open|answered|all
//   POST /sessions/{id}/questions  {op:'answer', qid, text} | {op:'close', qid, reason}
// （answer/close 是**一层路径 + body 里的 op**：宿主 `SESSION_PATH` 只认一层动作，嵌套路径会走兜底
//   proxy 到 current worker，破「写 owner 唯一」—— 见 `docs/manager-toolkit-plan.md` §3 的注。）
// 并且**故意**按 §1 的落盘形状回条目（「该 id 最后一条 op 决定现状」，多数条不打 status 字段）——
// 响应条的字段名还没钉死，前端必须自己推（`web/app.js` 的 normalizeQuestion）。
//
// 答题回执那条**真话**（2026-09-22 与输入框那条统一成 steer）：三种 `delivery.mode` 页面上要说三种话，
// 而且要能证明「页面上说的话 ≠ 假回执」，所以本门另开 `SOPHO_QUESTIONS_UI_WEB` 一个旋钮（同 `test/live-segments.mjs`
// 的 `SOPHO_LIVESEGMENTS_WEB`）把 `web/` 指到一份**改回旧文案**的快照上跑 —— 照着旧文案跑必红：
//   cp -r web /tmp/old-web && 把 /tmp/old-web/app.js 的 answerDeliveryNotice 改回按 queued 说话
//   SOPHO_QUESTIONS_UI_WEB=/tmp/old-web CHROME_BIN=… node test/manager-questions-ui.mjs   ⇒ 必红在「steer 臂」
//
// 修前红：tip 上还没有 `#view-tabs` / `#questions-pane`（第 0 条断言就挂）。
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boot, sendJson, readBody, waitFor } from './ui-harness.mjs';

const ids = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
};
const qids = {
  options: 'q-0000aaaa',
  plain: 'q-0000bbbb',
  answered: 'q-0000cccc',
  closed: 'q-0000dddd',
  extra: 'q-0000eeee',
  options2: 'q-0000ffff',
  // 会话 C：被 `op:'update'` 就地改过的两条（P0.5）。
  updated: 'q-0000abab',
  updated2: 'q-0000acac',
};
// §16.5 那条：验收「followUp 这条真话页面上也说得出来」用的（临时往假 store 里加一条）。
const QID_FOLLOWUP = 'q-0000fe0a';
const artifacts = path.join(os.tmpdir(), 'sopho-manager-questions');
const screenshotSession = path.join(artifacts, 'session-1200x760.png');
const screenshotOpen = path.join(artifacts, 'questions-open-1200x760.png');
const screenshotAnswered = path.join(artifacts, 'questions-answered-1200x760.png');
const T = Date.now() - 3_600_000;
// 工具契约（`docs/manager-toolkit-plan.md` §2/§3）：问题自带「判断所需的事实」。
// 多行（含 `\n`）用来验渲染是**原样**（CSS pre-wrap），不是拼成一行。
const ctxWith = '第一行：C: 只剩 515 GB，pagefile.sys 42 GB、hiberfil.sys 26 GB 都还没动。\n第二行：A 组纯日志 202.6 GB 零风险；B/C 中的日志部分约 358.6 GB。\n第三行：当前主线 = 先把零风险的清掉。';

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// ── 假的会话文件（append-only 条目；`op` 序列就是事实源）────────────────────────────
// 第一条**带** `status` 字段，其余只带 `op` —— 两种响应形状都走一遍。
const store = [
  { id: qids.options, op: 'ask', status: 'open', text: '第一件事：要不要立刻把这条 landing 合进 master？', options: ['立刻合', '等我再看'], priority: 'high', by: 'agent', at: T, context: ctxWith },
  // 老条目：工具还没要求 context 的那个时代落的条目 —— 一条不带 context 的未答，未答页断言「如实那句」。
  { id: qids.plain, op: 'ask', text: '第二件事：旧分支留不留？', options: null, priority: 'normal', by: 'agent', at: T + 60_000 },
  { id: qids.answered, op: 'ask', text: '已经答过的那条', by: 'agent', at: T - 900_000 },
  { id: qids.answered, op: 'answer', text: '已经答过的那条', answer: '照着方案继续', by: 'user', at: T - 540_000 },
  // 已关/已答页也要画背景（同一个 `renderQuestions`）—— 拿一条带 context 的已关条目验。
  { id: qids.closed, op: 'ask', text: '后来不需要了的那条', by: 'agent', at: T - 900_000, context: ctxWith },
  { id: qids.closed, op: 'close', text: '后来不需要了的那条', closeReason: '换个方向做了', by: 'user', at: T - 480_000 },
  // ── 会话 C：两条被 `op:'update'` 就地改过的未答（P0.5；“让 ai 可以更新对话”）──────────
  // 每条 = 一条 ask + 一条 update，现状按“最后一条 op”合成；`askedAt` 仍是问的时刻。
  // 题面/背景/候选/优先级都会被改写 —— 渲染必须只看到新的那份。
  { session: ids.c, id: qids.updated, op: 'ask', text: '更新前：这条会被就地改掉', options: ['旧甲', '旧乙'], priority: 'normal', by: 'agent', at: T + 120_000, context: '更新前的旧背景：这段文字在更新后就不该再出现在页面上（用来证“最后一条 op”真的赢），现在先垫上四十个字。' },
  { session: ids.c, id: qids.updated, op: 'update', text: '更新后：题面已经改过', options: ['新甲', '新乙'], priority: 'high', by: 'agent', at: T + 180_000, context: ctxWith },
  { session: ids.c, id: qids.updated2, op: 'ask', text: '更新前的第二条', options: null, priority: 'normal', by: 'agent', at: T + 200_000, context: '更新前第二条的旧背景：同样在更新后不该再出现，垫够四十个字用来验“最后一条 op 决定现状”。' },
  { session: ids.c, id: qids.updated2, op: 'update', text: '更新后的第二条（用来验关闭）', options: null, priority: 'normal', by: 'agent', at: T + 240_000, context: '更新后第二条的新背景：这条只验关闭流程照旧，所以候选留空、优先级不变，只改题面与背景。' },
];
const statusOf = (entry) => (entry.status === 'open' || entry.status === 'answered' || entry.status === 'closed'
  ? entry.status
  : entry.op === 'answer' ? 'answered' : entry.op === 'close' ? 'closed' : 'open');
const rowsOf = (id) => store.filter((entry) => entry.id === id);
const latestEntries = () => {
  const last = new Map();
  for (const entry of store) last.set(entry.id, entry);
  return [...last.values()];
};
// 真实服务端的 GET 条目形状（`server/base-logic.mjs` 的 `questionWire`）：聚合后逐字段，
// 「问的账」（askedAt/askedBy）与「这次状态变更的账」（answeredAt/answerBy、closedAt/closedBy）分开。
const wireOf = (id) => {
  const state = {
    id, op: null, status: 'open', text: null, options: null, priority: null, dedupeKey: null,
    at: null, by: null, askedAt: null, askedBy: null,
    answer: null, answeredAt: null, answerBy: null,
    closeReason: null, closedAt: null, closedBy: null, context: null, updatedAt: null, updatedBy: null, entryId: null, entryCount: 0,
  };
  const rows = rowsOf(id);
  state.entryCount = rows.length;
  state.entryId = rows.at(-1)?.entryId ?? null;
  for (const row of rows) {
    if (typeof row.op === 'string') state.op = row.op;
    if (Number.isFinite(row.at)) state.at = row.at;
    if (typeof row.by === 'string') state.by = row.by;
    if (typeof row.text === 'string' && row.text !== '') state.text = row.text;
    if (row.op === 'ask') {
      if (Number.isFinite(row.at)) state.askedAt = row.at;
      if (typeof row.by === 'string') state.askedBy = row.by;
      if (row.options !== undefined) state.options = Array.isArray(row.options) ? row.options : null;
      if (typeof row.priority === 'string') state.priority = row.priority;
      // 真实服务端只在 `op:'ask'` 那条上投影 context（与 text/options/priority 同口径）。
      if (typeof row.context === 'string') state.context = row.context;
    }
    if (row.op === 'answer') {
      state.answer = typeof row.answer === 'string' ? row.answer : '';
      if (Number.isFinite(row.at)) state.answeredAt = row.at;
      if (typeof row.by === 'string') state.answerBy = row.by;
    }
    if (row.op === 'close') {
      state.closeReason = typeof row.closeReason === 'string' ? row.closeReason : '';
      if (Number.isFinite(row.at)) state.closedAt = row.at;
      if (typeof row.by === 'string') state.closedBy = row.by;
    }
    // P0.5：`op:'update'` 就地改写现状（text 由上面的通用行处理），另记 updatedAt/updatedBy ——
    // 与真实服务端 `server/base-logic.mjs` 的 `questionStates` 逐行对齐。
    if (row.op === 'update') {
      if (typeof row.context === 'string') state.context = row.context;
      if (row.options !== undefined) state.options = Array.isArray(row.options) ? row.options : null;
      if (typeof row.priority === 'string') state.priority = row.priority;
      if (Number.isFinite(row.at)) state.updatedAt = row.at;
      if (typeof row.by === 'string') state.updatedBy = row.by;
    }
  }
  state.status = state.op === 'answer' ? 'answered' : state.op === 'close' ? 'closed' : 'open';
  return state;
};
// 这些条目都属于会话 A；会话 B 没有任何问题条目（用来验 N=0 与「视图按会话记忆」）。
// `status` 过滤口径与服务端一致：`answered` = 所有非 open（已答**或**已关）。
const questionsPayload = (sessionId, status) => {
  // 会话归属：老条目没打 `session` 的都属于 A；C 有自己那两条。
  const questionIds = [...new Set(store.filter((entry) => (entry.session ?? ids.a) === sessionId).map((entry) => entry.id))];
  const wire = control.legacyShape
    ? questionIds.map((id) => ({ ...rowsOf(id).at(-1) })) // 老/别的形状：只回「该 id 最后一条 op」
    : questionIds.map((id) => wireOf(id));
  const counts = { open: 0, answered: 0, closed: 0, concluded: 0, total: wire.length };
  for (const row of wire) {
    counts[statusOf(row)] += 1;
    if (statusOf(row) !== 'open') counts.concluded += 1; // P0 第三轮加的键（open + concluded === total）
  }
  const filtered = wire.filter((row) => (status === 'all' ? true : status === 'open' ? statusOf(row) === 'open' : statusOf(row) !== 'open'));
  return { questions: filtered, counts, filteredCount: filtered.length };
};

// ── 左栏事实（未读闭环用）──────────────────────────────────────────────────────────
const treeState = {
  [ids.a]: { settledAt: T, seenAt: T + 1000 },
  [ids.b]: { settledAt: T - 100_000, seenAt: T - 100_000 },
  [ids.c]: { settledAt: T, seenAt: T },
};
// 把左栏「两条滚动轴」都填溢出（活跃 ~38 行 / 存档 16 行）：本门的「切页不影响左栏两条滚动轴」
// 才量得到真实的 scrollTop（否则 scrollTop 永远是 0，断言等于没量）。
const fillerActive = Array.from({ length: 36 }, (_, index) => `a0000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`);
const fillerArchived = Array.from({ length: 16 }, (_, index) => `f0000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`);
const sessionRows = () => [
  { id: ids.a, name: 'Manager A', parentId: null, archived: false, cwd: 'C:/work/a', modifiedAt: new Date(T).toISOString(), titleSource: 'auto' },
  { id: ids.b, name: 'Idle B', parentId: null, archived: false, cwd: 'C:/work/b', modifiedAt: new Date(T).toISOString(), titleSource: 'auto' },
  { id: ids.c, name: 'Updated C', parentId: null, archived: false, cwd: 'C:/work/c', modifiedAt: new Date(T).toISOString(), titleSource: 'auto' },
].map((row) => {
  const state = treeState[row.id];
  const unread = state.settledAt > state.seenAt;
  return {
    ...row,
    status: unread ? 'unread' : 'idle',
    statusLabel: unread ? '未读' : '闲置',
    unread,
    settledAt: state.settledAt,
    seenAt: state.seenAt,
    notify: { notifies: [], waitingFor: [] },
  };
}).concat(
  fillerActive.map((id, index) => ({ id, name: `Extra active ${index}`, parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, settledAt: T, seenAt: T, notify: { notifies: [], waitingFor: [] } })),
  fillerArchived.map((id, index) => ({ id, name: `Extra archived ${index}`, parentId: null, archived: true, status: 'idle', statusLabel: '闲置', unread: false, settledAt: T, seenAt: T, modifiedAt: new Date(T - index * 60_000).toISOString(), notify: { notifies: [], waitingFor: [] } })),
);
const treePayload = () => ({ sessions: sessionRows(), unread: { count: sessionRows().filter((row) => row.unread).length } });


// ── 控制面（同一个进程里，测试直接读这些账）─────────────────────────────────────────────
const control = {
  mode: 'ok', // ok | answer500 | close500 | netfail | questions404
  deliveryQueued: false,
  deliveryMode: null, // null | 'steer' | 'followUp' | 'message'（与真实服务端的 `delivery.mode` 对齐）
  deliveryShape: 'both', // both（默认，同 P0）| top（只给顶层 queuedForDelivery）| legacy（只给**无 mode 的**老 delivery）
  legacyShape: false, // 切成「只回最后一条 op」的老形状，验前端容错
  seenPosts: [],
  answerRequests: [],
  closeRequests: [],
  questionRequests: [],
  // 红线（`docs/questions-context-gap.md`）：问题页**绝不许**新增 `/messages` 请求。
  // 这条计数就是它的机械判据（看问题页的那段里必须不增）。
  messagesRequests: 0,
  nestedRequests: [], // 反证臂：嵌套路径（契约里**不存在**的那些）一旦被请求就记在这里
  treeClients: new Set(),
  sessionStreams: new Map(),
};
const broadcastTree = () => {
  const payload = JSON.stringify({ type: 'tree.session', sessionId: ids.a });
  for (const response of control.treeClients) response.write(`event: tree.session\ndata: ${payload}\n\n`);
};
const broadcastSession = (name, data) => {
  for (const streams of control.sessionStreams.values()) {
    for (const response of streams) {
      if (!response.destroyed) response.write(`event: ${name}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    }
  }
};
const messagesPayload = (id) => ({
  messages: Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `${id} 第 ${index} 条 ${'正文内容 '.repeat(12)}`,
  })),
  extras: [],
  compaction: { atIndex: null, note: '' },
  observability: null,
});

let ui;
let problemsAtStart = 0;
try {
  await mkdir(artifacts, { recursive: true });
  ui = await boot({
    width: 1200,
    height: 760,
    // 反证臂用：把 `web/` 指到一份改回旧文案的快照上（不给就是本仓的 web/）。
    ...(process.env.SOPHO_QUESTIONS_UI_WEB ? { webRoot: path.resolve(process.env.SOPHO_QUESTIONS_UI_WEB) } : {}),
    routes: async (request, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload()), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
        control.treeClients.add(response);
        response.once('close', () => control.treeClients.delete(response));
        return true;
      }
      if (pathname === '/api/test/event' && request.method === 'POST') {
        const { name, data } = JSON.parse((await readBody(request)) || '{}');
        broadcastSession(name, data);
        return sendJson(response, 200, { ok: true, name }), true;
      }

      // ── 控制面 ────────────────────────────────────────────────────────────────
      if (pathname === '/control/mode') {
        control.mode = url.searchParams.get('mode') || 'ok';
        return sendJson(response, 200, { mode: control.mode }), true;
      }
      if (pathname === '/control/ask') {
        const id = url.searchParams.get('id') || qids.extra;
        const text = url.searchParams.get('text') || '服务端新加的一条待确认问题';
        const options = url.searchParams.get('options');
        const context = url.searchParams.get('context');
        store.push({ id, op: 'ask', text, options: options ? options.split(',') : null, priority: 'normal', by: 'agent', at: Date.now(), ...(context === null ? {} : { context }) });
        return sendJson(response, 200, { ok: true, id }), true;
      }
      if (pathname === '/control/unread') {
        const id = url.searchParams.get('session') || ids.a;
        treeState[id].settledAt = Date.now();
        treeState[id].seenAt = 0;
        broadcastTree();
        return sendJson(response, 200, { ok: true }), true;
      }
      if (pathname === '/control/state') {
        return sendJson(response, 200, {
          mode: control.mode,
          legacyShape: control.legacyShape,
          seenPosts: control.seenPosts,
          answers: control.answerRequests,
          closes: control.closeRequests,
          questionRequests: control.questionRequests.map((item) => item.status),
          questionRequestPaths: control.questionRequests.map((item) => item.path),
          nestedRequests: control.nestedRequests,
          store: latestEntries(),
        }), true;
      }
      if (pathname === '/control/delivery') {
        // `mode=steer|followUp|message`（2026-09-22 与真实服务端对齐：回执主字段是 `delivery.mode`）；
        // 不给 mode 就用老开关 `queued=0|1`（退回 `delivery.queued` 的口径）。
        // shape=both（默认，同 P0）| top（只给顶层 `queuedForDelivery`）| legacy（只给**无 mode 的**老 `delivery`）。
        const wantedMode = url.searchParams.get('mode');
        control.deliveryMode = ['steer', 'followUp', 'message'].includes(wantedMode) ? wantedMode : null;
        control.deliveryQueued = control.deliveryMode ? control.deliveryMode === 'followUp' : url.searchParams.get('queued') === '1';
        control.deliveryShape = url.searchParams.get('shape') || 'both';
        return sendJson(response, 200, { mode: control.deliveryMode, queued: control.deliveryQueued, shape: control.deliveryShape }), true;
      }
      if (pathname === '/control/legacy') {
        control.legacyShape = url.searchParams.get('on') === '1';
        return sendJson(response, 200, { legacyShape: control.legacyShape }), true;
      }
      if (pathname === '/control/answered-elsewhere') {
        // 模拟「这条在别处已经被答了」（另一个标签页 / agent 自己关的）——用来验 409 那条路。
        const id = url.searchParams.get('id');
        const current = latestEntries().find((entry) => entry.id === id);
        if (current && statusOf(current) === 'open') store.push({ id, op: 'answer', text: current.text, answer: '（在别处答的）', by: 'user', at: Date.now() });
        return sendJson(response, 200, { ok: true, id }), true;
      }

      // ── 反证臂：契约里**不存在**的嵌套路径（`…/questions/{qid}/answer|close`）────────────
      // 真宿主/worker 里这条路由不存在 ⇒ 404。一旦前端又改回嵌套路径，它就会打到这里：
      // 记一笔 + 404 ⇒ 请求体断言、列表更新、计数那几条会一起红。
      const nestedMatch = /^\/api\/sessions\/([^/]+)\/questions\/[^/]+(?:\/(answer|close))?$/.exec(pathname);
      if (nestedMatch) {
        control.nestedRequests.push({ method: request.method, path: pathname, body: await readBody(request) });
        return sendJson(response, 404, { error: 'not_found', message: `no route: ${pathname}` }), true;
      }

      // ── 契约端点（answer/close = 一层路径 + body 里的 op）───────────────────────────
      const questionsMatch = /^\/api\/sessions\/([^/]+)\/questions$/.exec(pathname);
      if (questionsMatch) {
        const sessionId = questionsMatch[1];
        // 先记账再判 404：这道门要能断言「客户端确实去问了，只是服务端说没有」。
        if (request.method === 'GET') control.questionRequests.push({ status: url.searchParams.get('status') || 'open', path: pathname, at: Date.now() });
        if (control.mode === 'questions404') return sendJson(response, 404, { error: 'unknown_route', message: 'no such route' }), true;
        if (request.method === 'GET') return sendJson(response, 200, questionsPayload(sessionId, url.searchParams.get('status') || 'open')), true;
        const raw = await readBody(request);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 坏输入由下面的分支如实报 */ }
        const op = body.op;
        const qid = typeof body.qid === 'string' ? body.qid : null;
        if (op !== 'answer' && op !== 'close') {
          // 不带 op 的那条是 ask（agent 侧；网页不该发它）—— 假 API 按真服务端的码如实拒。
          return sendJson(response, 400, { error: 'invalid_op', message: 'op must be one of ask, answer, close' }), true;
        }
        if (control.mode === 'netfail') { response.destroy(); return true; }
        (op === 'answer' ? control.answerRequests : control.closeRequests).push({ method: request.method, path: pathname, contentType: request.headers['content-type'], body });
        if (control.mode === `${op}500`) return sendJson(response, 500, { error: 'server_busy', message: `受控 500：故意让${op === 'answer' ? '答题' : '关闭'}失败` }), true;
        if (!qid) return sendJson(response, 400, { error: 'invalid_question_id', message: 'qid must look like q-<8 hex>' }), true;
        const current = latestEntries().find((entry) => entry.id === qid);
        if (!current) return sendJson(response, 404, { error: 'question_not_found', message: `no question with id ${qid} in this session`, id: qid }), true;
        if (statusOf(current) !== 'open') return sendJson(response, 409, { error: 'question_not_open', message: `question ${qid} is already ${statusOf(current)}` }), true;
        const at = Date.now();
        if (op === 'answer') {
          // §1 的形状：每一条 op 条目都带 text
          store.push({ session: sessionId, id: qid, entryId: `${qid}-e${store.length}`, op: 'answer', text: current.text, answer: String(body.text ?? ''), by: 'user', at });
          // 回执按真实服务端的形状（P0 第三轮：顶层 `queuedForDelivery` + 整块 `delivery`；
          // 2026-09-22 起 `delivery.mode` 是主字段：steer / followUp / message）。
          const queued = control.deliveryQueued;
          const mode = control.deliveryMode ?? (queued ? 'followUp' : 'message');
          const notes = {
            steer: '会话正在跑：回答已作为插话注入当前这一轮 ⇒ 它会影响当前这一轮的行为（不再等这一轮跑完）。',
            followUp: '会话正处在准入窗口（有 prompt 正在派发/一条扩展命令正在跑，此刻还没有活跃回合）⇒ steer 的前提不成立；回答已排进 followUp 队列，等那一轮（若这次准入根本不跑模型，则等下一次跑）的回合边界再作为一条 user 消息送达。',
            message: '回答已作为一条 user 消息投进会话，并触发了新一轮回复。',
          };
          // legacy：老服务端的 `delivery` 块里**没有** `mode`（只有 queued/note）—— 前端必须靠 queued 兜底。
          const delivery = control.deliveryShape === 'legacy'
            ? { queued, note: queued ? '会话正在跑：回答已排进 followUp 队列（不打断当前回合），队列空出来就作为一条 user 消息送达。' : notes.message }
            : { mode, queued, note: notes[mode] };
          return sendJson(response, 200, {
            ok: true, id: qid, status: 'answered', answeredAt: at, by: 'user', at,
            ...(control.deliveryShape === 'legacy' ? {} : { queuedForDelivery: queued }),
            ...(control.deliveryShape === 'top' ? {} : { delivery }),
            question: wireOf(qid),
          }), true;
        }
        store.push({ session: sessionId, id: qid, entryId: `${qid}-e${store.length}`, op: 'close', text: current.text, closeReason: String(body.reason ?? ''), by: 'user', at });
        return sendJson(response, 200, { ok: true, id: qid, status: 'closed', closedAt: at, closedBy: 'user', at, question: wireOf(qid) }), true;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen|draft|commands))?$/.exec(pathname);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        if (action === 'messages') { control.messagesRequests += 1; return sendJson(response, 200, messagesPayload(id)), true; }
        if (action === 'seen' && request.method === 'POST') {
          control.seenPosts.push(id);
          treeState[id].seenAt = Date.now();
          return sendJson(response, 200, { ok: true, id, unread: false }), true;
        }
        if (action === 'draft') {
          await readBody(request);
          return sendJson(response, 200, { text: '' }), true;
        }
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
          if (!control.sessionStreams.has(id)) control.sessionStreams.set(id, new Set());
          control.sessionStreams.get(id).add(response);
          response.once('close', () => control.sessionStreams.get(id)?.delete(response));
          return true;
        }
        const row = sessionRows().find((entry) => entry.id === id);
        return sendJson(response, 200, {
          name: row?.name ?? id, cwd: row?.cwd ?? 'C:/work', archived: false,
          runtime: { isStreaming: false, isCompacting: false, isRetrying: false },
          observability: null, context: null,
        }), true;
      }
      return false;
    },
  });
  problemsAtStart = ui.pageProblems.length;

  const setMode = async (mode) => {
    const result = await fetch(`http://127.0.0.1:${ui.port}/control/mode?mode=${mode}`);
    if (!result.ok) throw new Error(`setMode(${mode}) failed: ${result.status}`);
    await result.json();
  };
  const controlGet = (suffix) => fetch(`http://127.0.0.1:${ui.port}${suffix}`).then((result) => result.json());
  const viewState = () => ui.evaluate(`(() => {
    const main=document.querySelector('main'); const pane=document.querySelector('#questions-pane');
    const list=document.querySelector('#questions-list'); const tabs=document.querySelector('#view-tabs');
    const composer=document.querySelector('#composer'); const messagesPane=document.querySelector('.messages-pane');
    const tab=(selector)=>{ const node=document.querySelector(selector); if(!node) return {missing:true}; return { text: node.textContent, selected: node.getAttribute('aria-selected'), disabled: node.disabled, openCount: node.dataset.openCount, known: node.dataset.countKnown }; };
    const notice=document.querySelector('#questions-notice');
    return {
      view: main.dataset.view ?? null,
      sessionTab: tab('#view-tab-session'),
      questionTab: tab('#view-tab-questions'),
      annotationsTab: tab('#view-tab-annotations'),
      debugTab: tab('#view-tab-debug'),
      tabsExist: tabs !== null,
      paneHidden: pane ? pane.hidden : null,
      list: list ? { load: list.dataset.load, status: list.dataset.status, count: document.querySelectorAll('#questions-list .question-item').length, text: list.textContent } : { missing: true },
      items: Array.from(document.querySelectorAll('#questions-list .question-item')).map((item) => ({ id: item.dataset.questionId, status: item.dataset.status, busy: item.dataset.busy ?? '', text: item.textContent })),
      composer: { display: getComputedStyle(composer).display, height: composer.getBoundingClientRect().height, hidden: composer.hidden },
      messagesPane: { visibility: getComputedStyle(messagesPane).visibility, top: document.querySelector('#messages').scrollTop },
      notice: notice ? notice.textContent : null,
      noticeLevel: notice ? notice.dataset.level : null,
      filter: { open: document.querySelector('#questions-filter-open')?.getAttribute('aria-selected') ?? null, answered: document.querySelector('#questions-filter-answered')?.getAttribute('aria-selected') ?? null },
    };
  })()`);
  const click = (selector) => ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickIn = (questionId, selector) => ui.evaluate(`(() => { const node=document.querySelector('[data-question-id="'+${JSON.stringify(questionId)}+'"] '+${JSON.stringify(selector)}); if(!node) throw new Error('missing ${selector} in ${questionId}'); node.click(); })()`);
  const typeIn = (questionId, value) => ui.evaluate(`(() => { const node=document.querySelector('[data-question-id="'+${JSON.stringify(questionId)}+'"] [data-field="answer"]'); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const typeCloseReason = (value) => ui.evaluate(`(() => { const node=document.querySelector('[data-field="close-reason"]'); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const openSession = async (id) => {
    await ui.evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
    await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), `session ${id} did not open`);
  };
  const waitView = (view, message) => waitFor(async () => (await viewState()).view === view, message);

  // ── 0. 没选会话：页签在岗但置灰，默认「会话」────────────────────────────────────
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"]') !== null`), 'tree did not render');
  const idle = await viewState();
  check('顶栏右侧有视图切换（四个页签式按钮：会话/问题/标注/调试；会话/问题未选会话时置灰，两个全局页「标注」「调试」始终可用），默认「会话」',
    idle.tabsExist && idle.sessionTab.disabled && idle.questionTab.disabled && idle.annotationsTab.disabled === false && idle.debugTab.disabled === false && idle.view === 'session' && idle.questionTab.text === '问题' && idle.sessionTab.text === '会话' && idle.debugTab.text === '调试',
    JSON.stringify({ view: idle.view, sessionTab: idle.sessionTab, questionTab: idle.questionTab, annotationsTab: idle.annotationsTab, debugTab: idle.debugTab }));

  // ── 1. 打开会话 A：页签在岗、在顶栏右侧、未答数 = 2 ──────────────────────────────
  await openSession(ids.a);
  await waitFor(async () => (await viewState()).questionTab.text === '问题 2', '未答数没有显示成「问题 2」');
  const opened = await viewState();
  check('未答数并入「问题」页签（N>0 显示 `问题 N`；默认仍在会话页）',
    opened.questionTab.text === '问题 2' && opened.questionTab.openCount === '2' && opened.questionTab.known === 'true'
    && opened.questionTab.selected === 'false' && opened.sessionTab.selected === 'true' && !opened.questionTab.disabled,
    JSON.stringify(opened.questionTab));
  const geo = await ui.evaluate(`(() => {
    const rect=(selector)=>{ const node=document.querySelector(selector); const box=node.getBoundingClientRect(); return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}; };
    return {header:rect('main > header'), title:rect('#session-title'), sessionTab:rect('#view-tab-session'), questionTab:rect('#view-tab-questions'), annotationsTab:rect('#view-tab-annotations'), debugTab:rect('#view-tab-debug'), usage:rect('#session-usage')};
  })()`);
  // ⚠️ 本单（右栏加「调试」页签）改动了这条断言的事实基：贴顶栏右内边的不再是「标注」，而是新的**最后一个**页签「调试」；
  //    四个页签从左到右依次是 会话 < 问题 < 标注 < 调试，四个都是 26px 单行。这是按新事实收紧，不是放宽。
  check('切换器在顶栏**右侧**且在岗（贴顶栏右内边的是最后一个页签「调试」；会话<问题<标注<调试；在标题右侧、与会话标题同一行、在观测行之上）',
    Math.abs(geo.header.right - geo.debugTab.right) <= 14
    && geo.questionTab.left > geo.title.left
    && geo.sessionTab.left < geo.questionTab.left
    && geo.questionTab.right <= geo.annotationsTab.left + 0.5
    && geo.annotationsTab.right <= geo.debugTab.left + 0.5
    && geo.annotationsTab.top >= geo.header.top && geo.annotationsTab.bottom <= geo.header.top + 40
    && geo.debugTab.top >= geo.header.top && geo.debugTab.bottom <= geo.header.top + 40
    && geo.questionTab.bottom < geo.usage.top
    && Math.abs(geo.sessionTab.height - 26) <= 0.5 && Math.abs(geo.questionTab.height - 26) <= 0.5 && Math.abs(geo.debugTab.height - 26) <= 0.5,
    JSON.stringify(geo));
  const baseline = await ui.evaluate(`({header:document.querySelector('main > header').getBoundingClientRect().height, composer:document.querySelector('#composer').getBoundingClientRect().height, usage:document.querySelector('#session-usage').getBoundingClientRect().height})`);
  check('顶栏既有 26px 单行行高没被切换器改变',
    Math.abs(baseline.usage - 26) <= 0.5 && baseline.composer >= 40,
    JSON.stringify(baseline));
  await ui.screenshot(screenshotSession);
  print('session page screenshot', screenshotSession);

  // ── 2. 切到问题页：默认列未答 ─────────────────────────────────────────────────
  await click('#view-tab-questions');
  await waitFor(async () => {
    const state = await viewState();
    return state.view === 'questions' && !state.paneHidden && state.list.load === 'ready';
  }, '问题页没有切出来');
  // 红线基线：从这里到答/关走完，`/messages` 请求数必须不增（问题页绝不另拉正文）。
  const messagesBaseline = control.messagesRequests;
  const questionView = await viewState();
  check('切到问题页 ⇒ 显示未答列表（默认 status=open，两条都在）',
    questionView.list.count === 2
    && questionView.list.status === 'open'
    && questionView.items.every((item) => item.status === 'open')
    && questionView.items.some((item) => item.text.includes('要不要立刻把这条 landing 合进 master？'))
    && questionView.items.some((item) => item.text.includes('旧分支留不留？')),
    JSON.stringify(questionView.items.map((item) => ({ id: item.id, status: item.status }))));

  // ── 2.5 问题自带上下文（「背景」）：在**题面之上**逐字可见；老条目如实说没有 ──────────────
  const ctxView = await ui.evaluate(`(() => {
    const withCtx = document.querySelector('[data-question-id="${qids.options}"]');
    const noCtx = document.querySelector('[data-question-id="${qids.plain}"]');
    const pick = (node) => {
      if (!node) return { missing: true };
      const body = node.querySelector('.question-context-body');
      const kids = [...node.children].map((child) => child.className);
      return {
        label: node.querySelector('.question-context-label')?.textContent ?? null,
        body: body?.textContent ?? null,
        whiteSpace: body ? getComputedStyle(body).whiteSpace : null,
        blockBeforeHead: kids.indexOf('question-context') < kids.indexOf('question-head'),
      };
    };
    return { withCtx: pick(withCtx), noCtx: pick(noCtx) };
  })()`);
  check('问题条目在**题面之上**画出「背景」（明确标注 + 多行原样：pre-wrap、逐字相等）',
    ctxView.withCtx.label === '背景'
    && ctxView.withCtx.body === ctxWith
    && ctxView.withCtx.whiteSpace === 'pre-wrap'
    && ctxView.withCtx.blockBeforeHead === true,
    JSON.stringify(ctxView.withCtx));
  check('老条目（没有 context）如实写一句「没有自带背景」，不留空、不编',
    ctxView.noCtx.body === '这条问题没有自带背景（当时的工具还没要求）。',
    JSON.stringify(ctxView.noCtx));
  check('有/无背景两种条目的候选与答题/关闭入口都不变',
    (await ui.evaluate(`document.querySelectorAll('[data-question-id="${qids.options}"] .question-options button').length`)) === 2
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.plain}"] [data-action="answer"]') !== null`))
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.plain}"] [data-action="close"]') !== null`)),
    'ok');

  check('未答条目：有 options 出候选按钮，答/关闭入口齐，两个页签状态正确',
    (await ui.evaluate(`document.querySelectorAll('[data-question-id="${qids.options}"] .question-options button').length`)) === 2
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.options}"] [data-action="answer"]') !== null`))
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.options}"] [data-action="close"]') !== null`))
    && questionView.filter.open === 'true' && questionView.filter.answered === 'false',
    JSON.stringify(questionView.filter));
  check('切到问题页时正文容器只切 visibility（不是 display:none）—— 滚动位置还活着',
    questionView.messagesPane.visibility === 'hidden',
    JSON.stringify(questionView.messagesPane));
  check('切到问题页时底栏隐藏', questionView.composer.display === 'none', JSON.stringify(questionView.composer));
  // 问题页是**顶掉右栏中段**（与正文区同格、重叠），不是挤在正文旁边 —— 宽度/左右边要与正文区逐字一致。
  const paneGeo = await ui.evaluate(`(() => {
    const rect=(selector)=>{ const box=document.querySelector(selector).getBoundingClientRect(); return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width}; };
    return {main:rect('main'), pane:rect('#questions-pane'), messagesPane:rect('.messages-pane'), header:rect('main > header'), list:rect('#questions-list'), toolbar:rect('#questions-toolbar')};
  })()`);
  check('问题页顶掉右栏中段（与正文区同格：左/右/上边界逐字一致，不是并排挤在旁边）',
    Math.abs(paneGeo.pane.left - paneGeo.main.left) <= 1
    && Math.abs(paneGeo.pane.right - paneGeo.main.right) <= 1
    && Math.abs(paneGeo.pane.left - paneGeo.messagesPane.left) <= 1
    && Math.abs(paneGeo.pane.right - paneGeo.messagesPane.right) <= 1
    && Math.abs(paneGeo.pane.top - paneGeo.messagesPane.top) <= 1
    && Math.abs(paneGeo.pane.top - paneGeo.header.bottom) <= 1
    && paneGeo.list.width > paneGeo.main.width * 0.8
    && paneGeo.pane.bottom <= paneGeo.main.bottom + 1,
    JSON.stringify(paneGeo));
  await ui.screenshot(screenshotOpen);
  print('questions (open) screenshot', screenshotOpen);

  // ── 3. 已答/已关：历史 + 谁在什么时候（留痕）────────────────────────────────────
  await click('#questions-filter-answered');
  await waitFor(async () => (await viewState()).list.status === 'answered' && (await viewState()).list.load === 'ready', '已答页没有切出来');
  const answeredView = await viewState();
  const answeredItem = answeredView.items.find((item) => item.id === qids.answered);
  const closedItem = answeredView.items.find((item) => item.id === qids.closed);
  check('切到已答/已关 ⇒ 显示历史（已答 + 已关；未答的不混进来）',
    answeredView.list.count === 2
    && answeredItem?.status === 'answered'
    && closedItem?.status === 'closed'
    && !answeredView.items.some((item) => item.id === qids.options || item.id === qids.plain),
    JSON.stringify(answeredView.items.map((item) => ({ id: item.id, status: item.status }))));
  check('已答/已关都显示**谁在什么时候**做的（by/at 留痕），且带原来的问题正文与答案/原因',
    /已经答过的那条/.test(answeredItem?.text ?? '')
    && /已答 · 用户 · \d\d-\d\d \d\d:\d\d/.test(answeredItem?.text ?? '')
    && /回答：照着方案继续/.test(answeredItem?.text ?? '')
    && /后来不需要了的那条/.test(closedItem?.text ?? '')
    && /已关（不答） · 用户 · \d\d-\d\d \d\d:\d\d/.test(closedItem?.text ?? '')
    && /原因：换个方向做了/.test(closedItem?.text ?? ''),
    JSON.stringify({ answered: answeredItem?.text, closed: closedItem?.text }));
  const ctxHist = await ui.evaluate(`(() => { const node=document.querySelector('[data-question-id="${qids.closed}"]'); return { label: node?.querySelector('.question-context-label')?.textContent ?? null, body: node?.querySelector('.question-context-body')?.textContent ?? null }; })()`);
  check('已答/已关页也画同一块「背景」（同一个 renderQuestions，两个页签都盖到）',
    ctxHist.label === '背景' && ctxHist.body === ctxWith,
    JSON.stringify(ctxHist));
  check('已答/已关读的是 status=answered（P0 口径：answered = 所有非 open），不是拿 all 在客户端凑',
    (await controlGet('/control/state')).questionRequests.at(-1) === 'answered',
    JSON.stringify((await controlGet('/control/state')).questionRequests));
  await ui.screenshot(screenshotAnswered);
  print('questions (answered/closed) screenshot', screenshotAnswered);
  // 「问于 …」不能把「谁做的这次状态变更」当成「谁问的」：已答/已关行的 `by` 是答题人，写进「问于」就是假事实。
  // 真实服务端把两笔账分得很清（askedAt/askedBy vs answeredAt/answerBy）—— 所以已答/已关行照样**能**写
  // 问的人（agent），只是绝不能是答题人（用户），时间也用 askedAt 而不是答题时间。
  const askerLines = await ui.evaluate(`({ answered: document.querySelector('[data-question-id="${qids.answered}"] .question-meta')?.textContent, closed: document.querySelector('[data-question-id="${qids.closed}"] .question-meta')?.textContent })`);
  check('「问于 …」写的是**问的人**（agent）与问的时刻，不是答题人（用户）与答题时刻',
    /^问于 \d\d-\d\d \d\d:\d\d · agent$/.test(askerLines.answered ?? '')
    && /^问于 \d\d-\d\d \d\d:\d\d · agent$/.test(askerLines.closed ?? '')
    && !/用户/.test(askerLines.answered ?? ''),
    JSON.stringify(askerLines));
  // 问的时刻（askedAt）与答/关的时刻（answeredAt/closedAt）在夹具里差 6 分钟 —— 两笔账确实分开取。
  // ⚠️ 不断言具体 HH:MM（夹具时间是相对 `Date.now()` 算的，跨过一分钟就会变）：算差值。
  const askQuestionTimes = await ui.evaluate(`(() => { const meta=document.querySelector('[data-question-id="${qids.answered}"] .question-meta')?.textContent ?? ''; const trail=document.querySelector('[data-question-id="${qids.answered}"] .question-trail')?.textContent ?? ''; return { meta, trail }; })()`);
  const minutesOf = (text) => {
    const match = /(\d\d-\d\d) (\d\d):(\d\d)/.exec(text ?? '');
    return match ? { day: match[1], minutes: Number(match[2]) * 60 + Number(match[3]) } : null;
  };
  const askedAt = minutesOf(askQuestionTimes.meta);
  const answeredAt = minutesOf(askQuestionTimes.trail);
  const accountGap = askedAt && answeredAt && askedAt.day === answeredAt.day ? (answeredAt.minutes - askedAt.minutes + 1440) % 1440 : null;
  check('「问于」用 askedAt、留痕用 answeredAt（夹具里差 6 分钟，不是同一个时间）',
    accountGap === 6,
    JSON.stringify({ ...askQuestionTimes, accountGap }));

  // ── 4. 答题：捕获请求体；成功后该条从未答消失、计数减少 ───────────────────────
  await click('#questions-filter-open');
  await waitFor(async () => (await viewState()).list.status === 'open' && (await viewState()).list.count === 2, '切回未答没成功');
  await typeIn(qids.plain, '留一条分支，别删');
  await clickIn(qids.plain, '[data-action="answer"]');
  // 等「写发出去了」而不是等「正确的那条路发出去了」：一旦又改回嵌套路径，前一种写法只会说
  // 「请求没发出去」，看不出真正原因；这么写让下面的 check 把嵌套路径原文端出来。
  await waitFor(() => control.answerRequests.length + control.nestedRequests.length >= 1, 'answer 请求没发出去');
  const answerRequest = control.answerRequests[0];
  check('答题 ⇒ POST /sessions/{id}/questions（一层路径），body {op:\'answer\', qid, text} 逐字正确',
    Boolean(answerRequest)
    && control.nestedRequests.length === 0
    && answerRequest.method === 'POST'
    && answerRequest.path === `/api/sessions/${ids.a}/questions`
    && /application\/json/.test(answerRequest.contentType || '')
    && JSON.stringify(answerRequest.body) === JSON.stringify({ op: 'answer', qid: qids.plain, text: '留一条分支，别删' }),
    JSON.stringify({ answerRequest: answerRequest ?? null, nestedRequests: control.nestedRequests }));
  await waitFor(async () => {
    const state = await viewState();
    return state.list.count === 1 && !state.items.some((item) => item.id === qids.plain) && state.questionTab.text === '问题 1';
  }, '答完之后该条没有从未答消失 / 计数没减');
  const afterAnswer = await viewState();
  check('答题成功后：该条从未答消失、未答数 2 → 1', afterAnswer.list.count === 1 && afterAnswer.questionTab.openCount === '1', JSON.stringify({ count: afterAnswer.list.count, tab: afterAnswer.questionTab.text }));
  check('答题成功有回执（问题页那条 notice 行 —— 底栏隐藏时也看得见），且按服务端 delivery 事实说话（已立即发送）',
    /已答/.test(afterAnswer.notice) && /已立即发送/.test(afterAnswer.notice) && afterAnswer.noticeLevel !== 'error',
    JSON.stringify({ notice: afterAnswer.notice, level: afterAnswer.noticeLevel }));

  // ── 5. 候选按钮 = 直接用该候选回答；空答案不许发请求 ─────────────────────────────
  await typeIn(qids.options, '   ');
  await clickIn(qids.options, '[data-action="answer"]');
  await ui.frames(3);
  const emptyAnswer = await viewState();
  check('空答案不发请求（前端直接拒，且如实说清）', control.answerRequests.length === 1 && /不能为空/.test(emptyAnswer.notice), JSON.stringify({ requests: control.answerRequests.length, notice: emptyAnswer.notice }));
  // 答题的回执是**异步**落进那条 notice 行的（POST 回来之后 submitAnswer 才写）——所以「读 notice」必须等它
  // **真的换过**，不能拿上一笔的旧回执当这一笔的（否则断言是在量上一笔：同一份代码时绿时红）。
  // ⚠️ 本文件里已有同类前例（第 9 节那臂：只等 notice 就立刻读状态 ⇒ 忙时连红 2 次、闲时连绿 3 次）。
  // 到点还没换**不抛错**：把旧值照原样交给断言，让断言自己红（红在内容，而不是一个超时）。
  const noticeAfterChange = async (previous, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let current = (await viewState()).notice;
    while (Date.now() < deadline && current === previous) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      current = (await viewState()).notice;
    }
    if (current === previous) print(`${label}（到点还没换：仍是上一笔的回执）`, previous);
    return current;
  };

  // ── steer 臂（业主 2026-09-22 拍板：忙时回答与输入框那条统一成「插进当前这一轮」）──
  await controlGet('/control/delivery?mode=steer&shape=both');
  const noticeBeforeSteer = (await viewState()).notice;
  await clickIn(qids.options, '.question-options button');
  await waitFor(() => control.answerRequests.length === 2, '候选按钮没有发出 answer 请求');
  check('点候选按钮 ⇒ 用该候选作为答案提交',
    JSON.stringify(control.answerRequests[1].body) === JSON.stringify({ op: 'answer', qid: qids.options, text: '立刻合' })
    && control.answerRequests[1].path === `/api/sessions/${ids.a}/questions`,
    JSON.stringify(control.answerRequests[1]));
  await waitFor(async () => (await viewState()).questionTab.text === '问题', '答完最后一条后没有归零');
  // 回的得是**同一种话**：忙时插话 = 影响当前这一轮；`queued` 不许出现在 steer 路径上（旧文案「已排队」必红）。
  const steerNotice = await noticeAfterChange(noticeBeforeSteer, 'steer 臂的回执没落进问题页 notice 行');
  check('回执 mode=steer ⇒ 说「插话注入当前这一轮（会影响这一轮的行为）」，且绝不谎报「已排队 / 等它这一轮结束」',
    /插话/.test(steerNotice) && /会影响这一轮/.test(steerNotice)
    && !/已排队/.test(steerNotice) && !/等它这一轮结束/.test(steerNotice),
    JSON.stringify({ notice: steerNotice, previousNotice: noticeBeforeSteer }));
  // 两块形状都得认：老服务端只给 `delivery.queued`（**没有** mode）、更老的只给顶层 `queuedForDelivery`；
  // 两块都没有时只能如实说「已投进会话」（不猜它排没排队）。
  await controlGet('/control/delivery?mode=followUp&shape=legacy');
  await controlGet(`/control/ask?id=${qids.extra}-shapes&text=${encodeURIComponent('回执形状那一条')}`);
  await ui.emit('session.question', { id: `${qids.extra}-shapes` });
  await waitFor(async () => (await viewState()).items.some((item) => item.id === `${qids.extra}-shapes`), '回执形状臂的前置条目没进列表');
  await typeIn(`${qids.extra}-shapes`, '只给 delivery 的老形状');
  const noticeBeforeLegacy = (await viewState()).notice;
  await clickIn(`${qids.extra}-shapes`, '[data-action="answer"]');
  await waitFor(() => control.answerRequests.length === 3, '老形状那条回执没发出去');
  const legacyNotice = await noticeAfterChange(noticeBeforeLegacy, '老形状臂的回执没落进问题页 notice 行');
  check('回执只带老形状 `delivery.queued`（没有 mode、没有顶层 queuedForDelivery）⇒ 照样说「已排队」，不许说成插话',
    /已排队/.test(legacyNotice) && !/插话/.test(legacyNotice),
    JSON.stringify({ notice: legacyNotice, previousNotice: noticeBeforeLegacy }));
  await controlGet('/control/delivery?queued=0&shape=both');
  await waitFor(async () => {
    const state = await viewState();
    return state.list.count === 0 && state.questionTab.text === '问题' && state.questionTab.openCount === '0';
  }, '答完最后一条后没有进空态 / 计数没有归零');
  const emptyView = await viewState();
  check('未答清空 ⇒ 页签 N=0 时只写「问题」+ 空态一句实话「没有待确认的问题」',
    emptyView.questionTab.text === '问题'
    && emptyView.questionTab.openCount === '0'
    && emptyView.questionTab.known === 'true'
    && /没有待确认的问题/.test(emptyView.list.text),
    JSON.stringify({ tab: emptyView.questionTab, list: emptyView.list.text }));
  await click('[data-action="show-answered"]');
  await waitFor(async () => (await viewState()).list.status === 'answered' && (await viewState()).list.count === 5, '空态里的一键切已答没生效');
  check('空态里可一键切到已答/已关看历史', (await viewState()).list.count === 5, JSON.stringify((await viewState()).items.map((item) => item.id)));
  await click('#questions-filter-open');

  // ── 6. 关闭（不答）：留痕原因 + POST 请求体；SSE 事件刷新计数 ─────────────────────
  await controlGet(`/control/ask?id=${qids.extra}&text=${encodeURIComponent('要不要现在停手去睡觉？')}`);
  check('（前置）服务端新加了一条未答问题', (await controlGet('/control/state')).store.some((entry) => entry.id === qids.extra), 'store 里没有新条目');
  await ui.emit('session.question', { id: qids.extra });
  await waitFor(async () => (await viewState()).questionTab.text === '问题 1', 'session.question 事件没有把计数刷上来');
  check('收到 session.question（SSE）⇒ 未答数刷新（事件那半落地时走这条路）', (await viewState()).questionTab.openCount === '1', JSON.stringify((await viewState()).questionTab));
  check('SSE 刷新后未答列表里就有那一条', (await viewState()).items.some((item) => item.id === qids.extra), JSON.stringify((await viewState()).items.map((item) => item.id)));
  const openMeta = await ui.evaluate(`document.querySelector('[data-question-id="${qids.extra}"] .question-meta')?.textContent`);
  check('未答行的「问于 …」带上问的人（agent）', /^问于 \d\d-\d\d \d\d:\d\d · agent$/.test(openMeta ?? ''), JSON.stringify(openMeta));
  await clickIn(qids.extra, '[data-action="close"]');
  await ui.frames(2);
  check('点「关闭（不答）」先展开确认行（收一句可空的原因，留痕用）', await ui.evaluate(`document.querySelector('[data-field="close-reason"]') !== null`), '没有确认行');
  await typeCloseReason('这个不问了');
  await clickIn(qids.extra, '[data-action="close-confirm"]');
  await waitFor(() => control.closeRequests.length + control.nestedRequests.length >= 1, 'close 请求没有发出去');
  check('关闭 ⇒ POST /sessions/{id}/questions（一层路径），body {op:\'close\', qid, reason} 逐字正确',
    Boolean(control.closeRequests[0])
    && control.nestedRequests.length === 0
    && control.closeRequests[0].method === 'POST'
    && control.closeRequests[0].path === `/api/sessions/${ids.a}/questions`
    && JSON.stringify(control.closeRequests[0].body) === JSON.stringify({ op: 'close', qid: qids.extra, reason: '这个不问了' }),
    JSON.stringify({ closeRequest: control.closeRequests[0] ?? null, nestedRequests: control.nestedRequests }));
  await waitFor(async () => {
    const state = await viewState();
    return state.list.count === 0 && state.questionTab.text === '问题' && state.questionTab.openCount === '0';
  }, '关闭之后列表/计数没有更新');
  check('关闭成功后：该条不在未答里、未答数归零', (await viewState()).list.count === 0, JSON.stringify((await viewState()).items));
  await click('#questions-filter-answered');
  await waitFor(async () => (await viewState()).list.count === 6, '关闭后已答/已关页没有它');
  const closedRow = (await viewState()).items.find((item) => item.id === qids.extra);
  check('关闭后已答/已关页看得到留痕（用户 + 时间 + 原因）', /已关（不答） · 用户 · \d\d-\d\d \d\d:\d\d/.test(closedRow?.text ?? '') && /原因：这个不问了/.test(closedRow?.text ?? ''), JSON.stringify(closedRow?.text));
  await click('#questions-filter-open');

  check('红线：从打开问题页到答/关走完，假 API 收到的 `/messages` 请求数 = 0（问题页绝不另拉正文）',
    control.messagesRequests === messagesBaseline,
    JSON.stringify({ baseline: messagesBaseline, now: control.messagesRequests }));

  // ── 7. 兜底：事件缺席时计数也不冻住（切到会话时轮询一次）───────────────────────
  // ⚠️ 先等「切回未答」那一次 GET 落定：不等的话，在飞的那次 GET 可能在我把新问题写进假服务端
  // **之后**才被处理，于是「不做任何事的页签上仍然是旧计数」这个前置本身就不成立（实测抽过一次）。
  await waitFor(async () => {
    const state = await viewState();
    return state.list.status === 'open' && state.list.load === 'ready' && state.questionTab.text === '问题';
  }, '切回未答没落定');
  await controlGet(`/control/ask?id=${qids.extra}-2&text=${encodeURIComponent('再问一条：要不要留活口？')}`);
  await ui.frames(2);
  check('（前置）不发 SSE 事件时，页签上的计数确实还是旧的', (await viewState()).questionTab.text === '问题', JSON.stringify((await viewState()).questionTab));
  await openSession(ids.a); // 切到会话 ⇒ 轮到「切到会话时轮询一次」这条路
  await waitFor(async () => (await viewState()).questionTab.text === '问题 1', '切到会话时没有轮询未答数');
  check('事件缺席也不冻住计数：切到会话时轮询一次就能对上（`问题 1`）', (await viewState()).questionTab.openCount === '1', JSON.stringify((await viewState()).questionTab));
  await click('#view-tab-questions');
  await waitFor(async () => (await viewState()).list.load === 'ready', '问题页没打开');
  check('切到问题页也会自己拉一次列表（不依赖 SSE）', (await viewState()).items.some((item) => item.id === `${qids.extra}-2`), JSON.stringify((await viewState()).items.map((item) => item.id)));

  // ── 8. 失败臂 A：受控 500 ⇒ 如实 notice，UI 不乐观更新（条还在、计数不变、草稿不丢）
  const beforeFail = await viewState();
  await setMode('answer500');
  await typeIn(`${qids.extra}-2`, '这条会被服务端拒掉');
  await clickIn(`${qids.extra}-2`, '[data-action="answer"]');
  await waitFor(async () => /答题失败/.test((await viewState()).notice), '500 之后没有如实报文');
  const failed = await viewState();
  check('受控 500 ⇒ 如实 notice（带 HTTP 状态与服务端原因）', failed.noticeLevel === 'error' && /答题失败/.test(failed.notice) && /500/.test(failed.notice), JSON.stringify({ notice: failed.notice, level: failed.noticeLevel }));
  check('500 之后不乐观更新：该条仍在未答里、计数不变、输入框原文不丢',
    failed.list.count === beforeFail.list.count
    && failed.items.some((item) => item.id === `${qids.extra}-2`)
    && failed.questionTab.openCount === beforeFail.questionTab.openCount
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.extra}-2"] [data-field="answer"]').value`)) === '这条会被服务端拒掉',
    JSON.stringify({ count: failed.list.count, before: beforeFail.list.count, tab: failed.questionTab }));
  await setMode('ok');
  await clickIn(`${qids.extra}-2`, '[data-action="answer"]');
  await waitFor(async () => (await viewState()).list.count === 0 && (await viewState()).questionTab.text === '问题', '恢复后重试没有成功');

  // ── 9. 失败臂 B：网络断 ⇒ 如实 notice，不乐观更新，确认行与原因都还在 ─────────
  await controlGet(`/control/ask?id=${qids.extra}-3&text=${encodeURIComponent('网络断这条：还答不答？')}`);
  await ui.emit('session.question', { id: `${qids.extra}-3` });
  await waitFor(async () => (await viewState()).list.count === 1, '网络断的前置问题没进列表');
  await setMode('netfail');
  await clickIn(`${qids.extra}-3`, '[data-action="close"]');
  await ui.frames(2);
  await typeCloseReason('断网也要留痕');
  await clickIn(`${qids.extra}-3`, '[data-action="close-confirm"]');
  await waitFor(async () => /关闭失败/.test((await viewState()).notice), '网络断之后没有如实报文');
  const netFailed = await viewState();
  check('网络断 ⇒ 如实 notice（不是静默、也不是假装成功）', netFailed.noticeLevel === 'error' && /关闭失败/.test(netFailed.notice), JSON.stringify({ notice: netFailed.notice, level: netFailed.noticeLevel }));
  check('网络断之后不乐观更新：该条还在、计数不变，确认行与原因原文都还给用户',
    netFailed.list.count === 1
    && netFailed.items.some((item) => item.id === `${qids.extra}-3`)
    && netFailed.questionTab.text === '问题 1'
    && (await ui.evaluate(`document.querySelector('[data-field="close-reason"]')?.value`)) === '断网也要留痕',
    JSON.stringify({ count: netFailed.list.count, tab: netFailed.questionTab.text, items: netFailed.items.map((item) => item.id) }));
  await setMode('ok');

  // ── 9.5 受控 409「这条已经不在未答里了」（别处答过 / agent 自己关的）⇒ 如实说 + 清单重拉 ──
  await controlGet(`/control/ask?id=${qids.extra}-4&text=${encodeURIComponent('409 这一条：别处会先答掉它')}`);
  await ui.emit('session.question', { id: `${qids.extra}-4` });
  await waitFor(async () => (await viewState()).items.some((item) => item.id === `${qids.extra}-4`), '409 的前置问题没进列表');
  const before409 = await viewState();
  await controlGet(`/control/answered-elsewhere?id=${qids.extra}-4`); // 先把它在「别处」答掉
  await typeIn(`${qids.extra}-4`, '我来晚了这一步');
  await clickIn(`${qids.extra}-4`, '[data-action="answer"]');
  await waitFor(async () => /question_not_open/.test((await viewState()).notice), '409 之后没有如实报文');
  // ⚠️ 409 之后客户端还要**真的重拉一次清单**才能把那条从未答里去掉 —— 断言必须等重拉落地：
  // 本臂原来只等 notice 就立刻读状态，机器一忙就读到重拉前那份列表（2026-09-20 实测同一份代码：
  // 忙时连红 2 次、闲时连绿 3 次；把这次等待并进来后又连绿 3 次）。门要抓的不是「notice 说了重拉」，
  // 而是「重拉真的发生了」。
  await waitFor(async () => !(await viewState()).items.some((item) => item.id === `${qids.extra}-4`), '409 之后清单没有重拉（该条仍在未答里）');
  const after409 = await viewState();
  check('受控 409（这条已被别处答/关）⇒ 如实报错码 + 说明「清单已重拉」，不是只甩一句失败',
    after409.noticeLevel === 'error' && /question_not_open/.test(after409.notice) && /重拉/.test(after409.notice),
    JSON.stringify({ notice: after409.notice, level: after409.noticeLevel }));
  check('409 之后清单确实重拉了（该条从**未答**里消失、计数跟着降）',
    !after409.items.some((item) => item.id === `${qids.extra}-4`)
    && Number(after409.questionTab.openCount) === Number(before409.questionTab.openCount) - 1,
    JSON.stringify({ before: before409.questionTab.openCount, after: after409.questionTab.openCount, items: after409.items.map((item) => item.id) }));

  // ── 10. 底栏在问题页隐藏、切回恢复；正文滚动位置保持不变 ──────────────────────
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');
  await ui.evaluate(`document.querySelector('#messages').scrollTop = 200`);
  await ui.frames(2);
  const scrollBefore = await ui.evaluate(`({top:document.querySelector('#messages').scrollTop, scrollable:document.querySelector('#messages').scrollHeight-document.querySelector('#messages').clientHeight})`);
  check('（前置）正文确实可滚，且已在会话页滚到中段', scrollBefore.scrollable > 400 && scrollBefore.top === 200, JSON.stringify(scrollBefore));
  await click('#view-tab-questions');
  await waitView('questions', '切到问题页没成功');
  const hiddenScroll = await ui.evaluate(`document.querySelector('#messages').scrollTop`);
  check('问题页期间正文的滚动位置原样保留（visibility 而不是 display:none）', hiddenScroll === 200, JSON.stringify({ hiddenScroll }));
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');
  const backToSession = await viewState();
  check('切回会话页 ⇒ 底栏恢复（高度与切页前一致），正文容器恢复可见',
    backToSession.composer.display !== 'none'
    && Math.abs(backToSession.composer.height - baseline.composer) <= 0.5
    && backToSession.messagesPane.visibility === 'visible',
    JSON.stringify({ composer: backToSession.composer, baseline: baseline.composer, visibility: backToSession.messagesPane.visibility }));
  check('切回会话页滚动位置保持不变（200 → 200）', backToSession.messagesPane.top === 200, JSON.stringify(backToSession.messagesPane));
  check('切页不动顶栏几何',
    Math.abs((await ui.evaluate(`document.querySelector('main > header').getBoundingClientRect().height`)) - baseline.header) <= 0.5,
    JSON.stringify({ header: await ui.evaluate(`document.querySelector('main > header').getBoundingClientRect().height`), baseline: baseline.header }));
  // 贴底的人切走再回来还得在底部：底栏一隐一现会改正文容器高度（row 2 = 1fr），
  // 不补偿的话浏览器会把 scrollTop 箝下去，切回来就离底一个底栏的高度。
  await ui.evaluate(`document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight`);
  await ui.frames(2);
  await click('#view-tab-questions');
  await waitView('questions', '切到问题页没成功');
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');
  const bottomDistance = await ui.evaluate(`(() => { const node=document.querySelector('#messages'); return {distance:node.scrollHeight-node.scrollTop-node.clientHeight, jump:document.querySelector('#jump').classList.contains('show')}; })()`);
  check('切页前贴底 ⇒ 切回还是贴底（没被滑出一屏、`回到底部` 不自己跳出来）',
    bottomDistance.distance <= 4 && bottomDistance.jump === false,
    JSON.stringify(bottomDistance));

  // ── 11. 切页不影响直播：问题页期间会话流继续收，切回按既有逻辑呈现 ───────────
  const liveText = 'LIVE-切页期间照样在收的正文';
  await click('#view-tab-questions');
  await waitView('questions', '再切到问题页没成功');
  await ui.emit('session.start', {});
  await ui.emit('session.delta', { channel: 'text', delta: liveText });
  await ui.frames(4);
  check('问题页期间直播照收（会话流没断、正文节点照样在长）', (await ui.evaluate(`document.querySelector('#messages').textContent.includes(${JSON.stringify(liveText)})`)) === true, 'live 正文没进 DOM');
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');
  check('切回会话页按既有逻辑呈现直播（同一段正文在，且没有重复的直播块）',
    (await ui.evaluate(`document.querySelector('#messages').textContent.includes(${JSON.stringify(liveText)})`)) === true
    && (await ui.evaluate(`document.querySelectorAll('#messages .live-message').length`)) <= 1,
    JSON.stringify({ liveNodes: await ui.evaluate(`document.querySelectorAll('#messages .live-message').length`) }));

  // ── 12. 未读闭环：问题页期间不许上报已读，切回会话页才补 ──────────────────────
  await ui.evaluate(`document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight`);
  await ui.frames(4);
  const seenBase = (await controlGet('/control/state')).seenPosts.filter((id) => id === ids.a).length;
  await click('#view-tab-questions');
  await waitView('questions', '问题页没打开');
  await controlGet(`/control/unread?session=${ids.a}`);
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"]').classList.contains('unread')`), '树行没有回到未读');
  await ui.frames(4);
  const seenDuringQuestions = (await controlGet('/control/state')).seenPosts.filter((id) => id === ids.a).length;
  check('人在问题页时不上报已读（未读闭环不被偷走）', seenDuringQuestions === seenBase, JSON.stringify({ before: seenBase, during: seenDuringQuestions }));
  await click('#view-tab-session');
  await waitFor(async () => (await controlGet('/control/state')).seenPosts.filter((id) => id === ids.a).length === seenBase + 1, '切回会话页没有补一次已读');
  check('切回会话页（贴底）才补一次已读', true, `seen ${seenBase} → ${seenBase + 1}`);

  // ── 13. 视图按会话记忆（内存，不落盘）：默认「会话」；切过问题页的会记住 ───────
  await click('#view-tab-questions');
  await waitView('questions', '问题页没打开');
  await openSession(ids.b);
  const freshB = await viewState();
  check('另一个会话默认仍是「会话」（视图按会话记，不串台）', freshB.view === 'session' && freshB.paneHidden, JSON.stringify({ view: freshB.view, hidden: freshB.paneHidden }));
  check('未答数 N=0 时页签只写「问题」（且已知就是 0）', freshB.questionTab.text === '问题' && freshB.questionTab.openCount === '0' && freshB.questionTab.known === 'true', JSON.stringify(freshB.questionTab));
  await openSession(ids.a);
  await waitFor(async () => (await viewState()).view === 'questions', '会话 A 的视图没有被记住');
  check('切回会话 A ⇒ 还是上次那个视图（问题页），且列表自己拉了回来',
    (await viewState()).view === 'questions' && (await viewState()).list.load === 'ready',
    JSON.stringify({ view: (await viewState()).view, load: (await viewState()).list.load }));

  // ── 14. 服务端还没有这四个端点（404）⇒ 如实降级、不报错、不装 0 ───────────────
  const questionRequestsBefore = control.questionRequests.length;
  await setMode('questions404');
  await openSession(ids.b);
  await waitFor(async () => control.questionRequests.length > questionRequestsBefore && (await viewState()).questionTab.known === 'false', '404 时页签没有降级成「计数未知」');
  const degraded = await viewState();
  check('404 ⇒ 页签只写「问题」、计数标成未知（不假装 0）', degraded.questionTab.text === '问题' && degraded.questionTab.openCount === '' && degraded.questionTab.known === 'false', JSON.stringify(degraded.questionTab));
  check('404 不弹错误报文（正文那半不该被这份清单拖累）', degraded.notice === '' && degraded.noticeLevel !== 'error', JSON.stringify({ notice: degraded.notice, level: degraded.noticeLevel }));
  await click('#view-tab-questions');
  await waitFor(async () => (await viewState()).list.load === 'unsupported', '404 时问题页没有如实降级');
  const unsupported = await viewState();
  check('404 ⇒ 问题页说实话（问不到 ≠ 没有问题）', /问不到/.test(unsupported.list.text) && !/没有待确认的问题/.test(unsupported.list.text), JSON.stringify(unsupported.list.text));
  await setMode('ok');

  // ── 15. 未知 SSE 事件名不报错（事件那半没落地时的容错）────────────────────────
  const problemsBeforeUnknown = ui.pageProblems.length;
  await ui.emit('session.questions', { whatever: true });
  await ui.emit('session.question', { id: 'q-不存在', text: '无所谓' });
  await ui.frames(4);
  check('未知/多余的问题事件不报错、不崩（浏览器对不存在的事件名只是不派发）',
    ui.pageProblems.length === problemsBeforeUnknown,
    JSON.stringify(ui.pageProblems.slice(problemsBeforeUnknown)));

  // ── 15.5 容错：服务端若回的是「该 id 最后一条 op」那种老/别的形状，列表也要能读 ──────
  await openSession(ids.a); // §14 停在会话 B（404 那条），先切回有问题的那个会话
  await click('#view-tab-questions');
  await waitView('questions', '问题页没打开');
  await controlGet(`/control/ask?id=${qids.extra}-5&text=${encodeURIComponent('容错这一条：老形状也要读得出来')}&options=${encodeURIComponent('甲,乙')}`);
  await ui.emit('session.question', { id: `${qids.extra}-5` });
  await waitFor(async () => (await viewState()).items.some((item) => item.id === `${qids.extra}-5`), '容错用的条目没进列表');
  await controlGet('/control/legacy?on=1');
  await click('#questions-refresh');
  await waitFor(async () => (await viewState()).list.load === 'ready' && (await viewState()).items.some((item) => item.id === `${qids.extra}-5`), '老形状下列表没读出来');
  const legacyOpen = await viewState();
  check('老形状（只回最后一条 op、不打 status）也能读出未答：状态/正文/问于都对',
    legacyOpen.items.every((item) => item.status === 'open')
    && legacyOpen.items.some((item) => item.text.includes('容错这一条：老形状也要读得出来'))
    && /^问于 \d\d-\d\d \d\d:\d\d/.test(await ui.evaluate(`document.querySelector('[data-question-id="${qids.extra}-5"] .question-meta')?.textContent`) ?? ''),
    JSON.stringify(legacyOpen.items.map((item) => ({ id: item.id, status: item.status }))));
  await click('#questions-filter-answered');
  await waitFor(async () => (await viewState()).list.status === 'answered' && (await viewState()).list.load === 'ready', '老形状下已答页没读出来');
  const legacyAnswered = await viewState();
  check('老形状下已答/已关也读得出（status 从 op 推）：已答行有答案、已关行有原因',
    legacyAnswered.items.some((item) => item.status === 'answered' && /回答：照着方案继续/.test(item.text))
    && legacyAnswered.items.some((item) => item.status === 'closed' && /原因：换个方向做了/.test(item.text)),
    JSON.stringify(legacyAnswered.items.map((item) => ({ id: item.id, status: item.status }))));
  await controlGet('/control/legacy?on=0');
  await click('#questions-filter-open');
  await waitFor(async () => (await viewState()).list.status === 'open' && (await viewState()).list.load === 'ready', '回新形状没读出来');

  // ── 15.7 更新留痕（P0.5 的 `op:'update'`，业主 2026-09-21 拍板“让 ai 可以更新对话”）────────────────
  // 真 Chromium + 假 API：会话 C 里两条都是「ask + update」（4 条条目、2 条未答）——
  // ①文本/背景按“最后一条 op”合成（旧的看不到）②「更新于 …」留痕可见 ③未答数不因更新而涨
  // ④更新过的条目照样能答题/关闭。
  await openSession(ids.c);
  await click('#view-tab-questions');
  await waitView('questions', 'C 会话的问题页没打开');
  await waitFor(async () => (await viewState()).items.some((item) => item.id === qids.updated), 'C 的更新条目没渲染出来');
  const updatedView = await viewState();
  const updatedItem = updatedView.items.find((item) => item.id === qids.updated);
  check('更新后的条目按「最后一条 op」呈现：题面是新的（旧的题面/候选不再出现）',
    updatedItem?.status === 'open'
    && updatedItem.text.includes('更新后：题面已经改过')
    && !updatedItem.text.includes('更新前：这条会被就地改掉')
    && updatedItem.text.includes('新甲') && !updatedItem.text.includes('旧甲'),
    JSON.stringify(updatedItem?.text));
  const updatedDom = await ui.evaluate(`(() => {
    const node = document.querySelector('[data-question-id="${qids.updated}"]');
    return {
      context: node?.querySelector('.question-context-body')?.textContent ?? null,
      metas: [...node.querySelectorAll('.question-meta')].map((m) => m.textContent),
      priority: node?.querySelector('.question-priority')?.textContent ?? null,
    };
  })()`);
  check('更新后的「背景」逐字是新的（老背景不再出现）',
    updatedDom.context === ctxWith && !String(updatedDom.context).includes('更新前的旧背景'),
    JSON.stringify(updatedDom.context));
  check('条目上有一行「更新于 …」留痕（与「问于 …」同风格，agent 与时刻都在）',
    updatedDom.metas.some((line) => /^更新于 \d\d-\d\d \d\d:\d\d · agent$/.test(line))
    && updatedDom.metas.some((line) => /^问于 \d\d-\d\d \d\d:\d\d · agent$/.test(line)),
    JSON.stringify(updatedDom.metas));
  check('更新把优先级也带上了（未答条目仍然能看出高优先级）',
    updatedItem?.id === qids.updated && updatedDom.priority === '高',
    JSON.stringify({ priority: updatedDom.priority }));
  check('未答数不变（更新不是新开）：4 条条目、2 条未答 ⇒ 页签「问题 2」、列表 2 条',
    updatedView.questionTab.text === '问题 2' && updatedView.questionTab.openCount === '2' && updatedView.list.count === 2,
    JSON.stringify({ tab: updatedView.questionTab.text, count: updatedView.list.count }));
  // ④ 更新过的条目照样能答题。
  await typeIn(qids.updated, '更新后照样答一句');
  await clickIn(qids.updated, '[data-action="answer"]');
  await waitFor(() => control.answerRequests.some((item) => item.body?.qid === qids.updated), '更新过的条目答题请求没发出去');
  await waitFor(async () => (await viewState()).list.count === 1 && !(await viewState()).items.some((item) => item.id === qids.updated), '更新过的条目答完后没有从未答消失');
  check('更新过的条目照样能答题（答题流程不变；未答数跟着降）',
    (await viewState()).list.count === 1 && (await viewState()).questionTab.text === '问题 1',
    JSON.stringify({ count: (await viewState()).list.count, tab: (await viewState()).questionTab.text }));
  // ④ 更新过的条目照样能关闭（带原因、留痕）。
  await clickIn(qids.updated2, '[data-action="close"]');
  await ui.frames(2);
  await typeCloseReason('更新过的条目照样关');
  await clickIn(qids.updated2, '[data-action="close-confirm"]');
  await waitFor(() => control.closeRequests.some((item) => item.body?.qid === qids.updated2), '更新过的条目关闭请求没发出去');
  await waitFor(async () => (await viewState()).list.count === 0, '更新过的条目关完后没有从未答消失');
  await click('#questions-filter-answered');
  await waitFor(async () => (await viewState()).list.status === 'answered' && (await viewState()).items.some((item) => item.id === qids.updated2), '已答/已关页没有更新过的条目');
  const updatedClosed = (await viewState()).items.find((item) => item.id === qids.updated2);
  check('更新过的条目照样能关闭（留痕：已关 + 原因；题面仍是更新后那份）',
    /已关（不答） · 用户 · \d\d-\d\d \d\d:\d\d/.test(updatedClosed?.text ?? '')
    && /原因：更新过的条目照样关/.test(updatedClosed?.text ?? '')
    && /更新后的第二条（用来验关闭）/.test(updatedClosed?.text ?? '')
    && !updatedClosed.text.includes('更新前的第二条'),
    JSON.stringify(updatedClosed?.text));
  const updatedAnsweredSide = (await ui.evaluate(`document.querySelector('[data-question-id="${qids.updated}"] .question-trail')?.textContent ?? null`));
  check('更新过又答了的条目：留痕行还在（已答），更新那条题面没被答题流程改写',
    /已答/.test(updatedAnsweredSide ?? ''),
    JSON.stringify(updatedAnsweredSide));
  await click('#questions-filter-open');
  await openSession(ids.a);

  // ── 16. 不变量：26px / 3px 槽 / token 色 / 禁阴影渐变 / 左栏两条滚动轴不受影响 ──
  await openSession(ids.a);
  await click('#view-tab-session');
  await waitView('session', '会话页没打开');
  // 左栏两条滚动轴：先把存档箱展开、两边都滚开（否则 scrollTop 永远是 0，断言等于没量），
  // 再切页、切回来逐字对比。
  await click('.attic-toggle');
  await waitFor(() => ui.evaluate(`document.querySelector('[data-attic-list="true"]') !== null`), '存档箱没有展开');
  await ui.evaluate(`(() => { document.querySelector('[data-active-tree-list="true"]').scrollTop = 140; document.querySelector('[data-attic-list="true"]').scrollTop = 70; })()`);
  await ui.frames(2);
  const treeAxis = () => ui.evaluate(`(() => { const aside=document.querySelector('aside.tree'); const active=document.querySelector('[data-active-tree-list="true"]'); const attic=document.querySelector('[data-attic-list="true"]'); return {asideScrollHeight:aside.scrollHeight, asideClientHeight:aside.clientHeight, activeOverflow:active?getComputedStyle(active).overflowY:null, activeTop:active?.scrollTop ?? null, activeScrollHeight:active?.scrollHeight ?? null, activeClientHeight:active?.clientHeight ?? null, atticOverflow:attic?getComputedStyle(attic).overflowY:null, atticTop:attic?.scrollTop ?? null, atticScrollHeight:attic?.scrollHeight ?? null, atticClientHeight:attic?.clientHeight ?? null}; })()`);
  const treeBefore = await treeAxis();
  check('（前置）左栏两条滚动轴都真的溢出了、也都真滚开了',
    treeBefore.activeScrollHeight > treeBefore.activeClientHeight + 40
    && treeBefore.atticScrollHeight > treeBefore.atticClientHeight + 20
    && treeBefore.activeTop === 140 && treeBefore.atticTop === 70,
    JSON.stringify(treeBefore));
  await click('#view-tab-questions');
  await waitView('questions', '问题页没打开');
  await controlGet(`/control/ask?id=${qids.options2}&text=${encodeURIComponent('不变量这一节要用的那一条')}&options=${encodeURIComponent('甲,乙')}`);
  await ui.emit('session.question', { id: qids.options2 });
  await waitFor(async () => (await viewState()).items.some((item) => item.id === qids.options2), '不变量用的问题条目没进列表');
  const invariant = await ui.evaluate(`(() => {
    const box=(selector)=>{ const node=document.querySelector(selector); if(!node) return null; const style=getComputedStyle(node); const rect=node.getBoundingClientRect(); return {selector, width:style.borderLeftWidth, style:style.borderLeftStyle, color:style.borderLeftColor, height:rect.height}; };
    const rows=[
      {selector:'#view-tab-session', row:true}, {selector:'#view-tab-questions', row:true},
      {selector:'#questions-filter-open', row:true}, {selector:'#questions-filter-answered', row:true}, {selector:'#questions-refresh', row:true},
      {selector:'.question-item', row:false},
      {selector:'[data-question-id="${qids.options2}"] .question-options button', row:true},
      {selector:'[data-question-id="${qids.options2}"] [data-action="answer"]', row:true},
      {selector:'[data-question-id="${qids.options2}"] [data-action="close"]', row:true},
      {selector:'[data-question-id="${qids.options2}"] [data-field="answer"]', row:true},
    ].map((entry)=>({...entry, ...(box(entry.selector) ?? {missing:true})}));
    const probe=document.createElement('i'); document.body.append(probe);
    const palette=[]; for (const name of ['--slot-idle','--slot-working','--slot-unread','--slot-dark','--slot-user','--slot-assistant','--slot-pending','--slot-success','--slot-error','--slot-warning','--slot-extra']) { probe.style.color='var('+name+')'; palette.push(getComputedStyle(probe).color); }
    probe.remove();
    const tree=()=>{ const aside=document.querySelector('aside.tree'); return {asideScrollHeight:aside.scrollHeight}; };
    return {
      rows,
      toolbarHeight: document.querySelector('#questions-toolbar').getBoundingClientRect().height,
      palette: [...new Set(palette)],
      forbidden: {
        gradients: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).backgroundImage!=='none').length,
        shadows: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).boxShadow!=='none').length,
        slowTransitions: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).transitionDuration.split(',').some((value)=>parseFloat(value)>0.15)).length,
      },
    };
  })()`);
  const missing = invariant.rows.filter((row) => row.missing);
  check('问题页与切换器的行都是 26px 单行（工具栏 26px；候选/答/关闭/输入框都 26px）',
    missing.length === 0
    && Math.abs(invariant.toolbarHeight - 26) <= 0.5
    && invariant.rows.filter((row) => row.row).every((row) => Math.abs(row.height - 26) <= 0.5),
    JSON.stringify({ missing: missing.map((row) => row.selector), toolbar: invariant.toolbarHeight, rows: invariant.rows.map((row) => ({ s: row.selector, h: row.height, isRow: row.row })) }));
  check('新增视觉要素都有最左 3px 槽，且颜色只用既有 token',
    invariant.rows.every((row) => row.width === '3px' && row.style === 'solid' && invariant.palette.includes(row.color)),
    JSON.stringify(invariant.rows.map((row) => ({ s: row.selector, w: row.width, c: row.color }))));
  check('没有新增阴影/渐变/慢过渡（v2.2 既有硬规矩）', invariant.forbidden.gradients === 0 && invariant.forbidden.shadows === 0 && invariant.forbidden.slowTransitions === 0, JSON.stringify(invariant.forbidden));
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');
  const treeAfter = await treeAxis();
  check('切页不影响左栏两条滚动轴（几何、滚动位置、overflow 逐字不变）',
    JSON.stringify(treeAfter) === JSON.stringify(treeBefore)
    && treeAfter.activeTop === 140 && treeAfter.atticTop === 70
    && Math.abs(treeAfter.asideScrollHeight - treeAfter.asideClientHeight) <= 1,
    JSON.stringify({ before: treeBefore, after: treeAfter }));

  // ── 16.5 followUp 那条**真话**也要能在页面上说出来（不是只有 steer 一种）──────────────
  // 何时会走到 followUp：会话**忙但没有活跃回合**（只剩准入窗口）——服务端如实退成排队、并如实报
  // `mode:'followUp'`。前端必须能把这条真话原样显示（与 steer 那条**不是**同一句话，且都不许编）。
  await click('#view-tab-questions');
  await waitView('questions', '切回问题页没成功');
  await click('#questions-filter-open');
  await controlGet(`/control/ask?id=${QID_FOLLOWUP}&text=${encodeURIComponent('准入窗口里的那条')}`);
  await ui.emit('session.question', { id: QID_FOLLOWUP });
  await waitFor(async () => (await viewState()).items.some((item) => item.id === QID_FOLLOWUP), 'followUp 臂的前置条目没进列表');
  await controlGet('/control/delivery?mode=followUp&shape=both');
  const noticeBeforeFollowUp = (await viewState()).notice;
  await typeIn(QID_FOLLOWUP, '准入窗口里的回答');
  await clickIn(QID_FOLLOWUP, '[data-action="answer"]');
  await waitFor(() => control.answerRequests.length === 8, 'followUp 臂的回执没发出去');
  const followUpNotice = await noticeAfterChange(noticeBeforeFollowUp, 'followUp 臂的回执没落进问题页 notice 行');
  check('回执 mode=followUp（忙但无活跃回合）⇒ 如实说「已排队」，且绝不谎报成插话注入当前这一轮',
    /已排队/.test(followUpNotice) && !/会影响这一轮/.test(followUpNotice) && !/注入当前这一轮/.test(followUpNotice),
    JSON.stringify({ notice: followUpNotice, previousNotice: noticeBeforeFollowUp }));
  await click('#view-tab-session');
  await waitView('session', '切回会话页没成功');

  // ── 17. 反证臂（总账）+ 页面自身没有未捕获异常 / console.error ───────────────────
  // 契约的两条写必须**始终**是一层路径 `/sessions/{id}/questions` + body 里的 op；
  // 假 API 对任何嵌套路径（`…/questions/{qid}/answer|close`）一律 404 并记一笔。
  // 将来谁改回嵌套路径，这两条会立刻红（而不是像本次真机那样到端到端才发现）。
  const ledger = await controlGet('/control/state');
  const writePaths = [...new Set([...ledger.answers, ...ledger.closes].map((item) => item.path))];
  check('反证臂：整轮里前端没有请求过任何嵌套路径（嵌套路径在这份契里不存在，假 API 一律 404）',
    ledger.nestedRequests.length === 0
    && writePaths.length === 2
    && writePaths.every((path) => /^\/api\/sessions\/[^/]+\/questions$/.test(path)),
    JSON.stringify({ nestedRequests: ledger.nestedRequests, writePaths }));
  // 证明这道臂**不是空的**：自己去打一发嵌套路径（真宿主/worker 里那条路由不存在 ⇒ 404），
  // 它必须被记下来 —— 于是「前端改回嵌套路径」会变成一条硬红，而不是静默通过。
  const nestedProbe = await fetch(`http://127.0.0.1:${ui.port}/api/sessions/${ids.a}/questions/${qids.plain}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '探针：这条请求本来就不该存在' }),
  });
  const afterProbe = await controlGet('/control/state');
  check('反证臂不是空的：探针往嵌套路径打一发 ⇒ 404 且被记帐（这条臂真的能抓住回退）',
    nestedProbe.status === 404 && afterProbe.nestedRequests.length === 1 && afterProbe.nestedRequests[0].path === `/api/sessions/${ids.a}/questions/${qids.plain}/answer`,
    JSON.stringify({ status: nestedProbe.status, nested: afterProbe.nestedRequests }));
  // 笔数对账（故意写死，改动路径时会提醒你回头看）：
  //   answer = §4 输入框答、§5 候选按钮答 + 回执形状臂、§8 受控 500、§8 重试成功、§9.5 受控 409、§15.7 C 会话更新后答、§16.5 followUp 臂 → 8
  //   close  = §6 关闭成功、§15.7 C 会话更新后关 → 2（§9 网络断那条在假服务端**没记账**就被 destroy 了：它不算一笔写）
  check('反证臂：每一笔写都带 body 里的 op（answer/close）与 qid（笔数与断言过的次数对得上）',
    ledger.answers.length === 8 && ledger.closes.length === 2
    && ledger.answers.every((item) => item.body?.op === 'answer' && typeof item.body?.qid === 'string' && typeof item.body?.text === 'string')
    && ledger.closes.every((item) => item.body?.op === 'close' && typeof item.body?.qid === 'string' && typeof item.body?.reason === 'string'),
    JSON.stringify({ answers: ledger.answers.length, closes: ledger.closes.length }));
  check('反证臂：读只用了 open / answered 两个 status（没有拿 all 在客户端凑）',
    [...new Set(ledger.questionRequests)].every((status) => status === 'open' || status === 'answered')
    && ledger.questionRequests.includes('answered'),
    JSON.stringify([...new Set(ledger.questionRequests)]));
  const newProblems = ui.pageProblems.slice(problemsAtStart);
  const unexpected = newProblems.filter((text) => !/Failed to fetch|net::ERR|TypeError: Failed to fetch/i.test(text));
  check('页面没有未捕获异常或 console.error（网络断那条只留 `Failed to fetch`）', unexpected.length === 0, JSON.stringify({ all: newProblems, unexpected }));

  print('answer requests', control.answerRequests);
  print('close requests', control.closeRequests);
  print('seen posts', control.seenPosts);
  print('screenshots', { session: screenshotSession, questionsOpen: screenshotOpen, questionsAnswered: screenshotAnswered });
  print('RESULT', `manager toolkit P1 web questions view PASS (${checks} checks)`);
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`\n✗ FAIL: ${error?.stack || error}\n`);
} finally {
  try { await ui?.close(); } catch (error) { process.stdout.write(`cleanup: ${error}\n`); }
}
