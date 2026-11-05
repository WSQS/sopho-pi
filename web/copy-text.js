// web/copy-text.js —— 「把一段文本送进剪贴板」的**唯一一份**三级降级实现（主产品页与设计器页共用）。
//
// 为什么要有这个文件（业主 2026-09-25 实测报回来的那条错，逐字）：
//   「复制失败：can't access property "writeText", navigator.clipboard is undefined（可以用「导出 JSON」下载）」
// 根因（设计器那一单查实、这一单沿用，不推翻）：`navigator.clipboard` **只在「安全上下文」存在**
//   —— HTTPS，或 `localhost` / `127.0.0.1`。从**局域网 IP ＋ 明文 HTTP** 打开页面时，这一格是
//   `undefined`（不是抛错，是压根没有）⇒ 直接 `await navigator.clipboard.writeText(text)` 当场抛。
// 设计器页（`web/designer.js`）当时**就地**实现了三级降级；主产品页（`web/render.js` 的工具卡「复制」）
//   只有两级 ⇒ 两级都失败就只剩一句「复制失败」，**没有出路**。同一个根因、两处实现、一处漏了
//   ⇒ 抽成这一份共用实现，两处都调它（改一处，两处都改）。
//
// 三级（顺序明确，每级都说得清为什么）：
//   ① `navigator.clipboard?.writeText(text)` —— 安全上下文里的现代 API。**带 1.5 s 上界**：
//      本机实测（headless Chromium、没授权、没有用户激活）它**既没 resolve 也没 reject** ⇒ 不设上界
//      就是一个「点了没反应」的死胡同；超时就走 ②（写的是同一串文本，重复也无害）。
//      挂 `.then(ok, err)` 两边都接住：就算它 1.5 s 之后才 reject，也不会变成未捕获的 rejection。
//   ② 兼容路径：临时 `textarea`（`position:fixed;opacity:0`）⇒ `focus()` / `select()` ＋
//      `document.execCommand('copy')` ⇒ **用完移除**。⚠️ 这条依赖**用户激活**：本机实测在真鼠标点击的
//      处理器里返回 `true`，在 `Runtime.evaluate`（没有用户激活）里返回 `false` ⇒ 它必须跑在点击那条
//      同步链上（① 不存在时是同步到达它的；① 超时 1.5 s 后到达它则可能已经失去激活 —— 如实降级到 ③）。
//   ③ 手动框：**只读** textarea ＋ **内容全选**，写明为什么与怎么办。
//      **这条路上没有「复制失败」的死胡同**：②③ 都在这个文件里，只在反证臂里会被拿掉
//      （见下面 [SEAM:copy-fallback]）。
//
// 接口（挂在 `window.sophoCopyText` 上；**经典脚本**，不是 ES module —— 设计器那一侧有一道
// 「页面零 `import`」的既有门 `Static:no-server`，共用文件不该把它推翻）：
//   copyText(text, { label, hint, ids }) ⇒ Promise<{ path, ok, text, bytes, reasons }>
//     · `path` ∈ `'clipboard' | 'execCommand' | 'manual'` —— **实际走到的**那一级；
//     · `ok`  —— 是否真的把文本交给了剪贴板（`'manual'` 时是 `false`：那是「交给用户手按」，
//                不是「已复制」，**不许**在 UI 上冒充成功）；
//     · `reasons` —— 逐级**为什么**没成（人话，进手动框的 `#…-why`）。
//     · `label` —— 「复制的是什么」（进 ③ 的文案：「下面这份就是<label>」）；
//     · `hint`  —— ③ 里「或…」那条备选出路的措辞（各页面不同：设计器是「导出 JSON」，主产品是手动选中）；
//     · `ids`   —— 手动框那几个元素的 id（各页面各不相同：设计器用 `dz-copy-*`，主产品用 `copy-*`）。
//   走的是哪一级**不进 UI**（按前人给的取舍）：调用方自己标在 `data-*` / `title` / 控制台上。
//
// 门：`test/designer-ui.mjs`（设计器那一侧，真 Chromium 真鼠标）与 `test/copy-tiers-live.mjs`
//     （主产品那一侧 + 这个共用文件自己的契约）。断言不许放宽。

(function (root) {
  'use strict';

  /** ① 最多等多久（设计器那一单实测出来的数，这一单沿用）。 */
  const CLIPBOARD_WRITE_BUDGET_MS = 1500;

  /** 手动框（③）默认的元素 id —— 主产品页 `web/index.html` 用的就是这一组。 */
  const DEFAULT_IDS = {
    panel: 'copy-panel',
    lead: 'copy-lead',
    why: 'copy-why',
    text: 'copy-text',
    close: 'copy-close',
  };

  /** 当前开着的手动框（同一时刻只可能有一个：一次复制动作开一个）。Esc / 「关掉」都关它。 */
  let active = null;
  /** 已经接过事件的框（按元素记，避免重复 addEventListener）。 */
  const wired = new WeakSet();
  /** Esc 的全局监听只挂一次。 */
  let escapeWired = false;

  const documentOf = () => root.document;

  function resolveNodes(ids) {
    const doc = documentOf();
    if (!doc) return null;
    const wanted = { ...DEFAULT_IDS, ...(ids ?? {}) };
    return {
      ids: wanted,
      panel: doc.getElementById(wanted.panel),
      lead: doc.getElementById(wanted.lead),
      why: doc.getElementById(wanted.why),
      text: doc.getElementById(wanted.text),
      close: doc.getElementById(wanted.close),
    };
  }

  /** ③ 手动框：**这一格的存在就是为了不留死胡同** —— 把文本全选好交出去，并如实写清为什么、怎么办。
   *  返回是否**真的有**这个框（没有就是这一页没铺 DOM：如实说，不假装）。 */
  function openManualCopy(text, reasons, { label, hint, nodes }) {
    if (!nodes?.panel || !nodes.text) return false;
    const head = root.isSecureContext === true
      ? '当前页面是安全上下文，但浏览器没让自动复制'
      : '当前页面不在安全上下文（在 HTTPS 或 localhost / 127.0.0.1 之外打开，浏览器就不提供剪贴板 API）';
    const wayOut = hint ? `，或${hint}` : '';
    nodes.text.value = text;
    if (nodes.lead) nodes.lead.textContent = `${head} —— 下面这份就是${label}，已全选：请按 Ctrl+C 复制（macOS 是 ⌘C）${wayOut}。`;
    if (nodes.why) nodes.why.textContent = `为什么没能自动复制：${reasons.join('；')}。`;
    nodes.panel.hidden = false;
    active = { nodes };
    wireClose(nodes);
    nodes.text.focus();
    nodes.text.select(); // 内容全选：用户来了直接 Ctrl+C
    nodes.text.setSelectionRange(0, nodes.text.value.length);
    nodes.text.scrollTop = 0; // 全选后浏览器会把视口滑到末尾；拉回开头（复制不受影响，只是看得见头部）
    return true;
  }

  /** 「关掉」（点按钮 / Esc）是同一个出口：收起面板并把那份文本从 DOM 里清掉（不留副本）。 */
  function closeManualCopy() {
    if (!active) return false;
    const { nodes } = active;
    active = null;
    if (nodes.panel) nodes.panel.hidden = true;
    if (nodes.text) nodes.text.value = '';
    return true;
  }

  function wireClose(nodes) {
    if (nodes.close && !wired.has(nodes.close)) {
      wired.add(nodes.close);
      nodes.close.addEventListener('click', () => { closeManualCopy(); });
    }
    if (!escapeWired) {
      escapeWired = true;
      const doc = documentOf();
      if (doc) {
        doc.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          // 只收起框，不 preventDefault / 不 stopPropagation：页面自己的 Esc 处理照旧
          // （设计器那页还有预览与别的浮层要用同一个键）。
          closeManualCopy();
        });
      }
    }
  }

  /** ② 兼容路径。⚠️ 依赖**用户激活**（见文件头）：它必须跑在点击那条同步链上。 */
  function copyViaExecCommand(text) {
    const doc = documentOf();
    if (!doc || !doc.body) return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.dataset.copyHelper = 'compat';
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    doc.body.appendChild(area);
    let copied = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = doc.execCommand('copy') === true;
    } catch {
      copied = false;
    } finally {
      area.remove(); // 用完移除：不留 DOM 垃圾，也不把文本留在页面里
    }
    return copied;
  }

  /** 三级降级；返回**实际走到的**那一级与成败。 */
  async function copyText(text, { label = '这段文本', hint = '', ids = null } = {}) {
    const reasons = [];
    const bytes = typeof root.TextEncoder === 'function' ? new root.TextEncoder().encode(text).length : text.length;
    const clipboard = root.navigator?.clipboard; // ⚠️ 非安全上下文里这一格是 `undefined`（不是抛错）
    if (clipboard && typeof clipboard.writeText === 'function') {
      let timer = null;
      try {
        const budget = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ settled: 'timeout' }), CLIPBOARD_WRITE_BUDGET_MS);
        });
        // `.then(ok, err)` 两边都接住：就算它 1.5 s 之后才 reject，也不会变成未捕获的 rejection。
        const outcome = await Promise.race([
          clipboard.writeText(text).then(() => ({ settled: 'ok' }), (error) => ({ settled: 'rejected', error })),
          budget,
        ]);
        if (outcome.settled === 'ok') return { path: 'clipboard', ok: true, text, bytes, reasons };
        if (outcome.settled === 'timeout') {
          reasons.push(`navigator.clipboard.writeText 等了 ${CLIPBOARD_WRITE_BUDGET_MS} ms 也没有回应（浏览器没给它授权，或文档没聚焦）`);
        } else {
          reasons.push(`navigator.clipboard.writeText 被浏览器拒绝了（${outcome.error?.name ?? 'Error'}: ${outcome.error?.message ?? String(outcome.error)}）`);
        }
      } catch (error) {
        reasons.push(`navigator.clipboard.writeText 抛了（${error?.message ?? String(error)}）`);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    } else {
      reasons.push('当前页面没有 navigator.clipboard —— 它是「安全上下文」才有的 API（HTTPS 或 localhost / 127.0.0.1）'
        + `，本页 window.isSecureContext = ${root.isSecureContext}`);
    }
    // [SEAM:copy-fallback] ②③ 的入口 —— 反证臂 `clipboard-no-fallback` 把下面这一段换成 `throw`
    // （回到业主报的那条「只调 clipboard、失败就报复制失败」）⇒ 两侧的 `clip:*` 那几条必红。
    if (copyViaExecCommand(text)) return { path: 'execCommand', ok: true, text, bytes, reasons };
    reasons.push("document.execCommand('copy') 返回 false（浏览器不让这条兼容路径复制）");
    const nodes = resolveNodes(ids);
    if (openManualCopy(text, reasons, { label, hint, nodes })) return { path: 'manual', ok: false, text, bytes, reasons };
    reasons.push(`这一页没有手动复制框（#${(ids?.panel ?? DEFAULT_IDS.panel)} / #${(ids?.text ?? DEFAULT_IDS.text)}）—— 三级降级的第 ③ 级铺不出去`);
    return { path: 'manual', ok: false, text, bytes, reasons };
  }

  root.sophoCopyText = { copyText, closeManualCopy, openManualCopy, CLIPBOARD_WRITE_BUDGET_MS, DEFAULT_IDS };
})(typeof window !== 'undefined' ? window : globalThis);
