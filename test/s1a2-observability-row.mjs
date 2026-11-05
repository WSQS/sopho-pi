// M-20 / M-23 / M-22 门：观测行补 cache 统计、上下文百分比+窗口（阈值配色走既有 token）、cwd 一眼可见。
// 数值全部来自受控假 payload —— 改数字必须跟着变；各条阈值边界各一例。
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const sessionId = '22222222-2222-4222-8222-222222222222';
const sessions = [{
  id: sessionId, name: '观测行回归', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, cwd: 'C:/work/observability', modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];
const state = {
  cwd: sessions[0].cwd,
  // M-11：`runtime.thinkingLevel` 的受控开关。null = 服务端**根本不给这个字段**（老服务端 / 读不到）。
  thinkingLevel: null,
  context: { modelId: 'fake/obs', provider: 'fake', contextWindow: 4096, usedTokens: 3000, thresholdTokens: 3700, freeTokens: 700, reserveTokens: 396, keepRecentTokens: 128, compactionEnabled: true },
  observability: {
    lastTurn: { model: { display: 'fake/obs' }, usage: { status: 'known', input: 100, output: 20, cacheRead: 800, cacheWrite: 200 } },
    cumulative: { usage: { status: 'known', input: 1000, output: 200, cacheRead: 8000, cacheWrite: 2000 }, cost: { status: 'estimated', total: 0.5 } },
  },
};
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const artifacts = [
  `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-observability-row-1200x760.png`,
  `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-observability-row-900x760.png`,
  `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-observability-row-420x820.png`,
];

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/control/set') {
      const patch = JSON.parse(url.searchParams.get('patch') || '{}');
      if ('cwd' in patch) state.cwd = patch.cwd;
      if ('context' in patch) state.context = patch.context;
      if ('observability' in patch) state.observability = patch.observability;
      if ('thinkingLevel' in patch) state.thinkingLevel = patch.thinkingLevel;
      return sendJson(response, 200, { ok: true }), true;
    }
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: sessions.map((s) => ({ ...s, cwd: state.cwd })), unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: sessions.map((s) => ({ ...s, cwd: state.cwd })) })}\n\n`);
      return true;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) {
      // M-11：只有服务端真给了非空字符串才带上 `thinkingLevel`（否则整个字段不出现，模拟“读不到”）。
      const runtime = { isStreaming: false, isCompacting: false, isRetrying: false };
      if (typeof state.thinkingLevel === 'string' && state.thinkingLevel !== '') runtime.thinkingLevel = state.thinkingLevel;
      return sendJson(response, 200, { name: sessions[0].name, cwd: state.cwd, archived: false, runtime, observability: state.observability, context: state.context }), true;
    }
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: state.observability, context: state.context }), true;
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

const snapshot = () => ui.evaluate(`(() => {
  const usage=document.querySelector('#session-usage'); const ctx=document.querySelector('#session-context'); const cwd=document.querySelector('#session-cwd');
  const cs=ctx?getComputedStyle(ctx):null; const ws=cwd?getComputedStyle(cwd):null;
  const ucs=getComputedStyle(usage);
  // 行数用 Range 的行盒（不同 top 值）算 —— clientHeight 在 overflow:hidden 下会被钳到 26，数不出换行。
  const node=usage.firstChild; const range=document.createRange(); let lines=0;
  if(node){ range.setStart(node,0); range.setEnd(node,node.length); lines=[...new Set([...range.getClientRects()].map(b=>Math.round(b.top)))].length; }
  return {
    usage: usage.textContent,
    usageRow: { text: usage.textContent, title: usage.getAttribute('title'), lines, whiteSpace: ucs.whiteSpace, clientHeight: usage.clientHeight, scrollHeight: usage.scrollHeight, scrollWidth: usage.scrollWidth, clientWidth: usage.clientWidth },
    context: { text: ctx?.textContent, level: ctx?.dataset.level, hidden: ctx?.hidden, color: cs?.color, height: ctx?.getBoundingClientRect().height },
    cwd: { text: cwd?.textContent, title: cwd?.getAttribute('title'), hidden: cwd?.hidden, height: cwd?.getBoundingClientRect().height, whiteSpace: ws?.whiteSpace, textOverflow: ws?.textOverflow },
    scroll: { doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
  };
})()`);
const assertOneLine = (name, row) => {
  check(`${name} 恰好一行（Range 行盒）`,
    row.lines === 1 && row.whiteSpace === 'nowrap' && row.clientHeight === 26 && row.scrollHeight <= 27,
    JSON.stringify({ lines: row.lines, whiteSpace: row.whiteSpace, clientHeight: row.clientHeight, scrollHeight: row.scrollHeight }));
};
const reselect = async () => {
  await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not reopen');
  await ui.frames(3);
};
const setState = async (patch) => {
  const response = await fetch(`http://127.0.0.1:${ui.port}/control/set?patch=${encodeURIComponent(JSON.stringify(patch))}`);
  if (!response.ok) throw new Error(`control/set failed: ${response.status}`);
};

try {
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  await reselect();

  const initial = await snapshot();
  check('M-20 缓存统计来自 payload 真值（读取/写入取累计）', initial.usage.includes('缓存 读取8.0k / 写入2.0k'), initial.usage);
  check('M-20 命中率按最近一轮 cacheRead/(input+cacheRead+cacheWrite) 口径，且 R/W/CH 已改为明文', initial.usage.includes('命中率72.7%') && !/R[\d,]+|CH\d/.test(initial.usage), initial.usage);
  check('M-20 累计输入/输出仍来自 payload（没被改口径，只是 k/M 缩写）', initial.usage.includes('累计输入 1.0k / 输出 200'), initial.usage);
  check('观测行保留字段集合 = 推荐方案（模型/距离/费用/缓存/累计，一个不漏）',
    ['本轮 fake/obs', '距压缩阈值还剩 700 tokens', '约 $0.500（估算）', '缓存 读取8.0k / 写入2.0k / 命中率72.7%', '累计输入 1.0k / 输出 200'].every((part) => initial.usage.includes(part)),
    initial.usage);
  check('观测行已删的两个括号（限定语进 title，不占行宽）',
    !initial.usage.includes('（仅已知轮次）') && !initial.usage.includes('（估算，非账单）')
      && /不是账单/.test(initial.usageRow.title) && /精确/.test(initial.usageRow.title),
    JSON.stringify({ text: initial.usage, title: initial.usageRow.title }));
  check('观测行不再重复单轮 in/out（用户点名的重复感）', !/输入 100 /.test(initial.usage) && !/输出 20( |$|·)/.test(initial.usage), initial.usage);
  assertOneLine('1200x760', initial.usageRow);
  check('M-23 上下文百分比 + 窗口来自 payload 真值', initial.context.text === '上下文 73.2% / 4,096', initial.context.text);
  check('M-23 73.2% 超 70% ⇒ 黄（既有 --slot-warning token）', initial.context.level === 'warn' && initial.context.color === 'rgb(216, 180, 90)', JSON.stringify(initial.context));
  check('M-22 cwd 在顶栏一眼可见且带完整路径 tooltip', initial.cwd.hidden === false && initial.cwd.text === 'C:/work/observability' && initial.cwd.title === 'C:/work/observability', JSON.stringify(initial.cwd));

  // 改数字 ⇒ 文案/配色跟着变（阈值边界：恰好 70% 不算黄，90% 不算红，90.1% 才红）。
  await setState({
    context: { modelId: 'fake/obs', provider: 'fake', contextWindow: 1000, usedTokens: 700, thresholdTokens: 604, freeTokens: -96, reserveTokens: 396, keepRecentTokens: 128, compactionEnabled: true },
    observability: {
      lastTurn: { model: { display: 'fake/obs' }, usage: { status: 'known', input: 200, output: 9, cacheRead: 600, cacheWrite: 200 } },
      cumulative: { usage: { status: 'known', input: 2000, output: 300, cacheRead: 1234, cacheWrite: 567 }, cost: { status: 'estimated', total: 0.125 } },
    },
  });
  await reselect();
  const changed = await snapshot();
  check('M-20 改 cache 数字 ⇒ 读取/写入/命中率跟着变', changed.usage.includes('缓存 读取1.2k / 写入567 / 命中率60.0%'), changed.usage);
  check('M-20 改累计数字 ⇒ 累计输入/输出跟着变（k 缩写）', changed.usage.includes('累计输入 2.0k / 输出 300'), changed.usage);
  check('M-23 恰好 70.0% ⇒ 不黄（阈值是 >70）', changed.context.text === '上下文 70.0% / 1,000' && changed.context.level === 'ok' && changed.context.color === 'rgb(105, 108, 117)', JSON.stringify(changed.context));

  await setState({ context: { ...state.context, usedTokens: 900 } });
  await reselect();
  const warn = await snapshot();
  check('M-23 恰好 90.0% ⇒ 黄不红（阈值是 >90）', warn.context.text === '上下文 90.0% / 1,000' && warn.context.level === 'warn' && warn.context.color === 'rgb(216, 180, 90)', JSON.stringify(warn.context));

  await setState({ context: { ...state.context, usedTokens: 901 } });
  await reselect();
  const error = await snapshot();
  check('M-23 90.1% ⇒ 红（既有 --slot-error token）', error.context.text === '上下文 90.1% / 1,000' && error.context.level === 'error' && error.context.color === 'rgb(224, 104, 104)', JSON.stringify(error.context));

  const longCwd = `C:/${'very-long-segment/'.repeat(8)}leaf-dir`;
  await setState({ cwd: longCwd });
  await reselect();
  const long = await snapshot();
  check('M-22 超长 cwd 做头部省略、叶子目录仍可见', long.cwd.text.startsWith('…') && long.cwd.text.endsWith('leaf-dir') && long.cwd.title === longCwd, JSON.stringify(long.cwd));
  check('M-22 cwd 行固定 26px 单行 + 省略号截断', long.cwd.height === 26 && long.cwd.whiteSpace === 'nowrap' && /ellipsis/.test(long.cwd.textOverflow), JSON.stringify(long.cwd));

  await ui.resize(420, 820);
  const narrow = await snapshot();
  check('M-22 窄屏不撑破（无横向滚动）且 cwd 仍 26px 单行', narrow.scroll.doc <= narrow.scroll.client && narrow.cwd.height === 26, JSON.stringify({ scroll: narrow.scroll, cwd: narrow.cwd }));
  assertOneLine('420x820（截断也不换行）', narrow.usageRow);
  check('420 观测行确实被 ellipsis 截（省下的宽度不是靠没内容）', narrow.usageRow.scrollWidth > narrow.usageRow.clientWidth, JSON.stringify(narrow.usageRow));
  await ui.screenshot(artifacts[2]);

  await ui.resize(900, 760);
  await ui.frames(3);
  const mid = await snapshot();
  assertOneLine('900x760', mid.usageRow);
  await ui.screenshot(artifacts[1]);

  // ③ 未知数据仍说「未知」，不拿空白/0 冒充。
  await ui.resize(1200, 760);
  await setState({ observability: null });
  await reselect();
  const unknown = await snapshot();
  check('未知观测事实仍沿用「未知」文案（不是空白、不是 0）',
    unknown.usage === '本轮模型未知 · 累计未知 · 已超过压缩阈值 96 tokens', unknown.usage);
  assertOneLine('未知文案', unknown.usageRow);

  // M-11（思考档位**只读显示**）正反两面。这一段开始时 `state.thinkingLevel = null`（服务端根本没给这个字段）。
  check('M-11 服务端没给 thinkingLevel ⇒ 行里不出现档位（不猜、不默认某个档位）',
    !unknown.usage.includes('•') && !/思考档位/.test(unknown.usageRow.title), JSON.stringify({ usage: unknown.usage, title: unknown.usageRow.title }));

  await setState({ thinkingLevel: 'medium' });
  await reselect();
  const levelOnly = await snapshot();
  check('M-11 观测事实未知但仍给了 thinkingLevel ⇒ 按 model • level 如实写出（本轮模型未知 • medium）',
    levelOnly.usage === '本轮模型未知 • medium · 累计未知 · 已超过压缩阈值 96 tokens', levelOnly.usage);

  // 恢复一份已知的观测事实，验「模型 + 档位」同时可见那一条（与 pi TUI footer 的 `model • level` 同格式）。
  await setState({
    observability: {
      lastTurn: { model: { display: 'fake/obs' }, usage: { status: 'known', input: 100, output: 20, cacheRead: 800, cacheWrite: 200 } },
      cumulative: { usage: { status: 'known', input: 1000, output: 200, cacheRead: 8000, cacheWrite: 2000 }, cost: { status: 'estimated', total: 0.5 } },
    },
  });
  await reselect();
  const withLevel = await snapshot();
  check('M-11 给了 thinkingLevel ⇒ 观测行显示 `model • level`（与 pi TUI footer 同格式）',
    withLevel.usage.includes('本轮 fake/obs • medium'), withLevel.usage);
  check('M-11 档位来源写进 title 且标明「只读」（不冒充这里能切换）',
    /思考档位（只读）/.test(withLevel.usageRow.title), JSON.stringify(withLevel.usageRow.title));
  assertOneLine('带档位', withLevel.usageRow);

  await setState({ thinkingLevel: null });
  await reselect();
  const levelGone = await snapshot();
  check('M-11 thinkingLevel 变回缺失 ⇒ 档位不再显示（不把上一份档位留在行里）',
    !levelGone.usage.includes('medium') && !levelGone.usage.includes('•'), levelGone.usage);

  await ui.resize(1200, 760);
  await ui.frames(3);
  await ui.screenshot(artifacts[0]);
  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  print('observability row', changed);
  print('screenshots', { observability: artifacts[0] });
  print('RESULT', `M-20/M-23/M-22 observability row PASS (${checks} checks)`);
} finally {
  await ui.close();
}
