// web/settings.js —— 设置页（`docs/design/design-settings.md` v1）。
//
// ⚠️ 协议（`/api/settings` 的取数与提交）不在这里 —— 它与**会话页的设置浮层**共用同一份
//    `web/settings-client.mjs`（同一份服务端设置、一套实现；理由写在那里）。
//
// 四项：① 思考折叠的全局默认（radio，改即存）；② 卡片反馈的维护者会话（文本框 + 保存按钮，
// `annotations.notifySession`，业主 2026-09-22 拍的 ②）；③ 对话内「推荐回复」的总开关
//（`suggestions.enabled`，checkbox 改即存，业主 2026-09-23 拍的那条线）；
// ④ 「压缩即封存」的自动触发（`seal.autoOnCompaction`，checkbox 改即存）。
// ⚠️ ④ 是 2026-09-25 补的**对称性**修正：`959a587` 只把这一行加进了会话页的浮层
//    （`web/settings-panel.mjs`），而独立页仍是三项 ⇒ 同一项设置在一个面上能改、在另一个面上连看都看不到。
//    两面的关系与判据（为什么独立页仍是产品面之一、为什么该补）写在 `docs/design/design-settings.md` §11。
//    纪律与另三项一字不差：这一页与浮层只读 `GET /settings`、只写 `PATCH /settings`，**不各存一份**。
// ⚠️ **前端不推算**：生效值是 `GET /settings` 的 `settings[...]` 原样；提交后用服务端回的同一个字段
// 重画（不是用刚点的那个 radio / 刚敲的那串字）。服务端说 400，就如实说出来。
//
// 入口纪律：这一页**不往会话页加任何元素**（UI Style）。它是可直接访问的 URL `/settings.html`；
// 命令面板里那条 `/settings`（pi 的多项设置菜单）仍是 TUI 专用，但它的说明文字里指了这一页的地址。

import { settingsRequest } from './settings-client.mjs';

const KEY = 'thinking.defaultFold';
const NOTIFY_KEY = 'annotations.notifySession';
const SUGGESTIONS_KEY = 'suggestions.enabled';
const SEAL_KEY = 'seal.autoOnCompaction';
const LABELS = { expanded: '默认展开', collapsed: '默认收起' };
const NODE = {
  state: document.querySelector('#settings-state'),
  group: document.querySelector('#settings-fold'),
  radios: [...document.querySelectorAll('input[name="thinking-default-fold"]')],
  notifyInput: document.querySelector('#settings-notify-input'),
  notifySave: document.querySelector('#settings-notify-save'),
  notifyState: document.querySelector('#settings-notify-state'),
  notifyField: document.querySelector('#settings-notify'),
  suggestionsToggle: document.querySelector('#settings-suggestions-enabled'),
  suggestionsState: document.querySelector('#settings-suggestions-state'),
  sealToggle: document.querySelector('#settings-seal-auto'),
  sealState: document.querySelector('#settings-seal-state'),
};

function setState(text, kind = '') {
  NODE.state.textContent = text;
  NODE.state.dataset.kind = kind;
}

function setNotifyState(text, kind = '') {
  NODE.notifyState.textContent = text;
  NODE.notifyState.dataset.kind = kind;
}

/** ② 维护者会话：值只可能是「空串（不通知）」或完整 uuid（服务端校验过的）。 */
function paintNotify(payload) {
  const effective = payload?.settings?.[NOTIFY_KEY];
  const known = typeof effective === 'string';
  NODE.notifyInput.disabled = !known;
  NODE.notifySave.disabled = !known;
  if (!known) {
    NODE.notifyInput.value = '';
    setNotifyState(`服务端没有给出可识别的 ${NOTIFY_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
    return;
  }
  NODE.notifyInput.value = effective;
  NODE.notifyField.dataset.effective = effective;
  const stored = payload?.stored?.[NOTIFY_KEY] === effective;
  setNotifyState(
    effective === ''
      ? `生效中：不通知（${stored ? '已保存在服务端' : '服务端默认值'}）`
      : `生效中：新反馈会通知 ${effective}（${stored ? '已保存在服务端' : '服务端默认值'}）`,
    'ok',
  );
}

function setSuggestionsState(text, kind = '') {
  NODE.suggestionsState.textContent = text;
  NODE.suggestionsState.dataset.kind = kind;
}

/** ③ 推荐回复总开关（`suggestions.enabled`）：布尔值，只画服务端给的生效值。 */
function paintSuggestions(payload) {
  const effective = payload?.settings?.[SUGGESTIONS_KEY];
  const known = typeof effective === 'boolean';
  NODE.suggestionsToggle.disabled = !known;
  if (!known) {
    NODE.suggestionsToggle.checked = false;
    setSuggestionsState(`服务端没有给出可识别的 ${SUGGESTIONS_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
    return;
  }
  NODE.suggestionsToggle.checked = effective;
  const stored = payload?.stored?.[SUGGESTIONS_KEY] === effective;
  setSuggestionsState(`生效中：${effective ? '开（每回合结束后生成候选）' : '关（一次模型调用都不发）'}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
}

function setSealState(text, kind = '') {
  NODE.sealState.textContent = text;
  NODE.sealState.dataset.kind = kind;
}

/** ④ 「压缩即封存」的自动触发开关（`seal.autoOnCompaction`）：值只可能是布尔，只画服务端给的生效值。 */
function paintSeal(payload) {
  const effective = payload?.settings?.[SEAL_KEY];
  const known = typeof effective === 'boolean';
  NODE.sealToggle.disabled = !known;
  if (!known) {
    NODE.sealToggle.checked = false;
    setSealState(`服务端没有给出可识别的 ${SEAL_KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
    return;
  }
  NODE.sealToggle.checked = effective;
  const stored = payload?.stored?.[SEAL_KEY] === effective;
  setSealState(`生效中：${effective ? '开（压缩落定后自动封存）' : '关（压缩后不再自动封存，显式封存仍可用）'}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
}

function paint(payload) {
  // 服务端给的生效值原样用：它说是什么就是什么（不在这里合并默认值、也不猜）。
  const effective = payload?.settings?.[KEY];
  const known = Object.hasOwn(LABELS, effective ?? '');
  for (const radio of NODE.radios) {
    radio.checked = known && radio.value === effective;
    radio.disabled = !known;
  }
  if (!known) {
    setState(`服务端没有给出可识别的 ${KEY} 值：${JSON.stringify(effective ?? null)}`, 'error');
  } else {
    const stored = payload?.stored?.[KEY] === effective;
    setState(`生效中：${LABELS[effective]}（${stored ? '已保存在服务端' : '还没改过，这是服务端默认值'}）`, 'ok');
    NODE.group.dataset.effective = effective;
  }
  paintNotify(payload);
  paintSuggestions(payload);
  paintSeal(payload);
}

async function request(path, options = {}) {
  return settingsRequest(path, options);
}

async function load() {
  setState('正在读取…');
  setNotifyState('正在读取…');
  setSuggestionsState('正在读取…');
  setSealState('正在读取…');
  try {
    paint(await request('/settings'));
  } catch (error) {
    for (const radio of NODE.radios) radio.disabled = true;
    NODE.notifyInput.disabled = true;
    NODE.notifySave.disabled = true;
    NODE.suggestionsToggle.disabled = true;
    NODE.sealToggle.disabled = true;
    setState(`读不到设置：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
    setNotifyState(`读不到设置：${error.message}`, 'error');
    setSuggestionsState(`读不到设置：${error.message}`, 'error');
    setSealState(`读不到设置：${error.message}`, 'error');
  }
}

async function save(value) {
  for (const radio of NODE.radios) radio.disabled = true;
  setState('正在保存…');
  try {
    // PATCH 回来的就是**新的生效值**（服务端权威）；照它重画，不拿本地的选择当结果。
    paint(await request('/settings', { method: 'PATCH', body: JSON.stringify({ [KEY]: value }) }));
  } catch (error) {
    setState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
    // 失败后回到服务端当下的真值（重读一次），免得界面停在一个没生效的勾上。
    await load();
  }
}

/** ② 维护者会话：空串 = 不通知（也是服务端合法值之一）。 */
async function saveNotify(value) {
  NODE.notifyInput.disabled = true;
  NODE.notifySave.disabled = true;
  setNotifyState('正在保存…');
  try {
    paintNotify(await request('/settings', { method: 'PATCH', body: JSON.stringify({ [NOTIFY_KEY]: value }) }));
  } catch (error) {
    setNotifyState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
    await load();
  }
}

/** ③ 推荐回复总开关：改即存（checkbox 的勾选状态本身就是值）。 */
async function saveSuggestions(value) {
  NODE.suggestionsToggle.disabled = true;
  setSuggestionsState('正在保存…');
  try {
    paintSuggestions(await request('/settings', { method: 'PATCH', body: JSON.stringify({ [SUGGESTIONS_KEY]: value }) }));
  } catch (error) {
    setSuggestionsState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
    await load();
  }
}

/** ④ 压缩即封存：改即存（与思考折叠、「推荐回复」同一条路），回读服务端生效值再画。 */
async function saveSeal(value) {
  NODE.sealToggle.disabled = true;
  setSealState('正在保存…');
  try {
    // 同一条纪律：PATCH 回来的就是**新的生效值**，照它重画（不拿本地勾选当结果）。
    paintSeal(await request('/settings', { method: 'PATCH', body: JSON.stringify({ [SEAL_KEY]: value }) }));
  } catch (error) {
    setSealState(`保存失败：${error.message}（服务端 ${error.status ?? '?'}）`, 'error');
    await load();
  }
}

for (const radio of NODE.radios) {
  radio.addEventListener('change', (event) => {
    if (!event.target.checked) return;
    void save(event.target.value);
  });
}

// ② 维护者会话：**点保存才写**（空串也是一个明确的选择：不通知）。
NODE.notifySave?.addEventListener('click', () => {
  void saveNotify(NODE.notifyInput.value.trim());
});

// ③ 推荐回复：checkbox 一改就 PATCH（与思考折叠那条同一条路），回读服务端生效值再画。
NODE.suggestionsToggle?.addEventListener('change', (event) => {
  void saveSuggestions(event.target.checked === true);
});

// ④ 压缩即封存：checkbox 一改就 PATCH（与另两项同一条路），回读服务端生效值再画。
NODE.sealToggle?.addEventListener('change', (event) => {
  void saveSeal(event.target.checked === true);
});

await load();
