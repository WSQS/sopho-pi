package dev.sopho.pi.zt

import dev.sopho.pi.Profile
import dev.sopho.pi.Profiles
import dev.sopho.pi.RunMode
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * “Profile 是服务器连接配置，不是 ZeroTier 网络的唯一拥有者”：
 * - 同 network＋同 Moon、不同 serverUrl 的两条 Profile 必须落在**同一个** zt 配置键上；
 * - 切到另一条这样的 Profile 不应 leave/rejoin，也不应 re-init/re-start；
 * - 新 AppState（Activity 重建）接管同一张网只换租约，零 native 调用；
 * - Moon 不同 ⇒ 键不同，沿用现有口径（先 leave 再 orbit+join），旧 orbit 不保证被移除。
 *
 * 这一组只在 JVM 的假 native 上验调用序列；真实 native/真网未验。
 */
private class ReuseFake : ZtNative {
    val calls = ArrayList<String>()
    var online = true
    var running = false
        private set
    var transportReady = true
    var addrRc = 1

    override fun initFromStorage(path: String): Int {
        if (running) return ZtsErr.SERVICE
        calls += "init"
        return ZtsErr.OK
    }

    override fun start(): Int {
        if (running) return ZtsErr.SERVICE
        calls += "start"
        running = true
        return ZtsErr.OK
    }

    override fun isOnline(): Boolean = online
    override fun join(networkId: Long): Int {
        calls += "join(${hex(networkId)})"
        return ZtsErr.OK
    }

    override fun leave(networkId: Long): Int {
        calls += "leave(${hex(networkId)})"
        return ZtsErr.OK
    }

    override fun isTransportReady(networkId: Long): Boolean = transportReady
    override fun addrIsAssigned(networkId: Long, family: Int): Int = if (running) addrRc else 0
    override fun nodeId(): Long = if (running) 0x0123456789L else -2L
    override fun ipv4(networkId: Long): String? = if (running) "10.147.20.5" else null
    override fun orbit(worldId: Long, seedId: Long): Int {
        calls += "orbit(${java.lang.Long.toUnsignedString(worldId, 16).padStart(16, '0')},${java.lang.Long.toUnsignedString(seedId, 16).padStart(16, '0')})"
        return ZtsErr.OK
    }

    private fun hex(id: Long): String = java.lang.Long.toHexString(id).padStart(16, '0')
}

class ZtProfileReuseTest {

    private val net = java.lang.Long.parseUnsignedLong("8056c2e21c000001", 16)
    private val netHex = "8056c2e21c000001"
    private val moonA = MoonConfig(0x0123456789abcdefL, 0xfedcba9876543210UL.toLong())
    private val moonB = MoonConfig(0x1111111111111111L, 0x2222222222222222L)

    private fun dir(): File =
        File(System.getProperty("java.io.tmpdir"), "sopho-zt-reuse/zerotier").apply { mkdirs() }

    private fun manager(native: ReuseFake, node: ZtNode) =
        ZtManager(dir(), node, timeoutMs = 200, pollMs = 5)

    @Test
    fun `two profiles on the same network and moon but different server urls share the same zt key`() {
        val a = Profile("a", "A", "http://10.0.0.1:7321", RunMode.ZEROTIER, netHex, "0123456789abcdef", "fedcba9876543210")
        val b = Profile("b", "B", "http://10.0.0.2:7321", RunMode.ZEROTIER, netHex, "0123456789abcdef", "fedcba9876543210")
        assertEquals("serverUrl 不该参与 zt 节点配置键", Profiles.ztConfigKey(a), Profiles.ztConfigKey(b))
        assertNotEquals("改 Moon 必须换键（现有 orbit 生效口径）", Profiles.ztConfigKey(a), Profiles.ztConfigKey(a.copy(moonWorld = "1111111111111111")))
    }

    @Test
    fun `switching to a same-network profile does not leave or re-init the node`() {
        val native = ReuseFake()
        val node = ZtNode(native)
        val manager = manager(native, node)

        runBlocking { manager.start(netHex, moonA) }
        val afterFirst = native.calls.toList()
        // AppState 切到 B：key 相同 ⇒ 不调用 zt.disconnect()；再连接也只走同一个 Ready 分支。
        runBlocking { manager.start(netHex, moonA) }
        assertEquals("同网同 Moon 再连接不许有额外 init/start/leave/join/orbit", afterFirst, native.calls)
        assertEquals(listOf("init", "start", "orbit(0123456789abcdef,fedcba9876543210)", "join($netHex)"), afterFirst)
    }

    @Test
    fun `a new AppState taking over the same network only transfers the lease`() {
        val native = ReuseFake()
        val node = ZtNode(native)
        val first = manager(native, node)
        val second = manager(native, node) // = Activity 重建后的新 AppState/ZtManager

        runBlocking { first.start(netHex, moonA) }
        val afterFirst = native.calls.toList()
        runBlocking { second.start(netHex, moonA) }
        assertEquals("新实例接管同网：只换租约，零 native 调用", afterFirst, native.calls)

        first.disconnect() // 旧实例迟到的 close
        assertEquals("旧实例的 close 不许 leave 新实例的网", afterFirst, native.calls)
        second.disconnect()
        assertEquals("只有当前持有者 leave 一次", listOf("leave($netHex)"), native.calls.drop(afterFirst.size))
    }

    @Test
    fun `a moon change on an already-ready manager is applied instead of silently ignored`() {
        val native = ReuseFake()
        val node = ZtNode(native)
        val manager = manager(native, node)

        runBlocking {
            manager.start(netHex, moonA)
            manager.start(netHex, moonB) // 没有 disconnect：只换 Moon，同网 join 是幂等的
        }

        assertEquals(
            listOf(
                "init",
                "start",
                "orbit(0123456789abcdef,fedcba9876543210)",
                "join($netHex)",
                "orbit(1111111111111111,2222222222222222)",
            ),
            native.calls,
        )
        val ready = manager.status.value as ZtStatus.Ready
        assertTrue("要如实说明旧 Moon 不会被移除：${ready.moon}", ready.moon!!.contains("旧 Moon"))
    }

    @Test
    fun `a stale Ready is not trusted after the current holder left the network`() {
        val native = ReuseFake()
        val node = ZtNode(native)
        val first = manager(native, node)
        val second = manager(native, node)

        runBlocking { first.start(netHex, moonA) } // first 持有
        runBlocking { second.start(netHex, moonA) } // second 接管租约（同网零 native）
        second.disconnect() // 当前持有者 leave 掉整张网

        val before = native.calls.toList()
        runBlocking { first.start(netHex, moonA) } // first 还停在 Ready，但网已经没了
        assertEquals(
            "过期 Ready 必须重新 join，而不是直接返回：${native.calls}",
            before + "join($netHex)",
            native.calls,
        )
        assertTrue(first.status.value is ZtStatus.Ready)
    }

    @Test
    fun `changing the moon on the same network keeps the existing leave-then-orbit-then-join shape`() {
        val native = ReuseFake()
        val node = ZtNode(native)
        val manager = manager(native, node)

        runBlocking { manager.start(netHex, moonA) }
        // AppState 看到 ztConfigKey 变了：先显式 disconnect（leave），再用新 Moon 连接。
        manager.disconnect()
        runBlocking { manager.start(netHex, moonB) }

        assertEquals(
            listOf(
                "init",
                "start",
                "orbit(0123456789abcdef,fedcba9876543210)",
                "join($netHex)",
                "leave($netHex)",
                "orbit(1111111111111111,2222222222222222)",
                "join($netHex)",
            ),
            native.calls,
        )
        assertTrue("旧 Moon 没有被 deorbit（本单不扩 Moon 管理）", native.calls.none { it.startsWith("deorbit") })
    }
}
