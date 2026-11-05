#!/usr/bin/env node
// `#debug-pane`（右栏第四个页签「调试」）的门：页签同级 + 切页只留它 + 假数据下关键字段都画出来 +
// **字段缺失/端点缺失时如实写「这一项取不到」** + 两个视口无横向溢出、不逐字折断。
//
// 契约（本单《右栏加一个「调试」页签》）：
//   · 页签在 `#view-tabs`（role=tablist）里与 会话/问题/标注 **同级**，样式沿用 `#view-tabs button`（26px 单行）；
//   · 面板 `#debug-pane` 与 `#questions-pane` / `#annotations-pane` **同形**（toolbar 26px + 列表自己滚 + notice 行）；
//   · 数据两个来源：① A 的 `GET /debug/instances`（页上经 `/api` 反代）；② B 自己的 `GET /app-host`（**同源**、不走 /api）；
//   · 它是**全局**页（跨会话）⇒ 页签始终可用（同「标注」），不随选没选中会话置灰；
//   · 本页**只做界面**，不加任何 agent 工具，也不写任何东西（只读）。
//
// 假响应形状（本门自己约定的，写在下方 `DEBUG_PAYLOAD` / `APP_HOST_PAYLOAD`；真实端点端到端核在合并前由总台做）：
//   GET /api/debug/instances → { at, endpoint, readOnly,
//     worker:{ pid, generationId, logicVersion, codeRevision, uptimeSeconds, memory:{rss,heapTotal,heapUsed,external,arrayBuffers} },
//     pool:{ scope, summary:{hot,cold,active,pinned,draining,maxHot,...}, sessions:[{sessionId,runtimeState,durable,idleForMs,
//       evictionEligible,acquiredLeases,pendingMessages,queuedOperations,pinReasons,blockers,sessionFileBytes,...}], sessionFields, sessionsSource },
//     policy:{ heapLimitBytes, watermarks:{heapHighBytes,heapLowBytes,rssHighBytes,rssLowBytes}, pressure, admission:{formula,singleFileBudgetBytes}, rejections, lastAction },
//     host:{ generationId, currentGenerationId, draining, drain, worker, hotSessions, hostMemory, sessionsRoot, pool },
//     tools:{ counts:{registered,active}, active:[name], registered:[{name,active,source,path,group,groupSource,description,descriptionHead,hasParameters,parameterNames,parameters,parameterDetails:[{name,type,required,description}]}], groups:[{name,groupSource,toolCount,tools:[name]}], groupsUnavailableReason, groupTable:{declaredIn,groupSourceValues,groups,duplicateToolNames,declaredButNotRegistered,registeredButNotDeclared}, mismatches },
//     unavailable:[{field,reason,where}] }
//   GET /app-host → { pid, codeVersion, startedAt, upstream, webRoot }
//
// 红半（确定性，本门自己跑）：把 `web/` 拷进临时目录做三份**单点**变异，再以子进程重跑本门，断了必须红：
//   ① 撤掉 `#view-tab-debug` 页签；② 把分组那一行的键前缀（`DEBUG_GROUP_ROW_PREFIX`）改成空串（分组看不见了）；
//   ③ 把「这一项取不到」那条渲染改成空串。三份都要 `exit != 0` 且报出对应断言名。
//   用法：CHROME_BIN=/usr/bin/chromium node test/debug-pane-ui.mjs
//         SOPHO_DEBUG_UI_WEB=<另一份 web/>  —— 只给红半的子进程用（父进程用它跑变异体）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sendJson, waitFor } from './ui-harness.mjs';
import { removeSandbox } from './harness.mjs';

const HERE = fileURLToPath(import.meta.url);
const WEB_ROOT = path.resolve(path.dirname(HERE), '..', 'web');
const ARTIFACTS = path.join(os.tmpdir(), 'sopho-debug-pane');
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';
const MISSING_TOKEN = '这一项取不到';
// 逐字折断臂用的那一个词：它出现在 `.debug-title`（工具名）与 `.debug-value`（描述/路径）里。
// 2026-09-26：`spawn` 并入 `session_new` ⇒ 夹具里的样例工具名也跟着换成 `session_new`。
const WORD = 'session_new';
const SESSIONS_ROOT = `/sandbox/${'deep-'.repeat(10)}${WORD}-leaf/sessions`;

const CHECKS = [];
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  CHECKS.push(name);
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// ── 约定的假响应（形状见文件头注释）───────────────────────────────────────────────────
const DEBUG_PAYLOAD = () => ({
  at: '2026-09-25T08:00:00.000Z',
  endpoint: 'GET /debug/instances',
  readOnly: true,
  worker: {
    pid: 4242,
    generationId: 'gen-4f2a-9c1b',
    logicVersion: 'logic-2026-09-25T07:00:00.000Z',
    codeRevision: { revision: 'f7ab4a7', dirty: false },
    uptimeSeconds: 321.5,
    memory: { rss: 268435456, heapTotal: 134217728, heapUsed: 99999999, external: 12345678, arrayBuffers: 7654321 },
    memorySource: 'process.memoryUsage() of the generation worker that serves this endpoint',
  },
  pool: {
    scope: `only this generation worker's own pool; other live generations hold their own pools (${WORD})`,
    summary: { hot: 2, cold: 1, active: 1, pinned: 1, loading: 0, draining: false, maxHot: 8, idleTTL: 300000, counters: { acquire: 3, restore: 1, evict: { ttl: 0, stale_generation: 0, memory: 0 }, disposeFailures: 0, lastDisposeError: null } },
    sessions: [
      {
        sessionId: SESSION_A, runtimeState: 'hot', durable: true, running: false, runningNow: false, acquiredLeases: 0,
        pendingMessages: 0, queuedOperations: 0, busyFlags: [], pinReasons: [], idleForMs: 1234, generationId: 'gen-4f2a-9c1b',
        sessionFileBytes: 54321, evictionEligible: true, blockers: [],
      },
      {
        sessionId: SESSION_B, runtimeState: 'hotActive', durable: true, running: true, runningNow: true, acquiredLeases: 1,
        pendingMessages: 2, queuedOperations: 1, busyFlags: ['turn'], pinReasons: ['sse_subscriber'], idleForMs: 987654, generationId: 'gen-4f2a-9c1b',
        sessionFileBytes: 9876543, evictionEligible: false, blockers: ['running_turn'],
      },
      // ⚠️ 缺字段臂：这一条**故意**缺 idleForMs / evictionEligible ⇒ 页上那两行必须是「这一项取不到」。
      { sessionId: SESSION_C, runtimeState: 'cold', durable: false },
    ],
    sessionFields: ['sessionId', 'runtimeState', 'durable', 'running', 'runningNow', 'acquiredLeases', 'pendingMessages', 'queuedOperations', 'busyFlags', 'pinReasons', 'idleForMs', 'generationId', 'sessionFileBytes', 'evictionEligible', 'blockers'],
    sessionsSource: 'pool.drainBlockers() — same read-only facts the reclaim/drain path uses',
  },
  policy: {
    heapLimitBytes: 1073741824,
    watermarks: { heapHighBytes: 805306368, heapLowBytes: 536870912, rssHighBytes: 1610612736, rssLowBytes: 1073741824, reserveBytes: 67108864, sessionMultiplier: 1.5 },
    pressure: { rss: 268435456, heapTotal: 134217728, heapUsed: 99999999, external: 12345678, arrayBuffers: 7654321, pressure: 'normal', episode: 0, aboveHigh: false, belowLow: true, reclaimedEpisode: 0 },
    admission: { formula: 'predictedPeakBytes = sessionFileBytes * sessionMultiplier + reserveBytes', singleFileBudgetBytes: 805306368, implementedIn: 'server/base-logic.mjs admitSession' },
    rejections: 0,
    lastAction: null,
  },
  host: {
    generationId: 'gen-4f2a-9c1b',
    codeRevision: { revision: 'f7ab4a7', dirty: false },
    currentGenerationId: 'gen-4f2a-9c1b',
    draining: false,
    drain: { draining: false, busy: [], blockers: [] },
    worker: { pid: 4242, generationId: 'gen-4f2a-9c1b', logicVersion: 'logic-2026-09-25T07:00:00.000Z', codeRevision: { revision: 'f7ab4a7', dirty: false }, rssBytes: 268435456, heapUsedBytes: 99999999, heapTotalBytes: 134217728, externalBytes: 12345678, arrayBuffersBytes: 7654321, hot: 2, active: 1, draining: false },
    hotSessions: [
      { sessionId: SESSION_A, generationId: 'gen-4f2a-9c1b', runtimeState: 'hot', durable: true, pinReasons: [], acquiredLeases: 0, owner: { generationId: 'gen-4f2a-9c1b', workerPid: 4242, runtimeId: 'rt-fixture-a', token: 'tok-fixture-a' } },
      { sessionId: SESSION_B, generationId: 'gen-4f2a-9c1b', runtimeState: 'hot', durable: true, pinReasons: ['sse_subscriber'], acquiredLeases: 1, owner: { generationId: 'gen-4f2a-9c1b', workerPid: 4242, runtimeId: 'rt-fixture-b', token: 'tok-fixture-b' } },
    ],
    hostMemory: { rss: 268435456, heapTotal: 134217728, heapUsed: 99999999, external: 12345678, arrayBuffers: 7654321 },
    sessionsRoot: SESSIONS_ROOT,
    memoryPolicy: { heapLimitBytes: 1073741824, cpu: { userMs: 11.5, systemMs: 4.25, totalMs: 15.75, note: 'cumulative for this worker process since start' }, caches: { hot: 2 }, rejections: 0, lastAction: null },
    pool: { hot: 2, cold: 1, active: 1, pinned: 1 },
  },
  tools: {
    source: 'GET /debug/instances → tools（由插件上报）',
    scope: `this generation worker's own pool only; only HOT (live) runtimes are covered (${WORD})`,
    liveSessionCount: 2,
    observedOn: 'gen-4f2a-9c1b',
    registered: [
      { name: 'bash', source: 'builtin', path: '<builtin:bash>', group: '内置工具组', groupSource: 'builtin-table', hasParameters: true, parameterNames: ['command'],
        description: 'Run a shell command in the current working directory and return stdout/stderr. Output is truncated.',
        descriptionHead: 'Run a shell command in the current working directory…',
        parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'Shell command to execute' } } },
        parameterDetails: [{ name: 'command', type: 'string', required: true, description: 'Shell command to execute' }] },
      // ⚠️ 缺字段臂：这一条**故意**缺 description / parameters / parameterDetails / parameterNames
      // ⇒ 页上那几行都必须是「这一项取不到」。
      { name: 'read', source: 'builtin', path: '<builtin:read>', group: '内置工具组', groupSource: 'builtin-table', hasParameters: true, descriptionHead: 'Read a file from disk' },
      { name: WORD, source: 'cli', path: `/ext/${WORD}/index.ts`, group: '树形会话组', groupSource: 'declared', hasParameters: true, parameterNames: ['task', 'notify'],
        description: `Create a child session (optionally delegating a task) with workspace-conflict protection.`,
        descriptionHead: `Create a child session (optionally delegating a task)…`,
        parameters: { type: 'object', required: [], properties: { task: { type: 'string', description: "Task to send as the child's first user message" }, notify: { type: 'boolean' } } },
        parameterDetails: [
          // task 现在是**可选**的（省略 ⇒ 只建会话、不起回合）⇒ required = 否。
          { name: 'task', type: 'string', required: false, description: "Task to send as the child's first user message" },
          // 缺字段臂（本门自造）：真实的 `session_new.notify` 有说明；这里故意抹成 null，逼出 UI 的
          // 「这一项取不到」（真实端点确实可能给出 null —— 参数 schema 不带 description 时）。
          { name: 'notify', type: 'boolean', required: false, description: null },
        ] },
    ],
    registeredCount: 3,
    registeredUnavailableReason: null,
    // 分组（业主 2026-09-26 那条要求）：服务端的**分组视图**（组名 + 该组工具）＋ 那份声明表的静态事实。
    // 形状取自真端点（`server/base-logic.mjs` 的 toolGroupsView / toolGroupTableReport）。
    groups: [
      { name: '内置工具组', groupSource: 'builtin-table', toolCount: 2, tools: ['bash', 'read'] },
      { name: '树形会话组', groupSource: 'declared', toolCount: 1, tools: [WORD] },
    ],
    groupsUnavailableReason: null,
    groupTable: {
      declaredIn: 'server/base-logic.mjs TOOL_GROUP_TABLE (single source of truth; pi itself has no group concept, so this repo declares the groups explicitly). Takes effect on POST /reload-code because a new generation worker re-imports this file.',
      groupSourceValues: {
        declared: 'the tool name is listed in TOOL_GROUP_TABLE under a group this repo declares (the plugin tools)',
        'builtin-table': "the tool name is listed in TOOL_GROUP_TABLE's builtin group (pi's own built-in tools, matched by name)",
        unclassified: 'the tool is in neither table ⇒ it lands in the explicit group 未分组（没进声明表）; that is a registration gap the gates fail on, never a catch-all bucket',
      },
      groups: [
        { name: '内置工具组', groupSource: 'builtin-table', tools: ['bash', 'read'] },
        { name: '树形会话组', groupSource: 'declared', tools: [WORD] },
      ],
      duplicateToolNames: [],
      declaredButNotRegistered: [],
      registeredButNotDeclared: [],
    },
    identicalRegisteredAcrossLiveSessions: true,
    activeBySession: [
      { sessionId: SESSION_A, activeCount: 2, active: ['bash', WORD] },
      { sessionId: SESSION_B, activeCount: 1, active: ['read'] },
    ],
    unreadableLiveSessions: [],
    unavailable: [],
  },
  unavailable: [
    { field: 'hostProcess', reason: 'the A host (server/base.mjs) is a separate process; its pid/memory are not visible from inside a worker', where: 'GET /host on the A host' },
    { field: 'appProcess', reason: 'B (server/app.mjs) is not reachable from this worker', where: 'GET /app-host on B' },
    { field: 'otherGenerations', reason: 'this response only covers the pool of the worker that served it', where: 'GET /host -> workers[]' },
  ],
});
const APP_HOST_PAYLOAD = () => ({
  pid: 9090,
  codeVersion: 'app-2026-09-25T06:00:00.000Z',
  startedAt: '2026-09-25T06:00:00.000Z',
  upstream: 'http://127.0.0.1:7331',
  webRoot: '/repo/web',
});

const treePayload = () => ({
  sessions: [
    { id: SESSION_A, name: 'Debug fixture A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, notify: { notifies: [], waitingFor: [] } },
    { id: SESSION_B, name: 'Debug fixture B', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, notify: { notifies: [], waitingFor: [] } },
    { id: SESSION_C, name: 'Debug fixture C', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, notify: { notifies: [], waitingFor: [] } },
  ],
  unread: { count: 0 },
});

// ── 控制面 ────────────────────────────────────────────────────────────────────────────
const control = { mode: 'ok', endpointRequests: 0, appHostRequests: 0 };

async function openUi(webRoot) {
  return boot({
    width: 1200,
    height: 760,
    ...(webRoot ? { webRoot } : {}),
    routes: async (request, response, url) => {
      const p = url.pathname;
      if (p === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (p === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (p === '/api/tree') return sendJson(response, 200, treePayload()), true;
      if (p === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
        return true;
      }
      if (p === '/control/mode') {
        control.mode = url.searchParams.get('mode') || 'ok';
        return sendJson(response, 200, { mode: control.mode }), true;
      }
      if (p === '/control/state') {
        return sendJson(response, 200, { mode: control.mode, endpointRequests: control.endpointRequests, appHostRequests: control.appHostRequests }), true;
      }
      // ① A 的实例端点（页上经 /api 反代）
      if (p === '/api/debug/instances') {
        control.endpointRequests += 1;
        if (control.mode === 'endpoint404') return sendJson(response, 404, { error: 'unknown_route', message: 'no such route' }), true;
        const payload = DEBUG_PAYLOAD();
        // 「没有热 runtime」那一档：`registered` 是 `null` ＋ 原因 ＋ 在 `tools.unavailable[]` 里点名 ——
        // 这是真实端点的口径（不吐空清单假装没有）。
        if (control.mode === 'noregistered') {
          payload.tools = {
            source: 'GET /debug/instances → tools（由插件上报）',
            scope: "this generation worker's own pool only; only HOT (live) runtimes are covered",
            liveSessionCount: 0,
            observedOn: null,
            registered: null,
            registeredCount: null,
            registeredUnavailableReason: 'no live runtime in this generation pool; the tool set is a per-runtime fact',
            groups: null,
            groupsUnavailableReason: 'the group view is derived from the registered tool list, which is only readable off a live pi session (see registeredUnavailableReason)',
            // 声明表那块是**静态**事实（不依赖 runtime）⇒ 没有热 runtime 时它照样在，只是两个差集是 null。
            groupTable: { ...DEBUG_PAYLOAD().tools.groupTable, declaredButNotRegistered: null, registeredButNotDeclared: null },
            identicalRegisteredAcrossLiveSessions: null,
            activeBySession: [],
            unreadableLiveSessions: [],
            unavailable: [{ field: 'registered', reason: 'no live runtime in this generation pool; the tool set is a per-runtime fact', where: 'open a session so a runtime becomes hot, then read again' }],
          };
        }
        return sendJson(response, 200, payload), true;
      }
      // ② B 自己的本机事实（**同源**、不经 /api）
      if (p === '/app-host') {
        control.appHostRequests += 1;
        if (control.mode === 'hostfail') return sendJson(response, 404, { error: 'not found' }), true;
        return sendJson(response, 200, APP_HOST_PAYLOAD()), true;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|commands|draft|seen|models|archive))?$/.exec(p);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        if (action === 'messages') return sendJson(response, 200, { messages: [{ role: 'user', text: '调试页夹具' }], extras: [], compaction: { atIndex: null }, observability: null }), true;
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'draft') return sendJson(response, 200, { text: '' }), true;
        if (action === 'models') return sendJson(response, 200, { current: null, models: [], source: 'unavailable' }), true;
        if (action === 'seen') return sendJson(response, 200, { ok: true }), true;
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
          return true;
        }
        if (action === null) return sendJson(response, 200, { name: `debug ${id.slice(0, 8)}`, cwd: '/sandbox', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
      }
      return false;
    },
  });
}

// ── 页面里的读数 ──────────────────────────────────────────────────────────────────────
const PANE_STATE = `(() => {
  const main=document.querySelector('main');
  const tabs=document.querySelector('#view-tabs');
  const rect=(selector)=>{ const node=document.querySelector(selector); if(!node) return null; const box=node.getBoundingClientRect(); return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}; };
  const tab=(id)=>{ const node=document.getElementById(id); if(!node) return {missing:true}; return { id, text:node.textContent, role:node.getAttribute('role'), selected:node.getAttribute('aria-selected'), disabled:node.disabled, controls:node.getAttribute('aria-controls') }; };
  const list=document.querySelector('#debug-list');
  const notice=document.querySelector('#debug-notice');
  const items=Array.from(document.querySelectorAll('#debug-list .debug-item'));
  const rowOf=(item)=>({ key: item.querySelector('.debug-key')?.textContent ?? null, value: item.querySelector('.debug-value')?.textContent ?? null, missing: item.querySelector('.debug-value')?.dataset.missing === 'true' });
  return {
    view: main.dataset.view ?? null,
    tabsExist: tabs !== null,
    tabIds: tabs ? Array.from(tabs.children).map((node)=>node.id) : null,
    tabs: ['view-tab-session','view-tab-questions','view-tab-annotations','view-tab-debug'].map(tab),
    tabCount: tabs ? tabs.children.length : null,
    panes: {
      questions: document.querySelector('#questions-pane').hidden,
      annotations: document.querySelector('#annotations-pane').hidden,
      debug: document.querySelector('#debug-pane').hidden,
    },
    messagesPane: { visibility: getComputedStyle(document.querySelector('.messages-pane')).visibility },
    composer: { display: getComputedStyle(document.querySelector('#composer')).display },
    queue: { display: getComputedStyle(document.querySelector('#queue-status')).display, hidden: document.querySelector('#queue-status').hidden },
    list: {
      load: list.dataset.load,
      itemCount: items.length,
      rows: Array.from(document.querySelectorAll('#debug-list .debug-row')).map(rowOf),
      missingCount: document.querySelectorAll('#debug-list .debug-value[data-missing="true"]').length,
      titles: Array.from(document.querySelectorAll('#debug-list .debug-title')).map((node)=>node.textContent),
      text: list.textContent,
      sections: items.map((item)=>({ title: item.querySelector('.debug-title')?.textContent ?? null, source: item.querySelector('.debug-source')?.textContent ?? null, state: item.dataset.state ?? null, rows: Array.from(item.querySelectorAll('.debug-row')).map(rowOf) })),
    },
    notice: { text: notice.textContent, level: notice.dataset.level },
    geometry: { main: rect('main'), pane: rect('#debug-pane'), messagesPane: rect('.messages-pane'), list: rect('#debug-list'), toolbar: rect('#debug-toolbar') },
    scroll: { docScrollWidth: document.documentElement.scrollWidth, docClientWidth: document.documentElement.clientWidth, bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth, listScrollWidth: list.scrollWidth, listClientWidth: list.clientWidth },
  };
})()`;

// 「逐字折断」的尺子（与 test/text-wrap.mjs / test/wrap-sweep.mjs 同口径）：一个词只应产生 1 个 rect。
const WORD_RECTS = (word) => `(() => {
  const WORD=${JSON.stringify(word)};
  const out=[];
  const root=document.querySelector('#debug-list');
  const walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node=walker.nextNode())) {
    const pattern=new RegExp(WORD,'g'); let match;
    while ((match=pattern.exec(node.data))) {
      const before=match.index>0?node.data[match.index-1]:' ';
      const after=match.index+WORD.length<node.data.length?node.data[match.index+WORD.length]:' ';
      if (/[A-Za-z0-9_]/.test(before)||/[A-Za-z0-9_]/.test(after)) continue;
      const range=document.createRange();
      range.setStart(node,match.index); range.setEnd(node,match.index+WORD.length);
      const raw=Array.from(range.getClientRects()).map((rect)=>({x:+rect.x.toFixed(1),y:+rect.y.toFixed(1),w:+rect.width.toFixed(1)}));
      const rects=[]; for (const rect of raw) if (!rects.some((other)=>other.x===rect.x&&other.y===rect.y&&other.w===rect.w)) rects.push(rect);
      const el=node.parentElement;
      const probe=document.createElement('span'); probe.style.cssText='position:absolute;left:-10000px;top:0;white-space:pre;'; const style=getComputedStyle(el); probe.style.font=style.font; probe.textContent=WORD; document.body.append(probe); const wordWidth=+probe.getBoundingClientRect().width.toFixed(2); probe.remove();
      const parent=el.clientWidth;
      out.push({ rectCount:rects.length, baselines:new Set(raw.map((rect)=>Math.round(rect.y))).size, width: rects[0]?.w ?? 0, wordWidth, carrierWidth: parent, visible: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden', here: node.data.slice(Math.max(0,match.index-14),match.index+WORD.length+14) });
    }
  }
  return out;
})()`;

const sectionOf = (state, title) => state.list.sections.find((section) => section.title === title) ?? null;
const rowOf = (state, title, key) => (sectionOf(state, title)?.rows ?? []).find((row) => row.key === key) ?? null;

async function main() {
  const webRoot = process.env.SOPHO_DEBUG_UI_WEB ? path.resolve(process.env.SOPHO_DEBUG_UI_WEB) : null;
  let ui = null;
  const cleanupProblems = [];
  try {
    ui = await openUi(webRoot);
    const problemsAtStart = ui.pageProblems.length;
    const evaluate = (expression) => ui.evaluate(expression);
    const state = () => evaluate(PANE_STATE);
    const setMode = async (mode) => {
      const result = await fetch(`http://127.0.0.1:${ui.port}/control/mode?mode=${mode}`);
      assert.equal(result.ok, true, `setMode(${mode}) failed`);
      await result.json();
    };
    const controlState = () => fetch(`http://127.0.0.1:${ui.port}/control/state`).then((result) => result.json());
    const openSession = async (id) => {
      await evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
      await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), `session ${id} did not open`);
    };

    // ── 1. 四个页签同级、调试页签**始终可用**（全局页），默认仍在会话页 ────────────────────────
    // 先读页签（它们是 index.html 的静态结构）：这样「撤掉页签」的变异体会**恰好红在这一条**上，
    // 而不是先撞上「app.js 因为找不到节点而崩了 ⇒ 树没渲染」这种间接症状。
    const idle = await state();
    check('右栏四个页签同级（会话/问题/标注/调试，同在 #view-tabs 的 tablist 里），调试页签始终可用（全局页，同「标注」）',
      idle.tabsExist && idle.tabCount === 4
      && JSON.stringify(idle.tabIds) === JSON.stringify(['view-tab-session', 'view-tab-questions', 'view-tab-annotations', 'view-tab-debug'])
      && idle.tabs.every((tab) => !tab.missing && tab.role === 'tab')
      && idle.tabs[3].text === '调试' && idle.tabs[3].disabled === false && idle.tabs[3].controls === 'debug-pane'
      && idle.tabs[0].disabled === true && idle.tabs[1].disabled === true && idle.tabs[2].disabled === false
      && idle.view === 'session',
      JSON.stringify({ tabIds: idle.tabIds, tabs: idle.tabs, view: idle.view }));
    await waitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_A}"]') !== null`), 'tree did not render');

    // ── 2. 切到调试页：只有调试面板可见，底栏/排队条隐藏，正文只切 visibility ──────────────────
    check('（前置）切到调试页之前，`/app-host` 一次都没被读过（取证用）', (await controlState()).appHostRequests === 0, JSON.stringify(await controlState()));
    // 让 `#queue-status` 先可见（否则「隐藏」可能只是它本来就 hidden，量不出那条 CSS 规则）。
    await evaluate(`(() => { const queue=document.querySelector('#queue-status'); queue.hidden=false; queue.textContent='排了一条'; return true; })()`);
    await evaluate(`document.querySelector('#view-tab-debug').click()`);
    await waitFor(async () => {
      const value = await state();
      return value.view === 'debug' && value.panes.debug === false && value.list.load === 'ready';
    }, '调试页没有切出来');
    const opened = await state();
    check('切到调试页 ⇒ 只有 #debug-pane 可见（问题/标注面板都 hidden），#composer 与 #queue-status 被 CSS 隐掉，正文容器只切 visibility',
      opened.view === 'debug'
      && opened.panes.debug === false && opened.panes.questions === true && opened.panes.annotations === true
      && opened.composer.display === 'none' && opened.queue.display === 'none' && opened.queue.hidden === false
      && opened.messagesPane.visibility === 'hidden'
      && opened.tabs[3].selected === 'true' && opened.tabs[2].selected === 'false' && opened.tabs[0].selected === 'false',
      JSON.stringify({ panes: opened.panes, composer: opened.composer, queue: opened.queue, messagesPane: opened.messagesPane, tabs: opened.tabs }));
    check('调试面板顶掉右栏中段（与正文区同格：左/右/上边界逐字一致，不是并排挤在旁边），工具栏 26px 单行',
      Math.abs(opened.geometry.pane.left - opened.geometry.main.left) <= 1
      && Math.abs(opened.geometry.pane.right - opened.geometry.main.right) <= 1
      && Math.abs(opened.geometry.pane.left - opened.geometry.messagesPane.left) <= 1
      && Math.abs(opened.geometry.pane.right - opened.geometry.messagesPane.right) <= 1
      && Math.abs(opened.geometry.pane.top - opened.geometry.messagesPane.top) <= 1
      && Math.abs(opened.geometry.toolbar.height - 26) <= 0.5,
      JSON.stringify(opened.geometry));
    await mkdir(ARTIFACTS, { recursive: true });
    await ui.screenshot(path.join(ARTIFACTS, 'debug-1200x760.png'));

    // ── 3. 不变量：新增视觉要素都带最左 3px 槽、颜色只用既有 token、无新增阴影/渐变/慢过渡 ──
    const invariant = await evaluate(`(() => {
      const box=(selector)=>{ const node=document.querySelector(selector); if(!node) return {selector, missing:true}; const style=getComputedStyle(node); const rect=node.getBoundingClientRect(); return {selector, width:style.borderLeftWidth, style:style.borderLeftStyle, color:style.borderLeftColor, height:rect.height}; };
      const rows=['#view-tab-debug','#debug-scope','#debug-refresh','#debug-notice','.debug-item'].map(box);
      const probe=document.createElement('i'); document.body.append(probe);
      const palette=[]; for (const name of ['--slot-idle','--slot-warning','--slot-unread','--slot-dark','--slot-user','--slot-assistant','--slot-pending','--slot-success','--slot-error','--slot-extra','--slot-bash']) { probe.style.color='var('+name+')'; palette.push(getComputedStyle(probe).color); }
      probe.remove();
      return { rows, palette: [...new Set(palette)], toolbarHeight: document.querySelector('#debug-toolbar').getBoundingClientRect().height, forbidden: { gradients: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).backgroundImage!=='none').length, shadows: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).boxShadow!=='none').length, slowTransitions: Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).transitionDuration.split(',').some((value)=>parseFloat(value)>0.15)).length } };
    })()`);
    check('新增视觉要素都带最左 3px 槽、颜色只用既有 token（页签/数据源/刷新/notice/每一条 debug-item）',
      invariant.rows.every((row) => row.missing !== true && row.width === '3px' && row.style === 'solid' && invariant.palette.includes(row.color) && row.height > 0),
      JSON.stringify({ rows: invariant.rows, palette: invariant.palette }));
    check('没有新增阴影/渐变/慢过渡（v2.2 既有硬规矩；工具栏 26px 单行）',
      invariant.forbidden.gradients === 0 && invariant.forbidden.shadows === 0 && invariant.forbidden.slowTransitions === 0 && Math.abs(invariant.toolbarHeight - 26) <= 0.5,
      JSON.stringify({ forbidden: invariant.forbidden, toolbarHeight: invariant.toolbarHeight }));

    // ── 3. 假数据下关键字段都画出来了（A 的实例事实 + B 的本机事实）────────────────────────
    const text = opened.list.text;
    check('A 的实例事实画出来了：worker pid/generationId/内存 rss + 池 summary + 策略阈值 + 宿主事实（每一段都有来源）',
      rowOf(opened, '逻辑实例（worker）', 'pid')?.value === '4242'
      && rowOf(opened, '逻辑实例（worker）', 'generationId')?.value === 'gen-4f2a-9c1b'
      && rowOf(opened, '逻辑实例（worker）', 'memory.rss')?.value === '256.0 MB（268435456 B）'
      && rowOf(opened, '逻辑实例（worker）', 'uptimeSeconds')?.value === '321.5 s'
      && rowOf(opened, '池（按会话表）', 'summary.hot')?.value === '2'
      && rowOf(opened, '策略阈值（内存准入 / 压力）', 'watermarks.heapHighBytes')?.value === '768.0 MB（805306368 B）'
      && rowOf(opened, '宿主事实（这一代 worker 能看到的）', 'sessionsRoot')?.value === SESSIONS_ROOT
      && text.includes('逻辑实例（worker）') && text.includes('池（按会话表）') && text.includes('策略阈值') && text.includes('宿主事实'),
      JSON.stringify({
        pid: rowOf(opened, '逻辑实例（worker）', 'pid'),
        gen: rowOf(opened, '逻辑实例（worker）', 'generationId'),
        rss: rowOf(opened, '逻辑实例（worker）', 'memory.rss'),
        hot: rowOf(opened, '池（按会话表）', 'summary.hot'),
        heapHigh: rowOf(opened, '策略阈值（内存准入 / 压力）', 'watermarks.heapHighBytes'),
      }));
    check('池的**按会话表**逐条画出来了（每个会话一条：runtimeState/idleForMs/evictionEligible/blockers…）',
      opened.list.titles.includes(`会话 ${SESSION_A.slice(0, 8)}`)
      && opened.list.titles.includes(`会话 ${SESSION_B.slice(0, 8)}`)
      && opened.list.titles.includes(`会话 ${SESSION_C.slice(0, 8)}`)
      && text.includes('hotActive') && text.includes('running_turn') && text.includes('sse_subscriber'),
      JSON.stringify(opened.list.titles));
    check('池的 source/scope 也带出来了（口径出自服务端，不是前端猜的）',
      (sectionOf(opened, '池（按会话表）')?.source ?? '').includes('GET /debug/instances')
      && rowOf(opened, '池（按会话表）', 'scope')?.value.includes('only this generation worker'),
      JSON.stringify({ source: sectionOf(opened, '池（按会话表）')?.source, scope: rowOf(opened, '池（按会话表）', 'scope') }));
    check('暴露给 agent 的工具：真实形状的块级字段都画了（registeredCount / liveSessionCount / identical… / unreadable… / scope）',
      rowOf(opened, '暴露给 agent 的工具', 'registeredCount')?.value === '3'
      && rowOf(opened, '暴露给 agent 的工具', 'liveSessionCount')?.value === '2'
      && rowOf(opened, '暴露给 agent 的工具', 'identicalRegisteredAcrossLiveSessions')?.value === '是'
      && rowOf(opened, '暴露给 agent 的工具', 'unreadableLiveSessions')?.value === '无'
      && (rowOf(opened, '暴露给 agent 的工具', 'scope')?.value ?? '').includes('only HOT (live) runtimes')
      && rowOf(opened, '暴露给 agent 的工具', 'observedOn')?.value !== MISSING_TOKEN,
      JSON.stringify((sectionOf(opened, '暴露给 agent 的工具')?.rows ?? []).filter((row) => ['registeredCount', 'liveSessionCount', 'identicalRegisteredAcrossLiveSessions', 'unreadableLiveSessions', 'scope'].includes(row.key))));
    check('`active` 是**每会话**的：activeBySession[] 逐条一行（sessionId 片段 + activeCount + 工具名列）',
      rowOf(opened, '暴露给 agent 的工具', `会话 ${SESSION_A.slice(0, 8)}`)?.value === `2 个：bash · ${WORD}`
      && rowOf(opened, '暴露给 agent 的工具', `会话 ${SESSION_B.slice(0, 8)}`)?.value === '1 个：read'
      && rowOf(opened, '暴露给 agent 的工具', 'activeBySession')?.value === '2 个会话',
      JSON.stringify((sectionOf(opened, '暴露给 agent 的工具')?.rows ?? []).filter((row) => row.key.startsWith('会话 '))));
    check('`registered` 逐条画；插件 / 内建按**服务端声明的分组来源**分（`declared` / `builtin-table`），**不按 path 猜**（内建的 path 实测不是空串，是 `<builtin:bash>` 这种形状）',
      rowOf(opened, '暴露给 agent 的工具', '插件（分组来源 declared）')?.value === '1 条'
      && rowOf(opened, '暴露给 agent 的工具', '内建（分组来源 builtin-table）')?.value === '2 条'
      && rowOf(opened, '工具 bash', '类型（按分组来源）')?.value === '内建' && rowOf(opened, '工具 bash', 'source')?.value === 'builtin'
      && rowOf(opened, '工具 bash', 'path')?.value === '<builtin:bash>'
      && rowOf(opened, `工具 ${WORD}`, '类型（按分组来源）')?.value === '插件' && rowOf(opened, `工具 ${WORD}`, 'source')?.value === 'cli'
      && rowOf(opened, `工具 ${WORD}`, 'path')?.value === `/ext/${WORD}/index.ts`
      && opened.list.titles.includes('工具 bash') && opened.list.titles.includes('工具 read') && opened.list.titles.includes(`工具 ${WORD}`),
      JSON.stringify({ plugin: rowOf(opened, '暴露给 agent 的工具', '插件（分组来源 declared）'), builtin: rowOf(opened, '暴露给 agent 的工具', '内建（分组来源 builtin-table）'), bash: [rowOf(opened, '工具 bash', '类型（按分组来源）'), rowOf(opened, '工具 bash', 'path')], tools: opened.list.titles.filter((title) => title.startsWith('工具')) }));
    // 业主 2026-09-26 那条要求：**工具按组画出来**（组名 + 该组工具），且每个工具有组与分组来源两行。
    check('工具**按组**画出来了（组名 + 该组工具，逐组一行；逐工具也各自带「组」与「分组来源」两行），且标明声明表在哪儿',
      rowOf(opened, '暴露给 agent 的工具', 'groups（按组列出）')?.value === '2 组'
      && rowOf(opened, '暴露给 agent 的工具', '组 内置工具组')?.value === '2 个：bash · read'
      && rowOf(opened, '暴露给 agent 的工具', `组 树形会话组`)?.value === `1 个：${WORD}`
      && rowOf(opened, '工具 bash', '组')?.value === '内置工具组' && rowOf(opened, '工具 bash', '分组来源')?.value === 'builtin-table'
      && rowOf(opened, `工具 ${WORD}`, '组')?.value === '树形会话组' && rowOf(opened, `工具 ${WORD}`, '分组来源')?.value === 'declared'
      && (rowOf(opened, '暴露给 agent 的工具', 'groupTable.declaredIn')?.value ?? '').includes('TOOL_GROUP_TABLE')
      && (rowOf(opened, '暴露给 agent 的工具', 'groupTable.declaredIn')?.value ?? '').includes('POST /reload-code'),
      JSON.stringify((sectionOf(opened, '暴露给 agent 的工具')?.rows ?? []).filter((row) => row.key.startsWith('组') || row.key.startsWith('groups'))));
    check('工具块里也有一档「取不到」（read 缺 parameterNames ⇒ 那一行是「这一项取不到」，不是空）',
      rowOf(opened, '工具 read', 'parameterNames')?.value === MISSING_TOKEN && rowOf(opened, '工具 read', 'parameterNames')?.missing === true,
      JSON.stringify({ parameterNames: rowOf(opened, '工具 read', 'parameterNames'), description: rowOf(opened, '工具 read', 'description（全文）') }));
    // 业主 2026-09-25 那条要求：**名称/描述/参数/参数说明**四样都要能在页上看见。
    check('业主那条「名称/描述/参数/参数说明」都画得出来：description（全文）/ parameters（JSON Schema 原样）/ 每个参数的 type·required·description',
      (rowOf(opened, '工具 bash', 'description（全文）')?.value ?? '').startsWith('Run a shell command in the current working directory and return stdout/stderr.')
      && rowOf(opened, '工具 bash', 'descriptionHead（前 160 字，兼容字段）')?.value === 'Run a shell command in the current working directory…'
      && (rowOf(opened, '工具 bash', 'parameters（JSON Schema 原样）')?.value ?? '').includes('Shell command to execute')
      && rowOf(opened, '工具 bash', 'parameterDetails')?.value === '1 个'
      && rowOf(opened, '工具 bash', '参数 command.type')?.value === 'string'
      && rowOf(opened, '工具 bash', '参数 command.required')?.value === '是'
      && rowOf(opened, '工具 bash', '参数 command.description')?.value === 'Shell command to execute',
      JSON.stringify((sectionOf(opened, '工具 bash')?.rows ?? []).filter((row) => row.key.startsWith('参数 ') || row.key.startsWith('description') || row.key.startsWith('parameters'))));
    check('参数说明取不到时逐字写「这一项取不到」（session_new.notify 的 description 是 null，不是空串），有说明的逐字画出来',
      rowOf(opened, `工具 ${WORD}`, '参数 notify.description')?.value === MISSING_TOKEN
      && rowOf(opened, `工具 ${WORD}`, '参数 notify.description')?.missing === true
      && rowOf(opened, `工具 ${WORD}`, '参数 notify.required')?.value === '否'
      && rowOf(opened, `工具 ${WORD}`, '参数 notify.type')?.value === 'boolean'
      && rowOf(opened, `工具 ${WORD}`, '参数 task.description')?.value === "Task to send as the child's first user message"
      && rowOf(opened, `工具 ${WORD}`, '参数 task.required')?.value === '否',
      JSON.stringify((sectionOf(opened, `工具 ${WORD}`)?.rows ?? []).filter((row) => row.key.startsWith('参数 '))));
    check('description/parameters/parameterDetails 三样取不到时也如实写「这一项取不到」（read 那一档，不是空、不是空对象）',
      rowOf(opened, '工具 read', 'description（全文）')?.value === MISSING_TOKEN && rowOf(opened, '工具 read', 'description（全文）')?.missing === true
      && rowOf(opened, '工具 read', 'parameters（JSON Schema 原样）')?.value === MISSING_TOKEN && rowOf(opened, '工具 read', 'parameters（JSON Schema 原样）')?.missing === true
      && rowOf(opened, '工具 read', 'parameterDetails')?.value === MISSING_TOKEN && rowOf(opened, '工具 read', 'parameterDetails')?.missing === true,
      JSON.stringify((sectionOf(opened, '工具 read')?.rows ?? []).filter((row) => ['description（全文）', 'parameters（JSON Schema 原样）', 'parameterDetails'].includes(row.key))));
    check('服务端登记的「取不到的项」原样带出来了（字段 + 原因 + 去哪儿取），这一块单独一块',
      text.includes('取不到的项') && text.includes('hostProcess') && text.includes('appProcess') && text.includes('GET /host on the A host'),
      JSON.stringify(sectionOf(opened, '取不到的项（服务端如实登记）')?.rows.slice(0, 2) ?? null));
    check('B 自己的那份（pid/版本/startedAt/upstream/webRoot）走**同源** GET /app-host 画出来了，且与 A 段的 pid 分得开',
      rowOf(opened, '页面所在的进程（B）', 'pid')?.value === '9090'
      && rowOf(opened, '页面所在的进程（B）', 'codeVersion')?.value === 'app-2026-09-25T06:00:00.000Z'
      && rowOf(opened, '页面所在的进程（B）', 'startedAt')?.value !== MISSING_TOKEN
      && rowOf(opened, '页面所在的进程（B）', 'upstream')?.value === 'http://127.0.0.1:7331'
      && rowOf(opened, '页面所在的进程（B）', 'webRoot')?.value === '/repo/web'
      && rowOf(opened, '逻辑实例（worker）', 'pid')?.value === '4242'
      && (sectionOf(opened, '页面所在的进程（B）')?.source ?? '').includes('同源'),
      JSON.stringify((sectionOf(opened, '页面所在的进程（B）')?.rows ?? []).filter((row) => ['pid', 'codeVersion', 'upstream', 'webRoot'].includes(row.key))));

    // ── 4. 字段缺失 ⇒ 如实写「这一项取不到」（绝不是空、绝不是 0）────────────────────────────
    const sessionC = sectionOf(opened, `会话 ${SESSION_C.slice(0, 8)}`);
    const missingRows = opened.list.rows.filter((row) => row.missing === true);
    check('字段缺失时如实写「这一项取不到」（会话 C 缺 idleForMs / evictionEligible ⇒ 那两行就是它，不是空、不是 0）',
      opened.list.missingCount >= 2
      && sessionC?.rows.some((row) => row.key === 'idleForMs' && row.value === MISSING_TOKEN)
      && sessionC?.rows.some((row) => row.key === 'evictionEligible' && row.value === MISSING_TOKEN)
      && !missingRows.some((row) => row.value === '' || row.value === '0'),
      JSON.stringify((sessionC?.rows ?? []).filter((row) => ['idleForMs', 'evictionEligible', 'runtimeState', 'durable'].includes(row.key))));
    check('「取不到」那条渲染**逐字**是这一句（不是空串、不是「—」、不是编一个值）',
      missingRows.length > 0 && missingRows.every((row) => row.value === MISSING_TOKEN),
      JSON.stringify({ count: opened.list.missingCount, sample: missingRows.slice(0, 3) }));
    check('同一条里**有值**的字段照常画（缺的那两个是「取不到」，其余仍是真值）：runtimeState=cold、durable=否',
      sessionC?.rows.find((row) => row.key === 'runtimeState')?.value === 'cold'
      && sessionC?.rows.find((row) => row.key === 'durable')?.value === '否',
      JSON.stringify((sessionC?.rows ?? []).filter((row) => ['runtimeState', 'durable'].includes(row.key))));

    // ── 5. 两个视口：无横向溢出、不逐字折断 ────────────────────────────────────────────────
    const wide = await state();
    const wideWords = await evaluate(WORD_RECTS(WORD));
    check('1200×760：页面/正文/#debug-list 都不横向溢出，工具名与路径里的整词不断行（每个 session_new 恰好 1 个 rect / 1 条 baseline）',
      wide.scroll.docScrollWidth <= wide.scroll.docClientWidth + 1
      && wide.scroll.bodyScrollWidth <= wide.scroll.bodyClientWidth + 1
      && wide.scroll.listScrollWidth <= wide.scroll.listClientWidth + 1
      && wideWords.length > 0
      && wideWords.every((row) => row.rectCount === 1 && row.baselines === 1),
      JSON.stringify({ scroll: wide.scroll, words: wideWords }));

    await ui.resize(420, 820);
    await ui.frames(3);
    const narrowState = await state();
    const narrowWords = await evaluate(WORD_RECTS(WORD));
    check('420×820：无横向溢出（documentElement/body/#debug-list）、且 #debug-list 里每个 session_new 仍是 1 个 rect（没被逐字折断）',
      narrowState.scroll.docScrollWidth <= narrowState.scroll.docClientWidth + 1
      && narrowState.scroll.bodyScrollWidth <= narrowState.scroll.bodyClientWidth + 1
      && narrowState.scroll.listScrollWidth <= narrowState.scroll.listClientWidth + 1
      && narrowWords.length > 0
      && narrowWords.every((row) => row.rectCount === 1 && row.baselines === 1),
      JSON.stringify({ scroll: narrowState.scroll, words: narrowWords }));
    await ui.screenshot(path.join(ARTIFACTS, 'debug-420x820.png'));
    await ui.resize(1200, 760);
    await ui.frames(2);

    // ── 6. 端点 404：如实说「这个服务端还没有调试端点」，且 B 的本机事实照常显示 ──────────────
    await setMode('endpoint404');
    await evaluate(`document.querySelector('#debug-refresh').click()`);
    await waitFor(async () => (await state()).list.load === 'unsupported', '404 臂没有落到 unsupported');
    const notFound = await state();
    check('A 上没有调试端点（GET /debug/instances 404）⇒ 如实说「没有调试端点/不是没有实例」，不编数据；B 的本机事实照常显示',
      /没有调试端点/.test(notFound.list.text)
      && rowOf(notFound, '页面所在的进程（B）', 'pid')?.value === '9090'
      && (notFound.list.rows.find((row) => row.key === 'pid' && row.value === '4242') === undefined)
      && notFound.notice.level === 'error',
      JSON.stringify({ text: notFound.list.text.slice(0, 160), notice: notFound.notice, pid: rowOf(notFound, '页面所在的进程（B）', 'pid') }));

    // ── 7. /app-host 读不到：B 的字段如实「取不到」并给出原因，A 的事实照旧 ─────────────────
    await setMode('hostfail');
    await evaluate(`document.querySelector('#debug-refresh').click()`);
    await waitFor(async () => {
      const value = await state();
      return value.list.load === 'ready' && (sectionOf(value, '页面所在的进程（B）')?.rows ?? []).some((row) => row.key === '读取结果');
    }, '/app-host 失败臂没有落账');
    const hostFail = await state();
    const hostFailB = sectionOf(hostFail, '页面所在的进程（B）');
    check('/app-host 读不到 ⇒ B 段的字段如实写「这一项取不到」+ 单独一行给出原因，A 的实例事实照旧画出（两个来源各自成败）',
      (hostFailB?.rows ?? []).filter((row) => row.missing && row.value === MISSING_TOKEN).length >= 4
      && (hostFailB?.rows ?? []).some((row) => row.key === '读取结果' && /读不到/.test(row.value))
      && rowOf(hostFail, '逻辑实例（worker）', 'pid')?.value === '4242'
      && rowOf(hostFail, '逻辑实例（worker）', 'memory.rss')?.value === '256.0 MB（268435456 B）'
      && /B 的本机事实读不到/.test(hostFail.notice.text),
      JSON.stringify({ b: (hostFailB?.rows ?? []).filter((row) => ['pid', '读取结果', 'webRoot'].includes(row.key)), missing: hostFail.list.missingCount, notice: hostFail.notice }));

    // ── 7.5 没有热 runtime：`tools.registered=null` ⇒ 整块如实「取不到」+ 原因，**不吐空清单假装没有** ──
    await setMode('noregistered');
    await evaluate(`document.querySelector('#debug-refresh').click()`);
    await waitFor(async () => (sectionOf(await state(), '暴露给 agent 的工具')?.state === 'unavailable'), '没有热 runtime 的臂没有落账');
    const noRuntime = await state();
    const noRuntimeTools = sectionOf(noRuntime, '暴露给 agent 的工具');
    check('没有热 runtime（tools.registered=null，服务端明说问不到）⇒ 整块如实写「这一项取不到」+ registeredUnavailableReason，**不吐空清单假装没有**；分组视图同样如实「取不到」+ 原因（声明表那块静态事实照旧在）',
      rowOf(noRuntime, '暴露给 agent 的工具', 'registered')?.value === MISSING_TOKEN
      && (rowOf(noRuntime, '暴露给 agent 的工具', 'registeredUnavailableReason')?.value ?? '').includes('no live runtime')
      && noRuntimeTools?.state === 'unavailable'
      && !(noRuntimeTools?.rows ?? []).some((row) => row.value === '空清单（服务端说这一代没有任何注册工具）')
      && !noRuntime.list.titles.some((title) => title.startsWith('工具 '))
      && rowOf(noRuntime, '暴露给 agent 的工具', 'liveSessionCount')?.value === '0'
      && rowOf(noRuntime, '暴露给 agent 的工具', 'activeBySession')?.value === '无（这一代没有热的会话）'
      && rowOf(noRuntime, '暴露给 agent 的工具', 'groups（按组列出）')?.value === MISSING_TOKEN
      && (rowOf(noRuntime, '暴露给 agent 的工具', 'groupsUnavailableReason')?.value ?? '').includes('derived from the registered tool list')
      && !(noRuntimeTools?.rows ?? []).some((row) => row.key.startsWith('组 '))
      && (rowOf(noRuntime, '暴露给 agent 的工具', 'groupTable.declaredIn')?.value ?? '').includes('TOOL_GROUP_TABLE')
      && (noRuntimeTools?.rows ?? []).some((row) => row.key === '取不到：registered' && /no live runtime/.test(row.value ?? '')),
      JSON.stringify({ state: noRuntimeTools?.state, registered: rowOf(noRuntime, '暴露给 agent 的工具', 'registered'), reason: rowOf(noRuntime, '暴露给 agent 的工具', 'registeredUnavailableReason'), groups: rowOf(noRuntime, '暴露给 agent 的工具', 'groups（按组列出）'), titles: noRuntime.list.titles }));
    await setMode('ok');
    await evaluate(`document.querySelector('#debug-refresh').click()`);
    await waitFor(async () => rowOf(await state(), '页面所在的进程（B）', 'pid')?.value === '9090', '恢复 ok 臂失败');

    // ── 8. 切回会话页：底栏与队列恢复（同形的两条 CSS 规则是**按视图**生效的）──────────────────
    await openSession(SESSION_A);
    // `#queue-status` 的 hidden 由 app 自己管（无队列时又会被收回）⇒ 这里手动摊开，量的才是**那条 CSS 规则**。
    await evaluate(`(() => { const queue=document.querySelector('#queue-status'); queue.hidden=false; queue.textContent='排了一条'; return true; })()`);
    await ui.frames(1);
    const sessionView = await state();
    check('切回会话页 ⇒ 底栏与排队条恢复显示（那条 CSS 是按视图切的，不是一次性隐藏）',
      sessionView.view === 'session' && sessionView.composer.display !== 'none' && sessionView.queue.display !== 'none'
      && sessionView.messagesPane.visibility !== 'hidden',
      JSON.stringify({ view: sessionView.view, composer: sessionView.composer, queue: sessionView.queue, messagesPane: sessionView.messagesPane }));

    // ── 9. 再切回调试页：仍然只有调试面板可见（页签互斥逐次重算）─────────────────────────────
    await evaluate(`document.querySelector('#view-tab-debug').click()`);
    await waitFor(async () => (await state()).view === 'debug' && (await state()).panes.debug === false, '第二次切调试页失败');
    const again = await state();
    check('切回会话再切回调试：仍然只有调试面板可见（互斥是逐次重算的，不是一次性的）',
      again.panes.debug === false && again.panes.questions === true && again.panes.annotations === true && again.composer.display === 'none',
      JSON.stringify({ panes: again.panes, composer: again.composer }));

    // ── 10. 只读证据 + 页面零异常 ─────────────────────────────────────────────────────────
    const ledger = await controlState();
    check('两个只读端点都真的被问过（不是空跑）：/api/debug/instances 与 /app-host 都 ≥2 次',
      ledger.endpointRequests >= 2 && ledger.appHostRequests >= 2,
      JSON.stringify(ledger));
    const problems = ui.pageProblems.slice(problemsAtStart);
    const unexpected = problems.filter((text) => !/Failed to load resource|status of 404|net::ERR|Failed to fetch/i.test(text));
    check('页面没有未捕获异常或 console.error（受控 404 臂只留网络层那条，不算页面异常）', unexpected.length === 0, JSON.stringify({ all: problems, unexpected }));

    print('约定的假响应形状', { endpoint: DEBUG_PAYLOAD(), appHost: APP_HOST_PAYLOAD() });
    print('screenshots', { wide: path.join(ARTIFACTS, 'debug-1200x760.png'), narrow: path.join(ARTIFACTS, 'debug-420x820.png') });
    print('checks', CHECKS.length);
    print('RESULT', `debug pane PASS（${CHECKS.length} checks）`);
  } catch (error) {
    process.exitCode = 1;
    if (ui) print('pageProblems', ui.pageProblems);
    process.stdout.write(`\n✗ FAIL: ${error?.stack || error}\n`);
  } finally {
    try { await ui?.close(cleanupProblems); } catch (error) { cleanupProblems.push(`close: ${error.message}`); }
    if (cleanupProblems.length > 0) {
      process.exitCode = 1;
      process.stdout.write(`\n✗ FAIL（收尾）: ${JSON.stringify(cleanupProblems)}\n`);
    }
  }
}

// ── 红半：单点变异 + 子进程重跑，断了必须红 ────────────────────────────────────────────
async function runRedHalf() {
  const redRoot = await mkdtemp(path.join(os.tmpdir(), 'sopho-debug-ui-red-'));
  const redProblems = [];
  const outcomes = [];
  try {
    const mutants = [
      {
        label: '撤掉 #view-tab-debug 页签',
        expect: /四个页签同级|调试页签/,
        mutate: async (dir) => {
          const target = path.join(dir, 'index.html');
          const html = await readFile(target, 'utf8');
          const next = html.replace(/\s*<button id="view-tab-debug"[\s\S]*?<\/button>/, '');
          assert.notEqual(next, html, '变异没生效：index.html 里没找到 #view-tab-debug 页签');
          await writeFile(target, next);
        },
      },
      {
        label: '把「组 」那一行的键前缀改成空串（分组那一行就看不见了）',
        expect: /按组|组名/,
        mutate: async (dir) => {
          const target = path.join(dir, 'render.js');
          const sourceText = await readFile(target, 'utf8');
          const next = sourceText.replace("const DEBUG_GROUP_ROW_PREFIX = '组 ';", "const DEBUG_GROUP_ROW_PREFIX = '';");
          assert.notEqual(next, sourceText, '变异没生效：render.js 里没找到 DEBUG_GROUP_ROW_PREFIX');
          await writeFile(target, next);
        },
      },
      {
        label: '把「这一项取不到」那条渲染改成空串',
        expect: /取不到|字段缺失/,
        mutate: async (dir) => {
          const target = path.join(dir, 'render.js');
          const sourceText = await readFile(target, 'utf8');
          const next = sourceText.replace("const DEBUG_MISSING_TEXT = '这一项取不到';", "const DEBUG_MISSING_TEXT = '';");
          assert.notEqual(next, sourceText, '变异没生效：render.js 里没找到 DEBUG_MISSING_TEXT');
          await writeFile(target, next);
        },
      },
    ];
    for (const [index, mutant] of mutants.entries()) {
      const dir = path.join(redRoot, `mutant-${index}`);
      await cp(WEB_ROOT, dir, { recursive: true });
      await mutant.mutate(dir);
      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, [HERE], {
          env: { ...process.env, SOPHO_DEBUG_UI_WEB: dir, SOPHO_DEBUG_UI_RED_CHILD: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.once('exit', (code) => resolve({ code, output }));
      });
      const matched = mutant.expect.test(result.output);
      outcomes.push({ label: mutant.label, exitCode: result.code, matched, line: (result.output.split('\n').find((line) => /✗ (FAIL|右栏|字段缺失|「取不到」|工具\*\*按组\*\*)/.test(line)) ?? '').trim() });
      assert.equal(result.code !== 0 && matched, true, `红半没红：${mutant.label}（exit=${result.code}，matched=${matched}）\n${result.output.slice(-1200)}`);
    }
    print('红半（单点变异 ⇒ 必红）', outcomes);
  } finally {
    // 收尾走共享入口（`test/harness.mjs`）：不能在这里裸 `rm` —— 那会在失败时盖掉真错误。
    await removeSandbox(redRoot, redProblems, 'red-half temp web copies');
  }
  if (redProblems.length > 0) throw new Error(`红半的临时 web 副本没收干冷：${redProblems.join('; ')}`);
}

await main();
if (process.exitCode !== 1 && process.env.SOPHO_DEBUG_UI_RED_CHILD !== '1') await runRedHalf();
