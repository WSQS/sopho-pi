import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommandPalette } from '../web/render.js';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Manual contract for the DOM surface used by web/render.js and web/app.js.
// When either frontend starts using another DOM API, add it here and implement it
// in test/fake-dom.mjs before relying on the fake in a behavior suite.
const contract = {
  elementMethods: ['setAttribute', 'getAttribute', 'removeAttribute', 'append', 'prepend', 'replaceChildren', 'remove', 'insertBefore', 'closest', 'matches', 'contains', 'querySelector', 'querySelectorAll', 'focus', 'setSelectionRange', 'scrollIntoView', 'addEventListener',
    // 直播块的持久文本节点：v2.2 每个 delta 重写整块正文，改成 `appendData` 增量。
    // 假 DOM 的文本节点就是 FakeElement，所以按 Element 方法声明。
    'appendData',
    // 卡片正文取样（v1.5 的 web/render.js 的 annotationCardText）：`cloneNode(true)` 拿一份
    // `.message-body` 的副本、剔掉里面的工具卡 —— 假 DOM 的 `cloneNode` 与真 DOM 同语义（深拷子节点）。
    'cloneNode',
    // 注解触发点的装卸（web/app.js 的 installAnnotationTrigger）要卸监听；假 DOM 从不真派事件，
    // `removeEventListener` 与已有的 `addEventListener` 同为登记意义的空函数。
    'removeEventListener'],
  elementProperties: ['dataset', 'style', 'hidden', 'disabled',
    // TUI 平价（工具卡耗时）：跑着的卡的共享定时器按 `isConnected` 清场（离开文档的旧卡自己出册）。
    'isConnected'],
  documentMethods: ['createElement', 'createTextNode'],
};

// This broader reviewed-call list is intentionally mechanical: a new member call
// anywhere in either covered frontend makes this gate red until it is classified
// as a DOM API (and added above) or an ordinary JavaScript call.
const reviewedMemberCalls = new Set([
  'abort', // AbortController#abort: session switches cancel stale GETs; this is not a DOM API.
  'add', 'addEventListener', 'all', 'append', 'appendData', 'catch', 'close', 'contains', 'createElement', 'createTextNode', 'delete', 'exec', 'filter', 'finally', 'find', 'focus',
  // P1（manager toolkit）问题页：`event.target.closest(selector)` 与
  // `input.setSelectionRange(...)` 都是 Element 方法（已在上面 contract.elementMethods 里声明）——
  // 前者用**一个**委托监听处理列表里所有动作按钮，后者在重画后把光标还给答题输入框。
  'closest', 'setSelectionRange',
  // `insertBefore`：直播块与占位消息的**落位**（web/render.js 的 appendMessageNodes 按
  // `options.before` 插到活跃直播块之前；web/app.js 的 restackTransient 把占位/直播块按说话
  // 顺序摆回尾部）。它是 Element 方法（已在下方 contract.elementMethods 里声明）。
  'insertBefore',
  // 跨栏拖选的「选区护栏」（web/app.js，e2dcca6「跨栏拖选不再为选区补出整段旧正文的布局」）。
  // 拖选期间把**已滚出正文可视区**的子节点标上 `data-sel-clamp`，那条 CSS 让它们
  // `content-visibility: hidden`（Range 够不着 ⇒ 浏览器不必为选区补布局）。两个成员都是标准 DOM API：
  //   · `getBoundingClientRect`（Element 的布局 API，回 DOMRect）：取 `#messages` 与每个子节点的
  //     视口矩形，判「谁在可视区外」（一批读、一批写，免得读写交错逼浏览器反复布局）；
  //   · `getSelection`（Document 的选区 API，`document.getSelection()` ⇒ Selection）：取
  //     `anchorNode` 跳过「含选区锚点的那一条」，免得把用户正看着的选区藏掉。
  // 假 DOM 既没有布局也没有选区模型（同下面的 Storage / History 一类：登记为 DOM API，
  // 语义由真浏览器那条臂 `test/drag-select-cost.mjs` 证），故**不进**上面的 contract
  // （那里声明的每个成员都得在 test/fake-dom.mjs 里给出同语义实现）；这里按本文件既有的
  // 「分类 + 说明用途」惯例登记即可 —— 任何**新**出现的成员调用仍会照旧判红。
  'getBoundingClientRect', 'getSelection',
  // 大会话分片渲染：`...buildMessageNodes(` 是展开传参（不是成员调用）；`now` 是 performance.now；
  // `prepend` 是 Element 方法（已在下方 contract.elementMethods 里声明）。
  'buildExtraNodes', 'buildMessageNodes', 'now', 'prepend',
  'ceil', // Math.ceil：分片渲染按字数估块高，不是 DOM 调用。
  'random', 'round', // Math.random / Math.round：/tree 退避抖动的算术，不是 DOM 调用。
  // 观测行 token 缩写（web/render.js 的 formatUsageTokens）：`Number.isFinite` 判有效数字、
  // `Math.trunc` 去小数 —— 都是普通 JS 数值调用，不是 DOM 集合/元素方法。
  'isFinite', 'trunc',
  // 换代窗口的客户端分支（web/app.js 的 `api()`）：`String(options.method ?? 'GET').toUpperCase()` 只是
  // 把 HTTP 方法名归一化后分类「幂等读 / 写路径」—— String 的方法，不是 DOM 调用。
  'toUpperCase',
  // 分片渲染的入参校验（web/render.js 的 windowFrom）：`Number.isInteger` 判整数下标，
  // 同样是普通 JS 数值调用 —— 这一处在换渲染器**之前**的 render.js 里就已存在。
  'isInteger',
  // 调试页的字节数格式化（web/render.js 的 formatDebugBytes，`memory.rss` 一类）：`Math.abs` 取绝对值
  // 再按 1024 递阶 —— 普通 JS 数值调用，不是 DOM 集合/元素方法。（这一处是 `wt/v1-b33fb041`
  // 加调试页时漏审的：本门在**改动前的 HEAD** 上就是红的，本单顺手把它补审，不是为绕过新代码。）
  'abs',
  // 调试页同时拉两个只读来源（web/app.js 的调试页加载）：`Promise.allSettled([api('/debug/instances'), fetchAppHost()])`
  // 等两个各自成败的 promise —— 普通 JS Promise 调用（同上面已审的 `race` / `then`），不是 DOM 调用。
  // 同样是 `wt/v1-b33fb041` 漏审、在**改动前的 HEAD** 上就红的那一类。
  'allSettled',
  'forEach', // Array#forEach: renderCommandPalette iterates its items array; this is not a DOM collection supplied by the fake.
  'reverse', // Array#reverse：直播块按 part 倒序取节点做归位（I-16 直播工具卡），不是 DOM 调用。
    'some',    // Array#some：同上，判断直播块里是否已有某类 part 节点；不是 DOM 调用。
  'get', 'getDate', 'getHours', 'getMinutes', 'getMonth', 'getTime', 'has', 'includes', 'isArray', 'isNaN', 'isOpen', 'join', 'map', 'max', 'min', 'padStart', 'parse',
  'preventDefault', 'push', 'querySelector', 'querySelectorAll', 'remove', 'removeAttribute', 'replace', 'replaceChildren', 'replaceState', // History#replaceState：I-53 深链把 `#<uuid>` 写回地址栏（不新增历史条目），不是 DOM 调用。
  'resolve', 'resolveForSend', 'scrollIntoView', 'set', 'setAttribute', 'slice', 'sort', 'split', 'startsWith',
  'stopPropagation', 'stringify', 'test', 'text', 'then', 'toFixed', 'toISOString', 'toLocaleString', 'toLowerCase', 'toUpperCase', 'toggle', 'trim', 'values',
  // Storage API：折叠态「跨刷新记住」（web/render.js 的 localStorage）—— 假 DOM 不提供
  // localStorage，这些是浏览器 Storage 的方法，不是 DOM 集合方法。
  'getItem', 'setItem', 'removeItem',
  // Map / 迭代器 API：折叠态容器（web/render.js）要按插入顺序（LRU）淘汰最老的一个键 ——
  // `keys()` / `next()` 是普通 JS 调用，不是 DOM 集合方法。
  'keys', 'next',
  // M-33：正文流的「边界块」（压缩 / 分支摘要）在 buildMessageNodes 里按 atIndex 落位。
  //   · `build` 是每条边界块携带的**闭包**（`item.build(document)`，见 render.js 的 boundaryNotes），
  //     不是 DOM API；
  //   · `reduce` 是 Array#reduce —— M-34 计费行把 input+output+cacheRead+cacheWrite 加起来。
  'build', 'reduce',
  // v1.5 卡片级反馈：
  //   · `hasOwn` = `Object.hasOwn`（web/render.js 的 applyAnnotationState 判「这个 state 有没有
  //     对应的文案/是否该显示痕迹」）—— 普通 JS 调用，不是 DOM 集合方法；
  //   · `mount` / `unmount` 是**注解触发点自己的**契约（web/app.js 的 installAnnotationTrigger：
  //     `trigger.mount(host)` ⇒ 返回卸装函数，`trigger.unmount()` 先卸旧的），不是 DOM API。
  'hasOwn', 'mount', 'unmount',
  // `cloneNode` 与 `removeEventListener` 都是标准 DOM API（已在上方 contract.elementMethods 声明，
  // test/fake-dom.mjs 里给了同语义实现）；这里按本文件惯例再登记一道（成员调用必须先在此分类）。
  'cloneNode', 'removeEventListener',
  // `every` = Array#every（web/app.js 的 annotationMarkForCard：同一张卡上**所有**标注都 done
  // 才显示「已处理 ✓」）—— 普通 JS 调用，不是 DOM 集合方法。
  'every',
]);

// 带**调用点**的白名单（allowlist 只减不增）：按**方法名**放行等于「今后任何 .fill( / .indexOf(
// 都不再被盯」。改成按**调用点**放行 —— 每个被审过的点钉成「文件 · 方法 · 那一行原文」：
//   · web/render.js partOrdinals：`new Array(parts.length).fill(0)` 给 part 序号预填 0（Array#fill）；
//   · web/render.js bashCard：`text.indexOf('\n')` 把服务端的诚实 text 拆成「命令行 / 其余」
//     （String#indexOf）。
// 锚点**不含行号**（仓里既有纪律：`test/s4-handoff-cwd.mjs` 的「突变锚点（都不含行号）」、
// `docs/handoff.md` 的「引用行号必须带基准提交」）—— 行号会随产品代码搬家，实测在文件头部插入
// 2 行就会把**已审过**的两个点全部判红（见报告）。为此效果：整体搬家/换行号不算新调用点；
// **改动那一行、或在别处写一个新的调用**都会红（比按行号钉更严：改那一行也逃不掉）。
const reviewedMemberCallSites = new Set([
  'web/render.js · fill · const thinking = new Array(parts.length).fill(0);',
  'web/render.js · fill · const image = new Array(parts.length).fill(0);',
  "web/render.js · indexOf · const cut = text.indexOf('\\n');",
  // 浮层那条活（2026-09-22，本分支）：`web/app.js` 顶层的 `/slot.css` 拿不到时的**降级痕迹**
  // （那一下原来会抛未捕获异常、把整页拖死 ⇒ 已改成空样式 ＋ 元素上的 `data-unavailable` ＋ 这两条 warn）。
  // 按上面同一条口径登记：**不按方法名放行**（那等于今后任何 `.warn(` 都不再被盯），而是把两个调用点
  // 逐个钉住 —— 改一行字面或新增一个调用点都会红。⚠️ 这里**只能**用 `warn`：各门的 `pageProblems`
  // 把 `console.error` 当红。
  'web/app.js · warn · console.warn(`slot stylesheet unavailable: HTTP ${slotResponse.status} —— 槽色降级为无，页面继续`);',
  'web/app.js · warn · console.warn(`slot stylesheet unavailable: ${error?.message ?? error} —— 槽色降级为无，页面继续`);',
  // ⚠️ **主干自己漏登记的一条**（不是本分支新增的调用）：`cdcba2c`（流式期间也平铺）在
  // `web/app.js` 里写了 `plan.findIndex(...)`，但没把它登进任何一个名单 ⇒ **干净的 origin/master
  // 副本上 `test:fakedom` 本来就红**（实测原始输出：`+ [ 'web/app.js:1380:findIndex' ]`）。
  // 本分支并主干后把这条红一起继承了过来；按主干自己刚定的口径**按调用点**补齐（不按方法名 ——
  // 那等于今后任何 `.findIndex(` 都不再被盯）。Array#findIndex，不是 DOM 调用。
  'web/app.js · findIndex · const primaryIndex = plan.findIndex((block) => block.kind === \'segment\');',
  // ── 「复制逐字全文」与「建议行 ⌥1–⌥3」（`web/app.js` 的建议行键盘入口）这两条
  //    **只有真浏览器能跑**的路用到的成员（2026-09-25 补审；两位作者都没跑这道门）──
  // 红是**什么时候进主干**的（`git log -S` 实测）：复制那条 `284de91` 随 `df763f1` 并进 master、
  // 建议行那条 `24db0cb`；四个名字（`endsWith` / `execCommand` / `writeText` / `select`）
  // 在**这道门自己的全部历史**里一次都没出现过（`git log -S` 各 0 命中）⇒ 不是“后来变严了”，
  // 是**新成员没人审**（本文件的“新成员调用必须先分类”那次没跑）。
  // ⚠️ 又：这道门**每个文件各断言一次**、render.js 先断 ⇒ render.js 一红，`web/app.js` 那半
  //    **从来没被看到过**。本单实测：把 render.js 那 5 条盖住后，app.js 还藏着两条红
  //    （`web/app.js:2201:snapshot` —— 注释里的散文；**`web/app.js:626:click`** —— 真调用，`24db0cb`）。
  //
  // `endsWith` ×2 = **String#endsWith**（普通 JS，不是 DOM 调用）：
  //   · `commandFacts`：`command.endsWith('\n')` 判末尾换行（「末尾换行不算多一行」）；
  //   · `liveOutputLabel`：`String(live.text ?? '').endsWith('\n')` 同一口径。
  //   和上面 `startsWith` 同一类，但**不按方法名放行**（那等于今后任何 `.endsWith(` 都不再被盯）
  //   —— 按调用点钉，与 `fill` / `indexOf` / `findIndex` 同一条口径。
  "web/render.js · endsWith · const draft = command.endsWith('\\n') ? command.slice(0, -1) : command;",
  "web/render.js · endsWith · const draft = String(live.text ?? '').endsWith('\\n') ? String(live.text ?? '').slice(0, -1) : String(live.text ?? '');",
  // `onComplete` ×2 = `options.onComplete?.()`（调用方的**回调**，普通 JS，不是 DOM API）：
  // 分片渲染跑完/尾批直接命中时通知调用方（`web/render.js` 的 renderMessages）。
  // ⚠️ 这两处**老判据根本看不见**（`?.` 把 `\s*\(` 顶开）；本单把判据改准后才露出来（见下面的 maskNonCode）。
  'web/render.js · onComplete · options.onComplete?.();',
  // `click` = **HTMLElement#click**（DOM API）：建议行的 ⌥1–⌥3 键盘入口「点那一颗」
  // （`web/app.js` 的 keydown 处理器 ⇒ 走同一颗 chip 的 click 处理器 ⇒ 同一条投递路）。
  // 语义由**真浏览器臂**证：`npm run test:suggestions`（真 Chromium 发 `Digit1..3` + Alt，断言走的是同一条投递路）。
  'web/app.js · click · chip.click();',
  // ── 「复制」按钮那条路：**三级降级 2026-09-25 抽进了共用实现 `web/copy-text.js`** ────────────
  // 于是 `web/render.js` 里**不再有** `writeText` / `select` / `execCommand` 这三个调用点
  // （它们随三级降级一起搬进了 `web/copy-text.js` —— 那份文件也已加进本门的扫描列表，
  // 下面有它自己那几行）。本页现在只剩「交给共用实现」这一句 ＋ 三处如实降级痕迹：
  //   · `copyText` = 挂在 `window` 上的那个共用对象的**普通 JS 方法**（`sophoCopyText.copyText`），
  //     不是 DOM API；
  //   · `warn` / `error` = `console.warn` / `console.error` —— 共用脚本没加载、或共用实现抛了
  //     （兜底的兜底）时的如实痕迹；两条都不在正常路径上（各门的 `pageProblems` 把
  //     `console.error` 当红 ⇒ 真跑到了就该红，那是对的）；
  //   · `log` = `console.log`：「走的是哪一级」留在控制台（路径另标在按钮的 `data-copy-path` /
  //     `title` 上 —— **不进 UI 文案**）。
  'web/render.js · copyText · const outcome = await copy.copyText(text, {',
  "web/render.js · warn · console.warn('sophoCopyText 不在场（/copy-text.js 没加载？）：复制这一格没有三级降级');",
  'web/render.js · error · console.error(`复制命令时共用实现抛了：${error?.message ?? String(error)}`);',
  'web/render.js · log · console.log(`[render] 复制命令：走 ${outcome.path} 路径（${outcome.bytes} 字节）`);',
  // ── 共用实现 `web/copy-text.js` 自己的成员调用（三级降级搬过来之后，它成了**新**的扫描对象）────
  // 口径同上面：真 DOM / Web API 的**只登记、不进 `contract`**（假 DOM 没有事件 / 选区 / 剪贴板模型），
  // 语义由**真浏览器臂**证 —— `npm run test:copytiers`（真 Chromium ＋ 真鼠标 ＋ 真剪贴板）与
  // 设计器那一侧的 `clip:*`（`test/designer-ui.mjs`）；下面逐条按**调用点**钉（不按方法名）：
  //   · `getElementById` ×5 = Document#getElementById（手动框那五个元素；假 DOM 没有「按 id 取元素」，
  //     给不出同语义实现 ⇒ 只登记）；
  //   · `select` ×2 = HTMLTextAreaElement#select（② 那把临时 textarea 与 ③ 的手动框，都把内容
  //     全选好交出去）；`writeText` = Clipboard#writeText（①；非安全上下文里根本没这一格）；
  //   · `execCommand` = Document#execCommand（② 兼容路径）；
  //   · `appendChild` = Node#appendChild（把临时 textarea 挂上）；`setAttribute` / `focus` /
  //     `setSelectionRange` / `remove` 都是 Element 方法（前四个已在 `contract.elementMethods`，
  //     假 DOM 有同语义实现）；
  //   · `TextEncoder` / `encode` 是 Web API（`new TextEncoder().encode(text).length` 只用来算字节数，
  //     不是 DOM）；`race` = `Promise.race`（① 那 1.5 s 上界），`then` / `catch` / `finally` 同：普通 JS。
  'web/copy-text.js · getElementById · panel: doc.getElementById(wanted.panel),',
  'web/copy-text.js · getElementById · lead: doc.getElementById(wanted.lead),',
  'web/copy-text.js · getElementById · why: doc.getElementById(wanted.why),',
  'web/copy-text.js · getElementById · text: doc.getElementById(wanted.text),',
  'web/copy-text.js · getElementById · close: doc.getElementById(wanted.close),',
  'web/copy-text.js · select · nodes.text.select(); // 内容全选：用户来了直接 Ctrl+C',
  'web/copy-text.js · appendChild · doc.body.appendChild(area);',
  'web/copy-text.js · select · area.select();',
  "web/copy-text.js · execCommand · copied = doc.execCommand('copy') === true;",
  "web/copy-text.js · TextEncoder · const bytes = typeof root.TextEncoder === 'function' ? new root.TextEncoder().encode(text).length : text.length;",
  "web/copy-text.js · encode · const bytes = typeof root.TextEncoder === 'function' ? new root.TextEncoder().encode(text).length : text.length;",
  'web/copy-text.js · writeText · clipboard.writeText(text).then(() => ({ settled: \'ok\' }), (error) => ({ settled: \'rejected\', error })),',
  'web/copy-text.js · race · const outcome = await Promise.race([',
]);

// ── 「成员调用」的取法：**只紧不松** ─────────────────────────────────────────────
// 老取法是 `/\\.(name)\\s*\\(/` 直接扫**整个文件文本**，在真代码里撞到两个毛病：
//   ① **散文假装成调用**：`web/render.js` 的 JSDoc 里写了一句 `` `document.execCommand('copy')` ``
//      说明 ⇒ 被判成「一个未审的成员调用」（报出 `web/render.js:58:execCommand`）；
//      `web/app.js:2201` 的注释里 `` `output.snapshot()` `` 同理。注释不是调用。
//   ② **可选链的真调用看不见**：真调用写成 `document.execCommand?.(...)` 时，`?.` 把 `\s*\(` 顶开
//      ⇒ 这条**真的调用**反而漏掉（`web/render.js:81` 就是这么漏的）。
// 所以：先把注释 / 字符串 / 模板字面量掩成**同长度的空白**（换行保留 ⇒ 偏移与行号一字不变），
// 再按「`.name(` 或 `.name?.(`」取调用点。**方向是收紧**：
//   · 掩码只会**去掉**「散文假装成调用」这类假点（本单实测只去掉了 6 处：render.js 的
//     58/939/959/1314、app.js 的 2004/2201 —— 逐行核过、全是注释行，没有一行是真代码）；
//   · 认可选链只会**多抓到**真调用（实测 10 处：render.js 的 execCommand(81) 与 onComplete×2、
//     app.js 的 isOpen×1 与 closest×6 —— 全是 `?.` 写法）。
// 模板字面量里的 `${ ... }` 是**真代码**，那一段必须还原回来（不掩）—— 掩掉它会把真调用一起藏起来，
// 那是**放宽**（本单明确不许）。
function maskNonCode(source) {
  const out = [...source];
  const length = source.length;
  const blank = (from, to) => { for (let at = from; at < to; at += 1) if (out[at] !== '\n') out[at] = ' '; };
  // 每个 'code' 帧记自己那层的花括号深度：`${ ... }` 的收口 = 深度回到 0 的那个 `}`。
  const stack = [{ kind: 'code', brace: 0 }];
  let at = 0;
  while (at < length) {
    const ch = source[at];
    const next = source[at + 1];
    const frame = stack[stack.length - 1];
    if (frame.kind === 'template') {
      if (ch === '\\') { blank(at, at + 2); at += 2; continue; }
      if (ch === '`') { blank(at, at + 1); stack.pop(); at += 1; continue; }
      if (ch === '$' && next === '{') { blank(at, at + 2); stack.push({ kind: 'code', brace: 0 }); at += 2; continue; }
      blank(at, at + 1); at += 1; continue;
    }
    if (ch === '/' && next === '/') { const close = source.indexOf('\n', at); const end = close === -1 ? length : close; blank(at, end); at = end; continue; }
    if (ch === '/' && next === '*') { const close = source.indexOf('*/', at + 2); const end = close === -1 ? length : close + 2; blank(at, end); at = end; continue; }
    if (ch === "'" || ch === '"') {
      let end = at + 1;
      while (end < length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === ch) { end += 1; break; }
        if (source[end] === '\n') break; // 未闭合：绝不跨行吞代码
        end += 1;
      }
      blank(at, Math.min(end, length)); at = Math.min(end, length); continue;
    }
    if (ch === '`') { blank(at, at + 1); stack.push({ kind: 'template' }); at += 1; continue; }
    if (ch === '{') { frame.brace += 1; at += 1; continue; }
    if (ch === '}') {
      if (stack.length > 1 && frame.brace === 0) { blank(at, at + 1); stack.pop(); at += 1; continue; }
      frame.brace = Math.max(0, frame.brace - 1); at += 1; continue;
    }
    at += 1;
  }
  return out.join('');
}

const sources = await Promise.all(['web/render.js', 'web/app.js', 'web/copy-text.js'].map(async (name) => [name, await readFile(path.join(root, name), 'utf8')]));
for (const [name, source] of sources) {
  // 成员调用 → 行号/行原文（用于带**调用点**的白名单：同一方法在不同位置出现必须分开审）。
  const lineStarts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const lineText = (index) => {
    const end = source.indexOf('\n', index);
    return source.slice(lineStarts[lineOf(index) - 1], end === -1 ? source.length : end).trim();
  };
  // 只在**掩掉散文之后**的代码上取调用点：`.name(` 与 `.name?.(` 都算（见上面的 maskNonCode）。
  const memberCalls = [...maskNonCode(source).matchAll(/\.([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)].map((match) => ({ method: match[1], at: match.index }));
  const unreviewed = [...new Set(memberCalls
    .filter(({ method }) => !reviewedMemberCalls.has(method))
    .map(({ method, at }) => ({ key: `${name} · ${method} · ${lineText(at)}`, where: `${name}:${lineOf(at)}:${method}` }))
    .filter(({ key }) => !reviewedMemberCallSites.has(key))
    .map(({ where }) => where))].sort();
  assert.deepEqual(unreviewed, [], `${name} added unreviewed member calls at these call sites; update the fake DOM contract if they are DOM APIs (or pin the reviewed call site as "file · method · that line")`);
  // 契约里声明的成员，**真被调用**（含 `?.` 调用）就必须在假 DOM 里有实现。
  // 这里改用上面那份**取准了的**调用集合（老写法 `source.includes('.name(')` 同样看不见 `?.name(`）。
  const calledMethods = new Set(memberCalls.map(({ method }) => method));
  for (const method of contract.elementMethods) {
    if (calledMethods.has(method)) assert.equal(typeof FakeElement.prototype[method], 'function', `${name} uses Element.${method}`);
  }
  for (const method of contract.documentMethods) {
    if (calledMethods.has(method)) assert.equal(typeof FakeDocument.prototype[method], 'function', `${name} uses Document.${method}`);
  }
}

const document = new FakeDocument();
const parent = document.createElement('section');
const child = document.createElement('button');
for (const property of contract.elementProperties) assert.ok(property in child, `FakeElement missing ${property}`);
child.setAttribute('aria-expanded', false);
assert.equal(child.getAttribute('aria-expanded'), 'false');
child.removeAttribute('aria-expanded');
assert.equal(child.getAttribute('aria-expanded'), null);
parent.append(child);
assert.equal(child.closest('section'), parent);
assert.equal(child.matches('button'), true);
assert.equal(parent.contains(child), true);
child.remove();
assert.equal(parent.contains(child), false);
assert.equal(child.parentElement, null);
parent.append(child);
child.focus();
assert.equal(child.focusCalls, 1);

// `isConnected`（工具卡耗时的清场判据）在假 DOM 里必须与真 DOM 同语义：
// 孤立节点 false、挂在 `documentElement` 下 true。
assert.equal(child.isConnected, false);
assert.equal(document.documentElement.isConnected, true);
document.documentElement.append(child);
assert.equal(child.isConnected, true);
child.remove();
assert.equal(child.isConnected, false);

// paintTreeSelection 靠 Element.querySelectorAll 扫全树的会话行做批量重涂，
// 假 DOM 必须给出与真 DOM 一致的「后代顺序、只要匹配、可遍历」语义。
const list = document.createElement('div');
const firstRow = document.createElement('div');
firstRow.className = 'tree-session selected';
const nested = document.createElement('div');
const nestedRow = document.createElement('div');
nestedRow.className = 'tree-session';
const decoy = document.createElement('div');
decoy.className = 'tree-select';
list.append(firstRow, nested, decoy);
nested.append(nestedRow);
assert.deepEqual(list.querySelectorAll('.tree-session'), [firstRow, nestedRow]);
assert.deepEqual(list.querySelectorAll('.tree-session.selected'), [firstRow]);
assert.deepEqual(list.querySelectorAll('.not-there'), []);
assert.deepEqual(child.querySelectorAll('.tree-session'), []);

const palette = document.createElement('section');
renderCommandPalette(palette, {
  open: true,
  items: [
    { name: 'cwd', description: 'Show cwd', source: 'extension', runnable: true },
    { name: 'compact', description: 'Compact', source: 'builtin', runnable: true },
  ],
  selectedIndex: 1,
});
const selected = palette.querySelector('.command-palette-item.selected');
assert.equal(selected.dataset.commandName, 'compact');
assert.deepEqual(selected.scrollIntoViewCalls, [{ block: 'nearest' }]);

process.stdout.write(`RESULT: fake DOM contract PASS (${sources.map(([name]) => name).join(', ')}, command palette scroll)\n`);
