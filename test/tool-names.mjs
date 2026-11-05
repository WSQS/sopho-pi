#!/usr/bin/env node
// 门：工具名 —— 业主文档 `docs/human/v2.2-lessons.md`（**整份**，不只某一节）里**以工具名写下来的**
// 每个名字，都必须在**插件注册表**里真的存在；并且两次改名后，旧名不许再当工具名。
//
// 出处：业主 2026-09-26 把 §Agent 工具 的清单改成**工具名**写法（提交 `028edf1`），要求实现里也这么叫
// （「是要改实现当中的名字，并且这样命名可以方便分组」）；同一天又在 §问题看板 把三个问题类工具定名成
// `question_ask` / `question_list` / `question_close`（提交 `2e0689b`）。那份**人类文档只读、AI 禁改**；本门**只读**它。
//
// ⚠️ **只看文档列出来的**名字：它没列的工具**不要求存在**；反过来，`question_ask` 这种「文档已定名、实现还没改名」
// 的分歧 ⇒ 门**必须红**并点名 —— 那正是本门要抓的东西，不是噪声。**整份文档**都解析（§Agent 工具 / §问题看板
// 两节都列了工具名；只解析 §Agent 工具 那一节 ⇒ 漏掉后来加的 §问题看板 三个名字、EXIT=0 假绿 ⇒ 本门修的就是这个洞）。
//
// 四条互相独立的事实 + 一条兜底扫描：
//   ① 插件源码 `pi-extensions/assistant/index.ts` 里逐条的 `pi.registerTool({ name: "…" })`（**双引号**）；
//   ② `test/debug-tools.mjs` 的 `EXPECTED_TOOLS`（登记处：新加/漏登记一个工具就与 ① 不等）；
//   ③ `server/base-logic.mjs` 的 `TOOL_GROUP_TABLE` 里 `source:'declared'` 各组的成员名（分组声明表）；
//   ④ 业主文档里声明的**分组名** ⊆ `TOOL_GROUP_TABLE` 的组名（见下「同族判据」）；
//   ⑤ 兜底扫描（见 `SCAN` 一节）：在**在册文件**里找「把旧名当工具名写下来」的形状。
// ①②③ 必须**三方相等**，且都不含这七个旧名 `send` / `push` / `archive_session` / `set_title`
// / `ask_user` / `list_questions` / `close_question`（业主两次改名都没选「保留旧名」那条 ⇒ 旧名一律不再注册，也不留别名）。
//
// ⚠️ 为什么不拿「全仓 grep 这七个词」当判据：`send` / `push` 是极常见的英文与 JS 词 ——
// `POST /sessions/{id}/send` 那条**路由名**（改名只改工具名，路由不动）、网页按钮 `id="send"`、
// 数组的 `.push()`、`git push`、委派消息的 `kind:"push"`、CDP 的 `send()` ……都会误报。所以兜底扫描
// **只匹配两种「名字被当工具名写下来」的形状**：`name: "<旧名>"` 与 `tools: […… "<旧名>" ……]`。
// 这四种噪声（路由 / DOM id / 数组方法 / git）**天然不匹配**这两个形状。
//
// ── 业主文档怎么解析（整份，可审计）──────────────────────────────────────────────
// 判据**只有一条**：某一行是 bullet（`- xxx…`），它的**首个 token 是 ASCII `snake_case`**（`^[A-Za-z][A-Za-z0-9_]*$`），
// **且**该行在这个 token 后面紧跟着 `:` 或 `：`。这就是「声明一个工具名」的形状（`- question_ask: …`）。
// ⇒ 正文里的非工具 snake_case 词**天然排除**：中文正文里的 `ask_user`（在句子中间、不在 bullet 首个 token 上、
//    后面也不跟冒号）不匹配；`- 实例情况：…` 这种首个 token 是中文的 bullet 也不匹配。
// 万一文档里出现「形状一样但不是工具名」的 bullet ⇒ 必须写进 `OWNER_DOC_NON_TOOL_BULLETS` 白名单
// （键＝名字，值＝**为什么它不是工具名**）；不写 ⇒ 门红着点名它 —— 不许静默放过。
// 解析结果逐条打印（`ownerDocListed` / `ownerDocParse`），可人工核对。
//
// ── 同族判据：业主文档里**声明的分组名** ⊆ `TOOL_GROUP_TABLE` 的组名（2026-09-26 业主首次给分组定名）──
// 业主在 §调试工具 §agent工具明细 写下「可以确认的分组：」（提交 `eff06f9`），**这是第一次给分组定名**：
// `内置工具组` / `树形会话组` / `提问组`。⇒ 判据与工具名那条同族：**只查它声明的、不要求完整**
// （它只确认了三组；其余四组的名字是仓库自拟、业主尚未确认 ⇒ 本门不碰）。
// 解析口径**只认那个声明块**（锚点行 `可以确认的分组：` 之后的连续 bullet，遇第一条非空且非 bullet 的行就结束）——
// 整份中文文档里 bullet 到处都有，分组名又没有天然分隔符，所以判据是**位置**而不是形状。
// 块里形状一样但不是分组名的 bullet ⇒ 必须写进 `OWNER_DOC_NON_GROUP_BULLETS`（键＝文本，值＝**为什么它不是分组名**）；
// 不写 ⇒ 门红着点名它 —— 不许静默放过。解析结果逐条打印（`ownerDocGroups` / `ownerDocGroupsParse`），可人工核对。
//
// 反证臂：
//   · `npm run test:toolnames:reverse-rename`（把**注册表副本**里一个名字改掉 ⇒ 必红）；
//   · `npm run test:toolnames:reverse-owner-doc`（往**文档副本**里塞一条「列了、但没实现」的工具名 ⇒ 必红）；
//   · `npm run test:toolnames:reverse-group-rename`（把**分组声明表副本**里业主定名的一组改掉 ⇒ 必红）；
//   · `npm run test:toolnames:reverse-oldname`（把注册名改回已退休的 `spawn` ⇒ 「旧名不许再当工具名」必红）。
// 用法：`node test/tool-names.mjs [--reverse-arm=rename-registry|owner-doc-name|group-rename|old-name-spawn]`。
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runGateOnMutatedCopy } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
// 反证臂用它指向「改过一处的副本」；正常跑就是真树。
const ROOT = path.resolve(process.env.SOPHO_TOOLNAMES_GATE_ROOT || REPO_ROOT);
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_NAMES = new Set(['rename-registry', 'owner-doc-name', 'group-rename', 'old-name-spawn', 'old-name-page-read']);

const PLUGIN_SOURCE = path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts');
const GROUP_TABLE_SOURCE = path.join(ROOT, 'server', 'base-logic.mjs');
const EXPECTED_SOURCE = path.join(ROOT, 'test', 'debug-tools.mjs');
const HUMAN_DOC = path.join(ROOT, 'docs', 'human', 'v2.2-lessons.md');

// 旧工具名（不许再出现在「工具名」的位置上）：
//   · 两次改名（会话类 4 个 + 问题类 3 个）；
//   · 2026-09-26 业主把 `spawn` 并入 `session_new`（只留一个建会话工具）、并砍掉 `role_start` / `reflect` / `s0b_plugin_probe`
//     ⇒ 这四个名字也不许再当工具名。注意：`spawn` 作为**路由**名（`POST /sessions/{id}/spawn`）与
//     `node:child_process` 的 `spawn` 当然还在 —— 兜底扫描只匹配「名字被当工具名写下来」的两种形状
//     （`name: "…"` 与 `tools: [ … ]`），那两种噪声天然不匹配（见文件头）。
const OLD_TOOL_NAMES = ['send', 'push', 'archive_session', 'set_title', 'ask_user', 'list_questions', 'close_question', 'spawn', 'role_start', 'reflect', 's0b_plugin_probe', 'epub_outline', 'epub_search', 'page_ask', 'page_note', 'page_progress', 'page_read', 'page_source'];

// 业主文档里「形状像工具名、但不是工具名」的 bullet 白名单：`Map<名字, 为什么它不是工具名>`。
// ⚠️ 现在**是空的** —— 整份 `docs/human/v2.2-lessons.md` 里符合「bullet 首个 token 是 ASCII snake_case
// ＋ 该行带冒号」这一形状的，恰好只有那 9 个工具名。空 ≠ 不用管：真出现同类 bullet 时，
// 把它连同**一句理由**写进来；不写 ⇒ 门红着点名它（宁可要人确认一次，也不许静默放过一个名字）。
const OWNER_DOC_NON_TOOL_BULLETS = new Map([]);

// 业主文档里**声明分组名的那个块**：锚点行 `可以确认的分组：` 之后的连续 bullet 才是分组名（口径见文件头）。
// 块里形状一样但不是分组名的 bullet 白名单：`Map<文本, 为什么它不是分组名>`（当前为空；不写就红）。
const GROUP_DECL_ANCHOR = /^\s*可以确认的分组\s*[:：]\s*$/;
const OWNER_DOC_NON_GROUP_BULLETS = new Map([]);

// 兜底扫描：要扫整棵树，但要跳过自己建的沙箱与依赖目录。
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.sopho-wt']);
const SKIP_DIR_PREFIX = '.sopho-';
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.bin', '.map']);
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

/** ① 插件源码里的注册点：`pi.registerTool({ name: "…" })`。每一条都必须被解析到（漏一条就是扫描器瞎了）。 */
async function registeredToolNamesInSource() {
  const source = await readFile(PLUGIN_SOURCE, 'utf8');
  const pattern = /pi\.registerTool\(\{\s*\n?\s*name:\s*"([^"]+)"/g;
  const names = [];
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  const occurrences = (source.match(/pi\.registerTool\(/g) ?? []).length;
  assert.equal(occurrences, names.length, `every pi.registerTool({ name: "…" }) occurrence must be parsed by this gate; parsed=${JSON.stringify(names.slice().sort())}`);
  return names;
}

/** ② 登记处：`test/debug-tools.mjs` 的 `EXPECTED_TOOLS`。 */
async function expectedToolsInSource() {
  const source = await readFile(EXPECTED_SOURCE, 'utf8');
  const body = /const EXPECTED_TOOLS = \[([\s\S]*?)\];/.exec(source);
  if (!body) throw new Error('cannot find EXPECTED_TOOLS in test/debug-tools.mjs (seam changed?)');
  const names = [];
  const pattern = /'([^']+)'/g;
  let match;
  while ((match = pattern.exec(body[1])) !== null) names.push(match[1]);
  if (names.length === 0) throw new Error('EXPECTED_TOOLS parsed as empty (seam changed?)');
  return names;
}

/** ③ 分组声明表：`server/base-logic.mjs` 里 `source: 'declared'` 各组的成员名。 */
async function declaredGroupToolsInSource() {
  const source = await readFile(GROUP_TABLE_SOURCE, 'utf8');
  const table = /const TOOL_GROUP_TABLE = \[([\s\S]*?)\n  \];/.exec(source);
  if (!table) throw new Error('cannot find TOOL_GROUP_TABLE in server/base-logic.mjs (seam changed?)');
  const names = [];
  const linePattern = /\{[^}]*source:\s*'declared'[^}]*tools:\s*\[([^\]]*)\][^}]*\}/g;
  let match;
  while ((match = linePattern.exec(table[1])) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '');
      if (name) names.push(name);
    }
  }
  if (names.length === 0) throw new Error('TOOL_GROUP_TABLE declared tools parsed as empty (seam changed?)');
  return names;
}

/** ③b 分组声明表里的**组名**：`server/base-logic.mjs` 的 `TOOL_GROUP_TABLE`。 */
async function declaredGroupNamesInSource() {
  const source = await readFile(GROUP_TABLE_SOURCE, 'utf8');
  const table = /const TOOL_GROUP_TABLE = \[([\s\S]*?)\n  \];/.exec(source);
  if (!table) throw new Error('cannot find TOOL_GROUP_TABLE in server/base-logic.mjs (seam changed?)');
  const names = [];
  const pattern = /\{\s*name:\s*'([^']*)'/g;
  let match;
  while ((match = pattern.exec(table[1])) !== null) names.push(match[1]);
  const entries = (table[1].match(/\{\s*name:\s*'/g) ?? []).length;
  assert.equal(entries, names.length, `every TOOL_GROUP_TABLE entry must carry a parseable name; parsed=${JSON.stringify(names)}`);
  if (names.length === 0) throw new Error('TOOL_GROUP_TABLE group names parsed as empty (seam changed?)');
  return names;
}

/** ④ 业主文档里**以工具名写下来的**名字 —— 解析**整份文档**（不只 §Agent 工具），口径见文件头。 */
async function toolsListedInOwnerDoc() {
  const source = await readFile(HUMAN_DOC, 'utf8');
  const lines = source.split(/\r?\n/);
  const listed = [];      // 判定为「工具名声明」
  const whitelisted = []; // 命中形状但属于显式白名单（当前为空；打印出来以备审计）
  const bullets = [];     // 所有命中形状的 bullet（含白名单的），供可审计打印
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*-\s+([A-Za-z][A-Za-z0-9_]*)\s*[:：]/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    bullets.push({ name, line: index + 1 });
    if (OWNER_DOC_NON_TOOL_BULLETS.has(name)) { whitelisted.push(name); continue; }
    listed.push(name);
  }
  if (listed.length === 0) throw new Error('docs/human/v2.2-lessons.md declares no tool names (shape changed? the gate must not pass on an empty list)');
  return { listed, whitelisted, bullets, lines: lines.length };
}

/** ⑤ 业主文档里**声明的分组名** —— 只解析 `可以确认的分组：` 引导的那个 bullet 块（口径见文件头）。 */
async function groupsListedInOwnerDoc() {
  const source = await readFile(HUMAN_DOC, 'utf8');
  const lines = source.split(/\r?\n/);
  let anchorLine = null;
  const bullets = [];      // 块里所有 bullet（含白名单的），供可审计打印
  const listed = [];       // 判定为「分组名声明」
  const whitelisted = [];  // 命中形状但属于显式白名单（当前为空；打印出来以备审计）
  for (let index = 0; index < lines.length; index += 1) {
    if (anchorLine === null) {
      if (GROUP_DECL_ANCHOR.test(lines[index])) anchorLine = index + 1;
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/.exec(lines[index]);
    if (bullet) {
      const text = bullet[1];
      bullets.push({ text, line: index + 1 });
      if (OWNER_DOC_NON_GROUP_BULLETS.has(text)) whitelisted.push(text);
      else listed.push(text);
      continue;
    }
    if (lines[index].trim() === '') continue; // 块内/块后的空行不算结束
    break; // 遇到正文 ⇒ 声明块结束
  }
  if (anchorLine === null) throw new Error('docs/human/v2.2-lessons.md has no "可以确认的分组：" anchor (shape changed? the gate must not pass silently)');
  if (listed.length === 0) throw new Error('docs/human/v2.2-lessons.md declares no group names under "可以确认的分组：" (shape changed? the gate must not pass on an empty list)');
  return { anchorLine, bullets, listed, whitelisted, lines: lines.length };
}

/** 兜底扫描用：把 `tools: [ … ]` 的每个成员名解析出来（引号/空白都容错）。 */
function groupMembersOf(content) {
  const members = [];
  const pattern = /tools\s*:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '');
      if (name) members.push(name);
    }
  }
  return members;
}

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // 不跟符号链接（worktree 的 node_modules 是链接）
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(SKIP_DIR_PREFIX)) continue;
      await walk(full, out);
    } else if (entry.isFile()) {
      if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  }
}

/** ④ 兜底扫描：整棵树里「把旧名当工具名写下来」的形状（口径见文件头）。 */
async function scanOldToolNames() {
  const files = [];
  await walk(ROOT, files);
  const hits = [];
  const skippedLarge = [];
  const declPattern = new RegExp(`\\bname\\s*:\\s*['"](${OLD_TOOL_NAMES.join('|')})['"]`);
  for (const file of files) {
    let content;
    try {
      const raw = await readFile(file);
      if (raw.byteLength > MAX_SCAN_BYTES) { skippedLarge.push(path.relative(ROOT, file)); continue; }
      content = raw.toString('utf8');
    } catch {
      continue; // 读不了的文件不静默当成「干净」——记进 unreadable
      hits.push({ file: path.relative(ROOT, file), reason: 'unreadable' });
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const decl = declPattern.exec(lines[index]);
      if (decl) hits.push({ file: path.relative(ROOT, file), line: index + 1, reason: `name: "${decl[1]}"`, text: lines[index].trim() });
    }
    const members = groupMembersOf(content);
    for (const name of members) {
      if (OLD_TOOL_NAMES.includes(name)) hits.push({ file: path.relative(ROOT, file), reason: `tools: [ … "${name}" … ]` });
    }
  }
  return { filesScanned: files.length, skippedLarge, hits };
}

async function runGate() {
  const registered = (await registeredToolNamesInSource()).slice().sort();
  const expected = (await expectedToolsInSource()).slice().sort();
  const declared = (await declaredGroupToolsInSource()).slice().sort();
  const declaredGroups = await declaredGroupNamesInSource();
  const ownerDoc = await toolsListedInOwnerDoc();
  const ownerListed = ownerDoc.listed.slice().sort();
  const ownerGroups = await groupsListedInOwnerDoc();
  const ownerGroupListed = ownerGroups.listed.slice().sort();
  const scan = await scanOldToolNames();

  const problems = [];
  const uniq = (list) => [...new Set(list)].sort();
  const setsEqual = (a, b) => JSON.stringify(uniq(a)) === JSON.stringify(uniq(b));

  // ① 三方相等：注册表 == 登记处 == 分组声明表。
  if (!setsEqual(registered, expected)) {
    problems.push(`registry names != EXPECTED_TOOLS (test/debug-tools.mjs); onlyInRegistry=${JSON.stringify(uniq(registered).filter((n) => !expected.includes(n)))} onlyInExpected=${JSON.stringify(uniq(expected).filter((n) => !registered.includes(n)))}`);
  }
  if (!setsEqual(registered, declared)) {
    problems.push(`registry names != declared group table (server/base-logic.mjs TOOL_GROUP_TABLE); onlyInRegistry=${JSON.stringify(uniq(registered).filter((n) => !declared.includes(n)))} onlyInTable=${JSON.stringify(uniq(declared).filter((n) => !registered.includes(n)))}`);
  }
  // ② 业主文档里以工具名写下来的名字 ⊆ 注册表。
  const missingFromRegistry = ownerListed.filter((name) => !registered.includes(name));
  if (missingFromRegistry.length > 0) {
    problems.push(`owner doc (docs/human/v2.2-lessons.md) lists tools missing from the registry: ${JSON.stringify(missingFromRegistry)}; if they are real work items, rename the registry; if they are not tool names, add them to OWNER_DOC_NON_TOOL_BULLETS with a reason`);
  }
  // ③ 旧名不许再当工具名（注册表 / 登记处 / 声明表三面）。
  for (const [label, list] of [['registry', registered], ['EXPECTED_TOOLS', expected], ['group table', declared]]) {
    const oldPresent = uniq(list).filter((name) => OLD_TOOL_NAMES.includes(name));
    if (oldPresent.length > 0) problems.push(`${label} still carries old tool name(s): ${JSON.stringify(oldPresent)} (the rename left no alias)`);
  }
  // ④ 业主文档里声明的分组名 ⊆ 分组声明表的组名（只查它声明的、不要求完整）。
  const missingGroups = ownerGroupListed.filter((name) => !declaredGroups.includes(name));
  if (missingGroups.length > 0) {
    problems.push(`owner doc (docs/human/v2.2-lessons.md) declares groups missing from TOOL_GROUP_TABLE (server/base-logic.mjs): ${JSON.stringify(missingGroups)}; the owner named these groups, so the table must use the owner's words; if a bullet in that block is not a group name, add it to OWNER_DOC_NON_GROUP_BULLETS with a reason; declared group names = ${JSON.stringify(declaredGroups)}`);
  }
  // ⑤ 兜底扫描。
  if (scan.hits.length > 0) {
    problems.push(`old tool name(s) still written as a tool name in ${scan.hits.length} place(s): ${JSON.stringify(scan.hits.slice(0, 12))}`);
  }

  print('ownerDocListed', ownerListed);
  print('ownerDocParse', { file: 'docs/human/v2.2-lessons.md', scope: 'whole file', rule: 'bullet first token is ASCII snake_case AND the same line carries ":"', lines: ownerDoc.lines, bulletShaped: ownerDoc.bullets, whitelisted: ownerDoc.whitelisted, listed: ownerListed });
  print('ownerDocGroups', ownerGroupListed);
  print('ownerDocGroupsParse', { file: 'docs/human/v2.2-lessons.md', scope: 'the bullet block under the "可以确认的分组：" anchor', anchorLine: ownerGroups.anchorLine, rule: 'anchor line 可以确认的分组： then consecutive "- …" bullets until the first non-blank non-bullet line', lines: ownerGroups.lines, bulletShaped: ownerGroups.bullets, whitelisted: ownerGroups.whitelisted, listed: ownerGroupListed });
  print('declaredGroupNames', declaredGroups);
  print('registered', registered);
  print('groupAndExpectedCounts', { registered: registered.length, expected: expected.length, declared: declared.length, ownerDocListed: ownerListed.length });
  print('scan', { filesScanned: scan.filesScanned, skippedLarge: scan.skippedLarge.length, hits: scan.hits.length });
  if (scan.skippedLarge.length > 0) print('scanSkippedLarge', scan.skippedLarge);

  if (problems.length > 0) {
    for (const problem of problems) process.stdout.write(`RED: ${problem}\n`);
    print('RESULT', `tool-names gate RED (${problems.length} problem(s)) — ${problems[0]}`);
    return 1;
  }
  print('RESULT', 'tool-names gate PASS (owner doc tools ⊆ registry; owner doc declared groups ⊆ group table; registry == EXPECTED_TOOLS == declared group table; no old tool names anywhere in the repo)');
  return 0;
}

async function runReverseArm(name) {
  const mutants = {
    'rename-registry': {
      what: '把插件注册表里的一个名字改掉（`name: "session_send"` → `name: "session_send_renamed"`）⇒ 注册表不再等于登记处、也不再覆盖业主文档列出的名字',
      file: 'pi-extensions/assistant/index.ts',
      from: '\t\tname: "session_send",',
      to: '\t\tname: "session_send_renamed",',
      expect: 'registry names != EXPECTED_TOOLS',
    },
    'group-rename': {
      what: '把**分组声明表**里业主已定名的一组改掉（`内置工具组` → `内置工具组（改了名）`）⇒「业主文档声明的分组名必须在 TOOL_GROUP_TABLE 里存在」那条必红（这正是 2026-09-26 业主给分组定名后要补的那条判据）',
      file: 'server/base-logic.mjs',
      from: "{ name: '内置工具组', source: 'builtin-table',",
      to: "{ name: '内置工具组（改了名）', source: 'builtin-table',",
      expect: 'declares groups missing from TOOL_GROUP_TABLE',
    },
    'owner-doc-name': {
      what: '往**业主文档副本**里塞一条「列了、但注册表里没有」的工具名（`- question_snooze: …`）⇒「文档以工具名写下来的名字 ⊆ 注册表」那条必红（这正是本门 2026-09-26 要补的那个洞：文档列了名字而实现没有 ⇒ 必红）',
      file: 'docs/human/v2.2-lessons.md',
      from: '- question_close: 关闭问题\n',
      to: '- question_close: 关闭问题\n- question_snooze: 假的、没实现的工具名\n',
      expect: 'lists tools missing from the registry',
    },
    'old-name-spawn': {
      what: '把注册名改回已经退休的那个建会话旧名（从 `session_new` 改回 `spawn` 这个已退休工具名）⇒「旧名不许再当工具名」那条必红（业主 2026-09-26 把 spawn 并入 session_new）',
      file: 'pi-extensions/assistant/index.ts',
      from: '\t\tname: "session_new",',
      to: `\t\tname: "${OLD_TOOL_NAMES.find((name) => name === 'spawn')}",`,
      expect: 'still carries old tool name',
    },
    'old-name-page-read': {
      what: '把已退休的阅读页工具名（`page_read`）重新写成注册行的形状（在**不是注册表**的 `server/base-logic.mjs` 里注入一行 `name: "…"` 形状的注释）⇒ 只可能由兜底扫描（⑤）抓到 ⇒「旧名不许再当工具名」的整棵树扫描必红（业主 2026-09-26 把阅读页整条功能退休）',
      file: 'server/base-logic.mjs',
      from: "    { name: '设备（远端）', source: 'declared', tools: ['device_list', 'device_probe', 'device_run'] },",
      to: `    // name: "${OLD_TOOL_NAMES.find((name) => name === 'page_read')}"\n    { name: '设备（远端）', source: 'declared', tools: ['device_list', 'device_probe', 'device_run'] },`,
      expect: 'old tool name(s) still written as a tool name',
    },
  };
  const arm = mutants[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${Object.keys(mutants).join(' / ')}）`);
  process.stdout.write(`反证臂 ${name}：${arm.what}\n`);
  const result = await runGateOnMutatedCopy({
    root: REPO_ROOT,
    tag: 'toolnamesarm',
    dirs: ['pi-extensions', 'server', 'test', 'docs'],
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    envKey: 'SOPHO_TOOLNAMES_GATE_ROOT',
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.file);
      const text = await readFile(file, 'utf8');
      if (!text.includes(arm.from)) {
        throw new Error(`反证臂 ${name} 的改写**没命中**（接缝形状变了？）：${arm.file}\n  要找：${JSON.stringify(arm.from)}`);
      }
      await writeFile(file, text.replace(arm.from, arm.to), 'utf8');
    },
  });
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine });
  if (result.problems.length > 0) process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
  if (result.problems.length > 0) return 1;
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine}\n`);
  return 0;
}

if (ARM) {
  if (!ARM_NAMES.has(ARM)) throw new Error(`不认识的反证臂：${ARM}（可选：${[...ARM_NAMES].join(' / ')}）`);
  process.exitCode = await runReverseArm(ARM);
} else {
  process.exitCode = await runGate();
}
