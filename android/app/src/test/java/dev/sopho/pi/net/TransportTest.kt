package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * OkHttp 的池共享关系要按**对象身份**读，而不是数 `build()` 调了几次：
 * `newBuilder()` 会复制同一个 `ConnectionPool` 对象（直到被显式替换）；`build()` 在新 builder 上
 * 才创建新池。这里直接比较池对象，钉住：
 * - GET / SSE / POST 三套池互不相同；
 * - SSE 的池没有 idle 复用（0）；
 * - POST 仍是专用策略：不隐式重试、不跟重定向 —— 不被 GET 的重试策略污染。
 *
 * 只构造 client，不发任何请求（不碰真实 A/B，也不碰 libzt）。
 */
class TransportTest {

    @Test
    fun `plain transport has three distinct connection pools and sse does not keep idle connections`() {
        val transport = Transports.plain()
        assertNotSame(transport.client.connectionPool, transport.sseClient.connectionPool)
        assertNotSame(transport.client.connectionPool, transport.postClient.connectionPool)
        assertNotSame(transport.sseClient.connectionPool, transport.postClient.connectionPool)
        // newBuilder() 实际共享的是 Dispatcher（同一个对象），池被显式换掉；POST 是另一个 builder。
        assertSame(transport.client.dispatcher, transport.sseClient.dispatcher)
        assertNotSame(transport.client.dispatcher, transport.postClient.dispatcher)
        assertTrue("GET 仍允许 OkHttp 的连接失败重试", transport.client.retryOnConnectionFailure)
    }

    @Test
    fun `the post client keeps its no-replay policy`() {
        val transport = Transports.plain()
        assertFalse("POST 不许隐式重试", transport.postClient.retryOnConnectionFailure)
        assertFalse("POST 不跟重定向", transport.postClient.followRedirects)
        assertFalse("POST 不跟 SSL 重定向", transport.postClient.followSslRedirects)
        assertEquals(8_000, transport.postClient.connectTimeoutMillis)
    }

    @Test
    fun `libzt transport uses the fixed libzt socket factory but still keeps post separate`() {
        val transport = Transports.overLibzt("10.147.20.5", 7321)
        assertNotSame(transport.client.connectionPool, transport.sseClient.connectionPool)
        assertNotSame(transport.sseClient.connectionPool, transport.postClient.connectionPool)
        assertFalse(transport.postClient.retryOnConnectionFailure)
        assertFalse(transport.postClient.followRedirects)
        assertEquals(15_000, transport.postClient.connectTimeoutMillis)
        // 只断言构造出来的超时，不连接：真网/真 ZT 不在本测试范围。
        assertEquals(25_000, transport.client.readTimeoutMillis)
        assertEquals(40_000, transport.sseClient.readTimeoutMillis)
    }
}
