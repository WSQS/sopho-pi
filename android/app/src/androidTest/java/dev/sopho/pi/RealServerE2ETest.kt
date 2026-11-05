package dev.sopho.pi

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import android.util.Base64

/**
 * **真链路的端到端**（不是假服务端）：安卓这台应用进程 → 独立起的真 B（反代）→ 真 A（宿主＋generation
 * worker）→ 本地 OpenAI 兼容 stub provider。钉住三件本轮新增的东西**真的通**：
 *
 * 1. **图片**：走真实 `onImagePicked`（ContentResolver 读图 → 嗅探 → 降采样 → 重编码 → base64），
 *    然后真 `POST /message {text, images:[{mimeType,data}]}`；回执必须**真的确认了图**（`images:1`），
 *    草稿与附件才清。模型侧是否真收到 `image_url` 由**沙箱那侧的 provider 请求记录**作证（本文件不猜）。
 * 2. **模型能力**：`GET /models` 的 `supportsImages` 三态接到图片闸（`canSendImages`）上。
 * 3. **思考档位**：真 `POST /model {thinkingLevel}` → 服务端回执 → **`GET /sessions/{id}` 回读**；
 *    只有回读值与请求值一致时才算写成功，且**不许**出现“和你选的不同”这种偏差话术。
 *
 * ⚠️ 默认 **skip**：没有 `-e sophoBaseUrl=…` 参数时一条断言都不跑（它要求一个已起好的隔离沙箱，
 * 见 `docs/ops/android-e2e-real-server.md` 的起法）。这样它不会在别人的机器上假装跑过。
 *
 * ⚠️ 它**不**碰 7331/7321、不碰真实 profile、不写生产会话：沙箱的 ASSIST_HOME 是 mkdtemp 出来的，
 * 端口是随机高位端口。
 */
@RunWith(AndroidJUnit4::class)
class RealServerE2ETest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    private val args get() = InstrumentationRegistry.getArguments()
    private val baseUrl: String? get() = args.getString("sophoBaseUrl")
    private val sessionId: String? get() = args.getString("sophoSessionId")
    private val pngBase64: String? get() = args.getString("sophoPngBase64")

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun tearDown() {
        created.forEach { state -> runCatching { onMain { state.close() } } }
        created.clear()
        prefs().edit().clear().commit()
    }

    @Test
    fun androidSendsARealImageToAnIsolatedServerAndReadsModelAndThinkingBack() {
        assumeTrue(
            "没有 -e sophoBaseUrl/sophoSessionId/sophoPngBase64 ⇒ 跳过（需要一台已起好的隔离沙箱）",
            baseUrl != null && sessionId != null && pngBase64 != null,
        )
        val url = baseUrl!!
        val targetSessionId = sessionId!!

        val state = newState()
        saveProfile(state, "E2E 沙箱", url)
        onMain { state.connect() }
        waitFor("连上（进列表）", timeoutMs = 20_000, diag = { snap(state).toString() }) { state.screen == Screen.LIST }

        val row = onMain { state.sessions.firstOrNull { it.id == targetSessionId } }
        assertNotNull("沙箱里那条会话要出现在真实 /tree 里（sessions=${onMain { state.sessions.map { it.name } }}）", row)
        onMain { state.open(row!!) }
        waitFor("正文到（详情页打开）", timeoutMs = 20_000, diag = { snap(state).toString() }) {
            state.current?.id == targetSessionId
        }
        assertEquals("打开的就是沙箱那条会话", targetSessionId, onMain { state.current!!.id })

        // ── ① 图片：真 ContentResolver 读入（file:// 也算一条真正的输入流） ──
        val file = File(app.cacheDir, "e2e-${System.currentTimeMillis()}.png")
        file.writeBytes(Base64.decode(pngBase64, Base64.DEFAULT))
        onMain { state.onImagePicked(Uri.fromFile(file)) }
        waitFor("图片进内存（解码/缩放/重编码是真的跑过）", timeoutMs = 20_000, diag = { "notice=" + onMain { state.imageNotice } }) {
            state.attachment != null || state.imageNotice != null
        }
        assertNull("摄入不许失败（notice=${onMain { state.imageNotice }}）", onMain { state.imageNotice })
        val attachment = onMain { state.attachment }
        assertNotNull("附件要在", attachment)
        assertTrue(
            "输出 MIME 只许 jpeg/png（实际 ${attachment!!.payload.mimeType}）",
            attachment.payload.mimeType == "image/png" || attachment.payload.mimeType == "image/jpeg",
        )
        assertTrue("编码后字节数要有界且非空", attachment.payload.decodedBytes in 1..(2 * 1024 * 1024))

        // ── ② 真发送：{text, images:[...]} → 202 + accepted + images:1 ──
        onMain { state.onDraftChange("E2E 看图") }
        onMain { state.send() }
        waitFor("这一发结束", timeoutMs = 40_000, diag = { snap(state).toString() }) { !state.sending }
        val receipt = onMain { state.sendReceipt } ?: fail("要有回执").let { "" }
        assertEquals("这一发必须被真服务端接受（回执=$receipt）", AppState.ReceiptTone.OK, onMain { state.sendReceiptTone })
        assertTrue("回执照实说“已接受”：$receipt", receipt.contains("已接受"))
        assertTrue("回执必须真的确认了图片（不是静默忽略）：$receipt", receipt.contains("带 1 张图片"))
        assertNull("接受了才清附件（实际=${onMain { state.attachment }}）", onMain { state.attachment })
        assertEquals("接受了才清草稿", "", onMain { state.draft })

        // 服务端正文里要能读回这一条（含图片元数据）—— 证明它真的落在这条会话的历史里，
        // 而不只是“客户端以为发了”。像素是否回到客户端由 /messages 的 content 决定。
        waitFor("我发的那条进了正文", timeoutMs = 40_000, diag = { snap(state).toString() }) {
            state.messages.any { it.role == "user" && it.text.contains("E2E 看图") }
        }
        val mine = onMain { state.messages.last { it.role == "user" && it.text.contains("E2E 看图") } }
        assertTrue("正文里这条要带图片（images=${mine.images.size}）", mine.images.isNotEmpty())
        assertTrue("图片要么有像素、要么如实说看不到内容，不许假图", mine.images.all { it.canRender || it.bytes != null })

        // ── ③ 模型与思考：真 /models ＋ 真 /model ＋ 真回读 ──
        onMain { state.openModelPanel() }
        waitFor(
            "模型目录与思考真值都到手",
            timeoutMs = 30_000,
            diag = { "err=" + onMain { state.modelsError } + " loading=" + onMain { state.modelsLoading } },
        ) {
            // 目录先到、思考真值要等紧随其后的 `GET /sessions/{id}` 回读落地 —— 两件都到齐再判。
            state.modelCatalog != null && !state.modelsLoading && state.actualThinkingLevel != null
        }
        assertEquals("stub-vision 声明了 input=[text,image] ⇒ 能力必须是 true（实际=${onMain { state.canSendImages }}）", true, onMain { state.canSendImages })
        val actualModel = onMain { state.actualModelRef }
        val actualThinking = onMain { state.actualThinkingLevel }
        assertNotNull("模型真值要从服务端回读（不是本地默认）", actualModel)
        assertNotNull("思考档位真值要从服务端回读", actualThinking)
        val levels = onMain { state.thinkingLevels }
        assertTrue("档位清单来自服务端（实际=${levels}）", levels.isNotEmpty())

        val target = levels.firstOrNull { it != actualThinking }
            ?: fail("至少要有两个档位才能验“写入真的生效”（levels=$levels）").let { "" }
        onMain { state.selectDraftThinking(target) }
        onMain { state.applySettings() }
        waitFor("写结束", timeoutMs = 40_000, diag = { snap(state).toString() }) { !state.settingsBusy }
        val writeReceipt = onMain { state.settingsReceipt } ?: ""
        assertTrue("回执要逐字带写入与回读值：$writeReceipt", writeReceipt.contains("思考档位已写入"))
        assertTrue("回执要写清回读了服务端真值：$writeReceipt", writeReceipt.contains("回读"))
        assertEquals("这就是持久化=false 的会话级写（只这一条）", AppState.ReceiptTone.OK, onMain { state.settingsReceiptTone })
        assertEquals("回读值与请求一致（不是本地乐观值）", target, onMain { state.actualThinkingLevel })
        assertNotEquals("档位真的变了", actualThinking, onMain { state.actualThinkingLevel })
        assertFalse(
            "请求值与回读值一致时**不许**出现偏差话术：$writeReceipt",
            writeReceipt.contains("不是你的选择") || writeReceipt.contains("和你") && writeReceipt.contains("不同"),
        )
    }

    // ── 与其它行为用例同一套小工具（真 Context ＋ 真 Prefs ＋ 真 AppState） ──

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun newState(): AppState {
        var state: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { state = AppState(app) }
        return state!!.also { created += it }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun waitFor(what: String, timeoutMs: Long = 10_000, diag: () -> String = { "" }, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        fail("等不到：$what（${timeoutMs} ms 超时）${runCatching { diag() }.getOrDefault("")}")
    }

    private fun saveProfile(state: AppState, name: String, url: String) {
        onMain {
            state.newProfile()
            state.draftUpdate { it.copy(name = name, serverUrl = url) }
            state.saveDraft()
        }
        assertEquals("保存并选中「$name」", name, onMain { state.selectedProfileName })
    }

    private fun snap(state: AppState): String = "screen=${state.screen} sending=${state.sending} " +
        "receipt=${state.sendReceipt} draft=${state.draft} attach=${state.attachment} " +
        "panel=${state.panel} models=${state.modelCatalog?.models?.size} " +
        "actual=${state.actualModelRef}/${state.actualThinkingLevel}"
}
