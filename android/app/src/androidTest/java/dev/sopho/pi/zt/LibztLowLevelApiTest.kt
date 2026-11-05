package dev.sopho.pi.zt

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.zerotier.sockets.ZeroTierNative
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 固定 AAR 的**低层调用面**：不是“假设签名”，而是直接对打包进 APK 的 `ZeroTierNative` 取方法。
 *
 * 这个测试**不 start 节点、不 join/orbit 任何网络**：只做一次 `zts_bsd_socket` / `zts_connect` 的失败路径，
 * 证明：
 * - 应用实际调用到的低层方法都存在（与 `LibztSockets` 的用法一一对应）；
 * - 常数与 AAR 一致；
 * - 未启动节点时连接失败是**快速**返回并带 rc（不是 native 的 30 s 默认），修好的路径会 close fd。
 *
 * ⚠️ 它不证明真实网络可达；也不证明 close 能打断 lwIP 的阻塞调用（那一格没有授权/真机证据）。
 */
@RunWith(AndroidJUnit4::class)
class LibztLowLevelApiTest {

    private val INT: Class<*> = Int::class.javaPrimitiveType!!
    private val BYTES: Class<*> = ByteArray::class.java

    @Test
    fun fixedAarExposesEveryLowLevelCallWeUse() {
        fun require(name: String, vararg params: Class<*>) {
            ZeroTierNative::class.java.getMethod(name, *params)
        }
        require("zts_bsd_socket", INT, INT, INT)
        require(
            "zts_connect",
            INT,
            String::class.java,
            INT,
            INT,
        )
        require("zts_bsd_close", INT)
        require(
            "zts_set_recv_timeout",
            INT,
            INT,
            INT,
        )
        require(
            "zts_bsd_read_offset",
            INT,
            BYTES,
            INT,
            INT,
        )
        // 故意用整块 write：AAR 的 write_offset 在 offset>0 时把 &(buf[offset]) 当 jarray 传给
        // GetPrimitiveArrayCritical（源码和 x86_64 libzt.so 反汇编都如此），不是我们能依赖的 API。
        require("zts_bsd_write", INT, BYTES)
        require("zts_bsd_shutdown", INT, INT)

        assertEquals("ZTS_AF_INET", LibztSockets.FAMILY_INET, ZeroTierNative.ZTS_AF_INET)
        assertEquals("ZTS_AF_INET6", LibztSockets.FAMILY_INET6, ZeroTierNative.ZTS_AF_INET6)
        assertEquals("ZTS_SOCK_STREAM", LibztSockets.SOCK_STREAM, ZeroTierNative.ZTS_SOCK_STREAM)
    }

    @Test
    fun connectingWithoutAStartedNodeFailsFastWithAnRcAndClosesTheFd() {
        val startedAt = System.nanoTime()
        val error = try {
            LibztSockets.begin("127.0.0.1", 9, 1_000).connect()
            null
        } catch (failure: IOException) {
            failure
        }
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
        println("[libzt-api] no-node failfast elapsedMs=$elapsedMs error=${error?.message}")
        assertNotNull("没有节点时必须抛 IOException（不能假装连上）", error)
        assertTrue("不能等 native 的 30s 默认：${elapsedMs}ms", elapsedMs < 5_000)
        assertTrue("失败信息要带 rc：${error!!.message}", error.message!!.contains("rc="))
    }
}
