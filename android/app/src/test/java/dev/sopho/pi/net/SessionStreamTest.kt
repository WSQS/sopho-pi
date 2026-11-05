package dev.sopho.pi.net

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * SSE 的“无响应头”阶段必须可见地失败/退避，而不是只剩一句“连接中…”；取消后不许再新建连接。
 * 这里用的是**本机裸 HTTP 假 server**，与 libzt/真实服务无关；它只证明客户端状态机与 Call 取消，
 * **不**证明 libzt 的 close 能打断 native 阻塞（那一格没有真机证据）。
 */
class SessionStreamTest {

    private class RawServer(private val handler: (Socket) -> Unit) : AutoCloseable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val running = java.util.concurrent.atomic.AtomicBoolean(true)
        val accepted = AtomicInteger(0)
        val port: Int get() = server.localPort

        private val acceptThread = thread(isDaemon = true) {
            while (running.get()) {
                val socket = try {
                    server.accept()
                } catch (error: IOException) {
                    break
                }
                accepted.incrementAndGet()
                thread(isDaemon = true) { runCatching { handler(socket) } }
            }
        }

        override fun close() {
            running.set(false)
            runCatching { server.close() }
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

    private fun client(): OkHttpClient = OkHttpClient.Builder()
        .readTimeout(300, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private suspend fun waitUntil(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 6_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            delay(20)
        }
        throw AssertionError("等到超时：$what")
    }

    @Test
    fun `no response headers becomes a visible failure with attempt and backoff`() = runBlocking {
        val server = RawServer { socket ->
            readRequest(socket)
            Thread.sleep(4_000) // 故意不回响应头
            runCatching { socket.close() }
        }
        val events = CopyOnWriteArrayList<Pair<StreamState, String?>>()
        val stream = SessionStream(
            client = client(),
            baseUrl = "http://127.0.0.1:${server.port}",
            sessionId = "s1",
            onState = { state, detail -> events += state to detail },
            onEvent = { _, _ -> },
        )
        val job = launch(Dispatchers.IO) { stream.run() }
        try {
            withTimeout(6_000) { waitUntil("第一次失败") { events.any { it.first == StreamState.FAILED } } }
            val failed = events.first { it.first == StreamState.FAILED }.second!!
            assertTrue(failed, failed.contains("第 1 次失败"))
            assertTrue(failed, failed.contains("后重试"))

            withTimeout(6_000) {
                waitUntil("第二次 CONNECTING（带上次原因）") {
                    events.any { it.first == StreamState.CONNECTING && it.second?.contains("第 2 次") == true }
                }
            }
            val connecting = events.first {
                it.first == StreamState.CONNECTING && it.second?.contains("第 2 次") == true
            }.second!!
            assertTrue(connecting, connecting.contains("上次："))
        } finally {
            stream.cancel()
            job.cancelAndJoin()
            server.close()
        }
    }

    @Test
    fun `the headers deadline cancels an attempt that never gets response headers`() = runBlocking {
        val server = RawServer { socket ->
            readRequest(socket)
            Thread.sleep(4_000)
            runCatching { socket.close() }
        }
        val events = CopyOnWriteArrayList<Pair<StreamState, String?>>()
        val stream = SessionStream(
            client = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build(),
            baseUrl = "http://127.0.0.1:${server.port}",
            sessionId = "s1",
            onState = { state, detail -> events += state to detail },
            onEvent = { _, _ -> },
            headersTimeoutMs = 500,
        )
        val job = launch(Dispatchers.IO) { stream.run() }
        try {
            withTimeout(6_000) { waitUntil("headers deadline 失败") { events.any { it.first == StreamState.FAILED } } }
            val failed = events.first { it.first == StreamState.FAILED }.second!!
            assertTrue(failed, failed.contains("等待响应头 500ms 超时"))
            assertTrue(failed, failed.contains("第 1 次失败"))
        } finally {
            stream.cancel()
            job.cancelAndJoin()
            server.close()
        }
    }

    @Test
    fun `cancel after a failure stops further connection attempts`() = runBlocking {
        val server = RawServer { socket ->
            readRequest(socket)
            Thread.sleep(4_000)
            runCatching { socket.close() }
        }
        val events = CopyOnWriteArrayList<Pair<StreamState, String?>>()
        val stream = SessionStream(
            client = client(),
            baseUrl = "http://127.0.0.1:${server.port}",
            sessionId = "s1",
            onState = { state, detail -> events += state to detail },
            onEvent = { _, _ -> },
        )
        val job = launch(Dispatchers.IO) { stream.run() }
        try {
            withTimeout(6_000) { waitUntil("第一次失败") { events.any { it.first == StreamState.FAILED } } }
            stream.cancel()
            job.cancelAndJoin()
            val afterCancel = server.accepted.get()
            delay(1_500)
            assertEquals("取消后不许再新建连接", afterCancel, server.accepted.get())
        } finally {
            stream.cancel()
            job.cancelAndJoin()
            server.close()
        }
    }

    @Test
    fun `a snapshot opens the stream and a reconnect is reported`() = runBlocking {
        val snapshots = AtomicInteger(0)
        val server = RawServer { socket ->
            readRequest(socket)
            val out = socket.getOutputStream()
            out.write(
                (
                    "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/event-stream\r\n" +
                        "Cache-Control: no-cache\r\n" +
                        "\r\n" +
                        "retry: 1000\n\n" +
                        "event: session.snapshot\n" +
                        "data: {\"isStreaming\":false}\n\n"
                    ).toByteArray(),
            )
            out.flush()
            Thread.sleep(300)
            runCatching { socket.close() }
        }
        val events = CopyOnWriteArrayList<Pair<StreamState, String?>>()
        val stream = SessionStream(
            client = client(),
            baseUrl = "http://127.0.0.1:${server.port}",
            sessionId = "s1",
            onState = { state, detail -> events += state to detail },
            onEvent = { type, _ -> if (type == "session.snapshot") snapshots.incrementAndGet() },
        )
        val job = launch(Dispatchers.IO) { stream.run() }
        try {
            withTimeout(6_000) { waitUntil("OPEN") { events.any { it.first == StreamState.OPEN } } }
            withTimeout(6_000) {
                waitUntil("OPEN_AFTER_RECONNECT") { events.any { it.first == StreamState.OPEN_AFTER_RECONNECT } }
            }
            assertTrue("snapshot 至少要来一次", snapshots.get() >= 1)
        } finally {
            stream.cancel()
            job.cancelAndJoin()
            server.close()
        }
    }
}
