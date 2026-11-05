#!/usr/bin/env node
// test/tree-row-flush.mjs —— 左栏会话行「铺满一行（缩进行除外）」的门（真 Chromium，1440×900）。
//
// 业主原话（逐字，2026-09-25）：「对照目前的设计页面我和我们实际上的真实页面，可以看到，我们的左侧栏当中的会话栏
// 左侧还是有一个空隙，请你去除它，使其铺满一行，除了缩进行的情况」。
// 翻成可量的三条：
//   ① `rail`   —— `#tree` 的左内边距为 0，且**它的内容区左边缘 == 左栏内容区左边缘**；
//   ② `flush`  —— **非缩进**会话行（`[data-depth="0"]`）的左边缘 == 左栏内容区左边缘（**零容差**）；
//   ③ `indent` —— **缩进**会话行仍然缩进：`depth=1`/`depth=2` 各自相对上一级的位移 == **改前实测值**
//                  （零容差）—— 这就是「缩进行除外」的机械表达（缩进只由行自己的 `margin-inline-start`
//                  表达，不许被一起抹平）；
//   ④ `slot`   —— 最左那条 3px 状态槽仍然贴在**本行**的最左（槽宽恰好 3px、solid、色只取自 `--slot-*`）；
//   ⑤ `content`—— 行的内容（`.tree-select`）起点 = 行左边缘 + 3px（+ 折叠列的 2rem，当这一行有折叠键时），
//                  也就是**没有**任何东西被塞到槽的左边；
//   ⑥ `rowbox` —— 行的右边缘仍与列表内容区右边缘对齐（右内边距保留不动）、高仍是 26px
//                  （不许拿「把行缩窄 / 挪出去」冒充「去掉空隙」）。
// 另有一条**只记录、不判死**的读数：存档箱（展开后）里的会话行 —— 它仍是 3.4px，见文件里那段注释。
//
// 起因（**改前的原始读数**在交付报告里）：`web/index.html` 的 `#tree` 原来是 `padding: .2rem .3rem`
// —— 那条**左**内边距把整棵树（含每一行）从「左栏内容区左边缘」往右推了 0.3rem × 16px = 4.8px，
// 于是每条会话行的左边缘都落在 4.8px 处、3px 状态槽画在 [4.8, 7.8]，左边留出那一条空隙。
// 修法：`#tree` 的**左**内边距归零（右内边距不动 —— 业主说的是左侧那条空隙，不许顺手改别的）。
// 缩进机制**不在这条链上**：`web/render.js` 给每条行写 `row.style.marginInlineStart = depth × .65rem`，
// 所以「左栏内容区左边缘」就是每一行自己盒子的左边缘，缩进行靠自己的 margin 往右挪 ⇒ 缩进量不变。
//
// 反证臂（各自必红；改的都是 `web/` 的**临时副本**，真 `web/` 一个字节不动，跑完即删）：
//   npm run test:treeflush:reverse-gap     —— 把 `#tree` 的左内边距**加回** `.3rem` ⇒ ①②必红（③④⑤⑥必须仍绿）
//   npm run test:treeflush:reverse-flatten —— 把 `render.js` 的缩进写死成 `0rem`（缩进行也被抹平）⇒ ③必红（其余仍绿）
// 两条臂都断言「**预期的那一条**确实红了」，不是「红没红都算对」——一道从不判红的门等于没有门。
//
// 用法：
//   CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/tree-row-flush.mjs
//   ... --measure            # 只量不判死（改前 / 调几何时用；打印原始读数 + 拍图，退出码 0）
//   ... --label=before       # 截图文件名前缀（改前 / 改后各留一组）
//   ... --reverse-arm=gap|flatten
//   ... --web-root=<目录>     # 把「真实现」指到 web/ 的副本上（反证臂自己用；人也能手动用）
//
// 沙箱纪律（`test/harness.mjs` / `test/ui-harness.mjs`）：高位随机端口、临时 profile、私有 TMPDIR/home/XDG；
// 不碰真 profile、不用 7331/7321、绝不 pkill（收尾只按本次 spawn 的精确 pid）。截图落在
// `$TEMP/sopho-tree-row-flush/`（不入仓；本仓 git 里没有任何 PNG 的先例）。
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { boot, sendJson } from './ui-harness.mjs';
import { createUiSettingsStore, UI_SETTINGS_FILE_NAME } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 业主验收用的约定视口（会话页）。
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const MEASURE = process.argv.includes('--measure');
const LABEL = (process.argv.find((arg) => arg.startsWith('--label=')) || '').split('=')[1] || 'current';
const ARTIFACT_DIR = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'sopho-tree-row-flush');
let runWebRoot = path.resolve(process.argv.find((arg) => arg.startsWith('--web-root='))?.split('=')[1]
  || process.env.SOPHO_TREEFLUSH_WEBROOT
  || path.join(root, 'web'));

// 缩进量 = `web/render.js` 写的 `depth × .65rem`，`.65rem × 16px = 10.4px` —— **这个数就是改前的实测值**
// （报告里那两列读数：改前 4.796875 / 15.1875 / 25.59375，级差 10.390625 / 10.40625，即 10.4px）。
// 「缩进行仍然缩进」断的是「**相对上一级**的位移一字不变」，不是「行的绝对左边缘不变」
// （左边缘本来就该跟着整棵树左移到 0 —— 那是这次要的效果）。
const INDENT_STEP_PX = 10.4;
// 容差 = 一个 LayoutUnit（1/64px）：几何按 1/64px 布局，10.4px 落不到格点上（实测两种取整 10.390625 /
// 10.40625），所以级差本身会在这两个值之间跳。这个容差只吃取整噪声，吃不掉任何一次真的缩进改动
// （改一级就是 10.4px，比容差大三个数量级）。
const INDENT_TOLERANCE_PX = 1 / 64;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// ── 断言簿（一次把所有红条目列全，最后统一判；臂模式下反过来断言「该红的红了」）───────────────────
const checks = [];
const record = (id, name, ok, detail) => {
  checks.push({ id, name, ok });
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return ok;
};

// ── 反证臂：在 `web/` 的**临时副本**上改一处 ────────────────────────────────────────────────────
// `expect` = 必须红的 id；`expectGreen` = 必须**仍然绿**的 id（否则证明不了「只打那一侧」）。
const ARM_MUTANTS = {
  gap: {
    what: '把**真实现副本**里 `#tree` 的左内边距加回 `.3rem`（＝那条空隙回来了）',
    file: 'index.html',
    from: 'padding: .2rem .3rem .2rem 0;',
    to: 'padding: .2rem .3rem .2rem .3rem;',
    expect: ['rail', 'flush'],
    expectGreen: ['indent', 'slot', 'content', 'rowbox', 'errors'],
  },
  flatten: {
    what: '把**真实现副本**里 `render.js` 的缩进写死成 `0rem`（＝缩进行也被一起抹平）',
    file: 'render.js',
    from: 'row.style.marginInlineStart = `${Math.min(depth, 6) * .65}rem`;',
    to: "row.style.marginInlineStart = '0rem';",
    expect: ['indent'],
    expectGreen: ['rail', 'flush', 'slot', 'content', 'rowbox', 'errors'],
  },
};

const scratchDirs = [];
const problems = [];
let primaryError = null;
let page = null;

try {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  if (ARM) {
    const arm = ARM_MUTANTS[ARM];
    if (!arm) throw new Error(`看不懂的反证臂：${ARM}（有：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
    print('反证臂', `${ARM} —— ${arm.what}`);
    const scratch = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'sopho-tree-flush-web-'));
    scratchDirs.push(scratch);
    await cp(runWebRoot, scratch, { recursive: true });
    const target = path.join(scratch, arm.file);
    const canonical = await readFile(target, 'utf8');
    const mutated = canonical.replace(arm.from, arm.to);
    if (mutated === canonical) throw new Error(`反证臂 ${ARM} 的改写没命中（真实现的形状变了？）：${arm.what}`);
    await writeFile(target, mutated, 'utf8');
    runWebRoot = scratch;
    print('真实现副本', `${scratch} —— 改的是 ${arm.file}，原件 web/ 一个字节没动（跑完即删）`);
  }

  const productIndex = await readFile(path.join(runWebRoot, 'index.html'), 'utf8');
  const treeRule = /\n\s*#tree \{([^}]*)\}/.exec(productIndex);
  print('真实现里那条声明', treeRule ? `#tree {${treeRule[1].trim()}}` : '（找不到 #tree 规则！）');

  // ── 夹具：活跃树里四条行 —— 顶层 2 条（第 1 条带一个已归档子会话 ⇒ 它那行有折叠键；第 2 条在跑）、
  //    缩进 1 级 1 条、缩进 2 级 1 条（未读）。顶层两条用来验「**每一条**非缩进行都铺满」，不是只验第一条。
  //    另加一条已归档的**顶层**会话 ⇒ 底那条「存档箱」折叠栏也会渲染（它只用来记录、不判死）。──────
  const ids = {
    root: 'a1a1a1a1-1111-4111-8111-111111111111',
    child: 'b2b2b2b2-2222-4222-8222-222222222222',
    grand: 'c3c3c3c3-3333-4333-8333-333333333333',
    sibling: 'd4d4d4d4-4444-4444-8444-444444444444',
    archivedChild: 'e5e5e5e5-5555-4555-8555-555555555555',
    archivedRoot: 'f6f6f6f6-6666-4666-8666-666666666666',
  };
  const quiet = () => ({ notifies: [], waitingFor: [] });
  const sessions = [
    { id: ids.root, name: '顶层会话（这一行有折叠键）', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, modifiedAt: '2026-09-25T10:00:00.000Z', notify: quiet() },
    { id: ids.child, name: '子会话 · 缩进 1 级', status: 'idle', statusLabel: '闲置', archived: false, parentId: ids.root, modifiedAt: '2026-09-25T09:00:00.000Z', notify: quiet() },
    { id: ids.grand, name: '孙会话 · 缩进 2 级', status: 'unread', statusLabel: '未读', unread: true, archived: false, parentId: ids.child, modifiedAt: '2026-09-25T08:00:00.000Z', notify: quiet() },
    { id: ids.sibling, name: '另一条顶层会话（在跑）', status: 'working', statusLabel: '工作中', archived: false, parentId: null, modifiedAt: '2026-09-25T07:30:00.000Z', notify: quiet() },
    // 已归档子会话：**不渲染**，但它让顶层那行长出折叠键（于是折叠列 2rem 那一支也被这一行量到）。
    { id: ids.archivedChild, name: '已归档的子会话', status: 'idle', statusLabel: '闲置', archived: true, parentId: ids.root, modifiedAt: '2026-09-25T06:00:00.000Z', notify: quiet() },
    // 已归档的**顶层**会话：它才是存档箱（底那条折叠栏）里那一条 —— 本门只记录它的位置、不判死（见下）。
    { id: ids.archivedRoot, name: '已归档的顶层会话（存档箱里）', status: 'idle', statusLabel: '闲置', archived: true, parentId: null, modifiedAt: '2026-09-25T05:00:00.000Z', notify: quiet() },
  ];
  // 设置端点走**仓库自己的** store（`server/ui-settings.mjs`）＋ 临时侧车文件，与本门要量的几何无关，
  // 只是不许给真页面喂一个假形状（形状真了，页面上就不会多一条「启动失败」的 notice 干扰读数）。
  const settingsHome = await mkdtemp(path.join(os.tmpdir(), 'sopho-tree-flush-home-'));
  scratchDirs.push(settingsHome);
  const settingsStore = createUiSettingsStore({
    file: path.join(settingsHome, UI_SETTINGS_FILE_NAME),
    writeJson: async (target, value) => {
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
    },
  });

  const routes = async (request, response, url) => {
    const p = url.pathname;
    if (p === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (p === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] }), true;
    if (p === '/api/settings') return sendJson(response, 200, await settingsStore.read()), true;
    if (p === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 1, oldestId: ids.grand, oldestName: '孙会话 · 缩进 2 级' } }), true;
    if (p === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const m = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|annotations))?$/.exec(p);
    if (m) {
      const action = m[2] ?? null;
      if (action === null) { sendJson(response, 200, { name: '顶层会话', cwd: root, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
      if (action === 'messages') { sendJson(response, 200, { sessionId: m[1], messages: [], extras: [], compaction: { atIndex: null }, observability: null }); return true; }
      if (action === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
      if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
      if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
      if (action === 'annotations') { sendJson(response, 200, { exists: true, items: [], total: 0, counts: { open: 0, done: 0 } }); return true; }
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return true;
      }
    }
    return false;
  };

  page = await boot({ webRoot: runWebRoot, width: VIEWPORT.width, height: VIEWPORT.height, routes });
  await page.waitFor(() => page.evaluate(`document.querySelector('style[data-slot-language="v2.2"]') && document.querySelectorAll('[data-active-tree-list="true"] > .tree-session').length === 4`), '会话页没渲染出 4 条会话行');
  await page.frames(2);

  const snapshot = await page.evaluate(`(() => {
    const aside = document.querySelector('aside.tree');
    const asideStyle = getComputedStyle(aside);
    const asideRect = aside.getBoundingClientRect();
    const railContentLeft = asideRect.left + parseFloat(asideStyle.borderLeftWidth) + parseFloat(asideStyle.paddingLeft);
    const tree = document.querySelector('#tree');
    const treeStyle = getComputedStyle(tree);
    const treeRect = tree.getBoundingClientRect();
    const treeContentLeft = treeRect.left + parseFloat(treeStyle.borderLeftWidth) + parseFloat(treeStyle.paddingLeft);
    const list = document.querySelector('[data-active-tree-list="true"]');
    const listStyle = getComputedStyle(list);
    const listRect = list.getBoundingClientRect();
    const listContentLeft = listRect.left + parseFloat(listStyle.borderLeftWidth) + parseFloat(listStyle.paddingLeft);
    const listContentRight = listRect.right - parseFloat(listStyle.borderRightWidth) - parseFloat(listStyle.paddingRight);
    const probe = document.createElement('i');
    document.body.append(probe);
    const palette = ['--slot-idle', '--slot-working', '--slot-unread', '--slot-dark'].map((name) => { probe.style.color = 'var(' + name + ')'; return getComputedStyle(probe).color; });
    probe.remove();
    const rows = [...list.querySelectorAll(':scope > .tree-session')].map((row) => {
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const select = row.querySelector('.tree-select');
      const selectRect = select.getBoundingClientRect();
      return {
        id: row.dataset.sessionId,
        depth: Number(row.dataset.depth),
        hasFold: row.classList.contains('has-fold'),
        left: rect.left, right: rect.right, width: rect.width, height: rect.height,
        slotWidth: parseFloat(style.borderInlineStartWidth),
        slotStyle: style.borderInlineStartStyle,
        slotColor: style.borderInlineStartColor,
        marginInlineStart: parseFloat(style.marginInlineStart),
        paddingInlineStart: parseFloat(style.paddingInlineStart),
        selectOffset: selectRect.left - rect.left,
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      railContentLeft, treeContentLeft,
      treePaddingInlineStart: parseFloat(treeStyle.paddingInlineStart),
      treePaddingInlineEnd: parseFloat(treeStyle.paddingInlineEnd),
      listContentLeft, listContentRight,
      rows, palette,
    };
  })()`);

  const railLeft = snapshot.railContentLeft;
  const byDepth = (depth) => snapshot.rows.filter((row) => row.depth === depth);
  const roots = byDepth(0);
  const gapOf = (row) => Number((row.left - railLeft).toFixed(4));
  const indentOf = (row, parent) => Number((row.left - parent.left).toFixed(4));

  // 原始读数整张表打出来（改前 / 改后各一份，就是交付报告里那两列）。
  print('原始读数', {
    视口: snapshot.viewport,
    左栏内容区左边缘: railLeft,
    '#tree 内容区左边缘': snapshot.treeContentLeft,
    '#tree 左内边距': snapshot.treePaddingInlineStart,
    '#tree 右内边距': snapshot.treePaddingInlineEnd,
    列表内容区: { left: snapshot.listContentLeft, right: snapshot.listContentRight, width: Number((snapshot.listContentRight - snapshot.listContentLeft).toFixed(4)) },
    行: snapshot.rows.map((row) => ({
      id: row.id, depth: row.depth, hasFold: row.hasFold,
      left: row.left, right: row.right, width: row.width, height: row.height,
      空隙: gapOf(row),
      slotWidth: row.slotWidth, slotColor: row.slotColor,
      marginInlineStart: row.marginInlineStart, paddingInlineStart: row.paddingInlineStart,
      contentOffset: row.selectOffset,
    })),
    缩进量: { 'depth1 − depth0': indentOf(byDepth(1)[0], roots[0]), 'depth2 − depth1': indentOf(byDepth(2)[0], byDepth(1)[0]) },
  });

  // ── 截图：整页（1440×900）＋ 左栏放大（×3，缩进行与槽都看得清）──────────────────────────────
  await page.screenshot(path.join(ARTIFACT_DIR, `tree-row-flush-${LABEL}-${VIEWPORT.width}x${VIEWPORT.height}.png`));
  const railRect = await page.evaluate(`(() => { const b = document.querySelector('aside.tree').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const railShot = await page.browser.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, railRect.x), y: Math.max(0, railRect.y), width: railRect.width, height: railRect.height, scale: 3 } });
  await writeFile(path.join(ARTIFACT_DIR, `tree-row-flush-${LABEL}-indent-zoom.png`), Buffer.from(railShot.data, 'base64'));
  print('截图', {
    整页: path.join(ARTIFACT_DIR, `tree-row-flush-${LABEL}-${VIEWPORT.width}x${VIEWPORT.height}.png`),
    左栏放大: path.join(ARTIFACT_DIR, `tree-row-flush-${LABEL}-indent-zoom.png`),
  });

  // ── 只记录、不判死：**存档箱**（底那条折叠栏，展开后）里的会话行。────────────────────────
  // 这次**没动它**：`.attic-list` 自带 `padding: .15rem` + `border: 1px`，所以那些行离左栏内容区
  // 左边缘还差 1px + 2.4px = 3.4px（改动前是 8.2px —— 还要再加上 `#tree` 原来那条 4.8px 左内边距）。
  // 业主说的是上面那棵**活跃树**；存档箱是另一种容器（有边框的小盒子），要不要也贴到最左得先问业主，
  // 所以这里**不写成断言**（不许把没拍板的东西钉成「正确值」）。
  await page.evaluate(`(() => { const toggle = document.querySelector('[data-attic-toggle="true"]'); if (toggle) toggle.click(); return true; })()`);
  await page.frames(2);
  const atticRows = await page.evaluate(`(() => {
    const aside = document.querySelector('aside.tree');
    const asideStyle = getComputedStyle(aside);
    const railLeft = aside.getBoundingClientRect().left + parseFloat(asideStyle.borderLeftWidth) + parseFloat(asideStyle.paddingLeft);
    return [...document.querySelectorAll('[data-attic-list="true"] > .tree-session')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.sessionId, left: rect.left, 空隙: Number((rect.left - railLeft).toFixed(4)) };
    });
  })()`);
  print('存档箱展开后的行（只记录，不当断言）', { rows: atticRows, 容器: '.attic-list { padding: .15rem; border: 1px solid var(--line) }' });

  if (MEASURE) {
    print('（--measure：只量不判死 —— 六条断言没跑）', '读数与截图见上');
  } else {
    // ① `#tree` 的左内边距为 0，且它的内容区左边缘 == 左栏内容区左边缘（**零容差**）
    record('rail', '`#tree` 左内边距为 0 且内容区左边缘 == 左栏内容区左边缘',
      snapshot.treePaddingInlineStart === 0 && snapshot.treeContentLeft === railLeft,
      `#tree padding-inline-start=${snapshot.treePaddingInlineStart}，内容区左边缘=${snapshot.treeContentLeft}，左栏内容区左边缘=${railLeft}`);

    // ② 非缩进行铺满一行：每一条 depth=0 行的左边缘 == 左栏内容区左边缘（**零容差**）
    const flushOk = roots.length >= 2 && roots.every((row) => row.left === railLeft);
    record('flush', `非缩进会话行（${roots.length} 条）左边缘 == 左栏内容区左边缘（零容差）`, flushOk,
      roots.map((row) => `${row.id} 空隙 ${gapOf(row)}px`).join('｜') + `（左栏内容区左边缘 ${railLeft}）`);

    // ③ 缩进行仍然缩进：相对上一级的位移 == 改前实测值（不许变）
    const indent1 = indentOf(byDepth(1)[0], roots[0]);
    const indent2 = indentOf(byDepth(2)[0], byDepth(1)[0]);
    const indentOk = Math.abs(indent1 - INDENT_STEP_PX) <= INDENT_TOLERANCE_PX && Math.abs(indent2 - INDENT_STEP_PX) <= INDENT_TOLERANCE_PX;
    record('indent', `缩进行仍然缩进：每一级的位移 == 改前实测值 ${INDENT_STEP_PX}px（容差 ${INDENT_TOLERANCE_PX}px）`, indentOk,
      `depth1 − depth0 = ${indent1}px；depth2 − depth1 = ${indent2}px（容差只吃 1/64px 的取整噪声；改前 / 改后的级差读数见交付报告）`);

    // ④ 最左那 3px 状态槽仍然贴在**本行**的最左，且色只取自 `--slot-*`
    const slotOk = snapshot.rows.every((row) => row.slotWidth === 3 && row.slotStyle === 'solid' && snapshot.palette.includes(row.slotColor))
      && new Set(snapshot.rows.map((row) => row.slotColor)).size === 3;
    record('slot', '每行的 3px 状态槽仍在（宽 3px、solid、色属 `--slot-*`；三条不同状态三种色）', slotOk,
      snapshot.rows.map((row) => `${row.id} ${row.slotWidth}px/${row.slotStyle}/${row.slotColor}`).join('｜'));

    // ⑤ 槽在最左：行的内容起点 = 行左边缘 + 3px（有折叠键的行再加 2rem 的折叠列）
    const contentOk = snapshot.rows.every((row) => Math.abs(row.selectOffset - (3 + (row.hasFold ? 32 : 0))) <= INDENT_TOLERANCE_PX);
    record('content', '行的内容起点 = 行左边缘 + 3px（有折叠键的行 + 2rem 折叠列）——槽的左边没有别的空隙', contentOk,
      snapshot.rows.map((row) => `${row.id} 起点偏移 ${row.selectOffset}px（折叠键 ${row.hasFold}）`).join('｜'));

    // ⑥ 行仍然铺满它容器的**内容宽**（右边缘一律与列表内容区右边缘对齐 —— 右内边距保留不动）、
    //    高仍是 26px —— 不许拿「把行缩窄 / 挪出去」冒充「去掉空隙」（缩进行窄掉的是它自己 margin 那一截）。
    const listWidth = snapshot.listContentRight - snapshot.listContentLeft;
    const rowboxOk = snapshot.rows.every((row) => Math.abs(row.right - snapshot.listContentRight) <= INDENT_TOLERANCE_PX && row.height === 26)
      && roots.every((row) => row.left === snapshot.listContentLeft);
    record('rowbox', `行的右边缘仍与列表内容区右边缘对齐（右内边距保留）且行高 26px`, rowboxOk,
      snapshot.rows.map((row) => `${row.id} 右 ${row.right}/高 ${row.height}`).join('｜') + `（列表内容区 ${snapshot.listContentLeft}…${snapshot.listContentRight}，宽 ${Number(listWidth.toFixed(4))}）`);

    // ⑦ 真页面不许有控制台异常（夹具 / 断言自己坏的信号，不许被当成产品的问题混过去）
    record('errors', '真页面 0 条控制台异常', page.pageProblems.length === 0,
      page.pageProblems.length ? JSON.stringify(page.pageProblems) : '0 条');
  }

  if (ARM) {
    const arm = ARM_MUTANTS[ARM];
    for (const id of arm.expect) {
      const check = checks.find((item) => item.id === id);
      assert.ok(check, `反证臂 ${ARM}：断言 ${id} 没跑到（判据自己坏了）`);
      assert.equal(check.ok, false, `反证臂 ${ARM}：${id} 本该红却是绿的 —— 这条臂没有牙（${check.name}）`);
    }
    for (const id of arm.expectGreen) {
      const check = checks.find((item) => item.id === id);
      assert.ok(check, `反证臂 ${ARM}：断言 ${id} 没跑到（判据自己坏了）`);
      assert.equal(check.ok, true, `反证臂 ${ARM}：${id} 本该仍然绿却红了 —— 这条臂打到了无辜的那一侧（${check.name}）`);
    }
  }
} catch (error) {
  primaryError = error;
} finally {
  if (page) await page.close(primaryError ? [String(primaryError.message ?? primaryError)] : problems);
  for (const directory of scratchDirs) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

if (primaryError) {
  process.stdout.write(`\nFAIL: ${primaryError.message}\n`);
  process.exitCode = 1;
} else if (MEASURE) {
  print('RESULT', `--measure（只量不判死）：读数与截图见上，退出码 0`);
} else if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  print('RESULT', `反证臂 ${ARM} 有效：预期红的都红了（${arm.expect.join('、')}），该绿的仍绿（${arm.expectGreen.join('、')}）`);
  if (problems.length) { print('sandbox 收尾记账（次要）', problems.join(' / ')); process.exitCode = 1; }
} else {
  const red = checks.filter((check) => !check.ok);
  print('RESULT', red.length
    ? `tree-row-flush RED —— ${checks.length} 条断言里 ${red.length} 条红：${red.map((check) => `${check.id}(${check.name})`).join('；')}`
    : `tree-row-flush PASS —— ${checks.length} 条断言全绿（真 Chromium，${VIEWPORT.width}×${VIEWPORT.height}）`);
  if (problems.length) print('sandbox 收尾记账（次要）', problems.join(' / '));
  if (red.length || problems.length) process.exitCode = 1;
}
