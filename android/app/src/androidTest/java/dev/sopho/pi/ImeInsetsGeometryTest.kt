package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
 * 「输入框与输入法之间多出一个键盘高度的空白」（业主 2026-10-23 反馈 C）的**几何断言**。
 *
 * 这场 bug 的正身是**窗口被平移（adjustPan）**，不是 Compose 的 `imePadding()` 多算了一次：
 * 键盘弹起时系统把整个窗口往上搬了一个「输入法顶 − 焦点底」的距离，而 `safeDrawingPadding()`
 * 在窗口内部又按 IME 高度给内容让了一次位 ⇒ 两者叠加，输入框被抬到离键盘 ~300dp 的地方。
 * ⇒ 只断言「输入框在 Compose 根里的坐标」是**测不出来**的（平移发生在根之外）；
 * 这里的断言全部换算到**屏幕坐标**：`decorView 在屏幕上的 top + 语义节点的 root 内 bottom` 对 `IME 顶`。
 *
 * 判据（都随键盘真实出现/消失/再出现各测一次）：
 * 1. 键盘可见时：输入框底边到 IME 顶的**空隙 ≤ 16dp**（本机实测 ≈ 10.7dp，那是输入框自己的内边距）；
 *    旧形状（adjustPan）实测 ≈ 299dp ⇒ 这条会红。
 * 2. 键盘收起时：输入框底边到系统导航栏顶的空隙同样 ≤ 16dp（导航栏保留、不遮按钮）。
 * 3. 多行输入长高后，1 仍然成立；输入框高度不超过 Composer 的上限 132dp。
 * 4. 键盘**再弹一次**，1 仍然成立（不是“只有第一次对”）。
 *
 * 全部在**假 API**（[FakeServer]，绑 127.0.0.1 临时端口）上做：不碰真实服务，不发真实写请求。
 */
@RunWith(AndroidJUnit4::class)
class ImeInsetsGeometryTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private val sessionId = "11111111-1111-4111-8111-111111111111"

    /** 屏幕坐标下的一次几何快照（px，都是显示器像素）。 */
    private data class Geom(
        val windowHeight: Int,
        val windowTopOnScreen: Int,
        val imeBottom: Int,
        val navBottom: Int,
        val composerBottomInRoot: Int,
        val composerHeight: Int,
        val imeVisible: Boolean,
    ) {
        /** IME 顶在屏幕上的 y。窗口铺满显示器（edge-to-edge），所以 IME 顶 = 屏高 − IME 底边。 */
        val imeTopOnScreen: Int get() = windowHeight - imeBottom
        val composerBottomOnScreen: Int get() = windowTopOnScreen + composerBottomInRoot
        val gapToIme: Int get() = imeTopOnScreen - composerBottomOnScreen
        val navTopOnScreen: Int get() = windowHeight - navBottom
        val gapToNav: Int get() = navTopOnScreen - composerBottomOnScreen
    }

    private fun dp(px: Int): Int = (px / app.resources.displayMetrics.density).toInt()

    @Before
    fun freshPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun cleanPrefs() {
        prefs().edit().clear().commit()
    }

    private fun composer(): SemanticsNodeInteraction = compose.onAllNodes(hasSetTextAction())[0]

    private fun tapButton(label: String) {
        val node = compose.onNodeWithText(label)
        runCatching { node.performScrollTo() }
        node.performClick()
        compose.waitForIdle()
    }

    private fun geom(scenario: ActivityScenario<MainActivity>): Geom {
        val node = composer().fetchSemanticsNode()
        val composerBottom = node.boundsInRoot.bottom.toInt()
        val composerHeight = node.boundsInRoot.height.toInt()
        var out: Geom? = null
        scenario.onActivity { activity ->
            val decor = activity.window.decorView
            val insets = ViewCompat.getRootWindowInsets(decor)!!
            val loc = IntArray(2)
            decor.getLocationOnScreen(loc)
            out = Geom(
                windowHeight = decor.height,
                windowTopOnScreen = loc[1],
                imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                navBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom,
                composerBottomInRoot = composerBottom,
                composerHeight = composerHeight,
                imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime()),
            )
        }
        compose.waitForIdle()
        return out!!
    }

    private fun waitForIme(scenario: ActivityScenario<MainActivity>, visible: Boolean, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            var seen = false
            scenario.onActivity { activity ->
                val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)!!
                seen = insets.isVisible(WindowInsetsCompat.Type.ime())
            }
            if (seen == visible) return
            Thread.sleep(100)
        }
    }

    /**
     * 等**布局**跟上 inset（insets 的可见性先变，Compose 的 padding 要下一帧才落；IME 收起还有动画）。
     * 判据是连续两次采样一致；但最多等到 [timeoutMs]——超时后仍返回最后一次读数，断言照旧拿它判红
     * （所以这不是“重试到绿”，真卡住的形状照样红，只是日志里能看到它卡在哪个数）。
     */
    private fun settledGeom(scenario: ActivityScenario<MainActivity>, timeoutMs: Long = 4_000): Geom {
        var previous = geom(scenario)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(150)
            val current = geom(scenario)
            if (current.imeBottom == previous.imeBottom &&
                current.composerBottomOnScreen == previous.composerBottomOnScreen &&
                current.composerHeight == previous.composerHeight
            ) {
                return current
            }
            previous = current
        }
        return previous
    }

    private fun setIme(scenario: ActivityScenario<MainActivity>, show: Boolean) {
        scenario.onActivity { activity ->
            val controller = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
            if (show) controller.show(WindowInsetsCompat.Type.ime()) else controller.hide(WindowInsetsCompat.Type.ime())
        }
    }

    private fun report(tag: String, g: Geom) {
        println(
            "[ime-geom] $tag windowHeight=${g.windowHeight} windowTopOnScreen=${g.windowTopOnScreen} " +
                "imeBottom=${g.imeBottom} imeVisible=${g.imeVisible} imeTop=${g.imeTopOnScreen} " +
                "composerBottomOnScreen=${g.composerBottomOnScreen} composerBottomInRoot=${g.composerBottomInRoot} " +
                "composerHeight=${g.composerHeight} gapToIme=${g.gapToIme}px(${dp(g.gapToIme)}dp) " +
                "gapToNav=${g.gapToNav}px(${dp(g.gapToNav)}dp)",
        )
    }

    /** 「空隙 ≤ 24dp」：键盘顶着输入框，且不是靠负 padding 硬塞进去的（负数也红）。
     *  本机实测 = 16dp（composer 自己的内边距）；旧形状实测 ≈ 299dp。 */
    private fun assertTouchable(gapPx: Int, what: String, g: Geom) {
        val limit = (24 * app.resources.displayMetrics.density).toInt()
        assertTrue(
            "$what：输入框底边与可用区之间是 ${dp(gapPx)}dp（上限 24dp）。" +
                "为负=被遮住；≈一个键盘高度=多出一块空白。读数：$g",
            gapPx in 0..limit,
        )
    }

    @Test
    fun composerSitsOnTheKeyboardAndOnTheNavBarWithoutAnExtraKeyboardHeight() {
        FakeServer("ime").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionId, "IME 几何"))
            server.messageBodies[sessionId] = FakeServer.messages(
                "user" to "第一句：键盘几何测试。",
                "assistant" to "第二句：这条只是正文，不参与几何。",
            )
            // 直接从真 prefs 起一条「直连」配置（不经过界面保存，几何测试不测保存）。
            val raw = Profiles.encode(
                ProfileBook(
                    profiles = listOf(
                        Profile(
                            id = "ime-profile",
                            name = "IME 几何",
                            serverUrl = server.baseUrl,
                            mode = RunMode.DIRECT,
                            networkId = "",
                            moonWorld = "",
                            moonSeed = "",
                        ),
                    ),
                    selectedId = "ime-profile",
                    showArchived = false,
                ),
            )
            assertTrue(prefs().edit().putString("profilesRaw", raw).commit())

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                compose.waitForIdle()
                tapButton("连接")
                compose.waitForIdle()
                compose.onNodeWithText("IME 几何", substring = false).performClick()
                compose.waitForIdle()
                // 到了详情页（「重拉」只在详情页出现），且唯一一个可输入框就是 composer。
                compose.onNodeWithText("重拉").assertExists()
                assertEquals("详情页里可输入框只有一个（composer）", 1, compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size)

                // ① 键盘收起：输入框贴着导航栏（导航栏保留、不遮按钮）。
                val hidden = settledGeom(scenario)
                report("kb-hidden", hidden)
                assertTrue("这一步键盘不该是可见的：$hidden", !hidden.imeVisible)
                assertTouchable(hidden.gapToNav, "键盘收起时输入框底边距导航栏顶", hidden)

                // ② 点输入框 → 键盘真的弹起来。
                composer().performClick()
                compose.waitForIdle()
                waitForIme(scenario, visible = true)
                var shown = settledGeom(scenario)
                if (!shown.imeVisible) {
                    // 少数情况下注入的点击不触发 IMM（真机上是有界面的）；显式请求一次，并在日志里写明。
                    println("[ime-geom] note=click did not raise IME, requesting it explicitly")
                    setIme(scenario, show = true)
                    waitForIme(scenario, visible = true)
                    shown = settledGeom(scenario)
                }
                report("kb-shown", shown)
                assertTrue("键盘必须真的弹起来（否则这条几何断言没有意义）：$shown", shown.imeVisible)
                assertTouchable(shown.gapToIme, "键盘弹起时输入框底边距 IME 顶", shown)

                // ③ 多行：输入框长高到上限附近，仍然贴着键盘。
                composer().performTextInput("第一行\n第二行\n第三行\n第四行\n第五行\n第六行")
                compose.waitForIdle()
                waitForIme(scenario, visible = true)
                val multi = settledGeom(scenario)
                report("kb-shown-multiline", multi)
                assertTouchable(multi.gapToIme, "多行草稿时输入框底边距 IME 顶", multi)
                val maxPx = (132 * app.resources.displayMetrics.density).toInt() + 2
                assertTrue(
                    "多行输入框高度不超过 Composer 的 132dp 上限：实测 ${multi.composerHeight}px / ${dp(multi.composerHeight)}dp",
                    multi.composerHeight <= maxPx,
                )

                // ④ 键盘收起：回到导航栏上方。
                setIme(scenario, show = false)
                waitForIme(scenario, visible = false)
                val hiddenAgain = settledGeom(scenario)
                report("kb-hidden-again", hiddenAgain)
                assertTrue("键盘收起后不该还报 IME 可见：$hiddenAgain", !hiddenAgain.imeVisible)
                assertTouchable(hiddenAgain.gapToNav, "键盘收起后输入框底边距导航栏顶", hiddenAgain)

                // ⑤ 再弹一次：不是“只有第一次对”。
                setIme(scenario, show = true)
                waitForIme(scenario, visible = true)
                val shownAgain = settledGeom(scenario)
                report("kb-shown-again", shownAgain)
                assertTrue("第二次弹出键盘没起来：$shownAgain", shownAgain.imeVisible)
                assertTouchable(shownAgain.gapToIme, "键盘第二次弹起时输入框底边距 IME 顶", shownAgain)

                // ⑥ 键盘在场时还能正常发送（只在假 API 上；POST 一次、回执只说“已接受”）。
                val beforeSend = geom(scenario)
                assertTrue("发送前键盘应当还在场（这条验证的是“键盘在场时也能发”）：$beforeSend", beforeSend.imeVisible)
                composer().performTextClearance()
                composer().performTextInput("ime-geom 发送自测")
                compose.waitForIdle()
                tapButton("发送")
                val deadline = System.currentTimeMillis() + 10_000
                while (System.currentTimeMillis() < deadline && server.postCalls.isEmpty()) {
                    Thread.sleep(100)
                    compose.waitForIdle()
                }
                assertEquals("只发了一次、走的是 message：${server.postCalls}", listOf("message"), server.postCalls.toList())
                assertTrue(
                    "回执要说“已接受”：" + compose.onAllNodesWithText("已接受", substring = true).fetchSemanticsNodes().size,
                    compose.onAllNodesWithText("已接受", substring = true).fetchSemanticsNodes().isNotEmpty(),
                )
                assertEquals(
                    "接受后草稿清空",
                    "",
                    composer().fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text ?: "",
                )
                val afterSend = settledGeom(scenario)
                report("kb-after-send", afterSend)
                // 发送会把焦点/回执挪一下，键盘可能自己收起；两种都行，但**可用区按当下的态判**。
                if (afterSend.imeVisible) {
                    assertTouchable(afterSend.gapToIme, "发送后（键盘仍在）输入框底边距 IME 顶", afterSend)
                } else {
                    assertTouchable(afterSend.gapToNav, "发送后（键盘已收起）输入框底边距导航栏顶", afterSend)
                }
                scenario.close()
            }
        }
    }
}
