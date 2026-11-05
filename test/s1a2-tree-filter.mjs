// M-18 门：左栏搜索 + 只看命名（纯前端过滤，零服务端改动）。
// 断言过滤后可见行数正确、清空恢复、「只看命名」只留 name 非空的；归档区同样受过滤影响。
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const ids = {
  alpha: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  unnamed1: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  beta: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
  unnamed2: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004',
  archived: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005',
};
const sessions = [
  { id: ids.alpha, name: 'Alpha 项目', cwd: '/work/alpha', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:04:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.unnamed1, name: '', cwd: '/work/empty', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:03:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.beta, name: 'Beta 笔记', cwd: '/data/beta', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:02:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.unnamed2, name: '', cwd: '/work/alpha2', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:01:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.archived, name: 'Archive Alpha', cwd: '/old/alpha', parentId: null, archived: true, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-tree-filter-1200x760.png`;

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

const rows = () => ui.evaluate(`Array.from(document.querySelectorAll('.tree-session')).map((row)=>row.dataset.sessionId)`);
const setQuery = async (text) => {
  await ui.evaluate(`(() => { const input=document.querySelector('#tree-search-input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await ui.frames(2);
};
const namedOnly = async () => {
  await ui.evaluate(`document.querySelector('#tree-named-only').click()`);
  await ui.frames(2);
};

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 4`), 'tree did not render');
  const panel = await ui.evaluate(`({toggle:document.querySelector('#tree-search-toggle')!==null, input:document.querySelector('#tree-search-input')!==null, named:document.querySelector('#tree-named-only')!==null})`);
  check('搜索入口在岗（toggle + input + 只看命名）', panel.toggle && panel.input && panel.named, JSON.stringify(panel));

  const searchHidden = await ui.evaluate(`document.querySelector('#tree-search').hidden`);
  check('搜索行默认收起（不占首屏高度）', searchHidden === true, `hidden=${searchHidden}`);
  await ui.evaluate(`document.querySelector('#tree-search-toggle').click()`);
  await ui.frames(2);
  const opened = await ui.evaluate(`({hidden:document.querySelector('#tree-search').hidden, focused:document.activeElement.id})`);
  check('点导航「搜索」展开搜索行并聚焦输入框', opened.hidden === false && opened.focused === 'tree-search-input', JSON.stringify(opened));

  // 这一行是 M-18 加的搜索行，几何上必须真的铺满（方向书：水平方向都保持铺满，只有会话栏/归档栏里
  // 缩进的栏目例外）。历史缺陷：CSS 写的是 `.tree-search` 而这个 section 只带了 `id`，于是整条规则
  // 从未生效——输入框与按钮退回 inline 默认宽度左对齐，右边空出一大截（1200px 下按钮右边缘离栏内边界 51px），
  // 面板底色与分隔线也一起丢了。断言只看几何，不看某个具体 display，避免把实现钉死。
  const searchRow = await ui.evaluate(`(() => {
    const section = document.querySelector('#tree-search');
    const style = getComputedStyle(section);
    const contentRight = section.getBoundingClientRect().right - (parseFloat(style.borderRightWidth) || 0) - (parseFloat(style.paddingRight) || 0);
    const input = document.querySelector('#tree-search-input').getBoundingClientRect();
    const button = document.querySelector('#tree-named-only').getBoundingClientRect();
    return {
      contentRight: +contentRight.toFixed(2),
      buttonRight: +button.right.toFixed(2),
      rightGap: +(contentRight - button.right).toFixed(2),
      inputLeft: +input.left.toFixed(2),
      inputRight: +input.right.toFixed(2),
      sameRow: Math.abs(input.bottom - button.bottom) <= 1.5,
      overlap: +(input.right - button.left).toFixed(2),
    };
  })()`);
  check('搜索行的控件铺满一行（右边缘贴齐面板内容右边缘，且不与按钮重叠）', Math.abs(searchRow.rightGap) <= 1 && searchRow.sameRow && searchRow.overlap <= 1 && searchRow.inputRight > searchRow.inputLeft, JSON.stringify(searchRow));

  check('未过滤时活跃树 4 行', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.unnamed1, ids.beta, ids.unnamed2]), JSON.stringify(await rows()));

  // M-18（排序模式）：导航里一个循环按钮（最近 → 最早 → 名称 → 最近），点一下兄弟顺序真的变。
  const sortControl = await ui.evaluate(`(() => { const b=document.querySelector('#tree-sort-toggle'); if(!b) return null; const s=getComputedStyle(b); return {text:b.textContent, slot:s.borderLeftWidth, height:b.getBoundingClientRect().height}; })()`);
  check('排序入口在岗（导航里的循环按钮，走既有 3px 槽）', sortControl !== null && sortControl.slot === '3px', JSON.stringify(sortControl));
  check('排序按钮标明当前模式（默认「最近」= 旧行为）', sortControl?.text === '排序 最近', JSON.stringify(sortControl));

  const clickSort = async () => { await ui.evaluate(`document.querySelector('#tree-sort-toggle').click()`); await ui.frames(2); };
  await clickSort();
  check('切到「最早」⇒ 兄弟顺序真的反过来', JSON.stringify(await rows()) === JSON.stringify([ids.unnamed2, ids.beta, ids.unnamed1, ids.alpha]), JSON.stringify(await rows()));
  check('按钮文案跟着模式变', (await ui.evaluate(`document.querySelector('#tree-sort-toggle').textContent`)) === '排序 最早', 'early');

  await clickSort();
  check('切到「名称」⇒ 有名字的按名称在前，无名字的按最近活动在后', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.beta, ids.unnamed1, ids.unnamed2]), JSON.stringify(await rows()));

  await setQuery('alpha');
  const sortedFiltered = await rows();
  check('排序与过滤叠加：名称模式下搜 alpha ⇒ 仍是命中的 2 行', JSON.stringify(sortedFiltered) === JSON.stringify([ids.alpha, ids.unnamed2]), JSON.stringify(sortedFiltered));
  await setQuery('');

  await clickSort();
  check('再点一下回到「最近」（默认顺序）', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.unnamed1, ids.beta, ids.unnamed2]), JSON.stringify(await rows()));

  await setQuery('beta');
  check('搜 beta ⇒ 只剩 1 行（Beta 笔记）', JSON.stringify(await rows()) === JSON.stringify([ids.beta]), JSON.stringify(await rows()));

  await setQuery('alpha');
  check('搜 alpha ⇒ 名字或 cwd 命中 2 行（Alpha 项目 + /work/alpha2）', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.unnamed2]), JSON.stringify(await rows()));

  await setQuery('');
  check('清空 ⇒ 恢复到 4 行原顺序', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.unnamed1, ids.beta, ids.unnamed2]), JSON.stringify(await rows()));

  await namedOnly();
  check('只看命名 ⇒ 只留 name 非空的 2 行', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.beta]), JSON.stringify(await rows()));
  const pressed = await ui.evaluate(`document.querySelector('#tree-named-only').getAttribute('aria-pressed')`);
  check('只看命名按钮 aria-pressed=true', pressed === 'true', pressed);

  await setQuery('beta');
  check('只看命名 + 搜 beta ⇒ 1 行', JSON.stringify(await rows()) === JSON.stringify([ids.beta]), JSON.stringify(await rows()));
  await setQuery('');
  await namedOnly();
  await ui.frames(2);
  check('关掉只看命名 ⇒ 恢复 4 行', JSON.stringify(await rows()) === JSON.stringify([ids.alpha, ids.unnamed1, ids.beta, ids.unnamed2]), JSON.stringify(await rows()));

  await setQuery('zzz');
  const empty = await ui.evaluate(`({rows:document.querySelectorAll('.tree-session').length, text:document.querySelector('.tree-empty')?.textContent})`);
  check('没有匹配 ⇒ 0 行且空态文案正确', empty.rows === 0 && empty.text === '没有匹配的会话。', JSON.stringify(empty));

  // 归档区同样受过滤：展开存档箱后 alpha 命中活跃 2 + 归档 1；beta 命中活跃 1、归档归零（存档箱收起）。
  await setQuery('');
  await ui.evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('[data-attic-list="true"]') !== null`), 'attic did not open');
  await setQuery('alpha');
  const withAttic = await rows();
  check('展开存档箱后搜 alpha ⇒ 活跃 2 + 归档 1 = 3 行', withAttic.length === 3 && withAttic.includes(ids.archived), JSON.stringify(withAttic));
  await setQuery('beta');
  const atticFiltered = await ui.evaluate(`({rows:Array.from(document.querySelectorAll('.tree-session')).map((r)=>r.dataset.sessionId), atticList:document.querySelector('[data-attic-list="true"]')!==null})`);
  check('搜 beta ⇒ 归档无命中、存档箱收起', JSON.stringify(atticFiltered.rows) === JSON.stringify([ids.beta]) && atticFiltered.atticList === false, JSON.stringify(atticFiltered));

  await setQuery('');
  await ui.frames(2);
  check('再次清空 ⇒ 活跃与归档全部恢复', (await rows()).length === 5, JSON.stringify(await rows()));
  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  await ui.screenshot(screenshotFile);
  print('filter rows', { inAttic: await rows() });
  print('screenshots', { filter: screenshotFile });
  print('RESULT', `M-18 tree search + named-only PASS (${checks} checks)`);
} finally {
  await ui.close();
}
