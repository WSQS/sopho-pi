// web/settings-panel.mjs —— **会话页里的设置浮层**（业主 2026-09-22：「我希望设置是一个悬浮窗，而不是打开一个新窗口」）。
//
// 它是什么：左栏底栏那条「设置」入口开的**居中模态框**（`#settings-overlay` ⇒ `#settings-panel`），
// 内容与交互照搬独立页 `web/settings.html` 的那几项（思考折叠的默认 / 卡片反馈的维护者会话 /
// 推荐回复总开关 / 「压缩即封存」总开关）——
// **同一对端点、同一份侧车**（`GET` / `PATCH /settings`），协议实现共用 `web/settings-client.mjs`。
//
// 为什么不是「把 /settings.html 塞进 iframe / 抓下来注入」：那要么多一层窗口语义（业主否的正是这个），
// 要么把别人的 DOM 当数据用。这里就是同一个界面在会话页里的一份静态实现，读写走同一条服务端契约。
//
// 交互（判据与门写在 `docs/design/design-settings.md` §10）：
//   · 点入口 ⇒ **就地开/关**（不导航；入口的 `aria-expanded` 表达激活态）；
//   · 关：点遮罩 / `Esc` / 右上角 × —— 三种都**把焦点还给入口**；
//   · 键盘可达：开时焦点进框内（面板本身 `tabindex="-1"`，`Tab` 自然进到第一个控件），
//     `Tab` 在框内循环（焦点陷阱），`Esc` 关；
//   · **不假成功**：读不到就把那条错误显示出来（并把控件禁用）＋**留一条可见的重试**（`#settings-panel-retry`）；
//     写失败也如实说，然后回读服务端当下的真值。⚠️ **这条路一个字都不许抛未捕获异常**（业主口径）；
//     门里专门有两臂（`GET /settings` ⇒ 404 非 JSON / 500）钉它。
//
// ⚠️ 动效只有 ≤150ms 的透明度/位移，`prefers-reduced-motion: reduce` 下**完全不动**（`animation: none`）——
//    这既是可访问性要求，也是 `test:slot` 那条「页面里不许有 >150ms 过渡 / 阴影 / 渐变」的硬约束。

import { settingsRequest } from './settings-client.mjs';

const FOLD_KEY = 'thinking.defaultFold';
const NOTIFY_KEY = 'annotations.notifySession';
const SUGGESTIONS_KEY = 'suggestions.enabled';
const SEAL_KEY = 'seal.autoOnCompaction';
const FOLD_LABELS = { expanded: '默认展开', collapsed: '默认收起' };

/** 面板里可 Tab 到的元素（与浏览器一致的「可聚焦」判据：看得见 + 没禁用）。
    ⚠️ `[hidden]` 的元素**不在**里面 —— 少了这一句，隐藏的「重试读取」会被当成末位，
    `Tab` 就不再在框内循环（这是自己的门在第二版抓到的一个真 bug）。 */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * 挂上设置浮层。返回 `{ open, close, isOpen }`（谁挂谁用；`app.js` 只用挂载这一处）。
 * `onEffective(payload)` 在**读/写成功且服务端回了新生效值**时被叫一次 —— 会话页靠它把
 * thinking 的全局默认当场交给 `render.js`（不靠自己推算，也不自己留一份）。
 */
export function mountSettingsPanel({ onEffective = () => {} } = {}) {
  const trigger = document.querySelector('#tree-settings');
  const overlay = document.querySelector('#settings-overlay');
  const panel = document.querySelector('#settings-panel');
  const closeButton = document.querySelector('#settings-panel-close');
  // 浮层没在 DOM 里（老页面/别的宿主）⇒ 退回一个什么都不做的壳：**不许**把整个会话页拖垮。
  if (!trigger || !overlay || !panel || !closeButton) return { open: () => {}, close: () => {}, isOpen: () => false };

  const foldGroup = panel.querySelector('#settings-panel-fold');
  const foldState = panel.querySelector('#settings-panel-fold-state');
  const radios = [...panel.querySelectorAll('input[name="settings-panel-thinking-default-fold"]')];
  const notifyInput = panel.querySelector('#settings-panel-notify-input');
  const notifySave = panel.querySelector('#settings-panel-notify-save');
  const notifyState = panel.querySelector('#settings-panel-notify-state');
  const suggestionsToggle = panel.querySelector('#settings-panel-suggestions-enabled');
  const suggestionsState = panel.querySelector('#settings-panel-suggestions-state');
  const sealToggle = panel.querySelector('#settings-panel-seal-auto');
  const sealState = panel.querySelector('#settings-panel-seal-state');
  const retryButton = panel.querySelector('#settings-panel-retry');

  let open = false;
  let restoreFocusTo = null;

  const setFoldState = (text, kind = '') => { foldState.textContent = text; foldState.dataset.kind = kind; };
  const setNotifyState = (text, kind = '') => { notifyState.textContent = text; notifyState.dataset.kind = kind; };
  const setSuggestionsState = (text, kind = '') => { suggestionsState.textContent = text; suggestionsState.dataset.kind = kind; };
  const setSealState = (text, kind = '') => { if (!sealState) return; sealState.textContent = text; sealState.dataset.kind = kind; };

  const focusables = () => [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.getClientRects().length > 0);

  function setControlsEnabled(enabled) {
    for (const radio of radios) radio.disabled = !enabled;
    notifyInput.disabled = !enabled;
    notifySave.disabled = !enabled;
    if (suggestionsToggle) suggestionsToggle.disabled = !enabled;
    if (sealToggle) sealToggle.disabled = !enabled;
  }

  /** 读不到时的可见重试：只在失败那一档出现（成功/加载中一律收起）。 */
  function setRetryVisible(visible) {
    if (retryButton) retryButton.hidden = !visible;
  }

  /** 服务端给的生效值原样画（**不推算、不合并默认值**）——与独立页同一条纪律。 */
  function paintFold(payload) {
    const effective = payload?.settings?.[FOLD_KEY];
    const known = Object.hasOwn(FOLD_LABELS, effective ?? '');
    for (const radio of radios) {
      radio.checked = known && radio.value === effective;
      radio.disabled = !known;
    }
    if (!known) {
      setFoldState(`服务端没有给出可识别的 ${FOLD_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
      return;
    }
    const stored = payload?.stored?.[FOLD_KEY] === effective;
    setFoldState(`生效中：${FOLD_LABELS[effective]}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
    if (foldGroup) foldGroup.dataset.effective = effective;
  }

  function paintNotify(payload) {
    const effective = payload?.settings?.[NOTIFY_KEY];
    const known = typeof effective === 'string';
    notifyInput.disabled = !known;
    notifySave.disabled = !known;
    if (!known) {
      notifyInput.value = '';
      setNotifyState(`服务端没有给出可识别的 ${NOTIFY_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
      return;
    }
    notifyInput.value = effective;
    const stored = payload?.stored?.[NOTIFY_KEY] === effective;
    setNotifyState(
      effective === ''
        ? `生效中：不通知（${stored ? '已保存在服务端' : '服务端默认值'}）`
        : `生效中：新反馈会通知 ${effective}（${stored ? '已保存在服务端' : '服务端默认值'}）`,
      'ok',
    );
  }

  /** ③ 推荐回复总开关：值只可能是布尔（服务端校验过的）。 */
  function paintSuggestions(payload) {
    const effective = payload?.settings?.[SUGGESTIONS_KEY];
    const known = typeof effective === 'boolean';
    suggestionsToggle.disabled = !known;
    if (!known) {
      suggestionsToggle.checked = false;
      setSuggestionsState(`服务端没有给出可识别的 ${SUGGESTIONS_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
      return;
    }
    suggestionsToggle.checked = effective;
    const stored = payload?.stored?.[SUGGESTIONS_KEY] === effective;
    setSuggestionsState(`生效中：${effective ? '开（每回合结束后生成候选）' : '关（一次模型调用都不发）'}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
  }

  /** ④ 「压缩即封存」的自动触发总开关：值只可能是布尔（服务端校验过的）。 */
  function paintSeal(payload) {
    if (!sealToggle) return;
    const effective = payload?.settings?.[SEAL_KEY];
    const known = typeof effective === 'boolean';
    sealToggle.disabled = !known;
    if (!known) {
      sealToggle.checked = false;
      setSealState(`服务端没有给出可识别的 ${SEAL_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
      return;
    }
    sealToggle.checked = effective;
    const stored = payload?.stored?.[SEAL_KEY] === effective;
    setSealState(`生效中：${effective ? '开（压缩落定后自动封存）' : '关（压缩后不再自动封存，显式封存仍可用）'}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
  }

  function paint(payload) {
    paintFold(payload);
    paintNotify(payload);
    paintSuggestions(payload);
    paintSeal(payload);
    setRetryVisible(false);
    onEffective(payload);
  }

  /** 读一次服务端：成功就画；失败**如实说出来**（控件禁用 ＋ 留一条重试，不让用户对着假成功点）。 */
  async function load() {
    setControlsEnabled(false);
    setRetryVisible(false);
    setFoldState('正在读取…');
    setNotifyState('正在读取…');
    setSuggestionsState('正在读取…');
    setSealState('正在读取…');
    try {
      paint(await settingsRequest('/settings'));
    } catch (error) {
      setControlsEnabled(false);
      setFoldState(`读不到设置：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
      setNotifyState(`读不到设置：${error.message}`, 'error');
      setSuggestionsState(`读不到设置：${error.message}`, 'error');
      setSealState(`读不到设置：${error.message}`, 'error');
      setRetryVisible(true);
    }
  }

  async function saveFold(value) {
    setControlsEnabled(false);
    setFoldState('正在保存…');
    try {
      // PATCH 回来的就是**新的生效值**（服务端权威）；照它重画，不拿本地的选择当结果。
      paint(await settingsRequest('/settings', { method: 'PATCH', body: JSON.stringify({ [FOLD_KEY]: value }) }));
    } catch (error) {
      setFoldState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
      await load();
    }
  }

  async function saveNotify(value) {
    notifyInput.disabled = true;
    notifySave.disabled = true;
    setNotifyState('正在保存…');
    try {
      paintNotify(await settingsRequest('/settings', { method: 'PATCH', body: JSON.stringify({ [NOTIFY_KEY]: value }) }));
    } catch (error) {
      setNotifyState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
      await load();
    }
  }

  async function saveSuggestions(value) {
    if (suggestionsToggle) suggestionsToggle.disabled = true;
    setSuggestionsState('正在保存…');
    try {
      // 与另两项同一条纪律：PATCH 回来的就是**新的生效值**，照它重画。
      paintSuggestions(await settingsRequest('/settings', { method: 'PATCH', body: JSON.stringify({ [SUGGESTIONS_KEY]: value }) }));
    } catch (error) {
      setSuggestionsState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
      await load();
    }
  }

  async function saveSeal(value) {
    if (sealToggle) sealToggle.disabled = true;
    setSealState('正在保存…');
    try {
      // 同一条纪律：PATCH 回来的就是**新的生效值**，照它重画（不拿本地勾选当结果）。
      paintSeal(await settingsRequest('/settings', { method: 'PATCH', body: JSON.stringify({ [SEAL_KEY]: value }) }));
    } catch (error) {
      setSealState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
      await load();
    }
  }

  function openPanel() {
    if (open) return;
    open = true;
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    overlay.hidden = false;
    overlay.dataset.state = 'open';
    trigger.setAttribute('aria-expanded', 'true');
    // 焦点进框内：面板自身可聚焦（`tabindex="-1"`），`Tab` 自然落到第一个控件上。
    panel.focus();
    void load();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    delete overlay.dataset.state;
    trigger.setAttribute('aria-expanded', 'false');
    const back = restoreFocusTo && document.contains(restoreFocusTo) ? restoreFocusTo : trigger;
    restoreFocusTo = null;
    back.focus();
  }

  trigger.addEventListener('click', () => { if (open) closePanel(); else openPanel(); });
  closeButton.addEventListener('click', () => closePanel());
  // 点遮罩关（只在点在**遮罩本身**上时 —— 点在框里、或从框里拖到遮罩上松手，都不关）。
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closePanel(); });

  // `Esc` 关：捕获阶段处理，并且**不再往下传**（浮层是模态的，别的 Esc 语义此刻不该同时生效）。
  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  }, true);

  // 焦点陷阱：`Tab` / `Shift+Tab` 在框内循环；没有可聚焦元素时把 Tab 吃掉（焦点不许漏到背后页面）。
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) { event.preventDefault(); last.focus(); return; }
    if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  });

  for (const radio of radios) {
    radio.addEventListener('change', (event) => { if (event.target.checked) void saveFold(event.target.value); });
  }
  notifySave.addEventListener('click', () => { void saveNotify(notifyInput.value.trim()); });
  suggestionsToggle?.addEventListener('change', (event) => { void saveSuggestions(event.target.checked === true); });
  sealToggle?.addEventListener('change', (event) => { void saveSeal(event.target.checked === true); });
  retryButton?.addEventListener('click', () => { void load(); });

  return { open: openPanel, close: closePanel, isOpen: () => open };
}
