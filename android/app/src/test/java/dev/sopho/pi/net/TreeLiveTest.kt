package dev.sopho.pi.net

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 前台树订阅（`/api/tree/events` ⇒ 合并后的 `GET /api/tree`）的状态机。
 *
 * 用的是**本机裸 HTTP 假服务端**（与 `SessionStreamTest` 同一套摆法）：它只证明客户端的订阅/合并/归属
 * 判定，**不**证明 libzt 的 native close 能打断阻塞读（那一格没有真机证据，代码里也不这么写）。
 *
 * 每条用例都**先等到 `OPEN` 再把帧推出去**（假服务端是写完响应头才把 socket 放进可写集合的），
 * 并且用**可观察的结果**（重拉次数 / 上屏的行 / 最大并发）来同步，不靠 `delay` 猜时序：
 * 否则“事件没送到”和“事件没触发刷新”会分不清，用例就靠别处的顺手刷新碰绿了。
 */
class TreeLiveTest {

    /** 只发 `text/event-stream` 的假服务端；帧由测试显式推，`id:`/心跳都不发（客户端不该依赖它们）。 */
    private class SseServer : AutoCloseable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val running = AtomicBoolean(true)
        private val open = CopyOnWriteArrayList<Socket>()
        private val closed = AtomicInteger(0)
        private val frames = AtomicInteger(0)

        /** 已接受的连接数（含被服务端主动收掉的）。 */
        val accepted = AtomicInteger(0)

        /** 第一条连接写完响应头就收流（一帧都不发），用来验“重连后对账只能靠状态”。 */
        @Volatile var closeFirstConnection = false

        val port: Int get() = server.localPort

        private val acceptor = thread(isDaemon = true) {
            while (running.get()) {
                val socket = try {
                    server.accept()
                } catch (error: IOException) {
                    break
                }
                val index = accepted.incrementAndGet()
                thread(isDaemon = true) {
                    var registered = false
                    try {
                        readRequest(socket)
                        val out = socket.getOutputStream()
                        out.write(
                            (
                                "HTTP/1.1 200 OK\r\n" +
                                    "Content-Type: text/event-stream; charset=utf-8\r\n" +
                                    "Cache-Control: no-cache\r\n" +
                                    "\r\n" +
                                    "retry: 1000\n\n"
                                ).toByteArray(),
                        )
                        out.flush()
                        if (closeFirstConnection && index == 1) {
                            socket.close()
                            return@thread
                        }
                        open += socket
                        registered = true
                        // 盯住这条连接什么时候被客户端关掉/断掉：用来量“旧流真的停了”，
                        // 而不是“它还在但结果被丢了”。
                        val input = socket.getInputStream()
                        val buffer = ByteArray(256)
                        while (input.read(buffer) >= 0) Unit
                    } catch (_: IOException) {
                        // 对端关闭/重置：落到 finally 里记账。
                    } finally {
                        if (registered) {
                            open -= socket
                            closed.incrementAndGet()
                        }
                        runCatching { socket.close() }
                    }
                }
            }
        }

        private fun readRequest(socket: Socket) {
            val input = socket.getInputStream()
            val text = StringBuilder()
            val one = ByteArray(1)
            while (!text.contains("\r\n\r\n")) {
                val n = input.read(one)
                if (n < 0) break
                text.append(one[0].toInt().toChar())
            }
        }

        fun send(event: String, data: String) {
            val bytes = "event: $event\ndata: $data\n\n".toByteArray()
            for (socket in open) {
                runCatching {
                    val out = socket.getOutputStream()
                    out.write(bytes)
                    out.flush()
                }
            }
            frames.incrementAndGet()
        }

        /** 已经推出去的帧数（用来证明“补发的那一发看见了全部事件”）。 */
        fun framesSent(): Int = frames.get()

        /** 仍然开着的连接数（客户端一取消就应当掉到 0/1）。 */
        fun openCount(): Int = open.size

        /** 已经被对端关掉的连接数（用来证“旧流真的停了”）。 */
        fun closedCount(): Int = closed.get()

        override fun close() {
            running.set(false)
            runCatching { server.close() }
            for (socket in open) runCatching { socket.close() }
            open.clear()
        }
    }

    private fun client(): OkHttpClient = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private fun row(id: String): SessionRow = SessionRow(
        id = id,
        name = id,
        status = "idle",
        statusLabel = "闲置",
        archived = false,
        cwd = "/tmp/$id",
        parentId = null,
        modifiedAt = null,
    )

    private fun sessionFrame(reason: String): Pair<String, String> =
        "tree.session" to "{\"type\":\"tree.session\",\"sessionId\":\"a\",\"reason\":\"$reason\"}"

    private suspend fun waitUntil(what: String, condition: suspend () -> Boolean) {
        val deadline = System.currentTimeMillis() + 8_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            delay(20)
        }
        throw AssertionError("等到超时：$what")
    }

    // ───────────────────────────── ① 事件 ⇒ 权威重拉 ─────────────────────────────

    @Test
    fun `tree frames trigger an authoritative refetch and non-tree frames do not`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val applied = CopyOnWriteArrayList<String>()
        val states = CopyOnWriteArrayList<StreamState>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = { listOf(row("s${fetches.incrementAndGet()}")) },
            onResult = { _, result, _ -> applied += (result as TreeFetch.Loaded).rows.first().id },
            onState = { _, state, _ -> states += state },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("连上") { states.contains(StreamState.OPEN) }
            waitUntil("起订那一发上屏") { applied.isNotEmpty() }
            // **基线必须可观察地停稳**：连续两次采样相同、且上屏的那份就是最后一发的结果。
            // 少了这一步，连上那发 / 首帧快照如果还没 settle，`before` 就会把它们一起算进去，
            // “事件没触发刷新”也能碰绿（这是上一版被驳的那格）。
            waitUntil("重拉停稳（两次采样一致且已上屏）") {
                val sample = fetches.get()
                delay(200)
                fetches.get() == sample && applied.last() == "s$sample"
            }
            val before = fetches.get()

            server.send("session.delta", "{\"type\":\"session.delta\"}")
            delay(300)
            assertEquals("非树帧不是刷新信号（不猜）", before, fetches.get())

            // 一帧 ⇒ 正好一发；上屏的必须是**这一发**拉回的那份。
            val one = sessionFrame("created")
            server.send(one.first, one.second)
            waitUntil("tree.session 一帧 ⇒ 补一发") { fetches.get() == before + 1 }
            waitUntil("这一发的结果上屏") { applied.last() == "s${before + 1}" }
            delay(400)
            assertEquals("一帧只许补一发（没被别的东西放大）", before + 1, fetches.get())

            server.send(TreeEvents.SNAPSHOT, "{\"type\":\"tree.snapshot\",\"sessions\":[]}")
            waitUntil("tree.snapshot 也是树帧") { fetches.get() == before + 2 }
            waitUntil("快照帧的结果也上屏") { applied.last() == "s${before + 2}" }
            delay(400)
            assertEquals("快照帧也只补一发", before + 2, fetches.get())
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ─────────────────────── ② 合并：并发 ≤1，且不丢最终状态 ───────────────────────

    /**
     * 这一条**只**用事件来驱动“补发”：在飞的那一发是**由一帧事件**起的，
     * `start()` 的对账与“首次连上”的对账都在它之前已经落定（等到它们上屏才继续）。
     * 所以把“帧 ⇒ 置 dirty”那根线拆掉，这条必红 —— 它不靠连上时那次顺手刷新碰绿。
     */
    @Test
    fun `a burst of events never runs two tree GETs at once and the last state is still applied`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val concurrent = AtomicInteger(0)
        val maxConcurrent = AtomicInteger(0)
        val framesAtFetch = CopyOnWriteArrayList<Int>()
        val applied = CopyOnWriteArrayList<String>()
        val states = CopyOnWriteArrayList<StreamState>()
        val gate = AtomicBoolean(false)
        val release = CompletableDeferred<Unit>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = {
                concurrent.incrementAndGet().let { now -> maxConcurrent.accumulateAndGet(now) { a, b -> maxOf(a, b) } }
                try {
                    val n = fetches.incrementAndGet()
                    framesAtFetch += server.framesSent()
                    // 只在测试说了之后才挡住：这样“在飞的那一发”一定是事件起的那一发。
                    if (gate.get()) release.await()
                    listOf(row("s$n"))
                } finally {
                    concurrent.decrementAndGet()
                }
            },
            onResult = { _, result, _ -> applied += (result as TreeFetch.Loaded).rows.first().id },
            onState = { _, state, _ -> states += state },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("连上") { states.contains(StreamState.OPEN) }
            // 起订那一发 + 首次连上那一发都落定（上屏），后面的事件才不会被它们“顺带”合并掉。
            waitUntil("起订/连上两发都上屏") { fetches.get() >= 2 && applied.size >= 2 }
            delay(200) // 让“连上那一发”的收尾跑完（它可能还会再拉一次），再开始只靠事件
            val settled = fetches.get()

            gate.set(true)
            val first = sessionFrame("e0")
            server.send(first.first, first.second)
            waitUntil("事件起的这一发在飞（被挡住）") { fetches.get() == settled + 1 }
            repeat(4) { index ->
                val frame = sessionFrame("e${index + 1}")
                server.send(frame.first, frame.second)
            }
            delay(300)
            assertEquals("在飞期间只攒一次 dirty，不许并发第二发", settled + 1, fetches.get())
            assertEquals("同一时刻最多一发在飞", 1, maxConcurrent.get())

            release.complete(Unit)
            waitUntil("补发了第二发") { fetches.get() >= settled + 2 }
            delay(300)

            assertEquals("5 个事件合并成一次补发（不是 6 发）", settled + 2, fetches.get())
            assertEquals("始终没有并发", 1, maxConcurrent.get())
            assertEquals("补发那一发必须看见全部 5 个事件（不丢最终状态）", 5, framesAtFetch.last())
            assertEquals("最后的结果必须上屏", "s${settled + 2}", applied.last())
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ───────────────────────── ③ 重连必须重新对账 ─────────────────────────

    @Test
    fun `a reconnect re-fetches the tree because the server does not replay events`() = runBlocking {
        val server = SseServer()
        server.closeFirstConnection = true
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val states = CopyOnWriteArrayList<StreamState>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = { listOf(row("s${fetches.incrementAndGet()}")) },
            onResult = { _, _, _ -> },
            onState = { _, state, _ -> states += state },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("第一次连上（服务端马上收流）") { server.accepted.get() >= 1 }
            waitUntil("第一次 OPEN") { states.contains(StreamState.OPEN) }
            delay(300) // 让「起订那一发 + 首次连上那一发」都落定，后面只看重连有没有再拉
            val afterFirstOpen = fetches.get()
            waitUntil("退避后重连，并且**重连后重新对账**") {
                states.contains(StreamState.OPEN_AFTER_RECONNECT) && fetches.get() > afterFirstOpen
            }
            assertTrue("重连是真的新建了连接", server.accepted.get() >= 2)
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ─────────────────── ④ stop：在飞结果丢弃、不再拉、不再连 ───────────────────

    @Test
    fun `stop while a refetch is in flight drops that late result and stops everything`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val applied = CopyOnWriteArrayList<String>()
        val states = CopyOnWriteArrayList<StreamState>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = {
                fetches.incrementAndGet()
                // 模拟“阻塞读已经开始、取消打不断”的那一格：结果照常回来，但归属已经不是它的了。
                withContext(NonCancellable) { Thread.sleep(400) }
                listOf(row("late"))
            },
            onResult = { _, result, _ -> applied += (result as TreeFetch.Loaded).rows.first().id },
            onState = { _, state, _ -> states += state },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("第一发在飞") { fetches.get() == 1 }
            delay(100) // 让它真进到阻塞那一段里
            live.stop()
            // 停掉之后**一个回调都不许再来**（状态与结果同一条门）：只要 helper 不发，
            // AppState 那条主线程队列里就不会有“旧归属待执行”的条目。
            val statesAtStop = states.size
            val acceptedAtStop = server.accepted.get()
            delay(900)

            assertEquals("停掉之后旧的迟到结果一个都不许上屏", 0, applied.size)
            assertEquals("停掉之后不许再有状态回调", statesAtStop, states.size)
            assertEquals("停掉之后不许再发起重拉", 1, fetches.get())
            assertEquals("停掉之后不许再新建连接", acceptedAtStop, server.accepted.get())
            assertFalse("没订阅时 requestRefresh 只回 false（不亮永远转的进度）", live.requestRefresh(explicit = true))
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ─────────────── ⑤ 重新 start：旧归属的迟到结果不得污染新归属 ───────────────

    @Test
    fun `a restart after stop only accepts the new generation's results and states`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val applied = CopyOnWriteArrayList<Pair<Long, String>>()
        val states = CopyOnWriteArrayList<Pair<Long, StreamState>>()
        val release = CompletableDeferred<Unit>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = {
                val n = fetches.incrementAndGet()
                if (n == 1) withContext(NonCancellable) { release.await() }
                listOf(row("s$n"))
            },
            onResult = { generation, result, _ ->
                applied += generation to (result as TreeFetch.Loaded).rows.first().id
            },
            // 状态回调**也**带 generation：只给结果带归属是上一版的缺口。
            onState = { generation, state, _ -> states += generation to state },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("第一发在飞") { fetches.get() == 1 }
            // 后台/换配置：停掉，再回前台/连上新端点 ⇒ 新归属
            live.stop()
            // 停之前已经收到的回调（旧归属的 CONNECTING）是合法的；从这里往后的每一条都必须属于新归属。
            val statesAtRestart = states.size
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("新归属自己拉了一发") { fetches.get() >= 2 }
            waitUntil("新归属的结果上屏") { applied.isNotEmpty() }
            waitUntil("新归属的状态回调也到了") { states.isNotEmpty() }

            release.complete(Unit) // 旧那一发此刻才回来
            delay(400)

            val current = live.generation()
            assertTrue("旧归属的迟到结果不许上屏：$applied", applied.none { it.second == "s1" })
            assertTrue("新归属的结果必须在：$applied", applied.any { it.second == "s2" })
            assertTrue(
                "上屏的结果全部属于当前归属：$applied",
                applied.all { it.first == current },
            )
            assertTrue(
                "重起之后的状态回调不许带旧归属号：${states.drop(statesAtRestart)}",
                states.drop(statesAtRestart).all { it.first == current },
            )
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ─────── ⑥ 旧归属的收尾不许把新归属的「在飞」标记清掉（否则会并发出两发） ───────

    /**
     * 这是实现里最腕的一格：旧归属的循环退出时，它的 `finally` 可能跑在**新**归属的循环已经跑之后。
     * 若「在飞」用一个裸 boolean（而不是绑 generation），旧收尾会把新归属的标记清零 ⇒ 下一发请求
     * 就能再起一条并发 GET，合并器当场失效（测试 ② 那套“同时最多一发”的保护就假了）。
     *
     * 造法：第一发用 `NonCancellable` 拖住（模拟“取消打不断的阻塞读”），`stop()` → `start()` 后
     * 新的那一发也在飞，再**放掉旧的那一发**（它的 `finally` 此刻才跑），然后请求一次刷新：
     * 标记若被清掉，这里就会出现两发并发。
     */
    @Test
    fun `a stale worker finishing must not clear the new owner's in-flight marker`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val concurrent = AtomicInteger(0)
        val applied = CopyOnWriteArrayList<String>()
        val releaseOld = CompletableDeferred<Unit>()
        val releaseNew = CompletableDeferred<Unit>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = {
                concurrent.incrementAndGet()
                try {
                    val n = fetches.incrementAndGet()
                    when (n) {
                        1 -> withContext(NonCancellable) { releaseOld.await() }
                        2 -> withContext(NonCancellable) { releaseNew.await() }
                    }
                    listOf(row("s$n"))
                } finally {
                    concurrent.decrementAndGet()
                }
            },
            onResult = { _, result, _ -> applied += (result as TreeFetch.Loaded).rows.first().id },
            onState = { _, _, _ -> },
        )
        try {
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("旧归属那一发在飞") { fetches.get() == 1 }
            live.stop()
            live.start("http://127.0.0.1:${server.port}")
            waitUntil("新归属那一发在飞") { fetches.get() == 2 }

            releaseOld.complete(Unit) // 旧那一发此刻才回来；它的收尾也是此刻才跑
            // 等到旧那一发**确定已经不在**（只剩新归属那一发在飞）：在这之前它们是重叠的
            // ——那属于“取消打不断的阻塞读”，不归合并器管，也不在本条用例的断言范围内。
            waitUntil("旧那一发已经退出") { concurrent.get() == 1 }
            delay(300) // 让旧循环的 finally 确定跑完

            assertTrue("新归属于当前归属，请求必须接住", live.requestRefresh())
            delay(400)

            assertEquals("旧收尾不许让新归属再起一发（在飞那发还在）", 2, fetches.get())
            assertEquals("仍然只有那一发在飞", 1, concurrent.get())
            assertTrue("旧归属的结果不许上屏：$applied", applied.isEmpty())

            releaseNew.complete(Unit)
            waitUntil("在飞那一发回来后补发一次") { fetches.get() == 3 }
            waitUntil("新归属的结果上屏") { applied.isNotEmpty() }
            assertEquals("s3", applied.last())
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ───── ↻ 同一个订阅对象重复 start：只留一条拥有者，且旧流真的停掉 ─────

    /**
     * “回前台 / 重起”会反复调 `start(base)`。若实现是「只递增归属号、再新建一个订阅对象」，
     * 旧对象的 SSE 与合并器**仍活着**、只是结果被丢 —— 它会继续拉 `/tree`，且引用已丢、取消不了。
     * 所以唯一拥有者必须是**同一个订阅对象**：重复 `start` ⇒ 旧流被 cancel（服务器侧看到 EOF）、
     * 只留一条活流、一帧仍然只补一发。
     */
    @Test
    fun `restarting the same subscription leaves exactly one owner and the old stream stops`() = runBlocking {
        val server = SseServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val fetches = AtomicInteger(0)
        val applied = CopyOnWriteArrayList<String>()
        val states = CopyOnWriteArrayList<StreamState>()
        val live = TreeLive(
            scope = scope,
            client = client(),
            fetch = { listOf(row("s${fetches.incrementAndGet()}")) },
            onResult = { _, result, _ -> applied += (result as TreeFetch.Loaded).rows.first().id },
            onState = { _, state, _ -> states += state },
        )
        val base = "http://127.0.0.1:${server.port}"
        try {
            live.start(base)
            waitUntil("第一条流连上") { states.contains(StreamState.OPEN) && server.openCount() == 1 }
            waitUntil("起订那一发上屏") { applied.isNotEmpty() }

            live.start(base) // 回前台 / 重起：同一实例
            waitUntil("旧流被关掉（服务端侧看到 EOF）") { server.closedCount() >= 1 }
            waitUntil("只剩一条活着的流") { server.openCount() == 1 }
            waitUntil("重起后的那一发上屏") { applied.size >= 2 }
            assertEquals("两次 start 只能建两条流（旧的真停，不是又开一条）", 2, server.accepted.get())

            val before = fetches.get()
            val frame = sessionFrame("one-owner")
            server.send(frame.first, frame.second)
            waitUntil("一帧 ⇒ 正好补一发") { fetches.get() == before + 1 }
            delay(400)
            assertEquals("一帧只补一发（旧归属不会再拉一份）", before + 1, fetches.get())
            assertEquals("始终只有一条活着的流", 1, server.openCount())
        } finally {
            live.stop()
            scope.cancel()
            server.close()
        }
    }

    // ───────────────────────────── ⑧ 状态文字与帧名 ─────────────────────────────

    @Test
    fun `the list status line follows the facts and never claims a release`() {
        assertTrue(treeStatusText(StreamState.OPEN, null).contains("已连接"))
        assertTrue(treeStatusText(StreamState.OPEN_AFTER_RECONNECT, null).contains("已重连"))
        val failed = treeStatusText(StreamState.FAILED, "第 1 次失败（已等 20ms）：HTTP 503；1.0s 后重试")
        assertTrue(failed, failed.contains("未连接"))
        assertTrue(failed, failed.contains("后重试"))
        for (state in StreamState.values()) {
            assertFalse(
                "不许把已取消写成已释放（取消是协作式的，native fd 没有证据）",
                treeStatusText(state, "x").contains("已释放"),
            )
        }
        assertTrue(TreeEvents.isTreeFrame(TreeEvents.SNAPSHOT))
        assertTrue(TreeEvents.isTreeFrame(TreeEvents.SESSION))
        assertFalse(TreeEvents.isTreeFrame("session.delta"))
        assertFalse(TreeEvents.isTreeFrame(""))
    }
}
