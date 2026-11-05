import { renderMarkdownMarked } from './markdown.mjs';
import { exactBase64Bytes, imageHeaderFacts } from './image-size.mjs';
// 插件那条**缺省 bash 超时**安全网的**数值**（生成物；唯一真源是插件源码，见文件头）。
// ⚠️ 这里**不写死那个秒数** —— 写了就是第二份真理，插件一改前端就撒谎（`npm run test:pluginvalues` 会红）。
import { BASH_DEFAULT_TIMEOUT_S, BASH_TIMEOUT_ENV, BASH_TIMEOUT_OFF_VALUES } from './generated/plugin-values.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
}

function appendText(document, parent, className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

// 正式消息的 markdown 渲染：**借 pi vendored 的 marked + highlight.js**（配置在 web/markdown.mjs，
// 逐条照抄 pi 的 tokenizer 关闭 + scheme 白名单）。流式那条纯文本 + `appendData` 的路径不经过这里。
// marked 不可用时（静态资源缺失 / 非浏览器环境）安全退化成纯文本 —— 这条路绝不在没有消毒配置时写 innerHTML。
export function renderMarkdown(document, text) {
  const rendered = renderMarkdownMarked(document, text);
  if (rendered) return rendered;
  const root = document.createElement('div');
  root.className = 'markdown markdown-plain';
  root.textContent = String(text ?? '');
  return root;
}

function argSummary(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.command === 'string') return args.command.split('\n')[0].slice(0, 240);
  const value = args.path ?? args.filePath ?? args.file ?? args.pattern ?? args.query ?? args.id;
  if (typeof value === 'string') return value;
  const json = JSON.stringify(args);
  return !json || json === '{}' ? '' : json.slice(0, 240);
}

// 命令的**逐字全文**（业主 2026-09-22：①「bash 工具的命令是不是只有一行？展开时应该显示命令的
// 全部内容」）。先查清调用点：`argSummary()` 全仓只有 `toolCard()` 一个调用点，但它仍是**折叠态**
// 那条路（首行 + 240 字上限）—— 本件**一字不改**它的行为，展开态与「复制」**另开这一条取值路径**：
//   · 不取首行（多行命令逐字全给）；
//   · 不 `slice(0, 240)`（长命令逐字全给）；
//   · 不是 `args.command`（别的工具没有「命令」这回事）就返回 `null`，绝不拿 path/pattern 顶上。
function fullCommandOf(args) {
  if (!args || typeof args !== 'object') return null;
  return typeof args.command === 'string' ? args.command : null;
}

// 工具卡上那句「未指定 timeout ⇒ 本机缺省 N s」—— 把插件里**看不见**的那层安全网摆到明面上。
// 事实与由来：pi 的 bash schema 是 `Timeout in seconds (optional, no default timeout)`（插件改不了），
// 插件在 `pi.on("tool_call")` 里给**没给** timeout 的调用**补**一个缺省；那个值**不落盘** ⇒ 工具卡
// 渲染的会话记录里没有 `timeout` 字段 ⇒ 它今天完全看不见。
// 判据与插件那条 handler **逐字同源**：只有 `bash`、且调用方**没给** `timeout`（`== null`）时才补
//（插件：`if (event.input.timeout != null) return;` —— 给了就一字不动）。
// 值全部来自 `web/generated/plugin-values.js`（`bin/gen-plugin-values.mjs` 从插件源码读出来的），
// 这里一个数都不写死；`SOPHO_BASH_TIMEOUT` 可覆盖、置成那几个值之一可关掉 —— 也一并从生成物读出来。
function bashTimeoutNoteText() {
  return `未指定 timeout ⇒ 本机缺省 ${BASH_DEFAULT_TIMEOUT_S} s（插件安全网；${BASH_TIMEOUT_ENV} 可覆盖，${BASH_TIMEOUT_OFF_VALUES.join('/')} 关掉）`;
}

function bashTimeoutNoteApplies(part) {
  if (part?.name !== 'bash') return false;
  const args = part.args;
  if (!args || typeof args !== 'object') return true; // 没有参数对象 ⇒ 也谈不上「显式给了超时」
  return args.timeout == null;
}

/** 折叠态那行旁边要标的「后面还有多少」：行数 + 字数（码点计数，CJK/emoji 各算 1 个字）。
 *  末尾换行不算多一行 —— 与 bash 自己的「输出行」口径一致（`split('\n')` 的最后一格为空不算）。 */
function commandFacts(command) {
  const draft = command.endsWith('\n') ? command.slice(0, -1) : command;
  return { lines: draft.split('\n').length, chars: [...command].length };
}

/** 「复制」按钮：**逐字原文**（不是首行、不是摘要）。三级降级**共用** `web/copy-text.js`
 *  （① `navigator.clipboard.writeText` → ② `document.execCommand('copy')` → ③ 只读、已全选的手动框
 *  `#copy-panel`）—— 修前这里只有 ①②，两级都失败就剩一句「复制失败」，**没有出路**。
 *  走到 ③ 时**不谎称成功**：按钮上写「请手动复制」（不是「已复制」，也不是「复制失败」—— 出路就在眼前的框里），
 *  并把「走的是哪一级」标在按钮的 `data-copy-path` / `title` ＋ 控制台上（**不在 UI 上吹**）。
 *  ⚠️ 取的就是同一张卡上 `.tool-command` 的 `textContent`（**唯一一份**原文），不在属性里再抄一遍。 */
async function copyVerbatim(button, text) {
  const flash = (label) => {
    const previous = button.textContent;
    button.textContent = label;
    setTimeout(() => { if (button.isConnected) button.textContent = previous; }, 1200);
  };
  const copy = globalThis.sophoCopyText;
  if (!copy) {
    // 共用脚本没加载（`/copy-text.js`）：那三级就一个都没有 ⇒ 如实说，不假装复制成功。
    console.warn('sophoCopyText 不在场（/copy-text.js 没加载？）：复制这一格没有三级降级');
    flash('复制失败');
    return false;
  }
  const outcome = await copy.copyText(text, {
    label: '命令全文',
    hint: '在工具卡的展开态里自己选中命令复制',
  }).catch((error) => {
    // 兜底的兜底：共用实现自己逐级都把错误收在里面了，真不该走到这里 —— 走到了也**如实**说，
    // 不装成功，也不让它变成一条未捕获的 rejection。
    console.error(`复制命令时共用实现抛了：${error?.message ?? String(error)}`);
    return null;
  });
  if (!outcome) { flash('复制失败'); return false; }
  button.dataset.copyPath = outcome.path;
  button.title = `复制命令：走的是 ${outcome.path} 路径（${outcome.bytes} 字节）`;
  console.log(`[render] 复制命令：走 ${outcome.path} 路径（${outcome.bytes} 字节）`);
  if (outcome.path === 'manual') { flash('请手动复制'); return false; }
  flash('已复制');
  return outcome.ok;
}

// M-26 / M-27 的折叠阈值：工具输出超过这个体量默认折叠（短输出保持展开），thinking 默认展开。
const TOOL_OUTPUT_COLLAPSE_LINES = 12;
const TOOL_OUTPUT_COLLAPSE_CHARS = 800;
// M-25 的 diff 另有一档**更松**的阈值：TUI 里 edit 的逐行 diff 是直接摊开看的（`components/diff.js`），
// 拿正文那档 12 行去卡它会把常规改动也收起来（M-25 就白做了）。超过这个行数才跟着卡片一起默认折叠；
// 另外 `.tool-diff-body` 自己也有 max-height（16rem，与 `.tool-result` 同），再长也不会撑破卡片。
const TOOL_DIFF_OPEN_LINES = 40;

// ── 折叠态容器（思考 / 工具输出）───────────────────────────────────────────────
// 为什么要有它：折叠态原来**只存在 DOM 节点自己的 `dataset.collapsed` 上**，而正文一旦重画
// （`renderMessages` 会 `replaceChildren`：session.end / snapshot / compaction_end / 切会话 /
// 渐进补齐，全走这一条）节点就是全新的 ⇒ 用户点过的「收起思考」被抹回默认，看起来像
// 「逻辑一结束就重置」。这里把它挪进一个**会话级、按稳定身份索引**的容器；渲染时先建节点、
// 再把状态应用回去。
//
// 键（稳定身份，不看位置/顺序）：
//   · 消息：`entryId`（服务端 messageWire 每条都带）⇒ `e:<entryId>`；没有 entryId 的合成/老数据
//     回落到 `i:<压缩盐>:<下标>` —— 盐取**最新压缩条目的 entryId**。压缩后条目身份会变（盐变 ⇒
//     旧键全部落空 ⇒ 回到默认）：这是**优雅退化**，不是拿别的条目的状态顶上。
//   · 思考：消息键 + `:p<该条消息里 thinking part 的序数>`（同一条消息里可以有交错的多段思考）。
//   · 工具输出：优先工具调用 id（`toolCallId` ⇒ `:c:<id>`，跑着→完成、重排都不变），
//     没有才回落到 part 序数 `:t<序数>`。
// 容器里只存**用户显式点过的**折叠态（默认态照旧渲染时算），所以大小随「点过多少个折叠开关」
// 增长，与动作次数无关（重复点同一个键是覆盖）。另有两道硬上界：每个会话 LRU 256 键、最多 24 个会话。
const COLLAPSE_SCOPE_LIMIT = 24;
const COLLAPSE_KEY_LIMIT = 256;
const collapseStores = new Map(); // scope -> Map<key, boolean>（Map 的插入顺序就是 LRU 序）

function collapseStore(scope) {
  let store = collapseStores.get(scope);
  if (store) {
    // 命中即视为最近使用（LRU）：删了再插，挪到队尾。
    collapseStores.delete(scope);
    collapseStores.set(scope, store);
    return store;
  }
  store = new Map();
  collapseStores.set(scope, store);
  while (collapseStores.size > COLLAPSE_SCOPE_LIMIT) collapseStores.delete(collapseStores.keys().next().value);
  return store;
}

/** 记下一个用户**显式选择**的折叠态；超出每会话上界时淘汰最久未动的键。 */
export function rememberCollapseState(scope, key, collapsed) {
  const store = collapseStore(scope);
  store.delete(key); // 覆盖也要挪到队尾（就是 LRU 序）
  store.set(key, collapsed === true);
  while (store.size > COLLAPSE_KEY_LIMIT) store.delete(store.keys().next().value);
  schedulePersistCollapse();
  return store.size;
}

/** 读回折叠态；没记过 ⇒ undefined（调用方用默认值，默认态不进容器）。 */
export function readCollapseState(scope, key) {
  const store = collapseStores.get(scope);
  return store ? store.get(key) : undefined;
}

/** 只给测试/报告用的内省：容器上界实测。 */
export function collapseStoreStats() {
  let keys = 0;
  let maxScopeKeys = 0;
  for (const store of collapseStores.values()) {
    keys += store.size;
    maxScopeKeys = Math.max(maxScopeKeys, store.size);
  }
  return { scopes: collapseStores.size, keys, maxScopeKeys, scopeLimit: COLLAPSE_SCOPE_LIMIT, keyLimit: COLLAPSE_KEY_LIMIT, storageMaxChars: COLLAPSE_STORAGE_MAX_CHARS, storageVersion: COLLAPSE_STORE_VERSION };
}

// ── 跨刷新记住（localStorage）──────────────────────────────────────────────────
// 用户拍板的「乙」：刷新页面（F5）后，上次收起/展开的折叠态还在。只做三件事，别的都不碰：
//   · **只存布尔**，且用**与会话内容器完全相同的键**（`e:<entryId>:…` / `i:<盐>:<下标>:…`）——
//     键自洽：刷新后同一份正文算出的键一模一样，所以对得上；
//   · **带版本号**（`v`）；版本不符 / JSON 坏了 / 不是布尔的条目 ⇒ **整份当没有**，静默降级；
//   · **上界**：沿用容器自己的两道 LRU（24 会话 × 256 键），再加一道**序列化字节上限**
//     （超了就从最老的会话开始丢，宁可少记，绝不撑爆 localStorage）。
// localStorage 不可用（Node / 隐私模式 / 被策略禁用）⇒ 静默无记忆，绝不让它把渲染带崩。
//
// ⚠️ 「丙」已经做了（本件，`docs/design/design-settings.md` v1）：思考折叠的**全局默认**改由**服务端**说话
// （`GET /settings` 的 `thinking.defaultFold`，侧车 `$ASSIST_HOME/ui-settings.json`）。
// 优先级仍是**显式点击 > 全局默认**：本容器/localStorage 里记过的照旧优先（既有「乙」一字未动），
// 只有「**没人点过**」时才去问服务端给的默认。前端**不推算**它（默认 ⊕ 已存是服务端算的）——
// 下面 `setThinkingDefaultFold()` 只收服务端给的生效值。
const COLLAPSE_STORAGE_KEY = 'sopho.collapse.v1';
const COLLAPSE_STORE_VERSION = 1;
const COLLAPSE_SAVE_DEBOUNCE_MS = 200;
const COLLAPSE_STORAGE_MAX_CHARS = 64 * 1024;

let collapseStorage;
let collapseStorageChecked = false;
let collapseSaveTimer = 0;

/** localStorage 可用吗（写一次探针再删）。不可用 ⇒ null，后续全部静默跳过。 */
function collapseStorageOrNull() {
  if (collapseStorageChecked) return collapseStorage;
  collapseStorageChecked = true;
  collapseStorage = null;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const probe = `${COLLAPSE_STORAGE_KEY}.probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    collapseStorage = localStorage;
  } catch { collapseStorage = null; }
  return collapseStorage;
}

/** 只认「v 相符 + 每层都是 object + 每个值是布尔」；否则整份当没有（坏了不许半信半疑地读）。 */
function loadPersistedCollapse() {
  const store = collapseStorageOrNull();
  if (!store) return;
  let parsed;
  try {
    const raw = store.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch { return; }
  if (!parsed || parsed.v !== COLLAPSE_STORE_VERSION || typeof parsed.scopes !== 'object' || parsed.scopes === null) return;
  let scopes = 0;
  for (const scope of Object.keys(parsed.scopes)) {
    if (scopes >= COLLAPSE_SCOPE_LIMIT) break;
    const entries = parsed.scopes[scope];
    if (typeof entries !== 'object' || entries === null) continue;
    const map = new Map();
    for (const key of Object.keys(entries)) {
      if (map.size >= COLLAPSE_KEY_LIMIT) break;
      const value = entries[key];
      if (value === true || value === false) map.set(key, value);
    }
    if (map.size > 0) { collapseStores.set(scope, map); scopes += 1; }
  }
}

function persistedScopes() {
  const scopes = {};
  for (const [scope, map] of collapseStores) {
    const entries = {};
    let count = 0;
    for (const [key, value] of map) {
      if (count >= COLLAPSE_KEY_LIMIT) break;
      entries[key] = value === true;
      count += 1;
    }
    scopes[scope] = entries;
  }
  return scopes;
}

/** 真的落盘。字节超上限就从最老的会话开始丢（Map 的插入顺序 = LRU），丢完还是超就不写了。 */
function persistCollapseNow() {
  collapseSaveTimer = 0;
  const store = collapseStorageOrNull();
  if (!store) return;
  const json = collapsePersistedJson();
  if (json.length > COLLAPSE_STORAGE_MAX_CHARS) return;
  try { store.setItem(COLLAPSE_STORAGE_KEY, json); } catch { /* 配额/被禁 ⇒ 静默降级 */ }
}

/** 当前会写进 localStorage 的那份 JSON。字节超上限就从最老的会话开始丢，直到装得下
 *  （宁可少记一点，绡不让它把 localStorage 撑爆）。测试/报告用同一个函数量体积。 */
export function collapsePersistedJson() {
  const snapshot = { v: COLLAPSE_STORE_VERSION, scopes: persistedScopes() };
  let json = JSON.stringify(snapshot);
  while (json.length > COLLAPSE_STORAGE_MAX_CHARS) {
    const names = Object.keys(snapshot.scopes);
    if (names.length === 0) break;
    delete snapshot.scopes[names[0]];
    json = JSON.stringify(snapshot);
  }
  return json;
}

/** 防抖：一次点击风暴只落一次盘（尾沿），不在每个 click 上同步写 localStorage。 */
function schedulePersistCollapse() {
  if (!collapseStorageOrNull()) return;
  if (collapseSaveTimer) clearTimeout(collapseSaveTimer);
  collapseSaveTimer = setTimeout(persistCollapseNow, COLLAPSE_SAVE_DEBOUNCE_MS);
}

// 模块导入时就读回上一次的折叠态（app.js 在渲染之前 import 本模块 —— 先读盘、再画）。
loadPersistedCollapse();

// 流式 → 正式正文那一刻的「交接桥」。直播块里的 part（思考 / 工具卡）**还没有 entryId**
// （历史还没落盘），所以直播期间把折叠态记在桥上的**直播键**里（思考 `p<序数>`、
// 工具 `c:<toolCallId>`）；正文一重画，**最后那条 assistant 消息**（下标 ≥ 桥的 startIndex，
// 因为这一轮会把用户那条也算进来）就把同一个直播键接过去、写进它自己的稳定键。
// 桥的生命周期由 app.js 的 `startLive` / `finishLive` 掐住（开工清一次、收工清一次），
// 保证「上一轮的折叠态」不会漏给下一轮的直播 part。
const liveBridges = new Map(); // scope -> { startIndex, parts: Map<bridgeKey, boolean> }

export function collapseScopeOf(container) {
  return container?.dataset?.collapseScope || 'default';
}

/** 一个直播 part 的**直播键**：思考 `p<该消息里 thinking part 的序数>`；
 *  工具 `c:<toolCallId>`（没有 id 才回落 `t<序数>`）—— 与正式正文那一侧同编号，交接才对得上。 */
export function liveBridgeKey(part, ordinal) {
  return part?.type === 'thinking' ? `p${ordinal}` : toolKeyOf(part, ordinal);
}

/** 取（按需建/换）这一轮直播的桥。`startIndex` 变了 ⇒ 换新桥，绝不把上一轮的状态带过来。 */
function liveBridgeFor(container, startIndex) {
  const scope = collapseScopeOf(container);
  let bridge = liveBridges.get(scope);
  if (!bridge || bridge.startIndex !== startIndex) {
    bridge = { startIndex, parts: new Map(), commands: new Map() };
    liveBridges.delete(scope);
    liveBridges.set(scope, bridge);
    while (liveBridges.size > COLLAPSE_SCOPE_LIMIT) liveBridges.delete(liveBridges.keys().next().value);
  }
  return bridge;
}

/** app.js 的直播块：读回这一轮直播里该 part 的折叠态（没点过 ⇒ 服务端给的**全局默认**）。
 *  注意 `undefined` 与 `false` 不同：前者 = 没人点过（听全局默认），后者 = 用户显式展开过（听手动的）。 */
export function liveCollapseGet(container, bridgeKey, startIndex) {
  const bridged = liveBridgeFor(container, startIndex).parts.get(bridgeKey);
  return bridged === undefined ? thinkingDefaultCollapsed() : bridged === true;
}

/** app.js 的直播块：点一下就把折叠态记进桥里（重挂直播块 / 工具卡就地重建 / 正文交接都读它）。 */
export function liveCollapseSet(container, bridgeKey, collapsed, startIndex) {
  const bridge = liveBridgeFor(container, startIndex);
  bridge.parts.set(bridgeKey, collapsed === true);
  return bridge.parts.size;
}

/** app.js 的直播工具卡：给 `toolCard()` 的折叠态上下文（正式正文那一侧由 messageBody 造）。
 *  `stableKey = null`（直播 part 还没有 entryId）⇒ 只走桥；交接后由正式正文把桥值落到稳定键。
 *  M-25 / M-31 的直播那一半：SSE `session.tool_end` 现在原样带 `details` 与 `content`（图片块就在里面），
 *  形状与 `/messages` 里配对的 toolResult message 一致 ⇒ 这里把它按 toolCallId 装成 `toolImages`，
 *  `toolExtras()` 一个字不改就能把 diff / 图片画出来。 */
export function liveToolContext(container, part, ordinal, startIndex, sessionId = null) {
  const toolImages = new Map();
  const toolImageMeta = new Map();
  const blocks = imageBlocksOf(part);
  if (part?.toolCallId && blocks.length > 0) {
    toolImages.set(part.toolCallId, blocks);
    toolImageMeta.set(part.toolCallId, Array.isArray(part.images) ? part.images : []);
  }
  return {
    scope: collapseScopeOf(container),
    stableKey: null,
    bridgeKey: liveBridgeKey(part, ordinal),
    bridge: liveBridgeFor(container, startIndex),
    toolImages,
    toolImageMeta,
    // 卡片级反馈（annotations）：直播这一侧 messageId 还没有（**绝不编**），
    // blockIndex 回落「这条消息里第几个工具卡」，toolCallId 是真正的稳定锚。
    sessionId,
    messageId: null,
    blockIndex: ordinal,
    role: 'assistant',
  };
}

/** 直播路（SSE `session.tool_end` 的 `details`）是 **pi 原样的** `ToolResultMessage.details`（例如
 *  `edit` 的 `{diff,firstChangedLine}`），而工具卡的 `toolExtras()` 读的是 `/messages` 那条路
 *  `detailsWire()` 产出的 `{status,value,bytes,truncated,note,preview}` 壳。
 *  这一个函数把前者包成后者的 `status:'known'` 那一支，让**两条路共用同一个 `toolExtras()`**。
 *  ⚠️ 直播路的 details **不截断**（服务端 `eventPayload()` 原样透出）；64KB 上限只属于 `/messages` 那条路。
 *  没有 details ⇒ `null`（`toolExtras()` 据此不画，不编）。 */
export function knownDetails(value) {
  if (value === undefined || value === null) return null;
  return { status: 'known', value, bytes: null, truncated: false, note: null, preview: null };
}

/** 收工（`finishLive`）/开工（`startLive`）：桥作废。收工后由消息自己的稳定键说话，
 *  否则「桥」会在用户改过正式正文之后又把旧值盖回来。 */
export function clearLiveCollapse(container) {
  return liveBridges.delete(collapseScopeOf(container));
}

const THINKING_LABELS = { collapsed: '▸ 展开思考', expanded: '▾ 收起思考' };
const TOOL_LABELS = { collapsed: '▸ 展开输出', expanded: '▾ 收起输出' };

// ── 思考折叠的**全局默认**（服务端权威）────────────────────────────────────────────────
// 值只有一个来源：`GET /settings` 回里的 `settings['thinking.defaultFold']`（服务端已经把
// 「默认 ⊕ 已存」算好了）。前端**只存这个生效值**，不自己合并、不回退到「本地推一个」。
//
// 为什么落地默认必须是 `'expanded'`：① 它必须**等于既有行为**（本文件一直默认展开，换默认会悄悄
// 改掉所有人的观感）；② 它必须与 pi TUI 对得上 —— TUI 的 `hideThinkingBlock` 默认 `false`
// （`node_modules/@earendil-works/pi-coding-agent/docs/settings.md:34`；
// `dist/core/settings-manager.js:620-621` 的 `getHideThinkingBlock()` 是 `?? false`），即**默认显示思考**。
// 详见 `docs/design/design-settings.md` §5-⑦ 与 `test/settings-fold.mjs` 的引证。
//
// 拿不到设置（端点不可用 / 首屏还没回来 / 假 API 没有这条路由）⇒ 用 `'expanded'`：那是**退化到
// 既有行为**，不是另定一个默认（也不会把渲染带崩）。
const THINKING_DEFAULT_FALLBACK = 'expanded';
let thinkingDefaultFold = THINKING_DEFAULT_FALLBACK;

/** 收下服务端给的**生效值**（`'expanded' | 'collapsed'`）。只认这两个值，别的当没收到。 */
export function setThinkingDefaultFold(value) {
  thinkingDefaultFold = value === 'collapsed' ? 'collapsed' : THINKING_DEFAULT_FALLBACK;
  return thinkingDefaultFold;
}

/** 当前生效的思考默认折叠态（`true` = 默认收起）。给渲染默认值、直播块、门读取。 */
export function thinkingDefaultCollapsed() {
  return thinkingDefaultFold === 'collapsed';
}

/** 把折叠态**四处**一起写：dataset / 正文 hidden / aria-expanded / 按钮文案。
 *  为什么四处都要：CSS 与断言看 dataset，视觉看 hidden 与文案，读屏看 aria；只改一半就会出现
 *  「看是收起、读屏说展开」这种半截状态。render.js 与 app.js 的直播块共用它，形状才不会走偏。 */
export function applyThinkingState({ thinking, toggle, content }, collapsed) {
  thinking.dataset.collapsed = String(collapsed);
  content.hidden = collapsed;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.textContent = collapsed ? THINKING_LABELS.collapsed : THINKING_LABELS.expanded;
}

export function applyToolState({ card, output, toggle }, collapsed) {
  card.dataset.collapsed = String(collapsed);
  output.hidden = collapsed;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.textContent = collapsed ? TOOL_LABELS.collapsed : TOOL_LABELS.expanded;
}

/** 展开命令那一相（与输出折叠**两条轴**，互不干扰：输出收起来时命令照样能展开看）。 */
const TOOL_COMMAND_LABELS = { collapsed: '展开命令', expanded: '收起命令' };

function applyCommandState({ args, toggle, command }, expanded) {
  args.dataset.commandExpanded = String(expanded);
  command.hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? TOOL_COMMAND_LABELS.expanded : TOOL_COMMAND_LABELS.collapsed;
}

/** 实时输出那一相（`session.tool_update`）。**只描述「到这一刻为止」**，一个字都不预言：
 *   · `totalLines` 是 pi 的 bash 快照给的**真实总行数**（`details.truncation.totalLines`）⇒ 直接说「已输出 N 行」；
 *   · 快照被截断时说清「只给了尾部 M 行、一共 N 行」（不许把尾部当全部）；
 *   · pi 明确说了「这一帧就是全部」（`complete === true`）⇒ 行数按帧内自己数，是**精确值**；
 *   · 服务端**不知道**是不是全部（`complete !== true`）⇒ 只能说**下界**「至少 N 行」
 *     —— 绝不把「未知」画成「0 行」或一个看起来精确的数（那是在编）。 */
function liveOutputLabel(live) {
  const known = Number.isFinite(live.totalLines) ? live.totalLines : null;
  const emitted = Number.isFinite(live.emittedLines) ? live.emittedLines : null;
  const draft = String(live.text ?? '').endsWith('\n') ? String(live.text ?? '').slice(0, -1) : String(live.text ?? '');
  const local = draft === '' ? 0 : draft.split('\n').length;
  if (live.truncated === true) {
    const total = known !== null ? `已输出 ${known} 行` : `已输出 ≥ ${local} 行`;
    return `实时 · ${total}（这一帧只给了尾部 ${emitted ?? '?'} 行）`;
  }
  if (live.complete === true) return `实时 · 已输出 ${known ?? local} 行`;
  return `实时 · 至少 ${local} 行（服务端没说这一帧是不是全部）`;
}

/** 实时输出节点的**内容**（建节点与就地更新走同一条，免得两处口径漂）。 */
function fillLiveOutput(node, live) {
  const text = String(live?.text ?? '');
  const body = node.querySelector('.tool-live-body');
  const meta = node.querySelector('.tool-live-meta');
  if (body.textContent !== text) body.textContent = text;
  const label = liveOutputLabel(live);
  if (meta.textContent !== label) meta.textContent = label;
}

function liveOutputNode(document, live) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-live';
  wrap.dataset.live = 'true';
  const body = document.createElement('pre');
  body.className = 'tool-live-body';
  const meta = document.createElement('div');
  meta.className = 'tool-live-meta';
  wrap.append(body, meta);
  fillLiveOutput(wrap, live);
  return wrap;
}

/** **就地**把最新那份累积快照写进直播卡（`web/app.js` 的 `renderLive` 每帧调一次）。
 *  ⚠️ 不在这里建节点：第一帧由 `toolCard()` 画（`livePartKey` 里「有没有实时尾」进 key ⇒ 那一下
 *  卡片原位重建一次），之后每帧都只是写文本 —— 否则用户展开的命令会被 ≈10 帧/秒的增量收回去。
 *  `live` 为 `null` 表示「正式结果到了」⇒ 把实时尾**整块摘掉**（替换，不是叠加）。 */
export function updateLiveOutput(card, live) {
  const node = card?.querySelector('.tool-live');
  if (!live) { node?.remove(); return; }
  if (!node) return;
  fillLiveOutput(node, live);
}

/** 一个工具 part 的部件键：优先工具调用 id（跑着→完成、重排都不变），没有才回落 part 序数。 */
function toolKeyOf(part, index) {
  const callId = part?.toolCallId ?? part?.id ?? null;
  return callId ? `c:${callId}` : `t${index}`;
}

// ── 卡片级反馈（annotations，`docs/history/design-annotations.md` v1）──────────────────────────────
// 每张用户/助手消息卡与每张工具结果卡右下角一个低调小按钮；点开写一句话 ⇒ 由 `web/app.js`
// POST `/annotations`。这里只**造节点与锚点数据**（交互全在 app.js 的委托监听里，重画不会漏监听器）。
// 锚点用**卡片自己的稳定 id**（绝不用 CSS 选择器 —— 它跨渲染会漂）：
//   · 消息卡：`messageId`(=entryId) ＋ `blockIndex`(=这条消息在会话正文里的下标) ＋ `role`；
//   · 工具结果卡：`messageId`(所属消息) ＋ `blockIndex`(=它在所属消息 `parts` 里的下标)
//     ＋ `toolCallId`/`toolName`。
// 拿不到 `messageId`（直播/重连头几帧还没有 entryId）就写 null —— **绝不编**；
// `blockIndex` 是位置兜底（直播期间唯一能给的定位），`excerpt` 提交时由 app.js 从卡片正文取。
const ANNOTATION_KINDS = new Set(['message', 'toolResult']);

/** 卡片锚点（与 `annotationAnchorOf` 同构；`live` 侧 messageId=null）。 */
function annotationKeyOfValues(kind, sessionId, messageId, blockIndex, toolCallId) {
  return [kind ?? '', sessionId ?? '', messageId ?? '', blockIndex ?? '', toolCallId ?? ''].join('|');
}

export function annotationControl(document, anchor = {}) {
  const kind = ANNOTATION_KINDS.has(anchor.kind) ? anchor.kind : 'message';
  const messageId = anchor.messageId ?? null;
  const blockIndex = anchor.blockIndex === null || anchor.blockIndex === undefined ? '' : String(anchor.blockIndex);
  const tools = kind === 'toolResult' ? (anchor.toolCallId ?? null) : null;
  const wrap = document.createElement('div');
  wrap.className = 'annotate';
  wrap.dataset.annotateKind = kind;
  wrap.dataset.annotateSession = anchor.sessionId ?? '';
  wrap.dataset.annotateMessageId = messageId ?? '';
  wrap.dataset.annotateBlockIndex = blockIndex;
  wrap.dataset.annotateToolCallId = tools ?? '';
  wrap.dataset.annotateToolName = kind === 'toolResult' ? (anchor.toolName ?? '') : '';
  wrap.dataset.annotateRole = kind === 'message' ? (anchor.role ?? '') : '';
  wrap.dataset.annotateKey = annotationKeyOfValues(kind, anchor.sessionId, messageId, blockIndex, tools);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'annotate-button';
  button.dataset.annotateAction = 'open';
  button.title = '反馈给维护者';
  button.setAttribute('aria-label', '反馈给维护者');
  button.textContent = '✎';
  const done = document.createElement('span');
  done.className = 'annotate-done';
  done.hidden = true;
  done.textContent = '已反馈 ✓';
  // ⚠️ 输入框**不在这里建**：每张卡都先造一个 `<form>`+textarea，在真规模会话（几千条消息）
  //   上会把首屏/分片渲染拖慢到把 `test:streamjump-real` 的阅读锚位移顶出预算（实测 87px→289px）。
  //   点击按钮时才由 `ensureAnnotationForm()` 现造 —— 默认每卡只多一个 22px 的小按钮。
  wrap.append(button, done);
  return wrap;
}

/** 点开时才现造的输入表单（幂等）。`openAnnotationForm`（app.js）用。 */
export function ensureAnnotationForm(control) {
  if (!control) return null;
  const existing = control.querySelector('.annotate-form');
  if (existing) return existing;
  const document = control.ownerDocument;
  const form = document.createElement('form');
  form.className = 'annotate-form';
  form.hidden = true;
  const note = document.createElement('textarea');
  note.className = 'annotate-note';
  note.dataset.annotateField = 'note';
  note.rows = 1;
  note.placeholder = '写一句话反馈给维护者…（Enter 提交 · Esc 取消）';
  note.setAttribute('aria-label', '反馈内容');
  const actions = document.createElement('div');
  actions.className = 'annotate-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'annotate-submit';
  submit.textContent = '提交';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'annotate-cancel';
  cancel.dataset.annotateAction = 'cancel';
  cancel.textContent = '取消';
  actions.append(submit, cancel);
  const status = document.createElement('span');
  status.className = 'annotate-status';
  status.setAttribute('aria-live', 'polite');
  form.append(note, actions, status);
  control.insertBefore(form, control.querySelector('.annotate-done'));
  return form;
}

/** 从控件节点上读出锚点（app.js 提交时用）。 */
export function annotationAnchorOf(control) {
  const d = control?.dataset ?? {};
  const rawIndex = d.annotateBlockIndex === '' || d.annotateBlockIndex === undefined ? null : Number(d.annotateBlockIndex);
  return {
    kind: d.annotateKind ?? null,
    sessionId: d.annotateSession || null,
    messageId: d.annotateMessageId || null,
    blockIndex: Number.isInteger(rawIndex) ? rawIndex : null,
    toolCallId: d.annotateToolCallId || null,
    toolName: d.annotateToolName || null,
    role: d.annotateRole || null,
  };
}

/** 卡片锚点键（v1 的本地标记用它；v1.5 起只用于调试观察，**不再**决定卡片显示什么）。 */
export function annotationKeyOf(control) {
  return control?.dataset?.annotateKey ?? null;
}

/** 卡片里**人可见**的正文（提交时的 `excerpt` 与「直播卡 → 正式卡」匹配的兜底**共用这一套**规范化）：
 *  工具卡取 `.tool-result`；消息卡取 `.message-body` 并把嵌套的工具卡剔掉（否则正文里混进工具输出）。 */
export function annotationCardText(control) {
  const owner = control?.parentElement ?? null;
  if (!owner) return '';
  let text = '';
  if (control?.dataset?.annotateKind === 'toolResult') {
    text = owner.querySelector('.tool-result')?.textContent ?? '';
  } else {
    const body = owner.querySelector('.message-body');
    if (body) {
      const clone = body.cloneNode(true);
      for (const tool of clone.querySelectorAll('.tool-card')) tool.remove();
      text = clone.textContent ?? '';
    } else {
      text = owner.textContent ?? '';
    }
  }
  return text.replace(/\s+/gu, ' ').trim();
}

/** 卡片锚点 ↔ 服务端一条标注：**匹配不上就不显示**（宁可不显示，也不张冠李戴）。
 *  纯函数（可单测）。规则（v1.5；`bodyText` = 这张卡的人可见正文，只有最后一条退路用它）：
 *   1. `sessionId` 与 `kind` 必须逐字相等；
 *   2. `toolResult`：两侧都有 `toolCallId` ⇒ **以它为准**——它跨「直播卡 → 正式卡」两侧都在
 *      （直播侧那个 `blockIndex` 是「第几张工具卡」、正式侧是「parts 里的下标」，口径不同 ⇒ 不看它）；
 *      任一侧没有 `toolCallId` ⇒ 退化为 `messageId + blockIndex` 逐字相等（拿不准就不匹配）；
 *   3. `message`：两侧都有 `messageId` ⇒ `messageId + blockIndex` 逐字相等；
 *      两侧都没有 `messageId`（都在直播期）⇒ `blockIndex + role` 相等；
 *      一侧有一侧没有（直播期提交、交接之后那条正式卡）⇒ `blockIndex + role` 相等 **且** 记录里的
 *      `excerpt` 是这张卡正文的前缀。这条就是「直播卡 → 正式卡」缺口的兜底：
 *      当时没正文（excerpt 为空）或正文对不上 ⇒ **不显示**（如实回到「对不上」）。 */
export function annotationMatches(anchor, record, bodyText = null) {
  if (!anchor || !record) return false;
  if (!anchor.sessionId || anchor.sessionId !== record.sessionId) return false;
  if (anchor.kind !== record.kind) return false;
  const sameIndex = Number.isInteger(anchor.blockIndex) && anchor.blockIndex === record.blockIndex;
  if (anchor.kind === 'toolResult') {
    if (anchor.toolCallId && record.toolCallId) return anchor.toolCallId === record.toolCallId;
    return anchor.messageId !== null && anchor.messageId === record.messageId && sameIndex;
  }
  const sameRole = anchor.role !== null && record.role !== null && anchor.role === record.role;
  if (anchor.messageId !== null && record.messageId !== null) {
    return anchor.messageId === record.messageId && sameIndex;
  }
  if (!sameIndex || !sameRole) return false;
  if (anchor.messageId === null && record.messageId === null) return true;
  const excerpt = typeof record.excerpt === 'string' ? record.excerpt.trim() : '';
  if (excerpt === '' || typeof bodyText !== 'string') return false;
  return bodyText.startsWith(excerpt);
}

/** 卡片上的痕迹（v1.5 起**全部由服务端 `state` 驱动**）：
 *   `'sent'` = 已反馈（服务端 `state:'open'`）；`'done'` = 已处理（服务端 `state:'done'`）；
 *   `null`/`''` = 清掉（没有匹配上的标注，或读不到服务端现状 ⇒ 一个字都不显示）。 */
const ANNOTATION_MARK_LABELS = { sent: '已反馈 ✓', done: '已处理 ✓' };
export function applyAnnotationState(control, state) {
  if (!control) return;
  const done = control.querySelector('.annotate-done');
  const form = control.querySelector('.annotate-form');
  control.dataset.annotateState = state ?? '';
  if (done) {
    done.textContent = ANNOTATION_MARK_LABELS[state] ?? ANNOTATION_MARK_LABELS.sent;
    done.hidden = !Object.hasOwn(ANNOTATION_MARK_LABELS, state ?? '');
  }
  if (form && Object.hasOwn(ANNOTATION_MARK_LABELS, state ?? '')) form.hidden = true;
}

/** 折叠态的最终取值：① 桥（直播期间点过的）优先；② 否则这个部件的稳定键；③ 都没有 ⇒ 调用方给的默认值。
 *  桥 → 稳定键的搬运也在这里：正文重画时把直播期间的态落下来，桥被清掉之后它自己还站着。 */
function resolveCollapse(ctx, defaultCollapsed) {
  const bridged = ctx.bridge ? ctx.bridge.parts.get(ctx.bridgeKey) : undefined;
  const value = bridged !== undefined ? bridged : (ctx.stableKey ? readCollapseState(ctx.scope, ctx.stableKey) : undefined);
  if (bridged !== undefined && ctx.stableKey) rememberCollapseState(ctx.scope, ctx.stableKey, bridged);
  return value === undefined ? defaultCollapsed : value;
}

/** 用户点了一下：写回容器；这一条正被桥盯着（直播刚开、历史已到）时桥也要同步，
 *  免得下一次重画用旧值盖回来。 */
function persistCollapse(ctx, collapsed) {
  if (ctx.stableKey) rememberCollapseState(ctx.scope, ctx.stableKey, collapsed);
  if (ctx.bridge) ctx.bridge.parts.set(ctx.bridgeKey, collapsed);
}

// ── 「命令全文展开」的折叠态（与输出的折叠是**两条轴**）─────────────────────────
// ⚠️ 用**独立的键前缀**（`cmd:`）—— 不然与输出折叠（`e:<entryId>:c:<id>` / `c:<id>`）撞车，
// 用户收起的输出会把展开的命令一起收走。容器 / localStorage / LRU / 桥都是同一个（不另开一套）。
const COMMAND_KEY_PREFIX = 'cmd:';

function commandKeyOf(ctx) {
  return ctx.stableKey ? `${COMMAND_KEY_PREFIX}${ctx.stableKey}` : null;
}

/** 命令全文是否展开。默认**收起**（守「折叠态一行」）；用户显式点过 / 桥上有值就听那个。 */
function resolveCommandExpanded(ctx) {
  const bridged = ctx.bridge ? ctx.bridge.commands.get(ctx.bridgeKey) : undefined;
  const key = commandKeyOf(ctx);
  const value = bridged !== undefined ? bridged : (key ? readCollapseState(ctx.scope, key) : undefined);
  if (bridged !== undefined && key) rememberCollapseState(ctx.scope, key, bridged);
  return value === true;
}

function persistCommandExpanded(ctx, expanded) {
  const key = commandKeyOf(ctx);
  if (key) rememberCollapseState(ctx.scope, key, expanded);
  if (ctx.bridge) ctx.bridge.commands.set(ctx.bridgeKey, expanded === true);
}

/** 一条消息的稳定键。 */
function messageKey(item, index, salt) {
  return item.entryId ? `e:${item.entryId}` : `i:${salt}:${index}`;
}

/** 一次渲染的共享上下文：会话作用域、压缩盐、以及「最后那条 assistant 消息」是不是桥的落点。 */
function messageContext(payload, scope) {
  const messages = payload.messages || [];
  let lastAssistantIndex = -1;
  messages.forEach((item, index) => { if (item.role === 'assistant') lastAssistantIndex = index; });
  const bridge = liveBridges.get(scope);
  // M-31：工具结果里的图片。toolResult message 自己**不单独成节点**（见下面的 buildMessageNodes），
  // 它的 `content` 里那几块原图只有配到工具卡上才画得出来 ⇒ 在这里按 toolCallId 建两张账。
  const toolImages = new Map();
  const toolImageMeta = new Map();
  for (const item of messages) {
    if (!item.toolCallId) continue;
    const blocks = imageBlocksOf(item);
    if (blocks.length === 0) continue;
    toolImages.set(item.toolCallId, blocks);
    toolImageMeta.set(item.toolCallId, Array.isArray(item.images) ? item.images : []);
  }
  return {
    scope,
    toolImages,
    toolImageMeta,
    // 卡片级反馈（annotations）的会话锚：`payload.sessionId` 是服务端一定给的；
    // 没有（假 API / fixture）就 null —— 提交时 app.js 拒绝无 sessionId 的提交。
    sessionId: typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : null,
    salt: payload.compaction?.entryId ?? '-',
    // 桥的落点 = 最后那条 assistant 消息，且它必须落在这一轮直播**之后**（下标 ≥ startIndex）。
    // 历史还没跟上（没有 ≥ startIndex 的 assistant）时不动桥，等下一次重画。
    bridge: bridge && lastAssistantIndex >= bridge.startIndex ? bridge : null,
    bridgeTargetIndex: bridge && lastAssistantIndex >= bridge.startIndex ? lastAssistantIndex : -1,
  };
}

// ── M-31：图片块内联显示 ──────────────────────────────────────────────────────
// 服务端只给「元数据 + 占位行」（`server/base-logic.mjs` 的 imageBlocks/contentTextWithImages），
// 而**原图 base64 一直原样躺在 `wire.content` 的 image 块里**（`docs/ops/tui-parity.md` M-31 说的那份原文）。
// 所以这一块只消费已有字段：不新增 wire 字段、不改 /messages 形状。
//
// 三条硬要求落在实现上：
//   ① 不静默空白：每一种「画不出来」都有自己的那一句（数据缺失 / 认不出类型 / 解码失败）；
//   ② 不引起布局跳变：宽高从图片**文件头**读（`web/image-size.mjs`），插进 DOM **之前**就写进
//      width/height 属性 ⇒ 解码完成前后盒子一样大（读不到尺寸时才走「占位撑一行」的退路）；
//   ③ 不说反话：占位行原文是「（网页暂不显示图片内容）」—— 图既然画出来了，那行就要让位
//      （`consumeImagePlaceholders`）；画不出来的那些行原样留着。
const IMAGE_PLACEHOLDER_LINE = /^\[图片：.*（网页暂不显示图片内容）\]$/;
const IMAGE_MIME_TYPES = /^image\/[a-z0-9.+-]+$/i;

/** 一条 message wire 上的图片块（`content` 里的原文，含 base64）。 */
function imageBlocksOf(item) {
  return Array.isArray(item?.content) ? item.content.filter((block) => block?.type === 'image') : [];
}

/** 服务端给这条消息的图片元数据（`images: [{mimeType,bytes}]`，与 content 里图片块同序）。 */
function imageMetaOf(item, index) {
  const list = Array.isArray(item?.images) ? item.images : [];
  const meta = list[index];
  return meta && typeof meta === 'object' ? meta : {};
}

/** 把**前 count 个**占位行从正文里拿掉（图已经画出来了，那行「暂不显示图片内容」就是假话）。
 *  占位行比图片块多时，多出来的**原样留着** —— 那说明服务端有图片元数据、这边却没有原图，
 *  留着正是那种现场唯一诚实的一句话。 */
export function consumeImagePlaceholders(text, count) {
  const value = String(text ?? '');
  if (!(count > 0) || !value.includes('（网页暂不显示图片内容）')) return value;
  let left = count;
  const kept = [];
  for (const line of value.split('\n')) {
    if (left > 0 && IMAGE_PLACEHOLDER_LINE.test(line.trim())) { left -= 1; continue; }
    kept.push(line);
  }
  return kept.join('\n');
}

function imageFallback(document, figure, text) {
  const node = document.createElement('div');
  node.className = 'message-image-bad';
  node.textContent = text;
  figure.append(node);
  return node;
}

/** 一个图片块 → `<figure class="message-image">`（图片本体 + 一行元信息）。
 *
 *  降级三分支（对着「有数据 / 坏数据 / 缺数据」三种现场）：
 *    · 没有 base64 data ⇒ `.message-image-bad` 说明「数据缺失」；
 *    · 有 data 但类型认不出（声明与文件头都不认）⇒ 说明「认不出类型」；
 *    · 有 src 但解码失败（img 的 `error`）⇒ 摘掉那张 img，换成「无法解码或显示」。
 *  三种都**不留空白**，也都不让页面崩（img 的 error 是能走到这里的唯一路径）。 */
export function imageFigure(document, block, meta = {}) {
  const declared = typeof block?.mimeType === 'string' && IMAGE_MIME_TYPES.test(block.mimeType) ? block.mimeType : null;
  const data = typeof block?.data === 'string' && block.data.trim() !== '' ? block.data : null;
  const facts = data === null ? null : imageHeaderFacts(data);
  // 文件头说了算：声明与真实字节不一致时（贴错扩展名那种），按**内容**画、也在 caption 里报内容那一种。
  const mime = facts?.mime ?? declared;
  const bytes = Number.isFinite(meta?.bytes) && meta.bytes >= 0 ? meta.bytes : exactBase64Bytes(data);
  const figure = document.createElement('figure');
  figure.className = 'message-image';
  figure.dataset.kind = 'image';
  const caption = document.createElement('figcaption');
  caption.className = 'message-image-meta';
  caption.textContent = `图片 · ${mime ?? '类型未知'} · ${bytes === null ? '字节数未知' : `${bytes} 字节`}`;
  figure.append(caption);
  if (data === null) {
    figure.dataset.state = 'missing';
    imageFallback(document, figure, `${caption.textContent} —— 这条消息的图片块里没有 base64 数据，网页没有东西可以画`);
    return figure;
  }
  if (mime === null) {
    figure.dataset.state = 'unknown-type';
    imageFallback(document, figure, `${caption.textContent} —— 既没有可用的 mimeType，文件头也不是 PNG/JPEG/GIF/WebP，认不出类型，未内联显示`);
    return figure;
  }
  const image = document.createElement('img');
  image.setAttribute('src', `data:${mime};base64,${data}`);
  image.setAttribute('alt', caption.textContent);
  // 惰性 + 异步解码：屏幕外/折叠里的图片不参与布局，也不抢占主线程。
  image.setAttribute('loading', 'lazy');
  image.setAttribute('decoding', 'async');
  const size = facts?.width && facts?.height ? { width: facts.width, height: facts.height } : null;
  if (size) {
    // 文件头给了真实像素尺寸 ⇒ 先占好位置，解码完成时盒子一点都不动。
    image.setAttribute('width', String(size.width));
    image.setAttribute('height', String(size.height));
    figure.dataset.imageWidth = String(size.width);
    figure.dataset.imageHeight = String(size.height);
  }
  image.addEventListener('load', () => {
    figure.dataset.state = 'loaded';
    if (!size && image.naturalWidth > 0 && image.naturalHeight > 0) {
      // 文件头没读出来（非常规编码）才走这条退路：这一次仍会跳一下，但把真实尺寸补进属性，
      // 同一条消息之后的任何一次重画都不再跳。
      image.setAttribute('width', String(image.naturalWidth));
      image.setAttribute('height', String(image.naturalHeight));
      figure.dataset.imageWidth = String(image.naturalWidth);
      figure.dataset.imageHeight = String(image.naturalHeight);
    }
  });
  image.addEventListener('error', () => {
    figure.dataset.state = 'error';
    image.remove();
    imageFallback(document, figure, `${caption.textContent} —— 这段 base64 解不出图片（浏览器解码失败），未内联显示`);
  });
  figure.dataset.state = 'pending';
  figure.append(image);
  return figure;
}

// ── M-25：工具 diff 的逐行 +/- ────────────────────────────────────────────────
// 语义照 pi 的 TUI（`components/diff.js`）：行形如 `+123 content` / `-123 content` / ` 123 content` / `     ...`；
// 前缀就是增/删/上下文，`...` 那行是「中间跳过了若干上下文行」的省略记号（pi 的 generateDiffString 用
// context=4 生成，本块不改写那份字符串，只按同一套语义着色与编号）。服务端把这条字符串放在 tool 卡的
// `details.value.diff`（`edit` 工具产出的就是它），`details.value.firstChangedLine` 是首个变更行（新文件口径）。
//
// ⚠️ 不做 TUI 的**行内词级**高亮（`renderIntraLineDiff`）：那要一个词级 diff 算法（pi 用 `diff` 包），
//   本仓 web/vendor 里没有；逐行 +/- 与行号是这一版给的那一块。
const DIFF_LINE = /^([+-\s])(\s*\d*)\s(.*)$/;

export function parseDiffLine(line) {
  const match = DIFF_LINE.exec(String(line ?? ''));
  if (!match) return null;
  return { prefix: match[1], lineNumber: match[2], content: match[3] };
}

function diffLineKind(parsed) {
  if (!parsed) return 'raw';
  if (parsed.prefix === '+') return 'add';
  if (parsed.prefix === '-') return 'remove';
  return parsed.content === '...' && parsed.lineNumber.trim() === '' ? 'skip' : 'context';
}

/** 一行的可显示文本：与 pi 的 renderDiff 同一拼法（前缀 + 行号 + 空格 + 内容），
 *  tab 换成 3 个空格（同 TUI 的 replaceTabs；否则 tab 在不同容器里宽度不一）。 */
function diffLineText(parsed, raw) {
  if (!parsed) return raw;
  return `${parsed.prefix}${parsed.lineNumber} ${parsed.content.replace(/\t/g, '   ')}`;
}

/** diff 字符串 → 逐行节点（`+`/`-`/上下文/省略，各带 `data-diff` 供 CSS 上色）。
 *  统计口径全部**从这份字符串数出来**（不拿别处的数字编）。 */
export function diffBlock(document, diffText, firstChangedLine, source = 'details') {
  const body = document.createElement('div');
  body.className = 'tool-diff-body';
  let added = 0;
  let removed = 0;
  let context = 0;
  let skipped = 0;
  for (const raw of String(diffText ?? '').split('\n')) {
    const parsed = parseDiffLine(raw);
    const kind = diffLineKind(parsed);
    if (kind === 'add') added += 1;
    else if (kind === 'remove') removed += 1;
    else if (kind === 'skip') skipped += 1;
    else context += 1;
    const line = document.createElement('div');
    line.className = 'tool-diff-line';
    line.dataset.diff = kind;
    line.textContent = kind === 'skip' ? `⋮ ${parsed.content}` : diffLineText(parsed, raw);
    body.append(line);
  }
  const head = document.createElement('div');
  head.className = 'tool-diff-head';
  head.textContent = [
    source === 'write' ? 'write 全量内容（逐行都是新增；不是与旧文件的差量）' : '逐行 diff',
    `+${added} −${removed}`,
    `上下文 ${context} 行`,
    skipped > 0 ? `省略 ${skipped} 处` : null,
    Number.isFinite(firstChangedLine) ? `首变更行 ${firstChangedLine}` : null,
  ].filter(Boolean).join(' · ');
  const wrap = document.createElement('div');
  wrap.className = 'tool-diff';
  wrap.dataset.kind = 'diff';
  wrap.dataset.source = source;
  wrap.dataset.added = String(added);
  wrap.dataset.removed = String(removed);
  wrap.append(head, body);
  return wrap;
}

/** `details` 超限 / 不能序列化时，服务端给的是「省略 + 真实字节数 + 原文预览」（`detailsWire`）。
 *  这一块**不许**当 diff 画（那是半截 JSON），只如实说清并给原文预览。 */
function toolDetailsNote(document, details) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-details';
  wrap.dataset.kind = 'details';
  wrap.dataset.status = details.status;
  const note = document.createElement('div');
  note.className = 'tool-details-note';
  note.textContent = typeof details.note === 'string' && details.note !== ''
    ? details.note
    : `工具 details ${details.status === 'oversized' ? '超过上限' : '不能序列化'}，正文被省略（不画半截 JSON）`;
  wrap.append(note);
  if (typeof details.preview === 'string' && details.preview !== '') {
    const preview = document.createElement('pre');
    preview.className = 'tool-details-preview';
    preview.textContent = `原文预览（前 ${details.preview.length} 字符）：\n${details.preview}`;
    wrap.append(preview);
  }
  return wrap;
}

// ── 工具卡的耗时（TUI 平价）─────────────────────────────────────────────────────
// pi 的 shell 渲染器在工具卡里写一行 muted 的耗时：跑着是 `Elapsed 3.4s`、跑完是 `Took 3.4s`
// （`dist/core/tools/renderers/bash.js:23` 的 `formatDuration`、`:93-95` 的落行位置；TUI 在
// `renderResult` 的 `isPartial` 期间每 1000ms 重画一次（`setInterval` + `invalidate()`））。
// 我们网页的等价物：**卡片标题行**加一个 muted 的 `.tool-duration`，格式**逐字**用 TUI 的
// `${(ms / 1000).toFixed(1)}s`，跑着的时候每秒重算、结束时冻结。
//
// 四条裁决（不是随手的）：
//   ① **基准必须是服务端给的 `startedAt`**，不是「从 0 开始计」：页面可以在工具跑着的时候才
//      打开/刷新/重连，那时历史里那张 running 卡要显示**已经**跑了多久；从 0 开始计在那里就是撒谎。
//      两个基准的来源与「近似、不是 CPU 时间」的口径见 `server/base-logic.mjs` 的 `entryTimestamp()`。
//   ② **拿不到 `startedAt` 就不画**（没有标签，**绝不写 `0.0s`**）：算不出来的时候不编一个数。
//      只有 `startedAt`、没有 `endedAt`、且这张卡**已不在跑**（未完成/中断）时同样不画 —— 那只能
//      写「到现在为止跑了多久」，而那个数会随页面停留时长一直变大，是另一种时间口径，不是这次要的。
//   ③ **一个共享定时器**，只有「跑着的卡」在册（不是每张卡一个 interval）；每 250ms 重算一遍，
//      文案没变就是一个写都不做。TUI 是 1s 重画一次（终端重画整屏，太快反而浪费）；网页只改一个
//      span 的文本，重算得勤一点更贴「已经跑了多少秒」的真值，**可见跳变仍由 `toFixed(1)` 的
//      0.1s 数字决定**。
//   ④ **清场靠 `isConnected`**：卡片被正文重画 / 切会话 / 直播块重挂换掉（= 离开文档）之后，
//      下一次 tick 就把它从册里剔掉；册空了定时器自己停。⇒ 不需要每个调用点（`renderMessages`
//      有同步/渐进/尾部增量三条路、`app.js` 的直播块还会重挂）都记得清理，也不会有「后台一直跳」。
const TOOL_DURATION_TICK_MS = 250;
const toolDurationTickers = new Set();
let toolDurationTimer = 0;

/** pi 的耗时格式（逐字照 `bash.js:23`）：`${(ms / 1000).toFixed(1)}s`，例如 `3.4s`。 */
export function formatToolDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** ISO 时间戳（服务端的 `startedAt`/`endedAt`）→ 毫秒；取不到 / 解析不出 ⇒ `null`
 *  （**绝不**回落本地时钟 —— 那会把「服务端什么时候说它开始了」换成「页面什么时候画的」）。 */
function toolDurationMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function paintToolDuration(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** 活着的卡怎么算「已经跑了多久」：**以服务端的 `startedAt` 为基准**（不是从 0 开始计）。
 *  钳到 0 只是防客户端/服务端时钟差把 `-0.3s` 画出来（同一台机器上这个分支不会进）。 */
function toolDurationElapsed(entry, now) {
  return Math.max(0, now - entry.startedAtMs);
}

function stopToolDurationTimer() {
  if (!toolDurationTimer) return;
  clearInterval(toolDurationTimer);
  toolDurationTimer = 0;
}

function tickToolDurations() {
  const now = Date.now();
  // 边遍历边删当前项是 Set 迭代器允许的（删过的项不会再出现）。
  for (const entry of toolDurationTickers) {
    // 卡片已经不在文档里（正文重画 / 切会话 / 直播块重挂）⇒ 这张不再跳，也不该留着。
    if (entry.node.isConnected !== true) { toolDurationTickers.delete(entry); continue; }
    paintToolDuration(entry.node, `${entry.prefix}${formatToolDuration(toolDurationElapsed(entry, now))}`);
  }
  if (toolDurationTickers.size === 0) stopToolDurationTimer();
}

/** 登记一张**跑着的**卡：先把当前值写上去（第一帧就得是对的值，不等第一次 tick），再挂共享定时器。 */
function registerToolDuration(node, prefix, startedAtMs) {
  const entry = { node, prefix, startedAtMs };
  toolDurationTickers.add(entry);
  paintToolDuration(node, `${prefix}${formatToolDuration(toolDurationElapsed(entry, Date.now()))}`);
  if (!toolDurationTimer) toolDurationTimer = setInterval(tickToolDurations, TOOL_DURATION_TICK_MS);
}

/** 工具卡上的耗时标签：跑着 ⇒ `已跑 3.4s`（每秒跳）/ 跑完 ⇒ `用时 3.4s`（冻结）。
 *  画不出来（没有 `startedAt`、或只有 `startedAt` 而没有结果的静止卡、或 `endedAt` 早于
 *  `startedAt` 这种自相矛盾的数据）⇒ 返回 `null`，**一个标签都不加**。 */
function toolDurationNode(document, part, state) {
  const startedAtMs = toolDurationMs(part?.startedAt);
  const endedAtMs = toolDurationMs(part?.endedAt);
  if (startedAtMs === null) return null;
  const running = state === 'running' && endedAtMs === null;
  if (!running && (endedAtMs === null || endedAtMs < startedAtMs)) return null;
  const node = document.createElement('span');
  node.className = 'tool-duration';
  if (running) registerToolDuration(node, '已跑 ', startedAtMs);
  else paintToolDuration(node, `用时 ${formatToolDuration(endedAtMs - startedAtMs)}`);
  return node;
}

/** 一张工具卡上除结果文本之外的「结构化输出」：M-25 的 diff（details）与 M-31 的图片（配对的 toolResult）。
 *  返回 `{ nodes, diffLines, images }` —— nodes 按「diff → 图片」的顺序接在结果文本之后。 */
function toolExtras(document, part, ctx) {
  const nodes = [];
  let diffLines = 0;
  let diffNode = null;
  const details = part?.details && typeof part.details === 'object' ? part.details : null;
  const value = details?.status === 'known' ? details.value : null;
  const diffText = value && typeof value.diff === 'string' ? value.diff : '';
  if (diffText.trim() !== '') {
    diffNode = diffBlock(document, diffText, value.firstChangedLine, 'details');
    diffLines = diffText.split('\n').length;
  } else if (part?.name === 'write' && typeof part.args?.content === 'string') {
    // write 工具**本来就不产 diff**（pi 的 `write.js` details 恒为 undefined）——它的「逐行」就是
    // 参数里的文件内容本身（TUI 的 write 渲染器展示的也正是这段内容）。按 pi 的 diff 行形全部记成新增。
    const content = part.args.content.replace(/\n+$/, '');
    if (content !== '') {
      const synthetic = content.split('\n').map((line, index) => `+${index + 1} ${line}`).join('\n');
      diffNode = diffBlock(document, synthetic, undefined, 'write');
      diffLines = synthetic.split('\n').length;
    }
  } else if (details && (details.status === 'oversized' || details.status === 'unserializable')) {
    diffNode = toolDetailsNote(document, details);
    diffLines = 2;
  }
  if (diffNode) nodes.push(diffNode);
  // 图片：工具结果里的 image 块（`read` 读图就是这个形状）。这些块挂在**被跳过的** toolResult message
  // 的 `content` 上，所以要靠 toolCallId 配到这张卡上（见 `messageContext` 的 toolImages）。
  const blocks = part?.toolCallId ? (ctx?.toolImages?.get(part.toolCallId) ?? []) : [];
  const metas = part?.toolCallId ? (ctx?.toolImageMeta?.get(part.toolCallId) ?? []) : [];
  for (let index = 0; index < blocks.length; index += 1) nodes.push(imageFigure(document, blocks[index], metas[index] ?? {}));
  return { nodes, diffLines, images: blocks.length };
}

function toolResultText(part, state) {
  if (state === 'running') return '⎿ 运行中…';
  if (state === 'unfinished' || state === 'interrupted') return '⏹ 未完成／已中断，或结果没有落盘';
  return String(part.result ?? '').trim() || (state === 'done-error' ? '⎿ 执行失败（没有错误正文）' : '⎿ 完成');
}

export function toolCard(document, part, ctx) {
  const states = new Set(['running', 'done-success', 'done-error', 'unfinished', 'interrupted']);
  const state = states.has(part.status) ? part.status : part.isError ? 'done-error' : 'unfinished';
  // diff / 图片：必须进 `.tool-output`（`.tool-card` 的直接子元素被 `test/wrap-sweep.mjs` 的元素签名
  // 钉成「恰好 div.tool-call + div.tool-output」两个，且折叠开关管的也是这个容器）。
  const extras = toolExtras(document, part, ctx);
  const card = document.createElement('section');
  card.className = `tool-card${state === 'done-error' ? ' tool-bad' : ''}`;
  card.dataset.kind = 'tool';
  card.dataset.state = state;
  // 稳定钩子：这张卡片的身份证（折叠态键、直播↔正式交接、门里的定位都靠它；没 id 的合成数据才缺）。
  if (part.toolCallId) card.dataset.toolCallId = part.toolCallId;
  // 「块自带可见身份」（业主 2026-09-22 的平铺）：工具块是**顶层块**，角标行说清**类型 + 谁发起的**
  // （`tool · assistant`），与 user/assistant/bash 块的 `.message-role` 同一套观感 —— 不靠位置猜归属。
  appendText(document, card, 'message-role', 'tool · assistant');
  // 所属 assistant 消息的稳定指针（门与折叠态用；直播卡还没有 entryId ⇒ 不写）。
  if (ctx?.messageId) card.dataset.partOf = ctx.messageId;
  if (Number.isInteger(ctx?.blockIndex)) card.dataset.partIndex = String(ctx.blockIndex);
  const header = document.createElement('div');
  header.className = 'tool-call';
  const name = document.createElement('strong');
  name.className = 'tool-name';
  name.textContent = part.name || 'tool';
  const args = document.createElement('span');
  args.className = 'tool-args';
  // 折叠态那一行：**与既有行为逐字相同**（`argSummary`：首行 + 240 字上限）。
  const argsSummary = document.createElement('span');
  argsSummary.className = 'tool-args-summary';
  argsSummary.textContent = argSummary(part.args);
  args.append(argsSummary);
  header.append(name, args);
  // 命令全文 + 展开 + 复制（业主 2026-09-22 缺陷①）。
  // ⚠️ 只在**「摘要 != 全文」**时加（多行、或被 240 字切过）—— 短单行命令**一个元素都不加**，
  // 这样既有门（元素签名 / 观感 / 单行）的那些夹具行为逐字不变。
  // ⚠️ 这些元素都挂在 **`.tool-args` 里面**，不是 `.tool-call` 的直接子元素 —— `test/wrap-sweep.mjs`
  // 与 `test/text-wrap.mjs` 把 `.tool-call` 的直接子元素钉成「恰好 name/args/duration/toggle」。
  const command = fullCommandOf(part.args);
  let commandView = null;
  if (command !== null && command !== argsSummary.textContent) {
    const facts = commandFacts(command);
    // 折叠态**恰好一行**的钩子（CSS 只认这个属性）：摘要 `nowrap + ellipsis`、三个控件 `flex:none`。
    // ⚠️ 只在**带全文的**命令卡上生效 —— 「摘要 == 全文」那些 `.tool-args` 一字未动
    // （`test/wrap-sweep.mjs` / `test/text-wrap.mjs` 的夹具就是那一类："摘要会随长 token 换行"
    // 是它们登记在案的**现有**行为，本件不去动它）。
    args.dataset.commandClip = 'true';
    const meta = document.createElement('span');
    meta.className = 'tool-args-meta';
    // 「让人知道后面还有」：行数 · 字数（标的是**全文**，不是那一行的）。
    meta.textContent = `${facts.lines} 行 · ${facts.chars} 字`;
    const commandToggle = document.createElement('button');
    commandToggle.type = 'button';
    commandToggle.className = 'tool-args-toggle';
    commandToggle.dataset.commandToggle = 'true';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'tool-copy';
    copy.dataset.commandCopy = 'true';
    copy.textContent = '复制';
    // 展开态：**逐字全文**（`pre-wrap` 保留换行与空格，最大高度 + 内部滚动由 CSS 管）。
    const commandNode = document.createElement('pre');
    commandNode.className = 'tool-command';
    commandNode.dataset.commandFull = 'true';
    commandNode.textContent = command;
    args.append(meta, commandToggle, copy, commandNode);
    commandView = { args, toggle: commandToggle, command: commandNode };
    applyCommandState(commandView, ctx ? resolveCommandExpanded(ctx) : false);
    commandToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = commandNode.hidden;
      applyCommandState(commandView, next);
      if (ctx) persistCommandExpanded(ctx, next);
    });
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyVerbatim(copy, commandNode.textContent ?? '');
    });
  }
  // 耗时标签（TUI 平价）：跑着的每秒跳、跑完冻结；算不出来就不加这个元素（见 toolDurationNode）。
  const duration = toolDurationNode(document, part, state);
  if (duration) header.append(duration);
  const resultText = consumeImagePlaceholders(toolResultText(part, state), extras.images);
  // 只有「已完成的长输出」默认折叠；运行中/未完成/短输出保持展开。
  const collapsible = state === 'done-success' || state === 'done-error';
  const startCollapsed = collapsible && (
    resultText.length > TOOL_OUTPUT_COLLAPSE_CHARS ||
    resultText.split('\n').length > TOOL_OUTPUT_COLLAPSE_LINES ||
    extras.diffLines > TOOL_DIFF_OPEN_LINES
  );
  const collapsed = ctx ? resolveCollapse(ctx, startCollapsed) : startCollapsed;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tool-toggle';
  toggle.dataset.toolToggle = 'true';
  const output = document.createElement('div');
  output.className = 'tool-output';
  // 「本机缺省 bash 超时」那一行：摆在结果**之前**，与 `.tool-result` 同一块（一卡正文的第一句）。
  // ⚠️ 为什么不放进 `.tool-call` 那一行：那一行有**恒为一条（≤26px）**的硬规矩（`npm run test:toolcmd`
  // 的那条），插一句话会把命令卡撑成两行；为什么不放进 `.tool-args`：那里的 textContent 就是**参数本身**
  //（有门逐字钉着）。这里与 `.tool-result` 同层的块级小字，不新造视觉语言。
  if (bashTimeoutNoteApplies(part)) {
    const timeoutNote = document.createElement('div');
    timeoutNote.className = 'tool-timeout-note';
    timeoutNote.dataset.timeoutNote = 'true';
    timeoutNote.textContent = bashTimeoutNoteText();
    output.append(timeoutNote);
  }
  // 实时输出（`session.tool_update`）：**只在真的收到过增量帧**时才出现（`part.live` 由
  // `web/app.js` 挂上）—— 没有增量事件时一个元素都不加，与今天逐字一致（不许造假进度）。
  // 它排在正式结果**之前**：结束那一下 `part.live` 被摘掉，这里就换成正式结果（替换，不是叠加）。
  if (part.live) output.append(liveOutputNode(document, part.live));
  const result = document.createElement('pre');
  result.className = 'tool-result';
  result.textContent = resultText;
  output.append(result, ...extras.nodes);
  const view = { card, output, toggle };
  applyToolState(view, collapsed);
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = card.dataset.collapsed !== 'true';
    applyToolState(view, next);
    if (ctx) persistCollapse(ctx, next);
  });
  header.append(toggle);
  card.append(header, output);
  // 卡片级反馈：工具结果卡右下角的低调小按钮（`docs/history/design-annotations.md` v1）。
  card.append(annotationControl(document, {
    kind: 'toolResult',
    sessionId: ctx?.sessionId ?? null,
    messageId: ctx?.messageId ?? null,
    blockIndex: Number.isInteger(ctx?.blockIndex) ? ctx.blockIndex : null,
    toolCallId: part.toolCallId ?? null,
    toolName: part.name ?? null,
  }));
  return card;
}

// 一条消息的**正文**（thinking / 图片 / 文本）。工具 part **不再**是 assistant 块的一部分
// （业主 2026-09-22 的「平铺」）：它们由 `assistantBlocks()` 提升成顶层 `section.tool-card`。
// `segment`（可选）= 一次分段渲染用的 `{ indices, thinkingOrdinal, imageOrdinal }`：assistant 消息在
// tool part 处切开时，每段只画自己那几个非工具 part，而序号（折叠键 / 图片）仍按**整条消息**编号
// （与直播侧 `p<序数>` 同口径）。
function partOrdinals(parts) {
  const thinking = new Array(parts.length).fill(0);
  const image = new Array(parts.length).fill(0);
  let t = 0;
  let i = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.type === 'thinking') { thinking[index] = t; t += 1; }
    else if (parts[index]?.type === 'image') { image[index] = i; i += 1; }
  }
  return { thinking, image };
}

function messageBody(document, item, ctx, segment = null) {
  const body = document.createElement('div');
  body.className = 'message-body';
  const parts = Array.isArray(item.parts) ? item.parts : [];
  // M-31：这条消息自己的图片块（原图 base64 在 `content` 里）。
  const blocks = imageBlocksOf(item);
  if (parts.length > 0) {
    const ordinals = segment ?? (() => {
      const { thinking, image } = partOrdinals(parts);
      return { indices: parts.map((_, index) => index), thinkingOrdinal: thinking, imageOrdinal: image };
    })();
    for (const blockIndex of ordinals.indices) {
      const part = parts[blockIndex];
      if (!part || part.type === 'tool') continue; // 工具 part 已由 assistantBlocks() 提到顶层
      if (part.type === 'image') {
        // assistant 的 `parts` 只带 `{mimeType,bytes}`（服务端不把原图在 parts 里再抄一份），
        // 原图按**同序**从 `content` 的图片块里取第 imageIndex 块 —— parts 与 content 的图片块
        // 都由同一份 content 顺序生成，次序对得上（对不上就退化成「数据缺失」那句）。
        const imageIndex = ordinals.imageOrdinal[blockIndex];
        const block = blocks[imageIndex];
        body.append(imageFigure(
          document,
          block && typeof block.data === 'string' ? block : { mimeType: block?.mimeType ?? part.mimeType ?? null },
          imageMetaOf(item, imageIndex),
        ));
      } else if (part.type === 'thinking') {
        const partIndex = ordinals.thinkingOrdinal[blockIndex];
        const thinking = document.createElement('div');
        thinking.className = 'message-thinking';
        const head = document.createElement('div');
        head.className = 'message-thinking-head';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'thinking-toggle';
        toggle.dataset.thinkingToggle = 'true';
        const content = document.createElement('div');
        content.className = 'thinking-body';
        content.append(renderMarkdown(document, part.text));
        const collapseCtx = {
          scope: ctx.scope,
          stableKey: `${ctx.messageKey}:p${partIndex}`,
          bridgeKey: `p${partIndex}`,
          bridge: ctx.bridge,
        };
        const view = { thinking, toggle, content };
        // 默认值来自服务端设置（`thinking.defaultFold`）；用户显式点过的照旧优先（`resolveCollapse` 先查容器/桥）。
        applyThinkingState(view, resolveCollapse(collapseCtx, thinkingDefaultCollapsed()));
        toggle.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const next = thinking.dataset.collapsed !== 'true';
          applyThinkingState(view, next);
          persistCollapse(collapseCtx, next);
        });
        head.append(toggle);
        thinking.append(head, content);
        body.append(thinking);
      } else if (part.type === 'text') body.append(renderMarkdown(document, part.text));
    }
  } else if (blocks.length > 0) {
    // 有图片的正文：按 `content` 的结构画（文本块走既有 markdown，图片块画真图）。
    // ⚠️ 这里**不走 `item.text`**：那里面拼着服务端的占位行「（网页暂不显示图片内容）」，
    //    图已经画出来了，再留着那行就是自相矛盾（`content` 里就是同一条正文的原文）。
    let imageIndex = 0;
    for (const block of item.content) {
      if (block?.type === 'image') {
        body.append(imageFigure(document, block, imageMetaOf(item, imageIndex)));
        imageIndex += 1;
      } else if (block?.type === 'text') body.append(renderMarkdown(document, block.text ?? ''));
    }
  } else {
    body.append(renderMarkdown(document, item.text || textOf(item.content)));
  }
  if (item.aborted || item.stopReason === 'aborted') appendText(document, body, 'message-aborted', '⏹ 这一轮已中断');
  return body;
}

/** 时间戳后缀（压缩边界 / 分支摘要共用）：` · 2026/9/1 08:00:11`，读不到就是空串。 */
function timestampSuffix(timestamp) {
  const value = timestamp ? new Date(timestamp) : null;
  return value && !Number.isNaN(value.getTime()) ? ` · ${value.toLocaleString('zh-CN')}` : '';
}

/** M-34：压缩 / 分支摘要的**计费行**。逐字照 pi TUI 的 `addCompactionCostNotice`
 *  （`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:3093-3101`）：
 *    · tokens = input + output + cacheRead + cacheWrite（TUI 用 footer 的 `formatTokens` 缩写，
 *      与本文件的 `formatUsageTokens` 是同一口径：k/M）；
 *    · 成本只在 `usage.cost.total >= 0.01` 时附 ` (~$X.XX)`，否则不写。
 *  wire 上 pi 记的原始 usage 在 `usage.raw`（`server/base-logic.mjs` 的 `normalizedUsage` 的 raw），
 *  成本取 `raw.cost.total` —— **照服务端原样**报，不在这儿重新估（TUI 用同一个 `usage.cost.total`）。
 *  `usage.status !== 'known'`（entry 上没有 usage）时**不画这一行**：TUI 也是 entry 上没 usage 就不加这条
 *  notice，webui 不拿 0 冒充。 */
function billingLine(document, parent, kind, usage) {
  if (usage?.status !== 'known') return null;
  const total = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
  const label = kind === 'branch_summary' ? 'Branch summary' : 'Compaction';
  const cost = usage.raw?.cost?.total;
  const suffix = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0.01 ? ` (~$${cost.toFixed(2)})` : '';
  return appendText(document, parent, 'compaction-billing', `${label}: ${formatUsageTokens(total)} tokens billed${suffix}`);
}

/** M-34 的「本会话压缩过 N 次」。出处**只有服务端给的计数**：
 *  `server/base-logic.mjs` 的 `messageWire` 在顶层给 `compactionCount`（= 当前 branch 里
 *  `type === 'compaction'` 的 entry 条数；`branch_summary` 是切分支的摘要，不算）。这里优先认
 *  `compaction.count`（别名，服务端给哪个都认），再认顶层 `compactionCount`。
 *  **0 是真实的数**：`Number.isFinite(0)` 为真 ⇒ 画「本会话压缩过 0 次」；只有字段**真的拿不到**
 *  才写「服务端未提供」—— 不用 `count || 兜底` 这种把 0 当空的写法，也不拿「屏幕上画了几个
 *  压缩块」充数（那是本地次数，不是事实来源）。
 *  ⚠️ 这一行画在**压缩边界块**里；一条压缩都没有的会话没有边界块 ⇒「0 次」在页面上没有落点
 *  （不是漏画）。所以本函数单独导出：门可以直接钉住「0 次 vs 缺字段」这个区分。 */
export function compactionCountText(payload) {
  const compaction = payload?.compaction ?? {};
  const count = Number.isFinite(compaction.count) ? compaction.count
    : (Number.isFinite(payload?.compactionCount) ? payload.compactionCount : null);
  return count === null ? '本会话压缩次数：服务端未提供' : `本会话压缩过 ${count} 次`;
}

function compactionNote(document, compaction, countText) {
  const note = document.createElement('section');
  note.className = 'compaction-note';
  note.dataset.kind = 'compaction';
  appendText(document, note, 'compaction-label', `✂ 压缩边界 @ ${compaction.atIndex}${timestampSuffix(compaction.timestamp)}：${compaction.note}`);
  if (compaction.summary) appendText(document, note, 'compaction-summary', `摘要：${compaction.summary}`);
  billingLine(document, note, 'compaction', compaction.usage);
  if (countText) appendText(document, note, 'compaction-count', countText);
  return note;
}

/** M-33：分支摘要块（`branch_summary` entry）。复用压缩边界块的**同一套**样式（`.compaction-note`
 *  + slot `--slot-extra`），只换标签字与 `data-kind` —— 不另造一套平行样式体系。
 *  `usage`/`details`/`fromId` 都是**可选**字段（`docs/session-format.md` 的 BranchSummaryEntry）：
 *  摘要缺就如实写「服务端未提供」，不编。 */
function branchSummaryNote(document, entry) {
  const note = document.createElement('section');
  note.className = 'compaction-note';
  note.dataset.kind = 'branch_summary';
  if (entry.entryId) note.dataset.entryId = entry.entryId;
  if (entry.fromId) note.dataset.fromId = entry.fromId;
  appendText(document, note, 'compaction-label', `⑂ 分支摘要 @ ${entry.atIndex}${timestampSuffix(entry.timestamp)}：${entry.note ?? ''}`);
  appendText(document, note, 'compaction-summary', entry.summary ? `摘要：${entry.summary}` : '摘要：服务端未提供');
  billingLine(document, note, 'branch_summary', entry.usage);
  return note;
}

/** 正文流里的「边界块」：压缩边界（服务端只给最新一条）+ **全部**分支摘要，各自带 `atIndex`
 *  （= 排在 `messages[atIndex]` 之前；见服务端 `messageWire`）。顺序：compaction 在前，
 *  分支摘要按服务端数组顺序（= `getBranch()` 顺序）在后。
 *  只有 `atIndex` 是有限数的才成块（压缩块缺省 `{atIndex:null}` 不画）。 */
function boundaryNotes(payload) {
  const notes = [];
  const compaction = payload?.compaction;
  if (compaction && Number.isFinite(compaction.atIndex)) {
    const countText = compactionCountText(payload);
    notes.push({ atIndex: compaction.atIndex, build: (document) => compactionNote(document, compaction, countText) });
  }
  for (const entry of payload?.branchSummaries ?? []) {
    if (!Number.isFinite(entry?.atIndex)) continue;
    notes.push({ atIndex: entry.atIndex, build: (document) => branchSummaryNote(document, entry) });
  }
  return notes;
}

function formatTokens(value) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知';
}

/** 观测行里的 token 数专用缩写（k = 千 / M = 百万），口径与 pi TUI footer 的 formatTokens 一致。
 *  这一行要「恰好一行」：12 位的原始数（如 437,427,072）单独就占 ~110px，是它被撑成两行的主因。
 *  精确值不丢——仍写进 #session-usage 的 title（见 renderSessionObservability）。
 *  ⚠️ 不要直接改 formatTokens：它还服务 #session-context 的「窗口」数字，那边要保留千分位。 */
function formatUsageTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  const count = Math.max(0, Math.trunc(value));
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatEstimatedCost(cost) {
  if (typeof cost?.total !== 'number') return '费用未知';
  const digits = cost.total >= 1 ? 2 : cost.total >= .01 ? 3 : 6;
  // 只留「（估算）」一个短标记（原来「（估算，非账单）」两个词是纯噪声）；
  // 「不是账单」这条完整说明挪进 title，口径不变。
  return `约 $${cost.total.toFixed(digits)}（估算）`;
}

function compactionDistance(context) {
  if (typeof context?.freeTokens !== 'number') return '距压缩阈值未知（服务端未提供）';
  if (context.compactionEnabled === false) return `距压缩边界还剩 ${formatUsageTokens(context.freeTokens)}（自动压缩已关）`;
  if (context.freeTokens >= 0) return `距压缩阈值还剩 ${formatUsageTokens(context.freeTokens)} tokens`;
  return `已超过压缩阈值 ${formatUsageTokens(-context.freeTokens)} tokens`;
}

// M-11（只读显示）：思考档位。格式与 pi TUI footer 对齐（`components/footer.js`：`modelName • thinkingLevel`）。
// 它紧跟在模型后面的理由：① 这就是 TUI 的写法（`model • level`）；② 观测行尾用 ellipsis 截断，
//    放到行尾在窄屏第一个被截掉，而档位是这行里唯一「模型此刻怎么思考」的事实；
//    ③ 行首已有「本轮 <模型>」，在行尾再写一遍模型正是用户点名过的「重复感」。
// 诚实降级：只有服务端真给了非空字符串才显示；读不到就不写（**不猜、不默认为某个档位**）。
function thinkingLevelSuffix(thinkingLevel) {
  return typeof thinkingLevel === 'string' && thinkingLevel.trim() !== '' ? ` • ${thinkingLevel}` : '';
}

export function renderSessionObservability(container, observability, context = null, thinkingLevel = null) {
  const distance = compactionDistance(context);
  const level = thinkingLevelSuffix(thinkingLevel);
  if (!observability) {
    container.title = '拿不到这一轮的用量事实（冷会话 / 还没跑过）：能知道的只有距压缩阈值的距离。';
    container.textContent = `本轮模型未知${level} · 累计未知 · ${distance}`;
    return;
  }
  const last = observability.lastTurn;
  const cumulative = observability.cumulative;
  const usage = cumulative?.usage;
  const model = last?.model?.display || '模型未知';
  const modelLabel = `${model}${level}`;
  // M-20：缓存统计取 cumulative.usage（标 R/W 会看不懂，这里改成「读取/写入/命中率」的明文）。
  // CH 命中率按 pi TUI footer 的口径只用「最近一轮」算：cacheRead/(input+cacheRead+cacheWrite)。
  // 数量级前缀 k/M 与 pi TUI 一致（见 formatUsageTokens），精确累计值在下面 title 里。
  const partial = usage?.status === 'partial';
  const cumulativeUsage = usage?.status === 'unknown'
    ? '累计未知'
    : `累计输入 ${formatUsageTokens(usage?.input)} / 输出 ${formatUsageTokens(usage?.output)}`;
  const cache = cacheSummary(observability);
  container.title = [
    '缓存读取/写入是会话累计；命中率按最近一轮 cacheRead/(input+cacheRead+cacheWrite) 算（与 pi TUI footer 同口径）。',
    `累计（精确）：输入 ${formatTokens(usage?.input)} / 输出 ${formatTokens(usage?.output)}${partial ? '；只统计已知轮次，缺 usage 的轮次不在内' : ''}`,
    '费用按 token 用量估算，不是账单。',
    ...(level ? ['思考档位（只读）来自服务端 runtime.thinkingLevel = pi 的 AgentSession.thinkingLevel：off / minimal / low / medium / high / xhigh / max。'] : []),
  ].join('\n');
  // 字段与顺序都是「一行内谁先被看见」定的 —— 行尾用 ellipsis 截，先把最该看的放左边：
  //   ① 本轮 <model>：这一行唯一的「身份」字段，别处看不到；
  //   ② 距压缩阈值：唯一带行动含义（要不要压缩）的实时数；
  //   ③ 约 $ 估算：这一行唯一的钱；
  //   ④ 缓存：命中率 + 读取量（保留 M-20 的方向，只是 R/W/CH 改成明文）；
  //   ⑤ 累计输入/输出：只增长、最不行动的汇总，放最后，窄屏第一个被截。
  // 删掉的字段与理由（以后想加回来先读这段）：
  //   · 「本轮 输入/输出」：与紧邻的累计是同一口径的重复（用户点名的「重复感」），
  //     且 pi TUI footer 只给累计，不给单轮；
  //   · 「（仅已知轮次）」「（估算，非账单）」两个括号：限定语不是数据，完整句进 title。
  const segments = [`本轮 ${modelLabel}`, distance, formatEstimatedCost(cumulative?.cost)];
  if (cache) segments.push(`缓存 ${cache}`);
  segments.push(cumulativeUsage);
  container.textContent = segments.join(' · ');
}

function cacheSummary(observability) {
  const usage = observability?.cumulative?.usage;
  const read = typeof usage?.cacheRead === 'number' ? usage.cacheRead : null;
  const write = typeof usage?.cacheWrite === 'number' ? usage.cacheWrite : null;
  const parts = [];
  if ((read ?? 0) > 0) parts.push(`读取${formatUsageTokens(read)}`);
  if ((write ?? 0) > 0) parts.push(`写入${formatUsageTokens(write)}`);
  const last = observability?.lastTurn?.usage;
  if (parts.length > 0 && last?.status === 'known') {
    const denominator = (last.input ?? 0) + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0);
    if (denominator > 0) parts.push(`命中率${((last.cacheRead ?? 0) / denominator * 100).toFixed(1)}%`);
  }
  return parts.join(' / ');
}

// M-23：上下文百分比 + 窗口大小，阈值配色只走 slot.css 既有 token（>70% 黄 / >90% 红）。
// 服务端拿不到 tokens 时（刚压缩过、下一轮还没来）如实显示 '?'，不拿 0 冒充。
export function renderContextUsage(container, context) {
  if (!context || typeof context.contextWindow !== 'number' || !(context.contextWindow > 0)) {
    // ⚠️ 行**保持占位**（不 hidden）：这一行从无到有会让整个顶栏长高 26px，把右侧正文区
    //    （grid 的 minmax(0,1fr) 行）整体向下推一下 —— 真规模数据实测冷开 +29px、热开（带 context）+58px
    //    （见 test/stream-jump-realdata.mjs）。居中留位后，数据到达只改文字，不改布局。
    container.hidden = false;
    container.textContent = '上下文未知（服务端未提供）';
    container.removeAttribute('data-level');
    return;
  }
  const used = typeof context.usedTokens === 'number' ? context.usedTokens : null;
  const percent = used === null ? null : used / context.contextWindow * 100;
  container.hidden = false;
  container.dataset.level = percent === null ? 'unknown' : percent > 90 ? 'error' : percent > 70 ? 'warn' : 'ok';
  const percentText = percent === null ? '?' : `${percent.toFixed(1)}%`;
  container.textContent = `上下文 ${percentText} / ${formatTokens(context.contextWindow)}${context.compactionEnabled === false ? '（自动压缩已关）' : ''}`;
}

// M-22：cwd 从 tooltip 提到一眼可见。窗口用 CSS 省略号截断，这里再对超长路径做
// 头部省略，保证叶子目录（最有用的一段）始终可见；完整路径仍在 title 里。
const CWD_DISPLAY_MAX = 72;
export function renderSessionCwd(container, cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    // 同上：这一行也**保持占位**，不让它在选中会话时突然长出来把正文区推下去。
    container.hidden = false;
    container.textContent = '工作目录未知';
    container.removeAttribute('title');
    return;
  }
  container.hidden = false;
  container.textContent = cwd.length > CWD_DISPLAY_MAX ? `…${cwd.slice(cwd.length - CWD_DISPLAY_MAX + 1)}` : cwd;
  container.setAttribute('title', cwd);
}

// M-18：左栏会话的纯前端过滤。匹配 = （名字或 cwd 子串，大小写不敏感）且（只看命名时 name 非空）。
// 被过滤掉的行不进 renderTree，所以它们的子会话在视图里上浮成根（不做祖先保留，语义直白）。
export function filterTreeSessions(sessions, { query = '', namedOnly = false } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle && !namedOnly) return list.slice();
  return list.filter((session) => {
    const name = typeof session?.name === 'string' ? session.name : '';
    if (namedOnly && name.trim() === '') return false;
    if (!needle) return true;
    const cwd = typeof session?.cwd === 'string' ? session.cwd : '';
    return name.toLowerCase().includes(needle) || cwd.toLowerCase().includes(needle);
  });
}

/**
 * 「模型建议」那一排（输入框正上方，`#suggestions-list`）。
 *
 * 纪律（业主 2026-09-23 拍的那条线）：
 *   · **只画服务端已经校验过的那几条**（非 JSON / 过长 / 空串 / 超 3 条都在服务端被丢/截了）——
 *     这里**不再自己改它们**（不截断、不重排），于是「上屏的就是校验后的内容」这句只有一处成立；
 *   · chip 上是**完整文本**（不截断）：一点就直接发出去，误点也要看得清；
 *   · 最多 3 颗是服务端保证的（它默认最多也就那么几颗）；这里照画拿到的每一条；
 *   · **没有候选就一个元素都不画**（调用方把它整排 `hidden`）—— 不画占位、不画 spinner。
 * 返回画出来的颗数。
 */
export function renderSuggestions(container, { items = [], onPick = null } = {}) {
  const document = container.ownerDocument;
  const values = Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item !== '') : [];
  container.replaceChildren();
  values.forEach((text, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion-chip';
    // 键盘可达性（⌥1–⌥3）与门里定位都靠它：**1 起数**（对人说话的数）。
    chip.dataset.suggestionIndex = String(index + 1);
    chip.title = `发送这一句（⌥${index + 1}）`;
    chip.textContent = text;
    if (typeof onPick === 'function') chip.addEventListener('click', () => onPick(text));
    container.append(chip);
  });
  return values.length;
}

export function renderQueueStatus(container, queue) {
  const steering = Array.isArray(queue?.steering) ? queue.steering : [];
  const followUp = Array.isArray(queue?.followUp) ? queue.followUp : [];
  const count = steering.length + followUp.length;
  container.replaceChildren();
  container.hidden = count === 0;
  if (count === 0) return;

  const document = container.ownerDocument;
  const summary = document.createElement('strong');
  summary.textContent = `⏳ 排队中 · ${count} 条`;
  container.append(summary);
  for (const [kind, messages] of [['steer', steering], ['follow-up', followUp]]) {
    for (const text of messages) {
      const item = document.createElement('span');
      item.className = 'queue-item';
      item.dataset.queueType = kind;
      item.textContent = `${kind}：${text}`;
      container.append(item);
    }
  }
}

export function renderCommandPalette(container, {
  open = false,
  mode = 'command',
  items = [],
  selectedIndex = 0,
  loading = false,
  error = null,
  query = '',
  onChoose = () => {},
} = {}) {
  container.hidden = !open;
  container.replaceChildren();
  if (!open) return;
  const document = container.ownerDocument;
  const note = (text) => appendText(document, container, 'command-palette-note', text);
  if (error) {
    note(error);
    return;
  }
  if (loading) {
    note(mode === 'model' ? '模型清单读取中…' : '命令清单读取中…');
    return;
  }
  if (items.length === 0) {
    note(query ? `没有匹配「${query}」的${mode === 'model' ? '模型' : '命令'}。` : `没有可用的${mode === 'model' ? '模型' : '命令'}。`);
    return;
  }
  items.forEach((item, index) => {
    const unavailable = mode === 'command' && item.runnable === false;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `command-palette-item${index === selectedIndex ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`;
    row.dataset.commandName = mode === 'model' ? item.ref : item.name;
    row.dataset.runnable = String(!unavailable);
    row.title = unavailable ? `网页里不能执行：${item.reason || 'TUI 专用'}` : (item.hint || '');
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => onChoose(item));

    const name = document.createElement('span');
    name.className = 'command-name';
    name.textContent = mode === 'model' ? item.ref : `/${item.name}`;
    row.append(name);
    const source = document.createElement('span');
    source.className = 'command-source';
    source.textContent = mode === 'model' ? (item.current ? '当前' : '可选') : ({ builtin: '内置', extension: '扩展', prompt: '模板', skill: '技能' }[item.source] || item.source);
    row.append(source);
    if (mode === 'command' && item.argumentHint) {
      const argument = document.createElement('span');
      argument.className = 'command-argument';
      argument.textContent = item.argumentHint;
      row.append(argument);
    }
    const description = document.createElement('span');
    description.className = 'command-description';
    description.textContent = mode === 'model' ? (item.name || '') : (item.description || '');
    row.append(description);
    if (unavailable) {
      const reason = document.createElement('span');
      reason.className = 'command-unavailable';
      reason.textContent = item.tag || 'TUI 专用';
      row.append(reason);
    }
    container.append(row);
  });
  note('↑↓ 选择 · Enter 执行/填入 · Esc 关闭');
  container.querySelector('.command-palette-item.selected')?.scrollIntoView({ block: 'nearest' });
}

// 大会话首开的分片渲染参数。
// 先同步画最近 RENDER_TAIL 条（小会话因此与「一次画完」逐字等价），更早的消息在空闲期
// 一片片补到正文顶部 —— 既不阻塞主线程、也不砍内容（补齐后 DOM = 服务端返回的全部条目）。
const RENDER_TAIL = 80;
const RENDER_SLICE = 6;
const RENDER_SLICE_BUDGET_MS = 6;
const renderTokens = new WeakMap();

function nextRenderToken(container) {
  const token = (renderTokens.get(container) || 0) + 1;
  renderTokens.set(container, token);
  return token;
}

// 让这个容器上尚未跑完的分片任务立刻作废。切会话/重画时必须先调它，
// 否则上一轮的旧消息还可能在下一帧被 prepend 进新会话的正文（世代号之外的渲染世代）。
export function cancelMessageRender(container) {
  nextRenderToken(container);
}

function nodeText(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.parts)) return item.parts.map((part) => part?.text || '').join('');
  if (Array.isArray(item.content)) return item.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
  return '';
}

// 屏幕外用估计高度占位时，估计值越接近真实高度，滚动位置越稳。按正文长度估一个块高即可
// （中文约 42 字/行、行高约 21px）；auto 会在元素真被渲染过后记住真实高度。
function estimateMessageHeight(item) {
  const length = nodeText(item).length + (Array.isArray(item.parts) ? item.parts.length * 60 : 0);
  const lines = Math.min(600, Math.max(1, Math.ceil(length / 42)));
  // M-25 / M-31：diff 行与图片块不吃 `nodeText` 的字数，却实打实占高度 ⇒ 单独加上去。
  // （`contain-intrinsic-size: auto` 在元素真被渲染过一次之后会用真实高度；这一条管的是第一次。）
  let extra = 0;
  for (const part of Array.isArray(item.parts) ? item.parts : []) {
    const diff = part?.details?.status === 'known' && typeof part.details.value?.diff === 'string' ? part.details.value.diff : '';
    if (diff !== '') extra += Math.min(400, diff.split('\n').length) * 21 + 22;
  }
  extra += imageBlocksOf(item).length * 260;
  return Math.min(8000, 44 + lines * 21 + extra);
}

// ── 扩展消息（`extras`）的落位 ───────────────────────────────────────────────
// 服务端刻意把 `custom_message` 放进**独立**字段 `extras`、不塞进 `messages`（`server/base-logic.mjs`
// 的 messageWire）：`compaction.atIndex` 与前端窗口计数都建在 `messages` 的**下标**上。
// 但 v2.2 的 payload 每条 extra 都带 `entryId` / `parentId` / `timestamp`（历史会话同样带），
// 而 pi 自己的顺序就是这样 —— 所以位置是**算得准的**，这里按锚把它摆回正文流里。
// 红线（v2.1 原意「不让人把机器的话当成模型的话」）：它始终是**独立**的 `aside.extra-message`
// 块 +「扩展消息 ·」标签，**绝不并进 message 正文**；这里只改摆放位置。
//
// 锚的优先级（每条都对着真会话 / 真 fixture 核过）：
//   ① parentId 命中 `messages[i]` ⇒ 边界 b = i + 1：落在**那条正文之后**。父是 `toolResult` 时
//      它照样占一个下标（只是不单独成节点）⇒ 自然落到画着那次工具调用的卡之后。
//   ② parentId 命中 compaction 条目 ⇒ b = atIndex：压缩块画在 `messages[atIndex]` **之前**，
//      所以这一档让 extra 落在压缩块**之后**。
//   ③ parentId 命中**另一条 extra**（连续两条）⇒ 与父同边界；先后靠 `extras` 的数组顺序保住
//      （服务端按 `getBranch()` 顺序 push，就是会话链的顺序）。
//   ④ 都不是（parentId 指向 `model_change` / `session_info` 这类**不进 `messages`** 的条目，
//      或在本 payload 里查不到）⇒ 按 `timestamp` 落位：排在第一条时间更晚的正文之前。
//      这是量过的做法：实测「父是 model_change」时若直接落末尾，extra 会排到**比它更晚**的正文
//      之后（错），按 timestamp 落位与文件顺序一致；「父在本 payload 里查不到」时它一定是链上
//      最老的一条（pi 的 `getBranch()` 从 leaf 沿 parentId 往回走、遇到缺失就停），timestamp
//      也正好把它放回最前。
//   ⑤ 连 `timestamp` 都拿不到（老文件缺时间）⇒ **保守回落**：留在末尾，保持 `extras` 数组顺序。
//      ⚠️ 这是**回落路径，不是正常路径**。
//
// 每条 extra 折算成一个边界位 b ∈ [0, messages.length]，表示它排在 `messages[b-1]` 与
// `messages[b]` 之间。同步路径按整表建；渐进路径按分片建 —— 每批只建 b 落在**本批区间**里的
// extra，于是「父还没补进来」的 extra 会跟着它所在的那一批一起被 prepend，最终仍在父之后。
function extraBoundaries(payload) {
  const messages = payload.messages || [];
  const extras = (payload.extras || []).filter((extra) => extra.display !== false);
  if (!extras.length) return [];
  const indexByEntry = new Map();
  messages.forEach((item, index) => { if (item.entryId) indexByEntry.set(item.entryId, index); });
  const compaction = payload.compaction ?? {};
  const cut = compaction.atIndex;
  const boundaryByEntry = new Map();
  const plan = [];
  for (const extra of extras) {
    const parentIndex = indexByEntry.get(extra.parentId);
    let boundary;
    let anchor;
    if (parentIndex !== undefined) {
      boundary = parentIndex + 1; // ①
      anchor = 'message';
    } else if (compaction.entryId && extra.parentId === compaction.entryId) {
      boundary = cut !== null && cut !== undefined && cut >= 0 && cut <= messages.length ? cut : messages.length; // ②
      anchor = 'compaction';
    } else if (boundaryByEntry.has(extra.parentId)) {
      boundary = boundaryByEntry.get(extra.parentId); // ③
      anchor = 'extra';
    } else {
      const at = firstMessageAfter(messages, extra.timestamp);
      boundary = at ?? messages.length; // ④ / ⑤
      anchor = at === null ? 'end' : 'timestamp';
    }
    boundaryByEntry.set(extra.entryId, boundary);
    plan.push({ extra, boundary, anchor });
  }
  return plan;
}

// 第一条时间**晚于** `timestamp` 的正文的下标；正文都比它早 ⇒ 末尾；一条时间都读不到 ⇒ null（交给回落）。
function firstMessageAfter(messages, timestamp) {
  const value = Date.parse(timestamp ?? '');
  if (Number.isNaN(value)) return null;
  let sawTimestamp = false;
  for (let index = 0; index < messages.length; index += 1) {
    const other = Date.parse(messages[index]?.timestamp ?? '');
    if (Number.isNaN(other)) continue;
    sawTimestamp = true;
    if (other > value) return index;
  }
  return sawTimestamp ? messages.length : null;
}

function buildExtraNode(document, extra, anchor) {
  const aside = document.createElement('aside');
  aside.className = 'extra-message';
  aside.dataset.kind = 'extra';
  aside.dataset.customType = extra.customType || 'extension';
  aside.dataset.anchor = anchor; // 摆在哪用的哪一档锚：落位不精确时（timestamp / end）一眼看得出来
  appendText(document, aside, 'extra-label', `扩展消息 · ${extra.customType || 'extension'}`);
  appendText(document, aside, 'extra-body', extra.text || textOf(extra.content));
  return aside;
}

/** 一张 `article.message-<role>` 块（用户 / 助手 / 其它消息）。`segment` 见 messageBody()。 */
function buildMessageArticle(document, item, index, ctx, segment = null) {
  const article = document.createElement('article');
  article.className = `message message-${item.role || 'unknown'}`;
  article.dataset.kind = 'message';
  article.dataset.role = item.role || 'unknown';
  // extras 的 parentId 就指向这里（工具结果那种不单独成节点，才需要靠下标兜）。
  if (item.entryId) article.dataset.entryId = item.entryId;
  article.style.containIntrinsicSize = `auto ${estimateMessageHeight(item)}px`;
  appendText(document, article, 'message-role', item.role || 'unknown');
  // 直播交接桥的落点：只有「这一轮直播之后的那条 assistant」才吃桥，别的条目一律走稳定键。
  const bridge = index === ctx.bridgeTargetIndex ? ctx.bridge : null;
  // 工具卡上的 diff / 图片要用的两份账（M-25 的 details 在 part 上，M-31 的图片在配对的 toolResult 上）。
  article.append(messageBody(document, item, {
    scope: ctx.scope,
    messageKey: messageKey(item, index, ctx.salt),
    // 卡片级反馈（annotations）的消息锚：messageId(=entryId) / 位置下标 / 角色。
    sessionId: ctx.sessionId,
    messageId: item.entryId ?? null,
    role: item.role ?? 'unknown',
    bridge,
    toolImages: ctx.toolImages,
    toolImageMeta: ctx.toolImageMeta,
  }, segment));
  // 卡片级反馈：用户/助手消息卡右下角的低调小按钮（notice / 压缩块 / 分支摘要**不上**，v1 边界）。
  // 分段时**只有第一段**带它 —— 同一条消息两个 messageId+blockIndex 相同的锚会撞在一起。
  if (!segment || segment.primary) {
    article.append(annotationControl(document, {
      kind: 'message',
      sessionId: ctx.sessionId,
      messageId: item.entryId ?? null,
      blockIndex: index,
      role: item.role ?? 'unknown',
    }));
  }
  if (item.errorMessage) appendText(document, article, 'message-error', item.errorMessage);
  return article;
}

/** 一个 tool part → **顶层** `section.tool-card`（不再嵌在 assistant 块里）。
 *  折叠键 / 直播键与旧实现**逐字相同**（`<messageKey>:<c:toolCallId>` / `c:<id>`），所以旧折叠态不丢。 */
function buildToolBlock(document, item, index, ctx, part, partIndex, toolOrdinal) {
  const toolKey = toolKeyOf(part, toolOrdinal);
  return toolCard(document, part, {
    scope: ctx.scope,
    stableKey: `${messageKey(item, index, ctx.salt)}:${toolKey}`,
    bridgeKey: toolKey,
    bridge: index === ctx.bridgeTargetIndex ? ctx.bridge : null,
    toolImages: ctx.toolImages,
    toolImageMeta: ctx.toolImageMeta,
    sessionId: ctx.sessionId,
    messageId: item.entryId ?? null,
    blockIndex: partIndex,
    role: item.role ?? 'assistant',
  });
}

/** 一条 assistant 消息 → 一组**顶层块**：连续的（非工具）part 合成 `article.message-assistant`，
 *  每个 tool part 单独成 `section.tool-card`。顺序 = parts 的**存储顺序逐字**（业主 2026-09-22 红线）。 */
function assistantBlocks(document, item, index, ctx) {
  const parts = Array.isArray(item.parts) ? item.parts : [];
  if (parts.length === 0) return [buildMessageArticle(document, item, index, ctx, null)];
  const { thinking, image } = partOrdinals(parts);
  const nodes = [];
  let run = null;
  let primary = true; // 第一段带标注按钮（分段时同一条消息只留一个锚）
  let toolOrdinal = 0;
  const flush = () => {
    if (!run) return;
    nodes.push(buildMessageArticle(document, item, index, ctx, { indices: run, thinkingOrdinal: thinking, imageOrdinal: image, primary }));
    primary = false;
    run = null;
  };
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    if (part?.type === 'tool') {
      flush();
      nodes.push(buildToolBlock(document, item, index, ctx, part, partIndex, toolOrdinal));
      toolOrdinal += 1;
    } else {
      if (!run) run = [];
      run.push(partIndex);
    }
  }
  flush();
  return nodes;
}

/** bash 块（用户发起的 `!` 命令）：与工具块**同名不同类** —— 自己的标题、槽色、默认折叠
 *  （默认**展开**，与工具块的「长输出默认折叠」相反），底盘与消息块同一家族。
 *  正文只用服务端的 `text`（唯一的诚实投影，缺字段有它自己那句话）：这里只把它拆成
 *  「命令行（标题）」+「其余（正文）」，不另写一套投影。 */
function bashCard(document, item, index, ctx) {
  const bash = item?.bash && typeof item.bash === 'object' ? item.bash : {};
  const card = document.createElement('section');
  card.className = 'bash-card';
  card.dataset.kind = 'bash';
  card.dataset.role = item.role || 'bashExecution';
  if (item.entryId) card.dataset.entryId = item.entryId;
  if (typeof bash.command === 'string') card.dataset.bashCommand = bash.command;
  appendText(document, card, 'message-role', 'bash · user');
  const head = document.createElement('div');
  head.className = 'bash-head';
  const command = document.createElement('strong');
  command.className = 'bash-command';
  const text = String(item.text ?? '');
  const cut = text.indexOf('\n');
  const first = cut === -1 ? text : text.slice(0, cut);
  const rest = cut === -1 ? '' : text.slice(cut + 1);
  const hasCommand = first.startsWith('$ ');
  command.textContent = hasCommand ? first : '（文件里没有命令行）';
  const body = document.createElement('div');
  body.className = 'message-body';
  const output = document.createElement('pre');
  output.className = 'bash-output';
  output.textContent = hasCommand ? rest : text;
  body.append(output);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'bash-toggle';
  toggle.dataset.bashToggle = 'true';
  // 折叠态按会话记住（稳定键 = 消息自己的 entryId）；与工具块共用同一套写回容器。
  const collapseCtx = { scope: ctx.scope, stableKey: messageKey(item, index, ctx.salt), bridgeKey: null, bridge: null };
  const view = { card, output: body, toggle };
  applyToolState(view, resolveCollapse(collapseCtx, false));
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = card.dataset.collapsed !== 'true';
    applyToolState(view, next);
    persistCollapse(collapseCtx, next);
  });
  head.append(command, toggle);
  card.append(head, body);
  card.append(annotationControl(document, {
    kind: 'message',
    sessionId: ctx.sessionId,
    messageId: item.entryId ?? null,
    blockIndex: index,
    role: item.role ?? 'bashExecution',
  }));
  return card;
}

// 一批正文（[from, to)）：压缩块、extras、正文节点按边界位**交错**产出。
// 区间约定：本批只认 boundary ∈ [from, to)；boundary === messages.length 由**最后一批**（isLast）收尾。
function buildMessageNodes(document, payload, plan, from, to, isLast, ctx) {
  const nodes = [];
  const messages = payload.messages || [];
  const byBoundary = new Map();
  const tail = [];
  for (const item of plan) {
    if (item.boundary < from) continue;
    if (item.boundary >= to) {
      // 边界正好落在 `messages.length`（回落 / 时间上比所有正文都晚）的，跟着**最后一批**收尾；
      // 分片批次（isLast=false）不收，否则会被下一批重复画一次。
      if (isLast && item.boundary === messages.length) tail.push(item);
      continue;
    }
    const list = byBoundary.get(item.boundary);
    if (list) list.push(item);
    else byBoundary.set(item.boundary, [item]);
  }
  // 边界块（压缩 / 分支摘要）：与 extras 一样按 atIndex 落位。落在本批区间外的，只有
  // 「atIndex ≥ 正文条数」或「负数」这种越界值才在**最后一批**收尾（压缩边界旧语义不变）；
  // `[to, messages.length)` 里的留给后面那一批（分片批次不许重复画）。
  const notesByIndex = new Map();
  const tailNotes = [];
  for (const item of boundaryNotes(payload)) {
    if (item.atIndex >= from && item.atIndex < to) {
      const list = notesByIndex.get(item.atIndex);
      if (list) list.push(item);
      else notesByIndex.set(item.atIndex, [item]);
    } else if (isLast && (item.atIndex >= messages.length || item.atIndex < 0)) tailNotes.push(item);
  }
  for (let index = from; index < to; index += 1) {
    // 边界块排在它之后的那条正文**之前**；父是压缩块的 extra 因此落在块之后。
    for (const item of notesByIndex.get(index) ?? []) nodes.push(item.build(document));
    for (const item of byBoundary.get(index) ?? []) nodes.push(buildExtraNode(document, item.extra, item.anchor));
    const item = messages[index];
    if (item.role === 'toolResult' || item.role === 'tool') continue;
    // 平铺（业主 2026-09-22）：bashExecution 单独成 bash 块；assistant 的 tool part 单独成顶层工具块。
    if (item.kind === 'bashExecution' || item.role === 'bashExecution') {
      nodes.push(bashCard(document, item, index, ctx));
      continue;
    }
    if (item.role === 'assistant' && Array.isArray(item.parts) && item.parts.length > 0) {
      for (const node of assistantBlocks(document, item, index, ctx)) nodes.push(node);
      continue;
    }
    nodes.push(buildMessageArticle(document, item, index, ctx, null));
  }
  if (isLast) {
    // 边界 = 末尾（回落 / 时间上比所有正文都晚）的 extra：留在最后，保持 `extras` 数组顺序。
    for (const item of tail) nodes.push(buildExtraNode(document, item.extra, item.anchor));
    // 边界块落在正文列表之外（负数 / 超过条数）时，按原语义补在正文末尾。
    for (const item of tailNotes) nodes.push(item.build(document));
  }
  return nodes;
}

function scheduleIdle(callback) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: 120 });
  else setTimeout(callback, 4);
}

export function renderMessages(container, payload, options = {}) {
  const document = container.ownerDocument;
  const messages = payload.messages || [];
  // 折叠态容器的作用域 = 会话。优先用载荷自己的 `sessionId`（服务端 messageWire 一定带），
  // 没有才用调用方显式给的 `options.scope`（app.js 换会话时传），最后才回落 'default'。
  // ⚠️ 不回落「上一次的 scope」：那会把上一个会话的折叠态串到这一个会话上。
  const scope = payload.sessionId ? String(payload.sessionId) : (typeof options.scope === 'string' && options.scope ? options.scope : 'default');
  container.dataset.collapseScope = scope;
  const ctx = messageContext(payload, scope);

  if (!options.progressive) {
    // 旧路径逐字保留：所有节点同步构建。小会话行为不变，s1a2-api 契约门也依赖它。
    // （extras 现在按锚插在正文流里，不再统一堆到末尾 —— 见 extraBoundaries 的说明。）
    nextRenderToken(container);
    container.replaceChildren();
    const plan = extraBoundaries(payload);
    for (const node of buildMessageNodes(document, payload, plan, 0, messages.length, true, ctx)) container.append(node);
    container.dataset.virtual = 'false';
    container.dataset.renderComplete = 'true';
    return;
  }

  const token = nextRenderToken(container);
  const tailSize = typeof options.tailSize === 'number' ? options.tailSize : RENDER_TAIL;
  const sliceSize = typeof options.sliceSize === 'number' ? options.sliceSize : RENDER_SLICE;
  const budgetMs = typeof options.budgetMs === 'number' ? options.budgetMs : RENDER_SLICE_BUDGET_MS;
  const tailStart = Math.max(0, messages.length - tailSize);

  const plan = extraBoundaries(payload);
  const tailNodes = buildMessageNodes(document, payload, plan, tailStart, messages.length, true, ctx);
  // ⚠️ 尾批（最后一屏 `RENDER_TAIL` 条）**永远按真实高度排**：`#messages[data-virtual="true"] .message`
  //    那条 content-visibility:auto 规则配上 `contain-intrinsic-size` 的**估计**高度，在真规模数据上会
  //    偏得很远（长正文/长工具结果）；滚到底那一刻浏览器才量到真实高度，scrollHeight 突然长出一截，
  //    接着空闲期补旧消息 + 贴底就把读者按多出来的那截往下拽（真数据实测 243–1369px，随测量时机抖动）。
  //    行内 `content-visibility:visible` 盖过那条惰性规则，让尾批从第一帧起就是真高 —— 成本只是这一屏，
  //    “屏幕外旧消息用估计高度”这个优化一字未动（那些节点靠下面的 `data-virtual` 开关保留）。
  for (const node of tailNodes) {
    node.style.contentVisibility = 'visible';
    // 工具卡自己也有一条 `#messages[data-virtual="true"] .tool-card { content-visibility:auto; … }`
    // （直播工具卡那一条 landing 加的）—— 只给外层 message 写 visible 盖不住它；长工具结果会在尾批里
    // 先按 260px 占位、随后被量成真高，同样把贴底那一刻的底推掉（实测再涨 6374px）。
    for (const card of node.querySelectorAll('.tool-card')) card.style.contentVisibility = 'visible';
  }
  container.replaceChildren(...tailNodes);
  container.dataset.messageTotal = String(messages.length);
  container.dataset.virtual = 'false';
  container.dataset.renderComplete = tailStart === 0 ? 'true' : 'false';
  if (tailStart === 0) {
    options.onComplete?.();
    return;
  }

  // 更早的正文先在**文档外**建好（不在文档里 ⇒ 不触发布局），建完一次性插到正文顶部。
  // 这一点是关键：如果边 prepend 边读 scrollHeight，每次插入都强制一次全量布局，
  // 成本随已渲染条数增长 ⇒ 总成本 O(n²)、长任务越跑越大。文档外建、最后插一次，布局只跑一遍。
  const staging = document.createElement('div');
  let cursor = 0;
  const flush = () => {
    if (renderTokens.get(container) !== token) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 8;
    const pinBottom = options.pinBottom === true || nearBottom;
    const before = container.scrollHeight;
    container.prepend(...staging.children);
    if (pinBottom) container.scrollTop = container.scrollHeight;
    else {
      // 把插入的旧内容高度补回去：正在读的人视线里的那一段不跳。
      const delta = container.scrollHeight - before;
      if (delta) container.scrollTop += delta;
    }
    container.dataset.renderComplete = 'true';
    options.onComplete?.();
  };
  const step = () => {
    if (renderTokens.get(container) !== token) return; // 已被切会话/重画作废
    // 补旧消息这一路才开惰性布局（尾批已经按真实高度排完了）。
    container.dataset.virtual = 'true';
    const started = performance.now();
    while (cursor < tailStart) {
      const to = Math.min(tailStart, cursor + sliceSize);
      for (const node of buildMessageNodes(document, payload, plan, cursor, to, false, ctx)) staging.append(node);
      cursor = to;
      if (performance.now() - started >= budgetMs) break;
    }
    if (cursor < tailStart) { scheduleIdle(step); return; }
    flush();
  };
  scheduleIdle(step);
}

/** 尾部增量渲染：只建 `[from, messages.length)` 那一段的新节点，**原地 append**（不 replaceChildren）。
 *
 *  为什么要有它：大会话每回合末都要重拉一次正文，而「整块重画」比这次拉取本身还贵 ——
 *  门里真夹具（2549 条 / 29.5 MiB）同一份载荷、同一轮测到：整份那条路 `added=1568 / removed=1567`、
 *  结算 936–981 ms；增量这条 `added=1 / removed=0`、结算 67–173 ms（`npm run test:bigrefetch`）。
 *  这不是另一条渲染路：节点仍由同一个 `buildMessageNodes` 按 [from, to) 区间产出，只是把区间选在末尾、
 *  把节点 append 在末尾。
 *
 *  调用方（`web/app.js` 的 tailMerge/appended 分支）负责证明「手上那份正文就是这一版的严格前缀」
 *  （游标是它的最后一条、已定稿、下标对得上，且容器已 `renderComplete`）。这里只负责**落位**那一半：
 *  · `previousExtras` = 上一版已经画过的那些（按 entryId 认）—— 它们的落位必须仍在已画好的
 *    前缀里（`boundary <= from`），否则说明它们现在应该排在增量区里而旧位置已经不对了；
 *  · 这一版**新**的 extra 必须落在增量区里（`boundary >= from`），否则要插回正文中间。
 *  任一条不满足就返回 false（**一个节点都不会碰**），调用方拿拼好的整份重画一次（不是重拉）。
 *
 *  `options.before`（可选）=「插到它**之前**」的那一个子节点，调用方（`web/app.js`）拿它传
 *  **活跃的直播块**（`.live-message`）。为什么需要它：直播块是**一个持久节点**，它的内容永远画在
 *  已落盘正文的**后面**（历史只接逐字相同的前缀、直播只画还没接管的尾巴）。于是这一版新来的
 *  正文/扩展块在说话顺序上都排在直播块**之前** —— 一律 `append` 就会把它们排到直播块**后面**，
 *  屏幕上就变成「助手的流式块跑到我那条消息上面」（业主 2026-09-20 报的现象；
 *  `web/app.js:refreshMessagesOnce` 那一条尾部增量路走的就是这里）。
 *  传进来的锚不是本容器的子节点（比如刚被 `replaceChildren` 摘掉）时按没有锚处理 —— 退化成 append。
 *
 *  返回 true ⇔ 节点已落位、容器元数据已跟上。 */
export function appendMessageNodes(container, payload, from, previousExtras = [], options = {}) {
  const document = container.ownerDocument;
  const messages = payload.messages || [];
  if (!Number.isInteger(from) || from < 1 || from > messages.length) return false;
  const scope = container.dataset.collapseScope || 'default';
  const previousIds = new Set(previousExtras.map((extra) => extra?.entryId));
  const old = [];
  const fresh = [];
  for (const item of extraBoundaries(payload)) {
    if (item.extra.entryId && previousIds.has(item.extra.entryId)) old.push(item);
    else fresh.push(item);
  }
  for (const item of old) if (item.boundary > from) return false;
  for (const item of fresh) if (item.boundary < from) return false;
  const ctx = messageContext(payload, scope);
  const nodes = buildMessageNodes(document, payload, fresh, from, messages.length, true, ctx);
  // 尾批的可见性处理（与 renderMessages 的渐进路一致）：新增的这几条在屏幕最下方，按真高排，
  // 不交给 content-visibility 估高。
  for (const node of nodes) {
    node.style.contentVisibility = 'visible';
    for (const card of node.querySelectorAll('.tool-card')) card.style.contentVisibility = 'visible';
  }
  const anchor = options.before && options.before.parentNode === container ? options.before : null;
  if (anchor) for (const node of nodes) container.insertBefore(node, anchor);
  else container.append(...nodes);
  container.dataset.messageTotal = String(messages.length);
  container.dataset.renderComplete = 'true';
  return true;
}

const TITLE_SOURCE_LABELS = {
  seed: '第一句话种的（还没人改过）',
  auto: '模型自己起的',
  manual: '用户自己设的（模型不许覆盖）',
};

function formatTreeTime(session) {
  const value = session.lastActivity ?? session.modifiedAt ?? session.settledAt;
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const two = (number) => String(number).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

// M-18（排序模式）：树的**兄弟顺序**按 `sortMode` 排。树本身始终是「树」（TUI 的 threaded 语义），
// 所以这里的三个模式排的是同一棵树的兄弟顺序，而不是把树压平：
//   recent  —— 最近活动在前（旧行为，默认）；oldest —— 最早在前；name —— 按显示名，**无名者排最后**。
// 名称模式下同名的（以及都无名的）用「最近活动在前」兜底，保证顺序稳定、不留未定义态。
// 认不出的模式当作默认 `recent` 处理（不抛错、不空白）。
const TREE_SORT_MODES = ['recent', 'oldest', 'name'];
export function normalizeTreeSortMode(mode) {
  return TREE_SORT_MODES.includes(mode) ? mode : 'recent';
}

function treeSiblingComparator(sortMode, activity) {
  const mode = normalizeTreeSortMode(sortMode);
  if (mode === 'oldest') return (left, right) => activity(left) - activity(right);
  if (mode === 'name') {
    // 有名字的按显示名排（大小写不敏感）；没名字的排到最后（它们没有「名字」可比），同名前/无名字的再按最近活动在前。
    return (left, right) => {
      const leftName = (typeof left.name === 'string' ? left.name : '').trim().toLowerCase();
      const rightName = (typeof right.name === 'string' ? right.name : '').trim().toLowerCase();
      if (leftName === '' || rightName === '') {
        if (leftName === '' && rightName !== '') return 1;
        if (leftName !== '' && rightName === '') return -1;
      } else if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
      }
      return activity(right) - activity(left);
    };
  }
  return (left, right) => activity(right) - activity(left);
}

export function renderTree(container, sessions, onSelect, {
  expanded = new Set(),
  collapsed = new Set(),
  atticOpen = false,
  selectedId = null,
  knownIds = null,
  sortMode = 'recent',
  emptyText = '还没有会话。',
  onFoldToggle = () => {},
  onAtticToggle = () => {},
} = {}) {
  sortMode = normalizeTreeSortMode(sortMode);
  const document = container.ownerDocument;
  const scrollPositions = {
    active: container.querySelector('[data-active-tree-list="true"]')?.scrollTop,
    attic: container.querySelector('[data-attic-list="true"]')?.scrollTop,
  };
  const restoreScrollPositions = () => {
    const active = container.querySelector('[data-active-tree-list="true"]');
    const attic = container.querySelector('[data-attic-list="true"]');
    if (active && scrollPositions.active !== undefined) active.scrollTop = scrollPositions.active;
    if (attic && scrollPositions.attic !== undefined) attic.scrollTop = scrollPositions.attic;
  };
  container.replaceChildren();
  container.dataset.atticOpen = String(atticOpen);
  const activeList = document.createElement('div');
  activeList.className = 'active-tree-list';
  activeList.dataset.activeTreeList = 'true';
  container.append(activeList);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // 折叠状态按「全部已知会话 id」剪枝，而不是按当前（可能被 M-18 过滤过的）列表，
  // 否则一次搜索就会把被隐藏会话的折叠状态删掉。
  const prunable = knownIds instanceof Set ? knownIds : new Set(sessions.map((session) => session.id));
  for (const state of [expanded, collapsed]) {
    for (const id of state) if (!prunable.has(id)) state.delete(id);
  }
  const children = new Map(sessions.map((session) => [session.id, []]));
  const roots = [];
  for (const session of sessions) {
    const parent = session.parentId ? byId.get(session.parentId) : null;
    if (parent && parent !== session) children.get(parent.id).push(session);
    else roots.push(session);
  }
  const activity = (session) => {
    const value = session.lastActivity ?? session.modifiedAt ?? session.settledAt;
    if (typeof value === 'number') return value;
    return typeof value === 'string' ? Date.parse(value) || 0 : 0;
  };
  const compareSiblings = treeSiblingComparator(sortMode, activity);
  roots.sort(compareSiblings);
  for (const siblings of children.values()) siblings.sort(compareSiblings);

  const said = (session) => expanded.has(session.id) ? true : collapsed.has(session.id) ? false : undefined;
  const effective = new Map();
  const computeEffective = (session, inherited) => {
    const open = said(session) ?? (session.archived ? inherited : false);
    effective.set(session.id, open);
    for (const child of children.get(session.id) || []) computeEffective(child, open);
  };
  for (const root of roots) computeEffective(root, false);

  const counts = new Map();
  const foldCount = (session) => {
    if (counts.has(session.id)) return counts.get(session.id);
    let count = 0;
    for (const child of children.get(session.id) || []) {
      if (!child.archived) continue;
      count += 1 + (said(child) === false ? 0 : foldCount(child));
    }
    counts.set(session.id, count);
    return count;
  };
  for (const root of roots) foldCount(root);

  function appendSession(parent, session, depth, archivedBranch) {
    const row = document.createElement('div');
    const count = foldCount(session);
    // 选中行的视觉高亮只由 .tree-session.selected 的 background+color 表达（v2.2 禁 box-shadow/
    // gradient，槽位留给状态）；aria-current 是给读屏和断言用的语义钩子，不承担视觉。
    const isSelected = session.id === selectedId;
    row.className = `tree-session status-${session.status}${count ? ' has-fold' : ''}${session.archived ? ' archived' : ''}${session.unread && !archivedBranch ? ' unread' : ''}${isSelected ? ' selected' : ''}`;
    row.dataset.sessionId = session.id;
    if (isSelected) row.setAttribute('aria-current', 'true');
    row.dataset.depth = String(depth);
    row.dataset.archived = String(session.archived === true);
    const notifyCount = (session.notify?.notifies || []).length;
    const waitingCount = (session.notify?.waitingFor || []).length;
    row.dataset.notify = notifyCount ? String(notifyCount) : '';
    row.dataset.waiting = waitingCount ? String(waitingCount) : '';
    row.style.marginInlineStart = `${Math.min(depth, 6) * .65}rem`;
    const notifyParts = [];
    if (notifyCount > 0) notifyParts.push(`将通知 ${notifyCount} 个会话`);
    if (waitingCount > 0) notifyParts.push(`等待 ${waitingCount} 个子会话`);
    // I-56：会话行只有一个槽位，在跑优先于未读（`web/slot.css` 的 `.tree-session.status-*`）。
    // 两个状态同时为真时槽显示「在跑」，未读只剩文字亮度 —— tooltip 是唯一能把两者同时说清的
    // 地方，所以这一种情况明写出来，不然读者会以为未读记号丢了。
    const statusText = [session.statusLabel || session.status, session.unread ? (session.status === 'working' ? '未读（此刻槽位显示在跑）' : '未读') : null, ...notifyParts].filter(Boolean).join(' · ');
    row.title = `${session.name || '（无标题）'}\n${session.id}${session.cwd ? `\n${session.cwd}` : ''}${session.archived ? '\n（已存档 —— 发消息就会复活）' : ''}${session.titleSource ? `\n（标题：${TITLE_SOURCE_LABELS[session.titleSource] || session.titleSource}）` : ''}${statusText ? `\n（状态：${statusText}）` : ''}`;
    row.addEventListener('click', () => onSelect(session.id));

    const open = effective.get(session.id) ?? false;
    if (count) {
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.className = `fold-toggle${open ? ' open' : ''}`;
      fold.dataset.foldId = session.id;
      fold.textContent = `${open ? '▾' : '▸'}${count}`;
      fold.title = open ? '收起这一支' : `这一支藏了 ${count} 个已存档的会话`;
      fold.setAttribute('aria-expanded', String(open));
      fold.addEventListener('click', (event) => {
        event.stopPropagation();
        onFoldToggle(session.id, open);
      });
      row.append(fold);
    }

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tree-select';
    // v2.2 的可见状态记号是行左那条 3px 槽（色由 status 决定，槽位常占、宽度不随状态变），
    // 这个圆点在 v2.2 里**故意不可见**（`slot.css` 的 `.status-dot{display:none}`）——
    // 它保留在 DOM 里是并行渲染契约（`test/s1a2-unread.mjs` / `test/s1a2-slot.mjs` 都断言
    // 它的 computed display 是 `none`），**不要**为了让「在跑」另起一个记号而把它显示出来：
    // 那是新增视觉要素、且会让行宽随状态变化（I-56 的裁定是：一个槽位、在跑优先于未读）。
    const dot = document.createElement('span');
    dot.className = `status-dot${session.unread && !archivedBranch ? ' unread-dot' : ''}`;
    dot.ariaHidden = 'true';
    select.append(dot);
    const label = document.createElement('span');
    label.className = 'tree-label';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = session.name || session.id;
    label.append(name);
    if (notifyCount > 0) {
      const notify = document.createElement('span');
      notify.className = 'tree-delegation tree-notify';
      notify.textContent = `⇢${notifyCount}`;
      label.append(notify);
    }
    if (waitingCount > 0) {
      const waiting = document.createElement('span');
      waiting.className = 'tree-delegation tree-waiting';
      waiting.textContent = `⋯${waitingCount}`;
      label.append(waiting);
    }
    select.append(label);
    const timestamp = formatTreeTime(session);
    if (timestamp) {
      const time = document.createElement('time');
      time.className = 'tree-time';
      time.textContent = timestamp;
      time.dateTime = new Date(session.lastActivity ?? session.modifiedAt ?? session.settledAt).toISOString();
      select.append(time);
    }
    row.append(select);
    parent.append(row);
  }

  const walk = (parent, session, depth, inherited, allowArchivedRoot = false, archivedBranch = false) => {
    if (session.archived && !inherited && !allowArchivedRoot) return;
    const open = effective.get(session.id) ?? false;
    const inArchivedBranch = archivedBranch || session.archived;
    appendSession(parent, session, depth, inArchivedBranch);
    for (const child of children.get(session.id) || []) walk(parent, child, depth + 1, open, false, inArchivedBranch);
  };

  for (const root of roots) walk(activeList, root, 0, false, false, false);
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tree-empty';
    empty.textContent = emptyText;
    activeList.append(empty);
  }

  const archivedRoots = roots.filter((session) => session.archived);
  if (archivedRoots.length === 0) {
    restoreScrollPositions();
    return;
  }
  const attic = document.createElement('section');
  attic.className = 'attic';
  attic.dataset.attic = 'true';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'attic-toggle';
  toggle.dataset.atticToggle = 'true';
  toggle.setAttribute('aria-expanded', String(atticOpen));
  toggle.title = atticOpen ? `收起底部的 ${archivedRoots.length} 个顶层存档会话` : `顶层有 ${archivedRoots.length} 个已归档的会话 —— 点开，就在这条按钮下面铺开`;
  toggle.textContent = `存档 ${atticOpen ? '▾' : '▸'} ${archivedRoots.length}`;
  toggle.addEventListener('click', onAtticToggle);
  attic.append(toggle);
  if (atticOpen) {
    const list = document.createElement('div');
    list.className = 'attic-list';
    list.dataset.atticList = 'true';
    const heading = document.createElement('div');
    heading.className = 'attic-heading';
    heading.textContent = `存档箱 · 顶层 ${archivedRoots.length} 个（不在上面的树里）`;
    list.append(heading);
    for (const root of archivedRoots) walk(list, root, 0, false, true, true);
    attic.append(list);
  }
  container.append(attic);
  restoreScrollPositions();
}

// ── Manager toolkit P1：问题页（`docs/plans/manager-toolkit-plan.md` §5）───────────────────────────
// 只负责画 `#questions-list` 里的节点；工具栏（未答 / 已答·已关 两个页签 + 刷新）与那条 notice 行
// 是 index.html 里的静态节点，由 app.js 直接接线。动作按钮一律只挂 `data-action` 数据属性
// （点击/回车由 app.js 的**一个**委托监听处理）—— 这里不挂任何监听器，重画不会泄漏。
//
// ⚠️ 条目字段名：契约只钉了**写入**形状（§3 的请求体）与 `custom` 条目的落盘形状（§1），
// 没钉 `GET questions` 的响应条目字段。所以 app.js 先归一化（见 normalizeQuestion），这里拿到的是
// 归一化后的 {id,status,text,options,priority,at,by,answer,closeReason,answeredAt,closedAt}。
const QUESTION_BY_LABELS = { user: '用户', agent: 'agent' };

function formatQuestionTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const two = (number) => String(number).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 已答/已关的留痕行：谁在什么时候做的（业主点名要可见）。
 *  真实服务端把「问的账」与「这次状态变更的账」分得很清（`askedAt/askedBy` vs `answeredAt/answerBy`、
 *  `closedAt/closedBy`）——时间与「谁」都按状态取对应的那笔，拿不到才回落 `at/by`。 */
function questionTrailText(entry) {
  const state = entry.status === 'closed' ? 'closed' : 'answered';
  const when = formatQuestionTime((state === 'closed' ? entry.closedAt : entry.answeredAt) ?? entry.at);
  const who = (state === 'closed' ? entry.closedBy : entry.answerBy) ?? entry.by;
  const stateLabel = state === 'closed' ? '已关（不答）' : '已答';
  return [stateLabel, QUESTION_BY_LABELS[who] ?? who ?? '未知', when].filter(Boolean).join(' · ');
}

/** 「这条被更新过」的留痕行（业主 2026-09-21 定的契约：更新 ≠ 新开，要在条目上看得出）。
 *  与「问于 …」同风格（同一套时间格式与 by 标签），只在真的更新过（`updatedAt` 有值）时才画 ——
 *  没更新过就不画这一行，绝不编一个「未更新」的占位。`updatedBy` 拿不到就只写时间。 */
function questionUpdatedText(entry) {
  const when = formatQuestionTime(entry.updatedAt);
  if (!when) return '';
  const who = entry.updatedBy ? (QUESTION_BY_LABELS[entry.updatedBy] ?? entry.updatedBy) : null;
  return `更新于 ${when}${who ? ` · ${who}` : ''}`;
}

export function renderQuestions(container, {
  status = 'open',
  load = 'idle',
  error = null,
  entries = [],
  drafts = new Map(),
  closeConfirm = null,
  closeReason = '',
  submitting = null,
} = {}) {
  const document = container.ownerDocument;
  container.replaceChildren();
  container.dataset.status = status;
  container.dataset.load = load;
  container.dataset.count = String(entries.length);

  const note = (text) => {
    const node = document.createElement('p');
    node.className = 'question-empty';
    node.textContent = text;
    container.append(node);
    return node;
  };

  // 空态/降级态都**说实话**：读不到就说读不到，绝不用「没有待确认的问题」冒充「问不到」。
  if (load === 'unsupported') {
    note('这个服务端还没有问题清单接口（GET /sessions/{id}/questions 不存在）—— 这不是「没有问题」，是这次问不到。');
    return;
  }
  if (load === 'error') {
    const box = document.createElement('div');
    box.className = 'question-empty';
    const line = document.createElement('p');
    line.textContent = `问题清单读失败：${error || '服务端没给原因'}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.action = 'refresh';
    retry.textContent = '重试';
    box.append(line, retry);
    container.append(box);
    return;
  }
  if (entries.length === 0 && load !== 'ready') {
    note('正在读取问题…');
    return;
  }
  if (entries.length === 0) {
    const box = document.createElement('div');
    box.className = 'question-empty';
    if (status === 'open') {
      const line = document.createElement('p');
      line.textContent = '没有待确认的问题。';
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.dataset.action = 'show-answered';
      switchButton.textContent = '看已答/已关';
      box.append(line, switchButton);
    } else {
      const line = document.createElement('p');
      line.textContent = '还没有已答或已关的问题。';
      box.append(line);
    }
    container.append(box);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('article');
    item.className = 'question-item';
    item.dataset.questionId = entry.id;
    item.dataset.status = entry.status;
    item.dataset.priority = entry.priority === 'high' ? 'high' : 'normal';
    const busy = submitting === entry.id;
    if (busy) item.dataset.busy = 'true';

    // 上下文事实（「背景」）—— 在**题面之上**画。业主 dogfood 后拍板：问题必须自带判断所需的事
    // 实，界面渲染只是**兜底展示**。老条目（工具还没要求 `context` 的时代）没有这个字段 ——
    // 如实说一句，**不许留空、不许编**（沿用 `.question-empty` 那套诚实口径）。
    // 多行原样（靠 CSS `white-space: pre-wrap`）；不折行、不截断、不吐 thinking。
    const contextText = typeof entry.context === 'string' && entry.context.trim() !== '' ? entry.context : null;
    const contextBlock = document.createElement('div');
    contextBlock.className = 'question-context';
    const contextLabel = document.createElement('span');
    contextLabel.className = 'question-context-label';
    contextLabel.textContent = '背景';
    const contextBody = document.createElement('div');
    contextBody.className = contextText ? 'question-context-body' : 'question-context-body question-context-none';
    contextBody.textContent = contextText ?? '这条问题没有自带背景（当时的工具还没要求）。';
    contextBlock.append(contextLabel, contextBody);
    item.append(contextBlock);

    const head = document.createElement('div');
    head.className = 'question-head';
    if (entry.priority === 'high') {
      const badge = document.createElement('span');
      badge.className = 'question-priority';
      badge.textContent = '高';
      badge.title = '优先级：高';
      head.append(badge);
    }
    const text = document.createElement('div');
    text.className = 'question-text';
    text.textContent = entry.text || '（这条问题没有正文）';
    head.append(text);
    item.append(head);

    const asked = formatQuestionTime(entry.askedAt ?? entry.at);
    const meta = document.createElement('div');
    meta.className = 'question-meta';
    // 「谁问的」只在**未答**上有意义：已答/已关那一行的 `by` 是「谁做的这次状态变更」，
    // 写进「问于 … ·」里就变成假事实（留痕行已经说了谁/何时）。服务端若把 `askedBy` 与 `by`
    // 分开给（真实服务端就是），这里用 `askedBy`；拿不到就不写。
    const asker = entry.askedBy ?? (entry.status === 'open' ? entry.by : null);
    meta.textContent = `问于 ${asked || '时间未知'}${asker ? ` · ${QUESTION_BY_LABELS[asker] ?? asker}` : ''}`;
    item.append(meta);
    // 「更新于 …」（与「问于 …」同风格）：这条被就地改过题面/背景/候选/优先级时留痕。
    const updatedText = questionUpdatedText(entry);
    if (updatedText) {
      const updated = document.createElement('div');
      updated.className = 'question-meta question-updated';
      updated.textContent = updatedText;
      item.append(updated);
    }

    if (entry.status === 'open') {
      if (Array.isArray(entry.options) && entry.options.length > 0) {
        const options = document.createElement('div');
        options.className = 'question-options';
        for (const option of entry.options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.action = 'option';
          button.dataset.value = String(option);
          button.textContent = String(option);
          button.disabled = busy;
          button.title = `按这个候选回答：${String(option)}`;
          options.append(button);
        }
        item.append(options);
      }
      const row = document.createElement('div');
      row.className = 'question-answer-row';
      // 手动回答框 = **多行控件**（业主 2026-10-05：「手动回答的框无法通过 shift+enter 换行」）：
      // 单行 `<input type="text">` 里 `\n` 无处可去（浏览器根本不往单行框里插换行）⇒「Shift+Enter 换行」
      // 的最小必要改动就是把控件形状换成 `<textarea>`。框高随内容长高（上限 5 行，到顶转框内滚动）——
      // 规则与「关闭原因」框**同源一处**（`autoGrowField`，见 `web/app.js`；高度上限就是 `web/index.html`
      // 那条 `max-height`）。
      const input = document.createElement('textarea');
      input.rows = 1;
      input.dataset.field = 'answer';
      input.placeholder = '答一句…（Enter 或点「答」；Shift+Enter 换行）';
      input.value = drafts.get(entry.id) ?? '';
      input.disabled = busy;
      input.setAttribute('aria-label', `回答：${entry.text || entry.id}`);
      const answer = document.createElement('button');
      answer.type = 'button';
      answer.dataset.action = 'answer';
      answer.textContent = busy ? '提交中…' : '答';
      answer.disabled = busy;
      const close = document.createElement('button');
      close.type = 'button';
      close.dataset.action = 'close';
      close.textContent = '关闭（不答）';
      close.disabled = busy;
      row.append(input, answer, close);
      item.append(row);
      if (closeConfirm === entry.id) {
        const confirmRow = document.createElement('div');
        confirmRow.className = 'question-close-row';
        // 「关闭原因」框 = 多行控件（业主 2026-10-06：「关闭原因」框也修成 Shift+Enter 换行）：
        // 与回答框**同一套口径** —— 同一个 `data-field` 守卫（`MULTILINE_FIELDS`）与同一段
        // `autoGrowField`；Enter 仍然提交这次关闭（与改前一字不动），Shift+Enter 才换行。
        const reason = document.createElement('textarea');
        reason.rows = 1;
        reason.dataset.field = 'close-reason';
        reason.placeholder = '关闭原因（可空；会留痕）';
        reason.value = closeReason ?? '';
        reason.disabled = busy;
        reason.setAttribute('aria-label', '关闭原因');
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.dataset.action = 'close-confirm';
        yes.textContent = '确认关闭';
        yes.disabled = busy;
        const no = document.createElement('button');
        no.type = 'button';
        no.dataset.action = 'close-cancel';
        no.textContent = '取消';
        no.disabled = busy;
        confirmRow.append(reason, yes, no);
        item.append(confirmRow);
      }
    } else {
      const trail = document.createElement('div');
      trail.className = 'question-trail';
      trail.textContent = questionTrailText(entry);
      item.append(trail);
      if (entry.status === 'answered' && entry.answer) {
        const answer = document.createElement('div');
        answer.className = 'question-trail';
        answer.textContent = `回答：${entry.answer}`;
        item.append(answer);
      }
      if (entry.status === 'closed' && entry.closeReason) {
        const reason = document.createElement('div');
        reason.className = 'question-trail';
        reason.textContent = `原因：${entry.closeReason}`;
        item.append(reason);
      }
    }
    container.append(item);
  }
}

// ── 卡片级反馈的**只读列表**（`GET /annotations`；与问题看板同级入口，`docs/history/design-annotations.md` §1/§3）──
// v1.5：`state` 由服务端折好的事件定（`open` 未处理 / `done` 已处理），已处理的行如实带出**谁/何时**标的；
// 这个页签仍然**只读**（resolve 由维护线走端点/文件，见 `docs/ops/handoff.md`）—— 页上不摆“标记已处理”的按钮。
const ANNOTATION_KIND_LABELS = { message: '消息卡', toolResult: '工具结果卡' };
const ANNOTATION_STATE_LABELS = { open: '未处理', done: '已处理' };

function formatAnnotationTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN');
}

export function renderAnnotations(container, { load = 'idle', error = null, items = [] } = {}) {
  const document = container.ownerDocument;
  container.replaceChildren();
  container.dataset.load = load;
  container.dataset.count = String(items.length);

  const note = (text) => {
    const node = document.createElement('p');
    node.className = 'annotation-empty';
    node.textContent = text;
    container.append(node);
    return node;
  };

  if (load === 'unsupported') {
    note('这个服务端还没有标注清单接口（GET /annotations 不存在）—— 这不是「没有反馈」，是这次问不到。');
    return;
  }
  if (load === 'error') {
    const box = document.createElement('div');
    box.className = 'annotation-empty';
    const line = document.createElement('p');
    line.textContent = `标注清单读失败：${error || '服务端没给原因'}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.annotateAction = 'refresh';
    retry.textContent = '重试';
    box.append(line, retry);
    container.append(box);
    return;
  }
  if (load !== 'ready') {
    note('正在读取标注…');
    return;
  }
  if (items.length === 0) {
    note('还没有任何卡片反馈。把鼠标移到正文里的一张卡片上，点右下角的 ✎ 就能写一条。');
    return;
  }

  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'annotation-item';
    row.dataset.annotationId = item.id ?? '';
    row.dataset.annotationKind = item.kind ?? '';
    row.dataset.annotationState = item.state ?? 'open';

    const head = document.createElement('div');
    head.className = 'annotation-head';
    const kind = document.createElement('span');
    kind.className = 'annotation-kind';
    kind.textContent = ANNOTATION_KIND_LABELS[item.kind] ?? item.kind ?? '类型未知';
    const state = document.createElement('span');
    state.className = 'annotation-state';
    state.dataset.state = item.state ?? 'open';
    state.textContent = ANNOTATION_STATE_LABELS[item.state] ?? (item.state || 'open');
    const session = document.createElement('span');
    session.className = 'annotation-session';
    session.textContent = item.sessionId ? String(item.sessionId).slice(0, 8) : '会话未知';
    if (item.sessionId) session.title = item.sessionId;
    const when = document.createElement('span');
    when.className = 'annotation-time';
    when.textContent = formatAnnotationTime(item.at);
    head.append(kind, state, session, when);

    const body = document.createElement('div');
    body.className = 'annotation-note';
    body.textContent = item.note || '（这条没有正文）';
    row.append(head, body);

    if (item.excerpt) {
      const excerpt = document.createElement('div');
      excerpt.className = 'annotation-excerpt';
      excerpt.textContent = item.excerpt;
      row.append(excerpt);
    }
    if (item.state === 'done') {
      const resolved = document.createElement('div');
      resolved.className = 'annotation-resolved';
      resolved.textContent = `已处理：由 ${item.resolvedBy || '未记名'} 于 ${formatAnnotationTime(item.resolvedAt)}`;
      row.append(resolved);
    }
    container.append(row);
  }
}

// ── 调试页（`#debug-pane`，业主 2026-09-22 裁定的第四个页签）───────────────────────────────
//
// 只读的机器事实，两个来源各自成败、各自如实报：① A 上的 `GET /debug/instances`（经 `/api`）；
// ② B 自己的 `GET /app-host`（同源）。硬口径（与全仓一致）：**任何取不到的字段都如实写
// 「这一项取不到」** —— 不许填 0、不许静默留空、不许编。服务端自己登记在 `unavailable[]` 里的
// 项（它明说取不到、以及去哪儿取）另列一块、原样带出去。
const DEBUG_MISSING_TEXT = '这一项取不到';
// 「按组展示」那一行的键前缀（业主 2026-09-26 那条要求）。单独拿出来是因为门（`test/debug-pane-ui.mjs`
// 的红半）要把「分组那一行没画出来」当成一个**单点**变异来打 —— 改一个常量名就能精确验证那条断言。
const DEBUG_GROUP_ROW_PREFIX = '组 ';

// ISO 时刻 → 本地可读；不是字符串/空的 ⇒ null（调用方画「取不到」）。认不出的字符串原样带出去。
function formatDebugTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

// 通用值整形：缺（null/undefined/空串）⇒ null（调用方画「取不到」）；0 与 false 是**真值**，照画。
function formatDebugValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? '无' : value.map((entry) => formatDebugValue(entry) ?? DEBUG_MISSING_TEXT).join(' · ');
  }
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return null; } }
  return null;
}

// 字节数带上可读单位（括号里永远保留原始字节，免得读者怀疑被抹平）。
function formatDebugBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.abs(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${index === 0 ? String(size) : size.toFixed(1)} ${units[index]}（${value} B）`;
}

function formatDebugMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1000 ? `${value} ms` : `${value} ms（${(value / 1000).toFixed(1)} s）`;
}

function formatDebugSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${value} s`;
}

export function renderDebug(container, { load = 'idle', error = null, payload = null, appHost = null } = {}) {
  const document = container.ownerDocument;
  container.replaceChildren();
  container.dataset.load = load;

  const empty = (text) => {
    const note = document.createElement('div');
    note.className = 'debug-empty';
    const line = document.createElement('p');
    line.textContent = text;
    note.append(line);
    container.append(note);
    return note;
  };

  // 一块（`.debug-item`）＝一个标题 + 一串「标签 / 值」行。值传 null ⇒ 如实画「这一项取不到」。
  const section = (title, { source = null, state = null } = {}) => {
    const node = document.createElement('article');
    node.className = 'debug-item';
    if (state) node.dataset.state = state;
    const head = document.createElement('div');
    head.className = 'debug-head';
    const titleNode = document.createElement('span');
    titleNode.className = 'debug-title';
    titleNode.textContent = title;
    head.append(titleNode);
    if (source) {
      const sourceNode = document.createElement('span');
      sourceNode.className = 'debug-source';
      sourceNode.textContent = source;
      head.append(sourceNode);
    }
    const rows = document.createElement('div');
    rows.className = 'debug-rows';
    node.append(head, rows);
    container.append(node);
    const add = (key, value) => {
      const row = document.createElement('div');
      row.className = 'debug-row';
      const keyNode = document.createElement('span');
      keyNode.className = 'debug-key';
      keyNode.textContent = key;
      const valueNode = document.createElement('span');
      valueNode.className = 'debug-value';
      if (value === null || value === undefined) {
        valueNode.dataset.missing = 'true';
        valueNode.textContent = DEBUG_MISSING_TEXT;
      } else {
        valueNode.textContent = value;
      }
      row.append(keyNode, valueNode);
      rows.append(row);
      return row;
    };
    return { node, add };
  };

  // ① 页面所在的进程（B）。浏览器就在 B 上 ⇒ 这条**不经 /api**，直接同源取 `/app-host`。
  const app = appHost?.value ?? null;
  const appSection = section('页面所在的进程（B）', { source: 'GET /app-host（同源）' });
  appSection.add('pid', formatDebugValue(app?.pid));
  appSection.add('codeVersion', formatDebugValue(app?.codeVersion));
  appSection.add('startedAt', formatDebugTime(app?.startedAt));
  appSection.add('upstream', formatDebugValue(app?.upstream));
  appSection.add('webRoot', formatDebugValue(app?.webRoot));
  if (appHost?.load === 'error' || appHost?.load === 'unsupported') {
    // 读不到**不是**「没有」：把原因单独写一行（字段那几行仍是「取不到」）。
    appSection.add('读取结果', `读不到 —— ${appHost?.error || '服务端没给原因'}`);
  }

  // ② A 上的实例/池事实。
  const hasPayload = payload !== null && typeof payload === 'object';
  if (load === 'unsupported') {
    empty('这个服务端还没有调试端点（GET /debug/instances 不存在）—— 这不是「没有实例」，是这次问不到；B 的本机事实照常显示。');
  } else if (load === 'error' && !hasPayload) {
    const note = empty(`实例事实读失败：${error || '服务端没给原因'}`);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.debugAction = 'refresh';
    retry.textContent = '重试';
    note.append(retry);
  } else if (!hasPayload) {
    empty('正在读取调试信息…');
  } else {
    renderDebugEndpoint(section, payload);
  }
}

// `GET /debug/instances` 的正文（形状未定稿 ⇒ 逐块 **有就画、缺就写「取不到」**，绝不猜）。
function renderDebugEndpoint(section, payload) {
  const worker = payload?.worker ?? null;
  const workerSection = section('逻辑实例（worker）', { source: 'GET /debug/instances → worker' });
  workerSection.add('pid', formatDebugValue(worker?.pid));
  workerSection.add('generationId', formatDebugValue(worker?.generationId));
  workerSection.add('logicVersion', formatDebugValue(worker?.logicVersion));
  workerSection.add('codeRevision', formatDebugValue(worker?.codeRevision));
  workerSection.add('uptimeSeconds', formatDebugSeconds(worker?.uptimeSeconds));
  workerSection.add('memory.rss', formatDebugBytes(worker?.memory?.rss));
  workerSection.add('memory.heapTotal', formatDebugBytes(worker?.memory?.heapTotal));
  workerSection.add('memory.heapUsed', formatDebugBytes(worker?.memory?.heapUsed));
  workerSection.add('memory.external', formatDebugBytes(worker?.memory?.external));
  workerSection.add('memory.arrayBuffers', formatDebugBytes(worker?.memory?.arrayBuffers));

  const pool = payload?.pool ?? null;
  const sessions = Array.isArray(pool?.sessions) ? pool.sessions : null;
  const poolSection = section('池（按会话表）', { source: 'GET /debug/instances → pool' });
  poolSection.add('scope', formatDebugValue(pool?.scope));
  poolSection.add('summary.hot', formatDebugValue(pool?.summary?.hot));
  poolSection.add('summary.cold', formatDebugValue(pool?.summary?.cold));
  poolSection.add('summary.active', formatDebugValue(pool?.summary?.active));
  poolSection.add('summary.pinned', formatDebugValue(pool?.summary?.pinned));
  poolSection.add('summary.loading', formatDebugValue(pool?.summary?.loading));
  poolSection.add('summary.draining', formatDebugValue(pool?.summary?.draining));
  poolSection.add('summary.maxHot', formatDebugValue(pool?.summary?.maxHot));
  poolSection.add('summary.idleTTL', formatDebugMs(pool?.summary?.idleTTL));
  poolSection.add('按会话表', sessions === null
    ? null
    : sessions.length === 0
      ? '无（这一代没有热 runtime）'
      : `${sessions.length} 条`);
  if (sessions) {
    for (const row of sessions) {
      const id = typeof row?.sessionId === 'string' && row.sessionId ? row.sessionId.slice(0, 8) : null;
      const item = section(`会话 ${id ?? '（会话 id 取不到）'}`, { source: 'pool.sessions[]' });
      item.add('sessionId', formatDebugValue(row?.sessionId));
      item.add('runtimeState', formatDebugValue(row?.runtimeState));
      item.add('durable', formatDebugValue(row?.durable));
      item.add('running', formatDebugValue(row?.running));
      item.add('runningNow', formatDebugValue(row?.runningNow));
      item.add('idleForMs', formatDebugMs(row?.idleForMs));
      item.add('evictionEligible', formatDebugValue(row?.evictionEligible));
      item.add('acquiredLeases', formatDebugValue(row?.acquiredLeases));
      item.add('pendingMessages', formatDebugValue(row?.pendingMessages));
      item.add('queuedOperations', formatDebugValue(row?.queuedOperations));
      item.add('busyFlags', formatDebugValue(row?.busyFlags));
      item.add('pinReasons', formatDebugValue(row?.pinReasons));
      item.add('blockers', formatDebugValue(row?.blockers));
      item.add('generationId', formatDebugValue(row?.generationId));
      item.add('sessionFileBytes', formatDebugBytes(row?.sessionFileBytes));
    }
  }

  const policy = payload?.policy ?? null;
  const policySection = section('策略阈值（内存准入 / 压力）', { source: 'GET /debug/instances → policy' });
  policySection.add('heapLimitBytes', formatDebugBytes(policy?.heapLimitBytes));
  policySection.add('watermarks.heapHighBytes', formatDebugBytes(policy?.watermarks?.heapHighBytes));
  policySection.add('watermarks.heapLowBytes', formatDebugBytes(policy?.watermarks?.heapLowBytes));
  policySection.add('watermarks.rssHighBytes', formatDebugBytes(policy?.watermarks?.rssHighBytes));
  policySection.add('watermarks.rssLowBytes', formatDebugBytes(policy?.watermarks?.rssLowBytes));
  policySection.add('watermarks.reserveBytes', formatDebugBytes(policy?.watermarks?.reserveBytes));
  policySection.add('watermarks.sessionMultiplier', formatDebugValue(policy?.watermarks?.sessionMultiplier));
  policySection.add('admission.singleFileBudgetBytes', formatDebugBytes(policy?.admission?.singleFileBudgetBytes));
  policySection.add('admission.formula', formatDebugValue(policy?.admission?.formula));
  policySection.add('pressure.pressure', formatDebugValue(policy?.pressure?.pressure));
  policySection.add('pressure.aboveHigh', formatDebugValue(policy?.pressure?.aboveHigh));
  policySection.add('pressure.belowLow', formatDebugValue(policy?.pressure?.belowLow));
  policySection.add('pressure.reclaimedEpisode', formatDebugValue(policy?.pressure?.reclaimedEpisode));
  policySection.add('pressure.rss', formatDebugBytes(policy?.pressure?.rss));
  policySection.add('rejections', formatDebugValue(policy?.rejections));
  policySection.add('lastAction', formatDebugValue(policy?.lastAction));

  const host = payload?.host ?? null;
  const hotSessions = Array.isArray(host?.hotSessions) ? host.hotSessions : null;
  const hostSection = section('宿主事实（这一代 worker 能看到的）', { source: 'GET /debug/instances → host' });
  hostSection.add('generationId', formatDebugValue(host?.generationId));
  hostSection.add('currentGenerationId', formatDebugValue(host?.currentGenerationId));
  hostSection.add('draining', formatDebugValue(host?.draining));
  // `hotSessions` 是**对象数组**（带 owner 等），不是一个 id 列表 ⇒ 画成「几条 + 每个会话 id 片段」。
  hostSection.add('hotSessions', hotSessions === null
    ? null
    : hotSessions.length === 0
      ? '无'
      : `${hotSessions.length} 条：${hotSessions.map((entry) => (typeof entry?.sessionId === 'string' && entry.sessionId ? entry.sessionId.slice(0, 8) : '（会话 id 取不到）')).join(' · ')}`);
  hostSection.add('worker.pid', formatDebugValue(host?.worker?.pid));
  hostSection.add('worker.rssBytes', formatDebugBytes(host?.worker?.rssBytes));
  hostSection.add('worker.hot', formatDebugValue(host?.worker?.hot));
  hostSection.add('pool.hot', formatDebugValue(host?.pool?.hot));
  hostSection.add('sessionsRoot', formatDebugValue(host?.sessionsRoot));
  hostSection.add('drain.blockers', formatDebugValue(host?.drain?.blockers));
  hostSection.add('memoryPolicy.cpu.totalMs', formatDebugValue(host?.memoryPolicy?.cpu?.totalMs));

  // `tools` 是**活着的 runtime** 的事实（会话级）：`registered` 是这一代注册的工具表（没热 runtime 时服务端
  // 回 `null` ＋ `registeredUnavailableReason`，**不吐空清单假装没有**）；`active` 是**每会话**的（在 `activeBySession[]`）。
  // 插件/内建的区分看 **`path`**（`source` 是 `cli`/`builtin`，认插件不准）—— 两道都画、不互相顶替。
  const tools = payload?.tools ?? null;
  const registeredRaw = tools?.registered;
  const registered = Array.isArray(registeredRaw) ? registeredRaw : null;
  const activeBySession = Array.isArray(tools?.activeBySession) ? tools.activeBySession : null;
  const unreadable = Array.isArray(tools?.unreadableLiveSessions) ? tools.unreadableLiveSessions : null;
  const toolsUnavailable = Array.isArray(tools?.unavailable) ? tools.unavailable : null;
  const toolsSection = section('暴露给 agent 的工具', {
    source: formatDebugValue(tools?.source) ?? 'GET /debug/instances → tools',
    // `registered === null` ＝服务端明说「问不到」⇒ 整块走 warning 槽（不是“空清单”那个脸）。
    state: registered === null ? 'unavailable' : null,
  });
  toolsSection.add('scope', formatDebugValue(tools?.scope));
  toolsSection.add('liveSessionCount', formatDebugValue(tools?.liveSessionCount));
  toolsSection.add('observedOn', formatDebugTime(tools?.observedOn));
  toolsSection.add('registeredCount', formatDebugValue(tools?.registeredCount));
  toolsSection.add('identicalRegisteredAcrossLiveSessions', formatDebugValue(tools?.identicalRegisteredAcrossLiveSessions));
  toolsSection.add('unreadableLiveSessions', unreadable === null
    ? null
    : unreadable.length === 0
      ? '无'
      : formatDebugValue(unreadable));
  // 这一行就是「整块取不到」的落点：null ⇒ 逐字写「这一项取不到」，旁边一行带原因（下一行）。
  toolsSection.add('registered', registered === null
    ? null
    : registered.length === 0
      ? '空清单（服务端说这一代没有任何注册工具）'
      : `${registered.length} 条`);
  // 原因只在「问不到」时才有意义（拿到了清单就没有这一行）—— 这一行就是「为什么不吐清单」的答案。
  if (registered === null) {
    toolsSection.add('registeredUnavailableReason', formatDebugValue(tools?.registeredUnavailableReason));
  }
  toolsSection.add('activeBySession', activeBySession === null
    ? null
    : activeBySession.length === 0
      ? '无（这一代没有热的会话）'
      : `${activeBySession.length} 个会话`);
  // ── 分组（业主 2026-09-26 那条要求：工具要对应的分组）──────────────────────────────
  // `groups` 是服务端的**分组视图**（组名 + 该组工具，由那张声明表派生；与每个工具自己的 `group`
  // 同源 ⇒ 两处必然一致）。`groups === null` ＝服务端明说「分组视图也取不到」（原因在
  // `groupsUnavailableReason`），**不是**「没有分组」⇒ 逐字写「这一项取不到」。
  const groups = Array.isArray(tools?.groups) ? tools.groups : null;
  const groupTable = tools?.groupTable ?? null;
  toolsSection.add('groups（按组列出）', groups === null
    ? null
    : groups.length === 0
      ? '空（服务端说这一代没有任何分组）'
      : `${groups.length} 组`);
  if (groups === null) toolsSection.add('groupsUnavailableReason', formatDebugValue(tools?.groupsUnavailableReason));
  // 声明表在哪儿、什么时候生效（组名不是 pi 给的事实 ⇒ 出处必须能查）。
  toolsSection.add('groupTable.declaredIn', formatDebugValue(groupTable?.declaredIn));
  if (groups) {
    for (const group of groups) {
      const names = Array.isArray(group?.tools) ? group.tools : null;
      const count = typeof group?.toolCount === 'number' ? group.toolCount : names === null ? null : names.length;
      const groupName = typeof group?.name === 'string' && group.name ? group.name : '（组名取不到）';
      toolsSection.add(`${DEBUG_GROUP_ROW_PREFIX}${groupName}`, names === null && count === null
        ? null
        : `${count ?? '数量取不到'} 个：${names === null ? '组内工具取不到' : names.length === 0 ? '无' : names.join(' · ')}`);
    }
  }
  // 插件 / 内建那一对计数：按**服务端声明的分组来源**分（`declared` ＝本仓插件工具；
  // `builtin-table` ＝ pi 内建工具按名字归组）。⚠️ 这里原来按 `path` 认（`path !== ''` 就算插件），
  // 实测**内建工具的 path 不是空串**（是 `<builtin:bash>` 这种形状）⇒ 那个判据会把 8 个内建全算成
  // 插件；换成按 `groupSource` 分（单一来源）。取不到分组来源时如实写「这一项取不到」，**不猜**。
  if (registered) {
    const withSource = registered.filter((entry) => typeof entry?.groupSource === 'string');
    toolsSection.add('插件（分组来源 declared）', withSource.length === 0 ? null : `${withSource.filter((entry) => entry.groupSource === 'declared').length} 条`);
    toolsSection.add('内建（分组来源 builtin-table）', withSource.length === 0 ? null : `${withSource.filter((entry) => entry.groupSource === 'builtin-table').length} 条`);
  }
  // 每会话一行：sessionId 片段 + activeCount + 工具名列。
  if (activeBySession) {
    for (const entry of activeBySession) {
      const short = typeof entry?.sessionId === 'string' && entry.sessionId ? entry.sessionId.slice(0, 8) : '（会话 id 取不到）';
      const names = Array.isArray(entry?.active) ? entry.active : null;
      const count = typeof entry?.activeCount === 'number' ? entry.activeCount : names === null ? null : names.length;
      toolsSection.add(`会话 ${short}`, names === null && count === null
        ? null
        : `${count ?? '数量取不到'} 个：${names === null ? '名单取不到' : names.length === 0 ? '无' : names.join(' · ')}`);
    }
  }
  if (toolsUnavailable && toolsUnavailable.length > 0) {
    for (const entry of toolsUnavailable) {
      const field = typeof entry?.field === 'string' && entry.field ? entry.field : '（未点名的字段）';
      const reason = formatDebugValue(entry?.reason);
      const where = formatDebugValue(entry?.where);
      toolsSection.add(`取不到：${field}`, reason === null && where === null
        ? null
        : `原因：${reason ?? DEBUG_MISSING_TEXT}；去哪儿取：${where ?? DEBUG_MISSING_TEXT}`);
    }
  }
  if (registered) {
    for (const entry of registered) {
      const name = typeof entry?.name === 'string' && entry.name ? entry.name : '（工具名取不到）';
      // 分组（业主 2026-09-26 那条要求）：组名 + 它**怎么定下来的**（`declared` / `builtin-table` /
      // `unclassified`，含义在 `groupTable.groupSourceValues` 里，服务端给）。
      const group = formatDebugValue(entry?.group);
      const groupSource = formatDebugValue(entry?.groupSource);
      const kind = entry?.groupSource === 'declared' ? '插件' : entry?.groupSource === 'builtin-table' ? '内建' : null;
      const item = section(`工具 ${name}`, { source: group === null ? 'tools.registered[]' : `tools.registered[] · 组：${group}` });
      item.add('类型（按分组来源）', kind);
      item.add('组', group);
      item.add('分组来源', groupSource);
      item.add('source', formatDebugValue(entry?.source));
      item.add('path', formatDebugValue(entry?.path));
      // 业主 2026-09-25 那条要求：**名称/描述/参数/参数说明**四样都要。
      //   · `description` ＝**全文**（业主那条要的「描述」）；
      //   · `descriptionHead` ＝ 前 160 字，**兼容字段**（两行都画、标签写明区别，不互相顶替）。
      item.add('description（全文）', formatDebugValue(entry?.description));
      item.add('descriptionHead（前 160 字，兼容字段）', formatDebugValue(entry?.descriptionHead));
      item.add('hasParameters', formatDebugValue(entry?.hasParameters));
      // 参数：那份 JSON Schema **原样**画（嵌套子属性的说明也在里面）。
      item.add('parameters（JSON Schema 原样）', entry?.parameters === null || entry?.parameters === undefined ? null : formatDebugValue(entry.parameters));
      item.add('parameterNames', formatDebugValue(entry?.parameterNames));
      // 参数说明：**每个参数**一行（`type` / `required` / `description`）；
      // `description` 取不到 ⇒ 逐字写「这一项取不到」（服务端给的是 `null`），不是空串。
      const parameterDetails = Array.isArray(entry?.parameterDetails) ? entry.parameterDetails : null;
      item.add('parameterDetails', parameterDetails === null
        ? null
        : parameterDetails.length === 0
          ? '无（这个工具没有参数）'
          : `${parameterDetails.length} 个`);
      if (parameterDetails) {
        for (const detail of parameterDetails) {
          const parameterName = typeof detail?.name === 'string' && detail.name ? detail.name : '（参数名取不到）';
          item.add(`参数 ${parameterName}.type`, formatDebugValue(detail?.type));
          item.add(`参数 ${parameterName}.required`, formatDebugValue(detail?.required));
          item.add(`参数 ${parameterName}.description`, formatDebugValue(detail?.description));
        }
      }
    }
  }

  const unavailable = Array.isArray(payload?.unavailable) ? payload.unavailable : null;
  const unavailableSection = section('取不到的项（服务端如实登记）', { source: 'GET /debug/instances → unavailable', state: 'unavailable' });
  if (unavailable === null) {
    unavailableSection.add('unavailable', null);
  } else if (unavailable.length === 0) {
    unavailableSection.add('unavailable', '服务端没有登记任何取不到的项');
  } else {
    for (const entry of unavailable) {
      const field = typeof entry?.field === 'string' && entry.field ? entry.field : '（未点名的字段）';
      const reason = formatDebugValue(entry?.reason);
      const where = formatDebugValue(entry?.where);
      unavailableSection.add(field, reason === null && where === null
        ? null
        : `原因：${reason ?? DEBUG_MISSING_TEXT}；去哪儿取：${where ?? DEBUG_MISSING_TEXT}`);
    }
  }
}
