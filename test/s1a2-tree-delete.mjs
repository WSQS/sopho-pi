// M-18（剩余）门：左栏「删除会话」入口。
// ⚠️ 这条门同时钉住「不许发明真删除」：前端唯一发出的写请求必须是已有的
//    `POST /sessions/{id}/archive {archived:true}`（= 归档），整轮里不许出现 DELETE / 新端点 / 真删除。
// 覆盖：入口只在有选中会话时出现；已归档的不可用（只在允许时可用）；点入口先出确认、**不发请求**；
//       取消零请求；确认后才发一次归档请求、成功后换组（不做乐观更新）；失败时树与按钮原地不动、报错原话。
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const ids = {
  alpha: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  beta: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  gamma: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
  archived: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004',
};
const sessions = [
  { id: ids.alpha, name: 'Alpha 项目', cwd: '/work/alpha', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:04:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.beta, name: 'Beta 笔记', cwd: '/work/beta', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:03:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.gamma, name: 'Gamma 实验', cwd: '/work/gamma', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:02:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.archived, name: '已归档 Alpha', cwd: '/old/alpha', parentId: null, archived: true, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
const writes = [];
let failNext = null;
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-tree-delete-1200x760.png`;

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const archiveMatch = /^\/api\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
    if (archiveMatch) {
      const session = sessions.find((entry) => entry.id === archiveMatch[1]);
      const body = JSON.parse((await readBody(request)) || '{}');
      writes.push({ method: request.method, path: url.pathname, body });
      if (!session) return sendJson(response, 404, { message: 'missing' }), true;
      if (failNext) {
        const failure = failNext;
        failNext = null;
        return sendJson(response, failure.status, { error: failure.error, message: failure.message }), true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      session.archived = body.archived === true;
      return sendJson(response, 200, { ok: true, id: session.id, archived: session.archived }), true;
    }
    if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      const session = sessions.find((entry) => entry.id === id);
      if (!session) return sendJson(response, 404, { message: 'missing' }), true;
      return sendJson(response, 200, { name: session.name, cwd: session.cwd, archived: session.archived, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    }
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null }), true;
    if (/^\/api\/sessions\/[^/]+\/commands$/.test(url.pathname)) return sendJson(response, 200, { streaming: false, commands: [] }), true;
    if (/^\/api\/sessions\/[^/]+\/seen$/.test(url.pathname)) return sendJson(response, 200, { ok: true }), true;
    if (/^\/api\/sessions\/[^/]+\/events$/.test(url.pathname)) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return true;
    }
    return false;
  },
});

const deleteState = () => ui.evaluate(`(() => {
  const b=document.querySelector('#delete');
  const c=document.querySelector('#delete-confirm');
  return {
    exists:b!==null,
    hidden:b?b.hidden:null,
    disabled:b?b.disabled:null,
    text:b?b.textContent:null,
    title:b?b.getAttribute('title'):null,
    confirmHidden:c?c.hidden:null,
    confirmText:document.querySelector('#delete-confirm-text')?.textContent ?? null,
    notice:document.querySelector('#notice')?.textContent ?? null,
    noticeLevel:document.querySelector('#notice')?.dataset.level ?? null,
  };
})()`);
const select = async (id) => {
  await ui.evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), `session ${id} did not open`);
  await ui.frames(2);
};
const inActive = (id) => ui.evaluate(`!!document.querySelector('.active-tree-list [data-session-id="${id}"]')`);
const inAttic = (id) => ui.evaluate(`!!document.querySelector('.attic-list [data-session-id="${id}"]')`);

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 3`), 'tree did not render');

  // ① 没选中会话：入口整个隐掉（与 #archive / #rename 同一规矩）。
  const noSelection = await deleteState();
  check('没选中会话 ⇒ 删除入口隐藏', noSelection.exists && noSelection.hidden === true, JSON.stringify({ hidden: noSelection.hidden }));

  // ② 选中活跃会话：入口可见可用，且文案如实说明底层是归档。
  await select(ids.alpha);
  const active = await deleteState();
  check('选中活跃会话 ⇒ 删除入口可见且可用', active.hidden === false && active.disabled === false, JSON.stringify({ hidden: active.hidden, disabled: active.disabled }));
  check('删除入口的 tooltip 如实说明「底层是归档」', /归档/.test(active.title || ''), active.title);
  check('入口文案是「删除」', active.text === '删除', active.text);

  // ③ 点入口 ⇒ 只出确认行，**一个请求都不发**。
  await ui.evaluate(`document.querySelector('#delete').click()`);
  await ui.frames(2);
  const asked = await deleteState();
  check('点删除 ⇒ 先出确认行（不立刻发请求）', asked.confirmHidden === false && writes.length === 0, JSON.stringify({ confirmHidden: asked.confirmHidden, writes }));
  check('确认文案点名会话并说明「底层是归档、可找回」', /Alpha 项目/.test(asked.confirmText || '') && /归档/.test(asked.confirmText || ''), asked.confirmText);

  // ④ 取消 ⇒ 零请求，会话原地不动。
  await ui.evaluate(`document.querySelector('#delete-confirm-no').click()`);
  await ui.frames(2);
  const cancelled = await ui.evaluate(`({hidden:document.querySelector('#delete-confirm').hidden, inActive:!!document.querySelector('.active-tree-list [data-session-id="${ids.alpha}"]'), notice:document.querySelector('#notice').textContent})`);
  check('取消 ⇒ 确认行收起、会话原地不动、没有任何写请求', cancelled.hidden === true && cancelled.inActive === true && writes.length === 0, JSON.stringify(cancelled));

  // ⑤ 确认 ⇒ 唯一一次写请求必须是归档（复用既有端点，不发明真删除）。
  await ui.evaluate(`document.querySelector('#delete').click()`);
  await ui.frames(2);
  await ui.evaluate(`document.querySelector('#delete-confirm-yes').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#notice').textContent.includes('已移出列表')`), 'delete did not report success');
  const deleted = await ui.evaluate(`({inActive:!!document.querySelector('.active-tree-list [data-session-id="${ids.alpha}"]'), title:document.querySelector('#session-title').textContent})`);
  check('确认后请求恰好一次，且是既有的归档端点（method/路径/body 逐字）', writes.length === 1 && writes[0].method === 'POST' && writes[0].path === `/api/sessions/${ids.alpha}/archive` && writes[0].body?.archived === true, JSON.stringify(writes));
  check('整轮没有任何 DELETE 请求、也没有非归档写端点（不许实现真删除）', writes.every((entry) => entry.method === 'POST' && /\/archive$/.test(entry.path)), JSON.stringify(writes.map((entry) => `${entry.method} ${entry.path}`)));
  check('成功后该会话移出活跃列表', deleted.inActive === false, JSON.stringify(deleted));
  const successNotice = await deleteState();
  check('成功回执如实说明「底层是归档、可找回」', /已移出列表/.test(successNotice.notice) && /归档/.test(successNotice.notice), successNotice.notice);

  // ⑥ 「只在允许时可用」的反面：选中一条已归档会话 ⇒ 入口可见但禁用。
  await ui.evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('[data-attic-list="true"]') !== null`), 'attic did not open');
  await select(ids.archived);
  const archivedSelected = await deleteState();
  check('选中已归档会话 ⇒ 删除入口禁用（已归档的没什么可删）', archivedSelected.hidden === false && archivedSelected.disabled === true, JSON.stringify({ hidden: archivedSelected.hidden, disabled: archivedSelected.disabled }));
  await ui.evaluate(`document.querySelector('#delete').click()`);
  await ui.frames(2);
  const blocked = await ui.evaluate(`({confirmHidden:document.querySelector('#delete-confirm').hidden, inAttic:!!document.querySelector('.attic-list [data-session-id="${ids.archived}"]')})`);
  check('已归档时点入口不弹确认、不发请求', blocked.confirmHidden === true && blocked.inAttic === true && writes.length === 1, JSON.stringify(blocked));

  // ⑦ 失败：不做乐观更新，树与按钮原地不动，错误原话上报。
  await select(ids.gamma);
  failNext = { status: 409, error: 'session_busy', message: 'delete refused: session is streaming' };
  await ui.evaluate(`document.querySelector('#delete').click()`);
  await ui.frames(2);
  await ui.evaluate(`document.querySelector('#delete-confirm-yes').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#notice').textContent.includes('删除失败')`), 'delete failure was not reported');
  const failed = await ui.evaluate(`({notice:document.querySelector('#notice').textContent, level:document.querySelector('#notice').dataset.level, inActive:!!document.querySelector('.active-tree-list [data-session-id="${ids.gamma}"]'), confirmHidden:document.querySelector('#delete-confirm').hidden, disabled:document.querySelector('#delete').disabled})`);
  check('删除失败 ⇒ 如实报错（含状态与原文），会话仍留在活跃列表', failed.level === 'error' && /删除失败/.test(failed.notice) && /409/.test(failed.notice) && /delete refused/.test(failed.notice) && failed.inActive === true, JSON.stringify(failed));
  check('失败后入口恢复可用（不是卡死在「在飞」）', failed.confirmHidden === true && failed.disabled === false, JSON.stringify(failed));
  check('失败那次也只发了归档请求（没有旁路写）', writes.length === 2 && writes[1].path === `/api/sessions/${ids.gamma}/archive` && writes[1].body?.archived === true, JSON.stringify(writes));

  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));
  await ui.screenshot(screenshotFile);
  print('writes', writes);
  print('screenshots', { delete: screenshotFile });
  print('RESULT', `M-18 delete-session (reuses archive) PASS (${checks} checks)`);
} finally {
  await ui.close();
}
