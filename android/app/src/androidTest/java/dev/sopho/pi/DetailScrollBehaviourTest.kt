package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 详情页的**初始定位与跟随**（业主 2026-10-24：「从列表点入会话时直接定位到底部最新消息」）。
 *
 * 这一组的对象是**真实 Compose 界面 + 真 AppState + 真 SSE**（服务端换成本进程内的 [FakeServer]），
 * 断言的是**屏幕几何**：末条正文的底边离输入框的顶边有多远（`gap`），不是“某个状态位被设成了什么”。
 *
 * 会失败的理由（每条对上一个用户看得见的形状）：
 * - 初次进入只把末条**顶边**对齐视口（`scrollToItem(last, 0)`）⇒ 末条超过一屏时它的底边在屏外：[openLandsOnTrueBottom] 红；
 * - 判据用 `itemCount` / `messages.size` ⇒「同一条变长」（流式增量）与「120 条截断后条数不变」都看不见：[streamingGrowthKeepsTail] 红；
 * - 用户上翻读历史时仍跟着 SSE 拉到底 ⇒ [userScrollUpThenRefreshKeepsPosition] 红；
 * - 从列表点另一条会话还停在上一屏的旧偏移，或旧会话的迟到结果把新会话拉走 ⇒ [switchLandsOnNewSessionsBottom] / [lateFirstSessionDoesNotDragSecond] 红；
 * - 空会话把上一条会话的旧正文当成自己的、或第一条内容落地时不画出来 ⇒ [emptySessionHasNoStaleContent] 红。
 */
@RunWith(AndroidJUnit4::class)
class DetailScrollBehaviourTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private val firstId = "11111111-1111-4111-8111-111111111111"
    private val secondId = "22222222-2222-4222-8222-222222222222"
    private val emptyId = "33333333-3333-4333-8333-333333333333"

    /**
     * 末条底边到**输入框语义节点顶边**的上限（dp）。它由三段固定的内边距叠成，不是拍出来的：
     * 卡片底内边距 8 ＋ 列表底 `contentPadding` 10 ＋ composer 里输入框之上自己的内边距 16 ＝ 34；这里留到 40。
     * 读它是为了区分“真的贴在底边”与“停在顶上”（后者实测是四位数的 dp）。
     */
    private val gapLimit = 40.dp

    private val tailPrefix = "TAIL-MARK-"

    /** 末条：以唯一标记开头、比一屏还高的正文（1800 字；客户端不再按字数截断，整段都会上屏）。 */
    private val tailMark: String get() = tailPrefix + "长".repeat(1800)

    @Before
    fun freshPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun cleanPrefs() {
        prefs().edit().clear().commit()
    }

    // ───────────────────────────── 用例 ─────────────────────────────

    /**
     * ① 从列表点进一条「末条比一屏还高」的会话：落地后**末条的底边**就在输入框上方。
     * 这条是本次的主诉形状 —— 只把顶边对齐（`scrollToItem(last, 0)`）时末条底边仍在屏外。
     */
    @Test
    fun openLandsOnTrueBottom() {
        FakeServer("bottom").use { server ->
            val messages = shortMessages("A", 20) + listOf("assistant" to tailMark)
            server.treeJson = FakeServer.tree(FakeServer.row(firstId, "底部锚定"))
            server.messageBodies[firstId] = FakeServer.messages(*messages.toTypedArray())

            launch(server).use { scenario ->
                openSession("底部锚定")
                waitForText("共 21 条", "正文落地")
                settle()

                val tail = boundsOf(tailPrefix)
                val root = rootBounds()
                val composerTop = composerTop()
                val gap = composerTop - tail.bottom
                val tailHeight = tail.bottom - tail.top
                val rootHeight = root.bottom - root.top
                println(
                    "[detail-scroll] open tailTop=${tail.top} tailBottom=${tail.bottom} tailHeight=$tailHeight " +
                        "rootHeight=$rootHeight composerTop=$composerTop gap=$gap",
                )
                // 前提：末条确实比整个界面还高，否则这条断言证明不了「只对齐顶边不够」。
                assertTrue("用例前提是末条比整个界面还高：实测 $tailHeight vs root $rootHeight", tailHeight > rootHeight)
                assertTrue("末条正文的底边必须在输入框上方：tail=$tail composerTop=$composerTop", tail.bottom <= composerTop)
                assertTrue("末条底边到输入框应是一行的内边距级别，实测 $gap（上限 $gapLimit）", gap <= gapLimit)
                assertTrue("已经落在底边时，头几条不该还占着视口（那是停在顶上）：实际 A-01 可见", !isComposed("A-01"))
                scenario.close()
            }
        }
    }

    /**
     * ② 在甲里上翻后**返回列表再点乙**：乙落在它自己的底边，甲的内容一格都不留。
     * （从列表点进来 = 一次新的初始定位，这是业主明确要的「重新点入就到底」。）
     */
    @Test
    fun switchLandsOnNewSessionsBottom() {
        FakeServer("switch").use { server ->
            server.treeJson = FakeServer.tree(
                FakeServer.row(firstId, "会话甲"),
                FakeServer.row(secondId, "会话乙"),
            )
            server.messageBodies[firstId] = FakeServer.messages(*shortMessages("A", 30).toTypedArray())
            val b = shortMessages("B", 12) + listOf("user" to tailMark)
            server.messageBodies[secondId] = FakeServer.messages(*b.toTypedArray())

            launch(server).use { scenario ->
                openSession("会话甲")
                waitForText("共 30 条", "甲正文落地")
                settle()
                // 在甲里上翻一次（记忆里停在历史），再返回列表 —— 乙不许用甲留下的偏移。
                swipeDownOnce()
                assertTrue("上翻后甲的末条应离开视口（前提：真的离开了底边）：实际 A-30 仍可见", !isComposed("A-30"))
                backToList()
                openSession("会话乙")

                waitForText("共 13 条", "乙正文落地")
                settle()
                val tail = boundsOf(tailPrefix)
                val composerTop = composerTop()
                println("[detail-scroll] switch tailTop=${tail.top} tailBottom=${tail.bottom} composerTop=$composerTop gap=${composerTop - tail.bottom}")
                assertTrue("乙必须落在自己的底边：tail=$tail composerTop=$composerTop", tail.bottom <= composerTop)
                assertTrue("乙的末条底边到输入框应是一行的内边距级别，实测 ${composerTop - tail.bottom}", composerTop - tail.bottom <= gapLimit)
                assertTrue("甲的内容不许跟着过来：实际 A-01 可见", !isComposed("A-01"))
                scenario.close()
            }
        }
    }

    /**
     * ③ 用户上翻读历史之后，SSE 的**快照刷新**与**流式增量**都不许把位置抢走。
     * 判据：同一个可见条目的 y 一点没动，且末条始终没被拉回视口。
     */
    @Test
    fun userScrollUpThenRefreshKeepsPosition() {
        FakeServer("history").use { server ->
            val messages = shortMessages("H", 40)
            server.treeJson = FakeServer.tree(FakeServer.row(firstId, "历史会话"))
            server.messageBodies[firstId] = FakeServer.messages(*messages.toTypedArray())

            launch(server).use { scenario ->
                openSession("历史会话")
                waitForText("共 40 条", "正文落地")
                settle()
                assertTrue("开场应先落在底边（末条可见）：实际 H-40 不可见", isComposed("H-40"))

                // 手指往下拖 ⇒ 看更早的内容（离开底边）。
                repeat(3) { swipeDownOnce() }
                assertTrue("上翻后末条不该还占着视口：实际 H-40 仍可见", !isComposed("H-40"))
                val anchor = visibleAnchor("H")
                println("[detail-scroll] history anchor=${anchor.first} topPx=${anchor.second}")

                // (a) 流式增量：同一条变长（`messages.size` 不变）。
                assertTrue("SSE 应已开出这条会话的流", waitFor { server.hasStream(firstId) })
                server.push(firstId, "session.delta", """{"channel":"text","delta":"LIVE-MARK-尾"}""")
                waitForText("这一轮在跑", "增量已上屏（agentBusy 那行）")
                settle()
                assertSamePosition(anchor, "增量之后")
                assertTrue("增量之后不许把末条拉回视口：实际 H-40 可见", !isComposed("H-40"))

                // (b) 快照刷新：条数从 40 变 41（同一屏的 keyed 条目不许被重排到别处）。
                server.messageBodies[firstId] = FakeServer.messages(*(messages + ("user" to "H-41")).toTypedArray())
                server.push(firstId, "session.snapshot", """{"isStreaming":false}""")
                waitForText("共 41 条", "快照刷新落地")
                settle()
                assertSamePosition(anchor, "快照刷新之后")
                assertTrue("快照刷新之后不许跳到新末条：实际 H-41 可见", !isComposed("H-41"))
                scenario.close()
            }
        }
    }

    /**
     * ④ 本来就在底边时，流式增量（**同一条**变长）要跟住：末条底边一直贴着输入框。
     * 旧实现只在 `itemCount` 变一次时滚一次，后续同条变长 ⇒ 尾巴一路掉到屏外。
     */
    @Test
    fun streamingGrowthKeepsTail() {
        FakeServer("stream").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(firstId, "流式会话"))
            server.messageBodies[firstId] = FakeServer.messages(*shortMessages("S", 10).toTypedArray())

            launch(server).use { scenario ->
                openSession("流式会话")
                waitForText("共 10 条", "正文落地")
                settle()
                assertTrue("SSE 应已开出这条会话的流", waitFor { server.hasStream(firstId) })

                val chunks = listOf(
                    "STREAM-MARK-一",
                    "二".repeat(400) + "MARK-2",
                    "三".repeat(900) + "MARK-3",
                    "四".repeat(1600) + "MARK-4",
                )
                chunks.forEachIndexed { index, chunk ->
                    server.push(firstId, "session.delta", """{"channel":"text","delta":"$chunk"}""")
                    val marker = when (index) {
                        0 -> "STREAM-MARK-"
                        else -> "MARK-${index + 1}"
                    }
                    waitForText(marker, "第 ${index + 1} 段增量上屏")
                    settle()
                }
                val live = boundsOf("STREAM-MARK-")
                val composerTop = composerTop()
                val gap = composerTop - live.bottom
                val liveHeight = live.bottom - live.top
                println(
                    "[detail-scroll] stream liveTop=${live.top} liveBottom=${live.bottom} liveHeight=$liveHeight " +
                        "composerTop=$composerTop gap=$gap",
                )
                assertTrue("直播块应该已经长过一屏（否则这条证明不了「同一条变长」）：实测 $liveHeight", liveHeight > 300.dp)
                assertTrue("直播块的底边必须在输入框上方：live=$live composerTop=$composerTop", live.bottom <= composerTop)
                assertTrue("跟随时直播块底边到输入框应是一行的内边距级别，实测 $gap（上限 $gapLimit）", gap <= gapLimit)
                scenario.close()
            }
        }
    }

    /**
     * ⑤ 旧会话那条**迟到的正文**回来时，新会话（已在自己底边）一格都不许动。
     * 这条对的是「异步旧会话的滚动任务/结果把新会话拉走」。
     */
    @Test
    fun lateFirstSessionDoesNotDragSecond() {
        FakeServer("late").use { server ->
            server.treeJson = FakeServer.tree(
                FakeServer.row(firstId, "慢会话"),
                FakeServer.row(secondId, "快会话"),
            )
            server.messageBodies[firstId] = FakeServer.messages(*shortMessages("L", 30).toTypedArray())
            server.messageDelays[firstId] = 3_000L
            server.messageBodies[secondId] = FakeServer.messages(*(shortMessages("Q", 8) + listOf("assistant" to tailMark)).toTypedArray())

            launch(server).use { scenario ->
                openSession("慢会话")
                assertTrue("慢会话的 /messages 确实发出去了", waitFor { server.messageGets.contains(firstId) })
                backToList()
                openSession("快会话")
                waitForText("共 9 条", "快会话正文落地")
                settle()
                val before = boundsOf(tailPrefix)
                val composerTop = composerTop()

                // 等那条迟到的正文**真的写回客户端**（服务端侧计数），再给它一点时间（它不该上屏）。
                assertTrue("慢会话的迟到响应确实回来了", waitFor(10_000) { server.messageDelivered.contains(firstId) })
                settle()
                val after = boundsOf(tailPrefix)
                println("[detail-scroll] late beforeTop=${before.top} beforeBottom=${before.bottom} afterTop=${after.top} afterBottom=${after.bottom}")
                assertEquals("迟到的旧会话结果不许移动快会话的末条", before.bottom, after.bottom)
                assertTrue("快会话仍在自己的底边：composerTop=$composerTop tail=$after", after.bottom <= composerTop)
                assertTrue("旧会话的正文不许出现在快会话的屏幕上：实际 L-01 可见", !isComposed("L-01"))
                scenario.close()
            }
        }
    }

    /**
     * ⑥ 空会话：不许把上一条会话的旧正文当成自己的；第一条内容（增量）落地时要画出来、不许乱跳。
     */
    @Test
    fun emptySessionHasNoStaleContent() {
        FakeServer("empty").use { server ->
            server.treeJson = FakeServer.tree(
                FakeServer.row(firstId, "有条目的"),
                FakeServer.row(emptyId, "空会话"),
            )
            server.messageBodies[firstId] = FakeServer.messages(*shortMessages("E", 20).toTypedArray())
            server.messageBodies[emptyId] = """{"messages":[]}"""

            launch(server).use { scenario ->
                openSession("有条目的")
                waitForText("共 20 条", "甲正文落地")
                settle()
                backToList()
                openSession("空会话")
                waitForText("共 0 条", "空会话的正文口径")
                settle()
                assertTrue("空会话不许显示上一条会话的正文：实际 E-01 可见", !isComposed("E-01"))

                // 第一条内容从增量来：它落到屏幕上，且不把任何旧东西带回来。
                assertTrue("SSE 应已开出空会话的流", waitFor { server.hasStream(emptyId) })
                server.push(emptyId, "session.delta", """{"channel":"text","delta":"FIRST-MARK-首"}""")
                waitForText("FIRST-MARK", "第一条内容上屏")
                settle()
                val first = boundsOf("FIRST-MARK")
                val composerTop = composerTop()
                println("[detail-scroll] empty firstTop=${first.top} firstBottom=${first.bottom} composerTop=$composerTop")
                assertTrue("第一条内容必须在可见区里（不压到输入框）：first=$first composerTop=$composerTop", first.bottom <= composerTop)
                assertTrue("空会话里不许冒出上一条会话的内容：实际 E-01 可见", !isComposed("E-01"))
                scenario.close()
            }
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private fun shortMessages(prefix: String, count: Int): List<Pair<String, String>> =
        (1..count).map { index -> "user" to "$prefix-%02d".format(index) }

    /** 写一条「直连」配置 → 拉起真界面 → 点「连接」→ 等列表（走产品路径，不直接改 AppState）。 */
    private fun launch(server: FakeServer): ActivityScenario<MainActivity> {
        val raw = Profiles.encode(
            ProfileBook(
                profiles = listOf(
                    Profile(
                        id = "scroll-profile",
                        name = "滚动配置",
                        serverUrl = server.baseUrl,
                        mode = RunMode.DIRECT,
                        networkId = "",
                        moonWorld = "",
                        moonSeed = "",
                    ),
                ),
                selectedId = "scroll-profile",
                showArchived = false,
            ),
        )
        // 配置必须在 Activity 起来**之前**落盘：AppState 在 onCreate 里读 prefs。
        assertTrue("配置写盘失败", prefs().edit().putString("profilesRaw", raw).commit())
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitForIdle()
        waitForText("连接", "连接页")
        compose.onNodeWithText("连接").performClick()
        compose.waitForIdle()
        waitForText("＋ 新建", "列表（连接成功）")
        return scenario
    }

    private fun openSession(name: String) {
        compose.onNodeWithText(name).performClick()
        compose.waitForIdle()
        assertTrue("应已进入详情页（「重拉」只在详情页）", isComposed("重拉"))
    }

    private fun backToList() {
        compose.onNodeWithText("‹ 返回").performClick()
        compose.waitForIdle()
        assertTrue("应已回到列表", isComposed("＋ 新建"))
    }

    private fun swipeDownOnce() {
        compose.onRoot().performTouchInput { swipeDown(startY = centerY - 200f, endY = centerY + 200f) }
        settle()
    }

    /**
     * 一段文字的**几何**（dp，相对 Compose 根）。先断言它在视口里真的看得见：
     * 懒列表会把视口外的条目也编进语义树（`boundsInRoot` 会是被裁成 0 的矩形），那种节点量出来的 dp 是
     * `Dp.Unspecified`（0/0）—— 拿它比大小会静默失真，所以这里直接判红。
     */
    private fun boundsOf(marker: String): DpRect {
        val node = compose.onNodeWithText(marker, substring = true).fetchSemanticsNode()
        assertTrue("$marker 在语义树里，但视口里看不到（clipped bounds=${node.boundsInRoot}）", node.boundsInRoot.height > 0f)
        return compose.onNodeWithText(marker, substring = true).getUnclippedBoundsInRoot()
    }

    private fun rootBounds(): DpRect = compose.onRoot().getUnclippedBoundsInRoot()

    private fun composerTop(): Dp = compose.onAllNodes(hasSetTextAction())[0].getUnclippedBoundsInRoot().top

    private fun isComposed(marker: String): Boolean =
        compose.onAllNodesWithText(marker, substring = true).fetchSemanticsNodes().isNotEmpty()

    /** 第一个**真的在视口里**的条目：条目名 ＋ 它在根坐标里的顶边（px，直接用 `boundsInRoot`）。 */
    private fun visibleAnchor(prefix: String): Pair<String, Float> {
        for (index in 1..99) {
            val marker = "$prefix-%02d".format(index)
            val nodes = compose.onAllNodesWithText(marker, substring = true).fetchSemanticsNodes()
            if (nodes.isEmpty()) continue
            val bounds = nodes[0].boundsInRoot
            if (bounds.height > 0f) return marker to bounds.top
        }
        throw AssertionError("一个 $prefix-* 条目都没在视口里")
    }

    private fun assertSamePosition(anchor: Pair<String, Float>, after: String) {
        assertTrue("$after，锚点条目 ${anchor.first} 必须还在屏幕上（位置被抢走了）", isComposed(anchor.first))
        val now = compose.onNodeWithText(anchor.first, substring = true).fetchSemanticsNode().boundsInRoot
        assertTrue("$after，锚点条目 ${anchor.first} 必须真的在视口里（clipped bounds=$now）", now.height > 0f)
        assertEquals(
            "$after，锚点条目 ${anchor.first} 的 y 一点都不许动（before=${anchor.second} after=${now.top}）",
            anchor.second,
            now.top,
        )
    }

    /** 等屏幕上出现某段文字（substring 匹配），超时就报错。 */
    private fun waitForText(text: String, what: String, timeoutMs: Long = 10_000) {
        assertTrue("$what：等不到「$text」（${timeoutMs} ms 超时）", waitFor(timeoutMs) { isComposed(text) })
    }

    /** 让布局落稳：idle ＋ 一小段真实时间再 idle（SSE 帧从网络线程回到主线程要一帧）。 */
    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(150)
        compose.waitForIdle()
    }

    private fun waitFor(timeoutMs: Long = 10_000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(20)
        }
        return false
    }
}
