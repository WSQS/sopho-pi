// M-05 门：会话标题栏（右栏顶栏）必须有指向 GET /sessions/{id}/export 的「快照」链接。
// 修前 web/ 里没有这个入口（docs/tui-parity.md M-05：台账写着「点快照」但按钮不存在）。
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const sessions = [{
  id: sessionId, name: '导出入口回归', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, cwd: 'C:/work/export', modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: sessions[0].name, cwd: sessions[0].cwd, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null }), true;
    if (url.pathname === `/api/sessions/${sessionId}/commands`) return sendJson(response, 200, { streaming: false, commands: [] }), true;
    if (url.pathname === `/api/sessions/${sessionId}/seen`) return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return true;
    }
    return false;
  },
});

try {
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  const before = await ui.evaluate(`(() => { const a=document.querySelector('#export'); return a ? {hidden:a.hidden, href:a.getAttribute('href')} : null; })()`);
  check('没选会话时「快照」入口在岗且隐藏', before !== null && before.hidden === true, JSON.stringify(before));

  await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');

  const link = await ui.evaluate(`(() => {
    const a=document.querySelector('#export'); const style=getComputedStyle(a); const rect=a.getBoundingClientRect();
    return { exists:!!a, tag:a.tagName, href:a.getAttribute('href'), target:a.getAttribute('target'), rel:a.getAttribute('rel'), text:a.textContent.trim(), hidden:a.hidden, height:rect.height, borderLeftWidth:style.borderLeftWidth, borderLeftColor:style.borderLeftColor, inHeader:a.closest('header')!==null, focusable:a.tabIndex>=0 };
  })()`);
  check('「快照」是 <a>，指向 /api/sessions/{id}/export', link.exists && link.tag === 'A' && link.href === `/api/sessions/${sessionId}/export`, JSON.stringify(link));
  check('target=_blank 且 rel 带 noopener（新标签、不交出 opener）', link.target === '_blank' && /noopener/.test(link.rel || ''), JSON.stringify(link));
  check('文案是「快照」、可见、可键盘聚焦', link.text === '快照' && link.hidden === false && link.focusable === true, JSON.stringify({ text: link.text, hidden: link.hidden, focusable: link.focusable }));
  check('入口在右栏顶栏里，且只吃既有 3px 槽（26px 单行高）', link.inHeader && link.borderLeftWidth === '3px' && Math.round(link.height) === 26, JSON.stringify({ inHeader: link.inHeader, borderLeftWidth: link.borderLeftWidth, height: link.height }));

  print('export link', link);
  print('RESULT', `M-05 export link PASS (${checks} checks)`);
} finally {
  await ui.close();
}
