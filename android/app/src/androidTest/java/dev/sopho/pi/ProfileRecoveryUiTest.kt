package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 业主那一格的**界面路径**（不是直接调 `AppState`）：
 *
 * 放到设备上的旧串 → 打开 App 看到「第 5 行…」→ 点「把原串拼成草稿」→ 核对 → 点「保存」→ 重启回读。
 *
 * 关键断言：**在「保存」之前，`profilesRaw` 一个字节都不许变**；拼回来的 Moon seed 不是 16 位十六进制时，
 * 保存要被拦住并说清（不把 wrong network 写回去）。
 */
@RunWith(AndroidJUnit4::class)
class ProfileRecoveryUiTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)
    private fun rawNow(): String? = prefs().getString("profilesRaw", null)

    /** 手机上那一份：第 4 行是 7 字段的完整配置，第 5 行是它最后一个字段的残片。 */
    private val oldShape = "sopho-profiles 1\n" +
        "selected old-1\n" +
        "showArchived 0\n" +
        "profile old-1\t公司旧配置\tZEROTIER\thttp://10.0.2.2:7399\t8056C2E21C000001\t0123456789ABCDEF\tFEDCBA98\n" +
        "76543210\\n\n" +
        "profile old-2\t家里\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n"

    @Before
    fun seedOldData() {
        prefs().edit().clear().commit()
        assertTrue(prefs().edit().putString("profilesRaw", oldShape).commit())
    }

    @After
    fun cleanUp() {
        prefs().edit().clear().commit()
    }

    private fun fields(): List<SemanticsNodeInteraction> =
        compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().indices.map { index ->
            compose.onAllNodes(hasSetTextAction())[index]
        }

    /** 先滚到可见再点（输入法弹起时整页会滚，直接注入的点击会落空）。 */
    private fun tapButton(label: String) {
        val node = compose.onNodeWithText(label)
        runCatching { node.performScrollTo() }
        node.performClick()
        compose.waitForIdle()
    }

    private fun textOf(index: Int): String =
        fields()[index].fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text ?: ""

    @Test
    fun theUserSeesTheErrorConfirmsADraftAndOnlyThenWrites() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForIdle()

            // ① 打开就是业主那句（读不懂），并且有一条可确认的草稿入口。
            compose.onNodeWithText("第 5 行", substring = true).assertExists()
            compose.onNodeWithText("把原串拼成草稿（先不写盘，核对后点保存）").assertExists()
            assertEquals("看到错误时原串一字未动", oldShape, rawNow())

            // ② 点「把原串拼成草稿」：进编辑区，但**不写盘**。
            tapButton("把原串拼成草稿（先不写盘，核对后点保存）")
            assertEquals("确认草稿这一步不写盘", oldShape, rawNow())
            assertEquals("编辑区里是被切开的那条", "公司旧配置", textOf(0))
            assertEquals("http://10.0.2.2:7399", textOf(1))
            assertEquals("8056C2E21C000001", textOf(2))
            assertEquals("0123456789ABCDEF", textOf(3))
            assertEquals("FEDCBA98\n76543210\n", textOf(4))

            // ③ 直接保存：Moon seed 拼回来不是 16 位十六进制 ⇒ 必须被拦住，且不写盘。
            tapButton("保存")
            assertTrue("保存被拦住并且说清了原因", compose.onAllNodesWithText("16 位十六进制", substring = true).fetchSemanticsNodes().isNotEmpty())
            assertEquals("被拦住时也不许写盘", oldShape, rawNow())

            // ④ 用户把那一格改成 16 位 id 再保存。
            fields()[4].performTextClearance()
            fields()[4].performTextInput("FEDCBA9876543210")
            compose.waitForIdle()
            tapButton("保存")
            val written = rawNow()!!
            println("[ui-recovery] written=" + written.replace("\n", "\\n"))
            assertFalse("写回的是新格式（无裸 CR）", written.contains('\r'))
            val book = (Profiles.decode(written) as ProfilesRead.Ok).book
            assertEquals("两条都在", 2, book.profiles.size)
            assertEquals("公司旧配置", book.profiles[0].name)
            assertEquals("FEDCBA9876543210", book.profiles[0].moonSeed)
            assertEquals("0123456789ABCDEF", book.profiles[0].moonWorld)
            assertEquals("家里", book.profiles[1].name)
            scenario.close()
        }

        val beforeRestart = rawNow()

        // ⑤ 重启：不靠内存，直接看界面。
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForIdle()
            assertEquals("重启后编辑区就是恢复出来的那条", "公司旧配置", textOf(0))
            assertEquals("FEDCBA9876543210", textOf(4))
            compose.onNodeWithText("● 公司旧配置").assertExists()
            compose.onNodeWithText("○ 家里").assertExists()
            compose.onNodeWithText("连接配置读取失败", substring = true).assertDoesNotExist()
            assertEquals("重启只读不写", beforeRestart, rawNow())
            scenario.close()
        }
    }
}
