package dev.sopho.pi.net

import java.util.Locale

/**
 * SSE 重连的有界退避。**不是**用来“用重试掩盖失败”：每次失败都通过 `onState(FAILED, …)` 报出
 * 第几次、耗时、原因和下一次等待；退避只是避免失败时每秒新建一个 libzt 连接（旧实现正是那样，
 * 而每次失败连接还会泄漏一个 native fd）。
 *
 * 服务端的心跳是 15 s、`retry: 1000`；第一次重连仍从 1 s 开始，连续失败才 1→2→4→8→16→30 s 封顶。
 * 一段流稳定活了 [STABLE_MS] 以上再断，按“网络抖了一下”算，下一次仍从 1 s 开始。
 */
object ReconnectBackoff {
    const val BASE_MS = 1_000L
    const val MAX_MS = 30_000L
    const val STABLE_MS = 10_000L

    fun delayMs(consecutiveFailures: Int): Long {
        if (consecutiveFailures <= 0) return BASE_MS
        val exponent = (consecutiveFailures - 1).coerceAtMost(5) // 1,2,4,8,16,32 → 封顶 30
        return (BASE_MS shl exponent).coerceAtMost(MAX_MS)
    }

    fun durationText(elapsedMs: Long): String {
        val safe = elapsedMs.coerceAtLeast(0)
        return if (safe < 1_000) {
            "${safe}ms"
        } else {
            String.format(Locale.ROOT, "%.1fs", safe / 1000.0)
        }
    }

    /** “连接中”的那一行：第几次、已经等了多久、上一次为什么失败。不含任何正文/identity。 */
    fun connectingText(attempt: Int, elapsedMs: Long, lastError: String?): String {
        val head = "第 ${attempt.coerceAtLeast(1)} 次 · 已等 ${durationText(elapsedMs)}"
        return if (lastError.isNullOrBlank()) head else "$head · 上次：$lastError"
    }

    /** 失败那一行：原因 ＋ 等多久再试；不写成“已放弃”，也不假装已经连上。 */
    fun failureText(attempt: Int, elapsedMs: Long, error: String, nextDelayMs: Long): String {
        return "第 ${attempt.coerceAtLeast(1)} 次失败（已等 ${durationText(elapsedMs)}）：$error；" +
            "${durationText(nextDelayMs)} 后重试"
    }
}
