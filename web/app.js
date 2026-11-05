import { mountMentions } from './mentions.mjs';
import { mountSettingsPanel } from './settings-panel.mjs';
import { renderCommandPalette, cancelMessageRender, renderMarkdown, renderMessages, appendMessageNodes, renderQueueStatus, renderSuggestions, renderSessionObservability, renderContextUsage, renderSessionCwd, filterTreeSessions, renderTree, normalizeTreeSortMode, renderQuestions, renderAnnotations, renderDebug, toolCard, annotationControl, ensureAnnotationForm, annotationAnchorOf, annotationCardText, annotationMatches, applyAnnotationState, applyThinkingState, liveBridgeKey, liveCollapseGet, liveCollapseSet, liveToolContext, clearLiveCollapse, knownDetails, setThinkingDefaultFold, updateLiveOutput } from './render.js';

// `index.html` 正与另一条 landing 并行修改；这里在应用启动前加载独立槽原语，
// 避免把全站设计语言重新塞回页面内联样式，也让所有组件只复用一份规则。
// ⚠️ **失败不许拖垮整页**（2026-09-22 修）：这是**顶层 await**，原来一发失败就整模块报错 ⇒
//   页面全死（不是“槽色缺失”而是一个白屏），且它在页面被导航带走时会被取消 ⇒
//   `TypeError: Failed to fetch` 变成未捕获异常（`test:s1a2-mainui` 偶发红、本件的浮层门也撞到过，
//   实测：`/slot.css` 延迟 400ms + load 后立刻导航 ⇒ `app.js:9` 报错，而 load 事件只等 65ms ⇒ TLA 不被 load 等）。
//   所以：拿不到就**降级**（元素仍在、只是空的，槽色不生效），并把这件事留在元素上与一条 warn 上。
const slotStyle = document.createElement('style');
slotStyle.dataset.slotLanguage = 'v2.2';
try {
  const slotResponse = await fetch('/slot.css');
  slotStyle.textContent = slotResponse.ok ? await slotResponse.text() : '';
  if (!slotResponse.ok) {
    slotStyle.dataset.unavailable = `http-${slotResponse.status}`;
    console.warn(`slot stylesheet unavailable: HTTP ${slotResponse.status} —— 槽色降级为无，页面继续`);
  }
} catch (error) {
  slotStyle.dataset.unavailable = 'fetch-failed';
  console.warn(`slot stylesheet unavailable: ${error?.message ?? error} —— 槽色降级为无，页面继续`);
}
document.head.append(slotStyle);

const treeNode = document.querySelector('#tree');
const devicesNode = document.querySelector('#devices');
const devicePanelNode = document.querySelector('#device-panel');
const messagesNode = document.querySelector('#messages');
const jumpNode = document.querySelector('#jump');
const titleNode = document.querySelector('#session-title');
const sessionUsageNode = document.querySelector('#session-usage');
const sessionConnectionNode = document.querySelector('#session-connection');
const composer = document.querySelector('#composer');
const promptNode = document.querySelector('#prompt');
const sendNode = document.querySelector('#send');
const archiveNode = document.querySelector('#archive');
const deleteNode = document.querySelector('#delete');
const deleteConfirmNode = document.querySelector('#delete-confirm');
const deleteConfirmTextNode = document.querySelector('#delete-confirm-text');
const deleteConfirmYesNode = document.querySelector('#delete-confirm-yes');
const deleteConfirmNoNode = document.querySelector('#delete-confirm-no');
const compactNode = document.querySelector('#compact');
const compactConfirmNode = document.querySelector('#compact-confirm');
const compactConfirmTextNode = document.querySelector('#compact-confirm-text');
const compactConfirmYesNode = document.querySelector('#compact-confirm-yes');
const compactConfirmNoNode = document.querySelector('#compact-confirm-no');
const abortNode = document.querySelector('#abort');
const queueNode = document.querySelector('#queue-status');
// 对话内的「推荐回复」：模型建议那一排（贴在输入框正上方）。三个节点都由 `renderSuggestionsRow()` 管。
const suggestionsNode = document.querySelector('#suggestions');
const suggestionsListNode = document.querySelector('#suggestions-list');
const suggestionsCloseNode = document.querySelector('#suggestions-close');
const noticeNode = document.querySelector('#notice');
// M-41：插件 `ctx.ui.notify` 的落点（独立一行，绝不进 `#messages`）。
const sessionNoticeNode = document.querySelector('#session-notice');
const sessionNoticeTextNode = document.querySelector('#session-notice-text');
const sessionNoticeCloseNode = document.querySelector('#session-notice-close');
const newSessionToggleNode = document.querySelector('#new-session-toggle');
const newSessionPanelNode = document.querySelector('#new-session-panel');
const newSessionCancelNode = document.querySelector('#new-session-cancel');
const newProjectNode = document.querySelector('#new-project');
const newScratchNode = document.querySelector('#new-scratch');
const advancedSessionNode = document.querySelector('#advanced-session');
const newCwdNode = document.querySelector('#new-cwd');
const treeConnectionNode = document.querySelector('#tree-connection');
const commandPaletteNode = document.querySelector('#command-palette');
const exportNode = document.querySelector('#export');
const renameNode = document.querySelector('#rename');
const renameFormNode = document.querySelector('#rename-form');
const sessionTitleInputNode = document.querySelector('#session-title-input');
const renameCancelNode = document.querySelector('#rename-cancel');
const sessionCwdNode = document.querySelector('#session-cwd');
const sessionContextNode = document.querySelector('#session-context');
// 这两行**从启动起就占位**（不再等选中会话才 `hidden=false`）：它们从无到有会让整个顶栏长高 26px、
// 把右侧正文区（grid 的 minmax(0,1fr) 行）整体向下推一下 —— 真规模数据实测冷开 +29px、热开会话（带 context）+58px
// 就发生在「点中会话、会话流刚连上」那一下（`test/stream-jump-realdata.mjs` 修前红）。
// 占位文案与用量行同一条规矩：未知就说未知，不拿空白冒充。
renderSessionCwd(sessionCwdNode, null);
renderContextUsage(sessionContextNode, null);
const treeSearchInputNode = document.querySelector('#tree-search-input');
const treeNamedOnlyNode = document.querySelector('#tree-named-only');
const treeSearchToggleNode = document.querySelector('#tree-search-toggle');
const treeSearchPanelNode = document.querySelector('#tree-search');
const treeSortToggleNode = document.querySelector('#tree-sort-toggle');
// P1（manager toolkit）：右栏视图切换 + 问题页的节点。
const mainNode = document.querySelector('main');
const viewTabSessionNode = document.querySelector('#view-tab-session');
const viewTabQuestionsNode = document.querySelector('#view-tab-questions');
const viewTabAnnotationsNode = document.querySelector('#view-tab-annotations');
const questionPaneNode = document.querySelector('#questions-pane');
const questionsListNode = document.querySelector('#questions-list');
const questionsNoticeNode = document.querySelector('#questions-notice');
const questionsRefreshNode = document.querySelector('#questions-refresh');
const questionsFilterOpenNode = document.querySelector('#questions-filter-open');
const questionsFilterAnsweredNode = document.querySelector('#questions-filter-answered');
// 卡片级反馈（annotations）：全局只读列表（与问题看板同级入口），节点与问题页对称。
const annotationsPaneNode = document.querySelector('#annotations-pane');
const annotationsListNode = document.querySelector('#annotations-list');
const annotationsNoticeNode = document.querySelector('#annotations-notice');
const annotationsRefreshNode = document.querySelector('#annotations-refresh');
const annotationsFilterAllNode = document.querySelector('#annotations-filter-all');
const annotationsFilterOpenNode = document.querySelector('#annotations-filter-open');
// 调试页（第四个页签，`#debug-pane`）：只读机器事实（A 的实例/池 + B 的本机事实）。节点与问题页/标注页对称。
const viewTabDebugNode = document.querySelector('#view-tab-debug');
const debugPaneNode = document.querySelector('#debug-pane');
const debugListNode = document.querySelector('#debug-list');
const debugNoticeNode = document.querySelector('#debug-notice');
const debugRefreshNode = document.querySelector('#debug-refresh');

let selectedId = null;
let sessionEvents = null;
let liveNode = null;
// 直播块按**通道 / 工具分片**攒内容（与 v2.1 的 `live.parts` 同构）：thinking / text 各自成段，
// 工具按 toolCallId 成卡，全部按到达顺序排列。以前只留一个 text 字符串 ⇒ thinking 被丢、工具无卡。
let liveParts = [];
// 直播块里的**顶层块**（业主 2026-09-22 的平铺）：连续的非工具 part 合成一个 assistant 段，
// 每个工具 part 单独成一张顶层工具卡。帧间按 key 复用，只写增量、不重建。
// 每项 { kind:'segment'|'tool', key, node, body, parts:[{type,key,node,textNode,rendered}] }。
let liveBlocks = [];
// 「思考中…」占位（只在直播块**真的什么都没得画**时才挂）。
let liveThinkNode = null;
let liveActive = false;
let liveStartIndex = 0;
// 一块直播 = 一个 token（`startLive` / `splitLive` 各开新块，只增不减）。
// 它给「占位消息」一个话序坐标：占位是在**哪一块直播期间**发出去的 —— 见 restackTransient。
let liveBlockToken = 0;
// 历史已接管的前缀长度，两个通道各算一份（历史里 thinking/text 是两个 part）。
let liveCoveredText = 0;
let liveCoveredThinking = 0;
// 历史已接管的工具卡（按 toolCallId）—— 历史里已有同一张卡时，直播块不再画一份。
let liveCoveredTools = new Set();
let liveRaf = 0;
let liveCoverageVersion = -1;
/** 排队消息（steer/followUp）**刚被 pi 注入对话** ⇒ 下一个 `session.start` 要开新块（见 splitLive）。 */
let liveSplitPending = false;
/** `splitLive` 收口时**冻住**的那些直播块（`data-kind="live-done"`）：内容已经落盘，但本地正文
 *  还没接手 —— 它们是「还没到的历史」，**不是**已画好的正文前缀。
 *  只要还有一块连在屏幕上，尾部增量那条路就不能用（它只会 append、绝不动已画好的节点 ⇒ 那块永远
 *  换不掉，同一段正文在屏幕上出现两次：见 `refreshMessagesOnce` 的 `appended` 与 splitLive 注释）。
 *  ⚠️ 摘掉它们的只有历史重画（`replaceChildren`，含换会话那一次）—— 那不在我们的代码里，所以这里
 *  按「还连在文档上吗」判（`liveDonePending` 顺手清掉已经不在了的）。 */
let liveDoneNodes = new Set();
let visibleMessages = [];
let visibleMessagesId = null;
let visibleMessagesVersion = 0;
/** 屏幕上那一份正文的指纹（见 historySignature）：同一份不重画。 */
let renderedSignature = null;
/** 屏幕上那一份正文的**载荷**（`renderedSignature` 对应的那一个对象）。尾部增量要用它算游标、
 *  并核对「服务端这一版的前缀就是我手上这份」（见 tailMerge）；换会话必须跟着 `renderedSignature` 一起清掉。 */
let renderedPayload = null;
let treeRefreshQueued = false;
let treeRequestGeneration = 0;
// /tree 的重试纪律（防「实例级放大回路」）：
//   ① 同一资源单飞：正在飞的那次没回来前，不再开第二个 /tree（不并发重入）；
//   ② 失败后指数退避 + 抖动（1s→2s→4s… 上限 30s），退避窗口内不立即重试，只登记一次到点重试；
//   ③ 成功一次后重置退避，回到常规节奏；
//   ④ 连续失败时把原因与下次重试时间写进 notice（不静默空着、不反复闪）。
let treeRequest = null;
let treeBackoffAttempt = 0;
let treeBackoffUntil = 0;
let treeBackoffTimer = null;
const TREE_BACKOFF_BASE_MS = 1000;
const TREE_BACKOFF_MAX_MS = 30000;
// worker 到点先回的**部分视图**（索引还在建）时，多快再问一次。它**不进退避**：这不是失败，
// 是「等一下就有」—— 但也不该比索引建得快，所以留一点间隔。
const TREE_PARTIAL_RETRY_MS = 1500;
let messagesRequestGeneration = 0;
let sessionGeneration = 0;
let sessionRequestController = null;
let streaming = false;
// 「agent 在不在跑」和「助手正文在不在流」是**两件事**（v2.1 用的 agent_start/agent_end 是前者）：
// pi 的一轮 run 里可能有多条 assistant 消息（工具循环），每条 message_end 都会发 session.end，
// 但 run 一直到 agent_settled 才真的停。所以 `streaming` 只驱动直播正文，
// `agentBusy` 才是「现在发消息要不要 steer / 要不要拒命令」的判据。
let agentBusy = false;
let compacting = false;
// M-36：上游自动重试的当前状态 `{ attempt, maxAttempts }` | null。它是**状态不是回执**（常驻到
// `session.retry_end` 或第一帧正文 delta），所以在 I-12 提示行里属于**状态层**（`hintStatus()`），
// 不占用覆盖层 —— 覆盖层照旧让错误 / 警告报文压过它。重连时由 `session.snapshot.isRetrying` 对账。
let retryState = null;
// 正在被自动重试的那一条**中间态**上游错误覆盖层（`session.end{stopReason:'error'}` 刚写下的那条）。
// 它紧接着就会被 `session.retry_start` 撤掉、让位给「正在重试」状态 —— 但**只撤这一条**：别的
// 错误 / 警告报文照旧压着重试状态，重试**最终失败**时（不再有 retry_start）这条错误自然保留。
let upstreamErrorNotice = null;
let compactRequest = null;
let sessionContext = null;
let queue = { steering: [], followUp: [] };
/** 「我刚发出去的那条」的占位：`[{ text, node }]` —— 沿用 v2.1 `pendingUser` 的语义。
 *  · **不是**乐观状态：文本在不在 pi 的队列事实（`queue.steering`/`queue.followUp`）里，决定它标
 *    「⏳ 排队中」还是普通「已发送」（后者 = 已经离队、下一发正文就会带上它）；
 *  · 正文一到，就按 **`(role:"user", text)` 逐字去重**（v2.1 `applyHistory` 的同一条判据）：
 *    历史接管后占位必须消失 —— **绝不能出现两条**；
 *  · 换会话 / 打不开 ⇒ 清空（占位不许残留到别的会话）。
 *  为什么非补不可：v2.2 只在 `session.snapshot` / `session.end` / `compaction_end` 才重拉正文，
 *  所以「刚发出的那条」要等**整轮结束**才出现（用户 2026-09-20 报的正是这个）。 */
let pendingUser = [];
let treeSessions = [];
let openErrorId = null;
let readOnlySessionId = null;
let composerAvailable = false;
// 有几次 `send()` 正打在服务端上（含它的兜底重发）。反方向兜底要求「此刻只有我这一次在飞」，
// 免得两条发送各自兜底、把同一条原文投递两次（幂等）。
let sendInFlight = 0;
let archiveRequest = null;
// M-18（删除会话）：在飞标记 + 正在等确认的那个会话 id（确认前**不发**任何请求）。
let deleteRequest = null;
let deleteConfirmId = null;
const expandedBranches = new Set();
const collapsedBranches = new Set();
let atticOpen = false;
// M-18 左栏过滤（纯前端）；M-08 改名请求的在飞标记。
let treeQuery = '';
let treeNamedOnly = false;
// M-18（排序模式）：兄弟顺序，内存态（不落盘、不请求服务端）。默认「最近活动在前」= 旧行为。
let treeSortMode = 'recent';
// M-11：当前会话的思考档位（只读）。只在 `GET /sessions/{id}` 的 `runtime.thinkingLevel` 真给了值时设它；
// 切会话 / 打开失败时清掉 —— 不猜、不把上个会话的档位留在这一行。
let sessionThinkingLevel = null;
let renameRequest = null;
let treeConnected = false;
let sessionConnected = false;
const seenInFlight = new Set();
let commands = [];
let commandsFor = null;
let commandsStreaming = false;
let commandsLoading = false;
let commandsError = null;
let commandMode = null;
let commandItems = [];
let commandIndex = 0;
let commandDismissed = '';
let models = [];
let modelsFor = null;
let modelsLoading = false;
let modelsError = null;
let mentions = null;
let draftTimer = null;
let draftTimerId = null;
const draftWrites = new Map();
const draftUnavailable = new Set();
const DRAFT_DEBOUNCE_MS = 500;

// ── P1（manager toolkit）：视图与问题页状态 ────────────────────────────────────────────────────
// 契约：`docs/plans/manager-toolkit-plan.md` §3（4 个端点）/ §5（界面口径）/ §9（已定八条）。
// 纪律：
//   · 视图与未答数**按会话记在内存**（不落盘）；默认「会话」。
//   · 切页不动直播：`sessionEvents` 一直连着，正文容器只切 visibility（见 index.html 的注释）——
//     切回时既有去重/对账/直播呈现逻辑原样接着跑。
//   · 计数未知就是未知：服务端没这接口（404）或读不到时显示 `问题`（不显示 0，也不弹错）。
const VIEW_SESSION = 'session';
const VIEW_QUESTIONS = 'questions';
// 卡片级反馈的**全局**只读页（与问题看板同级入口，但它不属于任何会话 —— 标注是跨会话的账）。
const VIEW_ANNOTATIONS = 'annotations';
// 调试页（业主 2026-09-22 裁定）：与问题/标注**同级**的第四个页签。它是**全局**只读页（跨会话）——
// 数据是整代 worker 的实例事实与本机（B）事实，不属于任何一条会话 ⇒ 页签始终可用。
const VIEW_DEBUG = 'debug';
const viewBySession = new Map(); // id -> 'session' | 'questions'
// 标注页是全局视图：开着它时压过 per-session 的 view（选会话时会被关掉，回到会话页）。
let annotationsView = false;
// 调试页也是全局视图（同标注页那条：开着它时压过 per-session 的 view）。
let debugView = false;
const questionCounts = new Map(); // id -> { open: number, known: boolean }
let questionLoadToken = 0;
const questionState = {
  id: null,
  generation: 0,
  status: 'open', // 页内筛选：'open'（未答）| 'answered'（已答/已关）
  load: 'idle', // 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
  error: null,
  entries: [],
  drafts: new Map(), // qid -> 还没提交的答案原文（重画不丢）
  closeConfirm: null, // 正在确认关闭的 qid
  closeReason: '',
  submitting: null, // 正在提交的 qid（answer/close 共用）
};

// 卡片级反馈（annotations）：全局页的状态（**不按会话** —— 标注是跨会话的账）。
const annotationState = {
  status: 'all', // 页内筛选：'all'（全部）| 'open'（未处理）
  load: 'idle', // 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
  error: null,
  items: [],
};
let annotationLoadToken = 0;
// 调试页的状态（也是**不按会话**的全局页）。两个来源各自成败、各自如实报：
//   · `load` / `error` / `payload`  ← GET /debug/instances（经 /api 反代到 A）
//   · `appHost`                     ← GET /app-host（同源 B，不走 /api）
// 值取不到由 `renderDebug` 统一画「这一项取不到」；这里只管“拿到了没有”。
const debugState = {
  load: 'idle', // 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
  error: null,
  payload: null,
  appHost: { load: 'idle', error: null, value: null },
  notice: '切到这一页会读一次实例事实与本机事实。',
};
let debugLoadToken = 0;
// 卡片上的「已反馈 / 已处理 ✓」**全部由服务端 state 驱动**（v1.5；v1 那个本地 `annotateSent`
// 集合已删）。这里只存**这个会话的、服务端折好的**那一批（`GET /annotations?session=` ⇒ 每条带
// `state`/`resolvedAt`/`resolvedBy`）；卡片按锚点去匹配（`annotationMatches`）—— 匹配不上就**不显示**。
const annotationMarks = { sessionId: null, load: 'idle', error: null, items: [], token: 0 };

// I-53 URL 深链（`docs/ops/interaction-parity.md`）：v2.1 里 `#<完整 uuid>` 就是「当前会话」的地址，
// v2.2 丢过 —— 刷新即回到「请选择会话」、会话不可书签。这里按 v2.1 的语义恢复，纪律不变：
//   · 写：选中会话后把 `#<uuid>` 写回地址栏。用 **replaceState 不是 pushState** —— 一次选择
//     不该往后退栈里塞一条（与 v2.1 一致）；
//   · 读：启动时按 hash 打开（刷新 / 收藏夹 / 别人贴来的链接）；
//   · 跟随：hashchange 切会话（用户手改地址、别的页面带 hash 进来、真·后退/前进）；
//   · 只认**完整 uuid**（与后端同一条纪律：解析只认完整 uuid）—— `#foo` / 空 `#` / uuid 片段
//     都不是会话标识，一律静默忽略（不动当前界面、不报错）。
const SESSION_HASH_PATTERN = /^#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
let hashWriteInFlight = false;

function sessionIdFromHash(hash = location.hash) {
  const match = SESSION_HASH_PATTERN.exec(String(hash ?? ''));
  return match ? match[1].toLowerCase() : null;
}

// 自己写地址栏：只换 hash。replaceState 本身不派 hashchange；这里再加一道「值没变就不碰」，
// 于是纵使哪个浏览器把这次写入当成导航，也不会自激成「写 hash → 切会话 → 再写 hash」的回环
//（下面 hashchange 那条里还有 `id === selectedId` 的第二道守卫）。
function syncSessionHash(id) {
  const next = `#${id}`;
  if (location.hash === next) return;
  hashWriteInFlight = true;
  try { history.replaceState(null, '', next); } finally { hashWriteInFlight = false; }
}

function clearSessionHash() {
  if (!sessionIdFromHash()) return;
  hashWriteInFlight = true;
  try { history.replaceState(null, '', `${location.pathname}${location.search}`); } finally { hashWriteInFlight = false; }
}

// ── 换代窗口：客户端按 `retryable` 这一个旗标分支（`docs/plans/manager-toolkit-plan.md` §11）────────────
// 宿主在换代窗口里给**非 2xx 追加** `retryable: true`（+ `retryAfterMs`）—— 状态码与既有 `error`
// code 一字不改（所以 409 仍是 409、`session_not_owned_by_generation` 仍是它）。客户端按旗标分支，
// 不按状态码猜。纪律（与宿主那条「写请求绝不自动重试」对称，理由相同：无法证明 worker 没处理过
// ⇒ 重试有双写风险）：
//   · **幂等读路径**（GET/HEAD：会话详情 / 正文 / 树 / 问题清单…）⇒ 按 `retryAfterMs` 退避后
//     **只重试一次**（再叠一个短随机量：多个标签页并发时不至于对齐成新的脉冲）；
//   · **写路径**（POST/PUT/PATCH…：发消息 / 答题 / 归档…）⇒ **绝不自动重试**，把话**如实说给用户**
//     （不静默、不假装成功），由 `swapWindowWriteNotice` 给出一句人话。
// ⚠️ 判据只有 `retryable === true`：**不带旗标**的 409/5xx（忙冲突、真所有权冲突、普通 500）行为与
// 从前**一字不差** —— 不许把它读成「任何错都重试」。
const RETRYABLE_DEFAULT_RETRY_AFTER_MS = 500;
const RETRYABLE_MAX_RETRY_AFTER_MS = 5000;
const RETRYABLE_JITTER_MS = 100;

function retryableBackoffMs(retryAfterMs) {
  const base = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(retryAfterMs, RETRYABLE_MAX_RETRY_AFTER_MS)
    : RETRYABLE_DEFAULT_RETRY_AFTER_MS;
  return base + Math.round(Math.random() * RETRYABLE_JITTER_MS);
}

/** 写路径撞上换代窗口：如实说人话（写进 `error.message`，各调用点已有的 notice 直接显示它）。 */
function swapWindowWriteNotice(retryAfterMs) {
  const hint = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? `，服务端建议约 ${Math.round(retryAfterMs)} ms 后再试` : '';
  return `服务端正在换代：这条没有发出去，也不会自动重发（免得重复）${hint} —— 请稍后重试。`;
}

async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  let retried = false;
  for (;;) {
    const response = await fetch(`/api${path}`, {
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...options,
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (response.ok) return body;
    const error = new Error(`${response.status} ${body.message || text}`);
    error.status = response.status;
    // 服务端的机器可读错误码（`{error, message}` 里的 `error`）——忙冲突要分方向就靠它，
    // 不靠人读的措辞（措辞是给人看的，会变；码是契约）。
    error.serverCode = typeof body.error === 'string' ? body.error : null;
    error.serverMessage = body.message || text;
    if (body?.retryable === true) {
      error.retryable = true;
      error.retryAfterMs = Number.isFinite(Number(body.retryAfterMs)) ? Number(body.retryAfterMs) : null;
      if (idempotent && !retried) {
        // 幂等读：退避后**只**再来一次；再来这一发若还失败，就按原样抛（不重试成环）。
        retried = true;
        await new Promise((resolve) => setTimeout(resolve, retryableBackoffMs(error.retryAfterMs)));
        continue;
      }
      if (!idempotent) error.message = swapWindowWriteNotice(error.retryAfterMs);
    }
    throw error;
  }
}

// ── I-12：输入框下方那一行 = 随状态变的提示行（`docs/ops/interaction-parity.md`） ────────────────
// 复用**既有**的 `#notice`（用户 2026-09-19 批准：常驻、随状态变；零新增元素、零新增行）：
// 这一行本来就常驻占位（`index.html` 的 `#notice { grid-column: 1/-1; min-height: 1rem; … }`），
// 所以文案在五种状态之间变长变短都不动布局（`test:streamjump*` 量 `noticeHeight`）。
// 行上有**两层**，覆盖层优先：
//   ① 状态层（默认）：随「当前处于哪个模式」变。状态源全部是**既有变量**（不新造状态机）：
//      `selectedId`（未选会话）→ `compacting`（压缩中）→ `retryState`（上游自动重试中，M-36：
//      来自 `session.retry_start/retry_end` / `session.snapshot.isRetrying`，是**状态不是回执**）
//      → `agentBusy`（流式中 = pi 的 **run 级**忙闲：
//      `session.start`→true、`session.settled`→false、`session.snapshot` 的 `isStreaming` 对账；
//      注意**不是** `streaming`，那个只管直播正文，工具循环里会一段段落下去）→ 其余=空闲。
//   ② 覆盖层：`notice(...)` 的瞬时报文（错误 / 确认回执）压过状态层 —— 见下面 notice()。
// 命令面板**不占这一行**：v2.2 的面板自带一条行内提示（`renderCommandPalette` 末尾的
// `.command-palette-note`：「↑↓ 选择 · Enter 执行/填入 · Esc 关闭」，模型模式下同一句）——
// v2.1 那句「模型候选 · ↑↓ 选择 · Tab/Enter 填入 · Esc 关闭」在 v2.2 由面板内这一行承担，
// 再搬到输入行上就是同一句话出现两次。
// 文案里**不放动态数字**（会随 token / 秒数变宽变窄 ⇒ 整行抖）——**唯一例外**是重试计数
// （「1/2」）：用户要的就是「第几次 / 共几次」（M-36），且这个位数（1↔2）不变宽，
// 那一行本就 `nowrap` + 占位 `min-height:1rem`，门 `test:retryvisible` 逐帧量过位移 = 0px。
const HINT_NO_SESSION = '先选一个会话';
const HINT_IDLE = 'Enter 发送 · Shift+Enter 换行';
const HINT_STREAMING = '流式中 —— Enter 插话 · Alt+Enter 排到队尾';
const HINT_COMPACTING = '正在压缩上下文…（可能要几十秒）';
// M-36：上游自动重试。`attempt/maxAttempts` 是 pi `auto_retry_start` 给的真值；缺字段就不编数字
//（重连后 snapshot 只给 `isRetrying` 布尔，那时就显示不带计数的通用句）。
const HINT_RETRY_PREFIX = '上游错误，正在重试';

function hintRetryText() {
  const { attempt, maxAttempts } = retryState ?? {};
  const counts = Number.isInteger(attempt) && Number.isInteger(maxAttempts) ? ` ${attempt}/${maxAttempts}` : '';
  return `${HINT_RETRY_PREFIX}${counts}…`;
}

function hintStatus() {
  if (!selectedId) return HINT_NO_SESSION;
  if (compacting) return HINT_COMPACTING;
  // 重试比「流式中」更具体（重试期间 agentBusy 也是 true）⇒ 它排在前面。
  if (retryState) return hintRetryText();
  if (agentBusy) return HINT_STREAMING;
  return HINT_IDLE;
}

/** 覆盖层（瞬时报文）：`{ text, error }`；`null` = 行上显示状态层。 */
let noticeOverride = null;
let noticeOverrideTimer = 0;
// 确认类报文（info）的存活时间：它是**一次性回执**（「消息已接收」「回复完成」…），
// 常驻会把「流式中 / 空闲」这些当前模式一直挡在后面 ⇒ 退场后把行还给状态层。
// 错误 / 警告（error）**不自动退场**：错误得留给人读（用户明定「错误优先覆盖」），
// 它只会被下一条报文替换，或在用户做了动作（改输入 / 切会话）时撤掉。
const NOTICE_RECEIPT_MS = 5000;

function renderNotice() {
  const override = noticeOverride;
  noticeNode.textContent = override ? override.text : hintStatus();
  noticeNode.dataset.level = override?.error ? 'error' : 'info';
  // 状态层的字色交回 CSS（`#notice` 的 #7f9baf，v2.1 hint 的同一份弱色）；左槽由 data-level 定。
  noticeNode.style.color = override ? (override.error ? 'var(--danger)' : 'var(--accent)') : '';
  // 两层同一行：这个属性既方便验收，也让后面的测试能分辨「现在是报文还是状态」。
  noticeNode.dataset.layer = override ? 'notice' : 'hint';
  // 问题页自带一条 notice 行：底栏（composer，`#notice` 住在里面）在问题页是隐藏的 ——
  // 答题失败/回执不能跟着一起消失。这条行只镜射**覆盖层**（瞬时报文），不镜射模式提示；
  // 空着也占位（`min-height: 1rem`），所以文案长短不动布局。
  questionsNoticeNode.textContent = override ? override.text : '';
  questionsNoticeNode.dataset.level = override?.error ? 'error' : 'info';
  // 标注页同样自带一条 notice 行（同上一条理由）。
  annotationsNoticeNode.textContent = override ? override.text : '';
  annotationsNoticeNode.dataset.level = override?.error ? 'error' : 'info';
}

/** 撤掉覆盖层（不动状态层）。 */
function clearNotice() {
  if (noticeOverrideTimer) {
    clearTimeout(noticeOverrideTimer);
    noticeOverrideTimer = 0;
  }
  if (noticeOverride === null) return;
  noticeOverride = null;
  renderNotice();
}

function notice(message, error = false) {
  if (noticeOverrideTimer) {
    clearTimeout(noticeOverrideTimer);
    noticeOverrideTimer = 0;
  }
  // 空报文 = 撤掉覆盖层（`selectSession` 的正常收尾就是 `notice('')`：没有草稿警告时把行还给状态层）。
  if (!message) {
    noticeOverride = null;
    renderNotice();
    return;
  }
  noticeOverride = { text: message, error };
  renderNotice();
  if (!error) noticeOverrideTimer = setTimeout(clearNotice, NOTICE_RECEIPT_MS);
}

// ── M-41：插件通知行（`session.notice`）─────────────────────────────────────────
// 服务端把插件的 `ctx.ui.notify` 投成 `session.notice`，只发给**在线**的 SSE 订阅者（瞬时、不落盘）。
// 这里只做展示：同一条会话里只有一个节点，后到者替换（不堆叠）；info 自动消失，warning/error
// 留到被下一条替换或被 × 关掉；多行用 textContent + pre-wrap 原样保留。它**不是**消息，
// 绝不 append 进 `#messages`（`test:liveorder` 守着消息顺序）。
const SESSION_NOTICE_INFO_MS = 8000;
let sessionNoticeTimer = 0;

function clearSessionNotice() {
  if (sessionNoticeTimer) {
    clearTimeout(sessionNoticeTimer);
    sessionNoticeTimer = 0;
  }
  if (!sessionNoticeNode) return;
  sessionNoticeNode.hidden = true;
  sessionNoticeTextNode.textContent = '';
}

function showSessionNotice(level, text) {
  if (!sessionNoticeNode) return;
  if (sessionNoticeTimer) {
    clearTimeout(sessionNoticeTimer);
    sessionNoticeTimer = 0;
  }
  const normalized = level === 'warning' || level === 'error' ? level : 'info';
  sessionNoticeNode.dataset.level = normalized;
  // textContent（不是 innerHTML）：换行原样保留，同时不给插件报文任何 HTML 注入面。
  sessionNoticeTextNode.textContent = typeof text === 'string' ? text : String(text ?? '');
  sessionNoticeNode.hidden = false;
  if (normalized === 'info') sessionNoticeTimer = setTimeout(clearSessionNotice, SESSION_NOTICE_INFO_MS);
}

sessionNoticeCloseNode?.addEventListener('click', clearSessionNotice);

// ── 对话内的「推荐回复」：模型建议那一排（输入框正上方）─────────────────────────────
// 服务端在**回合落定之后**另起一次模型调用生成 ≤3 条候选（也能是 0 条），把它落成**那条助手消息的
// 可选字段** `suggestions`，并同时发一帧 `session.suggestions {messageId, items}`。这一排的纪律：
//   · **可用了才出现**：只在收到事件（或刷新后从 `/messages` 读到那个可选字段）时才画；
//     没收到就一个元素都不画（**不画占位、不画 spinner**）；
//   · **陈旧 ⇒ 忽略**：候选挂在 `messageId` 上，只认**当前尾巴那条助手消息**的（旧 `messageId`
//     的事件一个字都不画）；新一轮开播（`session.start`）或发送时把目标清空 ⇒
//     上一轮那排当场消失（不许出现「上一轮的建议」）；
//   · **点击 = 直接发送**，走 `send()` 这**同一条**投递路（忙 ⇒ steer、空闲 ⇒ 普通消息）——
//     不另开第三条投递路径；
//   · 键盘：⌥1–⌥3 选那一颗，Esc / × 收起（**收起后本轮不再打扰**，新一轮的候选到达时复位）。
// 状态只有这四个（**不是乐观状态**：没有服务端给的东西就什么都不画）：
//   · `suggestionTarget` = 正文里认出的**尾巴那条助手消息**（`entryId`，候选挂在谁身上）；
//   · `suggestionItems` = 现在该画的候选（`{messageId, items}`；服务端事件给的，或 payload 字段给的）；
//   · `suggestionsCollapsedFor` = 用户收起过**哪一条**候选（`messageId`）—— 「收起只对本轮有效」：
//     同一条再来（同一轮里的事件重放）不再打扰，换一条（新一轮）自然复位。
//   · `suggestionsConsumedFor` = 已经**被用掉**的那一条（点了 chip ⇒ 这一轮的候选就消费掉了）：
//     那排**当场**收起（不等 POST 往返 —— 可见性不该由网络时延决定）；真没发出去则还回来。
let suggestionTarget = null;
let suggestionItems = null;
let suggestionsCollapsedFor = null;
let suggestionsConsumedFor = null;

/** 尾巴那条助手消息（只认 `user`/`assistant` 两种角色；中间夹的 toolResult 不影响）。
 *  尾巴之后又出现了用户消息（发送/插话）⇒ 没有尾巴 ⇒ 上一轮那排该消失。 */
function suggestionTailOf(payload) {
  const messages = payload?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return null;
    if (message?.role === 'assistant') {
      const items = Array.isArray(message.suggestions) ? message.suggestions.filter((item) => typeof item === 'string' && item !== '') : [];
      return { messageId: typeof message.entryId === 'string' ? message.entryId : null, items };
    }
  }
  return null;
}

/** 画/收那一排。可见性就五条：不在流式/压缩中、有目标、有候选、用户没收起、且这一条还**没被用掉**。 */
function renderSuggestionsRow() {
  if (!suggestionsNode || !suggestionsListNode) return 0;
  const collapsed = suggestionItems !== null && suggestionsCollapsedFor === suggestionItems.messageId;
  const consumed = suggestionItems !== null && suggestionsConsumedFor === suggestionItems.messageId;
  const active = !streaming && !compacting && suggestionTarget !== null && !collapsed && !consumed
    && suggestionItems !== null && suggestionItems.messageId === suggestionTarget.messageId;
  const items = active ? suggestionItems.items : [];
  const count = active
    ? renderSuggestions(suggestionsListNode, { items, onPick: (text) => { void pickSuggestion(text); } })
    : renderSuggestions(suggestionsListNode, { items: [] });
  suggestionsNode.hidden = count === 0;
  return count;
}

/** `/messages` 回来之后：按 payload 重建目标（并采纳它带的可选字段）。
 *  同一目标的“无字段”payload **不清空**事件已经画上的那排（可能的迟到响应：GET 先发、候选后写）。 */
function applySuggestionPayload(payload) {
  const tail = suggestionTailOf(payload);
  const previousId = suggestionTarget?.messageId ?? null;
  const changedTarget = (tail?.messageId ?? null) !== previousId;
  suggestionTarget = tail;
  if (changedTarget) {
    // 换了一条尾巴（= 新的一轮）⇒ 「已收起」「已用掉」都复位；候选照 payload 给的那份重建。
    suggestionsCollapsedFor = null;
    suggestionsConsumedFor = null;
    suggestionItems = tail !== null && tail.items.length > 0 ? { messageId: tail.messageId, items: tail.items } : null;
    return renderSuggestionsRow();
  }
  // 同一条尾巴：payload 带着字段就以它为准；**没带就不清空**事件已经画上的那排
  //（GET 先发、候选后写的迟到响应不能把那一排擦掉）。
  if (tail !== null && tail.items.length > 0) suggestionItems = { messageId: tail.messageId, items: tail.items };
  return renderSuggestionsRow();
}

/** 换会话 / 发送 / 开新轮：把这一排的现状清空（不许跟到另一条会话或上一轮去）。 */
function clearSuggestions() {
  suggestionTarget = null;
  suggestionItems = null;
  suggestionsCollapsedFor = null;
  suggestionsConsumedFor = null;
  renderSuggestionsRow();
}

/**
 * 点一颗 = 发出去：**走与打字完全同一条路**（`send`），忙闲由它自己判 steer/普通消息。
 * 「这一轮的候选被用掉」这件事在**点下去那一刻**就成立 ⇒ 那排**同步收起**（不等 POST 往返）。
 * 真没投出去（`send` 回 false）⇒ 把那条候选**还回来**（它并没被用掉）—— 于是「文字不丢」这条也成立。
 */
async function pickSuggestion(text) {
  if (typeof text !== 'string' || text === '') return;
  const messageId = suggestionItems?.messageId ?? null;
  suggestionsConsumedFor = messageId;
  renderSuggestionsRow();
  const delivered = await send(agentBusy ? 'steer' : 'message', text);
  if (delivered === false && suggestionsConsumedFor === messageId) {
    suggestionsConsumedFor = null;
    renderSuggestionsRow();
  }
}

suggestionsCloseNode?.addEventListener('click', () => {
  suggestionsCollapsedFor = suggestionItems?.messageId ?? suggestionTarget?.messageId ?? null;
  renderSuggestionsRow();
});

/** 那一排此刻真的在屏幕上吗（键盘入口只在它可见时拦截按键）。 */
function suggestionsRowVisible() {
  return !!suggestionsNode && !suggestionsNode.hidden;
}

// 键盘入口（业主拍的：⌥1–⌥3 选那一颗、Esc 收）：
//   · ⌥1–⌥3 = **点那一颗**（走同一个 click 处理器 ⇒ 走同一条投递路），只在那一排可见时生效；
//   · Esc = 收起（**只在焦点在输入框里、且命令面板/提及面板没开**时生效）—— 别的 Esc 语义
//     （设置浮层/改名/命令面板）要么在捕获阶段被拦下，要么判在前面，一个字都不改。
document.addEventListener('keydown', (event) => {
  if (!suggestionsRowVisible()) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    // `code` 优先（物理键：任何布局/输入法下 `Digit1` 都是那一颗）；退一步才看 `key`。
    const digit = /^Digit([123])$/.exec(event.code ?? '')?.[1] ?? (/^[123]$/.test(event.key ?? '') ? event.key : null);
    const chip = digit ? suggestionsListNode?.querySelector(`.suggestion-chip[data-suggestion-index="${digit}"]`) : null;
    if (chip) {
      event.preventDefault();
      chip.click();
      return;
    }
  }
  if (event.key !== 'Escape' || event.target !== promptNode) return;
  if (commandMode !== null || (mentions?.isOpen?.() ?? false)) return;
  event.preventDefault();
  suggestionsCollapsedFor = suggestionItems?.messageId ?? suggestionTarget?.messageId ?? null;
  renderSuggestionsRow();
});

renderNotice();
// P1：右栏视图的初始摆设（未选会话 ⇒ 两个页签置灰，正文那个视图生效）。
applyView();

function cancelDraftTimer(id = null) {
  if (draftTimer === null || (id !== null && draftTimerId !== id)) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  draftTimerId = null;
}

function queueDraftWrite(id, text, generation = sessionGeneration) {
  if (!id || draftUnavailable.has(id)) return Promise.resolve(true);
  const previous = draftWrites.get(id) ?? Promise.resolve(true);
  const operation = previous.catch(() => false).then(async () => {
    try {
      await api(`/sessions/${id}/draft`, { method: 'PUT', body: JSON.stringify({ text }) });
      return true;
    } catch (error) {
      if (generation === sessionGeneration && id === selectedId) notice(`草稿保存失败（不影响发送）：${error.message}`, false);
      return false;
    }
  });
  draftWrites.set(id, operation);
  operation.finally(() => {
    if (draftWrites.get(id) === operation) draftWrites.delete(id);
  });
  return operation;
}

function scheduleDraftSave() {
  if (!selectedId || !composerAvailable || readOnlySessionId === selectedId || draftUnavailable.has(selectedId)) return;
  const id = selectedId;
  cancelDraftTimer();
  draftTimerId = id;
  draftTimer = setTimeout(() => {
    draftTimer = null;
    draftTimerId = null;
    void queueDraftWrite(id, promptNode.value);
  }, DRAFT_DEBOUNCE_MS);
}

async function restoreDraft(id, generation, signal) {
  try {
    const draft = await api(`/sessions/${id}/draft`, { signal });
    if (generation !== sessionGeneration || id !== selectedId) return null;
    promptNode.value = typeof draft.text === 'string' ? draft.text : '';
    return null;
  } catch (error) {
    if (error.name === 'AbortError' || generation !== sessionGeneration || id !== selectedId) return null;
    // Old/fake APIs without the route must not turn every keystroke into another failure.
    draftUnavailable.add(id);
    return `草稿读取失败（仍可继续发送）：${error.message}`;
  }
}

function commandInput() {
  const value = promptNode.value;
  const model = /^\/model\s(\S*)$/.exec(value);
  if (model) return { kind: 'model', query: model[1] };
  const command = /^\/(\S*)$/.exec(value);
  if (command) return { kind: 'command', query: command[1] };
  return null;
}

function filteredCommands(query) {
  const lowered = query.toLowerCase();
  if (!lowered) return commands;
  return commands.filter((command) => command.name.toLowerCase().includes(lowered)
    || (command.description || '').toLowerCase().includes(lowered));
}

function filteredModels(query) {
  const lowered = query.toLowerCase();
  const matches = lowered
    ? models.filter((model) => model.ref.toLowerCase().includes(lowered)
      || model.id.toLowerCase().includes(lowered)
      || (model.name || '').toLowerCase().includes(lowered))
    : models;
  return [...matches].sort((left, right) => Number(right.current) - Number(left.current));
}

function renderCommands() {
  renderCommandPalette(commandPaletteNode, {
    open: commandMode !== null,
    mode: commandMode?.kind || 'command',
    items: commandItems,
    selectedIndex: commandIndex,
    loading: commandMode?.kind === 'model' ? modelsLoading : commandsLoading,
    error: commandMode?.kind === 'model' ? modelsError : commandsError,
    query: commandMode?.query || '',
    onChoose: chooseCommandItem,
  });
}

function closeCommands({ dismiss = false } = {}) {
  if (dismiss) commandDismissed = promptNode.value;
  commandMode = null;
  commandItems = [];
  commandIndex = 0;
  renderCommands();
}

async function loadCommands(id, generation, signal = sessionRequestController?.signal) {
  commandsFor = id;
  commands = [];
  commandsLoading = true;
  commandsError = null;
  renderCommands();
  try {
    const payload = await api(`/sessions/${id}/commands`, { signal });
    if (generation !== sessionGeneration || id !== selectedId) return;
    commands = payload.commands || [];
    commandsStreaming = payload.streaming === true;
    if (payload.builtinError) notice(`内置命令清单不完整：${payload.builtinError}`, true);
  } catch (error) {
    if (generation === sessionGeneration && id === selectedId) commandsError = `命令清单拿不到：${error.message}`;
  } finally {
    if (generation === sessionGeneration && id === selectedId) {
      commandsLoading = false;
      syncCommands();
    }
  }
}

async function loadModels() {
  const id = selectedId;
  const generation = sessionGeneration;
  const signal = sessionRequestController?.signal;
  if (!id || modelsLoading || modelsFor === id) return;
  modelsFor = id;
  models = [];
  modelsLoading = true;
  modelsError = null;
  renderCommands();
  try {
    const payload = await api(`/sessions/${id}/models`, { signal });
    if (generation !== sessionGeneration || id !== selectedId) return;
    models = payload.models || [];
    if (models.length === 0) modelsError = '这个会话没有可选模型。';
  } catch (error) {
    if (generation === sessionGeneration && id === selectedId) modelsError = `模型清单拿不到：${error.message}`;
  } finally {
    if (generation === sessionGeneration && id === selectedId) {
      modelsLoading = false;
      syncCommands();
    }
  }
}

function syncCommands() {
  const input = commandInput();
  if (!composerAvailable || input === null || promptNode.value === commandDismissed) {
    closeCommands();
    return;
  }
  mentions?.close();
  const changed = commandMode?.kind !== input.kind || commandMode?.query !== input.query;
  commandMode = input;
  if (input.kind === 'model') void loadModels();
  commandItems = input.kind === 'model' ? filteredModels(input.query) : filteredCommands(input.query);
  if (changed) commandIndex = 0;
  else if (commandIndex >= commandItems.length) commandIndex = Math.max(0, commandItems.length - 1);
  renderCommands();
}

async function setSessionModel(model) {
  const id = selectedId;
  const generation = sessionGeneration;
  try {
    const result = await api(`/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) });
    if (generation !== sessionGeneration || id !== selectedId) return;
    cancelDraftTimer(id);
    promptNode.value = '';
    resizePrompt({ reset: true });
    commandDismissed = '';
    closeCommands();
    modelsFor = null;
    const cleared = await queueDraftWrite(id, '', generation);
    if (generation !== sessionGeneration || id !== selectedId) return;
    if (cleared) notice(`模型已切到 ${result.model}（只对这条会话生效）`);
  } catch (error) {
    if (generation === sessionGeneration && id === selectedId) notice(`切模型失败：${error.message}`, true);
  }
}

function chooseCommandItem(item) {
  if (commandMode?.kind === 'model') {
    void setSessionModel(item.ref);
    return;
  }
  if (item.runnable === false) {
    notice(`「/${item.name}」在网页里不能执行：${item.reason || 'TUI 专用'}`, true);
    closeCommands({ dismiss: true });
    return;
  }
  promptNode.value = `/${item.name}${item.argumentHint || item.via === 'model' ? ' ' : ''}`;
  resizePrompt();
  commandDismissed = '';
  syncCommands();
  promptNode.focus();
}

function selectedCommand(text) {
  if (commandsFor !== selectedId || !text.startsWith('/')) return null;
  const name = text.slice(1).split(/\s/, 1)[0];
  return commands.find((command) => command.name === name) || null;
}

function resizePrompt({ reset = false } = {}) {
  if (reset || promptNode.disabled) {
    promptNode.style.height = '';
    promptNode.style.overflowY = 'hidden';
    return;
  }
  promptNode.style.height = 'auto';
  const maxHeight = parseFloat(getComputedStyle(promptNode).maxHeight);
  const height = Math.min(promptNode.scrollHeight, maxHeight);
  promptNode.style.height = `${height}px`;
  promptNode.style.overflowY = promptNode.scrollHeight > height + 1 ? 'auto' : 'hidden';
}

function updateCompactUi() {
  compactNode.disabled = !composerAvailable || readOnlySessionId === selectedId || compacting;
  compactNode.dataset.busy = String(compacting);
  compactNode.textContent = compacting ? '✂ 压缩中…' : '✂ 压缩';
  compactNode.title = compacting
    ? '正在压缩上下文；完成前不会接受新消息'
    : '有损压缩上下文（= TUI 的 /compact）；会先要求明确确认';
  renderNotice(); // 「压缩中」也是这一行的一个状态（I-12）：compact 一起一落都要重画。
}

function closeCompactConfirm() {
  compactRequest = null;
  compactConfirmNode.hidden = true;
  compactConfirmTextNode.textContent = '';
}

function askCompact(instructions = null) {
  if (!selectedId || !composerAvailable) return;
  if (compacting) {
    notice('正在压缩 —— 等这一次压完再操作。', true);
    return;
  }
  if (agentBusy) {
    notice('会话正在回复 —— 手动压缩会打断当前一轮；请等这轮结束后再压缩。', true);
    return;
  }
  const usage = typeof sessionContext?.usedTokens === 'number' ? `服务端报告当前用了 ${sessionContext.usedTokens.toLocaleString('zh-CN')} tokens。` : '服务端没有提供当前上下文 token 数。';
  const distance = typeof sessionContext?.freeTokens === 'number'
    ? (sessionContext.freeTokens >= 0 ? `距自动压缩阈值还剩 ${sessionContext.freeTokens.toLocaleString('zh-CN')} tokens。` : `已超过自动压缩阈值 ${(-sessionContext.freeTokens).toLocaleString('zh-CN')} tokens。`)
    : '距自动压缩阈值未知。';
  compactRequest = { id: selectedId, generation: sessionGeneration, instructions };
  compactConfirmTextNode.textContent = `压缩是有损的：旧上下文会换成摘要，不能撤销。${usage}${distance}${instructions ? ` 附带指示：${instructions}` : ''}`;
  compactConfirmNode.hidden = false;
  compactConfirmYesNode.focus();
}

async function runCompact() {
  const request = compactRequest;
  if (!request || request.id !== selectedId || request.generation !== sessionGeneration || compacting) return;
  closeCompactConfirm();
  compacting = true;
  updateCompactUi();
  sendNode.disabled = true;
  try {
    await api(`/sessions/${request.id}/compact`, { method: 'POST', body: JSON.stringify({ ...(request.instructions ? { instructions: request.instructions } : {}) }) });
    if (request.id !== selectedId || request.generation !== sessionGeneration) return;
    if (request.instructions !== null) {
      cancelDraftTimer(request.id);
      promptNode.value = '';
      resizePrompt({ reset: true });
      closeCommands();
      await queueDraftWrite(request.id, '');
    }
  } catch (error) {
    if (request.id !== selectedId || request.generation !== sessionGeneration) return;
    compacting = false;
    updateCompactUi();
    sendNode.disabled = !composerAvailable;
    notice(`压缩失败：${error.message}`, true);
  }
}

// M-18（删除会话）：⚠️ **不做真删除**。底层就是归档（`POST /sessions/{id}/archive {archived:true}`）——
// 这是本仓对 TUI trash 语义的诚实对应：「移出列表、且可恢复」；pi 的 trash 靠 `trash` CLI，我们靠存档箱。
// 与 TUI 一样**先要一次确认**（Ctrl+D 再确认），且**不做乐观更新**：只有服务端回执 + 重读树之后
// 那行才会换组；失败时树与按钮原地不动，错误如实报。
function closeDeleteConfirm() {
  deleteConfirmId = null;
  deleteConfirmNode.hidden = true;
  deleteConfirmTextNode.textContent = '';
}

function askDelete() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  if (!session || session.archived === true || deleteRequest) return;
  deleteConfirmId = session.id;
  deleteConfirmTextNode.textContent = `删除「${session.name || session.id}」：底层是归档 —— 会话文件不删，可以在左栏下方「存档」箱里找回。`;
  deleteConfirmNode.hidden = false;
  deleteConfirmYesNode.focus();
}

async function runDelete() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  if (!session || session.archived === true || deleteRequest || deleteConfirmId !== session.id) { closeDeleteConfirm(); return; }
  const id = session.id;
  closeDeleteConfirm();
  deleteRequest = { id };
  updateDeleteUi();
  try {
    await api(`/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) });
    try {
      await refreshTree({ markSeen: false });
      if (id === selectedId) notice('已移出列表（底层是归档，可在左栏下方「存档」箱里找回）');
    } catch (error) {
      if (id === selectedId) notice(`已移出列表，但刷新会话树失败：${error.message}`, true);
    }
  } catch (error) {
    // 失败：没有做乐观更新，所以树和这条会话原地不动，只需把原话说清楚。
    if (id === selectedId) notice(`删除失败：${error.message}`, true);
  } finally {
    if (deleteRequest?.id === id) deleteRequest = null;
    updateDeleteUi();
  }
}

function setComposerAvailable(available) {
  composerAvailable = available;
  promptNode.disabled = !available;
  sendNode.disabled = !available || compacting;
  updateCompactUi();
  if (!available) {
    closeCompactConfirm();
    closeDeleteConfirm();
    resizePrompt({ reset: true });
    abortNode.disabled = true;
    closeCommands();
    mentions?.close();
  }
}

function treeName(id) {
  return treeSessions.find((session) => session.id === id)?.name || id;
}

// M-05 / M-08：导出链接与改名入口只在选中会话时出现；只读会话不能改名（PATCH 会因 cwd 缺失被拒）。
function updateSessionActions() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  exportNode.hidden = !session;
  if (session) exportNode.setAttribute('href', `/api/sessions/${session.id}/export`);
  renameNode.hidden = !session;
  renameNode.disabled = !session || readOnlySessionId === session.id || renameRequest !== null;
}

function applySessionTitle(name = null) {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  const base = name ?? session?.name ?? selectedId ?? '';
  const suffix = session?.archived ? '（已归档）' : '';
  const state = readOnlySessionId === selectedId ? '（只读）' : openErrorId === selectedId ? '（打不开）' : '';
  titleNode.textContent = `${base}${suffix}${state}`;
}

function openRename() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  if (!session || readOnlySessionId === session.id || renameRequest) return;
  sessionTitleInputNode.value = session.name || '';
  renameFormNode.hidden = false;
  renameNode.disabled = true;
  sessionTitleInputNode.focus();
}

function closeRename() {
  renameRequest = null;
  renameFormNode.hidden = true;
  updateSessionActions();
}

function visibleTreeSessions() {
  return filterTreeSessions(treeSessions, { query: treeQuery, namedOnly: treeNamedOnly });
}

function renderTreeConnection() {
  treeConnectionNode.classList.toggle('connected', treeConnected);
  treeConnectionNode.textContent = `${treeConnected ? '● 已连接' : '○ 未连接'} · ${treeSessions.length} 个会话`;
}

function updateArchiveUi() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  archiveNode.hidden = !session;
  archiveNode.disabled = !session || archiveRequest?.id === session.id;
  archiveNode.textContent = session?.archived ? '取消存档' : '存档';
  archiveNode.title = session?.archived ? '把当前会话移回活跃树' : '把当前会话移到下方归档组';
  updateDeleteUi(); // 两个动作看到的是同一条会话，一起刷新（见 updateDeleteUi）
}

// M-18（删除会话）：入口**只在允许时可用** —— 有选中会话、且它还在活跃树里（已在存档里的没什么可删），
// 且此刻没有别的删除在飞。没选中就整个隐掉（与 `#archive` / `#rename` 同一规矩）。
function updateDeleteUi() {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  deleteNode.hidden = !session;
  const removable = Boolean(session) && session.archived !== true;
  deleteNode.disabled = !removable || deleteRequest?.id === session?.id;
  deleteNode.title = removable
    ? '把这条会话移出列表（底层是归档：会话文件不删，可在下方「存档」箱找回）'
    : '这条会话已经在存档里了 —— 用「取消存档」把它移回活跃树';
}

function setSessionConnected(connected) {
  sessionConnected = connected;
  sessionConnectionNode.classList.toggle('connected', sessionConnected);
  sessionConnectionNode.textContent = `${sessionConnected ? '● 已连接' : '○ 未连接'} · 会话流`;
}

function setNewSessionOpen(open) {
  newSessionPanelNode.hidden = !open;
  newSessionToggleNode.setAttribute('aria-expanded', String(open));
  if (open) newCwdNode.focus();
}

function openFailureMessage(error) {
  const message = error?.serverMessage || (error instanceof Error ? error.message.replace(/^\d+\s+/, '') : String(error));
  const cwd = /session cwd does not exist or is not a directory:\s*(.+)$/i.exec(message)?.[1]?.trim();
  return cwd
    ? `这个会话打不开：它的工作目录已不存在（${cwd}）`
    : `这个会话打不开：${message}`;
}


function treeBackoffDelayMs(attempt) {
  const base = Math.min(TREE_BACKOFF_MAX_MS, TREE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  // 抖动取 50%–100%：多棵前端同时重试时不会对齐成新的脉冲。
  return Math.min(TREE_BACKOFF_MAX_MS, Math.round(base * (0.5 + Math.random() * 0.5)));
}

function scheduleTreeRetry(delayMs) {
  if (treeBackoffTimer !== null) return; // 退避期间只留一个到点重试
  treeBackoffTimer = setTimeout(() => {
    treeBackoffTimer = null;
    queueTreeRefresh();
  }, delayMs);
}

async function refreshTree({ markSeen = true } = {}) {
  treeRefreshQueued = false;
  // 单飞：正在飞的那次没回来前，不再开第二个同 URL 请求。
  if (treeRequest) return treeRequest;
  const now = Date.now();
  if (now < treeBackoffUntil) {
    scheduleTreeRetry(treeBackoffUntil - now);
    return null;
  }
  const requestGeneration = ++treeRequestGeneration;
  treeRequest = (async () => {
    try {
      const payload = await api('/tree');
      if (requestGeneration !== treeRequestGeneration) return null;
      treeBackoffAttempt = 0;
      treeBackoffUntil = 0;
      // worker 的索引**还没建完**时会先回一份部分视图（`partial: true`：行都对、只是可能少）。
      // 拿它去顶掉手上这份完整的树 = 会话在界面上「消失」一下 —— 那比等一下更坏。
      // 所以：手上已经有行时**不落地**这份部分视图，到点再问（worker 那边扫描在接着跑）。
      // 手上还没行（刚打开页面 / 刚换会话集）时照常落地：少几条也比一片空白好。
      if (payload.partial === true && treeSessions.length > 0) {
        scheduleTreeRetry(TREE_PARTIAL_RETRY_MS);
        return false;
      }
      treeSessions = payload.sessions || [];
      renderTreeConnection();
      renderSessionTree();
      updateArchiveUi();
      updateSessionActions();
      if (selectedId) {
        const selected = treeSessions.find((session) => session.id === selectedId);
        if (selected) titleNode.textContent = `${selected.name || selected.id}${selected.archived ? '（已归档）' : ''}${readOnlySessionId === selectedId ? '（只读）' : openErrorId === selectedId ? '（打不开）' : ''}`;
        if (markSeen && isFollowingBottom()) void markSeenIfVisible(selectedId, sessionGeneration);
      }
      return true;
    } catch (error) {
      treeBackoffAttempt += 1;
      const delay = treeBackoffDelayMs(treeBackoffAttempt);
      treeBackoffUntil = Date.now() + delay;
      scheduleTreeRetry(delay);
      const seconds = Math.max(1, Math.round(delay / 1000));
      notice(`会话树暂时拿不到（${error.message}）· 约 ${seconds} 秒后重试（已退避第 ${treeBackoffAttempt} 次）`, true);
      return false;
    } finally {
      treeRequest = null;
    }
  })();
  return treeRequest;
}

function renderSessionTree() {
  renderTree(treeNode, visibleTreeSessions(), selectSession, {
    expanded: expandedBranches,
    collapsed: collapsedBranches,
    atticOpen,
    selectedId,
    knownIds: new Set(treeSessions.map((session) => session.id)),
    sortMode: treeSortMode,
    emptyText: treeQuery || treeNamedOnly ? '没有匹配的会话。' : '还没有会话。',
    onFoldToggle(id, effectiveOpen) {
      if (effectiveOpen) {
        expandedBranches.delete(id);
        collapsedBranches.add(id);
      } else {
        collapsedBranches.delete(id);
        expandedBranches.add(id);
      }
      renderSessionTree();
    },
    onAtticToggle() {
      atticOpen = !atticOpen;
      renderSessionTree();
    },
  });
}

// 选中高亮要跟手：selectSession 不重建整棵树（重建只走 refreshTree/renderSessionTree），
// 所以这里只翻转已有行的 class，把刚点中的那行立刻点亮（不额外拉 /tree）。
function paintTreeSelection() {
  for (const row of treeNode.querySelectorAll('.tree-session')) {
    const on = row.dataset.sessionId === selectedId;
    row.classList.toggle('selected', on);
    if (on) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

async function refreshDevices() {
  const payload = await api('/devices');
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  devicesNode.replaceChildren();
  devicePanelNode.hidden = !payload.exists || devices.length === 0;
  if (devicePanelNode.hidden) return;
  for (const device of devices) {
    const node = document.createElement('div');
    node.className = `device${device.lastProbe?.ok === true ? ' device-ok' : device.lastProbe?.ok === false ? ' device-failed' : ''}`;
    const status = device.lastProbe?.ok === true ? '最近探活成功' : device.lastProbe?.ok === false ? `探活失败：${device.lastProbe.error}` : '尚未探活';
    node.textContent = `${device.name} · ${device.host} · ${status}`;
    devicesNode.append(node);
  }
}

// ── 配置（`docs/design/design-settings.md` v1）：思考折叠的**全局默认**由服务端说话 ─────────────────
// 启动时先拿一次 `GET /settings`，把**服务端算好的生效值**交给 `render.js`（它只存，不推算）。
// 为什么要在开第一条会话**之前**拿到：thinking 块一旦按错的默认画下去，用户会先看见一个闪烁。
// 失败一律**退化到既有行为**（`'expanded'`，与 pi TUI 的默认一致）—— 端点不在（老的/假的 API）
// 只是拿不到设置，不该把整个页面拖垮；但**除 404/405 之外的错要如实说出来**（拿不到 ≠ 没这回事）。
async function refreshSettings() {
  try {
    const payload = await api('/settings');
    setThinkingDefaultFold(payload?.settings?.['thinking.defaultFold']);
  } catch (error) {
    const status = error?.status;
    if (status !== 404 && status !== 405) notice(`读配置失败（思考折叠的全局默认按默认展开）：${error.message}`, true);
  }
}

function queueTreeRefresh() {
  if (treeRefreshQueued) return;
  treeRefreshQueued = true;
  queueMicrotask(() => refreshTree().catch((error) => notice(error.message, true)));
}

function isFollowingBottom() {
  return messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight <= 4;
}

function syncBottomFollow(known) {
  const following = known === undefined ? isFollowingBottom() : known;
  jumpNode.classList.toggle('show', !following);
  jumpNode.setAttribute('aria-hidden', String(following));
  jumpNode.tabIndex = following ? -1 : 0;
  return following;
}

function scrollToBottom() {
  messagesNode.scrollTop = messagesNode.scrollHeight;
  syncBottomFollow();
}

async function markSeenIfVisible(id = selectedId, generation = sessionGeneration) {
  // P1：人在问题页时**不**上报已读 —— 正文那半看不见（虽然几何上还“贴底”），此时把新内容
  // 标成已读就是未读闭环被偷走。切回会话页时会再补一次（见 setView）；
  // 切页本身不碰 `seen`，所以未读状态在切页期间照旧累积。
  if (currentView() !== VIEW_SESSION) return;
  const node = treeSessions.find((session) => session.id === id);
  if (!id || generation !== sessionGeneration || id !== selectedId || visibleMessagesId !== id || !node?.unread || !isFollowingBottom() || seenInFlight.has(id)) return;
  seenInFlight.add(id);
  try {
    await api(`/sessions/${id}/seen`, { method: 'POST', body: '{}' });
    if (generation === sessionGeneration && id === selectedId) await refreshTree();
  } catch (error) {
    if (generation === sessionGeneration && id === selectedId) notice(`标记已读失败：${error.message}`, true);
  } finally {
    seenInFlight.delete(id);
  }
}

function messagePlainText(message) {
  if (Array.isArray(message?.parts)) return message.parts.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
  return '';
}

/** 历史消息里 thinking 通道的整段文字（与 `messagePlainText` 对称）—— 接管 thinking 前缀要用。 */
function messageThinkingText(message) {
  if (Array.isArray(message?.parts)) return message.parts.filter((part) => part?.type === 'thinking').map((part) => part.text || '').join('');
  if (Array.isArray(message?.content)) return message.content.filter((part) => part?.type === 'thinking').map((part) => part.thinking || '').join('');
  return '';
}

/** 某个通道**已收到的全部内容**（同通道的多段按到达顺序拼起来，与历史的 join 口径一致）。 */
function liveChannelText(type) {
  return liveParts.filter((part) => part.type === type).map((part) => part.text).join('');
}

function advanceLiveCoverage() {
  if (!liveActive) return;
  // 只在**历史真的变了**之后重算：这个函数要把历史助手正文整段 join 再 startsWith 比一遍，
  // 是 O(历史正文)。v2.2 原来每个 delta 都调它（920 次/一条回复）；历史在一次流式里只变几次，
  // 用「可见消息版本号」做闸，未变就直接早退（O(1)）。
  if (liveCoverageVersion === visibleMessagesVersion) return;
  liveCoverageVersion = visibleMessagesVersion;
  const thinkingText = liveChannelText('thinking');
  const text = liveChannelText('text');
  const liveToolIds = new Set(liveParts.filter((part) => part.type === 'tool' && part.toolCallId).map((part) => part.toolCallId));
  const uncoveredTool = [...liveToolIds].some((id) => !liveCoveredTools.has(id));
  if (liveCoveredThinking >= thinkingText.length && liveCoveredText >= text.length && !uncoveredTool) return;
  const assistant = visibleMessages.slice(liveStartIndex).filter((message) => message.role === 'assistant');
  if (liveCoveredThinking < thinkingText.length) {
    const historyThinking = assistant.map(messageThinkingText).join('');
    if (historyThinking.length >= liveCoveredThinking && thinkingText.startsWith(historyThinking)) liveCoveredThinking = historyThinking.length;
  }
  if (liveCoveredText < text.length) {
    const historyText = assistant.map(messagePlainText).join('');
    if (historyText.length >= liveCoveredText && text.startsWith(historyText)) liveCoveredText = historyText.length;
  }
  // 工具按 **toolCallId** 接管（不比 args：历史那份与直播那份来自同一条 toolCall，id 相同即同一张卡）。
  for (const message of assistant) for (const part of message.parts || []) {
    if (part.type === 'tool' && part.toolCallId && liveToolIds.has(part.toolCallId)) liveCoveredTools.add(part.toolCallId);
  }
}

/** 历史里还有服务端标着「在跑」的工具吗 —— 有就说明屏幕上已经有张在跑的卡了，
 *  这时再补一句「思考中…」就是骗人（与 v2.1 `histToolRunning()` 同一条判据）。 */
function histToolRunning() {
  for (const message of visibleMessages) for (const part of message.parts || []) if (part.type === 'tool' && part.status === 'running') return true;
  return false;
}
/** 直播块：**一个持久节点**（article + label + 按到达顺序的 part 节点）。
 *  历史刷新会 replaceChildren 把这块摘掉 ⇒ 这里按 isConnected 重新挂，别每次都重建。
 *  ⚠️ 它是**包装节点**（`display: contents` ⇒ 自身不产生盒子），里面装的是一组**顶层块**，
 *  与结束态同一套形状（`web/render.js` 的 `assistantBlocks()`）：连续的非工具 part =.assistant 段
 *  （`article.message.message-assistant`），每个工具 part = 顶层 `section.tool-card`（同一个 `toolCard()`）。
 *  ⇒ 流式期间「思考段 / 工具段」之间就已经是**块边界**，与结束态长得一样（收尾不闪现）。 */
function ensureLiveNode() {
  if (liveNode?.isConnected) return;
  liveNode = document.createElement('div');
  liveNode.className = 'live-message';
  liveNode.dataset.kind = 'live';
  messagesNode.append(liveNode);
  // 重新挂载 ⇒ 旧节点已经不在文档里了，对账表与占位都从头来。
  liveBlocks = [];
  liveThinkNode = null;
  // 落位：它得在「正文/扩展块」之后，但要在**这一块期间发出去的插话占位**之前（见 restackTransient）。
  restackTransient();
}

/** 活跃直播块的落位锚：所有「说话顺序在它之前」的节点都插到它**之前**（见 restackTransient）。
 *  已经收口的 `live-done` 块不算（它此刻就是「正文还没到的历史」，留在原位不许动）。 */
function liveTailAnchor() {
  return liveNode?.isConnected ? liveNode : null;
}

/** 屏幕上还有「已收口、等正文接管」的直播块吗（见 `splitLive` 的收口与 `refreshMessagesOnce` 的增量闸）。 */
function liveDonePending() {
  for (const node of liveDoneNodes) if (!node.isConnected) liveDoneNodes.delete(node);
  return liveDoneNodes.size > 0;
}

/** #messages 尾部那两种**临时节点**的落位：正文/扩展块 → 直播块 → 插话占位。
 *
 *  为什么需要这个函数：直播块是**一个持久节点**，而正文/占位都是后来才 append 进容器的 —— 一律
 *  `append` 就是「谁后到谁排在最后」，于是**直播块会被后来到的 user 正文（或它自己的占位）挤到
 *  上面去**：业主 2026-09-20 在真实例网页上看到的就是这个（发一条消息 ⇒ 流式回复出现在我的消息
 *  上面）。落位得按**说话顺序**算，不能按「谁先 append」：
 *   · 占位消息在 `send()` 那一刻就带上了它自己的坐标 `blockToken`（发它的时候哪一块直播在跑，
 *     没有就是 0）与 `afterBlock`（这条是**插话/排队**语义吗 —— pi 把它注入到当前这一段之后，
 *     所以它的正文排在那块直播之后；见 `send()` 里 `landed` 那一步）；
 *   · 占位排在活跃直播块**之后** ⇔ 它是插话（`afterBlock`）**且**它是在**这一块**期间发出去的
 *     （`blockToken === liveBlockToken`）。两块之间就换了坐标：插话注入之后新起的那一块（token 变了）
 *     必须排在它**后面** —— 那才是正文里的顺序。
 *  顺序已经对了就一个节点都不动（不做无谓的 DOM 写，别给滚动/观测台加噪音）。 */
function restackTransient() {
  const live = liveTailAnchor();
  const afterLive = (entry) => live !== null && liveBlockToken > 0 && entry.afterBlock === true && entry.blockToken === liveBlockToken;
  const tail = [];
  for (const entry of pendingUser) if (!afterLive(entry)) tail.push(entry.node);
  if (live) tail.push(live);
  for (const entry of pendingUser) if (afterLive(entry)) tail.push(entry.node);
  // 只在**顺序真的不对**（或节点压根还没进容器 —— 刚建好的占位就是这种）时才动 DOM：
  // 顺序已经对了就是一个写都没有 —— 直播块是每帧都重画一次的（`renderLive`），多写一次就是一个可量的抖动。
  let cursor = null;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const node = tail[index];
    if (node.parentNode !== messagesNode || node.nextSibling !== cursor) messagesNode.insertBefore(node, cursor);
    cursor = node;
  }
}

function dropLiveNode() {
  liveNode?.remove();
  liveNode = null;
  liveBlocks = [];
  liveThinkNode = null;
}

/** 直播 part 的**身份键**：类型 / 顺序没变就复用 DOM（帧间只写增量）。
 *  工具卡把状态与结果长度并进 key ⇒ 工具一结束（running→done）key 就变，
 *  于是在**原位**重建那一张卡（不动它前后的 part，也不是整块重建）。 */
function livePartKey(part) {
  if (part.type !== 'tool') return part.type;
  // `live`（实时尾）只把**有没有**并进 key —— 具体文本**绝不进** key，否则每个增量帧都会重建卡片
  // （用户展开的命令会被 ≈10 帧/秒的增量一次又一次收回去）。文本由 `updateLiveOutput()` 就地写。
  return `tool:${part.toolCallId ?? ''}:${part.status ?? ''}:${part.isError === true ? 'e' : ''}:${(part.result ?? '').length}:${part.live ? 'L' : '-'}`;
}

/** 一个 part 的**持久节点**：思考沿用历史那一套结构（`.message-thinking` > 折叠头 + `.thinking-body`，
 *  与 `web/render.js` 的 `messageBody` 同形），正文就是一个持久文本节点（与原来一致，
 *  帧间走 appendData 增量），工具直接调 `web/render.js` 的 `toolCard()` —— **与结束后的正式卡同一个函数**。
 *  ⚠️ 正文**不**包 markdown 容器：以前直播正文就是 `.message-body` 的直接文本子节点，包一层会改高度
 *  保持一致优先，不为了美观动它。（结束态那一段的正文走 `renderMarkdown` ⇒ 叶子形状不同，但**块**的形状
 *  与顺序一致；这是本门「结构 ≡」口径里明确排除的一项，见 test/live-segments.mjs。）
 *  `ordinal` 由调用方按**整块直播**里的第几个 thinking / tool 数出来（与正式正文的稳定编号同口径）。 */
function livePartNode(part, ordinal) {
  if (part.type === 'thinking') {
    const wrap = document.createElement('div');
    wrap.className = 'message-thinking';
    const head = document.createElement('div');
    head.className = 'message-thinking-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'thinking-toggle';
    toggle.dataset.thinkingToggle = 'true';
    const content = document.createElement('div');
    content.className = 'thinking-body';
    const textNode = document.createTextNode('');
    content.append(textNode);
    // 折叠态**不放在节点上**（工具卡就地重建/正文重画都会造新节点）——用 render.js 的会话级容器。
    // 直播 part 没有 entryId，所以按「这块直播里第几个 thinking part」编号（与正式正文同编号）；
    // 正文交接时 render.js 会把桥上的值落到那条 assistant 消息自己的稳定键上。
    const bridgeKey = liveBridgeKey(part, ordinal);
    const view = { thinking: wrap, toggle, content };
    applyThinkingState(view, liveCollapseGet(messagesNode, bridgeKey, liveStartIndex));
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = wrap.dataset.collapsed !== 'true';
      applyThinkingState(view, next);
      liveCollapseSet(messagesNode, bridgeKey, next, liveStartIndex);
    });
    head.append(toggle);
    wrap.append(head, content);
    return { type: 'thinking', key: 'thinking', node: wrap, textNode, rendered: '' };
  }
  if (part.type === 'tool') {
    // 直播工具卡与正式卡**同一个函数**；折叠态走桥（键 = `toolCallId`）。不然工具一结束
    // （running→done ⇒ key 变 ⇒ 节点原位重建）或流式→正式交接后，收起态会弹回去。
    const card = toolCard(document, part, liveToolContext(messagesNode, part, ordinal, liveStartIndex, selectedId));
    applyAnnotationMarks(card);
    return { type: 'tool', key: livePartKey(part), node: card, textNode: null, rendered: '' };
  }
  const textNode = document.createTextNode('');
  return { type: 'text', key: 'text', node: textNode, textNode, rendered: '' };
}

/** 历史上接管到哪就从直播块里切掉：两个通道**各自按前缀**，工具按 toolCallId。
 *  宁可多画一份，也绝不因为对不齐而把内容吞掉（与 v2.1 同方向）。 */
function liveVisibleParts() {
  let thinkingBudget = liveCoveredThinking;
  let textBudget = liveCoveredText;
  const out = [];
  for (const part of liveParts) {
    if (part.type === 'tool') {
      if (part.toolCallId && liveCoveredTools.has(part.toolCallId)) continue;
      out.push(part);
      continue;
    }
    const budget = part.type === 'thinking' ? thinkingBudget : textBudget;
    if (part.type === 'thinking') thinkingBudget = Math.max(0, thinkingBudget - part.text.length);
    else textBudget = Math.max(0, textBudget - part.text.length);
    const text = budget >= part.text.length ? '' : part.text.slice(budget);
    if (text) out.push({ type: part.type, text });
  }
  return out;
}

/** 直播块里的**顶层块**（与 `web/render.js` 的 `assistantBlocks()` 同形状，只是把"非工具段"这里的
 *  标记换成 `.live-segment`、角标写 `assistant · streaming`）：连续的非工具 part 合成一个 assistant 段。
 *  只有**第一段**带标注按钮（与结束态 `primary` 同口径：同一条消息只留一个锚）。 */
function liveSegmentBlock(parts, ordinals, primary) {
  const article = document.createElement('article');
  article.className = 'message message-assistant live-segment';
  article.dataset.kind = 'live-segment';
  const label = document.createElement('div');
  label.className = 'message-role';
  label.textContent = 'assistant · streaming';
  const body = document.createElement('div');
  body.className = 'message-body';
  article.append(label, body);
  const record = { kind: 'segment', key: `segment:${parts.map(livePartKey).join('|')}`, node: article, body, parts: [] };
  for (const part of parts) {
    const node = livePartNode(part, ordinals.get(part));
    body.append(node.node);
    record.parts.push(node);
  }
  if (primary) {
    // 卡片级反馈（annotations）：与旧直播块同一条锚（messageId 此刻还没有 ⇒ null，blockIndex 兜底）。
    article.append(annotationControl(document, {
      kind: 'message',
      sessionId: selectedId,
      messageId: null,
      blockIndex: visibleMessages.length,
      role: 'assistant',
    }));
    applyAnnotationMarks(article);
  }
  return record;
}

/** 提交一帧。**只在 rAF 里跑**（delta 路径只入队），所以：
 *  ① 每帧最多一次 DOM 写 + 一次布局读；② 正文走 `appendData` 增量，不重建节点、不整块重写。 */
function renderLive({ follow = false } = {}) {
  if (!liveActive) {
    if (liveNode) dropLiveNode();
    return;
  }
  advanceLiveCoverage();
  const visible = liveVisibleParts();
  // 「思考中…」只在**真的什么都没得画**时出现：直播块一个 part 都没有、历史里也没有在跑的工具。
  // 一旦有内容（或历史已接管内容）就撤掉占位，绝不和 part 抢位置。
  const showThinking = !visible.length && liveParts.length === 0 && !histToolRunning();
  if (!visible.length && !showThinking) {
    if (liveNode) dropLiveNode();
    return;
  }
  ensureLiveNode();
  if (showThinking) {
    if (!liveThinkNode) {
      const article = document.createElement('article');
      article.className = 'message message-assistant live-segment';
      article.dataset.kind = 'live-segment';
      const label = document.createElement('div');
      label.className = 'message-role';
      label.textContent = 'assistant · streaming';
      const body = document.createElement('div');
      body.className = 'message-body';
      liveThinkNode = document.createElement('div');
      liveThinkNode.className = 'think';
      liveThinkNode.dataset.think = 'live';
      liveThinkNode.textContent = '✻ 思考中…';
      body.append(liveThinkNode);
      article.append(label, body);
      liveNode.append(article);
      liveBlocks = [{ kind: 'segment', key: 'segment:think', node: article, body, parts: [] }];
    }
    if (follow) {
      messagesNode.scrollTop = messagesNode.scrollHeight;
      syncBottomFollow(true);
    } else syncBottomFollow();
    return;
  }
  // 占位段已由下面的 key 对账换掉（它的 key 是 `segment:think`，与真内容不匹配）。
  liveThinkNode = null;
  // ① 按到达顺序切块：连续非工具 part = 一个 assistant 段；每个工具 part = 一张顶层工具卡。
  const plan = [];
  let run = null;
  for (const part of visible) {
    if (part.type === 'tool') {
      if (run) { plan.push({ kind: 'segment', parts: run }); run = null; }
      plan.push({ kind: 'tool', parts: [part] });
    } else {
      if (!run) run = [];
      run.push(part);
    }
  }
  if (run) plan.push({ kind: 'segment', parts: run });
  // 折叠态桥的编号按**整块直播**里第几个 thinking / tool 数（与正式正文的稳定编号同口径）。
  const ordinals = new Map();
  let thinkingOrdinal = 0;
  let toolOrdinal = 0;
  for (const block of plan) for (const part of block.parts) {
    if (part.type === 'thinking') ordinals.set(part, thinkingOrdinal++);
    else if (part.type === 'tool') ordinals.set(part, toolOrdinal++);
  }
  const keyOf = (block) => (block.kind === 'tool' ? `tool:${livePartKey(block.parts[0])}` : `segment:${block.parts.map(livePartKey).join('|')}`);
  // ② 对齐节点表：key（块类型/段成分/工具卡状态）没变就复用（帧间只写增量），变了才把该位置之后的块重建。
  let shared = 0;
  while (shared < plan.length && shared < liveBlocks.length && liveBlocks[shared].key === keyOf(plan[shared])) shared += 1;
  if (shared < liveBlocks.length) {
    for (let index = shared; index < liveBlocks.length; index += 1) liveBlocks[index].node.remove();
    liveBlocks.length = shared;
  }
  const primaryIndex = plan.findIndex((block) => block.kind === 'segment');
  for (let index = shared; index < plan.length; index += 1) {
    const block = plan[index];
    const record = block.kind === 'tool'
      ? (() => { const node = livePartNode(block.parts[0], ordinals.get(block.parts[0])); return { kind: 'tool', key: `tool:${node.key}`, node: node.node, body: null, parts: [node] }; })()
      : liveSegmentBlock(block.parts, ordinals, index === primaryIndex);
    liveNode.append(record.node);
    liveBlocks.push(record);
  }
  // ③ 段内正文走 appendData 增量（与原来一致）。
  for (let index = 0; index < plan.length && index < liveBlocks.length; index += 1) {
    const block = liveBlocks[index];
    if (block.kind !== 'segment') continue;
    for (let partIndex = 0; partIndex < plan[index].parts.length; partIndex += 1) {
      const node = block.parts[partIndex];
      if (!node?.textNode) continue;
      const text = plan[index].parts[partIndex].text;
      if (text === node.rendered) continue;
      if (text.startsWith(node.rendered)) node.textNode.appendData(text.slice(node.rendered.length));
      else node.textNode.data = text;
      node.rendered = text;
    }
  }
  // ④ 工具块的**实时尾**：`session.tool_update` 是累积快照 ⇒ 拿最新那份**替换**尾的内容。
  //    这一条**不重建卡片**（卡片 key 只在状态/结果变化时变）—— 否则用户展开的命令每帧都会被收回去。
  for (let index = 0; index < plan.length && index < liveBlocks.length; index += 1) {
    const block = liveBlocks[index];
    if (block.kind !== 'tool') continue;
    updateLiveOutput(block.node, plan[index].parts[0].live ?? null);
  }
  if (follow) {
    messagesNode.scrollTop = messagesNode.scrollHeight;
    syncBottomFollow(true);
  } else syncBottomFollow();
}

/** delta 只入队：一帧里无论收到多少个 delta，都只提交一次（v2.1 的调度器做法）。 */
function scheduleLive() {
  if (!liveActive || liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    renderLive({ follow: isFollowingBottom() });
  });
}

/** 一份正文「是不是跟屏幕上那份同一份」的指纹 —— 口径抄 v2.1 的 histSig（`v2.1-final:web/app.mjs:1205`）：
 *  条数 + 每条的身份证 + 压缩边界 + 扩展消息；**末尾那一条的形状也要进指纹**，因为工具卡会从
 *  running 变 done（entryId 不变、内容变了，光看 entryId 看不见）。没有 entryId 的合成数据
 *  回落到「角色 + 文本长度 + parts 形状」。
 *
 *  为什么要有它：切会话之后 SSE 初连必发一条 session.snapshot（server/base-logic.mjs:3535），
 *  前端收到就再拉一次 /sessions/{id}/messages —— 回来的是逐字节相同的一份。
 *  v2.1 拿 histSig 比过之后**不重画**；v2.2 少了这道闸，于是每次切会话正文都被重建两遍
 *  （实测：400 条的会话插了 800 个节点、可见批次 4 批，见 test/switch-session-paint.mjs）。 */
function historySignature(payload) {
  const messages = payload?.messages ?? [];
  const extras = payload?.extras ?? [];
  const keys = new Array(messages.length + 1);
  keys[0] = `n${messages.length}`;
  for (let index = 0; index < messages.length; index += 1) keys[index + 1] = wireKey(messages[index]);
  const compaction = payload?.compaction;
  keys.push(`cut:${compaction?.entryId ?? ''}:${compaction?.atIndex ?? -1}:${compaction?.tokensBefore ?? -1}`);
  // M-33：分支摘要也是正文流里的一等公民（`.compaction-note[data-kind=branch_summary]`）。
  // 它的改变（切分支生成/换一条）必须进指纹，否则重拉回来同一份会被误判成「没变」而不重画。
  const summaries = payload?.branchSummaries ?? [];
  keys.push(`bs${summaries.length}:${summaries.map((entry) => `${entry?.entryId ?? ''}@${entry?.atIndex ?? -1}`).join('|')}`);
  keys.push(`x${extras.length}:${extras.map((extra) => wireKey(extra)).join('|')}`);
  return keys.join('|');
}

/** 一条消息 / 扩展消息的身份证：entryId（真数据全都有）+ 它那些 part 的形状。 */
function wireKey(item) {
  if (!item) return '';
  let shape = '';
  if (Array.isArray(item.parts)) {
    for (const part of item.parts) {
      // tool 卡的 result 长度与状态都要进指纹：跑着→完成时 entryId 没变，只有这两个变了。
      if (part?.type === 'tool') shape += `t${part.status ?? ''}:${typeof part.result === 'string' ? part.result.length : -1};`;
      else shape += `p${part?.type ?? ''}:${typeof part?.text === 'string' ? part.text.length : -1};`;
    }
  }
  const identity = item.entryId ? item.entryId : `${item.role ?? item.customType ?? ''}#${typeof item.text === 'string' ? item.text.length : -1}`;
  // 收尾/出错/中断的标记也要进指纹：它们一变，正文上就多出（/少掉）一行字。
  const ending = `${item.stopReason ?? ''}:${item.aborted === true ? 'a' : ''}${item.errorMessage ? 'e' : ''}`;
  return `${identity}~${shape}~${ending}`;
}

/** 一条消息「以后不会再变」的判据（只用来挑尾部增量的游标，**保守没关系**：少算只会多拉几条）。
 *  为什么不能拿「最后一条」当游标：服务端还会改写它 —— 工具结果落地会把 `running` 改成
 *  `done-*`、流式助手消息的 `stopReason` 也是后来才写上的。 */
function messageSettled(item) {
  if (!item || typeof item.entryId !== 'string' || item.entryId === '') return false;
  if (item.role !== 'assistant') return true; // user / toolResult / 摘要类：一次写死
  if (typeof item.stopReason !== 'string' || item.stopReason === '') return false;
  for (const part of item.parts ?? []) {
    if (part?.type !== 'tool') continue;
    if (part.status !== 'done-success' && part.status !== 'done-error') return false;
  }
  return true;
}

/** 尾部增量的游标：最后一条**已定稿**的消息（服务端 `?after=` 认的就是它的 entryId）。 */
function tailCursorOf(messages) {
  let index = messages.length - 1;
  while (index >= 0 && !messageSettled(messages[index])) index -= 1;
  if (index < 0) return null;
  return { index, entryId: messages[index].entryId };
}

/** 尾部增量能不能用：**只**在能证明「屏幕上那份正文就是服务端这一版的严格前缀」时才返回 non-null。
 *  任何一条对不上就返回 null ⇒ 调用方拿着整份（这一版没带 `tail`）走替换，与没有这个机制时逐字相同。
 *  这里只查「手跟前缀/游标/下标」这一半；extra 落位与压缩边界那一半在 render.js 的
 *  `appendMessageNodes` 里（它自己会说不满足）。 */
function tailBase(id) {
  if (!id || id !== selectedId || id !== visibleMessagesId) return null;
  const payload = renderedPayload;
  if (!payload || payload.sessionId !== id) return null;
  // 旧消息还在空闲期分片补进顶部时，容器里最后那个节点并不对应最后一条消息 —— 这时候不拼。
  if (messagesNode.dataset.renderComplete !== 'true') return null;
  const messages = payload.messages ?? [];
  const cursor = tailCursorOf(messages);
  // 游标必须是**手上那份的最后一条**：否则增量要求先换掉已画的那几条（那是替换，不是 append）。
  if (!cursor || cursor.index !== messages.length - 1) return null;
  return { payload, cursor };
}

/** 扩展消息合并：老的保序，新的按服务端给的顺序接在后面（同一 entryId 只留一份）。 */
function mergeExtras(previous = [], incoming = []) {
  const seen = new Set(previous.map((extra) => extra?.entryId));
  const merged = [...previous];
  for (const extra of incoming) {
    if (extra?.entryId && seen.has(extra.entryId)) continue;
    if (extra?.entryId) seen.add(extra.entryId);
    merged.push(extra);
  }
  return merged;
}

/** 把服务端回的尾部增量拼成**一整份**（与整份拉取逐字同形：多出的 `tail` 标记在这里拿掉）。
 *  返回 null ⇒ 这一版拼不了（不是增量、游标对不上、下标对不上、压缩边界落在正文中间）。 */
function tailMerge(payload, base) {
  const tail = payload?.tail;
  const previous = base?.payload;
  if (!tail || !previous) return null;
  if (payload.sessionId !== previous.sessionId) return null;
  if (tail.afterEntryId !== base.cursor.entryId) return null;
  if (tail.from !== base.cursor.index + 1 || tail.from !== (previous.messages ?? []).length) return null;
  if (tail.total !== tail.from + (payload.messages ?? []).length) return null;
  // 压缩边界：没动就照旧；动了只接受它落在增量区里（否则那个块要插回正文中间 —— 只能整份重画）。
  const before = previous.compaction ?? {};
  const after = payload.compaction ?? {};
  if (before.entryId !== after.entryId || before.atIndex !== after.atIndex) {
    if (typeof after.atIndex !== 'number' || after.atIndex < tail.from) return null;
  }
  // M-33：分支摘要同理，但更保守 —— 只要集合/位置变了就整份重画（它本来就是切分支时才生的，
  // 平时不会变；保守处理比琢磨「能不能只在尾部 append 一块」稳得多）。
  const summaryKey = (payload) => (payload.branchSummaries ?? []).map((entry) => `${entry?.entryId ?? ''}@${entry?.atIndex ?? -1}`).join('|');
  if (summaryKey(previous) !== summaryKey(payload)) return null;
  const merged = { ...payload, messages: [...(previous.messages ?? []), ...(payload.messages ?? [])], extras: mergeExtras(previous.extras, payload.extras) };
  delete merged.tail;
  return merged;
}

/** 同一份正文的并发拉取合并（见 refreshMessages）：初连时「选中会话」与「初连快照」几乎同时
 *  要正文，`coalesce:true` 的两次只发一次 GET、只画一遍。 */
let messagesRefreshInFlight = null;

/** 这次连接「hello」的正文拉取账：同一个 EventSource 连接里，初连（选中会话 + 首帧快照）
 *  只允许发一次 GET。为什么光有 `messagesRefreshInFlight` 不够（2026-09-19 实测）：
 *  `session.snapshot` 要等 `/events` 那边把 runtime 打开（大会话上秒级），而 `/messages` 命中
 *  响应体缓存时只要几十毫秒 ⇒ **第一条 GET 先回来**、在飞记录已经清空，快照那次就**又发一条**
 *  （实测大会话：两条全量 10 104 771 B / 10 104 771 B，相隔 ~340 ms；小会话：一条全量 + 一条
 *  `?after=` 增量）—— 同一份正文白拉第二遍。
 *  `refreshed` = 这次 hello 已经发出的那一个拉取 promise（null = 还没发）；`snapshots` 数这一
 *  连接上收到过几帧快照：**只有初连那一帧**可以复用（同一连接上后来的快照是服务端重同步，
 *  必须真拉）。EventSource **重连**（`onopen` 第二次）会把两个字段都清回去，因为重连那条快照
 *  也必须真拉一次（断线期间的正文要补回来）。
 *  ⚠️ 只有**两端都空闲**时才允许复用（`busy` / 快照的 `isStreaming`）：服务端登记 SSE 订阅是
 *  在它把 runtime 打开之后（`server/base-logic.mjs` 的 `sessionEvents`：`pool.acquire` →
 *  `adapter.subscribe` → 发快照），所以「正文还在写」的那一段时间里，真的可能有落盘内容既没
 *  被我们这条 GET 拿到、又没赶上订阅 ⇒ 那时候第二拉是**必须的**，宁可多拉一次也不丢正文。 */
let sessionHello = null;

/** 拉正文并（按指纹）决定要不要重画。
 *  `coalesce:true` 时：同一 id+generation 已有在飞的拉取 ⇒ 复用那一个（不再发第二次）；
 *  这次 hello 已经拉过（第一条 GET 先回来了）且**全程空闲**也复用那一个。
 *  为什么需要它：`selectSession` 与 SSE 初连必发的 `session.snapshot`（server/base-logic.mjs:4566）
 *  都会拉正文；不合并就会对同一份正文发两次 GET（真机上一份几 MB），第二次回来只会被
 *  `historySignature` 挡住不重画 —— 但**网络与序列化已经白烧了一遍**。
 *  ⚠️ 只有「初连/重连」这两个入口传 `coalesce:true`；`session.end`/`settled`/`tool_end` 这类
 *  「正文可能真的变了」的入口一律**不**合并，避免合并掉一次必须的重拉。 */
function refreshMessages(id = selectedId, generation = sessionGeneration, options = {}) {
  if (!id) return Promise.resolve(false);
  if (options.coalesce) {
    // ① 还在飞：复用同一次 GET。
    if (messagesRefreshInFlight && messagesRefreshInFlight.id === id && messagesRefreshInFlight.generation === generation) {
      return messagesRefreshInFlight.promise;
    }
    // ② 这次 hello 已经拉过了（第一条 GET 先回来、快照后到）且**当时空闲**：不再发第二条 ——
    //    连接已经建立，之后的内容变化由 SSE 事件驱动（session.end/settled/tool_end 不合并）；
    //    同一连接上后来的快照、以及「在跑/在压缩」时段拉的那一份，都会先把这本账清掉
    //    （见 session.snapshot 处理里的 `snapshots`/`isStreaming` 与下面的 `busy`）。
    if (sessionHello && sessionHello.id === id && sessionHello.generation === generation
      && sessionHello.refreshed !== null && sessionHello.busy !== true) {
      return sessionHello.refreshed;
    }
  }
  const promise = refreshMessagesOnce(id, generation, options);
  if (options.coalesce) {
    messagesRefreshInFlight = { id, generation, promise };
    if (sessionHello && sessionHello.id === id && sessionHello.generation === generation) {
      sessionHello.refreshed = promise;
      // 这一份是「在跑/在压缩」时拉的 ⇒ 它不算「可以不拉」的那一份（见 sessionHello 的注释）。
      sessionHello.busy = streaming || compacting || agentBusy;
    }
    // `then(onFulfilled, onRejected)` 而不是 `finally`：后者会派生一个「未处理的拒绝」。
    promise.then(() => {
      if (messagesRefreshInFlight && messagesRefreshInFlight.promise === promise) messagesRefreshInFlight = null;
    }, () => {
      if (messagesRefreshInFlight && messagesRefreshInFlight.promise === promise) messagesRefreshInFlight = null;
      // 失败就别把这本账留着：否则这次 hello 后面的快照会复用一个已经拒绝的 promise，永远拉不动。
      if (sessionHello && sessionHello.refreshed === promise) sessionHello.refreshed = null;
    });
  }
  return promise;
}

async function refreshMessagesOnce(id = selectedId, generation = sessionGeneration, { forceBottom = false, signal = sessionRequestController?.signal } = {}) {
  if (!id) return false;
  const requestGeneration = ++messagesRequestGeneration;
  const followed = forceBottom || isFollowingBottom();
  const previousHeight = messagesNode.scrollHeight;
  const previousTop = messagesNode.scrollTop;
  const base = tailBase(id);
  // 尾部增量：只拉「已知的最后一条定稿消息」之后的那些（`?after=` 是可选参数，服务端缺省行为不变；
  // 老服务端不认这个参数时回的仍是整份，`tailMerge` 拿不到 `tail` 就照旧走替换）。
  const query = base ? `?after=${encodeURIComponent(base.cursor.entryId)}` : '';
  const response = await api(`/sessions/${id}/messages${query}`, { signal });
  if (requestGeneration !== messagesRequestGeneration || generation !== sessionGeneration || id !== selectedId) return false;
  // 正文接管：历史里已经有了的那几条（role=user 且文本逐字相同）就不再画占位。
  if (pendingUser.length) confirmPendingUser(response.messages || []);
  // 同一份正文就不重画（见 historySignature）：重画一遍既白烧 CPU，又让正文可见地重建一次
  // （分两批插入 ⇒ 先是尾批、再补旧消息；中间那一帧跟收尾帧还差一行）。
  // ⚠️ 与主干「折叠态搬进会话级容器」那一版共存：`renderMessages` 的参数一个都没少
  // （含新的 `scope`）；同一份不重画也意味着**已画好的节点连同它们的折叠态原地不动**。
  const merged = tailMerge(response, base);
  // 增量拼得上就**只 append 新节点**（屏幕上那份前缀原地不动，见 render.js 的 appendMessageNodes）；
  // 拼不上（extra 落位 / 压缩边界对不上）就拿拼好的整份重画一次 —— 注意是重画，不是再拉一次。
  // ⚠️ 有一条**前置**对不上时也不许走增量：屏幕上有 `splitLive` 收口、还没被正文接管的直播块
  // （`.live-done`）时。那条路只会 append，**绝不动已画好的节点** ⇒ 那块收口的直播永远换不成历史
  // 里那一条，同一段正文在屏幕上出现**两次**（`test/steer-live-split.mjs` 的 ①-f 把它量成
  // `{"A":2,"B":1,"C":1,"steer":1}`）。带着它走下面那条重画路（`renderMessages` 的
  // `replaceChildren`）才是 `splitLive` 注释里写的那件事：「旧节点原地留着，马上会被这次重拉换成
  // 历史里那条」。`?after=` 增量**拉取**照旧（只省字节，与画法无关）。
  const appended = merged !== null && !liveDonePending()
    && appendMessageNodes(messagesNode, merged, response.tail.from, base.payload.extras ?? [], { before: liveTailAnchor() });
  const payload = merged ?? response;
  const signature = historySignature(payload);
  // 这一次拉取到底改了没有历史 DOM（只 append 也算「改了」）。下面的视口补偿只跟它绑定。
  let rerendered = false;
  if (appended) {
    renderedSignature = signature;
    renderedPayload = payload;
    rerendered = true;
  } else if (signature !== renderedSignature) {
    // 大会话：同步画最近一批，其余旧消息在空闲期分片补进正文顶部（不阻塞也不砍内容）。
    renderMessages(messagesNode, payload, {
      progressive: true,
      pinBottom: followed,
      // 折叠态容器的作用域：`payload.sessionId` 优先，这里是给不带 sessionId 的假 API/fixture 兜底。
      scope: id,
      // 分片补旧消息是在空闲期分批 prepend 的：那批卡片到得很晚 ⇒ 补完后**再**按服务端现状打一次标。
      onComplete: () => { applyAnnotationMarks(); syncBottomFollow(); },
    });
    renderedSignature = signature;
    renderedPayload = payload;
    rerendered = true;
  }
  visibleMessages = payload.messages || [];
  visibleMessagesId = id;
  visibleMessagesVersion += 1;
  // 模型建议：尾巴那条助手消息的可选字段（服务端校验过的）—— 刷新后这排还在，靠的就是它。
  applySuggestionPayload(payload);
  applyAnnotationMarks();
  if (payload.context !== undefined) sessionContext = payload.context;
  renderSessionObservability(sessionUsageNode, payload.observability, sessionContext, sessionThinkingLevel);
  renderContextUsage(sessionContextNode, sessionContext);
  renderLive();
  restackTransient(); // 正文/直播重画会把占位摘掉 —— 这里按说话顺序把占位与直播块挂回尾部
  if (followed) scrollToBottom();
  else {
    // 不贴底时得把「读者正在看的那个位置」保住。原来的算法是 `previousTop + max(0, 新高度-旧高度)`：
    //   · 末尾追加内容（高度变多）⇒ 把读者硬推下去同样的高度 —— 距离底部不变，但他们看的正文换人了（实测 40 条会话索引 12→16）；
    //   · 渐进渲染先把旧消息挪走（高度变少）⇒ 增量为 0 ⇒ 同一个像素偏移指向了更晚的几十条消息。
    // 改成「先扣掉已不在容器里的那一截（被挪走的高度），再把多出来的那截抵掉（新内容在下面，本就不该动视口）」：
    // ⚠️ 只在**真的重画过**时才写：没重画时容器高度没变，再把同一个 scrollTop 写回去是纯噪音
    //（也会让观测台多记一条无意义的滚动写，例如开播那一帧只为拉扩展消息的重拉）。
    if (rerendered) {
      const removedAbove = Math.max(0, previousHeight - messagesNode.scrollHeight);
      messagesNode.scrollTop = Math.max(0, previousTop - removedAbove);
    }
    syncBottomFollow();
  }
  await markSeenIfVisible(id, generation);
  return true;
}

function startLive() {
  liveParts = [];
  liveActive = true;
  // 上一块的块表作废（与 `dropLiveNode` 同口径）：正常路径上它已被清，但开播是唯一的入口，
  // 在这里再确认一次 —— 否则万一还挂着旧（已脱离文档的）块记录，帧间复用会把新块接到空壳上。
  liveBlocks = [];
  liveSplitPending = false;
  liveBlockToken += 1;
  liveStartIndex = visibleMessages.length;
  liveCoveredText = 0;
  liveCoveredThinking = 0;
  liveCoveredTools = new Set();
  liveCoverageVersion = -1;
  // 新一轮开工：上一轮直播留下的折叠态桥作废（否则新思考会继承旧思考的收起态）。
  clearLiveCollapse(messagesNode);
  if (liveRaf) {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
  }
}

/** 排队消息在插话点被注入 ⇒ pi 会在**同一轮**里再产出一条 assistant 消息。
 *  旧直播块必须在这里收口、新消息开新块；否则新流式内容会灌进「插话之前」那条旧气泡
 *  （用户 2026-09-19 报的就是这个：新正文还在往用户消息**上面**那块里涨）。
 *  **零新元素**：旧节点摘掉直播标记后原地留着（它已落盘，马上会被这次重拉换成历史里那条）；
 *  直播状态与覆盖游标清零 ⇒ 下一个 delta 在它**后面**建一块新的持久节点（帧间照旧 appendData）。 */
function splitLive() {
  if (liveNode) {
    liveNode.classList.remove('live-message');
    liveNode.dataset.kind = 'live-done';
    // 登记进「已收口、等正文接管」：它在屏上占着位，正文还没到 ⇒ 在它被换掉之前不许走尾部
    // 增量那条路（那条路只会 append、换不掉它 —— 见 refreshMessagesOnce 的 appended）。
    liveDoneNodes.add(liveNode);
    // 收口：段角标从 `assistant · streaming` 回 `assistant`（与历史那一段逐字相同）。
    for (const label of liveNode.querySelectorAll('.live-segment > .message-role')) label.textContent = 'assistant';
  }
  liveNode = null;
  liveBlocks = [];
  liveThinkNode = null;
  liveParts = [];
  liveCoveredText = 0;
  liveCoveredThinking = 0;
  liveCoveredTools = new Set();
  liveCoverageVersion = -1;
  liveBlockToken += 1; // 新的一块：在**这一块**期间发出去的插话占位从此刻起算下一块（见 restackTransient）
  liveStartIndex = visibleMessages.length;
  clearLiveCollapse(messagesNode);
  if (liveRaf) {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
  }
  // 旧块的内容此刻只在屏幕上（它的历史还没拉到本地）：立刻重拉一次，把它换成正文里那一条，
  // 插话后的新块才会排在用户消息**之后**。重拉回来再把覆盖游标钉到新的历史末尾。
  const id = selectedId;
  const generation = sessionGeneration;
  void refreshMessages(id, generation).then((refreshed) => {
    if (refreshed && generation === sessionGeneration && id === selectedId) {
      liveStartIndex = visibleMessages.length;
      renderLive();
    }
  }, () => {});
}

function finishLive() {
  liveActive = false;
  liveSplitPending = false;
  liveParts = [];
  liveCoveredText = 0;
  liveCoveredThinking = 0;
  liveCoveredTools = new Set();
  // 收工：桥作废。收工前 `refreshMessages` 已把桥上的折叠态落到那条 assistant 消息的稳定键上，
  // 此后由稳定键说话 —— 否则用户后来改正式正文时，桥会把旧值盖回去。
  clearLiveCollapse(messagesNode);
  if (liveRaf) {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
  }
  dropLiveNode();
}

function applyQueue(value) {
  const next = {
    steering: Array.isArray(value?.steering) ? value.steering : [],
    followUp: Array.isArray(value?.followUp) ? value.followUp : [],
  };
  // 排队消息**被注入**的信号（不是「我们还没发出去」）：上一条还在队里、这一条没有了。
  // pi 一注入就把它当 user 消息插进对话（`agent-session.js` 的 `_handleAgentEvent`），紧随其后的
  // `session.start` 是**另一条** assistant 消息 —— 那一刻直播块必须开新块（见 splitLive）。
  if (liveActive) {
    const injected = [...queue.steering, ...queue.followUp]
      .some((text) => !next.steering.includes(text) && !next.followUp.includes(text));
    if (injected) liveSplitPending = true;
  }
  queue = next;
  renderQueueStatus(queueNode, queue);
  // 队列事实变了：占位里「排队中 ⇄ 已发送」跟着变（节点原地重画，位置不动）。
  refreshPendingUser();
}

/** 一个占位节点：**同一套 `article.message.message-user` 结构**（正文里那条真消息也是它）——
 *  这样正文接管时换的只是内容来源，观感不跳。标注只抄 pi 的事实，不冒充：
 *  · 在队列里 ⇒ 「⏳ 排队中（steering/followUp）」+ 说清什么时候会被注入；
 *  · 不在队列里 ⇒ 只标「已发送」（pi 已经在注入它了，只是正文那一发还没到），**不**硬说“排队中”。 */
function fillPendingUserNode(node, text) {
  const kind = queue.steering.includes(text) ? 'steering' : queue.followUp.includes(text) ? 'followUp' : null;
  node.dataset.kind = 'pending';
  node.dataset.role = 'user';
  node.dataset.pending = kind ? 'queued' : 'sent';
  if (kind) node.dataset.queue = kind;
  else delete node.dataset.queue;
  const role = document.createElement('div');
  role.className = 'message-role';
  role.textContent = kind ? `user · ⏳ 排队中（${kind}）` : 'user · 已发送';
  const body = document.createElement('div');
  body.className = 'message-body';
  body.append(renderMarkdown(document, text));
  node.replaceChildren(role, body);
  if (!kind) return;
  const note = document.createElement('div');
  note.className = 'message-pending-note';
  note.textContent = kind === 'steering'
    ? '等这一轮的工具跑完、下次请求模型前注入；还没进模型上下文'
    : '等这一轮真停下来（没有更多工具/插话）时才注入；还没进模型上下文';
  node.append(note);
}

/** 把「我刚发出的那条」立刻画进消息区（发送成功那一刻）。文本就是 POST 出去的那一份
 *  （mention 已展开、已 trim）—— 和 pi 落盘的 user 正文逐字一致，去重才兑得掉。 */
function appendPendingUser(text, landed = 'message', staleLive = false) {
  const node = document.createElement('article');
  node.className = 'message message-user';
  fillPendingUserNode(node, text);
  pendingUser.push({
    text,
    node,
    // 这条是插话/排队语义（pi 会把它注入到**当前这一段之后**）⇒ 它的正文排在那块直播之后。
    // `staleLive`：这条按新消息发出去，但按下回车时屏幕上已经有一块直播在放（上一轮的，收尾还没画到）
    // —— 那块比这条**老**，也归到「之后」。
    afterBlock: landed !== 'message' || staleLive,
    blockToken: liveActive ? liveBlockToken : 0,
  });
  // 落位交给 restackTransient（不能直接 append：那会排到直播块后面去）。
  restackTransient();
  syncBottomFollow();
}

/** 队列事实变了（`session.queue` / 快照对账）：原地重画占位里的标注。 */
function refreshPendingUser() {
  for (const entry of pendingUser) fillPendingUserNode(entry.node, entry.text);
}

/** 正文接管：历史里已经有这一条（role=user 且文本逐字相同）⇒ 占位消失。
 *  判据与 v2.1 `applyHistory` 的 `pendingUser.filter(...)` 完全一致：**按 (role,text) 去重**。 */
function confirmPendingUser(messages) {
  const confirmedTexts = new Set();
  for (const item of messages) if (item.role === 'user') confirmedTexts.add(item.text);
  pendingUser = pendingUser.filter((entry) => {
    if (!confirmedTexts.has(entry.text)) return true;
    entry.node.remove();
    return false;
  });
}

/** 换会话 / 打不开：占位清空，绝不残留。 */
function clearPendingUser() {
  for (const entry of pendingUser) entry.node.remove();
  pendingUser = [];
}

function connectSessionEvents(id, generation) {
  sessionEvents?.close();
  setSessionConnected(false);
  // 这次连接自己的「hello」正文拉取账：`onopen` 第一次 = 初连（账不动，让 `refreshMessages` 去记），
  // 之后再 `onopen` = EventSource 自动重连 ⇒ 把账清空，那条快照必须真拉一次正文（见 sessionHello）。
  sessionHello = { id, generation, refreshed: null, busy: false, opened: false, snapshots: 0 };
  sessionEvents = new EventSource(`/api/sessions/${id}/events`);
  sessionEvents.onopen = () => {
    if (generation !== sessionGeneration || id !== selectedId) return;
    setSessionConnected(true);
    const hello = sessionHello;
    if (!hello || hello.id !== id || hello.generation !== generation) return;
    if (hello.opened) {
      // 重连：初连那次合并过的账作废（这条快照要把断线期间的正文补回来）。
      hello.refreshed = null;
      hello.busy = false;
      hello.snapshots = 0;
      // 标注现状也重拉一次：断线期间维护线可能已把某条 resolve 成 done ⇒ 卡面上的痕迹跟着变（服务端驱动）。
      // 只在**重连**这条支上拉：初连那一次的拉取由 `selectSession` 发出（不重复发请求）。
      void loadAnnotationMarks(id);
    }
    hello.opened = true;
  };
  sessionEvents.addEventListener('session.snapshot', async (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    // 这次快照是不是**初连那一帧**（见 sessionHello）：是 ⇒ 允许与「选中会话」那次 GET 合并；
    // 同一连接上又来一帧快照 = 服务端在重同步（不是初连）⇒ 必须真拉一次正文，把账清掉。
    const hello = sessionHello;
    if (hello && hello.id === id && hello.generation === generation) {
      if (hello.snapshots === 0) hello.snapshots = 1;
      else hello.refreshed = null;
      // 快照自己说还在跑/还在压缩 ⇒ 正文可能真变了，这次必须真拉（不赌）。
      if (data.isStreaming === true || data.isCompacting === true) hello.refreshed = null;
    }
    const wasRunning = streaming || liveActive;
    streaming = data.isStreaming === true;
    // snapshot 的 isStreaming 是 pi 的 run 级事实（_isAgentRunActive），权威的「忙不忙」就在这里对账：
    // 断线重连时它能把「session.end 丢了 / 只是工具循环中途」这两种情形都拉回真相。
    agentBusy = data.isStreaming === true;
    compacting = data.isCompacting === true;
    commandsStreaming = agentBusy;
    // 忙闲/压缩的对账也影响「模型建议」那一排（流式/压缩中不出现）。
    renderSuggestionsRow();
    updateCompactUi();
    sendNode.disabled = !composerAvailable || compacting;
    abortNode.disabled = !agentBusy && !compacting && data.isRetrying !== true;
    // M-36：snapshot 的 `isRetrying` 是权威的「是否在重试」（断线重连的对账点）。它只给布尔、
    // 不带第几次 ⇒ 重连后写成**不带计数**的通用句；真有 `retry_start` 时计数更准，会把它覆盖。
    if (data.isRetrying === true) { if (!retryState) retryState = {}; }
    else if (data.isRetrying === false) retryState = null;
    renderNotice(); // 忙闲/压缩的事实刚对完账 ⇒ 状态层跟着走（I-12）。
    if ('queue' in data) applyQueue(data.queue);
    // snapshot 是初连/重连的 hello 对账点：补回断线期间落盘的正文；如果 end 事件也丢了，
    // 服务端的非流式快照就是收敛判据。refreshMessages 会让历史接管与直播逐字相同的前缀。
    // `coalesce`：初连时「选中会话」刚拉过同一份正文且还在飞 ⇒ 复用那一次，不再发第二次 GET。
    try {
      const refreshed = await refreshMessages(id, generation, { coalesce: true });
      if (!refreshed || generation !== sessionGeneration || id !== selectedId) return;
      if (!streaming && wasRunning) {
        finishLive();
        notice('回复完成（重连对账）');
        queueTreeRefresh();
      }
    } catch (error) {
      if (generation === sessionGeneration && error.name !== 'AbortError') notice(`刷新会话失败：${error.message}`, true);
    }
  });
  sessionEvents.addEventListener('session.title', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    if (typeof data.name !== 'string' || data.name === '') return;
    const session = treeSessions.find((entry) => entry.id === selectedId);
    // 人类设过的标题（titleSource=manual）模型不许覆盖：服务端已拒 auto 写入，这里再兜一层，
    // 免得一条迟到的 auto 事件把人设的名字画回去。
    if (data.source === 'auto' && session?.titleSource === 'manual') return;
    if (session) {
      session.name = data.name;
      if (typeof data.source === 'string') session.titleSource = data.source;
    }
    applySessionTitle(data.name);
    renderSessionTree();
    updateArchiveUi();
    updateSessionActions();
  });
  sessionEvents.addEventListener('session.start', () => {
    if (generation !== sessionGeneration) return;
    streaming = true;
    agentBusy = true;
    commandsStreaming = true;
    // 新一轮开播 ⇒ 上一轮那排候选当场作废（业主拍的「新一轮开始后旧的那排被替换/丢弃，
    // 不许出现上一轮的建议」）。
    clearSuggestions();
    // 一轮可以分几段助手消息（工具调用前/后各一段）。工具循环的那种「下一段」接着同一块画
    // （工具卡就挂在上面）；但**排队消息被注入**之后那一条必须开新块 —— 见 splitLive。
    const freshTurn = !liveActive;
    if (freshTurn) {
      startLive();
    } else if (liveSplitPending) {
      splitLive();
    }
    // 开播那一帧就要提交：否则「思考中…」要等第一段 delta 才出现（那就不叫空态指示了）。
    scheduleLive();
    abortNode.disabled = false;
    renderNotice(); // 进入「流式中」：提示行的插话/排队文案由状态层给（I-12），不再另发一条报文。
    queueTreeRefresh();
    // ── 这一轮开工之前刚落盘的**扩展消息**（子会话 push 回来的 `sopho.delegation`…）──
    // 它**不走 SSE**（`server/base-logic.mjs` 的 `eventPayload` 只映射 assistant 的
    // message_start/update/end），前端只能从 `/messages` 的 payload 里按锚点现算（render.js 的
    // extraBoundaries）。不在开播这一帧拉一次，那条 `aside.extra-message` 就要等到 `session.end`
    // 的收尾重拉才出现 —— 屏幕上顺序反过来：先流式正文、代理消息晚到（用户报的就是这个）。
    // 只在**新起一轮**时拉：工具循环的下一段 assistant（`liveActive` 已真）由 `tool_end` 那条路
    // 负责，排队注入那一支由 `splitLive` 自己重拉，都不在这里重复。
    if (freshTurn) void refreshMessages(id, generation).catch(() => {});
  });
  // ── M-36：上游自动重试的可见状态 ────────────────────────────────────────
  // 服务端把 pi 的 `auto_retry_start/end` 如实投影成这两个事件（`server/base-logic.mjs:1683-1700`，
  // 带 attempt/maxAttempts/delayMs/errorMessage）；这里把「上游错误、正在重试 N/M…」写进 I-12 提示行的
  // **状态层**（常驻，不学时长为 5s 的 info 回执）。交还判据两条：这个 `retry_end`，或**第一帧正文 delta**
  // （正文开始流 = 不卡了，`retry_end` 在成功那条消息结束时才到，晚于首帧 delta）。`retry_start` 紧跟在
  // 中间态 `session.end{stopReason:'error'}` 之后 ⇒ 撤掉那一条错误报文、把行让给「正在重试」（只撤这一条）。
  sessionEvents.addEventListener('session.retry_start', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    retryState = {
      attempt: Number.isInteger(data.attempt) ? data.attempt : null,
      maxAttempts: Number.isInteger(data.maxAttempts) ? data.maxAttempts : null,
    };
    if (upstreamErrorNotice !== null && noticeOverride === upstreamErrorNotice) clearNotice();
    upstreamErrorNotice = null;
    renderNotice();
  });
  sessionEvents.addEventListener('session.retry_end', (event) => {
    if (generation !== sessionGeneration) return;
    // 只把**状态层**交还。**不碰覆盖层**：重试最终失败时 `session.end{stopReason:'error'}` 刚写下的
    // 那条错误报文必须留在行上（错误优先于状态层）。
    retryState = null;
    renderNotice();
  });
  sessionEvents.addEventListener('session.delta', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    // 两个通道都收：服务端 `eventPayload()` 按 `message_update + text_delta|thinking_delta` 分开送
    // （`server/base-logic.mjs`），此前这里把 `channel !== 'text'` 一律 return ⇒ thinking 被整段丢掉。
    const channel = data.channel === 'thinking' ? 'thinking' : data.channel === 'text' ? 'text' : null;
    if (!channel) return;
    // M-36：正文开始流 = 上游不卡了 ⇒ 立刻把状态层交还（`retry_end` 可能还差一两帧才到）。
    if (channel === 'text' && retryState) { retryState = null; renderNotice(); }
    if (!liveActive) startLive();
    // 续写**紧挨着的上一段**（不是「该通道的最后一段」）：交错到达时才不会被拍平成一段（v2.1 的 tailPart）。
    const tail = liveParts[liveParts.length - 1];
    if (tail && tail.type === channel) tail.text += data.delta || '';
    else liveParts.push({ type: channel, text: data.delta || '' });
    // 不在这里碰 DOM、不在这里读布局：入队，交给 rAF 每帧提交一次。
    scheduleLive();
  });
  // ── 工具卡（I-16）─────────────────────────────────────────────────────────
  // `session.tool_start`：在直播块里就地挂一张「运行中」卡（与结束后的正式卡同一套结构）。
  sessionEvents.addEventListener('session.tool_start', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    if (!liveActive) startLive(); // 兜底（正常序列里 session.start 已先到）
    liveParts.push({
      type: 'tool',
      toolCallId: data.toolCallId ?? null,
      name: data.name || 'tool',
      args: data.args && typeof data.args === 'object' ? data.args : {},
      status: 'running',
      result: '',
      isError: false,
      // 工具耗时的起点（服务端在收到 `tool_execution_start` 那一刻的观测时间）。没有就**不带**这个
      // 字段 —— `web/render.js` 那一边拿不到 `startedAt` 就不画耗时标签（绝不从 0 开始计）。
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    });
    scheduleLive();
  });
  // `session.tool_end`：**就地更新那一张卡**（不整块重建）；配不到直播里那张卡时
  // （页面在工具跑着时刷新 / 重连，那张卡已交给历史）绝不凭空再 push 一张 —— 去重拉正文让
  // 服务端把配到 result 的那张卡标对。
  // `session.tool_update`（实时输出，2026-09-22 新增）：服务端把 pi 的 `tool_execution_update`
  // 转成这一相。⚠️ `data.text` 是「到目前为止的全部输出」的**累积快照**（pi 的 `output.snapshot()`），
  // **不是 delta** ⇒ 这里存最新那一份，渲染时**替换**实时尾（不是把帧 append 成一串）。
  // 配不到直播卡（页面在工具跑着时刷新 / 重连后那张卡已交给历史）就**什么都不做** ——
  // 绝不凭空造一张卡冒充。
  sessionEvents.addEventListener('session.tool_update', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    const part = [...liveParts].reverse().find((item) => item.type === 'tool' && item.toolCallId === data.toolCallId);
    if (!part) return;
    part.live = {
      text: typeof data.text === 'string' ? data.text : '',
      // 行数诚实：服务端只有拿到 pi 的 `details.truncation` 时才给这几个字段；没给就 `null`
      // （渲染那一侧据此说「至少 N 行」，绝不把未知画成 0 行）。
      truncated: data.truncated === true,
      truncatedBy: typeof data.truncatedBy === 'string' ? data.truncatedBy : null,
      totalLines: Number.isFinite(data.totalLines) ? data.totalLines : null,
      emittedLines: Number.isFinite(data.emittedLines) ? data.emittedLines : null,
      // 服务端明确说过「这一帧就是全部输出」才为 `true`；缺/非布尔一律当成**不知道**（说下界）。
      complete: data.complete === true,
    };
    scheduleLive();
  });
  sessionEvents.addEventListener('session.tool_end', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    const part = [...liveParts].reverse().find((item) => item.type === 'tool' && item.toolCallId === data.toolCallId);
    if (part) {
      part.status = data.isError === true ? 'done-error' : 'done-success';
      part.isError = data.isError === true;
      part.result = typeof data.result === 'string' ? data.result : '';
      // M-25 / M-31 的直播那一半：`tool_end` 到达时就带上 `details`（diff）与 `content`（含图片块）。
      // 不在这条路画第二套 —— 把它们塞进同一个 part，`toolCard()` 的 `toolExtras()` 与正式卡
      // 走同一个渲染器（`details` 包成 `detailsWire()` 的 known 形状，`content` 交给 `liveToolContext`）。
      part.details = knownDetails(data.details);
      part.content = Array.isArray(data.content) ? data.content : null;
      // 实时尾**到此为止**：正式结果到了 ⇒ 用它**替换**那段增量（不是叠加），诚实标记随之撕下。
      delete part.live;
      // 终点：服务端在收到 `tool_execution_end` 那一刻的观测时间。事件里没有就**什么也不写**
      // （卡上的耗时标签随之撕下）—— 不拿浏览器本地时钟顶替服务端给的起点（两个时钟混进同一个数）。
      if (typeof data.endedAt === 'string') part.endedAt = data.endedAt;
      scheduleLive();
      return;
    }
    void refreshMessages(id, generation).catch(() => {});
  });
  sessionEvents.addEventListener('session.queue', (event) => {
    if (generation !== sessionGeneration) return;
    applyQueue(JSON.parse(event.data));
  });
  sessionEvents.addEventListener('session.compaction_start', () => {
    if (generation !== sessionGeneration) return;
    compacting = true;
    closeCompactConfirm();
    updateCompactUi();
    sendNode.disabled = true;
  });
  sessionEvents.addEventListener('session.compaction_end', async () => {
    if (generation !== sessionGeneration) return;
    compacting = false;
    updateCompactUi();
    sendNode.disabled = !composerAvailable;
    notice('压缩完成；正文已标出新的压缩边界。');
    try {
      await refreshMessages(id, generation);
    } catch (error) {
      if (generation === sessionGeneration) notice(`压缩完成，但刷新正文失败：${error.message}`, true);
    }
    queueTreeRefresh();
  });
  sessionEvents.addEventListener('session.end', async (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    // 带工具的那一段助手消息也会发 `session.end`（`stopReason:"toolUse"`）—— 这一轮**还没完**：
    // 工具要跑，后面还有下一段助手消息（真沙箱原始帧：session.end{toolUse} → tool_start →
    // tool_end → 下一个 session.start）。这里绝不能当收尾：直播块留着（工具卡就挂在上面），
    // 也不 refreshMessages（否则历史里那张 running 卡会与直播块同一张画两遍），更不能 finishLive。
    // 两种「这一轮还没完」：① 还有工具要跑（stopReason:"toolUse"）；② 用户插话/排队的那条
    // 马上要被注入（pi 在 turn 边界先投递排队消息、再产出一条新的 assistant 消息）。
    // ② 尤其不能在这里当收尾：否则新消息要么被并进旧块、要么被 finishLive 收掉（见 splitLive）。
    const queuedWhileEnding = data.stopReason !== 'error' && data.stopReason !== 'aborted'
      && (queue.steering.length > 0 || queue.followUp.length > 0);
    if (data.stopReason === 'toolUse' || queuedWhileEnding) {
      streaming = true;
      commandsStreaming = true;
      abortNode.disabled = false;
      scheduleLive();
      return;
    }
    streaming = false;
    // 这一条助手消息收尾了 ⇒ 那一排的可见性重算（新一轮的候选还没来，所以此刻通常还是不画）。
    renderSuggestionsRow();
    // ⚠️ session.end 只说明「这条 assistant 消息结束了」，**不说明这一轮 run 结束了**：
    // 工具循环里后面还有下一条 assistant 消息（本轮复现里 stopReason 就是 "toolUse"）。
    // 真正的空闲判据是 session.settled（pi 的 agent_settled）；在那之前 abort 要一直可用。
    abortNode.disabled = !agentBusy && !compacting;
    renderNotice(); // session.end 可能已把 streaming 落下去 ⇒ 状态层与 abortNode 同一条判据（I-12）。
    if (data.stopReason === 'error') {
      notice(`上游错误：${data.errorMessage || '未知错误'}`, true);
      // M-36：这一条上游错误若紧接着被 auto-retry 接管，就是**中间态**（马上会有一条 `retry_start`）——
      // 记下这一条覆盖层，`retry_start` **只撤它**，让位给「正在重试」；别的错误报文照旧压着重试状态，
      // 重试最终失败时（不再有 `retry_start`）这条错误自然留在行上。
      upstreamErrorNotice = noticeOverride;
    }
    else if (data.stopReason === 'aborted') {
      applyQueue({});
      notice('已中断，可以继续发送');
    } else notice('回复完成');
    try {
      const refreshed = await refreshMessages(id, generation);
      if (refreshed && generation === sessionGeneration) finishLive();
    } catch (error) {
      if (generation === sessionGeneration) notice(`刷新会话失败：${error.message}`, true);
    }
    queueTreeRefresh();
  });
  // `session.settled` = 这一轮真停下来（pi 的 `agent_settled`）：这才是「发消息不用 steer、
  // abort 复位」的时刻（`session.end` 只代表一条 assistant 消息结束 —— 工具循环里后面还有）。
  // 它还是**直播块的兜底**：`end` 丢了 / 中断停在工具里 时，直播块不许永远留在屏幕上。
  // ⚠️ 兜底判据故意要 `streaming` **和** `liveActive` 两个都为真：terminal `session.end` 是异步的
  // （要先 await refreshMessages），settled 紧跟着就到 —— 那时它已把 `streaming` 置假但
  // `finishLive()` 还没跑到；只卡一个标志会把「正是它收的尾」再重拉一遍。
  sessionEvents.addEventListener('session.settled', async () => {
    if (generation !== sessionGeneration) return;
    agentBusy = false;
    commandsStreaming = false;
    abortNode.disabled = !compacting;
    renderSuggestionsRow();
    renderNotice(); // 真空闲了：行从「流式中」回「Enter 发送」（I-12）。
    if (!streaming || !liveActive) return;
    streaming = false;
    try {
      const refreshed = await refreshMessages(id, generation);
      if (refreshed && generation === sessionGeneration) finishLive();
    } catch {
      if (generation === sessionGeneration) finishLive();
    }
    queueTreeRefresh();
  });
  sessionEvents.addEventListener('session.error', (event) => {
    if (generation !== sessionGeneration) return;
    const data = JSON.parse(event.data);
    if (compacting) {
      compacting = false;
      updateCompactUi();
      sendNode.disabled = !composerAvailable;
    }
    notice(`会话错误：${data.message}`, true);
  });
  // M-41：插件 notify 的可见落点（服务端 `session.notice`，瞬时、不落盘）。
  sessionEvents.addEventListener('session.notice', (event) => {
    if (generation !== sessionGeneration) return;
    let data = {};
    try { data = JSON.parse(event.data); } catch { data = {}; }
    showSessionNotice(data.level, data.text);
  });
  // ── P1（manager toolkit）：问题清单的直播刷新 ──────────────────────────────────────────────
  // 服务端上了 `session.question` 事件（ask/answer/close 任一变更）时就跟着刷新未答计数
  // （正在看问题页就顺带刷新列表）。⚠️ 另一条 landing 可能还没落地这个事件 —— 浏览器对
  // **不存在的事件名**只是永不派发（不是错误），所以这条监听器缺席时不会报错；
  // 计数也不靠它：切到会话时轮询一次、答题/关闭后重拉、切页时再拉一次（见 setView）。
  const followQuestionEvents = () => {
    if (generation !== sessionGeneration) return;
    void refreshQuestionCounts(id, generation);
  };
  sessionEvents.addEventListener('session.question', followQuestionEvents);
  // 同一条语义的另一种事件名写法（服务端只用其中一条；多挂一个不花代价，也不怕命名不同）。
  sessionEvents.addEventListener('session.questions', followQuestionEvents);
  // 卡片级反馈（annotations，业主 2026-09-22 拍的 ②）：服务端把「有新的卡片反馈」也发给
  // **被指定的维护者会话**（`session.annotation`）。这一条就是那股事件在**页面上的可见落点**：
  //   ① 瞬时的会话通知行（与插件 notify 同一行、同一套语言：后到者替换、不堆叠）；
  //   ② 立刻重拉一次正文 —— 服务端同时把一条**自解释的通知消息**（`customType:'sopho.annotation'`）
  //      投进了这条会话（它就是那条 `aside.extra-message`，也是维护者要读的正文）。
  // 为什么不靠 `session.end`：投递触发的回合要是起不来（没模型/离线），`session.end` 可能压根不来 ——
  // 而事件到达这件事与回合成不成无关。
  sessionEvents.addEventListener('session.annotation', (event) => {
    if (generation !== sessionGeneration) return;
    let data = {};
    try { data = JSON.parse(event.data); } catch { data = {}; }
    const count = Number.isInteger(data.count) ? data.count : (Array.isArray(data.items) ? data.items.length : 0);
    showSessionNotice('info', `有新的卡片反馈：共 ${count} 条（读下方那条通知消息；清单见 GET /annotations?state=open）`);
    void refreshMessages(id, generation).catch(() => {});
  });
  // ── 对话内的「推荐回复」（`session.suggestions`）────────────────────────────────
  // 服务端在后台生成完（**不阻塞主回合**）才发这一帧：`{messageId, items}`，`items` 是服务端
  // **严格校验过**的候选（非 JSON / 过长 / 空串 / 超 3 条都已经在那边处理完 —— 这里照画，不再改）。
  // 两条纪律：① **陈旧 ⇒ 忽略**（只认当前尾巴那条助手消息的 `messageId`）；② 没收到就什么都不画。
  sessionEvents.addEventListener('session.suggestions', (event) => {
    if (generation !== sessionGeneration) return;
    let data = {};
    try { data = JSON.parse(event.data); } catch { return; }
    const items = Array.isArray(data.items) ? data.items.filter((item) => typeof item === 'string' && item !== '') : [];
    // 陈旧：不是**当前尾巴**那条消息的候选 ⇒ 一个字都不画（也不覆盖现有的那排）。
    if (!suggestionTarget || typeof data.messageId !== 'string' || data.messageId !== suggestionTarget.messageId) return;
    suggestionItems = items.length > 0 ? { messageId: data.messageId, items } : null;
    // 注意：这里**不**碰「已收起」—— 收起是对**那一条**候选说的；同一条再来不打扰，
    // 换一条（新一轮）时 `applySuggestionPayload` 的换目标那一支已经把它复位了。
    renderSuggestionsRow();
  });
  sessionEvents.onerror = () => {
    if (generation !== sessionGeneration || id !== selectedId) return;
    setSessionConnected(false);
    notice('会话事件流或 worker 断开，状态可能已过期；浏览器会自动重连', true);
  };
}

// ── P1（manager toolkit）：视图切换 + 问题页（逻辑）────────────────────────────────────────────
// 数据只从这两个端点来（`ask` 在 agent 侧，网页不调）：
//   GET  /sessions/{id}/questions?status=open|answered|all&limit=N  → {questions:[…], counts:{open,answered,closed,total}}
//   POST /sessions/{id}/questions   （一层路径 + body 里的 op 区分四种写：
//        {op:'answer', qid, text} / {op:'close', qid, reason} / {op:'update', qid, text?, context?, options?, priority?}；
//        不带 op 的那条是 ask，网页不发）
// ⚠️ answer/close 为什么不是嵌套路径（`…/questions/{qid}/answer`）：宿主 `server/base.mjs` 的路由只按
// /sessions/{id}/{一层动作} 解析，嵌套路径匹配不上 ⇒ 落到兜底 proxy ⇒ 破「写 owner 唯一」。
// 契约原文与宿主机批条目见 `docs/plans/manager-toolkit-plan.md` §3 / §11。
// 条目字段（真实服务端 `questionWire`）：{id,status,text,options,priority,dedupeKey,at,by,askedAt,askedBy,
//   answer,answeredAt,answerBy,updatedAt,updatedBy,closeReason,closedAt,closedBy,entryId,entryCount}。
// 「已答/已关」这一页读 `status=answered`：P0 已把口径写死为「answered = 所有非 open（已答**或**已关）」。
// 客户端仍再剔一次 open 作保险（服务端若回得宽了/回的是 `all`，这一页也不会把未答混进历史里）。
const QUESTION_STATUS_QUERY = { open: 'open', answered: 'answered' };

// 答题回执里的投递事实（P0 第三轮起的口径；2026-09-22 与输入框那条统一成 steer）：三个 mode 各自说人话，
//   · `steer`   = 会话有活跃回合 ⇒ 回答已作为**插话**注入当前这一轮 ⇒ **会影响当前这一轮的行为**
//                （与输入框忙时回车那条同一语义；那条的文案是「插话已接收（这一轮还在跑），等待队列确认」）；
//   · `followUp`= 只剩准入窗口、没有活跃回合可插话 ⇒ steer 前提不成立，如实说「已排队、不打断当前回合」；
//   · `message` = 会话空闲 ⇒ 真起了一轮。
// 先看 `delivery.mode`（新服务端一定给），再退回 `queuedForDelivery`（P0 第三轮的顶层字段）/`delivery.queued`
// （老形状）；两块都没有（更老的服务端）就只说「回答已投进会话」，不猜它插了话还是排了队。
function answerDeliveryNotice(result) {
  const mode = typeof result?.delivery?.mode === 'string' ? result.delivery.mode : null;
  const queued = typeof result?.queuedForDelivery === 'boolean'
    ? result.queuedForDelivery
    : typeof result?.delivery?.queued === 'boolean' ? result.delivery.queued : null;
  if (mode === 'steer') return '已答：已作为插话注入当前这一轮（会影响这一轮的行为，不再等它跑完）';
  if (mode === 'followUp') return '已答：当前没有活跃回合可插话（只在准入窗口），已排队，等这轮跑完作为一条消息送达';
  if (mode === 'message') return '已答：已立即发送，已触发新一轮回复';
  if (queued === true) return '已答：已排队，等它这一轮结束（回答已进会话文件，不打断当前回合）';
  if (queued === false) return '已答：已立即发送，已触发新一轮回复';
  return '已答；回答已作为一条消息投进会话。';
}

// 写失败的两类要分开说：
//  · 409 `question_not_open` / 404 `question_not_found` = **这条已经不在了**（别处答过 / 被 agent 关了 /
//    另一个标签页先动的手）—— 这不是「服务端坏了」，正好清单该重拉一次。
//  · 其余（受控 500 / 网络断 / 正在压缩…）原样如实报，**不**重拉、不乐观更新。
async function reportQuestionWriteFailure(what, error) {
  const code = error?.serverCode ?? null;
  if (code === 'question_not_open') {
    notice(`${what}没成：这条已经不在未答里了（${code}，可能别处已经答/关过）；清单已重拉。`, true);
    await refreshQuestionCounts(selectedId, sessionGeneration);
    if (questionState.status !== 'open') await loadQuestions({ status: questionState.status });
    return;
  }
  if (code === 'question_not_found') {
    notice(`${what}没成：服务端说这个会话里没有这条问题（${code}）；清单已重拉。`, true);
    await refreshQuestionCounts(selectedId, sessionGeneration);
    if (questionState.status !== 'open') await loadQuestions({ status: questionState.status });
    return;
  }
  notice(`${what}失败：${error.message}`, true);
}

function currentView() {
  // 两个全局页都压过 per-session 的 view（调试页先判：它是最后选的）。
  if (debugView) return VIEW_DEBUG;
  if (annotationsView) return VIEW_ANNOTATIONS;
  return selectedId ? (viewBySession.get(selectedId) ?? VIEW_SESSION) : VIEW_SESSION;
}

// 条目归一化：真实服务端回的是聚合后的 `questionWire`（带 status/askedAt/answeredAt/closedAt…），
// 这里同时兼容 §1 的落盘形状（「该 id 最后一条条目的 op 决定现状」）—— 两种都能读。
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  const known = (value) => (value === 'open' || value === 'answered' || value === 'closed' ? value : null);
  const answer = typeof raw.answer === 'string' ? raw.answer : typeof raw.answerText === 'string' ? raw.answerText : null;
  const closeReason = typeof raw.closeReason === 'string' ? raw.closeReason : typeof raw.reason === 'string' ? raw.reason : null;
  // 「判断所需的事实」（工具契约要求的必填项）。白名单不加这个字段就会被丢掉。
  // 老条目/老服务端没有它 ⇒ null（渲染时如实说「这条没自带背景」，不许编）。
  const context = typeof raw.context === 'string' && raw.context.trim() !== '' ? raw.context : null;
  let status = known(raw.status) ?? known(raw.state);
  if (!status) {
    if (raw.op === 'close' || raw.closed === true || closeReason !== null) status = 'closed';
    else if (raw.op === 'answer' || answer !== null) status = 'answered';
    else status = 'open';
  }
  return {
    id,
    status,
    text: typeof raw.text === 'string' ? raw.text : '',
    context,
    options: Array.isArray(raw.options) ? raw.options : null,
    priority: raw.priority === 'high' ? 'high' : 'normal',
    // 「问于 …」用 askedAt/askedBy（真实服务端分得开）；老形状只有 at/by 时用它们兜底。
    askedAt: raw.askedAt ?? raw.at ?? raw.createdAt ?? null,
    askedBy: typeof raw.askedBy === 'string' ? raw.askedBy : status === 'open' && typeof raw.by === 'string' ? raw.by : null,
    at: raw.at ?? raw.createdAt ?? null,
    by: typeof raw.by === 'string' ? raw.by : null,
    answer,
    answeredAt: raw.answeredAt ?? null,
    answerBy: typeof raw.answerBy === 'string' ? raw.answerBy : null,
    // 「更新于 …」的留痕（P0.5 的 `op:'update'`）：只在该条真的被更新过时才有；老服务端没有这个字段 ⇒ null。
    updatedAt: raw.updatedAt ?? null,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    closeReason,
    closedAt: raw.closedAt ?? null,
    closedBy: typeof raw.closedBy === 'string' ? raw.closedBy : null,
  };
}

function renderViewTabs() {
  const enabled = Boolean(selectedId) && openErrorId !== selectedId;
  const view = currentView();
  const counts = selectedId ? questionCounts.get(selectedId) : null;
  const known = counts?.known === true && Number.isInteger(counts.open);
  const count = known ? counts.open : null;
  viewTabSessionNode.disabled = !enabled;
  viewTabQuestionsNode.disabled = !enabled;
  viewTabSessionNode.setAttribute('aria-selected', String(view === VIEW_SESSION));
  viewTabQuestionsNode.setAttribute('aria-selected', String(view === VIEW_QUESTIONS));
  // 标注页与调试页都是**全局**的（跨会话），不依赖选没选中会话 ⇒ 这两个页签始终可用。
  viewTabAnnotationsNode.disabled = false;
  viewTabAnnotationsNode.setAttribute('aria-selected', String(view === VIEW_ANNOTATIONS));
  viewTabDebugNode.disabled = false;
  viewTabDebugNode.setAttribute('aria-selected', String(view === VIEW_DEBUG));
  // 业主定的口径：未答数并入 `问题` 这一项；N=0 时就只写「问题」（不写 0）。
  viewTabQuestionsNode.textContent = count > 0 ? `问题 ${count}` : '问题';
  viewTabQuestionsNode.dataset.openCount = count === null ? '' : String(count);
  viewTabQuestionsNode.dataset.countKnown = String(known);
  viewTabQuestionsNode.title = count > 0
    ? `这个会话有 ${count} 条待你拍板的问题`
    : known
      ? '没有待你拍板的问题（切过去可看已答/已关）'
      : '待确认的问题；未答数未知 —— 服务端没给，或这个版本还没有问题清单接口';
}

// 问题页里**能换行**的输入格（`web/render.js` 建的都是 `<textarea rows=1>`）：手动回答框 ＋「关闭原因」框。
// 这一条集合只喂 `keydown` 那条守卫（Shift+Enter = 换行，不拦默认动作、绝不提交）；«随内容长高» 由
// 下面那个 `autoGrowField` 管（它看的是控件形状 = `<textarea>`，不另列一份字段名）。两格**同一套口径**，
// 不写成第二套：本仓吃过「两份口径迟早漂」的亏。
const MULTILINE_FIELDS = new Set(['answer', 'close-reason']);

// 多行输入格随内容长高、到上限转框内滚动（业主 2026-10-05/06 裁定：「随内容长高（设上限）」）。
// 上限不在这里写死 —— 它是 CSS 的 `max-height`（`web/index.html` 那条 `.question-answer-row textarea,
// .question-close-row textarea`，5 行 = 122px），这里用 `getComputedStyle` 读回来，**一份事实两处不各写**。
// 为什么用 JS 而不用 CSS `field-sizing: content`：那个是 Chromium 新特性，在 Firefox 里**静默不生效**
// （退化成固定高、不报错）—— 本仓还跑 Firefox 相关分支，会拿到「以为长了、其实没长」的假象；
// `scrollHeight` + clamp 是两条引擎共有的标准 API（不赌新特性），更可移植。
function autoGrowField(node) {
  if (!node || node.tagName !== 'TEXTAREA') return;
  const css = getComputedStyle(node);
  const min = parseFloat(css.minHeight) || 26;
  const max = parseFloat(css.maxHeight);
  const cap = Number.isFinite(max) && max > 0 ? max : Number.POSITIVE_INFINITY;
  // `scrollHeight` 不含边框，而我们的 `height`/`min-height` 是 `border-box` ⇒ 把边框加回来。
  const border = (parseFloat(css.borderTopWidth) || 0) + (parseFloat(css.borderBottomWidth) || 0);
  node.style.height = 'auto';
  const needed = node.scrollHeight + border;
  node.style.height = `${Math.max(min, Math.min(needed, cap))}px`;
}

function updateQuestionFilterTabs() {
  questionsFilterOpenNode.setAttribute('aria-selected', String(questionState.status === 'open'));
  questionsFilterAnsweredNode.setAttribute('aria-selected', String(questionState.status === 'answered'));
}

function renderQuestionsPane() {
  // 重画会把输入框换成新节点 —— 先记住焦点与光标，画完还回去（SSE 刷新不该打断正在写的答案）。
  const active = document.activeElement;
  const restore = active && active.dataset && questionsListNode.contains(active) && active.dataset.field
    ? {
      field: active.dataset.field,
      questionId: active.closest('[data-question-id]')?.dataset.questionId ?? null,
      caret: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    }
    : null;
  renderQuestions(questionsListNode, {
    status: questionState.status,
    load: questionState.load,
    error: questionState.error,
    entries: questionState.entries,
    drafts: questionState.drafts,
    closeConfirm: questionState.closeConfirm,
    closeReason: questionState.closeReason,
    submitting: questionState.submitting,
  });
  updateQuestionFilterTabs();
  // 重画后把多行格的高度按**当前内容**重新量一次（草稿/关闭原因里可能已经带着 `\n`）。
  for (const node of questionsListNode.querySelectorAll('[data-field="answer"], [data-field="close-reason"]')) autoGrowField(node);
  if (restore) {
    const selector = restore.questionId
      ? `[data-question-id="${restore.questionId}"] [data-field="${restore.field}"]`
      : `[data-field="${restore.field}"]`;
    const node = questionsListNode.querySelector(selector);
    if (node) {
      node.focus();
      if (restore.caret !== null && typeof node.setSelectionRange === 'function') {
        try { node.setSelectionRange(restore.caret, restore.caret); } catch { /* 不支持选择范围的输入型就算了 */ }
      }
    }
  }
}

function resetQuestionState(id) {
  questionState.id = id;
  questionState.generation = sessionGeneration;
  questionState.status = 'open';
  questionState.load = 'idle';
  questionState.error = null;
  questionState.entries = [];
  questionState.drafts = new Map();
  questionState.closeConfirm = null;
  questionState.closeReason = '';
  questionState.submitting = null;
  questionLoadToken += 1; // 换会话：在飞的那次响应作废
}

// 切页只改 `main[data-view]` 与问题页的 hidden：正文容器由 CSS 切 visibility（保住 scrollTop），
// 底栏/排队条由 CSS 在问题页隐藏（切回恢复）。直播与未读闭环都不在这里动。
// ⚠️ 底栏一隐一现会改正文容器的高度（row 2 是 1fr）—— 贴底的人得跟着留在底部：
// 不然切走那一下容器变高、浏览器会把 scrollTop 向下箝到新上限，切回来就离底还差一个底栏的高度，
// 「↓ 回到底部」自己跳出来。所以在切之前记「是否贴底」，切完按同一条判据对齐一次。
function applyView() {
  const view = currentView();
  const wasFollowing = isFollowingBottom();
  mainNode.dataset.view = view;
  questionPaneNode.hidden = view !== VIEW_QUESTIONS;
  annotationsPaneNode.hidden = view !== VIEW_ANNOTATIONS;
  debugPaneNode.hidden = view !== VIEW_DEBUG;
  if (wasFollowing) scrollToBottom();
  renderViewTabs();
  renderQuestionsPane();
  renderAnnotationsPane();
  renderDebugPane();
}

function setView(view) {
  // 标注页与调试页都是**全局**视图：不需要选中会话，开着它时压过 per-session 的 view。
  if (view === VIEW_DEBUG) {
    debugView = true;
    annotationsView = false;
    applyView();
    void loadDebug();
    return;
  }
  if (view === VIEW_ANNOTATIONS) {
    annotationsView = true;
    debugView = false;
    applyView();
    void loadAnnotations();
    return;
  }
  if (!selectedId || openErrorId === selectedId) return;
  annotationsView = false;
  debugView = false;
  const next = view === VIEW_QUESTIONS ? VIEW_QUESTIONS : VIEW_SESSION;
  viewBySession.set(selectedId, next);
  applyView();
  if (next === VIEW_QUESTIONS) {
    void loadQuestions({ status: questionState.status });
    return;
  }
  // 切回会话页：补两件事 —— ① 未答数轮询一次（`session.question` 事件还没落地时计数也不冻住）；
  // ② 人在问题页期间不许上报已读，回到正文这里补一次。
  void refreshQuestionCounts(selectedId, sessionGeneration);
  void markSeenIfVisible();
}

// ── 卡片级反馈的全局只读页（annotations）──────────────────────────────────
function renderAnnotationsPane() {
  renderAnnotations(annotationsListNode, {
    load: annotationState.load,
    error: annotationState.error,
    items: annotationState.status === 'open'
      ? annotationState.items.filter((item) => (item.state ?? 'open') === 'open')
      : annotationState.items,
  });
  annotationsFilterAllNode.setAttribute('aria-selected', String(annotationState.status === 'all'));
  annotationsFilterOpenNode.setAttribute('aria-selected', String(annotationState.status === 'open'));
}

async function loadAnnotations({ status = annotationState.status } = {}) {
  annotationState.status = status === 'open' ? 'open' : 'all';
  const token = ++annotationLoadToken;
  annotationState.load = 'loading';
  annotationState.error = null;
  renderAnnotationsPane();
  try {
    const payload = await api('/annotations');
    if (token !== annotationLoadToken) return;
    if (!Array.isArray(payload?.items)) {
      annotationState.load = 'error';
      annotationState.error = '服务端返回的形状不认识（没有 items 数组）';
      renderAnnotationsPane();
      return;
    }
    annotationState.items = payload.items;
    annotationState.load = 'ready';
    renderAnnotationsPane();
  } catch (error) {
    if (token !== annotationLoadToken) return;
    if (error?.status === 404) annotationState.load = 'unsupported';
    else { annotationState.load = 'error'; annotationState.error = error.message; }
    renderAnnotationsPane();
  }
}

// ── 调试页（`#debug-pane`）：两个来源各自成败、各自如实报 ──────────────────────────
function renderDebugPane() {
  renderDebug(debugListNode, {
    load: debugState.load,
    error: debugState.error,
    payload: debugState.payload,
    appHost: debugState.appHost,
  });
  debugNoticeNode.dataset.level = debugState.load === 'error' || debugState.load === 'unsupported' ? 'error' : 'info';
  debugNoticeNode.textContent = debugState.notice;
}

// 同源取 B 自己的事实（`GET /app-host`）——**不经 /api**（B 上那条 `/api/*` 是反代到 A 的）。
async function fetchAppHost() {
  const response = await fetch('/app-host', { headers: { accept: 'application/json' } });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${body?.message || text || ''}`.trim());
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loadDebug() {
  const token = ++debugLoadToken;
  debugState.load = 'loading';
  debugState.error = null;
  debugState.appHost = { load: 'loading', error: null, value: null };
  debugState.notice = '正在读取调试信息…';
  renderDebugPane();
  // 两个来源各自成败：一个读不到**不**掩掉另一个（B 的本机事实在 A 无端点时照常显示）。
  const [endpoint, app] = await Promise.allSettled([api('/debug/instances'), fetchAppHost()]);
  if (token !== debugLoadToken) return;
  if (app.status === 'fulfilled') debugState.appHost = { load: 'ready', error: null, value: app.value };
  else debugState.appHost = { load: 'error', error: app.reason?.message ?? String(app.reason), value: null };
  if (endpoint.status === 'fulfilled') {
    debugState.payload = endpoint.value;
    debugState.load = 'ready';
    debugState.error = null;
  } else {
    debugState.payload = null;
    if (endpoint.reason?.status === 404) { debugState.load = 'unsupported'; debugState.error = null; }
    else { debugState.load = 'error'; debugState.error = endpoint.reason?.message ?? String(endpoint.reason); }
  }
  const when = new Date().toLocaleString('zh-CN');
  if (debugState.load === 'ready') {
    debugState.notice = debugState.appHost.load === 'ready'
      ? `已读取（${when}）：A 的实例事实 + B 的本机事实。`
      : `已读取 A 的实例事实（${when}），但 B 的本机事实读不到 —— ${debugState.appHost.error}`;
  } else if (debugState.load === 'unsupported') {
    debugState.notice = `A 上没有调试端点（GET /debug/instances 不存在）—— 这不是「没有实例」，是这次问不到；B 的本机事实照常显示（${when}）。`;
  } else {
    debugState.notice = `实例事实读失败：${debugState.error || '服务端没给原因'}`;
  }
  renderDebugPane();
}

function switchAnnotationStatus(status) {
  const next = status === 'open' ? 'open' : 'all';
  if (annotationState.status === next && annotationState.load === 'ready') { renderAnnotationsPane(); return; }
  void loadAnnotations({ status: next });
}

async function refreshQuestionCounts(id, generation) {
  try {
    const payload = await api(`/sessions/${id}/questions?status=open`);
    if (generation !== sessionGeneration || id !== selectedId) return;
    const raw = Array.isArray(payload?.questions) ? payload.questions : null;
    const entries = (raw ?? []).map(normalizeQuestion).filter(Boolean).filter((entry) => entry.status === 'open');
    // 计数优先用服务端的 counts；服务端没给就用这次拉到的未答条数（这次没带 limit，条数就是全量）。
    const counted = Number.isInteger(payload?.counts?.open) ? payload.counts.open : raw ? entries.length : null;
    questionCounts.set(id, { open: counted, known: counted !== null });
    if (questionState.id === id && questionState.status === 'open' && raw) {
      questionState.entries = entries;
      questionState.load = 'ready';
      questionState.error = null;
      renderQuestionsPane();
    }
    renderViewTabs();
  } catch (error) {
    if (generation !== sessionGeneration || id !== selectedId) return;
    if (error?.status === 404) {
      // 服务端还没有这四个端点（另一条 landing 未落地）：如实记下「这个版本问不到」，
      // 不报错、不假装 0 —— 页签就只写「问题」。
      questionCounts.set(id, { open: null, known: false });
      if (questionState.id === id) { questionState.load = 'unsupported'; renderQuestionsPane(); }
    }
    // 其它错误（网络/5xx）：计数保持未知（不假装 0），也不弹错误 —— 正文那半不该被这份清单拖累。
    renderViewTabs();
  }
}

async function loadQuestions({ status = questionState.status } = {}) {
  const id = selectedId;
  if (!id) return;
  const generation = sessionGeneration;
  const token = ++questionLoadToken;
  questionState.status = status === 'answered' ? 'answered' : 'open';
  questionState.load = 'loading';
  questionState.error = null;
  questionState.closeConfirm = null;
  renderQuestionsPane();
  try {
    const payload = await api(`/sessions/${id}/questions?status=${QUESTION_STATUS_QUERY[questionState.status]}`);
    if (token !== questionLoadToken || generation !== sessionGeneration || id !== selectedId) return;
    if (!Array.isArray(payload?.questions)) {
      questionState.load = 'error';
      questionState.error = '服务端返回的形状不认识（没有 questions 数组）';
      renderQuestionsPane();
      return;
    }
    const entries = payload.questions.map(normalizeQuestion).filter(Boolean);
    questionState.entries = questionState.status === 'open'
      ? entries.filter((entry) => entry.status === 'open')
      : entries.filter((entry) => entry.status !== 'open');
    questionState.load = 'ready';
    if (Number.isInteger(payload?.counts?.open)) questionCounts.set(id, { open: payload.counts.open, known: true });
    renderQuestionsPane();
    renderViewTabs();
  } catch (error) {
    if (token !== questionLoadToken || generation !== sessionGeneration || id !== selectedId) return;
    if (error?.status === 404) questionState.load = 'unsupported';
    else { questionState.load = 'error'; questionState.error = error.message; }
    renderQuestionsPane();
  }
}

function switchQuestionStatus(status) {
  const next = status === 'answered' ? 'answered' : 'open';
  questionState.closeConfirm = null;
  questionState.closeReason = '';
  if (questionState.status === next && questionState.load === 'ready') { renderQuestionsPane(); return; }
  void loadQuestions({ status: next });
}

// 答题：不做乐观更新 —— 只有 2xx 之后才重拉（列表与计数都来自服务端那份事实），
// 失败就把原因写进问题页那条 notice 行，输入框里的原文**不丢**。
async function submitAnswer(qid, text) {
  const id = selectedId;
  if (!id || !qid || questionState.submitting) return;
  const value = String(text ?? '').trim();
  if (!value) {
    notice('答案不能为空 —— 没有发出请求。', true);
    renderQuestionsPane();
    return;
  }
  questionState.submitting = qid;
  questionState.closeConfirm = null;
  renderQuestionsPane();
  try {
    // ⚠️ **一层路径 + body 里的 op**（契约 §3）：`POST /sessions/{id}/questions`，绝不走嵌套路径。
    const result = await api(`/sessions/${id}/questions`, { method: 'POST', body: JSON.stringify({ op: 'answer', qid, text: value }) });
    if (id !== selectedId) return;
    questionState.submitting = null;
    questionState.drafts.delete(qid);
    // 回执按服务端的事实说：`delivery.mode` 为主（`steer` = 已插进当前这一轮 / `followUp` = 已排队 / `message` = 真起了一轮），
    // 老形状的 `queuedForDelivery` / `delivery.queued` 作兑底。
    notice(answerDeliveryNotice(result));
    await refreshQuestionCounts(id, sessionGeneration);
    if (questionState.status !== 'open') await loadQuestions({ status: questionState.status });
  } catch (error) {
    if (id !== selectedId) return;
    questionState.submitting = null;
    renderQuestionsPane();
    await reportQuestionWriteFailure('答题', error);
  }
}

function startCloseConfirm(qid) {
  questionState.closeConfirm = qid;
  questionState.closeReason = '';
  renderQuestionsPane();
  questionsListNode.querySelector(`[data-question-id="${qid}"] [data-field="close-reason"]`)?.focus();
}

// 关闭（不答）：业主定的留痕是「谁/何时/为什么」——所以先收一句可空的原因，再提交。
async function submitClose(qid, reason) {
  const id = selectedId;
  if (!id || !qid || questionState.submitting) return;
  const value = String(reason ?? '');
  questionState.submitting = qid;
  questionState.closeConfirm = null;
  renderQuestionsPane();
  try {
    // 同答题：**一层路径 + body 里的 op**（契约 §3）。`by` 不传 ⇒ 服务端当 user（只有人会用网页关）。
    await api(`/sessions/${id}/questions`, { method: 'POST', body: JSON.stringify({ op: 'close', qid, reason: value }) });
    if (id !== selectedId) return;
    questionState.submitting = null;
    questionState.closeReason = '';
    notice('已关（不答）；谁在何时关的已留痕。');
    await refreshQuestionCounts(id, sessionGeneration);
    if (questionState.status !== 'open') await loadQuestions({ status: questionState.status });
  } catch (error) {
    if (id !== selectedId) return;
    questionState.submitting = null;
    // 失败不吞：把确认行还给用户，原因原文照旧在（不因为一次 500 就丢掉输入）。
    questionState.closeConfirm = qid;
    questionState.closeReason = value;
    renderQuestionsPane();
    await reportQuestionWriteFailure('关闭', error);
  }
}

viewTabSessionNode.addEventListener('click', () => setView(VIEW_SESSION));
viewTabQuestionsNode.addEventListener('click', () => setView(VIEW_QUESTIONS));
viewTabAnnotationsNode.addEventListener('click', () => setView(VIEW_ANNOTATIONS));
viewTabDebugNode.addEventListener('click', () => setView(VIEW_DEBUG));
debugRefreshNode.addEventListener('click', () => void loadDebug());
debugListNode.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-debug-action="refresh"]');
  if (button) void loadDebug();
});
annotationsRefreshNode.addEventListener('click', () => void loadAnnotations({ status: annotationState.status }));
annotationsFilterAllNode.addEventListener('click', () => switchAnnotationStatus('all'));
annotationsFilterOpenNode.addEventListener('click', () => switchAnnotationStatus('open'));
annotationsListNode.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-annotate-action="refresh"]');
  if (button) void loadAnnotations({ status: annotationState.status });
});
questionsFilterOpenNode.addEventListener('click', () => switchQuestionStatus('open'));
questionsFilterAnsweredNode.addEventListener('click', () => switchQuestionStatus('answered'));
questionsRefreshNode.addEventListener('click', () => void loadQuestions({ status: questionState.status }));

// 问题页的动作全部走**一个**委托监听（重画不会泄漏监听器）：
// 选项按钮 = 按这个候选直接答；答 = 用同一条的输入框；关闭（不答）= 先展开确认行。
questionsListNode.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'show-answered') { switchQuestionStatus('answered'); return; }
  if (action === 'refresh') { void loadQuestions({ status: questionState.status }); return; }
  const qid = button.closest('[data-question-id]')?.dataset.questionId ?? null;
  if (!qid) return;
  if (action === 'option') { void submitAnswer(qid, button.dataset.value ?? ''); return; }
  if (action === 'answer') { void submitAnswer(qid, questionState.drafts.get(qid) ?? ''); return; }
  if (action === 'close') { startCloseConfirm(qid); return; }
  if (action === 'close-cancel') { questionState.closeConfirm = null; questionState.closeReason = ''; renderQuestionsPane(); return; }
  if (action === 'close-confirm') { void submitClose(qid, questionState.closeReason); }
});

questionsListNode.addEventListener('input', (event) => {
  const input = event.target;
  if (!input?.dataset?.field) return;
  const qid = input.closest('[data-question-id]')?.dataset.questionId ?? null;
  if (!qid) return;
  if (input.dataset.field === 'answer') questionState.drafts.set(qid, input.value);
  else if (input.dataset.field === 'close-reason') questionState.closeReason = input.value;
  // 随内容长高（同一段 `autoGrowField` 服务两格；`<input>` 型字段会被它内部挡掉）。
  autoGrowField(input);
});

questionsListNode.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const input = event.target;
  if (!input?.dataset?.field) return;
  const qid = input.closest('[data-question-id]')?.dataset.questionId ?? null;
  if (!qid) return;
  // Shift+Enter = **换行**（业主 2026-10-05 点名要的这一格）：**不**拦默认行为，交给那个多行控件
  // 自己把 `\n` 插到光标处（`web/render.js` 现在建的是 `<textarea>`）；绝不提交。
  // 一格还是两格由 `MULTILINE_FIELDS` 一处说了算 —— 「手动回答」与「关闭原因」同一条口径
  // （业主 2026-10-06：「关闭原因」框也修成 Shift+Enter 换行）；非 Shift 的 Enter 行为**一字不动**
  // （回答框 = 提交答案；关闭原因框 = 提交这次关闭）。
  if (event.shiftKey && MULTILINE_FIELDS.has(input.dataset.field)) return;
  event.preventDefault();
  if (input.dataset.field === 'answer') void submitAnswer(qid, input.value);
  else if (input.dataset.field === 'close-reason') void submitClose(qid, input.value);
});

// ── 卡片级反馈（annotations）：触发点与「抓取 + 提交」解耦 ─────────────────────────────────
// 纪律（`docs/history/design-annotations.md` §3）：
//   · 不点按钮 / Esc / 空提交 ⇒ 端点**零**调用（防误触）；
//   · 提交只发 `{note, kind, sessionId, messageId, blockIndex, toolCallId?, role?, excerpt}`，
//     时间 / 版本 / state / id 由服务端补；
//   · 卡片上的「已反馈 / 已处理 ✓」**由服务端 state 驱动**（v1.5）：前端只发锚点 + 正文摘要，
//     显示什么全看 `GET /annotations?session=` 折出来的 `state`。
//
// ⚠️ **入口（触发点）可替换**（业主 2026-09-21 的一个问题作答还歧义：当前实现 = 每张卡
//   右下角的小按钮；底栏是否再加一个入口待定）。所以把「抓取 + 提交」与入口拆开：
//     · 抓取 + 提交 = 从一张card上读稳定锚点（`annotationAnchorOf`）＋前 200 字正文
//       （`annotationExcerptOf`）⇒ `pushAnnotation` ⇒ 本地标记 + 清单刷新。这一段与入口无关。
//     · 入口 = `installAnnotationTrigger(trigger)`，trigger = { name, mount(host) -> unmount }，
//       host = { openFor, cancelFor, submit }。默认实现 = `buttonAnnotationTrigger`。
//   若最后改到底栏（「标注模式」/打开列表），只换/加一个 trigger 即可，
//   侧车、端点、只读清单、校验都不用动。

function annotateControlOf(target) {
  return target?.closest?.('.annotate') ?? null;
}

/** 卡片里**人可见**的正文（前 200 字作 excerpt）：与「直播卡→正式卡」匹配的兜底**共用同一套
 *  规范化**（`render.js` 的 `annotationCardText`）—— 不然同一段正文两边算出不同的字，兜底就永远对不上。 */
function annotationExcerptOf(control) {
  const clean = annotationCardText(control);
  return clean ? [...clean].slice(0, 200).join('') : null;
}

function setAnnotationPending(control, pending) {
  const status = control.querySelector('.annotate-status');
  const submit = control.querySelector('.annotate-submit');
  if (status && pending) status.textContent = '提交中…';
  else if (status) status.textContent = '';
  if (submit) submit.disabled = pending;
  control.dataset.annotatePending = pending ? 'true' : '';
}

/** 只发一次 `POST /annotations`（端点/校验/落盘是服务端那一半；这里不碰任何触发点）。 */
async function pushAnnotation({ kind, sessionId, messageId, blockIndex, toolCallId, toolName, role, note, excerpt }) {
  return api('/annotations', {
    method: 'POST',
    body: JSON.stringify({
      note, kind, sessionId, messageId, blockIndex,
      ...(kind === 'toolResult' ? { toolCallId, toolName } : { role }),
      excerpt,
    }),
  });
}

/** 「抓取 + 提交」：从 `control`（一张卡上的标注控件）抓锚点与 excerpt，提交 `note`。
 *  触发点要么把用户在输入框里写的 `note` 传进来，要么省略（默认读卡下输入框里的值）。 */
async function submitAnnotation(control, noteOverride) {
  const anchor = annotationAnchorOf(control);
  const noteNode = control.querySelector('.annotate-note');
  const note = String((noteOverride ?? noteNode?.value) ?? '').trim();
  if (!note) return; // 空提交 = **零调用**（防误触）
  if (!anchor.sessionId) return; // 没有会话锚：宁可少一条，不编一个 id
  if (control.dataset.annotatePending === 'true') return;
  setAnnotationPending(control, true);
  try {
    const result = await pushAnnotation({ ...anchor, note, excerpt: annotationExcerptOf(control) });
    // 痕迹**由服务端那份记录驱动**（201 里回来的就是服务端补好的那一条：state/resolvedAt/resolvedBy）：
    // 把它并进这一批 marks 再重画 —— 走的是与「刷新后重新拉取」**同一条**路（`annotationMarkForCard`）。
    const record = result?.annotation;
    if (record?.id) {
      if (annotationMarks.sessionId !== anchor.sessionId) {
        annotationMarks.sessionId = anchor.sessionId;
        annotationMarks.items = [];
      }
      annotationMarks.items = [...annotationMarks.items.filter((item) => item.id !== record.id), record];
      annotationMarks.load = 'ready';
      annotationMarks.error = null;
    }
    if (noteNode) noteNode.value = '';
    applyAnnotationMarks(control.parentElement ?? messagesNode);
    notice('已把这个反馈交给维护者（写进 annotations.jsonl）。');
    if (currentView() === VIEW_ANNOTATIONS && annotationState.load === 'ready') {
      void loadAnnotations({ status: annotationState.status }); // 标注页开着就顺手重拉一次
    }
  } catch (error) {
    const status = control.querySelector('.annotate-status');
    if (status) status.textContent = `没提交成功：${error.message}`;
    notice(`反馈没提交成功：${error.message}`, true);
  } finally {
    setAnnotationPending(control, false);
  }
}

function openAnnotationForm(control) {
  const form = ensureAnnotationForm(control);
  if (!form) return;
  form.hidden = false;
  control.dataset.annotateOpen = 'true';
  form.querySelector('.annotate-note')?.focus();
}

function closeAnnotationForm(control) {
  const form = control.querySelector('.annotate-form');
  if (form) form.hidden = true;
  control.dataset.annotateOpen = '';
}

// 核心给触发点的三个动作（触发点不关心它们怎么实现）。
const annotationTriggerHost = {
  // 展开这张卡的输入框（默认实现会在卡下现造表单；别的触发点也可以不调它）。
  openFor: (control) => openAnnotationForm(control),
  cancelFor: (control) => closeAnnotationForm(control),
  submit: (control, note) => submitAnnotation(control, note),
};

let annotationTrigger = null;
/** 装/换一个触发点（幂等：先卸旧的）。返回装上的 trigger；传入 null 只卸不装。 */
function installAnnotationTrigger(trigger) {
  if (annotationTrigger?.unmount) annotationTrigger.unmount();
  annotationTrigger = trigger ?? null;
  if (annotationTrigger?.mount) annotationTrigger.unmount = annotationTrigger.mount(annotationTriggerHost) ?? null;
  return annotationTrigger;
}

/** **默认触发点** = 每张卡右下角的小按钮。全部走 `#messages` 上的委托监听（重画不会泄漏监听器）。 */
const buttonAnnotationTrigger = {
  name: 'card-button',
  mount({ openFor, cancelFor, submit }) {
    const onClick = (event) => {
      const button = event.target.closest?.('[data-annotate-action]');
      if (!button) return;
      const control = annotateControlOf(button);
      if (!control) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.annotateAction === 'open') openFor(control);
      else if (button.dataset.annotateAction === 'cancel') cancelFor(control);
    };
    const onSubmit = (event) => {
      const form = event.target?.closest?.('.annotate-form');
      if (!form) return;
      event.preventDefault();
      event.stopPropagation();
      const control = annotateControlOf(form);
      if (control) void submit(control);
    };
    const onKeydown = (event) => {
      const note = event.target?.closest?.('.annotate-note');
      if (!note) return;
      const control = annotateControlOf(note);
      if (!control) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelFor(control); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void submit(control); }
    };
    messagesNode.addEventListener('click', onClick);
    messagesNode.addEventListener('submit', onSubmit);
    messagesNode.addEventListener('keydown', onKeydown);
    return () => {
      messagesNode.removeEventListener('click', onClick);
      messagesNode.removeEventListener('submit', onSubmit);
      messagesNode.removeEventListener('keydown', onKeydown);
    };
  },
};

installAnnotationTrigger(buttonAnnotationTrigger);

/** 这张卡该显示的痕迹 —— **从服务端现状推出来**（不读任何本地记忆、不发请求）。
 *  同一张卡有几条标注时：**全都**是 done 才显示「已处理 ✓」；还留一条 open 就如实显示「已反馈 ✓」。 */
function annotationMarkForCard(control) {
  const anchor = annotationAnchorOf(control);
  if (!anchor?.sessionId || annotationMarks.sessionId !== anchor.sessionId) return null;
  const items = annotationMarks.items;
  let matched = items.filter((item) => annotationMatches(anchor, item, null));
  if (matched.length === 0) {
    // 兜底只会命中「直播期提交、还没有 messageId」的记录（也就那么一两条）——先按 blockIndex/kind 缩到
    // 0~1 条，**再**去读卡片正文：读正文要克隆一次 DOM，不能让大会话里每张卡都付这个钱。
    const candidates = items.some((item) => item.messageId === null && item.kind === anchor.kind && item.blockIndex === anchor.blockIndex);
    if (candidates) {
      const body = annotationCardText(control);
      matched = items.filter((item) => annotationMatches(anchor, item, body));
    }
  }
  if (matched.length === 0) return null;
  return matched.every((item) => item.state === 'done') ? 'done' : 'sent';
}

/** 重画/刷新之后，把每张卡的痕迹按**服务端现状**重画一遍：匹配上的画，
 *  **匹配不上的清掉** —— 不留上一次的本地残影（v1 的 `annotateSent` 正在这里骗过人）。
 *  `scope` 给直播侧新造的卡片用（它还没进 DOM 也可以先打标）。 */
function applyAnnotationMarks(scope = messagesNode) {
  for (const control of scope.querySelectorAll('.annotate')) {
    applyAnnotationState(control, annotationMarkForCard(control));
  }
}

/** 拉这个会话的标注现状（**服务端**把 resolve 事件折好的 `state`/`resolvedAt`/`resolvedBy`）。
 *  读不到 ⇒ 清空并**一个字都不显示**（宁可少显示，不张冠李戴）。 */
async function loadAnnotationMarks(sessionId = selectedId) {
  if (!sessionId) return;
  if (annotationMarks.sessionId !== sessionId) {
    annotationMarks.sessionId = sessionId;
    annotationMarks.items = [];
    annotationMarks.load = 'idle';
    annotationMarks.error = null;
  }
  const token = ++annotationMarks.token;
  annotationMarks.load = 'loading';
  try {
    const payload = await api(`/annotations?session=${encodeURIComponent(sessionId)}`);
    if (token !== annotationMarks.token || annotationMarks.sessionId !== sessionId) return;
    if (!Array.isArray(payload?.items)) {
      annotationMarks.load = 'error';
      annotationMarks.error = '服务端返回的形状不认识（没有 items 数组）';
      annotationMarks.items = [];
      return;
    }
    annotationMarks.items = payload.items;
    annotationMarks.load = 'ready';
    annotationMarks.error = null;
  } catch (error) {
    if (token !== annotationMarks.token) return;
    annotationMarks.load = 'error';
    annotationMarks.error = error.message;
    annotationMarks.items = [];
  } finally {
    if (token === annotationMarks.token) applyAnnotationMarks();
  }
}

async function createSession(body, label) {
  newProjectNode.disabled = true;
  newScratchNode.disabled = true;
  try {
    const created = await api('/sessions', { method: 'POST', body: JSON.stringify(body) });
    notice(`${label}已创建：${created.cwd}`);
    setNewSessionOpen(false);
    await refreshTree();
    await selectSession(created.id);
  } catch (error) {
    notice(error.message, true);
  } finally {
    newProjectNode.disabled = false;
    newScratchNode.disabled = false;
  }
}

async function selectSession(id) {
  const generation = ++sessionGeneration;
  sessionRequestController?.abort();
  const requestController = new AbortController();
  sessionRequestController = requestController;
  const previousId = selectedId;
  const previousText = promptNode.value;
  const shouldFlushPrevious = Boolean(previousId && composerAvailable && readOnlySessionId !== previousId && !draftUnavailable.has(previousId));
  cancelDraftTimer(previousId);
  sessionEvents?.close();
  sessionEvents = null;
  setSessionConnected(false);
  setComposerAvailable(false);
  const previousDraftSaved = shouldFlushPrevious ? await queueDraftWrite(previousId, previousText) : true;
  if (generation !== sessionGeneration) return;
  selectedId = id;
  paintTreeSelection();
  // I-53：选中的会话就是地址栏里那个会话（深链走的是同一个入口，于是「刷新/贴链接」落到的
  // 状态与「点树行」逐字一致 —— 不另写一套收尾）。
  syncSessionHash(id);
  updateArchiveUi();
  promptNode.value = '';
  resizePrompt({ reset: true });
  openErrorId = null;
  readOnlySessionId = null;
  visibleMessages = [];
  visibleMessagesId = null;
  visibleMessagesVersion += 1;
  clearPendingUser(); // 换会话：上一条会话的占位立刻摘掉（下面的 replaceChildren 还会再清一次）
  renderedSignature = null;
  renderedPayload = null;
  finishLive();
  cancelMessageRender(messagesNode);
  messagesNode.replaceChildren();
  syncBottomFollow();
  streaming = false;
  agentBusy = false;
  compacting = false;
  retryState = null; // 换会话：重试状态不许从上一会话残留（M-36）。
  upstreamErrorNotice = null;
  clearSessionNotice(); // M-41：换会话时上一条插件通知不许残留到新会话。
  clearSuggestions(); // 换会话：「模型建议」那排也不许跟过来（新会话的候选等它自己的事件）。
  sessionContext = null;
  closeCompactConfirm();
  closeDeleteConfirm();
  applyQueue({});
  commands = [];
  commandsFor = null;
  commandsStreaming = false;
  commandsLoading = false;
  commandsError = null;
  models = [];
  modelsFor = null;
  modelsLoading = false;
  modelsError = null;
  commandDismissed = '';
  closeCommands();
  mentions?.close();
  titleNode.textContent = treeName(id);
  renameRequest = null;
  renameFormNode.hidden = true;
  renderSessionCwd(sessionCwdNode, null);
  sessionThinkingLevel = null; // M-11：换会话时先清空，不把上一条的档位留在这一行
  renderSessionObservability(sessionUsageNode, null, null, sessionThinkingLevel);
  renderContextUsage(sessionContextNode, null);
  updateSessionActions();
  // P1：换会话 —— 问题页状态清空，视图按会话从内存里取回（默认「会话」；不落盘）。
  resetQuestionState(id);
  annotationsView = false; // 选会话 ⇒ 离开全局标注页，回到这个会话自己的 view
  debugView = false; // 同理：选会话也离开全局调试页（两个全局页签都压过 per-session 的 view）
  applyView();
  notice('正在打开会话…');
  try {
    const detail = await api(`/sessions/${id}`, { signal: requestController.signal });
    if (generation !== sessionGeneration) return;
    readOnlySessionId = detail.readOnly === true ? id : null;
    titleNode.textContent = `${detail.name || treeName(id)}${detail.archived ? '（已归档）' : ''}${detail.readOnly ? '（只读）' : ''}`;
    sessionContext = detail.context ?? null;
    // M-11：档位只在服务端真给了非空字符串时才采用（读不到就是 null，不猜）。
    sessionThinkingLevel = typeof detail.runtime?.thinkingLevel === 'string' && detail.runtime.thinkingLevel.trim() !== '' ? detail.runtime.thinkingLevel : null;
    renderSessionCwd(sessionCwdNode, detail.cwd);
    renderSessionObservability(sessionUsageNode, detail.observability, sessionContext, sessionThinkingLevel);
    renderContextUsage(sessionContextNode, sessionContext);
    updateSessionActions();
    streaming = detail.runtime?.isStreaming === true;
    agentBusy = detail.runtime?.isStreaming === true;
    compacting = detail.runtime?.isCompacting === true;
    // P1：问题页数据。① 切到会话时轮询一次未答计数（`session.question` 事件缺席时计数也不冻住）；
    // ② 这个会话上次停在问题页 ⇒ 顺手把当前那一页也拉一次。两者都不阻塞打开会话。
    void refreshQuestionCounts(id, generation);
    // 卡片级反馈：这个会话的标注现状（服务端折好的 open/done）也拉一次 —— 卡面上的「已反馈 / 已处理 ✓」
    // 全靠它。刷新页面后内存清空、这里会重新拉到 —— 那正是「服务端 state 驱动」的证据（见 test/annotate.mjs 臂 B）。
    void loadAnnotationMarks(id);
    if (currentView() === VIEW_QUESTIONS) void loadQuestions({ status: questionState.status });
    // 只读会话（cwd 已不在）连不上会话流（服务端 /events 会 409），所以不连，只拉历史。
    if (detail.readOnly) {
      await refreshMessages(id, generation, { forceBottom: true, signal: requestController.signal });
      if (generation !== sessionGeneration) return;
      notice(`这个会话的工作目录已不存在（${detail.cwdMissing}）—— 可以查看历史，不能继续`, true);
      return;
    }
    // **先连流，再拉正文**：不改这条顺序的话，「● 已连接」要等 /sessions/{id} + /messages +
    // /draft + 首屏画完才出现 —— 用户感知到的「会话流连得慢」就来自这里（实测：真机服务端
    // open→session.snapshot 只要 11–17ms，慢的是客户端根本还没开始连）。连上后初连快照会立刻
    // 回来，它的 refreshMessages 与本行的 refreshMessages 用 `coalesce` 合并成**一次** GET。
    // （挂在 docs/ops/handoff.md 的既有闸：同一份正文不重画见 historySignature；test:connectflow。）
    connectSessionEvents(id, generation);
    await refreshMessages(id, generation, { forceBottom: true, signal: requestController.signal, coalesce: true });
    if (generation !== sessionGeneration) return;
    const draftWarning = await restoreDraft(id, generation, requestController.signal);
    if (generation !== sessionGeneration) return;
    setComposerAvailable(true);
    resizePrompt();
    abortNode.disabled = !agentBusy && !detail.runtime?.isCompacting && !detail.runtime?.isRetrying;
    notice(draftWarning ?? (previousDraftSaved ? '' : '上一个会话的草稿保存失败（不影响本会话发送）'));
    void loadCommands(id, generation, requestController.signal);
  } catch (error) {
    if (generation !== sessionGeneration) return;
    sessionEvents?.close();
    sessionEvents = null;
    setSessionConnected(false);
    openErrorId = id;
    readOnlySessionId = null;
    streaming = false;
    agentBusy = false;
    applyQueue({});
    titleNode.textContent = `${treeName(id)}（打不开）`;
    renderSessionCwd(sessionCwdNode, null);
    sessionThinkingLevel = null;
    renderSessionObservability(sessionUsageNode, null, null, sessionThinkingLevel);
    renderContextUsage(sessionContextNode, null);
    updateSessionActions();
    resetQuestionState(id);
    // 会话没打开就不发问题清单的请求（避免把两个错误指成一个）——页上如实写清楚。
    questionState.load = 'error';
    questionState.error = '会话没打开，问题清单这次没拉。';
    applyView();
    setComposerAvailable(false);
    if (error?.status === 404) {
      // 打不开是因为「这个会话根本不存在」（典型：深链指向一个已被删掉的会话）：
      // 给可读提示，并把地址栏里那个死 id 清掉 —— 不然一个坏链接每刷新一次就再试一次。
      // 其它失败（网络 / 5xx / cwd 缺失）保留 hash：那个会话只是**暂时**打不开。
      clearSessionHash();
      notice(`这个会话不存在（可能已被删除）：${id}`, true);
      return;
    }
    notice(openFailureMessage(error), true);
  }
}

newSessionToggleNode.addEventListener('click', () => setNewSessionOpen(newSessionPanelNode.hidden));
newSessionCancelNode.addEventListener('click', () => setNewSessionOpen(false));

// M-08 改名：PATCH /sessions/{id} {name}。不做乐观更新 —— 只有 2xx 才改标题，
// 失败原样回滚（标题仍是改名前那条）并把服务端原因写进 error notice。
renameNode.addEventListener('click', openRename);
renameCancelNode.addEventListener('click', () => {
  closeRename();
  notice('已取消改名；标题未变。');
});
sessionTitleInputNode.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeRename();
  notice('已取消改名；标题未变。');
});
renameFormNode.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = selectedId;
  if (!id || renameRequest) return;
  const generation = sessionGeneration;
  const name = sessionTitleInputNode.value.trim();
  if (!name) {
    notice('标题不能为空。', true);
    return;
  }
  renameRequest = { id, name };
  renameNode.disabled = true;
  try {
    const result = await api(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    if (generation !== sessionGeneration || id !== selectedId) return;
    const applied = typeof result.name === 'string' && result.name ? result.name : name;
    const session = treeSessions.find((entry) => entry.id === id);
    if (session) { session.name = applied; session.titleSource = 'manual'; }
    renameRequest = null;
    renameFormNode.hidden = true;
    applySessionTitle(applied);
    renderSessionTree();
    updateArchiveUi();
    updateSessionActions();
    notice(`标题已改成「${applied}」（此后模型不会再覆盖人设的标题）`);
  } catch (error) {
    if (generation !== sessionGeneration || id !== selectedId) return;
    renameRequest = null;
    renameFormNode.hidden = true;
    applySessionTitle();
    updateSessionActions();
    notice(`改名失败：${error.message}`, true);
  }
});

// M-18 左栏搜索 + 只看命名（纯前端过滤，不发请求）。搜索行默认收起（否则窄屏会把树的第一行挤出首屏），
// 点导航里的「搜索」展开。
treeSearchToggleNode.addEventListener('click', () => {
  const open = treeSearchPanelNode.hidden;
  treeSearchPanelNode.hidden = !open;
  treeSearchToggleNode.setAttribute('aria-expanded', String(open));
  if (open) treeSearchInputNode.focus();
});
treeSearchInputNode.addEventListener('input', () => {
  treeQuery = treeSearchInputNode.value;
  renderSessionTree();
});
treeNamedOnlyNode.addEventListener('click', () => {
  treeNamedOnly = !treeNamedOnly;
  treeNamedOnlyNode.setAttribute('aria-pressed', String(treeNamedOnly));
  renderSessionTree();
});

// M-18（排序模式）：单击在三种兄弟顺序间循环（TUI 用 Ctrl+S 切；网页是按钮派，落点放导航）。
// 只重画左树，不动选中/滚动之外的东西（renderTree 自己保留两条滚动轴）。
const TREE_SORT_LABELS = { recent: '最近', oldest: '最早', name: '名称' };
const TREE_SORT_NEXT = { recent: 'oldest', oldest: 'name', name: 'recent' };
if (treeSortToggleNode) {
  const updateTreeSortUi = () => {
    const nextMode = TREE_SORT_NEXT[treeSortMode] ?? 'recent';
    treeSortToggleNode.textContent = `排序 ${TREE_SORT_LABELS[treeSortMode]}`;
    treeSortToggleNode.setAttribute('aria-label', `会话排序：${TREE_SORT_LABELS[treeSortMode]}，点一下切换`);
    treeSortToggleNode.title = `会话排序：${TREE_SORT_LABELS[treeSortMode]} · 点一下换成「${TREE_SORT_LABELS[nextMode]}」`;
  };
  treeSortToggleNode.addEventListener('click', () => {
    treeSortMode = TREE_SORT_NEXT[treeSortMode] ?? 'recent';
    updateTreeSortUi();
    renderSessionTree();
  });
  updateTreeSortUi();
}

// ── 跨栏拖选的「选区护栏」（业主 2026-09-21：Windows + Firefox，在正文里按下拖选、把指针挪到
//    左边会话栏上空 ⇒ 主线程卡 0.75–0.9 s）─────────────────────────────────────────────────────
// 成因（实测，不是猜）：指针一旦离开 `#messages`，Range 的起点就落到 `<main>` 之前（树在 DOM 里
//   排在 main 前面）⇒ 这一次拖选把「#messages 开头 → 锚点」整段旧正文都圈进选区；大会话里那些
//   节点带 `content-visibility: auto`（见 `index.html`），被选区覆盖就变成「对用户相关」⇒ 浏览器
//   必须为它们补出真实布局（15 MB 夹具：Firefox 0.75–0.9 s / Chromium 0.6–0.7 s 主线程长任务）。
//   同一个 Range、同一份正文，把 content-visibility 换成 `visible` 只要 ~50 ms ⇒ 贵的是「为选区
//   补布局」，不是选区本身（分层臂见 `test/drag-select-cost.mjs`）。
// 护栏：拖选期间把「已经滚出正文可视区」的子节点标上 `data-sel-clamp` ⇒ 那条 CSS 让它们
//   `content-visibility: hidden`（无条件跳过）⇒ Range 够不着、布局也就不必补。松手即撤。
//   · 只在**横向**离开正文（指针 x 出了容器、y 还在容器里）上护栏：纵向离开会触发容器自动滚动，
//     滚动中「谁在屏幕外」一直在变，护栏会过时（可能把正在看的消息藏住）—— 那条路本轮没修，见报告。
//   · 不标「含选区锚点的那一条」：万一标中它，用户正看着的选区会被藏掉。
//   · 全局 pointermove 只多一点常数开销：没按左键时只读一次 event.buttons 就返回。
let selectionClampMarks = null;
function clearSelectionClamp() {
  if (!selectionClampMarks) return;
  for (const node of selectionClampMarks) delete node.dataset.selClamp;
  selectionClampMarks = null;
}
function applySelectionClamp() {
  const box = messagesNode.getBoundingClientRect();
  const children = [...messagesNode.children];
  const anchor = document.getSelection()?.anchorNode ?? null;
  // 一批读、一批写：读写交错会让浏览器每轮都强制一次布局。
  const rects = children.map((node) => node.getBoundingClientRect());
  const marks = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (anchor && node.contains(anchor)) continue;
    const rect = rects[index];
    if (rect.bottom < box.top + 4 || rect.top > box.bottom - 4) marks.push(node);
  }
  for (const node of marks) node.dataset.selClamp = '1';
  selectionClampMarks = marks;
}
window.addEventListener('pointermove', (event) => {
  if ((event.buttons & 1) === 0) { clearSelectionClamp(); return; }
  const box = messagesNode.getBoundingClientRect();
  const crossColumn = event.clientX < box.left || event.clientX > box.right;
  const inRow = event.clientY >= box.top && event.clientY <= box.bottom;
  if (!crossColumn || !inRow) { clearSelectionClamp(); return; }
  if (!selectionClampMarks) applySelectionClamp();
}, { capture: true, passive: true });
window.addEventListener('pointerup', clearSelectionClamp, true);
window.addEventListener('pointercancel', clearSelectionClamp, true);

messagesNode.addEventListener('scroll', () => {
  clearSelectionClamp(); // 滚动会让「谁在屏幕外」过时，护栏绝不能把正在看的消息藏住
  if (syncBottomFollow()) void markSeenIfVisible();
}, { passive: true });
jumpNode.addEventListener('click', () => {
  scrollToBottom();
  void markSeenIfVisible();
});

newProjectNode.addEventListener('click', () => createSession({}, '项目会话'));
newScratchNode.addEventListener('click', () => createSession({ scratch: true }, '临时会话'));
advancedSessionNode.addEventListener('submit', async (event) => {
  event.preventDefault();
  const cwd = newCwdNode.value.trim();
  if (!cwd) return;
  await createSession({ cwd }, '指定目录会话');
});

// 服务端的忙冲突原文（pi 自己的措辞）：`session_streaming` + STREAMING_CONFLICT。
// 它是在**入队之前**抛的（服务端 busyConflict 先于 session.prompt / session.steer），所以按正确语义
// 重发同一条文本不会产生重复消息 —— 这是两个方向的自动兜底唯一能成立的理由（幂等）。
const BUSY_CONFLICT_MARK = 'streamingBehavior';

function busyConflictNotice(error) {
  const text = String(error?.serverMessage ?? error?.message ?? '');
  if (error?.status !== 409) return null;
  if (text.includes(BUSY_CONFLICT_MARK)) return '409 这一轮还在跑（工具/收尾没结束）：消息没有发出去，也没有丢 —— 文字还在输入框里，稍后回车会按「插话」排队。';
  if (text.includes('not currently processing')) return '409 会话这轮已经结束：消息没有发出去，也没有丢 —— 文字还在输入框里，再回车一次会按新消息发送。';
  return null;
}

// 409 的**方向**（`api()` 透传的 `body.error`）。忙冲突是两个方向，措辞不同、语义相反：
//   'session_streaming'     —— 还在跑（message 路由遇到的忙冲突）      = 「以为空闲，其实在跑」；
//   'session_not_streaming' —— 已经闲了（steer/followUp 的忙冲突）    = 「以为在跑，其实已经闲」；
//   别的码（如 session_compacting）不是忙冲突的方向，返回它本身，由调用方原样抛出。
// 拿不到码时退回按原文认（老服务端 / 老夹具也不至于漏判）。
function busyConflictCode(error) {
  if (error?.status !== 409) return null;
  if (typeof error.serverCode === 'string') return error.serverCode;
  const text = String(error?.serverMessage ?? error?.message ?? '');
  if (text.includes(BUSY_CONFLICT_MARK)) return 'session_streaming';
  if (text.includes('not currently processing')) return 'session_not_streaming';
  return null;
}

// 投递一条消息，把「客户端以为的忙闲」与「服务端事实」对不上时的 409 兜住。两个方向各自**只兜一次**：
//  · 正方向（以为空闲、其实在跑，比如 session.start 还没到）：message 撞 'session_streaming'
//    → 同一条文本改走 steer（插话语义）；
//  · 反方向（以为在跑、其实已经闲，= 服务端刚 settle、`session.settled` 还在路上）：steer/followUp 撞
//    'session_not_streaming' → 同一条文本按「普通新消息」重发一次。
//    这一支正是「用户那句话被一个几毫秒的缝隙吃掉」：state-skew 实测 message(409) → 兜底 steer
//    两跳之间中位 6ms（5–9ms），这一轮若正好在这 6ms 里结束，steer 也被 409 拒、而原文根本没送出去。
//    ⚠️ 撞上来的那个 steer **两种来源都算**：① 用户回车时客户端以为在跑、直接选了 steer/followUp；
//    ② 客户端以为空闲先打了 message、撞 409 后兜底改走的 steer（用户报的就是这一条：message→steer 两跳）。
// 两个方向共享同一条幂等前提：`busyConflict()` 在 session.steer / session.prompt **入队之前**抛
// （server/base-logic.mjs），失败那次什么都没进会话 ⇒ 重发不会变成两条。
// 反方向额外要求三个条件**同时**成立，任一不成立就保持今天那句可读 409（不替用户乱猜）：
//   (a) 输入框里还是这次发送时的原文 —— 用户改过就不发（他现在要发的是另外一段）；
//   (b) 此刻只有这一次发送在飞（sendInFlight===1）—— 有别的发送交叉时不补，免得两条发送各自兜底；
//   (c) 只补这一次 —— 重发的结果（成功或失败）原样往上抛，这里没有第二跳，绝不重试成环。
// 返回真正落地的那条语义（'message' | 'steer' | 'followUp'），notice 据此说人话。
async function sendMessageWithBusyFallback(id, mode, text, composerSnapshot) {
  const route = mode === 'followUp' ? 'follow-up' : mode;
  // 反方向兜底（只在这里、只跳一次）：把同一条原文按「普通新消息」重发。
  const resendAsPlainMessage = async (originError) => {
    if (promptNode.value !== composerSnapshot || sendInFlight !== 1) throw originError;
    await api(`/sessions/${id}/message`, { method: 'POST', body: JSON.stringify({ text }) });
    return 'message';
  };
  try {
    await api(`/sessions/${id}/${route}`, { method: 'POST', body: JSON.stringify({ text }) });
    return mode;
  } catch (error) {
    const code = busyConflictCode(error);
    if (mode === 'message' && code === 'session_streaming') {
      try {
        await api(`/sessions/${id}/steer`, { method: 'POST', body: JSON.stringify({ text }) });
        return 'steer';
      } catch (steerError) {
        // 兜底踩的这脚也撞上「已经闲了」（这一轮正好在两跳之间结束）⇒ 反方向补一次。
        if (busyConflictCode(steerError) === 'session_not_streaming') return resendAsPlainMessage(steerError);
        throw steerError;
      }
    }
    if (mode !== 'message' && code === 'session_not_streaming') return resendAsPlainMessage(error);
    throw error;
  }
}

/**
 * 投递一条消息。
 * `mode` 与投递语义不变；`explicitText` 是「模型建议」那颗 chip 的入口：
 *   · `null`（默认）= **来自输入框**（打字 / 回车那条路，行为逐字不变）；
 *   · 非 `null` = 显式给一段文本（chip 点出来的）——**投递路完全同一条**（同样的 `message`/`steer`
 *     与同一个忙冲突兜底），差别只有两处、都不碰投递语义：
 *     ① 不读也不清输入框（**永不覆盖你正在打的字**，也不动草稿）；
 *     ② 反向忙冲突兜底（「输入框里还是这次发送时的原文」那条前提）不适用 —— 跳过它，
 * 返回 `true` = 真的投递出去了（调用方可以据此收起自己的 UI 状态）；`false` = 没投出去（守卫拦住/失败）。
 */
async function send(mode = agentBusy ? 'steer' : 'message', explicitText = null) {
  if (!selectedId || !composerAvailable) return false;
  if (compacting) {
    notice('正在压缩，当前消息没有发送也没有排队；请等压缩完成后重试。', true);
    return false;
  }
  const fromComposer = explicitText === null;
  const id = selectedId;
  const generation = sessionGeneration;
  // 「按下回车那一刻屏幕上已经有一块直播在放着吗」—— 给占位消息的落位用（见 `appendPendingUser`）：
  // 那一块（上一轮留下的）比这条**老**，占位得落在它后面。必须在这里取：`await` 回来之后再读，
  // 读到的可能是**这条自己那一轮**新开的那块 —— 那是它的回话，占位得排在它**前面**。
  const liveAtSend = liveActive;
  // 这次发送时的输入框原文：反方向兜底只在「它还没被改过」时才敢重发（见 sendMessageWithBusyFallback）。
  // chip 那条路没有“输入框原文”这个事实 ⇒ 传 null（兜底自然跳过，见函数注释）。
  const composerSnapshot = fromComposer ? promptNode.value : null;
  const resolved = mentions.resolveForSend(fromComposer ? promptNode.value : explicitText);
  if (!resolved.ok) {
    notice(resolved.error, true);
    return false;
  }
  const text = resolved.text.trim();
  if (!text) return false;
  const command = selectedCommand(text);
  if (command && (agentBusy || commandsStreaming)) {
    notice(`会话正在跑 —— 命令「/${command.name}」不能插话也不能排队，等这一轮跑完再发。`, true);
    return false;
  }
  if (command?.runnable === false) {
    notice(`「/${command.name}」在网页里不能执行：${command.reason || 'TUI 专用'}`, true);
    return false;
  }
  sendInFlight += 1;
  sendNode.disabled = true;
  try {
    if (command?.via === 'compact') {
      askCompact(text.slice(command.name.length + 1).trim() || null);
      return true;
    }
    if (command?.via === 'model') {
      const wanted = text.slice(command.name.length + 1).trim();
      if (!wanted) {
        promptNode.value = '/model ';
        resizePrompt();
        commandDismissed = '';
        syncCommands();
        notice('要切哪个模型？从下面选择，当前模型排最前。');
      } else await setSessionModel(wanted);
      return true;
    }
    let landed;
    if (command) {
      // 命令**不兜**忙冲突：命令不能以 steer/followUp 语义发散（同一段文本就成了插话而不是命令）。
      // 命令的忙判已在上面那道闸里做了；这里只把普通消息的 409 兜住。
      await api(`/sessions/${id}/message`, { method: 'POST', body: JSON.stringify({ text }) });
      landed = 'message';
    } else {
      landed = await sendMessageWithBusyFallback(id, mode, text, composerSnapshot);
    }
    if (generation !== sessionGeneration || id !== selectedId) return true; // 已经投出去了（只是界面换人了）
    // 命令（扩展 / prompt 模板 / skill）**不**发占位：pi 会在服务端再解释一遍这段文本
    // —— 扩展命令被直接吃掉（连 user 正文都不会有），prompt/skill 会被展开成另一段文本
    // （pi 的 `expandPromptTemplate` / `_expandSkillCommand`）⇒ 客户端画的占位永远兑不掉，会剩个
    // 拆不掉的「已发送」泡泡。命令的可见证据是它自己落下的正文 / 扩展消息块。
    // 命令清单还没拿到时（切会话的头几百毫秒）判不出 `/xxx` 会不会被改写 ⇒ 也一律不画（保守方向：
    // 宁可这一条等正文，也不要留一个永远兑不掉的泡泡）。
    if (!command && !(text.startsWith('/') && commandsFor !== selectedId)) appendPendingUser(text, landed, liveAtSend);
    scrollToBottom();
    // 这一轮的建议已经过时 ⇒ 那排当场收起（下一轮的候选自己会再来）。
    clearSuggestions();
    if (fromComposer) {
      cancelDraftTimer(id);
      promptNode.value = '';
      resizePrompt({ reset: true });
      closeCommands();
      mentions.close();
      const cleared = await queueDraftWrite(id, '', generation);
      if (generation !== sessionGeneration || id !== selectedId) return true;
      if (cleared) notice(landed === 'steer' ? '插话已接收（这一轮还在跑），等待队列确认' : landed === 'followUp' ? '后续消息已接收，等待队列确认' : '消息已接收');
    } else {
      // chip 那条路：**输入框一个字都不动**（草稿也不写），只给一条回执。
      notice(landed === 'steer' ? '建议已作为插话发出（这一轮还在跑），等待队列确认' : '建议已发出');
    }
    return true;
  } catch (error) {
    if (generation === sessionGeneration && id === selectedId) {
      // 忙冲突说人话：不要把 pi 的英文原句直接端给用户；输入框里的文字**绝不丢**。
      notice(busyConflictNotice(error) ?? `${mode === 'message' ? '发送' : mode} 失败：${error.message}`, true);
    }
    return false;
  } finally {
    sendInFlight -= 1;
    if (generation === sessionGeneration && id === selectedId && composerAvailable) {
      sendNode.disabled = false;
      promptNode.focus();
    }
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

promptNode.addEventListener('input', () => {
  // 用户开始打字 = 上一条报文（含错误）已经看到了，行让回状态层（v2.1 的
  // 「改了输入就撕掉上次的提示」同一条纪律，只是搬到了同一行上）。
  clearNotice();
  resizePrompt();
  commandDismissed = '';
  syncCommands();
  scheduleDraftSave();
});

promptNode.addEventListener('keydown', (event) => {
  if (commandMode !== null) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (commandItems.length > 0) {
        commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandItems.length) % commandItems.length;
        renderCommands();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommands({ dismiss: true });
      return;
    }
    if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (commandItems.length === 0) {
        if (event.key === 'Tab') event.preventDefault();
      } else {
        event.preventDefault();
        const item = commandItems[commandIndex];
        if (commandMode.kind === 'model') {
          chooseCommandItem(item);
          return;
        }
        if (item.runnable === false) {
          chooseCommandItem(item);
          return;
        }
        const exact = promptNode.value === `/${item.name}`;
        if (event.key === 'Enter' && exact && !item.argumentHint) {
          closeCommands();
          void send('message');
        } else chooseCommandItem(item);
        return;
      }
    }
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (event.altKey || event.metaKey) void send(agentBusy ? 'followUp' : 'message');
  else void send(agentBusy ? 'steer' : 'message');
});

mentions = mountMentions({
  input: promptNode,
  getNodes: () => treeSessions,
  getActiveId: () => selectedId,
  isBlocked: () => commandMode !== null,
});

document.addEventListener('mousedown', (event) => {
  if (commandMode !== null && !commandPaletteNode.contains(event.target) && event.target !== promptNode) closeCommands({ dismiss: true });
  if (mentions.isOpen() && !mentions.box.contains(event.target) && event.target !== promptNode) mentions.close();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !selectedId || !composerAvailable || readOnlySessionId === selectedId || draftUnavailable.has(selectedId)) return;
  cancelDraftTimer(selectedId);
  const id = selectedId;
  const generation = sessionGeneration;
  void fetch(`/api/sessions/${id}/draft`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ text: promptNode.value }),
    keepalive: true,
  }).then((response) => {
    if (!response.ok && generation === sessionGeneration && id === selectedId) notice(`草稿保存失败（不影响发送）：HTTP ${response.status}`, false);
  }).catch((error) => {
    if (generation === sessionGeneration && id === selectedId) notice(`草稿保存失败（不影响发送）：${error.message}`, false);
  });
});

archiveNode.addEventListener('click', async () => {
  const session = treeSessions.find((entry) => entry.id === selectedId);
  if (!session || archiveRequest) return;
  const id = session.id;
  const archived = !session.archived;
  archiveRequest = { id, archived };
  updateArchiveUi();
  try {
    await api(`/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) });
    try {
      await refreshTree({ markSeen: false });
      if (id === selectedId) notice(archived ? '已存档' : '已取消存档');
    } catch (error) {
      if (id === selectedId) notice(`${archived ? '已存档' : '已取消存档'}，但刷新会话树失败：${error.message}`, true);
    }
  } catch (error) {
    if (id === selectedId) notice(`${archived ? '存档' : '取消存档'}失败：${error.message}`, true);
  } finally {
    if (archiveRequest?.id === id) archiveRequest = null;
    updateArchiveUi();
  }
});

// M-18（删除会话）：入口 → 确认行 → 归档（不做真删除）。取消时不发任何请求。
deleteNode.addEventListener('click', () => askDelete());
deleteConfirmYesNode.addEventListener('click', () => void runDelete());
deleteConfirmNoNode.addEventListener('click', () => {
  closeDeleteConfirm();
  notice('已取消删除；没有发出请求。');
});

compactNode.addEventListener('click', () => askCompact());
compactConfirmYesNode.addEventListener('click', () => void runCompact());
compactConfirmNoNode.addEventListener('click', () => {
  closeCompactConfirm();
  notice('已取消压缩；没有发出请求。');
});

abortNode.addEventListener('click', async () => {
  if (!selectedId) return;
  const id = selectedId;
  const generation = sessionGeneration;
  abortNode.disabled = true;
  try {
    const result = await api(`/sessions/${id}/abort`, { method: 'POST', body: '{}' });
    if (generation !== sessionGeneration || id !== selectedId) return;
    // 只在「这一轮真的还在跑」时才回执：SSE 的 session.end/settled 可能比这条 HTTP 回执先到
    // （先到就已经有「已中断，可以继续发送」了），这时候不能再拿一句旧话把它盖回去。
    if (result.aborted && agentBusy) notice('已发出中断');
    else if (result.reason === 'abort_timeout') {
      // 服务端到点还没等到空闲（比如某个工具不返回）—— 这**不是**「已停止」，也不是「没在运行」。
      // 如实说，并把按钮放回去让用户重试（回合还没结束，SSE 也不会替它复位）。
      abortNode.disabled = !agentBusy && !compacting;
      notice('中断没停下（服务端到点还没等到空闲）—— 可以再按一次', true);
    }
    else if (!result.aborted) notice('会话当前没有在运行');
  } catch (error) {
    if (generation !== sessionGeneration || id !== selectedId) return;
    abortNode.disabled = !agentBusy;
    notice(`中断失败：${error.message}`, true);
  }
});

// ── 设置浮层（业主 2026-09-22：「我希望设置是一个悬浮窗，而不是打开一个新窗口」）──────────
// 左栏底栏那条「设置」开/关 `#settings-overlay`（**不导航**）；读写与独立页 `/settings.html`
// 是同一对 `GET/PATCH /settings`（同一份侧车）。这里只做**一件事**：把服务端回的生效值交给
// `render.js` 的 `setThinkingDefaultFold()`（它只存不推算）—— 于是浮层里改完，会话页的
// thinking 全局默认**当场**跟着变（不用等刷新；独立页做不到这一点，刷新也仍然生效）。
mountSettingsPanel({ onEffective: (payload) => setThinkingDefaultFold(payload?.settings?.['thinking.defaultFold']) });

const treeEvents = new EventSource('/api/tree/events');
treeEvents.onopen = () => {
  treeConnected = true;
  renderTreeConnection();
};
treeEvents.addEventListener('tree.snapshot', queueTreeRefresh);
treeEvents.addEventListener('tree.session', queueTreeRefresh);
treeEvents.onerror = () => {
  treeConnected = false;
  renderTreeConnection();
};

try {
  // S0b keeps this host probe as proof that B still proxies ordinary JSON to A.
  await fetch('/api/host', { headers: { accept: 'application/json' } });
  // 配置与树/设备并行拿：它们互不依赖，但都必须在开第一条会话**之前**就位 ——
  // `refreshSettings` 决定 thinking 块的默认折叠，晚了就会先按错的默认画一帧。
  await Promise.all([refreshTree(), refreshDevices(), refreshSettings()]);
} catch (error) {
  notice(`启动失败：${error instanceof Error ? error.message : String(error)}`, true);
}

// I-53 深链：地址栏带着 `#<完整 uuid>` 就当用户点名要开这个会话（刷新 / 收藏夹 / 贴过来的链接）。
// 放在 /tree 之后：树先落地，于是选中高亮、标题、右键动作一开就是齐的；用 await 让「页面就绪」
// 包含「深链已打开」——load 事件之后不再是半成品。失败/不存在的 id 由 selectSession 自己的
// 降级路径接管（可读提示，绝不把整个页面拖垮）。
const initialSessionHash = sessionIdFromHash();
if (initialSessionHash) await selectSession(initialSessionHash);
// 跟随外部导航：用户手改地址栏、别的页面带 hash 跳进来、以及**真**历史前进/后退。
// 本页自己写的 hash 不进这里（replaceState 不派 hashchange；即便派了，`id === selectedId`
// 也把它挡掉），所以不会有回环。非法/空 hash、以及「指向已打开的那个会话」一律静默忽略：
// 不动当前界面、不弹错（v2.1 对空 hash 就是忽略）。
window.addEventListener('hashchange', () => {
  if (hashWriteInFlight) return;
  const id = sessionIdFromHash();
  if (!id || id === selectedId) return;
  void selectSession(id);
});
