package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.sopho.pi.ui.SessionListScreen
import dev.sopho.pi.ui.SophoTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 会话列表的**显示**裁定（B2，业主 2026-10-23：「列表每条只显示 1 行，去掉 cwd 副行」）。
 *
 * 这一组的对象是**真实 Compose 界面**（真测量、真布局、真语义树），数据来自同进程内的 [FakeServer]
 * （真 `AppState` + 真 `/api/tree`）：断言的是“屏幕上到底有没有那一行、行有多高、缩进还在不在”。
 *
 * 会失败的理由：
 * - 把 cwd 副行加回去 ⇒ `/tmp/…` 那个文本节点就又出现了；
 * - 「父已隐藏，已提升」再占第二行 ⇒ 行高超过一行文字 ＋ 内边距；
 * - 提升走的语义说明删掉 ⇒ 无障碍描述找不到（短记号还在，只是没人念得出来）；
 * - 缩进丢了 ⇒ 子行左边界不再比父行更靠右。
 */
@RunWith(AndroidJUnit4::class)
class SessionListRowUiTest {

    @get:Rule
    val rule = createComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private var state: AppState? = null

    private val parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private val longId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    /** 长到一定换行的名字：用来验“单行 ellipsis”，而不是靠“名字短所以正好一行”蒙过去。 */
    private val longName = "长名字会话" + "0123456789".repeat(8)

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
    fun rowIsOneLineWithoutCwdSublineAndKeepsPromotedMarkerSemantics() {
        FakeServer("L").use { server ->
            // 父（归档，默认隐藏）＋ 它的未归档子（应被提升）＋ 一条长名字的根会话。
            server.treeJson = """{"sessions":[""" +
                rowJson(parentId, "父会话", "/tmp/parent-cwd", archived = true, parentId = null) + "," +
                rowJson(childId, "子会话", "/tmp/child-cwd", archived = false, parentId = parentId) + "," +
                rowJson(longId, longName, "/tmp/long-cwd", archived = false, parentId = null) +
                "]}"
            val connected = connect(server)

            rule.setContent { SophoTheme { SessionListScreen(connected) } }
            rule.waitForIdle()

            // ① 归档默认隐藏、未归档子没跟着丢
            rule.onNodeWithText("子会话").assertIsDisplayed()
            rule.onNodeWithText("父会话").assertDoesNotExist()

            // ② 每行只有一行：cwd 副行没了（这条会话的 cwd 没出现在屏幕任何地方）
            rule.onNodeWithText("/tmp/child-cwd").assertDoesNotExist()
            rule.onNodeWithText("/tmp/long-cwd").assertDoesNotExist()

            // ③ 「父已隐藏，已提升」不占第二行：老的那句副行文字不存在，但语义（无障碍）还在
            rule.onNodeWithText("· 父已隐藏，已提升").assertDoesNotExist()
            rule.onNodeWithContentDescription("父已隐藏，已提升").assertExists()

            // ④ 长名字仍是**一行**：卡片高度不许超过「一行文字 ＋ 内边距（14dp）＋ 余量」
            val nameText = rule.onNodeWithText(longName, substring = true, useUnmergedTree = true)
                .getUnclippedBoundsInRoot()
            val card = rule.onNode(hasText(longName, substring = true) and hasClickAction())
                .getUnclippedBoundsInRoot()
            val textHeight = nameText.bottom - nameText.top
            val cardHeight = card.bottom - card.top
            assertTrue(
                "行高必须是一行：卡片高 $cardHeight，文字高 $textHeight",
                cardHeight <= textHeight + 24.dp,
            )

            // ⑤ 打开归档开关：父出现、子缩进在它下面、提升记号消失（层级没退化）
            onMain { connected.updateShowArchived(true) }
            rule.waitForIdle()
            rule.onNodeWithText("父会话").assertIsDisplayed()
            val parentLeft = rule.onNodeWithText("父会话").getUnclippedBoundsInRoot().left
            val childLeft = rule.onNodeWithText("子会话").getUnclippedBoundsInRoot().left
            assertTrue("子行要比父行更靠右（缩进还在）：child=$childLeft parent=$parentLeft", childLeft > parentLeft)
            assertEquals(
                "父可见时不再需要“已提升”记号",
                0,
                rule.onAllNodesWithContentDescription("父已隐藏，已提升").fetchSemanticsNodes().size,
            )
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    /** `/api/tree` 的一行（字段名照服务端投影；`parentId` 空就是根）。 */
    private fun rowJson(
        id: String,
        name: String,
        cwd: String?,
        archived: Boolean,
        parentId: String?,
        status: String = "idle",
    ): String = buildString {
        append("{\"id\":\"$id\",\"name\":\"$name\",\"status\":\"$status\",\"statusLabel\":\"闲置\",")
        append("\"archived\":$archived,")
        append("\"cwd\":").append(if (cwd == null) "null" else "\"$cwd\"").append(',')
        append("\"parentId\":").append(if (parentId == null) "null" else "\"$parentId\"").append('}')
    }

    /** 走产品路径（Profile → connect → 列表）连到假服务端，返回连上的 State。 */
    private fun connect(server: FakeServer): AppState {
        val created = newState()
        onMain {
            created.newProfile()
            created.draftUpdate { it.copy(name = "列表配置", serverUrl = server.baseUrl) }
            created.saveDraft()
        }
        onMain { created.connect() }
        waitFor("连上（进列表）") { created.screen == Screen.LIST }
        return created
    }

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun newState(): AppState {
        var created: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { created = AppState(app) }
        return created!!.also { state = it }
    }

    private fun waitFor(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        throw AssertionError("等不到：$what（${timeoutMs} ms 超时）")
    }
}
