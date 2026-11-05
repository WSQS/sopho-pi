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
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **用真实 UI 语义保存**（点「新建」→ 在输入框里输入 → 点「保存」），然后在**真 `SharedPreferences`**
 * 与**真进程重启后的界面**上逐字段核对 —— 不直接写 prefs 冒充“用户保存过”。
 *
 * ⚠️ “重启”必须是**进程重启**（`am force-stop` + 再启动 / 另一次 `am instrument`）：Activity 重建不会
 * 重新读 XML，而业主的 bug 正是在 XML 往返里（见 `docs/ops/android-client.md` §21）。⇒ 这一组刻意分成
 * `phase1…`（保存）与 `phase2…`（另一次进程里回读）两步，且**两两之间不清 prefs**。
 *
 * 输入框按“编辑区里的输入框顺序”找（名字 / 地址 / [ZeroTier 三个]），这样同一份 test APK 也能跑在
 * **已交付包** `4c296b15…` 上（那一份没有测试标签）。每次先断言输入框个数，形态不对就红（不盲点）。
 */
@RunWith(AndroidJUnit4::class)
class ProfileUiSaveTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)
    private fun rawNow(): String? = prefs().getString("profilesRaw", null)

    private fun fields(): List<SemanticsNodeInteraction> =
        compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().indices.map { index ->
            compose.onAllNodes(hasSetTextAction())[index]
        }

    private fun type(index: Int, text: String) {
        val field = fields()[index]
        field.performTextClearance()
        field.performTextInput(text)
        compose.waitForIdle()
    }

    /** 先滚到可见再点：输入法弹出时整页会滚，按钮可能在可视区外，直接注入的点击会落空。 */
    private fun tapButton(label: String) {
        val node = compose.onNodeWithText(label)
        runCatching { node.performScrollTo() }
        node.performClick()
        compose.waitForIdle()
    }

    private fun textOf(index: Int): String =
        fields()[index].fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text ?: ""

    // ───────── phase 1：只用界面保存两条（一条 ZeroTier＋中文名＋CRLF、一条直连） ─────────

    @Test
    fun phase1SaveTwoProfilesThroughTheUi() {
        prefs().edit().clear().commit()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForIdle()
            println("[phase1] afterLaunch raw=" + (rawNow() ?: "null").replace(10.toChar().toString(), "|"))
            println("[phase1] afterLaunch fields=" + fields().size)
            assertEquals("首次启动先迁出一条「默认连接」：编辑区两个输入框", 2, fields().size)

            tapButton("新建")
            println("[phase1] afterNewClick raw=" + (rawNow() ?: "null").replace(10.toChar().toString(), "|"))
            tapButton("○ ZeroTier（libzt）")
            assertEquals("切到 ZeroTier 后编辑区五个输入框", 5, fields().size)
            // 名字里故意带 CRLF（粘贴进来的 Windows 换行）
            type(0, "公司\r\n一号")
            type(1, "http://10.0.2.2:7399")
            type(2, "8056C2E21C000001")
            type(3, "0123456789ABCDEF")
            type(4, "FEDCBA9876543210")
            assertEquals("输入框里就是输入的那份", "公司\r\n一号", textOf(0))
            tapButton("保存")

            val afterFirst = rawNow()
            assertNotNull("点「保存」必须真的落盘", afterFirst)
            assertFalse("新格式不许把裸 CR 写进记录：$afterFirst", afterFirst!!.contains('\r'))
            println("[phase1] afterFirstSave raw=" + afterFirst.replace(10.toChar().toString(), "|"))
            val firstRead = Profiles.decode(afterFirst)
            assertTrue("刚保存的串在本进程里必须读得回来：$firstRead", firstRead is ProfilesRead.Ok)
            assertEquals(2, (firstRead as ProfilesRead.Ok).book.profiles.size)
            assertEquals("公司\r\n一号", firstRead.book.profiles.last().name)

            tapButton("新建")
            assertEquals("新一条默认直连：两个输入框", 2, fields().size)
            type(0, "家里")
            type(1, "http://127.0.0.1:7399")
            tapButton("保存")

            val raw = rawNow()!!
            println("[phase1] stored=" + raw.replace("\n", "\\n"))
            val decoded = Profiles.decode(raw)
            assertTrue("两次保存之后整份读回：$decoded", decoded is ProfilesRead.Ok)
            decoded as ProfilesRead.Ok
            assertEquals("默认连接 + 两条新建 = 3 条", 3, decoded.book.profiles.size)
            assertEquals(
                "ZeroTier 那条每一个字段都要原样在",
                Profile(
                    id = decoded.book.profiles[1].id,
                    name = "公司\r\n一号",
                    serverUrl = "http://10.0.2.2:7399",
                    mode = RunMode.ZEROTIER,
                    networkId = "8056C2E21C000001",
                    moonWorld = "0123456789ABCDEF",
                    moonSeed = "FEDCBA9876543210",
                ),
                decoded.book.profiles[1],
            )
            assertEquals("家里", decoded.book.profiles[2].name)
            assertEquals("保存即选中：最后保存的那条", decoded.book.profiles[2].id, decoded.book.selectedId)
            scenario.close()
        }
    }

    // ───────── phase 2：**另一次进程**里回读（另一次 am instrument） ─────────

    @Test
    fun phase2AfterARealProcessRestartEverythingReadsBack() {
        val storedBeforeOpen = rawNow()
        assertNotNull("phase2 要接着 phase1 留下的数据跑（先跑 phase1SaveTwoProfilesThroughTheUi）", storedBeforeOpen)
        val before =
            Profiles.decode(storedBeforeOpen) as? ProfilesRead.Ok
                ?: error("phase1 留下的串必须能读（不能读就说明修没成）：$storedBeforeOpen")
        assertEquals("phase1 应当留下 3 条", 3, before.book.profiles.size)
        val selected = before.book.profiles.first { it.id == before.book.selectedId }

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForIdle()
            compose.onNodeWithText("连接配置读取失败", substring = true).assertDoesNotExist()
            compose.onNodeWithText("重建一条默认配置（原内容保留为备份）").assertDoesNotExist()

            // 界面上的编辑区应该就是 prefs 里选中的那一条（不靠 AppState 内存，靠磁盘上的 selectedId）。
            val expectedFields = if (selected.mode == RunMode.ZEROTIER) 5 else 2
            assertEquals("编辑区输入框个数跟着选中的模式走", expectedFields, fields().size)
            assertEquals(selected.name, textOf(0))
            assertEquals(selected.serverUrl, textOf(1))
            if (selected.mode == RunMode.ZEROTIER) {
                assertEquals(selected.networkId, textOf(2))
                assertEquals(selected.moonWorld, textOf(3))
                assertEquals(selected.moonSeed, textOf(4))
            }
            // 两条自己建的都在列表里（前缀 ●/○ 取决于当前选中，两条合计两个节点）。
            assertTrue("公司那条在列表里", compose.onAllNodesWithText("公司", substring = true).fetchSemanticsNodes().isNotEmpty())
            assertTrue("家里那条在列表里", compose.onAllNodesWithText("家里", substring = true).fetchSemanticsNodes().isNotEmpty())

            // prefs 这一层同样核对（不靠 AppState 内存）
            val raw = rawNow()!!
            println("[phase2] rawLength=" + raw.length + " tail=" + raw.takeLast(12).map { it.code })
            // 真机那一格（“第 5 行”的来源）：`SharedPreferences` 的 XML 往返会在**以换行结尾**的串尾补上
            // XML 缩进（android-35 实测 4 个空格；尾码点 `[...,10,32,32,32,32]`）。读回来多一行全空白。
            assertTrue(
                "末尾应当多出 XML 补的空白（本设备实测），实际尾码点：${raw.takeLast(12).map { it.code }}",
                raw.takeLast(12).contains(' ') && raw.takeLast(12).contains('\n'),
            )
            val decoded = Profiles.decode(raw)
            assertTrue("另一个进程读回来也必须是 Ok：$decoded", decoded is ProfilesRead.Ok)
            assertEquals("三条一条不少", 3, (decoded as ProfilesRead.Ok).book.profiles.size)
            assertEquals(
                "读不该改写内容：去掉 XML 往返补上的尾部空白后，就是 encode 出来的那一份",
                Profiles.encode(decoded.book),
                raw.trimEnd(' ', '\t'),
            )
            assertEquals("打开前后同一个串", storedBeforeOpen, raw)
            scenario.close()
        }
    }

    // ───────── 保存路径的反证臂（旧包上会红） ─────────

    /**
     * 只用界面做一个「名字里带 CRLF」的配置并保存，然后断言磁盘上没有裸 CR —— 旧包（`escape` 不转义 `\r`）会红。
     */
    @Test
    fun aCarriageReturnTypedIntoTheNameFieldNeverLandsRawOnDisk() {
        prefs().edit().clear().commit()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForIdle()
            tapButton("新建")
            type(0, "旧包会写坏\r\n这一格")
            tapButton("保存")
            val raw = rawNow()!!
            println("[crlf] stored=" + raw.replace("\n", "\\n"))
            assertFalse("存盘串里不许有裸 CR：$raw", raw.contains('\r'))
            assertTrue("CR 必须被转义成两个字符 反斜杠+r：$raw", raw.contains("\\r"))
            val decoded = Profiles.decode(raw)
            assertTrue("读回来不许报错：$decoded", decoded is ProfilesRead.Ok)
            assertEquals("旧包会写坏\r\n这一格", (decoded as ProfilesRead.Ok).book.profiles.last().name)
            scenario.close()
        }
    }
}
