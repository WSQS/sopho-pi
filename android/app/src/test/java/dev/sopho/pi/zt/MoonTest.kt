package dev.sopho.pi.zt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住 Moon 输入解析与 `zts_moon_orbit` 返回码的读法。
 *
 * 为什么值得测：这两个参数是 **World ID / Seed ID**（各 16 位十六进制），不是 IP:port；
 * 而 `zts_moon_orbit` **恒回 0**（`src/Controls.cpp` 把 `orbit()` 的返回值丢掉了），
 * 所以「0 == moon 成功」是假的。能测的就是这两层：输入的合法性、返回码怎么上屏。
 * 真正的 moon 可达性**没有**测（那需要真实 moon 与出网，本单不做）。
 */
class MoonTest {

    @Test
    fun `both fields empty means no orbit at all`() {
        assertEquals(MoonInput.Off, Moon.parse("", ""))
        assertEquals(MoonInput.Off, Moon.parse("   ", "\n"))
    }

    @Test
    fun `one field filled but not the other is rejected before connecting`() {
        assertTrue(Moon.parse("0123456789abcdef", "") is MoonInput.Invalid)
        assertTrue(Moon.parse("", "0123456789abcdef") is MoonInput.Invalid)
    }

    @Test
    fun `a valid pair parses to the exact 64-bit bits`() {
        val parsed = Moon.parse("0123456789abcdef", "FEDCBA9876543210")
        assertTrue(parsed is MoonInput.Ok)
        val config = (parsed as MoonInput.Ok).config
        assertEquals(0x0123456789abcdefL, config.worldId)
        assertEquals(0xfedcba9876543210UL.toLong(), config.seedId)
    }

    @Test
    fun `high bit set ids keep their bits instead of overflowing`() {
        // 0x8000000000000000 与 0xffffffffffffffff 用 Long.parseLong 会抛溢出 —— 必须按无符号解析。
        val parsed = Moon.parse("8000000000000000", "ffffffffffffffff")
        assertTrue(parsed is MoonInput.Ok)
        val config = (parsed as MoonInput.Ok).config
        assertEquals(Long.MIN_VALUE, config.worldId)
        assertEquals(-1L, config.seedId)
        assertEquals("ffffffffffffffff", Moon.hex(config.seedId))
        assertEquals("8000000000000000", Moon.hex(config.worldId))
    }

    @Test
    fun `an 0x prefix and surrounding spaces are tolerated`() {
        val parsed = Moon.parse(" 0x0123456789abcdef ", "0X0123456789abcdEF")
        assertTrue(parsed is MoonInput.Ok)
    }

    @Test
    fun `wrong length is rejected`() {
        assertTrue(Moon.parse("0123456789abcde", "0123456789abcdef") is MoonInput.Invalid) // 15
        assertTrue(Moon.parse("0123456789abcdef", "0123456789abcdef0") is MoonInput.Invalid) // 17
        assertTrue(Moon.parse("1", "1") is MoonInput.Invalid)
    }

    @Test
    fun `non hex characters are rejected`() {
        assertTrue(Moon.parse("0123456789abcdeg", "0123456789abcdef") is MoonInput.Invalid)
        assertTrue(Moon.parse("0123456789abcdef", "not-a-moon-id!!") is MoonInput.Invalid)
        // IP:port 这种形状必须被挡住 —— 契约里这两个参数不是地址。
        assertTrue(Moon.parse("10.0.2.2:9993", "0123456789abcdef") is MoonInput.Invalid)
    }

    @Test
    fun `all-zero ids are rejected because libzt returns ZTS_ERR_ARG for them`() {
        assertTrue(Moon.parse("0000000000000000", "0123456789abcdef") is MoonInput.Invalid)
        assertTrue(Moon.parse("0123456789abcdef", "0000000000000000") is MoonInput.Invalid)
    }

    @Test
    fun `only 0 counts as accepted and every negative code is named`() {
        assertTrue(Moon.accepted(0))
        assertFalse(Moon.accepted(-2))
        assertFalse(Moon.accepted(-3))

        assertEquals("0（ZTS_ERR_OK：调用被接受）", Moon.resultText(0))
        assertTrue(Moon.resultText(-2).startsWith("-2（ZTS_ERR_SERVICE"))
        assertTrue(Moon.resultText(-3).startsWith("-3（ZTS_ERR_ARG"))
        assertTrue(Moon.resultText(-4).startsWith("-4（ZTS_ERR_NO_RESULT"))
        assertTrue(Moon.resultText(-5).startsWith("-5（ZTS_ERR_GENERAL"))
        assertTrue(Moon.resultText(-1).startsWith("-1（ZTS_ERR_SOCKET"))
        assertTrue(Moon.resultText(42).contains("契约外"))
    }

    @Test
    fun `the caveat says out loud that 0 is not proof of a working moon`() {
        assertTrue(Moon.CAVEAT.contains("不代表") || Moon.CAVEAT.contains("不能证明"))
        assertTrue(Moon.CAVEAT.contains("zts_moon_orbit"))
    }
}
