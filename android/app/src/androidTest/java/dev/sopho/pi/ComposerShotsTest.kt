package dev.sopho.pi

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.input.TextFieldValue
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.sopho.pi.net.ImagePayload
import dev.sopho.pi.ui.ComposerBody
import dev.sopho.pi.ui.DetailScreen
import dev.sopho.pi.ui.SophoTheme
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * **截图夹具**（在自建 AVD 上跑）：把已确认的几种输入区状态与图片回显真实渲染一遍并存成 PNG，
 * 供 docs 引用。这些图**是模拟器**的，不是真机 —— 文件名与 docs 都这么标。
 *
 * 它同时做了少量断言（要截的那一块确实在），所以不是“只截图不验”。
 */
@RunWith(AndroidJUnit4::class)
class ComposerShotsTest {

    @get:Rule
    val rule = createComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private var state: AppState? = null

    private val sessionId = "cccccccc-0000-4000-8000-00000000000c"

    private val outDir: File
        get() = File(
            InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),
            "shots",
        ).apply { mkdirs() }

    @Before
    @After
    fun clean() {
        state?.let { s -> runCatching { onMain { s.close() } } }
        state = null
        app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE).edit().clear().commit()
        app.cacheDir.listFiles()?.forEach { it.delete() }
    }

    private fun shoot(name: String) {
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(outDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("截图要落盘：$name", File(outDir, name).length() > 1000)
    }

    private fun attachment(): Attachment {
        val bitmap = Bitmap.createBitmap(120, 90, Bitmap.Config.ARGB_8888)
        for (x in 0 until 120 step 8) for (y in 0 until 90 step 8) bitmap.setPixel(x, y, 0xFF3366CC.toInt())
        return Attachment(
            id = "img-shot",
            payload = ImagePayload("image/png", "QUJD"),
            thumb = bitmap,
            width = 1200,
            height = 900,
            originalWidth = 2400,
            originalHeight = 1800,
            sourceBytes = 812_345,
            encodedBytes = 356_789,
        )
    }

    /** 同一个测试只能 `setContent` 一次，所以用一个可变状态在几种布局间切。 */
    private enum class ShotState { EMPTY, TYPING, PAD, ATTACH }

    private fun composerShots() {
        val mode = mutableStateOf(ShotState.EMPTY)
        rule.setContent {
            val current = mode.value
            val field = when (current) {
                ShotState.EMPTY, ShotState.PAD -> TextFieldValue("")
                ShotState.TYPING -> TextFieldValue("帮我看下这条会话")
                ShotState.ATTACH -> TextFieldValue("配一句话一起发")
            }
            SophoTheme {
                ComposerBody(
                    field = field,
                    onFieldChange = {},
                    onFocus = {},
                    sending = false,
                    imageIngesting = false,
                    padOpen = current == ShotState.PAD,
                    attachment = if (current == ShotState.ATTACH) attachment() else null,
                    imageNotice = null,
                    padNotice = null,
                    onPrimary = {},
                    onRemoveAttachment = {},
                    onPeekAttachment = {},
                    onCommands = {},
                    onModels = {},
                    onPickImage = {},
                )
            }
        }

        rule.onNodeWithText("＋").assertExists()
        shoot("composer-01-empty-plus-avd.png")

        rule.runOnIdle { mode.value = ShotState.TYPING }
        rule.waitForIdle()
        rule.onNodeWithText("发送").assertExists()
        shoot("composer-02-typing-send-avd.png")

        rule.runOnIdle { mode.value = ShotState.PAD }
        rule.waitForIdle()
        rule.onNodeWithTag("func-pad").assertExists()
        shoot("composer-03-pad-open-avd.png")

        rule.runOnIdle { mode.value = ShotState.ATTACH }
        rule.waitForIdle()
        rule.onNodeWithTag("attach-thumb").assertExists()
        shoot("composer-04-attachment-avd.png")
    }

    @Test
    fun shots_ofTheComposerStates() {
        composerShots()
    }

    @Test
    fun shots_ofTheDetailScreen_withImageMessageAndPeek() {
        FakeServer("SHOT").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionId, "图片消息演示"))
            val png = smallPngBase64()
            server.messageBodies[sessionId] = """
                {"messages":[
                  {"entryId":"e1","role":"user","timestamp":"2026-10-25T09:00:00.000Z",
                   "text":"这张图里是什么？\n[图片：image/png，${png.second} 字节（网页暂不显示图片内容）]",
                   "content":[{"type":"text","text":"这张图里是什么？"},
                              {"type":"image","mimeType":"image/png","data":"${png.first}"}],
                   "images":[{"mimeType":"image/png","bytes":${png.second}}]},
                  {"entryId":"e2","role":"assistant","timestamp":"2026-10-25T09:00:03.000Z",
                   "text":"（演示用合成回复：这是一张合成图片。）","content":[]}
                ]}
            """.trimIndent()

            val created = newState()
            saveProfile(created, "截图配置", server.baseUrl)
            onMain { created.connect() }
            waitFor("连上") { onMain { created.screen == Screen.LIST } }
            onMain { created.open(created.sessions.first { it.id == sessionId }) }
            waitFor("正文到齐") { onMain { created.messages.size == 2 } }

            // 输入行上方放一张待发图，同时正文里也有图（图文同屏）。
            onMain { created.onImagePicked(writeImage("shot.png")) }
            waitFor("附件就绪") { onMain { created.attachment != null } }

            rule.setContent { SophoTheme { DetailScreen(created) } }
            rule.waitForIdle()
            shoot("detail-01-image-message-avd.png")

            // 点缩略图才看大图。
            rule.onNodeWithTag("attach-thumb").performClick()
            rule.waitForIdle()
            rule.onNodeWithTag("peek").assertExists()
            shoot("detail-02-peek-overlay-avd.png")
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private fun smallPngBase64(): Pair<String, Int> {
        val bitmap = Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888)
        for (x in 0 until 240 step 4) for (y in 0 until 160 step 4) {
            bitmap.setPixel(x, y, if ((x / 4 + y / 4) % 2 == 0) 0xFF2F6F9F.toInt() else 0xFF8ABEB7.toInt())
        }
        val bytes = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        bitmap.recycle()
        val array = bytes.toByteArray()
        return android.util.Base64.encodeToString(array, android.util.Base64.NO_WRAP) to array.size
    }

    private fun writeImage(name: String): Uri {
        val bitmap = Bitmap.createBitmap(600, 450, Bitmap.Config.ARGB_8888)
        for (x in 0 until 600 step 12) for (y in 0 until 450 step 12) bitmap.setPixel(x, y, 0xFF224466.toInt())
        val file = File(app.cacheDir, name)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 90, it) }
        bitmap.recycle()
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
