package dev.sopho.pi.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.BufferedSource
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference

enum class StreamState { CONNECTING, OPEN, OPEN_AFTER_RECONNECT, CLOSED, FAILED }

/**
 * 等响应头的上限。服务端 `beginSse` 一拿到连接就写响应头（还先写 `retry: 1000`）；
 * 20 s 还没头就不是“慢”，是失败 —— 到点 cancel 这次 Call，让它变成一个**可见的失败**。
 */
internal const val SSE_HEADERS_TIMEOUT_MS = 20_000L

/**
 * 一条前台 SSE 的**公共骨架**。
 *
 * `SessionStream`（`/api/sessions/{id}/events`，单会话）与 `TreeEventsStream`（`/api/tree/events`，整棵树）
 * 除了 URL **一模一样**：状态机、有界退避、可见失败、取消都必须是同一套（[ReconnectBackoff]），
 * 所以这里只留一份实现，两边都是几行的适配器。语义照服务端的事实（`server/base-logic.mjs` 的
 * `beginSse` / `sseWrite`）：
 * - 心跳 15 s（注释帧）、`retry: 1000`；
 * - **服务端不读 `Last-Event-ID`** ⇒ 重连**不是续播**，必须由调用方在 `OPEN_AFTER_RECONNECT`
 *   时重新拉一次权威快照（正文 / 树）对账。`id:` 帧照样会到，但**不当重放保证**用；
 * - 服务端软失败是「200 + text/event-stream 然后收流」⇒ 收到流结束也按 retry 语义重连。
 *
 * 两件事照旧、不改语义：
 * 1. **每个阶段都可见**：CONNECTING 期间每 500 ms 报“第几次、已等多久、上次为什么失败”；
 *    失败时报“第几次失败、耗时、原因、下一次多久后重试”。不再只有一句“连接中…”挂到底。
 * 2. **有界退避**：连接失败 1→2→4→8→16→30 s；一段流稳定超过 10 s 再断，下一次仍从 1 s 开始。
 *
 * ⚠️ 取消**只是请求取消**：`cancel()` 置标记并 cancel 这次 OkHttp Call。阻塞中的
 * `connect`/`execute`/读**多久才返回没有任何证据**（libzt 的 `ZeroTierSocket.isClosed()` 只反映它自己
 * 调用过 close，看不到对端半关），**native fd 是否真被释放也未验** ⇒ 谁都不许把“已请求取消/已请求停止”
 * 写成“阻塞读已结束”或“fd 已释放”。
 */
internal class SseStream(
    private val client: OkHttpClient,
    private val url: String,
    private val onState: (StreamState, String?) -> Unit,
    private val onEvent: (type: String, data: String) -> Unit,
    private val headersTimeoutMs: Long = SSE_HEADERS_TIMEOUT_MS,
) {
    @Volatile private var cancelled = false

    private val call = AtomicReference<okhttp3.Call?>(null)

    suspend fun run() = withContext(Dispatchers.IO) {
        var openedOnce = false
        var failures = 0
        var lastError: String? = null

        while (!cancelled && isActive) {
            val attempt = failures + 1
            val startedAt = System.nanoTime()
            var openedThisAttempt = false
            var stable = false
            val deadlineReason = AtomicReference<String?>(null)

            onState(StreamState.CONNECTING, ReconnectBackoff.connectingText(attempt, 0, lastError))

            try {
                coroutineScope {
                    val request = Request.Builder()
                        .url(url)
                        .header("accept", "text/event-stream")
                        .build()
                    val current = client.newCall(request)
                    call.set(current)
                    if (cancelled) {
                        current.cancel()
                        throw CancellationException("SSE 流已取消")
                    }

                    // 连接/等响应头期间每 500 ms 刷新一次“已等多久”：native connect 或读超时都可能很慢，
                    // 只发一次 CONNECTING 的话界面就又变成“看起来永远不动”。
                    val progress = launch {
                        while (isActive) {
                            delay(PROGRESS_INTERVAL_MS)
                            if (!openedThisAttempt && !cancelled) {
                                onState(
                                    StreamState.CONNECTING,
                                    ReconnectBackoff.connectingText(attempt, elapsedMs(startedAt), lastError),
                                )
                            }
                        }
                    }

                    // 响应头 deadline：不是靠“把读超时加长/缩短”掩盖，而是到点 cancel 这次 Call，
                    // 让无响应头变成一个**可见的失败**（带耗时/次数/退避）。
                    val deadline = launch {
                        delay(headersTimeoutMs)
                        if (!openedThisAttempt && !cancelled) {
                            deadlineReason.set("等待响应头 ${headersTimeoutMs}ms 超时")
                            current.cancel()
                        }
                    }

                    try {
                        current.execute().use { response ->
                            if (!response.isSuccessful) {
                                throw IOException("HTTP ${response.code}")
                            }
                            val source = response.body?.source() ?: throw IOException("空响应体")
                            openedThisAttempt = true
                            progress.cancel()
                            deadline.cancel()
                            lastError = null
                            onState(
                                if (openedOnce) StreamState.OPEN_AFTER_RECONNECT else StreamState.OPEN,
                                "第 $attempt 次 · 已建立（${ReconnectBackoff.durationText(elapsedMs(startedAt))}）",
                            )
                            openedOnce = true
                            readFrames(source, onEvent)
                        }
                        if (!cancelled) {
                            val duration = elapsedMs(startedAt)
                            stable = duration >= ReconnectBackoff.STABLE_MS
                            onState(
                                StreamState.CLOSED,
                                "服务端收流（第 $attempt 次，持续 ${ReconnectBackoff.durationText(duration)}）",
                            )
                        }
                    } finally {
                        progress.cancel()
                        deadline.cancel()
                        call.set(null)
                        if (cancelled) current.cancel()
                    }
                }
            } catch (cancelledError: CancellationException) {
                throw cancelledError
            } catch (error: IOException) {
                if (!cancelled) {
                    val duration = elapsedMs(startedAt)
                    stable = duration >= ReconnectBackoff.STABLE_MS
                    lastError = deadlineReason.get() ?: error.message ?: error.javaClass.simpleName
                    val failuresForDelay = if (stable) 0 else failures + 1
                    val nextDelay = ReconnectBackoff.delayMs(failuresForDelay)
                    onState(
                        StreamState.FAILED,
                        ReconnectBackoff.failureText(attempt, duration, lastError ?: "未知错误", nextDelay),
                    )
                }
            }

            if (cancelled) break

            // 稳定活过 10 s 的流断开 = 网络抖动，重新从 1 s 开始；连续短命/连不上才退避。
            if (stable) failures = 0 else failures += 1
            val delayMs = ReconnectBackoff.delayMs(failures)
            delay(delayMs)
        }
    }

    fun cancel() {
        cancelled = true
        call.get()?.cancel()
    }

    /** 最小 SSE 解析器：只认 `event:` / `data:`（`id:` 与注释帧收下但不用）。 */
    private fun readFrames(source: BufferedSource, sink: (String, String) -> Unit) {
        var type = "message"
        val data = StringBuilder()
        while (!cancelled) {
            val line = source.readUtf8Line() ?: throw IOException("服务端收流")
            if (line.isEmpty()) {
                if (data.isNotEmpty()) {
                    sink(type, data.toString())
                }
                type = "message"
                data.setLength(0)
                continue
            }
            if (line.startsWith(":")) continue // 心跳注释帧
            val colon = line.indexOf(':')
            val field = if (colon < 0) line else line.substring(0, colon)
            val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
            when (field) {
                "event" -> type = value
                "data" -> {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(value)
                }
                else -> Unit // `id:` / `retry:` 收下不用（重连节奏由 ReconnectBackoff 管）
            }
        }
    }

    private fun elapsedMs(startedAtNanos: Long): Long =
        (System.nanoTime() - startedAtNanos) / 1_000_000

    private companion object {
        const val PROGRESS_INTERVAL_MS = 500L
    }
}
