#!/usr/bin/env node
// 换代窗口的**网页那半**（真 Chromium + 假 API）：客户端必须按 `retryable` 这一个旗标分支。
//
// 契约（`docs/manager-toolkit-plan.md` §11，我们与集成/验收方已定）：换代窗口里宿主给**非 2xx 追加**
// `retryable: true`（+ `retryAfterMs`）—— 状态码与既有 `error` code **一字不改**；客户端按旗标分支。
// 宿主侧一直是照这条回的（每发窗口回执都带旗标），但 `web/` 里此前**一次都没读它**（review 单实测
// `retryable` 出现 0 次）⇒ 我们自己的网页从不重试、也从不把「等一下」如实说给用户。
//
// 这道门钉五件事（各臂独立报告，互不顶替）：
//   ① 正向 · 读路径：假 API 先回一次 `503 {retryable:true, retryAfterMs:10}` 再回 200 ⇒
//      断言前端**自动重试并成功**（会话真的打开），且**只重试一次**（那一发 GET 恰好 2 次）。
//   ①b 上界 · 读路径：连发两次可重试、第三次才 200 ⇒ 断言**总共只 2 发**（不许重试成环），
//      会话**打不开**（第二发失败就按原样抛），且第 3 发**没发出去**。
//   ② 写路径 · 带旗标的 409：发消息 ⇒ 断言**没有第二次请求**（绝不自动重发，双写风险），
//      并且用户可见那一行是**如实的人话**（说清「正在换代 / 没有发出去 / 不会自动重发」+ 建议等待）。
//   ③ 不带旗标 ⇒ 与今天**一字不差**：
//      · 读路径 500（无旗标）⇒ 不重试（恰好 1 发），提示是普通的「这个会话打不开：…」；
//      · 写路径 409（无旗标）⇒ 不重发（恰好 1 发），提示里是服务端原文，**没有**换代那句。
//   ④ 反证臂（两个，各自在 `web/` 的副本上做，真树 web/ 一个字不动）：
//      · 把幂等读路径的重试关掉 ⇒ ① 必红（1 发、会话打不开）—— 这一条的**红**就是本门的证据；
//      · 把「写路径不重试」反过来（写也重试）⇒ ② 必红（2 发）。
//
// 沙箱：真 Chromium（`CHROME_BIN`）+ 假 API（只实现契约里网页要用的那几条路由）+ 临时 user-data-dir；
// 只用一个高位随机端口，不碰真实 profile、不用 7331/7321。
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, sendJson, readBody, waitFor } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 两条会话：R 走读路径两条臂，W 走写路径（失败会把它置成「打不开」的界面态，所以不复用同一条）。
const READ_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const WRITE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const T = Date.now() - 3_600_000;

// ── 反证臂的突变锚（两处都只落在 web/ 的**副本**里）──────────────────────────────────────────
// 锚点必须在真树里恰好出现 1 次：找不到锚 = 门在说「它盯的那行代码跑了」，那是红不是跳过。
const READ_RETRY_ANCHOR = '      if (idempotent && !retried) {';
const MUTATIONS = {
  'no-read-retry': {
    note: 'mutation①：幂等读路径的重试被关掉 ⇒ ① 必红',
    to: '      if (false) {   // (mutation①: 幂等读路径的重试被关掉)',
  },
  'retry-writes-too': {
    note: 'mutation②：写路径也被重试（这正是双写风险）⇒ ② 必红',
    to: '      if (!retried) { // (mutation②: 写路径也被重试)',
  },
};

/** 把 `web/` 拷一份出来并在 `app.js` 上做一处突变（真树一个字不动）。 */
async function makeWebRoot(sandbox, mode) {
  const dir = path.join(sandbox, `web-${mode}`);
  await mkdir(dir, { recursive: true });
  await cp(path.join(root, 'web'), dir, { recursive: true });
  const file = path.join(dir, 'app.js');
  let text = await readFile(file, 'utf8');
  const anchorCount = text.split(READ_RETRY_ANCHOR).length - 1;
  assert.equal(anchorCount, 1, `mutation anchor must appear exactly once in web/app.js (found ${anchorCount})`);
  text = text.replace(READ_RETRY_ANCHOR, MUTATIONS[mode].to);
  await writeFile(file, text);
  // 变过的那份必须仍然能当 ESM 解析（否则门会红在一个语法错上，看着像产品问题）。
  const check = path.join(sandbox, `app-check-${mode}.mjs`);
  await writeFile(check, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', check], (error, stdout, stderr) => error ? reject(new Error(`mutated app.js does not parse: ${stderr || error.message}`)) : resolve()));
  print('mutation', { mode, webRoot: dir, ...MUTATIONS[mode] });
  return dir;
}

// ── 假 API 的账与控制面（同一个进程里直接读写，不需要控制端点）──────────────────────────────
const control = {
  // `GET /api/sessions/{id}`：'ok' | 'retryable-once' | 'retryable-twice' | 'plain-500'
  detailMode: 'ok',
  // `POST /api/sessions/{id}/message`：'ok' | 'retryable-409' | 'plain-409'
  messageMode: 'ok',
  detailRequests: [],   // 只记**详情**那一发（`/api/sessions/{id}`，不带子路径）
  detailRun: 0,         // 本臂开跑时已有的详情发数 ⇒ `nth` 是「本臂第几发」，臂之间互不污染
  messageRequests: [],
};

const treePayload = () => ({
  sessions: [READ_ID, WRITE_ID].map((id, index) => ({
    id,
    name: index === 0 ? 'Retry 读路径' : 'Retry 写路径',
    parentId: null,
    archived: false,
    cwd: `C:/work/retry-${index}`,
    modifiedAt: new Date(T + index).toISOString(),
    status: 'idle',
    statusLabel: '闲置',
    // unread:false ⇒ 不开那条「打开就上报已读」的支路，免得它的提示盖住本门要看的那一行。
    unread: false,
    settledAt: T,
    seenAt: T,
    notify: { notifies: [], waitingFor: [] },
  })),
  unread: { count: 0 },
});

const detailPayload = (id) => ({
  id,
  name: id === READ_ID ? 'Retry 读路径' : 'Retry 写路径',
  archived: false,
  cwd: 'C:/work/retry',
  readOnly: false,
  context: null,
  runtime: { isStreaming: false, isCompacting: false, isRetrying: false, thinkingLevel: 'off' },
  observability: null,
});

const RETRYABLE_BODY = (message, retryAfterMs) => ({ error: 'generation_swapped', message, retryable: true, retryAfterMs });

async function routes(request, response, url) {
  const { pathname } = url;
  const method = request.method || 'GET';

  if (pathname === '/api/host') return sendJson(response, 200, { ok: true, pid: 4242, currentWorkerPid: 4243 }), true;
  if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
  if (pathname === '/api/tree') return sendJson(response, 200, treePayload()), true;
  if (pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
    return true;
  }

  // 会话流：只开一条空流（本门量的是 HTTP 那一发，不是直播）。
  if (/^\/api\/sessions\/[^/]+\/events$/.test(pathname)) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(': connected\n\n');
    return true;
  }

  // ── 详情（本门的读路径主角）──────────────────────────────────────────────────────────────
  const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (detailMatch && method === 'GET') {
    const id = detailMatch[1];
    control.detailRequests.push({ id, at: Date.now() });
    const nth = control.detailRequests.length - control.detailRun;
    if (control.detailMode === 'retryable-once' && nth === 1) return sendJson(response, 503, RETRYABLE_BODY('connect ECONNRESET (换代窗口里没接通)', 10)), true;
    if (control.detailMode === 'retryable-twice' && nth <= 2) return sendJson(response, 503, RETRYABLE_BODY('connect ECONNRESET (换代窗口里没接通)', 10)), true;
    if (control.detailMode === 'plain-500') return sendJson(response, 500, { error: 'internal_error', message: '假 API：这一发没有 retryable 旗标（不是换代窗口）' }), true;
    return sendJson(response, 200, detailPayload(id)), true;
  }

  // ── 写路径主角：发消息 ──────────────────────────────────────────────────────────────────
  const messageMatch = /^\/api\/sessions\/([^/]+)\/(message|steer|follow-up|followUp)$/.exec(pathname);
  if (messageMatch && method === 'POST') {
    control.messageRequests.push({ id: messageMatch[1], route: messageMatch[2], body: await readBody(request), at: Date.now() });
    if (control.messageMode === 'retryable-409') {
      // 真实的形状：**已到达某一代**、而它说「我不再持有它」+ 窗口内追加 retryable/retryAfterMs。
      return sendJson(response, 409, { error: 'session_not_owned_by_generation', message: 'this generation no longer owns the session', retryable: true, retryAfterMs: 1000 }), true;
    }
    if (control.messageMode === 'plain-409') {
      // **非窗口**的真冲突：同样的 409，但没有旗标 ⇒ 客户端不许当可重试处理。
      return sendJson(response, 409, { error: 'session_moved', message: '这个会话已搬到别处（假 API 原文，无旗标）' }), true;
    }
    return sendJson(response, 200, { ok: true }), true;
  }

  if (/^\/api\/sessions\/[^/]+\/messages$/.test(pathname) && method === 'GET') {
    return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null, note: '' }, observability: null }), true;
  }
  if (/^\/api\/sessions\/[^/]+\/commands$/.test(pathname) && method === 'GET') {
    return sendJson(response, 200, { commands: [], streaming: false }), true;
  }
  if (/^\/api\/sessions\/[^/]+\/questions$/.test(pathname) && method === 'GET') {
    return sendJson(response, 200, { questions: [], counts: { open: 0, answered: 0, closed: 0, concluded: 0, total: 0 }, filteredCount: 0 }), true;
  }
  if (/^\/api\/sessions\/[^/]+\/draft$/.test(pathname)) {
    if (method === 'GET') return sendJson(response, 200, { text: '' }), true;
    return sendJson(response, 200, { ok: true }), true;
  }
  if (/^\/api\/sessions\/[^/]+\/seen$/.test(pathname)) return sendJson(response, 200, { ok: true }), true;

  return false;
}

// ── 浏览器侧的读法 ───────────────────────────────────────────────────────────────────────────
const view = (ui) => ui.evaluate(`({
  promptDisabled: document.querySelector('#prompt').disabled,
  title: document.querySelector('#session-title').textContent,
  notice: document.querySelector('#notice').textContent,
  noticeLevel: document.querySelector('#notice').dataset.level,
})`);
const clickSession = (ui, id) => ui.evaluate(`(() => {
  const row = document.querySelector('[data-session-id="${id}"]');
  if (!row) return false;
  row.click();
  return true;
})()`);
const typeAndSend = (ui, text) => ui.evaluate(`(() => {
  const input = document.querySelector('#prompt');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
})()`);

/** 等「详情那一发」涨到 n（并发请求数就这样点着数，不靠时间猜）。 */
// ⚠️ 本门每一条等待都用这一条**宽松**死线（默认 20 s）：所有断言都是**次数 / 状态**（不是时延），
// 机器上还有别的门在跑时慢一点不该变成假红（2026-09-21 实测：负载高时 8 s 默认值会误红）。
const WAIT_MS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_SWAPWINDOWWEB_WAIT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
})();
// ⚠️ 等的是 **`>= n`**，不是 `=== n`："先 503 再 200" 那一对之间只隔 `retryAfterMs + jitter`（实测 42 ms
// 那一次就把 `=== 1` 那个瞬时值漏过去了，门于是假红 —— 2026-09-21 实测复现）。「恰好几发」由各臂在
// settle 之后**单独断言**（那才是它要钉的东西）。
const waitDetailCount = (ui, n) => ui.waitFor(() => control.detailRequests.length >= n, `GET /api/sessions/{id} 没有涨到 ${n} 发（现在 ${control.detailRequests.length}）`);
// 读路径没动时的现场（用来把“点下去什么都没发生”与“点了但被谁拦了”分开）：
const pageFacts = (ui) => ui.evaluate(`({
  href: location.href,
  hash: location.hash,
  title: document.querySelector('#session-title').textContent,
  promptDisabled: document.querySelector('#prompt').disabled,
  notice: document.querySelector('#notice').textContent,
  rows: document.querySelectorAll('[data-session-id]').length,
  selectedRows: document.querySelectorAll('[data-session-id].selected').length,
  sessionResources: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/sessions/')).map((entry) => ({ name: new URL(entry.name).pathname, startTime: Math.round(entry.startTime), duration: Math.round(entry.duration), transferSize: entry.transferSize })),
  now: Math.round(performance.now()),
})`).catch((error) => ({ error: error.message }));
const waitMessageCount = (ui, n) => ui.waitFor(() => control.messageRequests.length >= n, `POST …/message 没有涨到 ${n} 发（现在 ${control.messageRequests.length}）`);
const opened = (state) => state.promptDisabled === false;
/** 开一臂的读路径：把「本臂第几发」的基准钉在当前发数上（假 API 按它决定前 N 发怎么回）。 */
const startDetailRun = () => { control.detailRun = control.detailRequests.length; };

const failures = [];
let openProblem = null;
async function arm(label, ui, fn) {
  try { await fn(ui); process.stdout.write(`✓ arm ${label}\n`); }
  catch (error) {
    failures.push({ label, error });
    process.stdout.write(`✗ arm ${label} —— ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'swap-window-web-'));
const problems = [];
try {
  print('fixture', { sandbox, readId: READ_ID, writeId: WRITE_ID, chrome: process.env.CHROME_BIN ?? '(ui-harness 默认)' });

  // ══════════════ 真树（修后）：① ①②b ③ 正向与边界 ══════════════
  const ui = await boot({ routes, width: 1200, height: 760 });
  ui.waitFor = (fn, message) => waitFor(fn, message, WAIT_MS);   // 见上面 WAIT_MS 的注释
  try {
    await ui.waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${READ_ID}"]') !== null`), '会话树没有画出来');
    // 把两行都点一遍打开过，才能保证后面「点 R」是**重新打开**而不是首次。
    print('boot', await view(ui));

    await arm('① 正向 · 读路径：503{retryable:true} 一次 ⇒ 自动重试一次并成功（恰好 2 发，会话打开）', ui, async (page) => {
      control.detailMode = 'retryable-once';
      const before = control.detailRequests.length;
      const clickedAt = Date.now();
      startDetailRun();
      assert.equal(await clickSession(page, READ_ID), true, '读路径会话那一行必须在树里');
      try {
        await waitDetailCount(page, before + 1);
      } catch (error) {
        print('arm① 诊断（读路径那一发没动）', { ...(await pageFacts(page)), hostDetailRequests: control.detailRequests.length, detailRun: control.detailRun });
        throw error;
      }
      const state = await page.waitFor(async () => {
        const snapshot = await view(page);
        return opened(snapshot) ? snapshot : null;
      }, '重试之后会话必须打开（#prompt 可用）');
      await sleep(400);   // 再等一会儿：若前端重试成环，这里会看到第 3 发
      assert.equal(control.detailRequests.length, before + 2, `只许重试一次 ⇒ 恰好 2 发；实得 ${control.detailRequests.length}`);
      assert.match(state.title, /Retry 读路径/, `标题应当是这个会话（不是「打不开」）：${state.title}`);
      assert.equal(state.noticeLevel, 'info', `打开成功不该留一条错误提示：${state.notice}`);
      // 时延只进日志（不进断言），但要看得到：“点一下到主机收到那一发”慢了多久。
      const after = control.detailRequests.slice(before);
      print('arm① evidence', {
        detailRequests: after.length,
        msFromClick: after.map((r) => r.at - clickedAt),
        promptDisabled: state.promptDisabled,
        title: state.title,
        notice: state.notice,
      });
    });

    await arm('①b 上界 · 读路径：连发两次可重试 ⇒ 总共只 2 发就停（重试成环必红）', ui, async (page) => {
      control.detailMode = 'retryable-twice';
      const before = control.detailRequests.length;
      startDetailRun();
      await clickSession(page, READ_ID);
      await waitDetailCount(page, before + 2);
      const state = await page.waitFor(async () => {
        const snapshot = await view(page);
        return snapshot.title.includes('（打不开）') ? snapshot : null;
      }, '第二发也失败 ⇒ 会话必须如实显示为「打不开」');
      await sleep(400);
      assert.equal(control.detailRequests.length, before + 2, `不许有第 3 发（重试成环）：实得 ${control.detailRequests.length - before} 发`);
      assert.equal(state.promptDisabled, true, '打不开的会话，输入框必须不可用');
      print('arm①b evidence', { detailRequests: control.detailRequests.length - before, title: state.title, notice: state.notice });
    });

    await arm('③a 边界 · 读路径 500 **不带**旗标 ⇒ 不重试（恰好 1 发），提示与今天一致', ui, async (page) => {
      control.detailMode = 'plain-500';
      const before = control.detailRequests.length;
      startDetailRun();
      await clickSession(page, READ_ID);
      await waitDetailCount(page, before + 1);
      const state = await page.waitFor(async () => {
        const snapshot = await view(page);
        return snapshot.notice.includes('这个会话打不开') ? snapshot : null;
      }, '读路径失败必须走既有那句「这个会话打不开：…」');
      await sleep(400);
      assert.equal(control.detailRequests.length, before + 1, `不带旗标就不许重试：实得 ${control.detailRequests.length - before} 发`);
      assert.ok(!state.notice.includes('服务端正在换代'), `不带旗标的 500 不许走换代那句：${state.notice}`);
      assert.equal(state.noticeLevel, 'error', `读失败是错误级提示：${state.notice}`);
      print('arm③a evidence', { detailRequests: control.detailRequests.length - before, notice: state.notice });
    });

    // 写路径：换成 W 那条会话（R 已被上一臂置成「打不开」）。
    control.detailMode = 'ok';
    await clickSession(ui, WRITE_ID);
    await ui.waitFor(async () => opened(await view(ui)), '写路径会话必须能打开（这一臂不量打开过程）');
    assert.equal((await view(ui)).title.includes('Retry 写路径'), true, '写路径那一臂应当开在 W 上');

    await arm('② 写路径 · 409{retryable:true} ⇒ 绝不自动重发（恰好 1 发）+ 用户可见那句如实提示', ui, async (page) => {
      control.messageMode = 'retryable-409';
      const before = control.messageRequests.length;
      await typeAndSend(page, '这一条撞上换代窗口');
      const state = await page.waitFor(async () => {
        const snapshot = await view(page);
        return snapshot.notice.includes('服务端正在换代') ? snapshot : null;
      }, '写路径必须把「正在换代」如实说给用户听');
      await sleep(500);   // 双写风险的窗口：若自动重发，这里会看到第 2 发
      assert.equal(control.messageRequests.length, before + 1, `写路径绝不许自动重试：实得 ${control.messageRequests.length - before} 发`);
      assert.equal(control.messageRequests.at(-1).route, 'message', `发的应当是 message 路由：${JSON.stringify(control.messageRequests.at(-1))}`);
      assert.match(state.notice, /没有发出去/, `提示说清「没发出去」：${state.notice}`);
      assert.match(state.notice, /不会自动重发/, `提示说清「不会自动重发」：${state.notice}`);
      assert.match(state.notice, /1000 ms/, `提示要带上服务端给的等待建议（retryAfterMs）：${state.notice}`);
      print('arm② evidence', { messageRequests: control.messageRequests.length - before, notice: state.notice });
    });

    await arm('③b 边界 · 写路径 409 **不带**旗标 ⇒ 不重发（恰好 1 发）、提示里是服务端原文、没有换代那句', ui, async (page) => {
      control.messageMode = 'plain-409';
      const before = control.messageRequests.length;
      await typeAndSend(page, '这一条是普通的 409（不是换代窗口）');
      await waitMessageCount(page, before + 1);
      const state = await page.waitFor(async () => {
        const snapshot = await view(page);
        return snapshot.notice.includes('这个会话已搬到别处') ? snapshot : null;
      }, '不带旗标的 409 应当照旧显示服务端原文');
      await sleep(500);
      assert.equal(control.messageRequests.length, before + 1, `不带旗标就不许重发：实得 ${control.messageRequests.length - before} 发`);
      assert.ok(!state.notice.includes('服务端正在换代'), `不带旗标的 409 不许走换代那句：${state.notice}`);
      print('arm③b evidence', { messageRequests: control.messageRequests.length - before, notice: state.notice });
    });

    print('page problems', ui.pageProblems);
  } finally {
    await ui.close();
  }

  // ══════════════ 反证臂 ④：把读路径的重试去掉 ⇒ ① 必红 ══════════════
  const cases = [
    {
      label: '④a 反证（突变①：读路径重试被关掉）⇒ ① 必红',
      mode: 'no-read-retry',
      scenario: async (page) => {
        control.detailMode = 'retryable-once';
        control.detailRequests.length = 0;
        control.detailRun = 0;
        await page.waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${READ_ID}"]') !== null`), '会话树没有画出来');
        await clickSession(page, READ_ID);
        await waitDetailCount(page, 1);
        await sleep(500);
        const state = await view(page);
        return { requests: control.detailRequests.length, opened: opened(state), title: state.title, notice: state.notice };
      },
      // ① 的判据（「自动重试并成功」）在突变下**必须不成立** —— 这一条红就是本门的证据。
      assertRed: (result) => {
        assert.equal(result.requests, 1, `突变下单发失败就该停（不许还有重试）：实得 ${result.requests} 发`);
        assert.equal(result.opened, false, `突变下会话不该打开：${JSON.stringify(result)}`);
      },
    },
    {
      label: '④b 反证（突变②：写路径也被重试）⇒ ② 必红',
      mode: 'retry-writes-too',
      scenario: async (page) => {
        control.detailMode = 'ok';
        control.messageMode = 'retryable-409';
        control.messageRequests.length = 0;
        await page.waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${WRITE_ID}"]') !== null`), '会话树没有画出来');
        await clickSession(page, WRITE_ID);
        await page.waitFor(async () => opened(await view(page)), '写路径会话必须能打开');
        await typeAndSend(page, '突变②：写路径也被重试');
        await page.waitFor(() => control.messageRequests.length >= 2, `突变下应当看到第二发（实得 ${control.messageRequests.length}）`);
        await sleep(400);
        const state = await view(page);
        return { requests: control.messageRequests.length, notice: state.notice };
      },
      // ② 的判据（「恰好 1 发」）在突变下**必须不成立**。
      assertRed: (result) => {
        assert.ok(result.requests >= 2, `突变下写路径必须被逮到重发（双写风险的机械证据）：实得 ${result.requests} 发`);
      },
    },
  ];

  for (const item of cases) {
    const webRoot = await makeWebRoot(sandbox, item.mode);
    const page = await boot({ routes, width: 1200, height: 760, webRoot });
    page.waitFor = (fn, message) => waitFor(fn, message, WAIT_MS);
    try {
      const result = await item.scenario(page);
      print(`arm${item.label.slice(0, 3)} mutated evidence`, result);
      item.assertRed(result);
      process.stdout.write(`✓ arm ${item.label}（突变下那一臂如实变红：${JSON.stringify(result)}）\n`);
    } catch (error) {
      failures.push({ label: item.label, error });
      process.stdout.write(`✗ arm ${item.label} —— ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await page.close();
    }
  }

  if (failures.length > 0) {
    print('failed arms', failures.map((entry) => ({ label: entry.label, error: entry.error instanceof Error ? entry.error.message : String(entry.error) })));
    assert.deepEqual(failures.map((entry) => entry.label), [], `${failures.length} arm(s) failed`);
  }
  print('RESULT', { ok: true, arms: 7 });
  process.stdout.write('RESULT: swap-window-retryable-frontend PASS\n');
} catch (error) {
  openProblem = error;
} finally {
  await removeSandbox(sandbox, problems);
  finishCleanup(openProblem, problems);
}
