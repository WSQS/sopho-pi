#!/usr/bin/env node
// test/drag-select-cost.mjs —— 「跨栏拖选」卡顿门（业主 2026-09-21 报的：Windows + Firefox，
// 在正文里按下左键拖选、把指针挪到**左边会话栏**上空 ⇒ 主线程卡很长一段时间）。
//
// 形状：只读 `web/` 源码 + 假 API + 真浏览器，两平台同一条量尺：
//   · Firefox 156 起 Remote Agent 只说 WebDriver **BiDi**（`--remote-debugging-port` 起来后 /json/version
//     是 404；CDP 那个面没了）⇒ 这里用 BiDi 的 `input.performActions` 做**真**指针拖选（实测可用）；
//   · Chromium 走 `Input.dispatchMouseEvent`。
// 量的是**页面自己看到的时间**（不靠宿主时钟）：页面在 capture 阶段记下每个 mousemove 的
// `performance.now()`，`moveGapMax` = 相邻两个 mousemove 的最大间隔 ⇒ 就是主线程被卡住的时长。
// 另外记 Firefox/Chromium 的 longtask（Firefox 不支持该 entry 类型，为 null 属预期）。
//
// 四条臂（每条都真拖一次，夹具同一份）：
//   ① within       —— 只在正文里拖（对照：这个手势本身很便宜）
//   ② across       —— 跨到左栏（**修法生效**：`web/app.js` 的选区护栏 + `index.html` 那条 data-sel-clamp）
//   ③ across-no-cv —— 跨到左栏，但运行时把 `content-visibility` 换成 `visible`（分层臂：
//                    证明贵的是「为选区补布局」，不是 Range 本身 —— Range 依然覆盖整段正文）
//   ④ across-no-guard —— 跨到左栏，把修法**摘掉**（反证臂：把 data-sel-clamp 的
//                    `content-visibility` 用 `!important` 顶回 `auto`，其余一字不改）
//
// 修法为什么是这两句：
//   指针一离开 `#messages`，Range 的起点就落到 `<main>` 之前（树在 DOM 里排在 main 前面）⇒ 这一次
//   拖选把「#messages 开头 → 锚点」整段旧正文都圈进选区。大会话里那些节点带 `content-visibility: auto`
//   （`index.html`），被 Range 覆盖就成为「对用户相关」⇒ 浏览器必须为它们补出真实布局。护栏把**已滚出
//   可视区**的那些节点临时标成 `content-visibility: hidden`（无条件跳过 ⇒ 够不着、也不必补布局）。
//
// 阈值依据（本机 2026-09-21 实测，15 MB 夹具 / 1521 条，中位）：
//   Firefox 156：within ≈ 33 ms、across（修后）≈ 33 ms、across-no-guard ≈ 750–900 ms、across-no-cv ≈ 50 ms
//   Chromium 129：within ≈ 45 ms、across（修后）≈ 400 ms、across-no-guard ≈ 650 ms、across-no-cv ≈ 210 ms
//   ⇒ Firefox 门限 200 ms（修后 33 ms 的 6×，修前 750 ms 的 1/4）；反证下限 300 ms。
//   Chromium 只断言「护栏不比不装护栏更差」（它在 Chromium 上只是部分改善，见交付报告）。
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, processAlive, processCommandLine, processGroupId, processInfoOf, processTable, removeSandbox } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SOPHO_DRAGSEL_WEB_ROOT：把门指向另一份 web/ 快照（「修前红」的对照跑法，与 test/ui-harness.mjs 同一套纪律）。
const WEB_ROOT = process.env.SOPHO_DRAGSEL_WEB_ROOT ? path.resolve(process.env.SOPHO_DRAGSEL_WEB_ROOT) : path.join(ROOT, 'web');
const ARTIFACT_ROOT = process.env.SOPHO_DRAGSEL_ARTIFACT_DIR || path.join(os.tmpdir(), 'sopho-drag-select');
const FIREFOX_BIN = process.env.FIREFOX_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/Mozilla Firefox/firefox.exe'
  : '/usr/bin/firefox');
const CHROME_BIN = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
  : '/usr/bin/chromium');

const BIG_ID = '11111111-1111-4111-8111-111111111111';
const BIG_COUNT = Number(process.env.SOPHO_DRAGSEL_MESSAGES ?? 1521);
const TREE_COUNT = Number(process.env.SOPHO_DRAGSEL_TREE ?? 300);
const ROUNDS = Number(process.env.SOPHO_DRAGSEL_ROUNDS ?? 3);
// 门限只对 Firefox 生效（修法在那里是 10× 以上的量级差；Chromium 见文件头）。
const FIREFOX_LIMIT_MS = Number(process.env.SOPHO_DRAGSEL_LIMIT_MS ?? 200);
const RED_MIN_MS = Number(process.env.SOPHO_DRAGSEL_RED_MS ?? 300);
const WITHIN_LIMIT_MS = Number(process.env.SOPHO_DRAGSEL_WITHIN_MS ?? 150);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

function report(name, ok, detail) {
  process.stdout.write(`${ok ? '✓' : '·'} ${name} —— ${detail}\n`);
}

// Chrome/Firefox 都拒绝连「不安全端口」，而 reservePort 抽到的端口里可能有它们。这里直接避开那一串。
const BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const reservePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const { port } = listener.address();
    listener.close(() => (BLOCKED_PORTS.has(port) ? reservePort().then(resolve, reject) : resolve(port)));
  });
});

// ─── 夹具：1521 条 × ~10 KB（≈15 MB，与 docs/history 记的正式已知形状同量级）+ 300 行树 ───────
const fillerUnit = '保持大会话正文形状的中文填充句子。';
const bigFiller = fillerUnit.repeat(169);
const bigMessages = Array.from({ length: BIG_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [
    { type: 'text', text: `BIGMSG${index}：${bigFiller}` },
    { type: 'tool', name: 'bash', status: 'done-success', args: { command: `echo ${index}` }, result: `工具结果 ${index}：\n\`\`\`\n${bigFiller.slice(0, 600)}\n\`\`\`` },
  ],
}));
const bigBody = JSON.stringify({ messages: bigMessages, extras: [], compaction: { atIndex: null }, observability: null });
const sessions = [
  { id: BIG_ID, name: '大会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ...Array.from({ length: TREE_COUNT }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    name: `会话 ${index}`, parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false,
    modifiedAt: '2026-09-20T00:00:00.000Z', notify: { notifies: [], waitingFor: [] },
  })),
];

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}
const contentType = (file) => file.endsWith('.html') ? 'text/html; charset=utf-8'
  : (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript; charset=utf-8'
    : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';

async function startStaticServer(port) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message))?$/.exec(url.pathname);
    if (match) {
      const id = match[1];
      const action = match[2] ?? null;
      const row = sessions.find((item) => item.id === id);
      if (!row) return sendJson(response, 404, { message: 'not found' });
      if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null });
      if (action === 'messages') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bigBody), 'cache-control': 'no-store' });
        return response.end(bigBody);
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'message') return sendJson(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
    }
    const file = path.resolve(WEB_ROOT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${WEB_ROOT}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      return response.end(content);
    } catch { return response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// ─── 收尾：把浏览器**整棵树**收干净（按平台分支） ─────────────────────────────────────
// Windows 仍是 `taskkill.exe /PID <pid> /T /F`（一字不改）；POSIX 上用浏览器**自建进程组**
// （spawn 时 detached，组长就是 child.pid）整组 SIGKILL，再扫一遍进程表兜底。
// 两条路都守同一批红线：动手前先确认「该 pid 的命令行里有本次沙箱路径」（拒杀口径不变）；
// 只按精确 pid / 自建进程组撕，绝不 pkill、绝不按进程名匹配 —— 模式会匹到**自己那条命令行上**
// （本仓踩过四次），所以枚举一律问 `test/harness.mjs`（`processTable` / `processInfoOf` /
// `processGroupId` / `processAlive` / `processCommandLine`），本文件里不出现 procfs 字面量。

// 自身 pid + 祖先链：收尾扫进程表时排除它们。
async function selfAndAncestors() {
  const chain = new Set([process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 32; depth += 1) {
    const info = await processInfoOf(current);
    const ppid = info?.ppid;
    if (!Number.isInteger(ppid) || ppid <= 1 || chain.has(ppid)) break;
    chain.add(ppid);
    current = ppid;
  }
  return chain;
}

// 「命令行里含某个标记串的进程」——与拒杀检查同一套口径（扫进程表，不 pgrep）。
// ⚠️ marker 的作用域必须**一个引擎一个**（各引擎自己的 profile 目录）：两个引擎同跑时，
// 整个沙箱路径是它们共有的 —— 拿它当收尾口径，Firefox 的收尾会顺手把**还在跑的 Chromium**
// 整棵杀掉（2026-09-21 实测：firefox close 的 survivors 就是 10 个 chromium 进程），
// 于是后面的 CDP 调用永远等不到回应、门静默停住。
// 整轮收尾自证那处仍然按**整个沙箱**扫（那里要的正是「全都没了」）。
async function sandboxProcesses(marker, exclude) {
  const rows = [];
  for (const row of await processTable()) {
    if (exclude.has(row.pid)) continue;
    const commandLine = row.commandLine ?? '';
    if (commandLine.includes(marker)) rows.push({ pid: row.pid, commandLine });
  }
  return rows;
}

// 自建进程组里还活着的成员（僵尸除外）。crashpad handler 那种「命令行里不含沙箱路径」的成员
// 只能靠这一条看见 —— 所以「真的没了」不能只查命令行。
async function processGroupMembers(pgid) {
  if (!pgid) return [];
  const members = [];
  for (const row of await processTable({ withCommandLine: false })) {
    if (row.state === 'Z') continue;
    if (row.pgid === pgid) members.push(row.pid);
  }
  return members;
}

// 只有当进程组确实是**它自己的**、且不是我们自己那一组时，才把 pgid 当收尾依据。否则为 null
// （拿自己那一组做「成员检查」会把自己的 shell 也算进来）。
async function ownProcessGroupForKill(pid) {
  const pgid = await processGroupId(pid);
  if (pgid === null || pgid !== pid) return null;
  return pgid === (await processGroupId(process.pid)) ? null : pgid;
}

async function browserSurvivors(pid, group, marker) {
  const byCommandLine = (await sandboxProcesses(marker, await selfAndAncestors())).map((row) => row.pid);
  const byGroup = await processGroupMembers(group);
  const pids = new Set([...byCommandLine, ...byGroup]);
  if (await processAlive(pid)) pids.add(pid);
  return [...pids];
}

async function killSpawnedBrowser(pid, marker, label) {
  if (!pid) return `${label}: 没拿到 pid，不杀`;
  const commandLine = await processCommandLine(pid).catch(() => '');
  if (!commandLine || !commandLine.includes(marker)) return `${label}: pid ${pid} 的命令行不含本引擎的 profile 路径，拒杀（` + `${commandLine.slice(0, 120)}）`;
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const after = await processCommandLine(pid).catch(() => '');
      if (!after) return null;
      await sleep(50);
    }
    return `${label}: taskkill 之后 pid ${pid} 还在`;
  }
  const group = await ownProcessGroupForKill(pid);
  const killVerb = group ? `kill(-${group})` : `kill(${pid})`;
  try {
    if (group) process.kill(-group, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw new Error(`${label}: ${killVerb} 失败：${error.message}`);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const survivors = await browserSurvivors(pid, group, marker);
    if (survivors.length === 0) return null;
    // 第二轮还没死透就按精确 pid 再补一遍（跑出进程组的漏网之鱼 / 刚被 fork 出来的子进程）。
    if (attempt === 1) {
      for (const survivor of survivors) {
        try { process.kill(survivor, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw new Error(`${label}: kill(${survivor}) 失败：${error.message}`); }
      }
    }
    await sleep(50);
  }
  return `${label}: ${killVerb} 之后还有残留（主 pid ${pid}；仍在：${(await browserSurvivors(pid, group, marker)).join(',')}）`;
}

// ─── 一条 websocket 通道 = 一串带 id 的请求 ────────────────────────────────────────
// 每个请求都要有**上限**，且 socket 一断就把未决请求全部拒掉 —— 否则浏览器没了的时候
// （例如被谁顺手杀掉）`await send(...)` 会永远挂着：门停在那里、一行日志都不打。
// 2026-09-21 在 Linux 上实测过这一幕（EXIT=124，日志停在 `chromium 版本: ...`）。
const SEND_TIMEOUT_MS = Number(process.env.SOPHO_DRAGSEL_SEND_TIMEOUT_MS ?? 120000);
function messageChannel(socket, label) {
  let sequence = 0;
  const pending = new Map();
  const failAll = (reason) => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const waiter of waiting) waiter.reject(new Error(`${label}：${reason}`));
  };
  socket.addEventListener('close', () => failAll('websocket 已断开（浏览器没了？）'), { once: true });
  socket.addEventListener('error', () => failAll('websocket 出错'), { once: true });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === 'error' || message.error) reject(new Error(JSON.stringify(message.error ?? message)));
    else resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${label}：${method} 超过 ${SEND_TIMEOUT_MS} ms 没有回应`));
    }, SEND_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

// 起过的浏览器都登记在这里（含「起了、但后面没起来」的那种）。detached（POSIX）起的浏览器
// **不随我们死**：任何早退路径（BiDi 没起来、断言红、send 超时）都可能把孤儿留在 /tmp 里，
// 所以收尾统一按这里的登记（精确 pid + 本引擎 profile 标记）收。close 幂等：成功路径上循环里
// 已经关过，收尾再叫一次是空跑。
const spawned = new Map();
async function closeSpawned(name) {
  const entry = spawned.get(name);
  if (!entry || entry.closed) return null;
  entry.closed = true;
  return killSpawnedBrowser(entry.pid, entry.marker, name);
}

async function startFirefox(sandbox, port) {
  const debugPort = await reservePort();
  // `--profile` 指的目录必须**先存在**：Linux 上的 Firefox 156 面对不存在的 profile 目录直接退出
  // （stderr `Could not find profile folder.`）⇒ 整条臂静默 SKIP、四道断言根本没跑。
  // Windows 那份容忍缺失的目录，但先建好对它是等价的（空目录正是它本来要初始化的那个）。
  const profileDir = path.join(sandbox, 'firefox-profile');
  await mkdir(profileDir, { recursive: true });
  // detached（POSIX）：自建进程组 ⇒ 收尾能整组收干净；Windows 保持原样（libuv 的 job object / taskkill /T 管）。
  // 沙箱根用**本引擎自己的 profile 目录**（不是整条 sandbox）：私有 HOME/TMPDIR/XDG 都建在它下面 ⇒
  // crashpad handler 的 `--database` 也落在它下面 ⇒ handler 的命令行带上了**本引擎的认领标记**，
  // 收尾（`browserSurvivors` 的按标记那一腿）才看得见它（handler 会 setsid/reparent，进程组那腿抓不到）。
  const child = spawn(FIREFOX_BIN, ['--headless', '--no-remote', '--profile', profileDir, `--remote-debugging-port=${debugPort}`, 'about:blank'], { env: browserSandboxEnv(profileDir), stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  spawned.set('firefox', { pid: child.pid, marker: profileDir, closed: false });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let wsUrl = null;
  for (let attempt = 0; attempt < 120 && !wsUrl; attempt += 1) {
    await sleep(250);
    const match = stderr.match(/listening on (ws:\/\/[^\s]+)/);
    if (match) wsUrl = match[1];
  }
  if (!wsUrl) throw new Error(`Firefox 的 WebDriver BiDi 没起来（stderr 前 400 字）：${stderr.slice(0, 400)}`);
  const socket = new WebSocket(wsUrl.replace(/\/$/, '') + '/session');
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('BiDi websocket 连不上')), { once: true });
  });
  const send = messageChannel(socket, 'firefox BiDi');
  const session = await send('session.new', { capabilities: {} });
  const contexts = await send('browsingContext.getTree', {});
  const context = contexts.contexts[0].context;
  await send('browsingContext.navigate', { context, url: `http://127.0.0.1:${port}/#${BIG_ID}`, wait: 'complete' });
  const ev = async (expression) => {
    const result = await send('script.evaluate', {
      expression: `JSON.stringify((()=>{return (${expression})})())`,
      target: { context }, awaitPromise: true, resultOwnership: 'none',
    });
    return JSON.parse(result.result.value);
  };
  return {
    engine: `firefox ${session.capabilities.browserVersion}`,
    version: session.capabilities.browserVersion,
    ev,
    async drag(from, to) {
      const started = Date.now();
      await send('input.performActions', {
        context,
        actions: [{
          type: 'pointer', id: 'drag-mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(from[0]), y: Math.round(from[1]), duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: Math.round(to[0]), y: Math.round(to[1]), duration: 400 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      return Date.now() - started;
    },
    close: () => closeSpawned('firefox'),
  };
}

async function startChromium(sandbox, port) {
  const debugPort = await reservePort();
  const profileDir = path.join(sandbox, 'chromium-profile');
  // detached（POSIX）：同上，自建进程组，收尾 `kill(-pgid)` 一次把 zygote/renderer/gpu 全收走；
  // 沙箱根同样用本引擎自己的 profile 目录（理由见 startFirefox 上面那段：handler 靠**标记**认领）。
  const child = spawn(CHROME_BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-proxy-server', '--proxy-bypass-list=*', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank'], { env: browserSandboxEnv(profileDir), stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  spawned.set('chromium', { pid: child.pid, marker: profileDir, closed: false });
  let version = null;
  for (let attempt = 0; attempt < 120 && !version; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) version = await response.json();
    } catch {}
  }
  if (!version) throw new Error('Chromium 的 remote debugger 没起来');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const send = messageChannel(socket, 'chromium CDP');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/#${BIG_ID}` });
  await sleep(500);
  const ev = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{return (${expression})})())`,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'browser evaluation failed');
    return JSON.parse(result.result.value);
  };
  return {
    engine: `chromium ${version.Browser}`,
    version: version.Browser,
    ev,
    async drag(from, to) {
      const started = Date.now();
      const steps = 12;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from[0]), y: Math.round(from[1]), button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(from[0]), y: Math.round(from[1]), button: 'left', buttons: 1, clickCount: 1 });
      for (let index = 1; index <= steps; index += 1) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(from[0] + ((to[0] - from[0]) * index) / steps),
          y: Math.round(from[1] + ((to[1] - from[1]) * index) / steps),
          button: 'left', buttons: 1,
        });
        await sleep(16);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(to[0]), y: Math.round(to[1]), button: 'left', buttons: 0, clickCount: 1 });
      return Date.now() - started;
    },
    close: () => closeSpawned('chromium'),
  };
}

// ─── 一条臂 = 一次真拖选 + 页面自己记的时间 ─────────────────────────────────────────────
const setOverrides = (noCv, noGuard) => `(()=>{window.__noCv.sheet.disabled=${noCv ? 'false' : 'true'};window.__noGuard.sheet.disabled=${noGuard ? 'false' : 'true'};return true;})()`;
async function measure(driver, { from, to, setup }) {
  await driver.ev(setOverrides(false, false));
  await driver.ev('(()=>{window.getSelection().removeAllRanges();window.__rec.moves=[];window.__rec.scrollChanges=[];window.__long=[];window.__t0=performance.now();return true;})()');
  if (setup) await driver.ev(setup);
  const wallMs = await driver.drag(from, to);
  const record = await driver.ev(`(()=>{
    const t0 = window.__t0;
    const rel = (list) => list.map((value) => Math.round(value - t0));
    const moves = rel(window.__rec.moves);
    let gapMax = 0;
    for (let index = 1; index < moves.length; index += 1) gapMax = Math.max(gapMax, moves[index] - moves[index - 1]);
    return {
      gapMax, moves: moves.length, long: window.__long, longErr: window.__longErr,
      selLen: String(window.getSelection()).length, selType: window.getSelection().type,
      scrollHeight: document.querySelector('#messages').scrollHeight,
      scrollTop: Math.round(document.querySelector('#messages').scrollTop),
      clampMarks: window.__rec.clampPeak ?? 0,
    };
  })()`);
  return { wallMs, ...record };
}

const percentile = (values, quantile) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
};

const problems = [];
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-dragselect-'));
await mkdir(ARTIFACT_ROOT, { recursive: true });
let port = 0;
let server = null;
let primaryError = null;
try {
  port = await reservePort();
  server = await startStaticServer(port);
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : 'all';
  const engines = [];
  for (const name of only === 'all' ? ['firefox', 'chromium'] : [only]) {
    const start = name === 'firefox' ? startFirefox : startChromium;
    try {
      engines.push({ name, driver: await start(sandbox, port) });
    } catch (error) {
      // 没装 / 起不来一律如实说，不装作跑过。两个都没有就来真的红。
      report(`启动 ${name}`, false, `SKIP —— ${error.message}`);
    }
  }
  if (engines.length === 0) throw new Error('Firefox 与 Chromium 都起不来：本门无法测量');

  for (const { name, driver } of engines) {
    print(`${name} 版本`, driver.version);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = await driver.ev(`(()=>{const m=document.querySelector('#messages');return {complete:m?m.dataset.renderComplete:null, virtual:m?m.dataset.virtual:null, children:m?m.children.length:0};})()`);
      if (state.complete === 'true') break;
      await sleep(200);
    }
    const fixture = await driver.ev(`(()=>{
      const m = document.querySelector('#messages');
      return { children: m.children.length, virtual: m.dataset.virtual, textLength: m.textContent.length, scrollHeight: m.scrollHeight, domNodes: document.getElementsByTagName('*').length, treeRows: document.querySelectorAll('.tree-session').length };
    })()`);
    print(`${name} 夹具`, fixture);
    await driver.ev(`(()=>{
      const style = document.createElement('style');
      style.id = '__no-guard';
      // ④ 反证臂：把护栏那条 CSS 用 !important 顶回 auto —— 这就是「把修法摘掉」，其余一字不改。
      style.textContent = '#messages[data-virtual="true"] [data-sel-clamp="1"] { content-visibility: auto !important; }';
      document.head.appendChild(style);
      style.sheet.disabled = true;
      window.__noGuard = style;
      // ③ 分层臂：把 content-visibility 整体换成 visible（Range 依然覆盖整段正文）。
      const layer = document.createElement('style');
      layer.id = '__no-cv';
      layer.textContent = '#messages .message, #messages .extra-message, #messages .compaction-note, #messages .tool-card { content-visibility: visible !important; contain-intrinsic-size: auto !important; }';
      document.head.appendChild(layer);
      layer.sheet.disabled = true;
      window.__noCv = layer;
      const rec = { moves: [], scrollChanges: [], clampPeak: 0 };
      window.__rec = rec;
      window.addEventListener('mousemove', () => rec.moves.push(performance.now()), true);
      // 护栏打的标记在 pointerup 就撤了，所以量的不是「拖完还剩几个」，而是「拖的过程里最多同时挂着几个」
      // （这只是测试侧的观察器，产品代码一字未改）。为 0 就说明护栏压根没上，across 那臂的数字不算数。
      new MutationObserver(() => {
        rec.clampPeak = Math.max(rec.clampPeak, document.querySelectorAll('#messages [data-sel-clamp]').length);
      }).observe(document.querySelector('#messages'), { attributes: true, attributeFilter: ['data-sel-clamp'], subtree: true });
      window.__long = [];
      window.__longErr = null;
      try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)); }).observe({ type: 'longtask', buffered: false }); }
      catch (error) { window.__longErr = String(error); }
      return true;
    })()`);
    const points = await driver.ev(`(()=>{
      const m = document.querySelector('#messages');
      const box = m.getBoundingClientRect();
      const tree = document.querySelector('#tree').getBoundingClientRect();
      return {
        from: [box.x + Math.min(240, box.width * 0.4), box.y + box.height * 0.45],
        withinTo: [box.x + Math.min(340, box.width * 0.5), box.y + box.height * 0.45 + 60],
        acrossTo: [tree.x + tree.width * 0.5, tree.y + tree.height * 0.5],
        box: [box.x, box.y, box.width, box.height],
      };
    })()`);
    await driver.ev('(()=>{const m=document.querySelector("#messages");m.scrollTop=m.scrollHeight;return true;})()');
    await sleep(600);

    const arms = {
      // setup 只在「开一条覆盖」时给；每轮开头都把两条覆盖重置成本臂要的状态。
      within: { to: points.withinTo, setup: setOverrides(false, false) },
      across: { to: points.acrossTo, setup: setOverrides(false, false) },
      'across-no-cv': { to: points.acrossTo, setup: setOverrides(true, false) },
      'across-no-guard': { to: points.acrossTo, setup: setOverrides(false, true) },
    };
    const results = {};
    for (const [label, arm] of Object.entries(arms)) {
      const rounds = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const measured = await measure(driver, { from: points.from, to: arm.to, setup: arm.setup });
        rounds.push(measured);
      }
      results[label] = rounds;
    }
    await driver.ev(setOverrides(false, false));
    print(`${name} 原始（每臂 ${ROUNDS} 轮）`, Object.fromEntries(Object.entries(results).map(([label, rounds]) => [label, rounds.map((r) => ({
      gapMax: r.gapMax, wallMs: r.wallMs, selLen: r.selLen, moves: r.moves, long: r.long, clampMarks: r.clampMarks, scrollHeight: r.scrollHeight,
    }))])));
    // 冷启动那一轮两台机器都会慢（Chromium 实测第一轮 1.5–3.3 s），中位取「后两轮」更稳，但也把首轮原样印出来。
    const summary = Object.fromEntries(Object.entries(results).map(([label, rounds]) => {
      const warm = rounds.slice(1).map((r) => r.gapMax);
      return [label, { median: percentile(warm.length ? warm : rounds.map((r) => r.gapMax), 0.5), max: Math.max(...rounds.map((r) => r.gapMax)), first: rounds[0].gapMax, selLen: rounds[rounds.length - 1].selLen, clampMarks: Math.max(...rounds.map((r) => r.clampMarks)) }];
    }));
    print(`${name} 汇总（gapMax ms，中位 = 后 ${Math.max(1, ROUNDS - 1)} 轮）`, summary);

    if (name === 'firefox') {
      check('① 只在正文里拖不卡（对照）', summary.within.median <= WITHIN_LIMIT_MS, `within gapMax 中位 ${summary.within.median} ms ≤ ${WITHIN_LIMIT_MS} ms`);
      check('② 跨栏拖选不卡（修法生效）', summary.across.median <= FIREFOX_LIMIT_MS, `across gapMax 中位 ${summary.across.median} ms ≤ ${FIREFOX_LIMIT_MS} ms（selLen=${summary.across.selLen}）`);
      check('③ 分层：关掉 content-visibility 也能不卡（贵的是「为选区补布局」）', summary['across-no-cv'].median <= FIREFOX_LIMIT_MS, `across-no-cv gapMax 中位 ${summary['across-no-cv'].median} ms ≤ ${FIREFOX_LIMIT_MS} ms（selLen=${summary['across-no-cv'].selLen} —— Range 照样覆盖整段正文）`);
      check('④ 反证臂：把护栏摘掉必须红', summary['across-no-guard'].median >= RED_MIN_MS, `across-no-guard gapMax 中位 ${summary['across-no-guard'].median} ms ≥ ${RED_MIN_MS} ms（selLen=${summary['across-no-guard'].selLen}）`);
      check('护栏标记确实上了', summary.across.clampMarks > 0, `跨栏拖选过程中最多同时挂着 ${summary.across.clampMarks} 个标记（松手即撤，收尾剩 0）`);
    } else {
      // Chromium：这一条修法在它上面只是部分改善（见交付报告），所以只断言「不比不装护栏更差」＋如实体检。
      report('Chromium 跨栏拖选（对照，非门限）', summary.across.median < summary['across-no-guard'].median, `across ${summary.across.median} ms vs across-no-guard ${summary['across-no-guard'].median} ms vs within ${summary.within.median} ms`);
      check('Chromium：护栏不比不装护栏更差', summary.across.median <= summary['across-no-guard'].median * 1.2, `across ${summary.across.median} ms ≤ across-no-guard ${summary['across-no-guard'].median} ms × 1.2`);
    }
    // 收尾：把护栏标记清干净（用 mid-air 的 DOM 状态确认没有残留标记）。
    const leftover = await driver.ev('document.querySelectorAll("#messages [data-sel-clamp]").length');
    check(`${name}：拖选收尾后没有残留的护栏标记`, leftover === 0, `残留 ${leftover} 个`);
    const failure = await driver.close();
    if (failure) problems.push(failure);
  }
  // 收尾自证：所有引擎都关完之后，整台机器再扫一遍 —— 不该还有命令行里带本次沙箱路径的进程。
  // （每个 driver.close() 已经各自确认过一次；这是最终账。Windows 这一支**保持原样**：收尾按精确 pid 的
  // taskkill /T（已在 close() 里），这里不另做一次进程表扫描 —— 迁移只换取数通道、没改行为。）
  if (process.platform === 'win32') {
    report('收尾后没有残留的浏览器进程', true, 'Windows：按 pid 的 taskkill /T 轮询已在 close() 里确认（本支不做进程表扫描）');
  } else {
    const stragglers = await sandboxProcesses(sandbox, await selfAndAncestors());
    check('收尾后没有残留的浏览器进程（命令行含本次沙箱路径）', stragglers.length === 0, `残留 ${stragglers.length} 个${stragglers.length ? `：${stragglers.map((row) => `${row.pid} ${row.commandLine.slice(0, 80)}`).join(' | ')}` : '（无）'}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  // 早退路径（断言红、send 超时、引擎压根没起来）也要把浏览器收干净：按登记表逐条收，
  // 已经关过的会空跑。放在删沙箱之前 —— 浏览器还在写 profile 目录时 rm 会打不干净。
  for (const name of [...spawned.keys()]) {
    const failure = await closeSpawned(name).catch((error) => `${name}: close 抛了 ${error.message}`);
    if (failure) problems.push(failure);
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSandbox(sandbox, problems, 'remove sandbox').catch(() => {});
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failed = await removeSandbox(sandbox, problems, 'remove sandbox retry').then(() => null).catch((error) => error.message);
    if (!failed) break;
    problems.pop(); // 重试过程中的失败不算最终问题（Windows 上浏览器刚退时 profile 里的 sqlite-wal 还会被占一会儿）
    await sleep(500);
  }
  await removeSandbox(sandbox, problems, 'remove sandbox final').catch(() => {});
}
print('沙箱', sandbox);
finishCleanup(primaryError, problems);
process.stdout.write(`RESULT: drag-select-cost PASS（夹具 ${BIG_COUNT} 条 / ${TREE_COUNT} 行树；Firefox 门限 ${FIREFOX_LIMIT_MS} ms，反证下限 ${RED_MIN_MS} ms）\n`);
