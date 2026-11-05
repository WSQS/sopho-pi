package dev.sopho.pi.zt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 钉住 `zts_addr_is_assigned` 的返回码判据。
 *
 * 为什么值得一条测试：旧实现写的是 `rc != 0`，而 libzt 的负数都是**错误码**
 * （`ZTS_ERR_SERVICE = -2`、`ZTS_ERR_ARG = -3`，见固定 revision `zerotier/libzt@a707ea6`
 * 的 `include/ZeroTierSockets.h:34-40`）⇒ 旧判据会把「服务未就绪 / 参数非法」读成「已分配」，
 * 于是客户端拿着一个并不存在的虚拟地址往下走。这条测试就是那件事的反证。
 */
class AddressProbeTest {

    @Test
    fun `positive return code means assigned`() {
        assertEquals(AddressProbe.ASSIGNED, addressProbe(1))
        assertEquals(AddressProbe.ASSIGNED, addressProbe(7)) // 非 1 的正数也应算「有」
    }

    @Test
    fun `zero means not assigned yet`() {
        assertEquals(AddressProbe.NOT_YET, addressProbe(0))
    }

    @Test
    fun `negative return codes are errors and never count as assigned`() {
        // 逐个点名 ZTS 的错误码全集（OK=0 / SOCKET=-1 / SERVICE=-2 / ARG=-3 / NO_RESULT=-4 / GENERAL=-5）
        for (code in listOf(-1, -2, -3, -4, -5)) {
            assertEquals("rc=$code 必须是 ERROR", AddressProbe.ERROR, addressProbe(code))
            assertNotEquals("rc=$code 不能被当成已分配", AddressProbe.ASSIGNED, addressProbe(code))
        }
    }
}
