package dev.sopho.pi

import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * 夹具自检：假服务端自己先说人话。
 *
 * 为什么值得留一条：下面几组行为测试的结论全靠 [FakeServer] 的计数（「GET 到了没有」「POST 到了没有」
 * 「流被断了没有」）。如果夹具本身不该计数的时候不计数，那些「隔离成立」的结论就会变成**假绿**。
 * 这条用它自己的一发 GET 与一发 POST 把计数钉在 OkHttp 的真实往返上。
 */
@RunWith(AndroidJUnit4::class)
class FakeServerSelfTest {

    @Test
    fun fakeServerCountsRealGetsAndPosts() {
        FakeServer("self").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row("sid", "会话"))
            val client = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .build()

            val treeResponse = client.newCall(
                Request.Builder().url("${server.baseUrl}/api/tree").build(),
            ).execute()
            assertEquals(200, treeResponse.code)
            assertTrue("tree 的 body 要带会话", treeResponse.body!!.string().contains("\"sid\""))
            assertEquals("tree 的 GET 要被记到", 1, server.treeGets.get())

            val postResponse = client.newCall(
                Request.Builder()
                    .url("${server.baseUrl}/api/sessions/sid/message")
                    .post("""{"text":"夹具自检"}""".toRequestBody("application/json".toMediaType()))
                    .build(),
            ).execute()
            assertEquals(202, postResponse.code)
            assertEquals("POST 的路径尾段要被记到", listOf("message"), server.postCalls.toList())
            assertTrue("POST 的 body 也要被读到：${server.lastPostBody}", server.lastPostBody.contains("夹具自检"))
            postResponse.close()
        }
    }
}
