package dev.sopho.pi.zt

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这几条 bug 的 JVM 证据（不加载 libzt.so、不 join 任何网络、不碰 identity）：
 * 1. 旧包装形状（AAR 的 `ZeroTierSocket`）在 connect 失败后会泄漏 fd；低层 attempt 失败必须 close 恰好一次；
 * 2. AAR 的 `setSoTimeout(ms)` 把 ms 当秒+微秒；这里换算必须是 (ms/1000, (ms%1000)*1000)；
 * 3. AAR 的输出流一次写会丢掉部分写，且它的 `write_offset` 在 offset>0 时把元素指针当 jarray；
 *    这里必须循环写、且每次给 native 的都是 offset=0 的整块；
 * 4. 取消**不能**跨线程 close 正在被阻塞 read/connect 使用的 fd；必须等阻塞调用返回后由调用线程 close 一次。
 *
 * ⚠️ 它**不**证明真实 native 的 close 能打断 lwIP 阻塞（那一格没有真机/真网证据）。
 */
class LibztSocketsTest {

    private open class FakeSys(
        var openRc: Int = 7,
        var connectRc: Int = 0,
        var openError: Throwable? = null,
        var connectError: Throwable? = null,
        var readRc: Int = 0,
        var writeChunks: MutableList<Int> = mutableListOf(),
    ) : LibztSys {
        val openedFamilies = mutableListOf<Int>()
        val connectCalls = mutableListOf<Triple<Int, String, Int>>()
        val connectTimeouts = mutableListOf<Int>()
        val closedFds = mutableListOf<Int>()
        val recvTimeouts = mutableListOf<Pair<Int, Int>>()
        val reads = mutableListOf<Triple<Int, Int, Int>>()
        val writeSizes = mutableListOf<Pair<Int, Int>>()
        val shutdowns = mutableListOf<Pair<Int, Int>>()

        override fun openStream(family: Int): Int {
            openedFamilies += family
            openError?.let { throw it }
            return openRc
        }

        override fun connect(fd: Int, host: String, port: Int, timeoutMs: Int): Int {
            connectCalls += Triple(fd, host, port)
            connectTimeouts += timeoutMs
            connectError?.let { throw it }
            return connectRc
        }

        override fun close(fd: Int) {
            closedFds += fd
        }

        override fun setReadTimeout(fd: Int, seconds: Int, micros: Int): Int {
            recvTimeouts += seconds to micros
            return 0
        }

        override fun read(fd: Int, buffer: ByteArray, offset: Int, length: Int): Int {
            reads += Triple(fd, offset, length)
            return readRc
        }

        override fun write(fd: Int, buffer: ByteArray, length: Int): Int {
            writeSizes += fd to length
            return writeChunks.removeFirstOrNull() ?: length
        }

        override fun shutdown(fd: Int, how: Int) {
            shutdowns += fd to how
        }
    }

    private fun connected(sys: FakeSys): LibztConnection =
        LibztSockets.beginWith(sys, "127.0.0.1", 1234, 8_000).connect()

    // ── 1. fd 泄漏与 close 恰好一次 ──

    @Test
    fun `the old AAR wrapper shape leaks the fd on a failed connect`() {
        val sys = FakeSys(connectRc = ZtsErr.SERVICE)
        // 旧形状：openStream 之后直接 connect，失败时没有任何 close（AAR 构造器就是这样抛的）。
        val fd = sys.openStream(LibztSockets.FAMILY_INET)
        assertEquals(ZtsErr.SERVICE, sys.connect(fd, "127.0.0.1", 1234, 0))
        assertEquals("旧形状不 close，才需要这一笔修复", emptyList<Int>(), sys.closedFds)
    }

    @Test
    fun `a failed low-level connect closes exactly once and reports rc and timeout`() {
        val sys = FakeSys(connectRc = ZtsErr.SERVICE)
        val error = assertThrows(IOException::class.java) { connected(sys) }
        assertEquals(listOf(7), sys.closedFds)
        assertTrue(error.message!!, error.message!!.contains("rc=-2"))
        assertTrue(error.message!!, error.message!!.contains("timeout=8000ms"))
    }

    @Test
    fun `an exception from native connect still closes the fd exactly once`() {
        val sys = FakeSys(connectError = IllegalStateException("boom"))
        assertThrows(IllegalStateException::class.java) { connected(sys) }
        assertEquals(listOf(7), sys.closedFds)
    }

    @Test
    fun `a socket-open failure has no fd to close`() {
        val sys = FakeSys(openRc = ZtsErr.SERVICE)
        val error = assertThrows(IOException::class.java) { connected(sys) }
        assertTrue(error.message!!, error.message!!.contains("rc=-2"))
        assertEquals(emptyList<Int>(), sys.closedFds)
    }

    @Test
    fun `a successful connect hands the fd over and close is idempotent`() {
        val sys = FakeSys()
        val connection = connected(sys)
        assertEquals(emptyList<Int>(), sys.closedFds)
        connection.closeWith(sys)
        connection.closeWith(sys)
        assertEquals("流/代理共享同一个 fd，只许 close 一次", listOf(7), sys.closedFds)
    }

    @Test
    fun `cancel during a blocked connect does not close the in-flight fd from another thread`() {
        val sys = object : FakeSys() {
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            override fun connect(fd: Int, host: String, port: Int, timeoutMs: Int): Int {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
                return ZtsErr.OK
            }
        }
        val attempt = LibztSockets.beginWith(sys, "127.0.0.1", 1234, 8_000)
        val failure = arrayOfNulls<Throwable>(1)
        val worker = Thread { failure[0] = runCatching { attempt.connect() }.exceptionOrNull() }.apply { start() }

        assertTrue(sys.entered.await(2, TimeUnit.SECONDS))
        attempt.cancel()
        assertEquals("取消线程不许 close 正在被 zts_connect 使用的 fd", emptyList<Int>(), sys.closedFds)

        sys.release.countDown()
        worker.join(2_000)
        assertTrue("取消后 connect 必须失败", failure[0] is IOException)
        assertEquals("native 返回后由 connect 线程 close 一次", listOf(7), sys.closedFds)
    }

    @Test
    fun `a deferred close waits for a blocked read to return before closing the fd`() {
        val sys = object : FakeSys() {
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            override fun read(fd: Int, buffer: ByteArray, offset: Int, length: Int): Int {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
                return 0
            }
        }
        val connection = connected(sys)
        val reader = Thread {
            runCatching { connection.input.read(ByteArray(4), 0, 4) }
        }.apply { start() }

        assertTrue(sys.entered.await(2, TimeUnit.SECONDS))
        connection.requestCloseWith(sys)
        assertEquals("read 还阻塞着时不许跨线程 close fd", emptyList<Int>(), sys.closedFds)
        assertTrue(connection.isClosed()) // 逻辑上已关闭，拒绝新调用

        sys.release.countDown()
        reader.join(2_000)
        assertEquals("read 返回后由 read 线程 close 一次", listOf(7), sys.closedFds)
        assertThrows(IOException::class.java) { connection.input.read(ByteArray(1), 0, 1) }
    }

    // ── 2. connect 超时与单位换算 ──

    @Test
    fun `the OkHttp connect timeout is passed to zts_connect instead of becoming the native 30 s default`() {
        val sys = FakeSys()
        connected(sys).closeWith(sys)
        assertEquals(listOf(8_000), sys.connectTimeouts)
        assertFalse("不能还是 native 的 30 s 默认", sys.connectTimeouts.single() == 30_000)
    }

    @Test
    fun `a missing connect timeout gets a bounded default and a huge one is capped`() {
        val zero = FakeSys()
        LibztSockets.beginWith(zero, "127.0.0.1", 1234, 0).connect().closeWith(zero)
        assertEquals(LibztSockets.DEFAULT_CONNECT_TIMEOUT_MS, zero.connectTimeouts.single())

        val huge = FakeSys()
        LibztSockets.beginWith(huge, "127.0.0.1", 1234, 60_000).connect().closeWith(huge)
        assertEquals(LibztSockets.MAX_CONNECT_TIMEOUT_MS, huge.connectTimeouts.single())
    }

    @Test
    fun `read timeouts are converted to seconds plus microseconds - not ms twice`() {
        assertEquals(25 to 0, LibztSockets.readTimeoutParts(25_000))
        assertEquals(40 to 0, LibztSockets.readTimeoutParts(40_000))
        assertEquals(1 to 500_000, LibztSockets.readTimeoutParts(1_500))
        assertEquals(0 to 999_000, LibztSockets.readTimeoutParts(999))
        assertEquals("AAR 的旧形状是 (ms, ms)", false, LibztSockets.readTimeoutParts(25_000) == (25_000 to 25_000))
    }

    @Test
    fun `setReadTimeout uses the converted parts and getSoTimeout stays symmetric`() {
        val sys = FakeSys()
        val connection = connected(sys)
        connection.setReadTimeoutWith(sys, 25_000)
        assertEquals(25_000, connection.readTimeoutMs)
        assertEquals(listOf(25 to 0), sys.recvTimeouts)
        connection.closeWith(sys)
    }

    // ── 3. 流语义：EOF/closed/部分写 ──

    @Test
    fun `read maps 0 and ECONNRESET to EOF and other negatives to IOException`() {
        val sys = FakeSys(readRc = 0)
        val connection = connected(sys)
        assertEquals(-1, connection.input.read(ByteArray(4), 0, 4))

        sys.readRc = -104
        assertEquals(-1, connection.input.read(ByteArray(4), 0, 4))

        sys.readRc = -11
        val error = assertThrows(IOException::class.java) { connection.input.read(ByteArray(4), 0, 4) }
        assertTrue(error.message!!, error.message!!.contains("-11"))
        connection.closeWith(sys)
    }

    @Test
    fun `stream close only shuts down and never closes the shared fd`() {
        val sys = FakeSys()
        val connection = connected(sys)
        connection.shutdownInput()
        connection.shutdownOutput()
        assertEquals(listOf(7 to 0, 7 to 1), sys.shutdowns)
        assertEquals("shutdown 不是 close fd", emptyList<Int>(), sys.closedFds)

        connection.closeWith(sys)
        assertEquals(listOf(7), sys.closedFds)
    }

    @Test
    fun `a closed stream refuses reads`() {
        val sys = FakeSys()
        val connection = connected(sys)
        connection.input.close()
        assertThrows(IOException::class.java) { connection.input.read(ByteArray(1), 0, 1) }
        connection.closeWith(sys)
    }

    @Test
    fun `write loops until every byte is accepted - the old one-shot shape dropped the tail`() {
        val sys = FakeSys(writeChunks = mutableListOf(3, 2))
        val connection = connected(sys)
        connection.output.write(ByteArray(5) { it.toByte() }, 0, 5)
        assertEquals(
            "必须两次写，且每次给 native 的都是 offset=0 的整块：第一次 5 字节、第二次 2 字节",
            listOf(7 to 5, 7 to 2),
            sys.writeSizes,
        )
        connection.closeWith(sys)
    }

    @Test
    fun `a zero-byte write result is an error instead of a spin`() {
        val sys = FakeSys(writeChunks = mutableListOf(0))
        val connection = connected(sys)
        val error = assertThrows(IOException::class.java) { connection.output.write(ByteArray(5), 0, 5) }
        assertTrue(error.message!!, error.message!!.contains("返回 0"))
        connection.closeWith(sys)
    }

    // ── 4. 代理本身：未连接/关闭/超时对称（不触发 native） ──

    @Test
    fun `the proxy rejects io before connect and keeps soTimeout symmetric`() {
        val proxy = ZeroTierSocketsSocketFactory.Proxy("127.0.0.1", 1234)
        assertThrows(IOException::class.java) { proxy.inputStream }
        assertThrows(IOException::class.java) { proxy.outputStream }
        proxy.soTimeout = 25_000
        assertEquals(25_000, proxy.soTimeout)
        assertThrows(IllegalArgumentException::class.java) { proxy.soTimeout = -1 }
        proxy.close()
        proxy.close() // 幂等；没有 fd 也不许抛
        assertTrue(proxy.isClosed)
        assertFalse(proxy.isConnected)
    }
}
