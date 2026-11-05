package dev.sopho.pi.net

import okhttp3.OkHttpClient

/**
 * `GET /api/tree/events` 的**帧契约**。读的是服务端源码（`server/base-logic.mjs` 的 `treeEvents` /
 * `emitTree` / `beginSse`），不是猜的：
 *
 * - 连接先发一帧 `tree.snapshot`：`{type:'tree.snapshot', sessions:[…], …}`，形状与 `GET /tree` 相同；
 * - 之后每次**树的事实**变化发 `tree.session`：`{seq, at, type, sessionId, reason}`，`reason` 例如
 *   `created` / `title_changed` / `child_created` / `delegated` / `moved` / `sealed` / `metadata_changed`，
 *   以及会话级 `session.*` 里**没被 `TREE_EVENT_SUPPRESSED` 挡掉**的状态转换（`start` / `end` / `settled` …）。
 *   流式增量、工具两相、`session.notice`、推荐回复都**抑掉**了，所以它不会每来一个字发一条；
 * - 心跳是注释帧（15 s），协商 `retry: 1000`；**服务端不读 `Last-Event-ID`** ⇒ 重连不是续播，
 *   必须重新拉一次 `GET /api/tree` 对账（见 [TreeLive]）。
 *
 * 所以一帧只回答一件事：“树的事实可能变了”。变成什么样**只**以 `GET /api/tree` 为准 ——
 * 本客户端**不**把 `tree.snapshot` 帧体直接上屏：它与随手到的 `/tree` 会打架（谁旧谁新无从判断），
 * 而 `/tree` 是权威投影。
 */
object TreeEvents {
    const val PATH = "/api/tree/events"
    const val SNAPSHOT = "tree.snapshot"
    const val SESSION = "tree.session"

    /** 这一帧是否说明“树的事实可能变了”。**未知帧名一律不当刷新信号**（不猜）。 */
    fun isTreeFrame(type: String): Boolean = type == SNAPSHOT || type == SESSION
}

/**
 * 整棵树的前台 SSE。与 [SessionStream] 共用 [SseStream] 那套状态机/退避/可见失败/取消语义，
 * 只差一个 URL 与“帧怎么用”（由调用方决定：这里只是把帧原样交出去）。
 */
class TreeEventsStream(
    client: OkHttpClient,
    baseUrl: String,
    onState: (StreamState, String?) -> Unit,
    onFrame: (type: String, data: String) -> Unit,
    headersTimeoutMs: Long = SSE_HEADERS_TIMEOUT_MS,
) {
    private val inner = SseStream(
        client = client,
        url = baseUrl + TreeEvents.PATH,
        onState = onState,
        onEvent = onFrame,
        headersTimeoutMs = headersTimeoutMs,
    )

    suspend fun run() = inner.run()

    fun cancel() = inner.cancel()
}

/**
 * 列表页那一行「实时状态」的文字。**照事实说**：
 * 断开就写未连接（重试中），后台停掉就写已请求停止 —— 不写“已停止/已释放”（取消是协作式的，
 * 底层连接（尤其 libzt 的 native socket）可能要等 read/connect 返回才真正释放，没有真机证据）。
 */
fun treeStatusText(state: StreamState, detail: String?): String = when (state) {
    StreamState.CONNECTING -> "连接中…" + (detail?.let { "（$it）" } ?: "")
    StreamState.OPEN -> "● 实时（已连接）"
    StreamState.OPEN_AFTER_RECONNECT -> "● 实时（已重连，已按服务端重拉列表对账）"
    StreamState.CLOSED -> "○ 未连接（服务端收流，重试中）"
    StreamState.FAILED -> "○ 未连接（重试中）" + (detail?.take(200)?.let { "：$it" } ?: "")
}
