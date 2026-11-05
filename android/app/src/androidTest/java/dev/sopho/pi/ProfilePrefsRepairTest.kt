package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Profile 序列化修复在**真 Context ＋ 真 `SharedPreferences`** 下的那几格（`docs/ops/android-client.md` §20.5）。
 *
 * 为什么要有这一组：§19 的证据全在 JVM 纯函数里（`ProfileTest`），而业主遇到的是**存盘再加载**——
 * 中间隔着 `SharedPreferences` 的 `getString` / XML 这一条路。这一组就走那条路：
 * 真的写进 `sopho-prefs`、真的新建一个 `AppState`（＝重启）、真的从 prefs 读回。
 *
 * 不连任何服务端、不启动 libzt（这几条用例一次 `connect()` 都不调）。
 */
@RunWith(AndroidJUnit4::class)
class ProfilePrefsRepairTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

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

    // ───────────────── ① 新格式：字段里的 CR 经真 prefs 存盘再加载，逐字回读 ─────────────────

    /**
     * 粘贴进来的 Windows 换行（`\r\n`）留在配置名里 → 保存 → **重启**（新 AppState）→ 名字逐字回读。
     *
     * 会失败的理由（修前的形状）：`escape` 不转义 `\r` ⇒ 存下来的串里有裸 `\r`；旧 `decode` 用
     * `raw.lines()`（也按 `\r` 切）⇒ 这条配置被切成两条 ⇒ 读回时报「第 N 行看不懂」/字段数不对。
     * 这里两端都断言：**存下来的串里没有裸 CR**（编码闭合），**读回的值与存进去的一字不差**（解码正确）。
     */
    @Test
    fun carriageReturnInAFieldSurvivesARealPrefsRoundTrip() {
        val name = "配置\r\n第二行"
        val state = newState()
        onMain {
            state.newProfile()
            state.draftUpdate { it.copy(name = name, serverUrl = "http://10.0.2.2:7321") }
            state.saveDraft()
        }
        assertNull("保存不该报错：${state.profileError}", state.profileError)

        val raw = rawProfiles()
        assertNotNull("保存之后必须真的落盘到 profilesRaw", raw)
        assertFalse("新格式不许把裸 CR 写进记录（记录之间只认 \\n）", raw!!.contains('\r'))
        assertTrue("CR 必须被转义成两个字符 反斜杠+r；实际：$raw", raw.contains("\\r"))

        val restarted = newState()
        // 首次运行会先迁出一条「默认连接」⇒ 这里是 2 条：一条默认 ＋ 一条刚保存的
        assertEquals("重启后条目数不变（默认 1 条 ＋ 刚保存的 1 条）", 2, restarted.profiles.size)
        assertEquals("保存即选中，重启后仍是它", name, restarted.selected?.name)
        assertNull("读回来不该有错误：${restarted.profileError}", restarted.profileError)
        assertTrue(
            "新格式不该被当成“旧数据被拆开又拼回来”（那是另一条分支）：${restarted.profileNotice}",
            restarted.profileNotice?.contains("拼回") != true,
        )
    }

    // ───────────────── ② 旧坏数据（裸 CR）：无损读回，且原串不被覆盖 ─────────────────

    /**
     * 旧版本写出来的形状：**字段里裸 CR**（旧 `escape` 不转义 `\r`）。旧 `decode` 会把它切成两条并报错。
     *
     * 这里直接把它塞进真 prefs，再新建 AppState ⇒ 必须**无损读回**（CR 还在字段里、条数不变、字段一个不少），
     * 且 `profilesRaw` **一字不动**（不静默改写成新格式：用户的东西不该被我们悄悄换掉）。
     *
     * 会失败的理由：`decode` 若仍按 `\r` 切行，这条会变成 Corrupt（一条配置都读不到）。
     */
    @Test
    fun oldRawCarriageReturnIsReadBackLosslesslyAndLeftIntact() {
        val book = bookWith(
            id = "11111111-1111-4111-8111-111111111111",
            name = "旧配置",
            serverUrl = "http://10.0.2.2:7321",
            moonSeed = "SEEDX",
        )
        // 用产品自己的 encode 造骨架，再把最后一个字段改成“旧版裸 CR”的形状（旧 escape 不会转义它）
        val oldRaw = Profiles.encode(book).replace("SEEDX", "SEED\rX")
        prefs().edit().putString("profilesRaw", oldRaw).commit()

        val state = newState()
        assertNull("旧数据里裸 CR 不该再报错：${state.profileError}", state.profileError)
        assertEquals("条数不许变（不静默丢条目）", 1, state.profiles.size)
        assertEquals("字段里的 CR 必须原样在", "SEED\rX", state.profiles[0].moonSeed)
        assertEquals("名字等其它字段也要对", "旧配置", state.profiles[0].name)
        assertEquals("读得懂就不许改写用户的原串", oldRaw, rawProfiles())
        assertNull("没被拆开就没什么可备份的", prefs().getString("profilesRaw.corrupt", null))
    }

    // ───────────────── ③ 旧坏数据（CRLF 把「名字」拆成两行）：拼回来、并真的先备份再提示 ─────────────────

    /**
     * 旧数据被 `\r\n` 拆成两行的形状，且**拆点落在中间的字段**（这里放在名字里）：
     * 上一行只有 4 个字段 ⇒ 可以**唯一地**拼回一条（拼回来正好 7 个字段）。
     *
     * 必须：拼回成功、字段逐字相等、如实提示「拼回去过」，并且**先真的备份**（`profilesRaw.corrupt`）
     * 再说那句“已按原样拼回去”；`profilesRaw` 本身保留原样（用户点保存才写回）。
     *
     * 会失败的理由：不拼 ⇒ 报字段数不对（用户那句“看不懂”）；只提示不备份 ⇒ 提示与实际不符
     * （旧文案正是这样：声称“已另存到 profilesRaw.corrupt”，实际只有点重建才备份）。
     */
    @Test
    fun oldRawSplitInAMiddleFieldIsRejoinedAndTheOriginalIsBackedUpFirst() {
        val book = bookWith(
            id = "22222222-2222-4222-8222-222222222222",
            name = "URLX",
            serverUrl = "http://10.0.2.2:7321",
        )
        val oldRaw = Profiles.encode(book).replace("URLX", "店里\r\n后厨")
        prefs().edit().putString("profilesRaw", oldRaw).commit()

        val state = newState()
        assertNull("拼得回来就不该报错：${state.profileError}", state.profileError)
        assertEquals("拼回后仍是 1 条（不是“少了条目的 Ok”）", 1, state.profiles.size)
        assertEquals("被拆开的那一段必须原样接回去（字节不少一个）", "店里\r\n后厨", state.profiles[0].name)
        assertEquals("其它字段不许串位", "http://10.0.2.2:7321", state.profiles[0].serverUrl)
        assertTrue(
            "拼回来要如实告知，不静默改行为：${state.profileNotice}",
            state.profileNotice?.contains("拼回") == true,
        )
        assertEquals("提示里说的备份必须真的发生过", oldRaw, prefs().getString("profilesRaw.corrupt", null))
        assertEquals("拼回来只在内存里成立，原串保留到用户点保存", oldRaw, rawProfiles())
    }

    // ───────────────── ③b 拆点在最后一个字段之后：不许“靠凑够 7 个字段”把不明内容吞掉 ─────────────────

    /**
     * 同一个 `\r\n` 拆分，但**拆点落在最后一个字段之后**：第一行其实已经是**完整 7 个字段**的配置，
     * 多出来的半截是一条独立的、谁也不认识的物理行。
     *
     * 必须：**报 Corrupt**（不猜、不把它接到上一个字段里），原串一字不动、另存备份；
     * 绝不返回一个“把不认识的内容吞进字段里”的 Ok —— 那会把用户的配置悄悄改坏。
     *
     * 会失败的理由：若拼接逻辑只看“上一行是 profile 行”而不看“字段还没凑够 7 个”，
     * 这条就会被并进最后那个字段（`moonSeed` 变成 `SEED` ＋ 换行 ＋ `X`），用户永远不会知道。
     */
    @Test
    fun rawSplitAfterAFullRecordIsReportedCorruptInsteadOfSwallowingTheStrayLine() {
        val book = bookWith(
            id = "33333333-3333-4333-8333-333333333333",
            name = "完整配置",
            serverUrl = "http://10.0.2.2:7321",
            moonSeed = "SEEDX",
        )
        val oldRaw = Profiles.encode(book).replace("SEEDX", "SEED\r\nX")
        prefs().edit().putString("profilesRaw", oldRaw).commit()

        val state = newState()
        assertNotNull("多出来的那一行不许被静默吞掉：必须报读不懂", state.profileError)
        assertTrue("读不懂期间不许有可用配置（不许变成“少了内容的 Ok”）", state.profiles.isEmpty())
        assertEquals("原串一字不动", oldRaw, rawProfiles())
        assertEquals("原串要另存备份", oldRaw, prefs().getString("profilesRaw.corrupt", null))
    }

    // ───────────────── ④ 读不懂：所有写点封死，唯一出口是先备份再重建 ─────────────────

    /**
     * 真·读不懂的串 ⇒ 可读错误上屏、原串一字不动；此时**每一个写点都不许写盘**；
     * 只有显式 `rebuildAfterCorrupt()`（它先备份）才允许改写。
     *
     * 会失败的理由：`book` 在 Corrupt 时是空书 —— 任何一个写点（拨归档开关 / 新建+保存 / 选 / 删）
     * 都会把用户唯一一份原串盖成“空配置”或只剩新条目。那就是真丢数据。
     */
    @Test
    fun unreadableConfigBlocksEveryWriteUntilExplicitRebuild() {
        val garbage = "这不是格式"
        prefs().edit().putString("profilesRaw", garbage).commit()

        val state = newState()
        assertTrue("读不懂的必须被标出来", state.profilesUnreadable)
        assertNotNull("必须给可读错误", state.profileError)
        assertTrue(
            "错误要说明“没被自动清空/重建”：${state.profileError}",
            state.profileError!!.contains("没有被自动清空"),
        )
        assertEquals("读到坏数据的那一刻就要备份", garbage, prefs().getString("profilesRaw.corrupt", null))
        assertEquals("坏数据不许就地覆盖", garbage, rawProfiles())

        // 四个写点走产品路径逐个试：每一个都必须被拦住，profilesRaw 一个字节都不许变
        onMain { state.updateShowArchived(true) }
        onMain {
            state.newProfile()
            state.draftUpdate { it.copy(name = "新配置", serverUrl = "http://10.0.2.2:7321") }
            state.saveDraft()
        }
        onMain { state.selectProfile("00000000-0000-4000-8000-000000000000") }
        onMain { state.deleteProfile("00000000-0000-4000-8000-000000000000") }
        assertEquals("读不懂期间所有写点都不许写盘", garbage, rawProfiles())
        assertEquals("备份也不许被这些写点改掉", garbage, prefs().getString("profilesRaw.corrupt", null))
        assertTrue("被拦住时要说明为什么", state.profileError?.contains("配置数据还没恢复") == true)

        // 唯一出口：先备份 → 再写一条默认可用的配置
        onMain { state.rebuildAfterCorrupt() }
        assertFalse("重建后不再是“读不懂”", state.profilesUnreadable)
        assertNull("重建后错误消失", state.profileError)
        assertEquals("重建后有一条默认可用的配置", 1, state.profiles.size)
        assertEquals("原始坏数据仍在备份里", garbage, prefs().getString("profilesRaw.corrupt", null))
        assertTrue("profilesRaw 这时才可以变：${rawProfiles()}", rawProfiles() != garbage)

        val restarted = newState()
        assertEquals("重建结果是真落盘的（重启回读）", 1, restarted.profiles.size)
        assertNull("重启后也不该报错：${restarted.profileError}", restarted.profileError)
        waitForPrefsFileContains("sopho-profiles 1")
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    /** 造一条旧数据的骨架（字段值故意写成占位串，方便替换成“旧版会写出来的坏形状”）。 */
    private fun bookWith(
        id: String,
        name: String,
        serverUrl: String,
        moonSeed: String = "",
    ): ProfileBook = ProfileBook(
        profiles = listOf(
            Profile(
                id = id,
                name = name,
                serverUrl = serverUrl,
                mode = RunMode.DIRECT,
                networkId = "",
                moonWorld = "",
                moonSeed = moonSeed,
            ),
        ),
        selectedId = id,
        showArchived = false,
    )

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun rawProfiles(): String? = prefs().getString("profilesRaw", null)

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /** 新建一个 AppState（＝应用重启一次；同一份 prefs、同一份 Context）。 */
    private fun newState(): AppState {
        var state: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { state = AppState(app) }
        return state!!.also { created += it }
    }

    /** 等 `shared_prefs` 的 XML 文件里真的出现这段内容（`apply()` 是异步落盘的，读文件要等）。 */
    private fun waitForPrefsFileContains(needle: String) {
        val file = File(app.applicationInfo.dataDir, "shared_prefs/sopho-prefs.xml")
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (file.isFile && file.readText().contains(needle)) return
            Thread.sleep(50)
        }
        throw AssertionError("prefs 的 XML 里没等到「$needle」（路径 ${file.absolutePath}）")
    }
}
