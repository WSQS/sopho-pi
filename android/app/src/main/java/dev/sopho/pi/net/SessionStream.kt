package dev.sopho.pi.net

import okhttp3.OkHttpClient

/**
 * 单会话的前台 SSE 流（`/api/sessions/{id}/events`）。
 *
 * 语义照服务端的事实（`server/base-logic.mjs` 的 `beginSse` / `eventPayload`）：
 * - 心跳 15 s（注释帧）、`retry: 1000`；
 * - **服务端不读 `Last-Event-ID`** ⇒ 重连**不是续播**，必须由调用方在 `OPEN_AFTER_RECONNECT`
 *   时重新拉一次正文（快照对账）。`id:` 帧照样会到，但**不当重放保证**用。
 * - 服务端软失败是「200 + text/event-stream 然后收流」⇒ 收到流结束也按 retry 语义重连。
 *
 * 状态机/退避/可见失败/取消全在 [SseStream] 里（与树事件流共用一份）；这里只给 URL。
 * ⚠️ 取消 cancel 的是 OkHttp 的 Call，**native fd 是否真被 close 没有真机证据**。
 */
class SessionStream(
    client: OkHttpClient,
    baseUrl: String,
    sessionId: String,
    onState: (StreamState, String?) -> Unit,
    onEvent: (type: String, data: String) -> Unit,
    /** 从发起请求到拿到响应头的上限（可注入，便于单测把“无响应头”压到亚秒级）。 */
    headersTimeoutMs: Long = SSE_HEADERS_TIMEOUT_MS,
) {
    private val inner = SseStream(
        client = client,
        url = "$baseUrl/api/sessions/$sessionId/events",
        onState = onState,
        onEvent = onEvent,
        headersTimeoutMs = headersTimeoutMs,
    )

    suspend fun run() = inner.run()

    fun cancel() = inner.cancel()
}
