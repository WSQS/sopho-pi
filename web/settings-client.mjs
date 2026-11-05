// web/settings-client.mjs —— 「设置」两处界面（**会话页的浮层** / 独立页 `web/settings.html`）**共用**的取数与提交。
//
// 为什么单开一个模块：同一份服务端设置（`$ASSIST_HOME/ui-settings.json`，`GET/PATCH /settings`）现在有
// **两处**读写界面 —— 协议只该有一份实现（路径前缀、JSON、错误语义）。各写一份迟早漂移，而业主的硬要求
// 正是「两处必须读**同一份**服务端设置（不许各存一份）」。
//
// 语义是从 `web/settings.js` 的 v1 实现**原样搬过来**的（一字未改）：
//   · 走 `/api/settings`（B 的 `/api` 前缀；A 上就是 `/settings`）；
//   · 只有带 body 时才带 `content-type: application/json`；
//   · 非 2xx ⇒ 抛 `Error`：`message` 用服务端给的人话（**非 JSON 体就原样用、只去掉首尾空白** ——
//     活宿主的顶层 404 体就是纯文本 `not found`；没有体就用 `HTTP <status>`），`status` 带上 HTTP 码 ——
//     调用方要**如实说出来**（读不到 ≠ 用默认值假装成功）。

export async function settingsRequest(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    ...options,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.trim() }; }
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);    error.status = response.status;
    throw error;
  }
  return body;
}
