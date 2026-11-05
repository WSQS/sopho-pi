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

/**
 * 「旧串 → 新包」的两条路，都在**真 Context ＋ 真 `SharedPreferences`** 上走，不碰服务端、不启动 libzt：
 *
 * - 可**确定**那一格（换行落在中间字段：拼回才凑够 7 个字段）⇒ 自动读回，且**不写盘**；
 * - **不唯一**那一格（换行落在最后一个字段：第 4 行已经是 7 个字段、残片落在第 5 行）⇒ 仍然报 Corrupt，
 *   但给一条候选；用户**明确确认并点「保存」**才写回，**不点就一字不写**。
 *
 * 两条都断言：`profilesRaw` 原串逐字节保留、`profilesRaw.corrupt` 有备份、条目一条不少。
 */
@RunWith(AndroidJUnit4::class)
class ProfileRecoveryDeviceTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)
    private fun rawProfiles(): String? = prefs().getString("profilesRaw", null)
    private fun backupProfiles(): String? = prefs().getString("profilesRaw.corrupt", null)

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

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun newState(): AppState {
        var state: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { state = AppState(app) }
        return state!!.also { created += it }
    }

    private fun store(raw: String): String {
        assertTrue("写 fixture 要成功", prefs().edit().putString("profilesRaw", raw).commit())
        return rawProfiles()!!
    }

    /** 旧形状 B：`\r` 落在**最后一个字段**（Moon seed），且已经变成 `\n`（手机 OS 的 XML 往返）⇒ 第 4 行仍是 7 个字段、残片落到第 5 行。 */
    private fun ambiguousShape(): String = store(
        "sopho-profiles 1\n" +
            "selected old-1\n" +
            "showArchived 1\n" +
            "profile old-1\t公司旧配置\tZEROTIER\thttp://10.0.2.2:7399\t8056C2E21C000001\t0123456789ABCDEF\tFEDCBA98\n" +
            "76543210\\n\n" +
            "profile old-2\t家里\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n",
    )

    /** 旧形状 A：`\r` 落在**中间字段**（名字）且已变成 `\n` ⇒ 拼回才凑够 7 个字段（可确定）。 */
    private fun deterministicShape(): String = store(
        "sopho-profiles 1\n" +
            "selected old-1\n" +
            "showArchived 0\n" +
            "profile old-1\t公司\n旧配置\tZEROTIER\thttp://10.0.2.2:7399\t8056C2E21C000001\t0123456789ABCDEF\tFEDCBA9876543210\n" +
            "profile old-2\t家里\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n",
    )

    // ───────── 不唯一那一格：确认草稿才写 ─────────

    @Test
    fun ambiguousOldDataOffersADraftAndWritesNothingUntilTheUserSaves() {
        val original = ambiguousShape()
        val state = newState()

        assertTrue("这一格必须仍然报“读不懂”（不许自己拼、不许当 Ok）", state.profilesUnreadable)
        val error = state.profileError ?: ""
        println("[recovery] error=$error")
        assertTrue("错误要指到第 5 行（业主看到的那句）：$error", error.contains("第 5 行"))
        assertTrue("错误里要告诉用户有一份草稿可确认：$error", error.contains("拼成草稿"))
        assertEquals("仍然不自动清空/不重建：profilesRaw 一字未动", original, rawProfiles())
        assertEquals("原串另存到 profilesRaw.corrupt", original, backupProfiles())

        val candidate = state.recoveryCandidate
        assertNotNull("要给候选（拼回正好一条完整配置）", candidate)
        assertEquals("候选一条不少", 2, candidate!!.profiles.size)
        assertEquals("公司旧配置", candidate.profiles[0].name)
        assertEquals("旧串里被切开的那一格要原样拼回（换行＋转义过的 \\n 都要在）",
            "FEDCBA98\n76543210\n", candidate.profiles[0].moonSeed)
        assertEquals("第二条原样", "家里", candidate.profiles[1].name)
        assertEquals("候选保留 selected / showArchived", "old-1", candidate.selectedId)
        assertTrue(candidate.showArchived)

        // 用户点「把原串拼成草稿」：只进内存，不写盘。
        onMain { state.admitRecoveryCandidate() }
        assertEquals("确认草稿这一步**不许**写盘", original, rawProfiles())
        assertFalse("确认之后草稿在编辑区里（可以核对字段）", state.profiles.isEmpty())
        assertEquals("编辑区里就是拼回来的那条", "公司旧配置", state.draftProfile?.name)

        // 再点「保存」之前先验证一下：字段拼回来仍然是**非法**的 Moon（不是 16 位十六进制）⇒
        // 保存必须被拦住、且一字不写（不能为了“能用”把 wrong network 写回去）。
        onMain { state.saveDraft() }
        val refused = state.profileError ?: ""
        println("[recovery] refused=$refused")
        assertTrue("拼回来的 Seed 不是 16 位十六进制 ⇒ 保存要拦住并说清：$refused",
            refused.contains("16 位十六进制"))
        assertEquals("被拦住时不许写盘", original, rawProfiles())

        // 用户把那一格改成真正的 16 位 id，再保存。
        onMain { state.draftUpdate { it.copy(moonSeed = "FEDCBA9876543210") } }
        onMain { state.saveDraft() }
        assertNull("保存后不该还有错误：${state.profileError}", state.profileError)
        val written = rawProfiles()!!
        println("[recovery] written=" + written.replace("\n", "\\n"))
        assertFalse("写回的是新格式（无裸 CR）", written.contains('\r'))
        val reread = Profiles.decode(written)
        assertTrue("写回的串必须自己能读回来：$reread", reread is ProfilesRead.Ok)
        val book = (reread as ProfilesRead.Ok).book
        assertEquals("两条都在，一条都不许丢", 2, book.profiles.size)
        assertEquals("被切开的那一格恢复成 16 位 Moon seed（用户核对时改正了）",
            "FEDCBA9876543210", book.profiles[0].moonSeed)
        assertEquals("0123456789ABCDEF", book.profiles[0].moonWorld)
        assertEquals("8056C2E21C000001", book.profiles[0].networkId)
        assertEquals(RunMode.ZEROTIER, book.profiles[0].mode)
        assertEquals("第二条没被动过", Profile("old-2", "家里", "http://127.0.0.1:7399", RunMode.DIRECT, "", "", ""), book.profiles[1])
        assertEquals("selected 仍是原串里的那条", "old-1", book.selectedId)
        assertTrue("showArchived 也保留", book.showArchived)
        assertEquals("损坏的原串备份仍在", original, backupProfiles())

        // 重启（新 AppState）：不靠内存，直接从盘上读。
        val restarted = newState()
        assertFalse("重启后不再是“读不懂”状态", restarted.profilesUnreadable)
        assertEquals("重启后条数不变", 2, restarted.profiles.size)
        assertEquals("公司旧配置", restarted.selected?.name)
        assertEquals("FEDCBA9876543210", restarted.selected?.moonSeed)
        assertNull("重启不该再有错误：${restarted.profileError}", restarted.profileError)
    }

    // ───────── 可确定那一格：自动恢复但也不写盘 ─────────

    @Test
    fun deterministicOldDataIsRepairedInMemoryWithoutWritingUntilTheUserSaves() {
        val original = deterministicShape()
        val state = newState()

        assertFalse("可确定的拼回不该进“读不懂”状态：${state.profileError}", state.profilesUnreadable)
        assertEquals("两条都在", 2, state.profiles.size)
        assertEquals("名字里被切开的换行拼回来了", "公司\n旧配置", state.profiles[0].name)
        assertEquals("中间字段一个不少", "8056C2E21C000001", state.profiles[0].networkId)
        assertTrue(
            "界面要如实说“这是拼回来的”：${state.profileNotice}",
            state.profileNotice?.contains("拼回") == true,
        )
        assertEquals("拼回只在内存里：profilesRaw 一字未动", original, rawProfiles())
        assertEquals("原串另存到 profilesRaw.corrupt", original, backupProfiles())

        onMain { state.saveDraft() }
        val written = rawProfiles()!!
        println("[recovery] deterministic written=" + written.replace("\n", "\\n"))
        assertFalse("写回的是新格式（无裸 CR）", written.contains('\r'))
        val book = (Profiles.decode(written) as ProfilesRead.Ok).book
        assertEquals(2, book.profiles.size)
        assertEquals("公司\n旧配置", book.profiles[0].name)
        val restarted = newState()
        assertEquals("重启后同一个名字", "公司\n旧配置", restarted.profiles[0].name)
    }

    // ───────── 反面：不许把“真的坏”当成能拼 ─────────

    @Test
    fun genuinelyBrokenDataGetsNoCandidateAndStaysUntouched() {
        val original = store(
            "sopho-profiles 1\nselected a\nshowArchived 0\n" +
                "profile a\tn\tDIRECT\thttp://10.0.2.2:7321\t\t\tX\n残片\t还有一段\n",
        )
        val state = newState()
        assertTrue(state.profilesUnreadable)
        assertNull("凑不出 7 个字段 ⇒ 不许给候选", state.recoveryCandidate)
        assertEquals("原串一字未动", original, rawProfiles())
        assertEquals("原串另存一份", original, backupProfiles())
    }
}
