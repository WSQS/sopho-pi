package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 「120 条截断」这一张形状下的底部定位（集成侧补，2026-10-24）。
 *
 * 为什么单独补这一条：`DetailScrollBehaviourTest` 覆盖了「同一条变长」（流式增量），但它自己的
 * 「没验到什么」里也写着 **>120 条大会话**没验。而 `AppState` 的 `takeLast(120)` 会让**条数恒定**
 * （行数一直是 120），窗口滑动只是**换掉内容** —— 老实现把滚动判据挂在 `itemCount` / `messages.size` 上，
 * 这种滑动它看不见。extras 顺序修合进来之后，`takeLast(120)` 作用在**合成后**的序列上，这一格更值得钉住。
 *
 * 断言的是**屏幕几何**（末条底边到输入框顶边的距离）＋ 产品自己那句「共 N 条 / 只渲染最近 120 条」，
 * 不是内部状态位。
 */
@RunWith(AndroidJUnit4::class)
class DetailScrollTruncationTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private val sessionId = "44444444-4444-4444-8444-444444444444"
    private val sessionName = "长会话截断"

    /** 与 `DetailScrollBehaviourTest` 同口径：卡片底 8 ＋ 列表底 padding 10 ＋ composer 自身 16 ＝ 34，留到 40。 */
    private val gapLimit = 40.dp

    private val tailPrefix = "TRUNC-TAIL-"
    private val tailPrefix2 = "TRUNC-TAIL2-"
    private val tailMark: String get() = tailPrefix + "长".repeat(1800)

    @Before
    fun freshPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun cleanPrefs() {
        prefs().edit().clear().commit()
    }

    /**
     * ① 130 条正文（产品只渲染最近 120 条）⇒ 点进来必须落在**末条底边**，
     * 而且产品自己那句「只渲染最近 120 条」要在，否则「看着像对了」也可能只是条数少于 120。
     */
    @Test
    fun truncationStillLandsOnTheBottom() {
        FakeServer("trunc").use { server ->
            val head = shortMessages(1, 129)
            server.treeJson = FakeServer.tree(FakeServer.row(sessionId, sessionName))
            server.messageBodies[sessionId] = FakeServer.messages(*(head + listOf("assistant" to tailMark)).toTypedArray())

            launch(server).use { scenario ->
                openSession()
                waitForText("共 130 条", "正文落地")
                waitForText("只渲染最近 120 条", "截断口径上屏")
                settle()

                assertBottomAligned("130 条窗口")
                println("[trunc] case1 gap=${gapToComposer()}")
                scenario.close()
            }
        }
    }

    /**
     * ② 窗口滑动而**行数不变**（130 → 131 条，仍是最近 120 行）：点「重拉」之后必须仍在底边。
     * 这条是「判据挂在 itemCount 上就会瞎」的直接形状 —— 两次行数都是 120。
     */
    @Test
    fun slidingWindowWithAFixedRowCountStillFollowsTheNewest() {
        FakeServer("trunc-slide").use { server ->
            val head = shortMessages(1, 129)
            server.treeJson = FakeServer.tree(FakeServer.row(sessionId, sessionName))
            server.messageBodies[sessionId] = FakeServer.messages(*(head + listOf("assistant" to tailMark)).toTypedArray())

            launch(server).use { scenario ->
                openSession()
                waitForText("共 130 条", "正文落地")
                settle()
                assertBottomAligned("滑动前")

                // 换一份 131 条：行数仍是 120（多出来的那条把最老的挤出窗口），只有内容是新的。
                val head2 = shortMessages(1, 130)
                val freshTail = tailPrefix2 + "新".repeat(1800)
                server.messageBodies[sessionId] = FakeServer.messages(*(head2 + listOf("assistant" to freshTail)).toTypedArray())
                compose.onNodeWithText("重拉").performClick()
                compose.waitForIdle()

                waitForText("共 131 条", "滑动后的正文落地")
                waitForText(tailPrefix2, "新末条落地")
                settle()

                val tail = compose.onNodeWithText(tailPrefix2, substring = true)
                    .fetchSemanticsNode()
                assertTrue("新末条必须真的在视口里（clipped bounds=${tail.boundsInRoot}）", tail.boundsInRoot.height > 0f)
                val tailBottom = compose.onNodeWithText(tailPrefix2, substring = true).getUnclippedBoundsInRoot().bottom
                val composerTop = composerTop()
                assertTrue(
                    "滑动窗口（行数不变）后仍必须贴在底边：末条底边 $tailBottom vs 输入框顶边 $composerTop",
                    tailBottom <= composerTop,
                )
                println("[trunc] case2 tailBottom=$tailBottom composerTop=$composerTop")
                scenario.close()
            }
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private fun shortMessages(from: Int, to: Int): List<Pair<String, String>> =
        (from..to).map { index -> "user" to "M-%03d".format(index) }

    private fun launch(server: FakeServer): ActivityScenario<MainActivity> {
        val raw = Profiles.encode(
            ProfileBook(
                profiles = listOf(
                    Profile(
                        id = "trunc-profile",
                        name = "截断配置",
                        serverUrl = server.baseUrl,
                        mode = RunMode.DIRECT,
                        networkId = "",
                        moonWorld = "",
                        moonSeed = "",
                    ),
                ),
                selectedId = "trunc-profile",
                showArchived = false,
            ),
        )
        assertTrue("配置写盘失败", prefs().edit().putString("profilesRaw", raw).commit())
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitForIdle()
        waitForText("连接", "连接页")
        compose.onNodeWithText("连接").performClick()
        compose.waitForIdle()
        waitForText("＋ 新建", "列表（连接成功）")
        return scenario
    }

    private fun openSession() {
        compose.onNodeWithText(sessionName).performClick()
        compose.waitForIdle()
        assertTrue("应已进入详情页（「重拉」只在详情页）", isComposed("重拉"))
    }

    private fun assertBottomAligned(what: String) {
        val node = compose.onNodeWithText(tailPrefix, substring = true).fetchSemanticsNode()
        assertTrue("$what：末条必须真的在视口里（clipped bounds=${node.boundsInRoot}）", node.boundsInRoot.height > 0f)
        val tail = compose.onNodeWithText(tailPrefix, substring = true).getUnclippedBoundsInRoot()
        val gap = gapToComposer()
        assertTrue("$what：末条底边必须在输入框上方（tail.bottom=${tail.bottom} composerTop=${composerTop()}）", gap >= 0.dp)
        assertTrue("$what：末条底边到输入框应是一行内边距级别，实测 gap=$gap（上限 $gapLimit）", gap <= gapLimit)
    }

    private fun gapToComposer(): Dp =
        composerTop() - compose.onNodeWithText(tailPrefix, substring = true).getUnclippedBoundsInRoot().bottom

    private fun composerTop(): Dp = compose.onAllNodes(hasSetTextAction())[0].getUnclippedBoundsInRoot().top

    private fun isComposed(marker: String): Boolean =
        compose.onAllNodesWithText(marker, substring = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitForText(text: String, what: String, timeoutMs: Long = 15_000) {
        assertTrue("$what：等不到「$text」（${timeoutMs} ms 超时）", waitFor(timeoutMs) { isComposed(text) })
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(150)
        compose.waitForIdle()
    }

    private fun waitFor(timeoutMs: Long = 10_000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { condition() }.getOrDefault(false)) return true
            Thread.sleep(20)
        }
        return false
    }
}
