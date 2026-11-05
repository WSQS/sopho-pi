package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 这一组**只碰真的 `SharedPreferences`**（不碰 `AppState` 的任何新成员），所以同一份 test APK
 * 既能跑在**旧包**上（`a1179ba` 那一版，Profile 序列化还没修），也能跑在**已交付包** `4c296b15…`
 * 与本单修好的包上 —— 这正是本单要的那条“旧串 → 新包”路径。
 *
 * 两个事实，都在本机 AVD（`pf5rep01`，android-35）上实测：
 *
 * 1. 裸 `\r` 经真 prefs 写读**不会**被规整成 `\n`（XML 里写成 `&#13;`）。⇒ 本机能复现的旧形状是
 *    “字段里留着裸 `\r`”（旧包的 `decode` 用 `lines()`，它按 `\r` 切 ⇒ 第 5 行就是残片）。
 * 2. 手机上还可能出现的另一种形状是“那个 `\r` 在 XML 往返里被规整成了 `\n`”（不同 OS 版本的
 *    `SharedPreferences` 写法不同）。本机 AVD 不复现 → 这一组直接把**那个已经变成 `\n` 的串**
 *    写进真 prefs 来复现业主那句“第 5 行不是本应用认识的记录”（串的字节与手机上的那份一致）。
 *
 * write* 用例会清空 prefs 再写 fixture；`check*` 用例不清空，只读上一步留下的东西（每步都是独立的
 * `am instrument`，即一个新进程）。
 */
@RunWith(AndroidJUnit4::class)
class ProfileDeviceSeedTest {

    private val app: Context = ApplicationProvider.getApplicationContext()

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)
    private fun rawNow(): String? = prefs().getString("profilesRaw", null)
    private fun xmlFile() = File(app.dataDir, "shared_prefs/sopho-prefs.xml")

    private fun store(raw: String) {
        prefs().edit().clear().commit()
        assertTrue("写 fixture 要成功", prefs().edit().putString("profilesRaw", raw).commit())
    }

    /** 把 prefs 清空（只清我这台 AVD 上这个应用的偏好；不卸载、不动 identity 目录）。 */
    @Test
    fun clearProfilesForAFreshRun() {
        prefs().edit().clear().commit()
        assertEquals("清空之后没有 profilesRaw", null, rawNow())
    }

    // ───────── 事实：裸 CR 经真 prefs 写读之后还在（不被规整） ─────────

    @Test
    fun writeARawCarriageReturnThroughRealPrefs() {
        val raw = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\t家里\tDIRECT\thttp://10.0.2.2:7321\t\t\tabc\rdef\n"
        store(raw)
        assertEquals("同一个进程里 getString 返回的就是刚写进去的那份（裸 CR 还在）", raw, rawNow())
    }

    // ───────── 形状 ①：`\r` 落在最后一个字段 ⇒ 残片落到第 5 行（业主那一句） ─────────

    /**
     * 写的是**手机上那一份存下来的串**：第 4 行仍是 7 个字段的完整配置，第 5 行是它最后一个字段的残片。
     * 这是旧包（`escape` 不转义 `\r`）＋ 手机 OS 的 XML 往返（`\r` → `\n`）合起来的产物。
     */
    @Test
    fun writeTheShapeWhereTheTailLandsOnLineFive() {
        store(
            "sopho-profiles 1\n" +
                "selected old-1\n" +
                "showArchived 0\n" +
                "profile old-1\t公司旧配置\tZEROTIER\thttp://10.0.2.2:7399\t8056C2E21C000001\t0123456789ABCDEF\tFEDCBA98\n" +
                "76543210\\n\n" +
                "profile old-2\t家里\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n",
        )
        checkLineFiveShape()
    }

    private fun checkLineFiveShape() {
        val stored = rawNow()
        assertNotNull("先跑 writeTheShapeWhereTheTailLandsOnLineFive", stored)
        println("[check] lineFive stored=" + stored!!.replace("\n", "\\n"))
        val lines = stored.split("\n")
        assertEquals("第 4 行必须是那条 7 字段的配置", 7, lines[3].split("\t").size)
        assertEquals("第 5 行必须是残片（业主看到的就是第 5 行）", "76543210\\n", lines[4])
        assertTrue("后面那条配置还在", lines[5].startsWith("profile old-2"))
    }

    // ───────── 形状 ②：`\r` 落在中间字段（名字）⇒ 第 4 行只有 3 个字段 ─────────

    @Test
    fun writeTheShapeWhereTheSplitFallsInAMiddleField() {
        store(
            "sopho-profiles 1\n" +
                "selected old-1\n" +
                "showArchived 0\n" +
                "profile old-1\t公司\n旧配置\tZEROTIER\thttp://10.0.2.2:7399\t8056C2E21C000001\t0123456789ABCDEF\tFEDCBA9876543210\n" +
                "profile old-2\t家里\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n",
        )
        val stored = rawNow()!!
        val lines = stored.split("\n")
        assertEquals("第 4 行只有 2 个字段（名字在同一行里被切开）", 2, lines[3].split("\t").size)
        assertTrue("第 5 行是那条的残片", lines[4].startsWith("旧配置\tZEROTIER\t"))
    }
}
