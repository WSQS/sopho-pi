package dev.sopho.pi

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 图片**发送链路**的行为（真 AppState ＋ 真 OkHttp ＋ 真解码/缩放/压缩 ＋ 同进程假服务端）。
 *
 * 关键一句：断言的是**假服务端真实收到的请求体**（`FakeServer.postBodies`）里的 base64 能不能解出
 * 真实图片字节（JPEG 的 `FF D8 FF`）—— 不是客户端自己说“我发了”。只有这样才能证明
 * “用户点发送才提交真实图片”而不是只展示本地预览。
 *
 * 会失败的理由：
 * - 选完图就自动 POST ⇒ `pickingAnImageNeverPosts` 红；
 * - 把 `images` 从请求体里丢掉（只发 text）⇒ 带图用例全红；
 * - 服务端没给图片凭据却把回执算成“已接受” ⇒ `acceptedWithoutImageEvidence` 红；
 * - 失败/未知时把附件清掉 ⇒ 保图用例红；
 * - 附件不按会话隔离 ⇒ 切会话用例红；
 * - 发送成功一律清附件（不管是不是发送时那一张）⇒ 在途换图用例红。
 */
@RunWith(AndroidJUnit4::class)
class ImageSendBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private var state: AppState? = null

    private val sessionA = "aaaaaaaa-0000-4000-8000-00000000000a"
    private val sessionB = "bbbbbbbb-0000-4000-8000-00000000000b"

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
        cacheDir().listFiles()?.forEach { it.delete() }
    }

    @After
    fun tearDown() {
        state?.let { s -> runCatching { onMain { s.close() } } }
        state = null
        prefs().edit().clear().commit()
        cacheDir().listFiles()?.forEach { it.delete() }
    }

    // ── 用例 ──

    @Test
    fun pickingAnImageNeverPosts_andSendDeliversRealImageBytes() {
        FakeServer("IMG1").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "图片会话"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            // 服务端确认收到 1 张图（契约里的 `images:<n>`）。
            server.routeBody["message"] = FakeServer.acceptedMessageWithImages(1)

            val created = connectAndOpen(server, sessionA)

            onMain { created.onImagePicked(writeImage("one.png", 1200, 900, png = true)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }
            val attachment = onMain { created.attachment!! }

            // ① 选图**不自动发送、不上传**：服务端一个 POST 都没收到。
            assertTrue("选图不许自动 POST", server.postCalls.isEmpty())
            assertEquals(0, server.createCalls.get())
            assertTrue("附件标签要写真实尺寸与大小（不含路径）", attachment.label.startsWith("1200×900 · "))
            assertTrue(attachment.label.endsWith(" KiB"))
            assertTrue("缩略图要真的解出来", attachment.thumb.width > 0 && attachment.thumb.height > 0)

            onMain { created.onDraftChange("看看这张") }
            onMain { created.send() }
            waitFor("发送回执回来") { onMain { created.sendReceipt != null } }

            // ② 服务端真的收到了 images[]，且 base64 能解出真 JPEG 字节。
            assertEquals(1, server.postCalls.size)
            assertEquals("message", server.postCalls.first())
            val body = JSONObject(server.postBodies.first().second)
            assertEquals("看看这张", body.getString("text"))
            val images = body.getJSONArray("images")
            assertEquals(1, images.length())
            val mime = images.getJSONObject(0).getString("mimeType")
            val data = images.getJSONObject(0).getString("data")
            assertEquals("image/png", mime)
            assertTrue("data 不许带 data: 前缀", !data.startsWith("data:"))
            val decoded = android.util.Base64.decode(data, android.util.Base64.NO_WRAP)
            assertTrue("服务端收到的必须是真图片字节（不是空壳/元数据）", decoded.size > 100)

            // ③ 回执是“已接受（带图，服务端确认）”，并且附件被清掉（它就是发送时那一张）。
            assertTrue(created.sendReceipt!!.contains("已接受"))
            assertTrue(created.sendReceipt!!.contains("带 1 张图片"))
            assertNull("accepted 后清掉发送时那一张", created.attachment)
            assertEquals("", created.draft)
        }
    }

    @Test
    fun pureImageIsSendable_withEmptyText_andEndsUpInTheRequestBody() {
        FakeServer("IMG2").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "纯图"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.routeBody["message"] = FakeServer.acceptedMessageWithImages(1)

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("pure.jpg", 800, 600, png = false)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }
            assertEquals("", onMain { created.draft })

            onMain { created.send() }
            waitFor("回执") { onMain { created.sendReceipt != null } }

            val body = JSONObject(server.postBodies.single().second)
            assertEquals("纯图 text 允许空串", "", body.getString("text"))
            assertEquals(1, body.getJSONArray("images").length())
            assertTrue("纯图 accepted 后也应清掉附件", created.attachment == null)
        }
    }

    @Test
    fun busySessionSendsImageThroughSteer_notAsTextOnly() {
        FakeServer("IMG3").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "在跑的会话", status = "working"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.routeBody["steer"] = FakeServer.acceptedSteerWithImages(1)

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("steer.png", 700, 500, png = true)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }

            onMain { created.onDraftChange("插一句") }
            onMain { created.send() }
            waitFor("回执") { onMain { created.sendReceipt != null } }

            assertEquals(listOf("steer"), server.postCalls.toList())
            val body = JSONObject(server.postBodies.single().second)
            assertEquals(
                "忙时带图必须走 steer 且**图不能丢**",
                1,
                body.getJSONArray("images").length(),
            )
            assertTrue(created.sendReceipt!!.contains("插话"))
        }
    }

    @Test
    fun acceptedWithoutImageEvidence_isNotReportedAsSent_andKeepsDraftAndImage() {
        FakeServer("IMG4").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "旧服务端"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            // 旧服务端形状：202 带 accepted，但**没有**图片凭据。
            server.routeBody["message"] = FakeServer.acceptedMessage()

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("old.png", 640, 480, png = true)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }
            onMain { created.onDraftChange("看图") }
            onMain { created.send() }
            waitFor("回执") { onMain { created.sendReceipt != null } }

            assertNotNull("没确认图片就不许删附件", created.attachment)
            assertEquals("看图", created.draft)
            assertTrue(created.sendReceipt!!.contains("没有确认图片"))
            assertEquals(AppState.ReceiptTone.WARN, created.sendReceiptTone)
        }
    }

    @Test
    fun serverErrorKeepsTheImageAndSaysNothingWasSent() {
        FakeServer("IMG5").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "报错"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.routeStatus["message"] = 400
            server.routeBody["message"] = """{"error":"unsupported_image_type","message":"只收 jpeg/png"}"""

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("bad.png", 640, 480, png = true)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }
            onMain { created.onDraftChange("看图") }
            onMain { created.send() }
            waitFor("回执") { onMain { created.sendReceipt != null } }

            assertNotNull(created.attachment)
            assertTrue(created.sendReceipt!!.contains("unsupported_image_type"))
            assertTrue("要说清“草稿与图片都保留”", created.sendReceipt!!.contains("保留"))
        }
    }

    @Test
    fun unknownOutcomeKeepsTheImage_andNeverReposts() {
        FakeServer("IMG6").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "未知"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.routeStatus["message"] = 500
            server.routeBody["message"] = """{"error":"boom"}"""

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("unknown.png", 640, 480, png = true)) }
            waitFor("图片处理完") { onMain { created.attachment != null } }
            onMain { created.onDraftChange("看图") }
            onMain { created.send() }
            waitFor("回执") { onMain { created.sendReceipt != null } }

            assertNotNull(created.attachment)
            assertTrue(created.sendReceipt!!.contains("不确定"))
            assertEquals("一次点击只出一个 POST", 1, server.postCalls.size)
        }
    }

    @Test
    fun attachmentsAreIsolatedPerSession_andComeBackWhenReturning() {
        FakeServer("IMG7").use { server ->
            server.treeJson = FakeServer.tree(
                FakeServer.row(sessionA, "会话 A"),
                FakeServer.row(sessionB, "会话 B"),
            )
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.messageBodies[sessionB] = """{"messages":[]}"""

            val created = newState()
            saveProfile(created, "图片隔离", server.baseUrl)
            onMain { created.connect() }
            waitFor("连上") { onMain { created.screen == Screen.LIST } }

            onMain { created.open(created.sessions.first { it.id == sessionA }) }
            waitFor("A 打开") { onMain { created.current?.id == sessionA } }
            onMain { created.onImagePicked(writeImage("a.png", 640, 480, png = true)) }
            waitFor("A 的图片处理完") { onMain { created.attachment != null } }
            val aImage = onMain { created.attachment!!.id }

            onMain { created.backToList() }
            onMain { created.open(created.sessions.first { it.id == sessionB }) }
            waitFor("B 打开") { onMain { created.current?.id == sessionB } }
            assertNull("切到 B 不许看到 A 的图片", onMain { created.attachment })

            onMain { created.backToList() }
            onMain { created.open(created.sessions.first { it.id == sessionA }) }
            waitFor("回到 A") { onMain { created.current?.id == sessionA } }
            assertEquals("回到 A 时那张图还在（只存内存，不落盘）", aImage, onMain { created.attachment?.id })
        }
    }

    @Test
    fun anImagePickedWhileSendingIsNotDeletedByTheLateReceipt() {
        FakeServer("IMG8").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "在途换图"))
            server.messageBodies[sessionA] = """{"messages":[]}"""
            server.routeBody["message"] = FakeServer.acceptedMessageWithImages(1)
            server.routeDelayMs["message"] = 1200

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeImage("before.png", 640, 480, png = true)) }
            waitFor("第一张处理完") { onMain { created.attachment != null } }
            val firstId = onMain { created.attachment!!.id }
            onMain { created.onDraftChange("第一张") }
            onMain { created.send() }
            waitFor("请求发出去了") { server.postCalls.isNotEmpty() }

            // 在途：用户又换了一张图。
            onMain { created.onImagePicked(writeImage("after.png", 500, 400, png = true)) }
            waitFor("第二张处理完") { onMain { created.attachment != null && created.attachment?.id != firstId } }
            val secondId = onMain { created.attachment!!.id }

            waitFor("回执回来") { onMain { created.sendReceipt != null && !created.sending } }
            assertEquals("回执不许删掉在途新选的那张", secondId, onMain { created.attachment?.id })
        }
    }

    @Test
    fun gifIsRefusedWithAReadableReason_andNoPostIsMade() {
        FakeServer("IMG9").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionA, "动图"))
            server.messageBodies[sessionA] = """{"messages":[]}"""

            val created = connectAndOpen(server, sessionA)
            onMain { created.onImagePicked(writeGif("anim.gif")) }
            waitFor("拒绝原因上屏") { onMain { created.imageNotice != null } }

            assertNull("动图不许被“接”下来", onMain { created.attachment })
            assertTrue(created.imageNotice!!.contains("GIF"))
            assertTrue("选图失败也不许发任何请求", server.postCalls.isEmpty())
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private fun connectAndOpen(server: FakeServer, sessionId: String): AppState {
        val created = newState()
        saveProfile(created, "图片配置", server.baseUrl)
        onMain { created.connect() }
        waitFor("连上（进列表）") { onMain { created.screen == Screen.LIST } }
        onMain { created.open(created.sessions.first { it.id == sessionId }) }
        waitFor("详情打开") { onMain { created.current?.id == sessionId } }
        return created
    }

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun cacheDir(): File = app.cacheDir

    /** 真图片文件（PNG 带 alpha / JPEG 不带），走 `Uri.fromFile` 让 ContentResolver 正常读。 */
    private fun writeImage(name: String, width: Int, height: Int, png: Boolean): Uri {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        for (x in 0 until width step 32) {
            for (y in 0 until height step 32) {
                bitmap.setPixel(x, y, 0xFF3366CC.toInt())
            }
        }
        val file = File(cacheDir(), name)
        file.outputStream().use { out ->
            bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 90, out)
        }
        bitmap.recycle()
        return Uri.fromFile(file)
    }

    /** 一个真 GIF 文件（本版必须**拒绝**，不许偷偷只发第一帧）。 */
    private fun writeGif(name: String): Uri {
        val file = File(cacheDir(), name)
        file.writeBytes("GIF89a".toByteArray(Charsets.US_ASCII) + ByteArray(32))
        return Uri.fromFile(file)
    }

    private fun newState(): AppState {
        var created: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { created = AppState(app) }
        return created!!.also { state = it }
    }

    private fun saveProfile(target: AppState, name: String, url: String) {
        onMain {
            target.newProfile()
            target.draftUpdate { it.copy(name = name, serverUrl = url) }
            target.saveDraft()
        }
    }

    private fun <T> onMain(block: () -> T): T {
        // `waitFor` 本身就包了一层 `runOnMainSync`，而条件里也可能再包一次 ——
        // 已经在主线程时直接跑（`runOnMainSync` 会在主线程上抛 RuntimeException）。
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return block()
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun waitFor(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(25)
        }
        throw AssertionError("等不到：$what（${timeoutMs} ms 超时）")
    }
}
