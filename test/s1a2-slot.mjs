// test/s1a2-slot.mjs —— v2.2 左槽语言（`--slot-*`）的权威门：几何（3px 槽）、调色板、语义（哪个元素吃哪条槽）
// 与逐元素撤销开关（`data-slot="off"`），全部在**真 Chromium ＋ 真产品页**（`web/index.html`）上逐条量。
//
// 2026-10-04 加的两条判据（冻结规格 I1：「槽色**只**由 `--slot-*` 表达」）：
//   · `slot:tool-state-token`（实测腿）：工具卡四个状态（running / done-success / done-error /
//     unfinished）的计算槽色必须等于该元素**自己**那条 `--slot` 的解析色（顺带钉住 3px 与状态底色仍在）。
//   · `slot:tool-state-source`（源码腿）：产品页 `web/index.html` 里不许再出现硬编码的边色声明
//     （`border-left-color` / `border-inline-start-color` 的值必须走 `var(…)`），**注释先剔除**
//     （别把注释里的字当代码）。
//     来源：那四条 `.tool-card[data-state=…] { border-left-color: #… }` 实测**从来没生效过**
//     —— `web/slot.css` 那条未分层的 `!important` 槽原语永远压过非 important 的长写，逐状态的计算色
//     等于 `--slot-*` 的解析值（running 是 `--slot-pending`，**不是**那句里的 `#8abeb7`）⇒ 与 `--dz-slots`
//     死 token 同一族。2026-10-04 已把那四条删掉（逐状态的计算色一个像素都没变，实测见提交信息）。
// 反证臂：`npm run test:slot:reverse-tool-state-hardcoded`（把 running 那句硬编码色加回**副本**）
//   ⇒ `slot:tool-state-source` 必红，而 `slot:tool-state-token` 必须**仍然绿**（那句确实是死的）；
//   `npm run test:slot:reverse-tool-state-hardcoded-wins`（把硬编码色写成真能赢的样子）
//   ⇒ `slot:tool-state-token` 必红 —— 两条一起证明**两条腿都有牙**。
// 用法：CHROME_BIN=<chromium> node test/s1a2-slot.mjs [--reverse-arm=tool-state-hardcoded|tool-state-hardcoded-wins]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-slot-'));
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

// ── 反证臂：只改 `web/` 的**副本**（产品原件一个字节不动），门就指到那份副本上量 ─────────────────
// `from` 必须**逐字**在仓里找得到、且在被改的那个文件里**恰好一处**（`test:armseams` 的静态判据）；
// 这里在**施加处**再守一次 —— `String.replace` 配字符串只改第一处，接缝出现两次就会改到别处
// ⇒ 臂「跑了」却红不到它该红的那条（本仓真踩过这种假臂）。
const ARM_MUTANTS = {
  'tool-state-hardcoded': {
    what: '把 `web/index.html` 里 `.tool-card[data-state="running"]` 那句硬编码槽色 `border-left-color: #8abeb7` 加回来'
      + '（＝又让一个不是 `--slot-*` 的东西声称在画槽色）—— 计算色**不会**变（那句本来就是死的），红的是源码腿',
    file: 'web/index.html',
    from: '    .tool-card[data-state="running"] { background-color: #282832; }',
    to: '    .tool-card[data-state="running"] { border-left-color: #8abeb7; background-color: #282832; }',
    expect: ['slot:tool-state-source'],
    expectGreen: ['slot:tool-state-token'],
  },
  // 上面那条证明**源码腿**有牙；这一条证明**实测腿**不是空转：把 running 那句硬编码色写成真的能赢的样子
  // （`!important` ＋ 更高的特异性 (0,2,0) ⇒ 压过槽原语那条 `.tool-card` (0,1,0)）—— 只改 slot.css。
  // 色值取 `--slot-idle` 的 `#4d5058` 而**不是**那句历史上写的 `#8abeb7`（＝ `--slot-user`），
  // 因为后者与 `.message-user` 同色，会先撞上既有断言 `new Set(audit.messages).size === 4` ⇒
  // 门会在跑到本臂的结算前**崩掉**（**臂崩 ≠ 臂红**，本仓明令禁止）。`#4d5058` 是一个调色板里的色、
  // 且不在任何一条互异性断言的组里 ⇒ 这一臂**只**红 `slot:tool-state-token` 这一条。
  'tool-state-hardcoded-wins': {
    what: '把 `.tool-card[data-state="running"]` 的槽色硬写成 `border-left-color: #4d5058 !important`（特异性 (0,2,0) '
      + '压过槽原语那条 `.tool-card` (0,1,0)）—— 这一回硬编码色**真的画上去了**，于是实测腿必红',
    file: 'web/slot.css',
    from: '.tool-card[data-state="running"] { --slot: var(--slot-pending); }',
    to: '.tool-card[data-state="running"] { --slot: var(--slot-pending); border-left-color: #4d5058 !important; }',
    expect: ['slot:tool-state-token'],
    expectGreen: ['slot:tool-state-source'],
  },
};
const webRoot = ARM ? path.join(sandbox, 'web-copy') : path.join(root, 'web');
// ⚠️ 臂的**准备**自己失败（认不出的臂 / `from` 没命中 / 改写没落地 / 拷贝失败）也要把自己建的沙箱删干净
// 再抛 —— 那时候还没进下面那个 `try`，`finally` 里的收尾不会跑（本仓踩过一次这种泄漏：
// 一条“命中 0 次”的臂在模块顶部就抛了，留下一个 `/tmp/s1a2-slot-*`（里面是我拷的 `web-copy/`））。
if (ARM) {
  try {
    const arm = ARM_MUTANTS[ARM];
    if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
    const relative = path.relative(path.join(root, 'web'), path.join(root, arm.file));
    if (relative.startsWith('..')) throw new Error(`反证臂 ${ARM} 的 file 不在 web/ 里：${arm.file}`);
    await cp(path.join(root, 'web'), webRoot, { recursive: true });
    const target = path.join(webRoot, relative);
    const text = await readFile(target, 'utf8');
    const hits = text.split(arm.from).length - 1;
    if (hits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 ${arm.file} 里出现 ${hits} 次（要求恰好 1 次）：${arm.what}`);
    await writeFile(target, text.replace(arm.from, arm.to), 'utf8');
    // 变异必须**真的落地**（别拿没落地的改写当证据）：读回来验一次。
    const mutated = await readFile(target, 'utf8');
    if (!mutated.includes(arm.to) || mutated === text) throw new Error(`反证臂 ${ARM} 的改写没落地：${arm.file}`);
    print(`反证臂 ${ARM}`, `${arm.what}（跑在副本上：${path.join('web-copy', relative)}）`);
  } catch (error) {
    const problems = [];
    await removeSandbox(sandbox, problems);
    if (problems.length > 0) process.stderr.write(`反证臂准备失败后的收尾问题：${problems.join('; ')}\n`);
    throw error;
  }
}
const screenshotWide = path.join(os.tmpdir(), 'sopho-v22-rail-open-1200x760.png');
const screenshotWideClosed = path.join(os.tmpdir(), 'sopho-v22-rail-closed-1200x760.png');
const screenshotNarrow = path.join(os.tmpdir(), 'sopho-v22-rail-open-420x820.png');
const ids = {
  idle: '11111111-1111-4111-8111-111111111111',
  working: '22222222-2222-4222-8222-222222222222',
  unread: '33333333-3333-4333-8333-333333333333',
  archived: '44444444-4444-4444-8444-444444444444',
  archivedChild: '55555555-5555-4555-8555-555555555555',
};
const sessions = [
  { id: ids.idle, name: 'Idle session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.archivedChild, name: 'Folded child', status: 'idle', statusLabel: '闲置', archived: true, parentId: ids.idle, notify: { notifies: [], waitingFor: [] } },
  { id: ids.working, name: 'Working delegate', status: 'working', statusLabel: '工作中', archived: false, parentId: null, notify: { notifies: [ids.idle], waitingFor: [ids.unread] } },
  { id: ids.unread, name: 'Unread session', status: 'unread', statusLabel: '未读', unread: true, archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } },
  { id: ids.archived, name: 'Archived session', status: 'idle', statusLabel: '闲置', archived: true, parentId: null, notify: { notifies: [], waitingFor: [] } },
];
// 填充到两个分区都溢出各自半栏：活跃 8 条 + 归档 9 条，才能真验「两棵树的滚动各自独立」。
for (let index = 0; index < 8; index += 1) {
  sessions.push({ id: `a0000000-0000-4000-8000-00000000000${index}`, name: `Extra active ${index}`, status: 'idle', statusLabel: '闲置', archived: false, parentId: null, notify: { notifies: [], waitingFor: [] } });
}
for (let index = 0; index < 9; index += 1) {
  sessions.push({ id: `f0000000-0000-4000-8000-00000000000${index}`, name: `Extra archived ${index}`, status: 'idle', statusLabel: '闲置', archived: true, parentId: null, modifiedAt: `2026-09-19T0${index}:00:00.000Z`, notify: { notifies: [], waitingFor: [] } });
}
const payload = {
  messages: [
    { role: 'user', text: '用户消息' },
    { role: 'assistant', parts: [
      { type: 'text', text: '助手消息' },
      { type: 'tool', name: 'pending', status: 'running' },
      { type: 'tool', name: 'success', status: 'done-success', result: 'ok' },
      { type: 'tool', name: 'error', status: 'done-error', result: 'bad', isError: true },
      { type: 'tool', name: 'unfinished', status: 'unfinished' },
    ] },
    // bash 块（用户发起的 `!` 命令）：它用**自己的槽色**（`--slot-bash`），与 user/assistant/tool 都不同。
    { kind: 'bashExecution', role: 'bashExecution', content: [], text: '$ git status --short\n M a.mjs', bash: { command: 'git status --short', output: ' M a.mjs', exitCode: 0, cancelled: false, truncated: false, fullOutputPath: null, excludeFromContext: false } },
  ],
  extras: [{ customType: 'slot.fixture', text: '额外消息', display: true }],
  compaction: { atIndex: 1, note: '压缩摘要边界' },
  observability: null,
};
let browser;
let chromium;
let server;

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
async function waitFor(operation, message, timeoutMs = 6000) {
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

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 1, oldestId: ids.unread, oldestName: 'Unread session' } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [{ name: 'lab', host: 'lab.local', lastProbe: { ok: true } }] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${ids.idle}`) return sendJson(response, 200, { name: 'Idle session', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${ids.idle}/messages`) return sendJson(response, 200, payload);
    if (url.pathname === `/api/sessions/${ids.idle}/commands`) return sendJson(response, 200, { streaming: false, commands: [
      { name: 'cwd', description: 'available', source: 'extension', runnable: true },
      { name: 'settings', description: 'TUI only', source: 'builtin', runnable: false, reason: 'TUI 专用', tag: 'TUI 专用' },
      { name: 'export', description: 'not restored', source: 'builtin', runnable: false, reason: '网页尚未恢复', tag: '尚未恢复' },
    ] });
    if (url.pathname === `/api/sessions/${ids.idle}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${ids.idle}/seen`) return sendJson(response, 200, { ok: true });
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
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
  await waitFor(() => evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelectorAll('[data-active-tree-list="true"] > .tree-session').length === 11`), 'slot language or tree did not render');
  await evaluate(`document.querySelector('[data-session-id="${ids.idle}"]').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.tool-card').length === 4 && document.querySelector('#prompt').disabled === false`), 'message fixtures did not render');
  await evaluate(`(() => { document.querySelector('#new-session-toggle').click(); const queue=document.querySelector('#queue-status'); queue.hidden=false; queue.textContent='⏳ fixture queue'; const input=document.querySelector('#prompt'); input.value='/'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.command-palette-item').length === 3 && !document.querySelector('#new-session-panel').hidden`), 'command palette or new-session controls did not render');
  const closedLayout = await evaluate(`(() => { const tree=document.querySelector('#tree').getBoundingClientRect(); const active=document.querySelector('[data-active-tree-list="true"]').getBoundingClientRect(); const attic=document.querySelector('[data-attic="true"]').getBoundingClientRect(); return {treeBottom:tree.bottom,activeBottom:active.bottom,atticTop:attic.top,atticBottom:attic.bottom,bottomDelta:tree.bottom-attic.bottom}; })()`);
  assert.ok(Math.abs(closedLayout.bottomDelta) <= 5, JSON.stringify(closedLayout));
  assert.ok(closedLayout.activeBottom <= closedLayout.atticTop + 1, JSON.stringify(closedLayout));
  await screenshot(screenshotWideClosed);
  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  const wideSplit = await waitFor(async () => {
    const value = await evaluate(`(() => { const active=document.querySelector('[data-active-tree-list="true"]').getBoundingClientRect(); const attic=document.querySelector('[data-attic="true"]').getBoundingClientRect(); return {activeHeight:active.height,archiveHeight:attic.height,ratio:active.height/attic.height}; })()`);
    return value.archiveHeight > 100 ? value : null;
  }, 'wide archive split did not settle');
  assert.ok(Math.abs(wideSplit.ratio - 1) <= .2, JSON.stringify(wideSplit));
  print('wide rail layout pixels', { closed: closedLayout, open: wideSplit });

  // 用户口径（2026-09-17）：两个分区各有一条独立滚动轴 —— 整条左栏自己不滚，
  // 滚动活跃树不得带动归档树（反之亦然）。
  const axes = await evaluate(`(() => {
    const aside=document.querySelector('aside.tree');
    const active=document.querySelector('[data-active-tree-list="true"]');
    const attic=document.querySelector('[data-attic-list="true"]');
    const axis=(node)=>({clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,overflowY:getComputedStyle(node).overflowY});
    const before={active:active.scrollTop,attic:attic.scrollTop};
    active.scrollTop=active.scrollHeight;
    const afterActive={active:active.scrollTop,attic:attic.scrollTop};
    attic.scrollTop=attic.scrollHeight;
    const afterAttic={active:active.scrollTop,attic:attic.scrollTop};
    active.scrollTop=0; attic.scrollTop=0;
    return {aside:axis(aside),tree:axis(document.querySelector('#tree')),active:axis(active),attic:axis(attic),before,afterActive,afterAttic};
  })()`);
  assert.equal(axes.aside.scrollHeight, axes.aside.clientHeight, JSON.stringify(axes));
  assert.match(axes.active.overflowY, /^(auto|scroll)$/, JSON.stringify(axes.active));
  assert.match(axes.attic.overflowY, /^(auto|scroll)$/, JSON.stringify(axes.attic));
  assert.ok(axes.active.scrollHeight > axes.active.clientHeight, JSON.stringify(axes.active));
  assert.ok(axes.attic.scrollHeight > axes.attic.clientHeight, JSON.stringify(axes.attic));
  assert.ok(axes.afterActive.active > 0, JSON.stringify(axes));
  assert.equal(axes.afterActive.attic, axes.before.attic, JSON.stringify(axes));
  assert.ok(axes.afterAttic.attic > 0, JSON.stringify(axes));
  assert.equal(axes.afterAttic.active, axes.afterActive.active, JSON.stringify(axes));
  print('two independent scroll axes pixels', axes);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

  const audit = await evaluate(`(() => {
    const selectors = [
      '.tree-nav h1', '#tree-search-toggle', '#new-session-toggle', '.new-session-label', '#new-project', '#new-scratch', '#new-cwd', '#advanced-session button', '#new-session-cancel',
      '.device-panel h2', '.device', '.tree-session.status-idle:not(.archived)', '.tree-session.status-working', '.tree-session.unread', '.tree-session.archived',
      '.attic-toggle', '.attic-heading', '.tree-connection', '#session-title', '#abort', '#session-usage', '#session-connection', '#queue-status',
      '.message-user', '.message-assistant', '.tool-card[data-state="running"]', '.tool-card[data-state="done-success"]',
      '.tool-card[data-state="done-error"]', '.tool-card[data-state="unfinished"]', '.bash-card', '.extra-message', '.compaction-note',
      '.command-palette-item', '.command-palette-note', '#prompt', '#send', '#notice'
    ];
    const variables = ['--slot-idle','--slot-working','--slot-unread','--slot-dark','--slot-user','--slot-assistant','--slot-pending','--slot-success','--slot-error','--slot-warning','--slot-extra','--slot-bash'];
    const probe=document.createElement('i'); document.body.append(probe);
    const palette=[];
    for (const variable of variables) { probe.style.color='var('+variable+')'; palette.push(getComputedStyle(probe).color); }
    probe.remove();
    const rows=selectors.map((selector)=>{
      const node=document.querySelector(selector); if(!node) return {selector,missing:true};
      const style=getComputedStyle(node); const rect=node.getBoundingClientRect();
      return {selector,width:style.borderLeftWidth,style:style.borderLeftStyle,color:style.borderLeftColor,height:rect.height,left:rect.left};
    });
    const color=(selector)=>getComputedStyle(document.querySelector(selector)).borderLeftColor;
    const working=document.querySelector('.tree-session.status-working');
    const delegationSupported=working.hasAttribute('data-notify');
    const delegateNodes=Array.from(working.querySelectorAll('.tree-delegation'));
    return {rows,palette:[...new Set(palette)],
      tree:[color('.tree-session.status-idle:not(.archived)'),color('.tree-session.status-working'),color('.tree-session.unread')],
      archived:color('.tree-session.archived'),
      messages:[color('.message-user'),color('.message-assistant'),color('.tool-card[data-state="running"]'),color('.bash-card')],
      tools:['running','done-success','done-error','unfinished'].map((state)=>color('.tool-card[data-state="'+state+'"]')),
      extras:[color('.extra-message'),color('.compaction-note')],
      delegation:{supported:delegationSupported,text:delegateNodes.map((node)=>node.textContent),inline:delegateNodes.every((node)=>Math.abs(node.getBoundingClientRect().top-working.querySelector('.tree-name').getBoundingClientRect().top)<3)},
      dots:Array.from(document.querySelectorAll('.status-dot')).map((node)=>getComputedStyle(node).display),
      wideAside:document.querySelector('aside.tree').getBoundingClientRect().width,
      rowContracts:Array.from(document.querySelectorAll('.tree-session')).map((row)=>{const rowRect=row.getBoundingClientRect(); const rowStyle=getComputedStyle(row); const name=row.querySelector('.tree-name'); const nameRect=name.getBoundingClientRect(); const slotNodes=[row,...row.querySelectorAll('*')].filter((node)=>getComputedStyle(node).borderLeftWidth==='3px'); return {id:row.dataset.sessionId,hasFold:row.classList.contains('has-fold'),slotCount:slotNodes.length,slotClasses:slotNodes.map((node)=>node.className),contentStart:rowRect.left+parseFloat(rowStyle.borderLeftWidth),nameLeft:nameRect.left,nameOffset:nameRect.left-(rowRect.left+parseFloat(rowStyle.borderLeftWidth))};}),
      forbidden:{
        gradients:Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).backgroundImage!=='none').length,
        shadows:Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).boxShadow!=='none').length,
        slowTransitions:Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).transitionDuration.split(',').some((value)=>parseFloat(value)>0.15)).length
      }
    };
  })()`);
  for (const row of audit.rows) {
    assert.equal(row.missing, undefined, `missing slot target: ${row.selector}`);
    assert.equal(row.width, '3px', JSON.stringify(row));
    assert.equal(row.style, 'solid', JSON.stringify(row));
    assert.ok(row.height > 0, JSON.stringify(row));
    assert.ok(audit.palette.includes(row.color), `non-palette slot ${row.selector}: ${row.color}`);
  }
  assert.equal(new Set(audit.tree).size, 3, JSON.stringify(audit.tree));
  assert.equal(new Set(audit.tools).size, 4, JSON.stringify(audit.tools));
  assert.equal(new Set(audit.messages).size, 4, JSON.stringify(audit.messages));
  assert.equal(new Set(audit.extras).size, 1, JSON.stringify(audit.extras));
  assert.ok(audit.dots.every((display) => display === 'none'), JSON.stringify(audit.dots));
  assert.equal(audit.wideAside, 304);
  const messageRows = audit.rows.filter((row) => ['.message-user', '.message-assistant', '.tool-card[data-state="running"]', '.bash-card', '.extra-message', '.compaction-note'].includes(row.selector));
  assert.ok(messageRows.every((row) => Math.abs(row.left - 316) <= 1), JSON.stringify(messageRows));
  assert.ok(audit.rowContracts.length >= 4, JSON.stringify(audit.rowContracts));
  // 用户方向书 2026-09-17 的具体例外只限会话/归档会话行；上面的消息、工具与控件槽断言一条不放宽。
  assert.ok(audit.rowContracts.every((row) => row.slotCount === 1), JSON.stringify(audit.rowContracts));
  const foldedRow = audit.rowContracts.find((row) => row.id === ids.idle);
  const leafRow = audit.rowContracts.find((row) => row.id === ids.working);
  assert.equal(foldedRow.hasFold, true, JSON.stringify(foldedRow));
  assert.equal(leafRow.hasFold, false, JSON.stringify(leafRow));
  assert.ok(Math.abs(leafRow.nameOffset) <= 1, JSON.stringify(leafRow));
  assert.ok(foldedRow.nameOffset >= 30, JSON.stringify(foldedRow));
  assert.deepEqual(audit.forbidden, { gradients: 0, shadows: 0, slowTransitions: 0 });
  if (audit.delegation.supported) {
    assert.deepEqual(audit.delegation.text, ['⇢1', '⋯1']);
    assert.equal(audit.delegation.inline, true);
  }
  print('slot geometry + palette + semantics', audit);
  print('tree row one-slot + name offsets pixels', { foldedRow, leafRow });

  // ── 规格 I1：「槽色**只**由 `--slot-*` 表达」—— 工具卡四个状态的两条腿 ───────────────────────
  // 实测腿：计算槽色 == 该元素**自己**那条 `--slot` 的解析色。任何**真的**画上去的硬编码色都会红；
  // 顺带钉住 3px/solid 与四条状态底色（它们就在我删掉那四条死声明的同一批规则里 ⇒ 删的是死声明，
  // 不是整条规则）。源码腿：产品页里不许再有硬编码的边色声明。
  const slotRed = [];
  const slotCheck = (id, ok, detail) => {
    print(`${ok ? '✓' : '✗'} [${id}]`, detail);
    if (!ok) {
      slotRed.push(id);
      // 反证臂要的是「红」这个事实；正常跑要的是「不许红」这个断言。
      if (!ARM) assert.fail(`[${id}] ${JSON.stringify(detail)}`);
    }
  };
  const hexToRgb = (hex) => { const value = parseInt(hex.slice(1), 16); return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`; };
  const toolStates = ['running', 'done-success', 'done-error', 'unfinished'];
  const toolStateBackgrounds = { running: '#282832', 'done-success': '#283228', 'done-error': '#3c2828', unfinished: '#3a3225' };
  const toolStateSlots = await evaluate(`(() => {
    const out = {};
    for (const state of ${JSON.stringify(toolStates)}) {
      const node = document.querySelector('.tool-card[data-state="' + state + '"]');
      const style = getComputedStyle(node);
      // 探针挂在**这个元素里面**：var(--slot) 在该元素自己的上下文里解析（继承下来的那条）。
      const probe = document.createElement('i');
      probe.style.color = 'var(--slot)';
      node.appendChild(probe);
      const tokenColor = getComputedStyle(probe).color;
      probe.remove();
      out[state] = { color: style.borderLeftColor, tokenColor, slot: style.getPropertyValue('--slot').trim(), width: style.borderLeftWidth, borderStyle: style.borderLeftStyle, background: style.backgroundColor };
    }
    return out;
  })()`);
  const toolStateProblems = toolStates.filter((state) => {
    const row = toolStateSlots[state];
    return !(row.color === row.tokenColor && row.slot !== '' && row.width === '3px' && row.borderStyle === 'solid'
      && row.background === hexToRgb(toolStateBackgrounds[state]));
  }).map((state) => ({ state, ...toolStateSlots[state], expectedBackground: hexToRgb(toolStateBackgrounds[state]) }));
  slotCheck('slot:tool-state-token', toolStateProblems.length === 0,
    { rows: toolStateSlots, problems: toolStateProblems, rule: '计算槽色 == 元素自己那条 `--slot` 的解析色；宽 3px / solid；状态底色仍在' });

  // 源码腿：**注释先剔除**再扫（别把注释里的字当代码 —— 本仓栽过）。
  const indexedSource = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  const indexedCss = indexedSource.replace(/\/\*[\s\S]*?\*\//g, '');
  const hardcodedBorders = [];
  for (const match of indexedCss.matchAll(/(border-left-color|border-inline-start-color)\s*:\s*([^;}]+)/g)) {
    const value = match[2].trim();
    if (!/^var\(/.test(value)) hardcodedBorders.push(`${match[1]}: ${value}`);
  }
  const missingStateBackgrounds = Object.entries(toolStateBackgrounds)
    .filter(([state, color]) => !new RegExp(`\\.tool-card\\[data-state="${state}"\\][^{}]*\\{[^}]*background-color:\\s*${color}\\s*[;}]`).test(indexedCss))
    .map(([state, color]) => `${state} → ${color}`);
  slotCheck('slot:tool-state-source', hardcodedBorders.length === 0 && missingStateBackgrounds.length === 0,
    { scanned: path.join(webRoot, 'index.html'), armCopy: ARM ? '反证臂副本（web/ 的拷贝）' : null, hardcodedBorders, missingStateBackgrounds,
      rule: '边色声明的值必须走 var(…)（槽色只由 `--slot-*` 表达）；四条状态底色必须仍在' });

  const controls = await evaluate(`(() => {
    const color=(selector)=>getComputedStyle(document.querySelector(selector)).borderLeftColor;
    const probe=(node)=>{ const style=getComputedStyle(node); const rect=node.getBoundingClientRect(); return {tag:node.tagName,id:node.id,disabled:node.disabled,disabledAttr:node.getAttribute('disabled'),data:{...node.dataset},focused:node.matches(':focus'),slot:style.getPropertyValue('--slot').trim(),borderInlineStartColor:style.borderInlineStartColor,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}; };
    const neutral=color('#new-session-toggle'); const primary=color('#send');
    const abort=document.querySelector('#abort'); abort.disabled=false; const danger=getComputedStyle(abort).borderLeftColor; abort.disabled=true;
    const prompt=document.querySelector('#prompt'); prompt.focus(); const focused=getComputedStyle(prompt).borderLeftColor; const focusedProbe=probe(prompt); prompt.disabled=true;
    return {neutral,primary,danger,focused,focusedProbe};
  })()`);
  const disabledProbe = await waitFor(() => evaluate(`(() => { const node=document.querySelector('#prompt'); const style=getComputedStyle(node); const root=getComputedStyle(document.documentElement); if(!node.disabled || style.getPropertyValue('--slot').trim() !== root.getPropertyValue('--slot-dark').trim()) return null; const rect=node.getBoundingClientRect(); return {tag:node.tagName,id:node.id,disabled:node.disabled,disabledAttr:node.getAttribute('disabled'),data:{...node.dataset},focused:node.matches(':focus'),slot:style.getPropertyValue('--slot').trim(),borderInlineStartColor:style.borderInlineStartColor,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}; })()`), 'disabled prompt slot did not settle');
  Object.assign(controls, { disabled: disabledProbe.borderInlineStartColor, disabledProbe }, await evaluate(`(() => {
    const prompt=document.querySelector('#prompt'); prompt.disabled=false;
    const notice=document.querySelector('#notice'); const levels={}; for(const level of ['info','warn','error']) { notice.dataset.level=level; levels[level]=getComputedStyle(notice).borderLeftColor; }
    const palette=Array.from(document.querySelectorAll('.command-palette-item')).map((node)=>({name:node.dataset.commandName,color:getComputedStyle(node).borderLeftColor,selected:node.classList.contains('selected')}));
    return {levels,palette};
  })()`));
  assert.equal(new Set([controls.neutral, controls.primary, controls.danger, controls.disabled]).size, 4, JSON.stringify(controls));
  assert.equal(controls.focused, controls.primary);
  assert.equal(new Set(Object.values(controls.levels)).size, 3);
  const tui = controls.palette.find((row) => row.name === 'settings');
  const unrestored = controls.palette.find((row) => row.name === 'export');
  assert.notEqual(tui.color, unrestored.color);
  print('controls + notice + command semantics', controls);

  const switchResult = await evaluate(`(() => { const target=document.querySelector('.message-user'); const peer=document.querySelector('.message-assistant'); const before=getComputedStyle(peer).borderLeftWidth; target.dataset.slot='off'; return {target:getComputedStyle(target).borderLeftWidth,peer:getComputedStyle(peer).borderLeftWidth,before}; })()`);
  assert.deepEqual(switchResult, { target: '0px', peer: '3px', before: '3px' });
  print('per-element data-slot=off', switchResult);

  // 逐元素撤销开关在**按钮**上也要真的关得掉（H-16/U-19 的契约：`data-slot="off"` 可逐元素撤销）。
  // 改前它在按钮上**失效** —— `slot.css` 的原语里 `button:not(…)×7` 是 (0,7,1)，而它只有 (0,1,0)，
  // 两条都是 `!important` 时按特异性判 ⇒ `web/index.html` 上真写着 `data-slot="off"` 的
  // `#session-notice-close` / `#suggestions-close` 实测仍是 `3px`（只有 `input` 那条 (0,0,1) 碰巧赢）。
  // 现在它住在 `@layer slot-off` 里（分层 `!important` 压过未分层的，与特异性无关）⇒ 按钮也归零，
  // 且**不带 off** 的按钮照旧 `3px`（不是把整页的槽关掉）。
  const switchButtons = await evaluate(`(() => {
    const width = (node) => (node ? getComputedStyle(node).borderInlineStartWidth : 'missing');
    const probe = document.createElement('button');
    probe.type = 'button'; probe.dataset.slot = 'off';
    document.body.appendChild(probe);
    const injected = width(probe);
    probe.remove();
    return {
      noticeClose: width(document.querySelector('#session-notice-close')),
      suggestionsClose: width(document.querySelector('#suggestions-close')),
      injected,
      send: width(document.querySelector('#send')),
    };
  })()`);
  assert.deepEqual(switchButtons, { noticeClose: '0px', suggestionsClose: '0px', injected: '0px', send: '3px' });
  print('per-element data-slot=off on buttons', switchButtons);

  await screenshot(screenshotWide);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  // 最挤组合此时已全部成立：未读条 + 设备面板 + 展开的新建表单 + 展开的存档箱。
  // 等布局稳定后先读一轮几何（强制 reflow），再等一帧拍图；避免把重排中的撕裂帧当成叠印。
  await new Promise((resolve) => setTimeout(resolve, 500));
  const narrow = await evaluate(`(() => {
    const body=getComputedStyle(document.body); const aside=document.querySelector('aside.tree'); const asideRect=aside.getBoundingClientRect();
    const rect=(node)=>{const r=node.getBoundingClientRect();return {name:node.id||node.className||node.tagName,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
    const overlaps=(items)=>items.flatMap((left,index)=>items.slice(index+1).filter((right)=>Math.min(left.right,right.right)>Math.max(left.left,right.left)&&Math.min(left.bottom,right.bottom)>Math.max(left.top,right.top)).map((right)=>[left.name,right.name]));
    const children=Array.from(aside.children).filter((node)=>getComputedStyle(node).display!=='none').map(rect);
    const rows=Array.from(aside.querySelectorAll('.tree-session')).filter((node)=>getComputedStyle(node).display!=='none').map((node)=>{const r=node.getBoundingClientRect(); const pane=(node.closest('[data-active-tree-list]')||node.closest('[data-attic-list]')||node).getBoundingClientRect(); const top=Math.max(r.top,pane.top),bottom=Math.min(r.bottom,pane.bottom),left=Math.max(r.left,pane.left),right=Math.min(r.right,pane.right); return {name:node.dataset.sessionId,top,bottom,left,right,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};}).filter((row)=>row.height>.5&&row.width>.5);
    const tree=document.querySelector('#tree'); const treeRect=tree.getBoundingClientRect(); const active=document.querySelector('[data-active-tree-list="true"]'); const activeRect=active.getBoundingClientRect(); const archive=document.querySelector('[data-attic="true"]'); const archiveRect=archive.getBoundingClientRect(); const list=document.querySelector('[data-attic-list="true"]'); const first=active.querySelector('.tree-session'); const firstRect=first.getBoundingClientRect(); const treeStyle=getComputedStyle(tree);
    return {bodyBg:body.backgroundColor,rowHeight:firstRect.height,asideWidth:asideRect.width,aside:{top:asideRect.top,bottom:asideRect.bottom,clientHeight:aside.clientHeight,scrollHeight:aside.scrollHeight,overflowY:getComputedStyle(aside).overflowY},children,childOverlaps:overlaps(children),rowOverlaps:overlaps(rows),tree:{top:treeRect.top,bottom:treeRect.bottom,clientHeight:tree.clientHeight,scrollHeight:tree.scrollHeight,overflowY:treeStyle.overflowY},split:{activeHeight:activeRect.height,archiveHeight:archiveRect.height,ratio:activeRect.height/archiveRect.height,activeOverflow:getComputedStyle(active).overflowY,atticOverflow:getComputedStyle(list).overflowY,activeScrollable:active.scrollHeight>active.clientHeight,atticScrollable:list.scrollHeight>list.clientHeight},outsideRows:rows.filter((row)=>row.top<asideRect.top-1||row.bottom>asideRect.bottom+1).map((row)=>row.name),first:{top:firstRect.top,bottom:firstRect.bottom,inFirstScreen:firstRect.top>=asideRect.top&&firstRect.bottom<=asideRect.bottom,inTreeViewport:firstRect.top>=activeRect.top&&firstRect.bottom<=activeRect.bottom},maxRadius:Math.max(...Array.from(document.querySelectorAll('button,input,textarea,.message')).map((node)=>parseFloat(getComputedStyle(node).borderRadius)||0)),shadows:Array.from(document.querySelectorAll('*')).filter((node)=>getComputedStyle(node).boxShadow!=='none').length};
  })()`);
  assert.equal(narrow.bodyBg, 'rgb(15, 16, 19)');
  assert.equal(narrow.rowHeight, 26);
  assert.equal(narrow.childOverlaps.length, 0, JSON.stringify(narrow));
  assert.equal(narrow.rowOverlaps.length, 0, JSON.stringify(narrow));
  assert.equal(narrow.first.inFirstScreen, true, JSON.stringify(narrow));
  assert.equal(narrow.first.inTreeViewport, true, JSON.stringify(narrow));
  assert.ok(narrow.split.activeHeight >= 52, JSON.stringify(narrow));
  assert.ok(narrow.split.archiveHeight >= 52, JSON.stringify(narrow));
  assert.ok(Math.abs(narrow.split.ratio - 1) <= .2, JSON.stringify(narrow));
  // 窄屏同样要求两条独立滚动轴：分区自己滚，不是整条左栏一个滚动条。
  assert.match(narrow.split.activeOverflow, /^(auto|scroll)$/, JSON.stringify(narrow.split));
  assert.match(narrow.split.atticOverflow, /^(auto|scroll)$/, JSON.stringify(narrow.split));
  assert.equal(narrow.split.activeScrollable, true, JSON.stringify(narrow.split));
  assert.equal(narrow.split.atticScrollable, true, JSON.stringify(narrow.split));
  assert.ok(narrow.maxRadius <= 2, JSON.stringify(narrow));
  assert.equal(narrow.shadows, 0);
  await evaluate(`(() => { const aside=document.querySelector('aside.tree'); aside.scrollTop=aside.scrollHeight-aside.clientHeight; return aside.scrollTop; })()`);
  await browser.send('Runtime.evaluate', { expression: 'document.body.getBoundingClientRect().height', returnByValue: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await screenshot(screenshotNarrow);
  print('responsive visual contract + crowded sidebar geometry', narrow);

  print('screenshots', { wideOpen: screenshotWide, wideClosed: screenshotWideClosed, narrowOpen: screenshotNarrow });
  print('chromium', { product: version.Browser, chrome, port, debugPort, forbiddenPortsUsed: false });
  if (ARM) {
    const arm = ARM_MUTANTS[ARM];
    const red = [...new Set(slotRed)];
    print(`反证臂 ${ARM} 结果`, { what: arm.what, expect: arm.expect, expectGreen: arm.expectGreen ?? [], actuallyRed: red });
    const notRed = arm.expect.filter((id) => !red.includes(id));
    const wronglyRed = (arm.expectGreen ?? []).filter((id) => red.includes(id));
    if (notRed.length === 0 && wronglyRed.length === 0) {
      print('RESULT', `反证臂 ${ARM} 红到位（这是**期望**的结果，不是缺陷）`);
    } else {
      print('RESULT', `反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}；本该留绿却红了 ${JSON.stringify(wronglyRed)} ⇒ 这道门是个假门`);
      process.exitCode = 1;
    }
  } else {
    print('RESULT', 'S1a-2 v2.2 slot language PASS');
  }
} catch (error) {
  primaryError = error;
} finally {
  // 沙箱清理走共享助手（原来 finally 里的裸 `rm` 会把「临时 profile 还在写」的 ENOTEMPTY
  // 变成整道门的失败，替掉真正的断言结果）。
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  await cleanupStep(cleanupProblems, 'stop chromium', async () => {
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
  });
  await cleanupStep(cleanupProblems, 'close server', async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
