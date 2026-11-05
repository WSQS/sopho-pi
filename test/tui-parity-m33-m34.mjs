#!/usr/bin/env node
// tui-parity-m33-m34.mjs —— `docs/tui-parity.md` 里 M-33 / M-34 的**前端那一半**的契约门（真 Chromium）。
//
// 背景：两条的服务端投影都已完成、也各有 `test:projection -- --item M-33/M-34` 守着，
// 但修前 `web/` 侧一条都没接（`grep -rn --exclude-dir=vendor "branchSummar\|billed\|compacted" web/` → 0）：
//   · M-33：`branch_summary` entry 在网页上**根本画不出来**（前端只认 messages / extras / compaction）；
//   · M-34：压缩块上**没有计费行**，也没有「本会话压缩过几次」。
// 本门就是量这两者在**真 Chromium** 里是否画对（不只是「画出来了」——要逐字比内容）。
//
// 断言（每条都带正反两面）：
//   M-33 正：`payload.branchSummaries[]` 每一条都画成 `.compaction-note[data-kind=branch_summary]`，
//           摘要文本逐字正确；落在 `messages[atIndex]` **之前**（与服务端 atIndex 语义一致）。
//   M-33 反：summary 缺失的 entry **照画块**但如实写「服务端未提供」，不编摘要。
//   M-34 正：`usage.status === 'known'` 的压缩块 / 分支摘要块都画一行
//           `Compaction|Branch summary: N tokens billed (~$X.XX)`（N = input+output+cacheRead+cacheWrite，
//           与 pi TUI `addCompactionCostNotice` 同口径）；成本只在 `cost.total >= 0.01` 时附上。
//   M-34 反：`usage.status !== 'known'`（entry 上没有 usage）**不画计费行**（TUI 也是没 usage 就不加 notice），
//           不拿 0 冒充；「本会话压缩次数」在 wire 没有计数字段时**如实写「服务端未提供」**。
//   M-34 计数字段（服务端将来若给）：`compactionCount: N` ⇒ 画「本会话压缩过 N 次」。
//           这一支现在**在真 wire 上走不到**（服务端只投影最新一条 compaction，没有计数），
//           本门喂合成 payload 把这条渲染分支焊住，免得以后服务端给了计数前端反而不认。
//   M-33/M-34 公共：块复用既有 `.compaction-note` 样式（slot = `--slot-extra`）、不横向溢出、
//           页面零未捕获异常。
//
// 修前对照（red→green 的另一半）：`SOPHO_PARITY_WEB=/tmp/m33m34-web-before node test/tui-parity-m33-m34.mjs`
// —— 同一把尺子量修前的 `web/`，M-33/M-34 的正反面断言必红。
//
// 纪律（与 ui-harness 一致）：真 Chromium + 假 API + 临时 user-data-dir；**不碰真 profile**；
// 清理一律走 `test/harness.mjs` 的 cleanupStep/removeSandbox/finishCleanup。
//
// 跑法：CHROME_BIN=/usr/bin/chromium node test/tui-parity-m33-m34.mjs

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
if (!existsSync(chrome)) {
  // 素材缺了要**显式 SKIP**，不许静默通过。
  process.stdout.write(`⤵ SKIP test:tui-parity-m33-m34 —— 找不到真 Chromium（CHROME_BIN=${chrome}）\n`);
  process.exit(0);
}

const webRoot = process.env.SOPHO_PARITY_WEB ? path.resolve(process.env.SOPHO_PARITY_WEB) : undefined;

const ids = { positive: 'aaaa1111-1111-4111-8111-111111111111', negative: 'bbbb2222-2222-4222-8222-222222222222' };
const sessions = [
  { id: ids.positive, name: 'M33/M34 正', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.negative, name: 'M33/M34 反', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

const COMPACTION_NOTE = '正文列表 ≠ 模型现在看得见的东西';
const BRANCH_NOTE = '切分支时给被抛下的那条路生成的摘要（不是正文消息）';

/** 正例：compaction usage 143 tokens、成本 $0.0521（>= 0.01 ⇒ 要显示 (~$0.05)）；
 *  分支摘要 #1 usage 83 tokens、成本 0（< 0.01 ⇒ 不显示成本）；#2 没有 usage（诚实性，不画计费行）。
 *  `compactionCount: 3` 是**服务端将来才会给的字段**（现在真 wire 上没有），单独焊计数渲染分支。 */
const positiveMessages = [
  { entryId: 'p1', role: 'user', text: '正例第一问' },
  { entryId: 'p2', role: 'assistant', text: '正例第一答' },
  { entryId: 'p3', role: 'user', text: '正例第二问' },
];
const positivePayload = {
  sessionId: ids.positive,
  messages: positiveMessages,
  extras: [],
  branchSummaries: [
    {
      entryId: 'bs-1', parentId: 'c-1', fromId: 'p2', atIndex: 2, timestamp: '2026-09-20T08:00:00.000Z',
      summary: 'BRANCH-SUMMARY-ONE', usage: { status: 'known', input: 41, output: 42, cacheRead: 0, cacheWrite: 0, raw: { input: 41, output: 42, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, note: null },
      details: { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] }, note: BRANCH_NOTE,
    },
    {
      entryId: 'bs-2', parentId: 'bs-1', fromId: 'p3', atIndex: 2, timestamp: '2026-09-20T08:00:01.000Z',
      summary: 'BRANCH-SUMMARY-TWO', usage: { status: 'unknown', input: null, output: null, cacheRead: null, cacheWrite: null, raw: null, note: 'entry 上没有 usage' },
      details: null, note: BRANCH_NOTE,
    },
  ],
  compaction: {
    entryId: 'c-1', atIndex: 2, timestamp: '2026-09-20T08:00:02.000Z', summary: 'COMPACTION-SUMMARY-A',
    firstKeptEntryId: 'p3', tokensBefore: 1234,
    usage: { status: 'known', input: 71, output: 72, cacheRead: 0, cacheWrite: 0, raw: { input: 71, output: 72, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0521 } }, note: null },
    details: { readFiles: ['a.ts'], modifiedFiles: ['d.ts'] }, note: COMPACTION_NOTE,
  },
  compactionCount: 3,
  observability: null,
};

/** 反例：atIndex = messages.length（落在正文末尾），compaction 与分支摘要**都没有 usage** ⇒ 不画计费行；
 *  wire 没有计数字段 ⇒ 「本会话压缩次数：服务端未提供」。 */
const negativeMessages = [
  { entryId: 'n1', role: 'user', text: '反例第一问' },
  { entryId: 'n2', role: 'assistant', text: '反例第一答' },
  { entryId: 'n3', role: 'user', text: '反例第二问' },
];
const unknownUsage = { status: 'unknown', input: null, output: null, cacheRead: null, cacheWrite: null, raw: null, note: 'entry 上没有 usage' };
const negativePayload = {
  sessionId: ids.negative,
  messages: negativeMessages,
  extras: [],
  branchSummaries: [
    { entryId: 'bs-3', parentId: 'c-2', fromId: 'n2', atIndex: 3, timestamp: '2026-09-20T07:00:00.000Z', summary: 'BRANCH-SUMMARY-THREE', usage: unknownUsage, details: null, note: BRANCH_NOTE },
  ],
  compaction: { entryId: 'c-2', atIndex: 3, timestamp: '2026-09-20T07:00:01.000Z', summary: 'COMPACTION-SUMMARY-B', firstKeptEntryId: 'n3', tokensBefore: 4321, usage: unknownUsage, details: null, note: COMPACTION_NOTE },
  observability: null,
};

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const PROBE = `(() => {
  const nodes = Array.from(document.querySelectorAll('#messages .compaction-note'));
  return {
    blocks: nodes.map((node) => ({
      kind: node.dataset.kind ?? null,
      entryId: node.dataset.entryId ?? null,
      label: node.querySelector('.compaction-label')?.textContent ?? null,
      summary: node.querySelector('.compaction-summary')?.textContent ?? null,
      billing: node.querySelector('.compaction-billing')?.textContent ?? null,
      count: node.querySelector('.compaction-count')?.textContent ?? null,
      slot: getComputedStyle(node).getPropertyValue('--slot').trim(),
      overflowX: Math.round((node.scrollWidth - node.clientWidth) * 100) / 100,
      width: Math.round(node.getBoundingClientRect().width),
    })),
    order: Array.from(document.querySelectorAll('#messages > *')).map((node) => node.dataset.kind ?? ('message-' + (node.dataset.role ?? '?'))),
    messageWidth: Math.round(document.querySelector('#messages > .message')?.getBoundingClientRect().width ?? 0),
    extraSlot: getComputedStyle(document.documentElement).getPropertyValue('--slot-extra').trim(),
  };
})()`;

const ui = { instance: null };
let primaryError = null;
try {
  ui.instance = await boot({
    webRoot,
    routes: async (request, response, url) => {
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
        return true;
      }
      const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen)$/.exec(url.pathname);
      if (match) {
        const id = match[1];
        if (match[2] === 'messages') {
          const payload = id === ids.positive ? positivePayload : negativePayload;
          return sendJson(response, 200, payload), true;
        }
        if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
        if (match[2] === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
          return true;
        }
      }
      const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        const session = sessions.find((entry) => entry.id === detail[1]);
        if (!session) return sendJson(response, 404, { message: 'missing' }), true;
        return sendJson(response, 200, { name: session.name, cwd: '/work/m33m34', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
      }
      return false;
    },
  });
  const page = ui.instance;

  const open = async (id) => {
    await waitFor(() => page.evaluate(`!!document.querySelector('[data-session-id="${id}"] .tree-select')`), `tree row ${id} did not render`);
    await page.evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
    await waitFor(() => page.evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#messages').dataset.renderComplete === 'true'`), `session ${id} did not open`);
    await page.frames(4);
  };
  const probe = () => page.evaluate(PROBE);

  await waitFor(() => page.evaluate(`document.querySelectorAll('.tree-session').length === 2`), 'tree did not render');
  print('webRoot', { served: webRoot ?? '(本仓 web/)', chromium: chrome });

  // ── 正例 ────────────────────────────────────────────────────────────────
  await open(ids.positive);
  const positive = await probe();
  print('正例 DOM', positive);

  const compactionBlock = positive.blocks.find((block) => block.kind === 'compaction');
  const branchOne = positive.blocks.find((block) => block.entryId === 'bs-1');
  const branchTwo = positive.blocks.find((block) => block.entryId === 'bs-2');

  check('M-33 正：两条 branch_summary 都画成块，且都在',
    Boolean(branchOne) && Boolean(branchTwo), JSON.stringify(positive.blocks.map((b) => [b.kind, b.entryId])));

  check('M-33 正：分支摘要块标签/摘要逐字正确（⑂ 分支摘要 @ 2 + 摘要全文）',
    Boolean(branchOne) && branchOne.kind === 'branch_summary'
      && branchOne.label.includes('⑂ 分支摘要 @ 2') && branchOne.label.includes(BRANCH_NOTE)
      && branchOne.summary === '摘要：BRANCH-SUMMARY-ONE',
    JSON.stringify(branchOne));

  check('M-33 正：分支摘要块落在 messages[atIndex=2] 之前（顺序：p1,p2,压缩块,分支块×2,p3）',
    positive.order.join(',') === ['message', 'message', 'compaction', 'branch_summary', 'branch_summary', 'message'].join(','),
    JSON.stringify(positive.order));

  check('M-33 反：usage/summary 缺失的 branch_summary 照画块，但如实写「服务端未提供」，不编',
    Boolean(branchTwo) && branchTwo.summary === '摘要：BRANCH-SUMMARY-TWO' && branchTwo.billing === null,
    JSON.stringify(branchTwo));

  // ── M-34 正例：计费行 ────────────────────────────────────────────────────
  check('M-34 正：压缩块画出计费行（143 = 71+72+0+0，成本 $0.0521 ⇒ (~$0.05)）',
    compactionBlock?.billing === 'Compaction: 143 tokens billed (~$0.05)',
    JSON.stringify(compactionBlock?.billing));

  check('M-34 正：分支摘要块画出计费行（83 = 41+42，成本 0 < 0.01 ⇒ 不附成本）',
    branchOne?.billing === 'Branch summary: 83 tokens billed',
    JSON.stringify(branchOne?.billing));

  check('M-34 正：服务端给了计数（compactionCount: 3）⇒ 画「本会话压缩过 3 次」',
    compactionBlock?.count === '本会话压缩过 3 次',
    JSON.stringify(compactionBlock?.count));

  // ── M-33/M-34 复用与布局（不造平行样式体系）─────────────────────────────
  check('复用：块 className 都是 compaction-note，slot = --slot-extra（不造平行样式）',
    positive.blocks.length === 3 && positive.blocks.every((block) => block.slot === positive.extraSlot && block.slot !== ''),
    JSON.stringify({ extraSlot: positive.extraSlot, slots: positive.blocks.map((block) => block.slot) }));

  check('布局：块与正文同宽、不横向溢出',
    positive.messageWidth > 0 && positive.blocks.every((block) => block.width === positive.messageWidth && block.overflowX <= 0),
    JSON.stringify({ messageWidth: positive.messageWidth, blocks: positive.blocks.map((b) => [b.width, b.overflowX]) }));

  // ── 反例：无 usage 不画计费行；无计数如实标未提供 ─────────────────────────
  await open(ids.negative);
  const negative = await probe();
  print('反例 DOM', negative);

  check('M-33 反：反例会话也画出了分支摘要块（atIndex = messages.length ⇒ 落在正文末尾）',
    negative.blocks.some((block) => block.kind === 'branch_summary' && block.entryId === 'bs-3')
      && negative.order.slice(-2).join(',') === 'compaction,branch_summary',
    JSON.stringify({ order: negative.order, blocks: negative.blocks.map((b) => [b.kind, b.entryId]) }));

  check('M-34 反：usage.status = unknown ⇒ 压缩块与分支摘要块都不画计费行（不拿 0 冒充）',
    negative.blocks.every((block) => block.billing === null),
    JSON.stringify(negative.blocks.map((block) => block.billing)));

  check('M-34 反：wire 没有计数字段 ⇒ 如实写「本会话压缩次数：服务端未提供」',
    negative.blocks.find((block) => block.kind === 'compaction')?.count === '本会话压缩次数：服务端未提供',
    JSON.stringify(negative.blocks.find((block) => block.kind === 'compaction')?.count));

  check('页面没有未捕获异常或 console.error', page.pageProblems.length === 0, JSON.stringify(page.pageProblems));

  print('checks', checks);
  print('RESULT', `M-33/M-34 frontend parity PASS (${checks} checks；正例计费行 + 反例不编 + 分支摘要块 + 计数出处)`);
} catch (error) {
  primaryError = error;
} finally {
  const problems = [];
  // 传 problems：收尾自己失败（等不到整棵树退出 / 删完又出现）也进这条判红通道，不静默。
  await cleanupStep(problems, 'close ui', async () => { if (ui.instance) await ui.instance.close(problems); });
  if (ui.instance?.sandbox) await removeSandbox(ui.instance.sandbox, problems);
  finishCleanup(primaryError, problems);
}
