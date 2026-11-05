package dev.sopho.pi.zt

import com.zerotier.sockets.ZeroTierNative
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * libzt 的**低层 socket 适配**（给 OkHttp 用）。
 *
 * 为什么不用 AAR 的 `ZeroTierSocket(String, int)` / `connect(...)`：这两个入口都会把
 * `timeout_ms = 0` 传给 `zts_connect`（固定 AAR 的字节码是 `iconst_0`），而 C 侧对 0 的解释是
 * **30 000 ms**（`src/Sockets.cpp:401-410`），OkHttp 传进来的 connectTimeout 完全没进 native。
 * 更糟的是失败时 `ZeroTierSocket` 的构造器已经 `zts_bsd_socket` 拿到 fd，却直接抛异常、**不 close**
 * （字节码：`_zfd` 在 135 落字段，`zts_connect` 在 152，失败跳 162-194 抛 IOException，没有 close）
 * ⇒ 每次失败连接泄漏一个 libzt socket；SSE 每秒重试一次，很快就会越试越差。
 *
 * 还不用 `ZeroTierSocket.setSoTimeout(int)`：它把同一个 `ms` 同时当**秒**和**微秒**传给
 * `zts_set_recv_timeout(fd, seconds, microseconds)`（字节码 `iload_1; iload_1; invokestatic`），
 * C 侧原样 `tv_sec = seconds; tv_usec = microseconds`（`src/Sockets.cpp:750-762`）。
 * OkHttp 的 25 s / 40 s 于是变成原生 25 000 s / 40 000 s —— 读超时事实上不生效。
 * 这里按 `(ms / 1000, (ms % 1000) * 1000)` 传，才是真正的读超时。
 *
 * 也**不用** `zts_bsd_write_offset`：固定 AAR 的 JNI 壳把 `&(buf[offset])`（数组元素指针）
 * 传给 `GetPrimitiveArrayCritical`（`src/bindings/java/JavaSockets.cxx:306-318`；x86_64
 * `libzt.so` 反汇编也显示 `rsi = rcx + r8d`），这不是合法 jarray，offset>0 时是未定义行为。
 * 这里改用 `zts_bsd_write`（JNI 壳正确传 `buf`），部分写时复制剩余字节、offset 恒为 0。
 *
 * 取消语义（重要）：`zts_connect` / `zts_bsd_read` / `zts_bsd_write` 在 libzt 里是**阻塞调用**，
 * 且 JNI 壳用 `GetPrimitiveArrayCritical` 包住读/写（`JavaSockets.cxx:270-318`）。从另一个线程
 * close 正在使用的 fd 可能让 lwIP 在已释放的 socket 上继续跑（fd 复用/use-after-free），
 * 所以这里**不在 cancel 时跨线程 close**：
 * - connect 取消 ⇒ 只置标记；等 native connect 按自己的 timeout 返回后，由 connect 线程 close 一次；
 * - 读/写取消 ⇒ 标记“关闭请求”，等当前阻塞 read/write 返回（最多 readTimeout 25 s/40 s）后再 close。
 * 代价是取消不是即时的；UI 不得写“已经停止/已释放”。真机上也未证明 close 能打断 lwIP 阻塞。
 */
class LibztConnection internal constructor(
    private val sys: LibztSys,
    val host: String,
    val port: Int,
    val fd: Int,
) {
    private val closed = AtomicBoolean(false)
    private val closeRequested = AtomicBoolean(false)
    private val activeBlockingCalls = AtomicInteger(0)

    val input: InputStream = LibztInputStream(sys, fd, this)
    val output: OutputStream = LibztOutputStream(sys, fd, this)

    @Volatile private var inputShutdown = false
    @Volatile private var outputShutdown = false

    /** 当前 native 上的读超时（`getSoTimeout` 与它对称；0 = 没设）。 */
    @Volatile var readTimeoutMs: Int = 0
        private set

    /** 用**正确单位**设置 SO_RCVTIMEO（见类注释里的 AAR 单位 bug）。 */
    @Throws(java.net.SocketException::class)
    fun setReadTimeout(timeoutMs: Int) = setReadTimeoutWith(sys, timeoutMs)

    @Throws(java.net.SocketException::class)
    internal fun setReadTimeoutWith(target: LibztSys, timeoutMs: Int) {
        require(timeoutMs >= 0) { "SO_TIMEOUT < 0" }
        val (seconds, micros) = LibztSockets.readTimeoutParts(timeoutMs)
        val rc = target.setReadTimeout(fd, seconds, micros)
        if (rc != ZtsErr.OK) {
            throw java.net.SocketException(
                "libzt zts_set_recv_timeout(fd=$fd, ${seconds}s ${micros}us) 返回 $rc ${ZtsErr.name(rc)}",
            )
        }
        readTimeoutMs = timeoutMs
    }

    fun shutdownInput() {
        if (closed.get() || inputShutdown) return
        inputShutdown = true
        runCatching { input.close() } // shutdown(RD)，**不是** close(fd)
    }

    fun shutdownOutput() {
        if (closed.get() || outputShutdown) return
        outputShutdown = true
        runCatching { output.close() } // shutdown(WR)，**不是** close(fd)
    }

    /** 已经真正 close(fd)（或者取消后等待阻塞调用返回中）。 */
    fun isClosed(): Boolean = closed.get() || closeRequested.get()

    fun isCloseRequested(): Boolean = closeRequested.get()

    fun isInputShutdown(): Boolean = inputShutdown

    fun isOutputShutdown(): Boolean = outputShutdown

    /** 无阻塞调用时的立即关闭（连接失败清理/测试用）；有阻塞调用时退化为请求关闭。 */
    fun close() = closeWith(sys)

    internal fun closeWith(target: LibztSys) {
        closeRequested.set(true)
        if (activeBlockingCalls.get() == 0) closeFdOnceWith(target)
    }

    /** OkHttp `Call.cancel()` 走这条：**不**跨线程 close 正在被阻塞 read/write 使用的 fd。 */
    fun requestClose() = requestCloseWith(sys)

    internal fun requestCloseWith(target: LibztSys) {
        closeRequested.set(true)
        inputShutdown = true
        outputShutdown = true
        if (activeBlockingCalls.get() == 0) closeFdOnceWith(target)
    }

    private fun closeFdOnceWith(target: LibztSys) {
        if (!closed.compareAndSet(false, true)) return
        (input as? LibztInputStream)?.markClosedByOwner()
        (output as? LibztOutputStream)?.markClosedByOwner()
        target.close(fd)
    }

    /** 阻塞调用开始前登记；已经请求关闭则拒绝新调用。 */
    internal fun enterBlocking(): Boolean {
        if (closeRequested.get()) return false
        activeBlockingCalls.incrementAndGet()
        if (closeRequested.get()) {
            exitBlocking()
            return false
        }
        return true
    }

    /** 当前是否有阻塞 read/write 在用这个 fd（流 close 时据此避免跨线程 shutdown）。 */
    internal fun hasActiveBlockingCalls(): Boolean = activeBlockingCalls.get() > 0

    /** 阻塞调用返回后登记；如果这期间有人请求关闭，就在这里（调用线程上）close 一次。 */
    internal fun exitBlocking() {
        if (activeBlockingCalls.decrementAndGet() == 0 && closeRequested.get()) {
            closeFdOnceWith(sys)
        }
    }
}

/** native 调用的最小面（JVM 单测可替换；生产实现只转 AAR）。 */
internal interface LibztSys {
    fun openStream(family: Int): Int
    fun connect(fd: Int, host: String, port: Int, timeoutMs: Int): Int
    fun close(fd: Int)
    fun setReadTimeout(fd: Int, seconds: Int, micros: Int): Int
    fun read(fd: Int, buffer: ByteArray, offset: Int, length: Int): Int

    /** 整块写（offset 恒 0）；AAR 的 `write_offset` 在 offset>0 时把元素指针当 jarray，不能用。 */
    fun write(fd: Int, buffer: ByteArray, length: Int): Int
    fun shutdown(fd: Int, how: Int)
}

internal object AarLibztSys : LibztSys {
    override fun openStream(family: Int): Int =
        ZeroTierNative.zts_bsd_socket(family, LibztSockets.SOCK_STREAM, 0)

    override fun connect(fd: Int, host: String, port: Int, timeoutMs: Int): Int =
        ZeroTierNative.zts_connect(fd, host, port, timeoutMs)

    override fun close(fd: Int) {
        ZeroTierNative.zts_bsd_close(fd)
    }

    override fun setReadTimeout(fd: Int, seconds: Int, micros: Int): Int =
        ZeroTierNative.zts_set_recv_timeout(fd, seconds, micros)

    override fun read(fd: Int, buffer: ByteArray, offset: Int, length: Int): Int =
        ZeroTierNative.zts_bsd_read_offset(fd, buffer, offset, length)

    override fun write(fd: Int, buffer: ByteArray, length: Int): Int =
        ZeroTierNative.zts_bsd_write(fd, buffer)

    override fun shutdown(fd: Int, how: Int) {
        ZeroTierNative.zts_bsd_shutdown(fd, how)
    }
}

/**
 * 输入流语义（与 AAR 保持一致，但显式写出来）：
 * - 正数 = 读到的字节数；
 * - `0` 与 `-104`（ECONNRESET）按 AAR 的既有语义当 **EOF(-1)**；
 * - 其它负数 = IOException（把 native errno 放进消息，不吞）。
 * close 只做 shutdown(RD)，**不** close fd（fd 归 [LibztConnection]）。
 */
internal class LibztInputStream(
    private val sys: LibztSys,
    private val fd: Int,
    private val owner: LibztConnection,
) : InputStream() {
    @Volatile private var closed = false

    override fun read(): Int {
        val one = ByteArray(1)
        val n = read(one, 0, 1)
        return if (n <= 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (closed) throw IOException("libzt input stream 已关闭")
        if (!owner.enterBlocking()) throw IOException("libzt input stream 正在关闭")
        return try {
            val rc = sys.read(fd, buffer, offset, length)
            when {
                rc > 0 -> rc
                rc == 0 || rc == -104 -> -1 // AAR 的既有语义：0 / -ECONNRESET 都是流结束
                else -> throw IOException("libzt read errno=$rc")
            }
        } finally {
            owner.exitBlocking()
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        // 有阻塞 read 在用同一个 fd 时，shutdown 也可能跨线程动 lwIP socket；留给 close 请求在
        // read 返回后统一处理（fd 最终由 LibztConnection close 一次）。
        if (!owner.isCloseRequested() && !owner.hasActiveBlockingCalls()) {
            runCatching { sys.shutdown(fd, SHUT_RD) }
        }
    }

    /** 连接 owner 关 fd 时同步流状态：之后再用这个流读应当报“已关闭”，而不是拿 -1 去撞 native。 */
    internal fun markClosedByOwner() {
        closed = true
    }

    private companion object {
        const val SHUT_RD = 0 // ZTS_SHUT_RD
    }
}

/**
 * 输出流语义：**循环写**，直到 `length` 个字节全部被 native 接受（AAR 的一次写会静默丢部分写）。
 * 每次传给 native 的都是 offset=0 的整块（复制剩余字节），避开 AAR `write_offset` 的 jarray bug。
 * `write` 返回 0 视为无法前进的错误；负数带 errno 抛出。close 只做 shutdown(WR)。
 */
internal class LibztOutputStream(
    private val sys: LibztSys,
    private val fd: Int,
    private val owner: LibztConnection,
) : OutputStream() {
    @Volatile private var closed = false

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        if (length == 0) return
        if (closed) throw IOException("libzt output stream 已关闭")
        var written = 0
        while (written < length) {
            if (!owner.enterBlocking()) throw IOException("libzt output stream 正在关闭")
            try {
                // offset 恒 0：AAR 的 write_offset 在 offset>0 时把元素指针当 jarray。
                val chunk = if (written == 0 && offset == 0 && length == buffer.size) {
                    buffer
                } else {
                    buffer.copyOfRange(offset + written, offset + length)
                }
                val rc = sys.write(fd, chunk, chunk.size)
                when {
                    rc > 0 && rc <= chunk.size -> written += rc
                    rc > 0 -> throw IOException("libzt write 返回的字节数超过请求：rc=$rc，剩余 ${chunk.size}")
                    rc == 0 -> throw IOException("libzt write 返回 0（无法前进）")
                    else -> throw IOException("libzt write errno=$rc")
                }
            } finally {
                owner.exitBlocking()
            }
        }
    }

    override fun flush() = Unit

    override fun close() {
        if (closed) return
        closed = true
        if (!owner.isCloseRequested() && !owner.hasActiveBlockingCalls()) {
            runCatching { sys.shutdown(fd, SHUT_WR) }
        }
    }

    /** 连接 owner 关 fd 时同步流状态（见 LibztInputStream 的同名方法）。 */
    internal fun markClosedByOwner() {
        closed = true
    }

    private companion object {
        const val SHUT_WR = 1 // ZTS_SHUT_WR
    }
}

/**
 * 一次 connect 尝试。存在的理由：OkHttp 的 `call.cancel()` 可能在 `zts_connect` **还没返回时**
 * 就调 `socket.close()`。**不能**在 cancel 线程 close 正在被 `zts_connect` 使用的 fd：
 * lwIP 在 close 之后可能复用同一个 fd，阻塞中的 connect 会在新 socket 上继续跑（use-after-free / 串号）。
 * 所以 cancel 只置标记；connect 线程在 native 返回后看到标记，自己 close 一次再抛“已取消”。
 *
 * 代价：取消后要等 native `zts_connect` 自己的 timeout（我们传 15 s）返回；如果 native 不返回，
 * 后台线程会一直留到它自己的超时。真实 native 取消是否有界**未验**。
 */
class LibztConnectAttempt internal constructor(
    private val sys: LibztSys,
    private val literalHost: String,
    private val port: Int,
    private val timeoutMs: Int,
) {
    private val fdRef = AtomicInteger(-1)
    private val cancelled = AtomicBoolean(false)

    /** 在 `zts_connect` 之前调用；所有失败/取消路径都在**当前线程** fd 关闭一次。 */
    @Throws(IOException::class)
    fun connect(): LibztConnection {
        if (cancelled.get()) throw IOException("libzt connect 已取消（尚未开始）")
        val fd = sys.openStream(LibztSockets.familyOf(literalHost))
        if (fd < 0) throw IOException("libzt socket 失败：rc=$fd（${ZtsErr.name(fd)}）")
        fdRef.set(fd)
        if (cancelled.get()) {
            closeFdOnce()
            throw IOException("libzt connect 已取消（socket 已建、尚未 connect）")
        }
        val rc = try {
            sys.connect(fd, literalHost, port, timeoutMs)
        } catch (error: Throwable) {
            closeFdOnce()
            throw error
        }
        if (cancelled.get()) {
            closeFdOnce()
            throw IOException("libzt connect 已取消（native 已返回）")
        }
        if (rc < 0) {
            closeFdOnce()
            throw IOException(
                "libzt connect 失败：rc=$rc（${ZtsErr.name(rc)}） $literalHost:$port，timeout=${timeoutMs}ms",
            )
        }
        // 把 fd 的所有权从 attempt 交给 connection；谁先把 fdRef 从 fd 改成 -1 谁负责 close。
        if (!fdRef.compareAndSet(fd, -1)) {
            closeFdOnce()
            throw IOException("libzt connect 已取消（连接刚建立）")
        }
        return LibztConnection(sys, literalHost, port, fd)
    }

    /**
     * 从别的线程调用：只置标记，**不 close fd**（避免阻塞 connect 使用被释放/复用的 fd）。
     * connect 线程返回后会 close 一次。
     */
    fun cancel() {
        cancelled.set(true)
    }

    private fun closeFdOnce() {
        val fd = fdRef.getAndSet(-1)
        if (fd >= 0) sys.close(fd)
    }
}

object LibztSockets {
    /**
     * OkHttp 在 `connectTimeout == 0` 时会传 0（我们自己的 Transport 不会这样做，但别让
     * native 的“0 = 30 s”偷偷接管）；这里给一个有界的默认值。
     */
    const val DEFAULT_CONNECT_TIMEOUT_MS = 10_000

    /** 再长也不超过这个值：避免一个连接把界面卡到用户以为“永久连接中”。 */
    const val MAX_CONNECT_TIMEOUT_MS = 30_000

    // 与固定 AAR 的 `include/ZeroTierSockets.h` 一致：ZTS_AF_INET=0x0002、ZTS_AF_INET6=0x000a、ZTS_SOCK_STREAM=0x0001。
    // 这里用字面量（而不是 ZeroTierNative 的静态字段），JVM 单测才能在不加载 libzt.so 的情况下测这条判据；
    // instrumentation 侧另有断言和 AAR 常量逐一对齐。
    const val FAMILY_INET = 2
    const val FAMILY_INET6 = 10
    const val SOCK_STREAM = 1

    fun effectiveConnectTimeoutMs(requested: Int): Int = when {
        requested <= 0 -> DEFAULT_CONNECT_TIMEOUT_MS
        else -> requested.coerceAtMost(MAX_CONNECT_TIMEOUT_MS)
    }

    fun familyOf(host: String): Int = if (host.contains(':')) FAMILY_INET6 else FAMILY_INET

    /** `zts_set_recv_timeout(fd, seconds, microseconds)` 的两个参数（AAR 的 `setSoTimeout(ms)` 把 ms 当了两遍）。 */
    fun readTimeoutParts(timeoutMs: Int): Pair<Int, Int> {
        val sane = timeoutMs.coerceAtLeast(0)
        return (sane / 1000) to ((sane % 1000) * 1000)
    }

    /**
     * 只接受 IP 字面量。AAR 没有暴露 libzt 的 DNS 解析入口，而 OkHttp 也用系统 DNS 先把 URL 主机
     * 解析成 InetSocketAddress —— 对字面量两者一致；对域名不做“也许能行”的猜测。
     */
    fun literalOf(host: String): String {
        val address = try {
            InetAddress.getByName(host)
        } catch (error: Exception) {
            throw IOException(
                "libzt 只按 IP 字面量连接（固定 AAR 没有暴露 libzt DNS）：$host（${error.javaClass.simpleName}）",
                error,
            )
        }
        return address.hostAddress?.substringBefore('%')
            ?: throw IOException("libzt 取不到 $host 的 IP 字面量")
    }

    /** 开始一次连接尝试（fd 在 attempt 内可见；cancel 只置标记，由 connect 线程关闭）。 */
    @Throws(IOException::class)
    fun begin(host: String, port: Int, requestedTimeoutMs: Int): LibztConnectAttempt {
        val timeout = effectiveConnectTimeoutMs(requestedTimeoutMs)
        return LibztConnectAttempt(AarLibztSys, literalOf(host), port, timeout)
    }

    /** 单测入口：不改真实 native。 */
    internal fun beginWith(sys: LibztSys, literalHost: String, port: Int, requestedTimeoutMs: Int): LibztConnectAttempt =
        LibztConnectAttempt(sys, literalHost, port, effectiveConnectTimeoutMs(requestedTimeoutMs))
}
