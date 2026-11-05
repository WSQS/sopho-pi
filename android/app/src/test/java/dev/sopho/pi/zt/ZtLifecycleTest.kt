package dev.sopho.pi.zt

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 按**真实 native 契约**建模的假货（不碰 libzt、不出网、不碰 identity）。
 *
 * 它只照抄固定 AAR 里与我们有关的几条判据：
 * - 服务在跑时 `initFromStorage` / `zts_node_start` 返回 -2（`ACQUIRE_SERVICE_OFFLINE`，`src/Events.hpp:40-47`）；
 * - 没在跑时 `zts_node_stop` 返回 -2（`ACQUIRE_SERVICE(ZTS_ERR_SERVICE)`，`src/Controls.cpp:622-630`）；
 * - 没在跑时 `zts_addr_is_assigned` 返回 0（`ACQUIRE_SERVICE(0)`，`src/Controls.cpp:332-336`）；
 * - 节点 ID 未启动时是 -2（`zts_node_get_id` 的 `ACQUIRE_SERVICE(ZTS_ERR_SERVICE)`）。
 *
 * `stop` 根本不在这张假货的脸上：`ZtNative` 接口里就没有它（`zts_node_stop()` 的 JNI 壳无条件
 * `DetachCurrentThread` ⇒ 真机 SIGABRT，且会与自己的 service 线程抢着删除全局实例）。
 *
 * 每次调用都记一行 ⇒ 单测用**调用序列**说话，而不只是看最后那个状态字段。
 * ⚠️ 它证明的是**我们的代码**在真实契约下的行为；它**不**证明真实 native 的 -2（那一格另行标注未验）。
 */
private class FakeZtNative : ZtNative {

    val calls = ArrayList<String>()

    var running = false
        private set

    var online = false
    var transportReady = true
    var addrRc = 1
    var joinRc = ZtsErr.OK
    var leaveRc = ZtsErr.OK
    var orbitRc = ZtsErr.OK
    var idValue = 0x0123456789L

    /** 模拟「本进程里已经有一个节点在跑，但不是本 owner 启动的」。 */
    fun pretendAlreadyRunning() {
        running = true
    }

    override fun initFromStorage(path: String): Int {
        if (running) {
            calls += "init(-2)"
            return ZtsErr.SERVICE
        }
        calls += "init"
        return ZtsErr.OK
    }

    override fun start(): Int {
        if (running) {
            calls += "start(-2)"
            return ZtsErr.SERVICE
        }
        calls += "start"
        running = true
        return ZtsErr.OK
    }

    override fun isOnline(): Boolean = online

    override fun join(networkId: Long): Int {
        calls += "join(${hex(networkId)})"
        return joinRc
    }

    override fun leave(networkId: Long): Int {
        calls += "leave(${hex(networkId)})"
        return leaveRc
    }

    override fun isTransportReady(networkId: Long): Boolean = transportReady

    override fun addrIsAssigned(networkId: Long, family: Int): Int = if (running) addrRc else 0

    override fun nodeId(): Long = if (running) idValue else -2L

    override fun ipv4(networkId: Long): String? = if (running) "10.147.20.5" else null

    override fun orbit(worldId: Long, seedId: Long): Int {
        calls += "orbit"
        return orbitRc
    }

    private fun hex(id: Long): String = java.lang.Long.toHexString(id).padStart(16, '0')
}

class ZtLifecycleTest {

    private val netA = java.lang.Long.parseUnsignedLong("8056c2e21c000001", 16)
    private val netB = java.lang.Long.parseUnsignedLong("8056c2e21c000002", 16)

    private fun dir(): File =
        File(System.getProperty("java.io.tmpdir"), "sopho-zt-test/zerotier").apply { mkdirs() }

    private fun manager(native: FakeZtNative, owner: ZtNode, timeoutMs: Long = 200) =
        ZtManager(dir(), owner, timeoutMs = timeoutMs, pollMs = 5)

    // ── 1. 幂等：一个进程只 init 一次、start 一次 ──

    @Test
    fun `a second AppState reuses the running node without a second init or start`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)

        runBlocking {
            manager(native, owner).start(hexId(netA))
            manager(native, owner).start(hexId(netA)) // = Activity 重建后的新 ZtManager，同一个进程
        }

        assertEquals(listOf("init", "start", "join(${hexId(netA)})"), native.calls)
        assertEquals(ZtNode.Phase.STARTED, owner.phase())
    }

    @Test
    fun `connecting the same network twice on the same manager sends nothing`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        runBlocking {
            zt.start(hexId(netA))
            val afterFirst = native.calls.toList()
            zt.start(hexId(netA))
            assertEquals(afterFirst, native.calls) // Ready + 同一个 networkId ⇒ 一次 native 调用都不发
        }
    }

    // ── 2. 自检：跑着时不 init（那只会拿 -2），没跑时只 init ──

    @Test
    fun `self-check while the node is running does not call init again and shows the real id`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        runBlocking {
            zt.start(hexId(netA))
            val afterStart = native.calls.toList()
            zt.selfCheck()
            assertEquals(afterStart, native.calls) // 不重复 init
        }

        val state = zt.status.value as ZtStatus.SelfChecked
        assertEquals(ZtManager.formatNodeId(native.idValue), state.nodeId)
        assertTrue(state.detail, state.detail.contains("节点已在运行"))
    }

    @Test
    fun `self-check before start only initialises identity and promises no node id`() {
        val native = FakeZtNative()
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        runBlocking { zt.selfCheck() }

        assertEquals(listOf("init"), native.calls) // 没有 start、没有 join
        assertEquals(ZtNode.Phase.NOT_STARTED, owner.phase())
        val state = zt.status.value as ZtStatus.SelfChecked
        assertNull("未启动时 libzt 不给 ID", state.nodeId)
        assertTrue(state.detail, state.detail.contains("未启动时 libzt 不给节点 ID"))
    }

    // ── 3. 失败/超时后 owner 不能变成「未启动」 ──

    @Test
    fun `a timed-out attempt keeps the owner STARTED and the retry reuses it`() {
        val native = FakeZtNative().apply { online = false }
        val owner = ZtNode(native)
        val zt = manager(native, owner, timeoutMs = 30)

        val failure = assertThrows(ZtException::class.java) { runBlocking { zt.start(hexId(netA)) } }
        assertTrue(failure.message!!, failure.message!!.contains(ZtStage.WAIT_ONLINE.label))
        assertEquals("native 还在跑，就必须如实记成 STARTED", ZtNode.Phase.STARTED, owner.phase())
        assertEquals(listOf("init", "start"), native.calls) // 还没 join，所以没有 leave

        native.online = true
        runBlocking { zt.start(hexId(netA)) }
        assertEquals(listOf("init", "start", "join(${hexId(netA)})"), native.calls) // 重试不再 init/start
        assertTrue(zt.status.value is ZtStatus.Ready)
    }

    @Test
    fun `a late failure (after join) leaves that network and keeps the node`() {
        val native = FakeZtNative().apply { online = true; transportReady = false }
        val owner = ZtNode(native)
        val zt = manager(native, owner, timeoutMs = 30)

        assertThrows(ZtException::class.java) { runBlocking { zt.start(hexId(netA)) } }

        assertEquals(
            listOf("init", "start", "join(${hexId(netA)})", "leave(${hexId(netA)})"),
            native.calls,
        )
        assertEquals(ZtNode.Phase.STARTED, owner.phase())

        native.transportReady = true
        runBlocking { zt.start(hexId(netA)) }
        assertEquals("join(${hexId(netA)})", native.calls.last())
        assertTrue(zt.status.value is ZtStatus.Ready)
    }

    // ── 4. 换网：先 leave 旧网，再 join 新网；断开不停节点 ──

    @Test
    fun `switching networks leaves the old one before joining the new one`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        runBlocking {
            zt.start(hexId(netA))
            zt.start(hexId(netB))
        }

        assertEquals(
            listOf(
                "init",
                "start",
                "join(${hexId(netA)})",
                "leave(${hexId(netA)})",
                "join(${hexId(netB)})",
            ),
            native.calls,
        )
        assertTrue(native.calls.indexOf("leave(${hexId(netA)})") < native.calls.indexOf("join(${hexId(netB)})"))
    }

    @Test
    fun `disconnect only leaves the network and never stops the node`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        runBlocking { zt.start(hexId(netA)) }
        zt.disconnect()

        assertEquals("leave(${hexId(netA)})", native.calls.last())
        assertEquals(ZtNode.Phase.STARTED, owner.phase())
        assertTrue(zt.status.value is ZtStatus.Idle)
    }

    // ── 4b. 租约：网归“当前持有者”，旧实例晚到的 close / 失败清理一律空操作 ──

    /**
     * 同一张网被**新实例**重新连上 ⇒ 租约换给新的；旧实例（Activity 已关）迟到的 `disconnect()`
     * （即 `AppState.close()` 走的那条）**不得** leave，也不得发任何 native 调用。只有新实例能 leave。
     *
     * 会失败的理由：若拿“networkId 相等”或“有没有 join 过”当条件，旧实例的 close 会把新连接刚用的网撤掉
     * （用户看到“已连接”但实际已经不网内了）—— 这正是本臂盯住的东西。
     */
    @Test
    fun `a late close from the previous instance does not leave the network the new one took over`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val oldOne = manager(native, owner)
        val newOne = manager(native, owner) // = 重建后的新 Activity 里的新 ZtManager

        runBlocking { oldOne.start(hexId(netA)) }
        runBlocking { newOne.start(hexId(netA)) } // 同网接管：换租约，不发 native
        val beforeClose = native.calls.toList()

        oldOne.disconnect() // = 旧 AppState.close()
        assertEquals("旧实例迟到的 close 不许 leave 新实例在用的网", beforeClose, native.calls)
        assertEquals("旧实例自己看到的是“我没连着”", ZtStatus.Idle, oldOne.status.value)
        assertEquals("新实例仍是 Ready", ZtStatus.Ready::class.java, newOne.status.value.javaClass)

        newOne.disconnect()
        assertEquals("只有当前持有者才发 leave（且只有一次）", listOf("leave(${hexId(netA)})"), native.calls.drop(beforeClose.size))
        assertEquals("leave 之后租约清空", 1, native.calls.count { it == "leave(${hexId(netA)})" })

        newOne.disconnect() // 幂等：不再 leave
        assertEquals(1, native.calls.count { it == "leave(${hexId(netA)})" })
    }

    /**
     * 新实例接管的是**另一张网**：旧的先 leave、后的 join（顺序不变），租约归新的；
     * 然后旧实例的**失败清理 / close** 都不许再动 native；最后只有新的能 leave。
     *
     * 会失败的理由：如果失败清理不看租约，旧的晚到清理会把新实例刚 join 的网 leave 掉。
     */
    @Test
    fun `a late failure cleanup from the previous instance cannot touch the new network`() {
        val native = FakeZtNative().apply { online = true }
        val owner = ZtNode(native)
        val oldOne = manager(native, owner)
        val newOne = manager(native, owner)

        runBlocking { oldOne.start(hexId(netB)) }
        runBlocking { newOne.start(hexId(netA)) } // 换网接管：先 leave(netB) 再 join(netA)
        assertTrue(
            "换网顺序不能变：先 leave 旧网再 join 新网 ⇒ ${native.calls}",
            native.calls.indexOf("leave(${hexId(netB)})") < native.calls.indexOf("join(${hexId(netA)})"),
        )
        val beforeLate = native.calls.toList()

        oldOne.disconnect() // 旧实例的 close
        assertEquals("旧实例晚到的 close 不许动 native", beforeLate, native.calls)
        assertEquals("新实例的网还在", ZtNode.Phase.STARTED, owner.phase())
        assertTrue("新实例仍看得到网就绪", owner.isTransportReady(netA))

        newOne.disconnect()
        assertEquals("只有新实例能 leave 它自己那张网", listOf("leave(${hexId(netA)})"), native.calls.drop(beforeLate.size))
        assertEquals("旧网只被 leave 过一次（接管那一次）", 1, native.calls.count { it == "leave(${hexId(netB)})" })
    }

    // ── 5. -2 如实报错、不重试、也不假装「又回到未启动」 ──

    @Test
    fun `a native -2 is reported with its stage and is not retried`() {
        val native = FakeZtNative().apply { pretendAlreadyRunning() }
        val owner = ZtNode(native)
        val zt = manager(native, owner)

        val failure = assertThrows(ZtException::class.java) { runBlocking { zt.start(hexId(netA)) } }
        assertTrue(failure.message!!, failure.message!!.contains(ZtStage.INIT_IDENTITY.label))
        assertTrue(failure.message!!, failure.message!!.contains("ZTS_ERR_SERVICE"))
        assertTrue("要给出可恢复提示", failure.message!!.contains("重启应用进程"))
        assertEquals(ZtNode.Phase.BROKEN, owner.phase())
        assertEquals(listOf("init(-2)"), native.calls)

        // 再点一次：不重发 native 调用（不轰炸 -2），仍然如实说同一个原因
        val again = assertThrows(ZtException::class.java) { runBlocking { zt.start(hexId(netA)) } }
        assertTrue(again.message!!.contains("ZTS_ERR_SERVICE"))
        assertEquals(listOf("init(-2)"), native.calls)
        assertEquals(ZtNode.Phase.BROKEN, owner.phase())
    }

    // ── 6. 取消（Activity 关闭）不清 owner、也不 leave ──

    @Test
    fun `cancelling an in-flight start leaves the owner state alone`() {
        val native = FakeZtNative().apply { online = false }
        val owner = ZtNode(native)
        val zt = manager(native, owner, timeoutMs = 60_000)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        val job = scope.launch { zt.start(hexId(netA)) }
        waitUntil { native.running }
        runBlocking { job.cancelAndJoin() }

        assertEquals(ZtNode.Phase.STARTED, owner.phase())
        assertEquals(listOf("init", "start"), native.calls) // 不 leave、不 stop、不「清成未启动」
        assertTrue(owner.describe().contains("owner=STARTED"))
    }

    // ── 7. 反证：旧实现的形状（每次连接 new 一个 wrapper 再 init）真的会拿到 -2 ──

    @Test
    fun `the previous shape really produced -2 - a fresh wrapper per attempt`() {
        val native = FakeZtNative()

        // 旧实现：start() 每次 new ZeroTierNode() 再 initFromStorage（wrapper 不代表新的 native 实例）
        assertEquals(ZtsErr.OK, native.initFromStorage("/data/user/0/dev.sopho.pi/files/zerotier"))
        assertEquals(ZtsErr.OK, native.start())

        // 连接失败/超时后旧代码只把 runningZtKey 清成 null，**不** stop 节点（native 仍在跑）
        // 重试 ⇒ 又一个 wrapper 去 init ⇒ 用户看到的那条 -2
        assertEquals(
            ZtsErr.SERVICE,
            native.initFromStorage("/data/user/0/dev.sopho.pi/files/zerotier"),
        )
        assertEquals(listOf("init", "start", "init(-2)"), native.calls)

        // 同一处换成 owner：只 init 一次、只 start 一次，重试不发 init
        val fixed = FakeZtNative().apply { online = true }
        val owner = ZtNode(fixed)
        runBlocking {
            manager(fixed, owner).start(hexId(netA))
            manager(fixed, owner).start(hexId(netA))
        }
        assertEquals(listOf("init", "start", "join(${hexId(netA)})"), fixed.calls)
    }

    private fun hexId(id: Long): String = java.lang.Long.toHexString(id).padStart(16, '0')

    private fun waitUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 2_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(2)
        }
        throw AssertionError("等到超时：条件一直不成立")
    }
}
