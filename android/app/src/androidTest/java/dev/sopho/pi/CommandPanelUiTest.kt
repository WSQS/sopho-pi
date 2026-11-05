package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed



import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.sopho.pi.ui.DetailScreen
import dev.sopho.pi.ui.SophoTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 命令页 / 会话通知的**真实 Compose** 证据（真测量、真语义树、真点击，数据来自同进程 [FakeServer]）。
 *
 * 断言的是“屏幕上发生了什么” ＋ “服务端到底收到没收到”：
 * - 点一条可执行的命令 ⇒ 回到聊天、输入框里有 `/name `、**一个 POST 都没有**；
 * - `/compact` 走确认框（不是当普通消息发出去）；
 * - `session.notice` 帧 ⇒ 正文区上方那一行通知**真的画出来了**。
 */
@RunWith(AndroidJUnit4::class)
class CommandPanelUiTest {

    @get:Rule
    val rule = createComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private var state: AppState? = null

    private val sid = "11111111-1111-4111-8111-111111111111"

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun tearDown() {
        state?.let { s -> runCatching { onMain { s.close() } } }
        state = null
        prefs().edit().clear().commit()
    }

    @Test
    fun clickingCommandFillsComposerAndSendsNothing() {
        FakeServer("cmdUi").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sid, "会话 UI"))
            server.messageBodies[sid] = FakeServer.messages("user" to "你好")
            server.commandsBody = COMMANDS
            val connected = connect(server)

            rule.setContent { SophoTheme { DetailScreen(connected) } }
            rule.waitForIdle()

            // 打开命令页（功能盘的那两个入口归并行那条线；这里直接走它的 seam）。
            onMain { connected.openCommandPanel() }
            rule.waitUntil(15_000) { connected.commandSnapshot != null }
            rule.waitForIdle()
            rule.onNodeWithText("命令").assertIsDisplayed()

            // 点「可填入」那一条：只填入，不发送。
            rule.onNodeWithText("/review", substring = true).performClick()
            rule.waitUntil(5_000) { connected.draft == "/review " }
            rule.waitForIdle()

            assertEquals("点条目只填入", "/review ", onMain { connected.draft })
            assertNull("点条目后回到聊天", onMain { connected.panel })
            assertEquals("一个 POST 都没有（填入不是发送）", 0, server.postCalls.size)
            rule.onNodeWithText("发送").assertIsDisplayed()
        }
    }

    @Test
    fun compactCommandShowsConfirmationInsteadOfSending() {
        FakeServer("compactUi").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sid, "会话 UI"))
            server.messageBodies[sid] = FakeServer.messages("user" to "你好")
            server.commandsBody = COMMANDS
            val connected = connect(server)

            rule.setContent { SophoTheme { DetailScreen(connected) } }
            rule.waitForIdle()

            onMain {
                connected.openCommandPanel()
                connected.onDraftChange("/compact")
            }
            rule.waitUntil(15_000) { connected.commandSnapshot != null }
            rule.waitForIdle()

            // 手敲 /compact 后点发送：不发 message，而是进命令页的确认框。
            onMain { connected.send() }
            rule.waitUntil(5_000) {
                connected.panel == Panel.COMMANDS && connected.pendingCompact != null
            }
            rule.waitForIdle()
            assertEquals("一个 POST 都没有（还在确认前）", 0, server.postCalls.size)
            rule.onNodeWithText("确认请求压缩").assertIsDisplayed()
        }
    }

    @Test
    fun sessionNoticeIsRenderedAboveTheTranscript() {
        FakeServer("noticeUi").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sid, "会话 UI"))
            server.messageBodies[sid] = FakeServer.messages("user" to "你好")
            val connected = connect(server)

            rule.setContent { SophoTheme { DetailScreen(connected) } }
            rule.waitForIdle()
            rule.waitUntil(15_000) { server.hasStream(sid) }

            assertTrue(
                "推一帧 session.notice",
                server.push(sid, "session.notice", """{"level":"warn","text":"插件提醒：这一轮有跳过"}"""),
            )
            rule.waitUntil(15_000) { connected.notices.isNotEmpty() }
            rule.waitForIdle()

            rule.onNodeWithText("插件提醒：这一轮有跳过", substring = true).assertIsDisplayed()
            // 收起：点那一行就没了（不堆叠、不永久占位）。
            rule.onNodeWithText("插件提醒：这一轮有跳过", substring = true).performClick()
            rule.waitUntil(5_000) { connected.notices.isEmpty() }
            rule.waitForIdle()
            assertEquals(0, onAllNodesWithTextCount("插件提醒：这一轮有跳过"))
        }
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private fun onAllNodesWithTextCount(needle: String): Int =
        rule.onAllNodesWithText(needle, substring = true).fetchSemanticsNodes().size

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun connect(server: FakeServer): AppState {
        var created: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { created = AppState(app) }
        val fresh = created!!.also { state = it }
        onMain {
            fresh.newProfile()
            fresh.draftUpdate { it.copy(name = "命令 UI 配置", serverUrl = server.baseUrl) }
            fresh.saveDraft()
        }
        onMain { fresh.connect() }
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (onMain { fresh.screen == Screen.LIST }) break
            Thread.sleep(20)
        }
        check(onMain { fresh.screen } == Screen.LIST) { "没连上假服务端（screen=${onMain { fresh.screen }}）" }
        onMain { fresh.open(fresh.sessions.first()) }
        val detailDeadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < detailDeadline) {
            if (onMain { fresh.screen == Screen.DETAIL }) break
            Thread.sleep(20)
        }
        check(onMain { fresh.screen } == Screen.DETAIL) { "没进详情" }
        return fresh
    }

    companion object {
        private const val COMMANDS = """{"sessionId":"{{sid}}","streaming":false,"compacting":false,"canRun":true,
          "commands":[
            {"name":"review","description":"审查代码改动","source":"prompt","argumentHint":"<path>","path":null,
             "builtin":false,"runnable":true,"reason":null,"tag":null,"via":"prompt","hint":null,"shadowed":null},
            {"name":"compact","description":"压缩本会话的上下文","source":"builtin","argumentHint":null,"path":null,
             "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"compact","hint":null,"shadowed":null}
          ]}"""
    }
}
