package dev.sopho.pi.zt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 用**替身**钉住 Moon 那一步的三件事（不需要 native、不碰任何真实 moon/网络）：
 * 1. 没配置 ⇒ **一次都不调用**（默认“不加额外 root”不能变成隐式调用）；
 * 2. 配置了 ⇒ 恰好调用一次，且**两个参数就是 World ID / Seed ID 的位**（不是 ip/port、不是 network id）；
 * 3. 返回码 → 上屏读数与“是否必须中止”的映射（0 只算调用被接受；负数中止）。
 *
 * 调用点相对 `zts_start` / `join` 的位置**不在**这里验（那需要 native 的 `ZeroTierNode`）；
 * 它由 `ZtManager.start` 的代码顺序与 KDoc 说明，见 `docs/ops/android-client.md` §11。
 */
class MoonLauncherTest {

    private class Recorder(private val rc: Int) : MoonOrbiter {
        val calls = ArrayList<Pair<Long, Long>>()
        override fun orbit(worldId: Long, seedId: Long): Int {
            calls += worldId to seedId
            return rc
        }
    }

    @Test
    fun `no moon configured means the native call never happens`() {
        val recorder = Recorder(0)
        val result = MoonLauncher(recorder).orbitIfConfigured(null)
        assertTrue(recorder.calls.isEmpty())
        assertNull(result.text)
        assertNull(result.failure)
    }

    @Test
    fun `a configured moon is passed through as the two 64-bit ids, once`() {
        val recorder = Recorder(0)
        val config = MoonConfig(worldId = 0x0123456789abcdefL, seedId = -1L) // seed 的位型＝ffffffffffffffff
        val result = MoonLauncher(recorder).orbitIfConfigured(config)
        assertEquals(1, recorder.calls.size)
        assertEquals(0x0123456789abcdefL to -1L, recorder.calls.single())
        assertEquals("Moon orbit 0（ZTS_ERR_OK：调用被接受）", result.text)
        assertNull(result.failure)
    }

    @Test
    fun `rc 0 is reported as accepted-but-not-proof and does not abort`() {
        val result = MoonLauncher(Recorder(0)).orbitIfConfigured(MoonConfig(1L, 2L))
        assertNull(result.failure)
        assertTrue(result.text!!.contains("ZTS_ERR_OK"))
        assertTrue(result.text!!.contains("调用被接受"))
    }

    @Test
    fun `negative return codes abort the connect and say which code it was`() {
        for (rc in listOf(-1, -2, -3, -4, -5)) {
            val result = MoonLauncher(Recorder(rc)).orbitIfConfigured(MoonConfig(1L, 2L))
            assertTrue("rc=$rc 必须中止", result.failure != null)
            assertTrue(result.failure!!.contains("$rc"))
            assertTrue(result.text!!.contains("$rc"))
        }
    }

    @Test
    fun `an out-of-contract return code still aborts instead of being treated as ok`() {
        val result = MoonLauncher(Recorder(42)).orbitIfConfigured(MoonConfig(1L, 2L))
        assertTrue(result.failure != null)
        assertTrue(result.failure!!.contains("契约外"))
    }
}
