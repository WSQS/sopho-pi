// test/fixtures/suggestions-bypass.mjs —— 「对话内的推荐回复」那一次**旁路模型调用**的识别器。
//
// 为什么要有它（2026-09-23，`wt/child-5d597207`）：每个回合**落定之后**，服务端会另起一次模型调用
// 生成「下一句」候选（业主拍的那条线；`suggestions.enabled` 默认**开**，见 `server/ui-settings.mjs`
// 里那一段的理由）。那一次请求**不是「这一轮对话的请求」**：它不进对话、不带工具、不产生任何会话条目。
//
// 但既有一些门的假 provider 是按「provider 被打了几次」做断言的（「这个回合只该有一次模型请求」
// 「这个窗口里一个新请求都不该收到」）。那些门要断的**仍然是回合请求**的计数 —— 所以这里给一个
// 共用的识别器把旁路那一次挑出来。**断言强度一个字都没改**：不是放开阈值，是把「哪一种请求」说清楚。
//
// 判据 = 服务端 `SUGGESTION_SYSTEM_PROMPT` 里那行机器可读标记（`SUGGESTION_BYPASS_MARK`）。
// 传**原始 body 字符串**（多数门记的就是它）或已解析的对象都行；也接受 `{ body }` 这种包装。
export const SUGGESTION_BYPASS_MARK = 'sopho.suggestions.v1';

export function isSuggestionBypassRequest(body) {
  if (body === null || body === undefined) return false;
  // 三形状都收：字符串、**Buffer**（`session-seal` 那类门按下发时的字节记的）、已解析的对象。
  const text = typeof body === 'string'
    ? body
    : Buffer.isBuffer(body)
      ? body.toString('utf8')
      : body instanceof Uint8Array
        ? Buffer.from(body).toString('utf8')
        : JSON.stringify(body);
  return typeof text === 'string' && text.includes(SUGGESTION_BYPASS_MARK);
}

/** 只留下**回合请求**（把旁路那一次挑掉）。`list` 里每项可以是 body 字符串/对象，也可以是 `{ body }`。 */
export function turnRequestsOf(list) {
  return (list ?? []).filter((entry) => !isSuggestionBypassRequest(entry?.body ?? entry));
}
