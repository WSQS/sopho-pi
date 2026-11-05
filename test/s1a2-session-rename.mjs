// M-08 门：标题可编辑 → PATCH /sessions/{id} {name}。语义：人设过（manual）后模型 auto 不许覆盖；
// 失败必须诚实报（error notice）且标题回滚 —— 不做乐观更新。
import { boot, sendJson, readBody, waitFor } from './ui-harness.mjs';

const sessionId = '33333333-3333-4333-8333-333333333333';
const sessions = [{
  id: sessionId, name: '改名前', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, cwd: 'C:/work/rename', titleSource: 'auto', modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];
let patchMode = 'ok';
let sessionStream = null;
const patchRequests = [];
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-rename-1200x760.png`;

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/control/mode') { patchMode = url.searchParams.get('mode') || 'ok'; return sendJson(response, 200, { patchMode }), true; }
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    if (url.pathname === `/api/sessions/${sessionId}` && request.method === 'PATCH') {
      const raw = await readBody(request);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      patchRequests.push({ method: request.method, path: url.pathname, contentType: request.headers['content-type'], body });
      if (patchMode === 'slow-fail') { await new Promise((resolve) => setTimeout(resolve, 500)); return sendJson(response, 500, { message: 'title_rejected: 服务端拒了这次改名' }), true; }
      if (patchMode === 'fail') return sendJson(response, 500, { message: 'title_rejected: 服务端拒了这次改名' }), true;
      return sendJson(response, 200, { name: body.name }), true;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: sessions[0].name, cwd: sessions[0].cwd, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null }), true;
    if (url.pathname === `/api/sessions/${sessionId}/commands`) return sendJson(response, 200, { streaming: false, commands: [] }), true;
    if (url.pathname === `/api/sessions/${sessionId}/seen`) return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      sessionStream = response;
      return true;
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const { name, data } = JSON.parse((await readBody(request)) || '{}');
      if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'no session stream' }), true;
      sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true }), true;
    }
    return false;
  },
});

const titleState = () => ui.evaluate(`(() => {
  const form=document.querySelector('#rename-form'); const input=document.querySelector('#session-title-input'); const notice=document.querySelector('#notice');
  return {
    title: document.querySelector('#session-title').textContent,
    rowName: document.querySelector('[data-session-id="${sessionId}"] .tree-name')?.textContent,
    formHidden: form.hidden, input: input.value,
    notice: { text: notice.textContent, level: notice.dataset.level },
    renameDisabled: document.querySelector('#rename').disabled,
  };
})()`);
const setMode = async (mode) => { const response = await fetch(`http://127.0.0.1:${ui.port}/control/mode?mode=${mode}`); if (!response.ok) throw new Error(`setMode failed ${response.status}`); };
const submitRename = (value) => ui.evaluate(`(() => { const input=document.querySelector('#session-title-input'); input.value=${JSON.stringify(value)}; document.querySelector('#rename-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`);

try {
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
  await waitFor(() => ui.evaluate(`document.querySelector('#session-title').textContent.includes('改名前')`), 'initial title missing');
  const entry = await ui.evaluate(`({rename:document.querySelector('#rename')!==null, form:document.querySelector('#rename-form')!==null, input:document.querySelector('#session-title-input')!==null})`);
  check('改名入口在岗（标题可编辑）', entry.rename && entry.form && entry.input, JSON.stringify(entry));

  // 模型 auto 改名（未被人设过）应被前端应用。
  await ui.emit('session.title', { name: '模型第一次起的', source: 'auto', at: new Date().toISOString() });
  await waitFor(() => ui.evaluate(`document.querySelector('#session-title').textContent.includes('模型第一次起的')`), 'auto title did not apply');

  await ui.evaluate(`document.querySelector('#rename').click()`);
  await ui.frames(2);
  const opened = await titleState();
  check('点「改名」出输入框，预填当前标题', opened.formHidden === false && opened.input === '模型第一次起的' && opened.renameDisabled === true, JSON.stringify(opened));
  await ui.screenshot(screenshotFile);

  await submitRename('人改的名字-1');
  await waitFor(() => patchRequests.length === 1 && ui.evaluate(`document.querySelector('#rename-form').hidden === true`), 'rename PATCH did not settle');
  const renamed = await titleState();
  check('PATCH 请求体/方法/路径正确', patchRequests[0].method === 'PATCH' && patchRequests[0].path === `/api/sessions/${sessionId}` && /application\/json/.test(patchRequests[0].contentType || '') && JSON.stringify(patchRequests[0].body) === JSON.stringify({ name: '人改的名字-1' }), JSON.stringify(patchRequests[0]));
  check('成功后标题更新', renamed.title.includes('人改的名字-1'), renamed.title);
  check('成功后左栏树行名字同步更新', renamed.rowName === '人改的名字-1', String(renamed.rowName));
  check('成功后 notice 说清「模型不会再覆盖人设的标题」', renamed.notice.level !== 'error' && /不会再覆盖/.test(renamed.notice.text), JSON.stringify(renamed.notice));

  // 人设过（manual）后，迟到的模型 auto 事件不许把人设标题画回去。
  await ui.emit('session.title', { name: '模型又想改', source: 'auto', at: new Date().toISOString() });
  await ui.frames(3);
  const guarded = await titleState();
  check('人设过之后模型 auto 事件被忽略（标题仍是人设那条）', guarded.title.includes('人改的名字-1') && !guarded.title.includes('模型又想改'), guarded.title);

  // 空标题客户端直接拒，不发请求。
  await ui.evaluate(`document.querySelector('#rename').click()`);
  await ui.frames(2);
  await submitRename('   ');
  await ui.frames(3);
  const empty = await titleState();
  check('空标题不发明请求、不空转', patchRequests.length === 1 && empty.notice.level === 'error' && /不能为空/.test(empty.notice.text), JSON.stringify({ count: patchRequests.length, notice: empty.notice }));

  // 失败：先挂 500ms，验证「不做乐观更新」，再验证诚实 notice + 标题回滚。
  await setMode('slow-fail');
  await ui.evaluate(`document.querySelector('#rename').click()`);
  await ui.frames(2);
  await submitRename('会被拒的名字');
  await ui.frames(1);
  const pending = await titleState();
  check('请求在飞时标题不动（没有乐观更新）', pending.title.includes('人改的名字-1') && !pending.title.includes('会被拒的名字'), pending.title);
  await waitFor(() => ui.evaluate(`document.querySelector('#notice').textContent.includes('改名失败')`), 'rename failure notice did not appear');
  const failed = await titleState();
  check('失败后诚实报错（带 HTTP 状态与服务端原因）', failed.notice.level === 'error' && /改名失败/.test(failed.notice.text) && /500/.test(failed.notice.text), JSON.stringify(failed.notice));
  check('失败后标题回滚（仍是改名前那条）且输入框收起', failed.title.includes('人改的名字-1') && !failed.title.includes('会被拒的名字') && failed.formHidden === true, JSON.stringify({ title: failed.title, hidden: failed.formHidden }));
  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  print('rename requests', patchRequests);
  print('screenshots', { rename: screenshotFile });
  print('RESULT', `M-08 web rename PASS (${checks} checks)`);
} finally {
  await ui.close();
}
