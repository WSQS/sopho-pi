package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectBackoffTest {

    @Test
    fun `delay grows 1-2-4-8-16-30 and is capped`() {
        assertEquals(1_000L, ReconnectBackoff.delayMs(0))
        assertEquals(1_000L, ReconnectBackoff.delayMs(1))
        assertEquals(2_000L, ReconnectBackoff.delayMs(2))
        assertEquals(4_000L, ReconnectBackoff.delayMs(3))
        assertEquals(8_000L, ReconnectBackoff.delayMs(4))
        assertEquals(16_000L, ReconnectBackoff.delayMs(5))
        assertEquals(30_000L, ReconnectBackoff.delayMs(6))
        assertEquals(30_000L, ReconnectBackoff.delayMs(20))
    }

    @Test
    fun `connecting text carries attempt and last error but never a body`() {
        val text = ReconnectBackoff.connectingText(2, 1_500, "timeout")
        assertTrue(text, text.contains("第 2 次"))
        assertTrue(text, text.contains("已等 1.5s"))
        assertTrue(text, text.contains("上次：timeout"))
        assertEquals("第 1 次 · 已等 0ms", ReconnectBackoff.connectingText(1, 0, null))
    }

    @Test
    fun `failure text says attempt, elapsed, reason and next delay`() {
        val text = ReconnectBackoff.failureText(3, 4_200, "connect refused", 4_000)
        assertTrue(text, text.contains("第 3 次失败"))
        assertTrue(text, text.contains("4.2s"))
        assertTrue(text, text.contains("connect refused"))
        assertTrue(text, text.contains("4.0s 后重试"))
    }

    @Test
    fun `a stable stream resets the backoff to one second`() {
        // STABLE_MS 以上算稳定；SessionStream 用这个值决定失败计数是否清零。
        assertEquals(10_000L, ReconnectBackoff.STABLE_MS)
        assertEquals(1_000L, ReconnectBackoff.delayMs(0))
    }
}
