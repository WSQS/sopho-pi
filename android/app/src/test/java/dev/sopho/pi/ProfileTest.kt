package dev.sopho.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Profile v1 的**可测层**：行格式的往返、坏数据的可读错误、选中项缺失时的回退、老键迁移、保存前校验、
 * 以及「草稿键按 (profileId, sessionId)」与「ZT 配置键」这两条隔离判据。
 *
 * 不碰 Android、不碰 SharedPreferences（那是 AppState 的事，用 AVD 验）。
 */
class ProfileTest {

    private fun profile(
        id: String = "p1",
        name: String = "家里",
        serverUrl: String = "http://10.0.2.2:7321",
        mode: RunMode = RunMode.DIRECT,
        networkId: String = "",
        moonWorld: String = "",
        moonSeed: String = "",
    ) = Profile(id, name, serverUrl, mode, networkId, moonWorld, moonSeed)

    @Test
    fun `encode then decode keeps every field including odd characters`() {
        val book = ProfileBook(
            profiles = listOf(
                profile(id = "a", name = "带\t制表符", serverUrl = "http://10.0.2.2:7321"),
                profile(
                    id = "b",
                    name = "换行\n与反斜杠\\",
                    serverUrl = "http://192.0.2.9:7399",
                    mode = RunMode.ZEROTIER,
                    networkId = "8056c2e21c000001",
                    moonWorld = "0123456789ABCDEF",
                    moonSeed = "FEDCBA9876543210",
                ),
            ),
            selectedId = "b",
            showArchived = true,
        )
        val decoded = Profiles.decode(Profiles.encode(book))
        assertTrue(decoded is ProfilesRead.Ok)
        val got = (decoded as ProfilesRead.Ok).book
        assertEquals(book.profiles, got.profiles)
        assertEquals("b", got.selectedId)
        assertTrue(got.showArchived)
    }

    @Test
    fun `nothing stored means empty, not corrupt`() {
        assertEquals(ProfilesRead.Empty, Profiles.decode(null))
        assertEquals(ProfilesRead.Empty, Profiles.decode(""))
        assertEquals(ProfilesRead.Empty, Profiles.decode("   \n  "))
    }

    @Test
    fun `corrupt stores give a readable reason instead of throwing or wiping`() {
        val cases = mapOf(
            "sopho-profiles 9\nselected -\nshowArchived 0\n" to "首行",
            "sopho-profiles 1\nshowArchived 0\n" to "缺少",
            "sopho-profiles 1\nselected -\nshowArchived 0\nprofile a\tb\tDIRECT\n" to "字段数",
            "sopho-profiles 1\nselected -\nshowArchived 0\nprofile a\tb\tNOPE\turl\tn\tw\ts\n" to "连接方式",
            "hello world" to "首行",
        )
        for ((raw, expected) in cases) {
            val read = Profiles.decode(raw)
            assertTrue("raw=$raw 应该是 Corrupt", read is ProfilesRead.Corrupt)
            val reason = (read as ProfilesRead.Corrupt).reason
            assertTrue("raw=$raw reason=$reason 期望含 $expected", reason.contains(expected))
        }
    }

    @Test
    fun `a dangling selectedId falls back to the first profile`() {
        val raw = Profiles.encode(ProfileBook(listOf(profile(id = "only")), selectedId = "gone", showArchived = false))
        val got = (Profiles.decode(raw) as ProfilesRead.Ok).book
        assertEquals("only", got.selectedId)
    }

    @Test
    fun `legacy keys migrate into one default profile that keeps moon and archived flag`() {
        val book = Profiles.migrateLegacy(
            showArchived = true,
            moonWorld = "0123456789ABCDEF",
            moonSeed = "FEDCBA9876543210",
            defaultServerUrl = "http://10.0.2.2:7321",
            newId = "migrated",
        )
        val only = book.profiles.single()
        assertEquals(Profiles.DEFAULT_PROFILE_NAME, only.name)
        assertEquals("migrated", only.id)
        assertEquals("0123456789ABCDEF", only.moonWorld)
        assertEquals("FEDCBA9876543210", only.moonSeed)
        assertTrue(book.showArchived)
        // 旧版本没存过地址/network ID ⇒ 不编造：地址用默认值，network ID 留空
        assertEquals("http://10.0.2.2:7321", only.serverUrl)
        assertEquals("", only.networkId)
        // 迁移结果本身必须是能存能读的
        val roundTrip = (Profiles.decode(Profiles.encode(book)) as ProfilesRead.Ok).book
        assertEquals(book, roundTrip)
    }

    @Test
    fun `validate rejects the things that would later fail silently`() {
        assertEquals("配置名字不能是空的", Profiles.validate(profile(name = "  ")))
        // 公网地址：沿用既有的明文/私网边界
        assertTrue(Profiles.validate(profile(serverUrl = "http://8.8.8.8:7321"))!!.contains("私网"))
        // ZT 模式下的 network ID / Moon
        assertTrue(Profiles.validate(profile(mode = RunMode.ZEROTIER, networkId = ""))!!.contains("network ID"))
        assertTrue(
            Profiles.validate(
                profile(mode = RunMode.ZEROTIER, networkId = "8056c2e21c000001", moonWorld = "123", moonSeed = ""),
            )!!.contains("Moon"),
        )
        // 合法：DIRECT 不要求 networkId；ZT 全填好就通过
        assertNull(Profiles.validate(profile()))
        assertNull(
            Profiles.validate(
                profile(
                    mode = RunMode.ZEROTIER,
                    networkId = "8056c2e21c000001",
                    moonWorld = "0123456789abcdef",
                    moonSeed = "fedcba9876543210",
                ),
            ),
        )
    }

    @Test
    fun `draft keys are per profile, so the same session id under two servers never collides`() {
        val sameSession = "aaaa-bbbb"
        assertNotEquals(Profiles.draftKey("p1", sameSession), Profiles.draftKey("p2", sameSession))
        assertEquals(Profiles.draftKey("p1", sameSession), Profiles.draftKey("p1", sameSession))
        assertNotEquals(Profiles.draftKey(null, sameSession), Profiles.draftKey("p1", sameSession))
    }

    @Test
    fun `zt config key ignores case and padding but notices real changes`() {
        val base = profile(mode = RunMode.ZEROTIER, networkId = "8056C2E21C000001", moonWorld = "0123456789ABCDEF", moonSeed = "FEDCBA9876543210")
        val same = base.copy(networkId = " 8056c2e21c000001 ", moonWorld = " 0123456789abcdef", moonSeed = "fedcba9876543210 ")
        assertEquals(Profiles.ztConfigKey(base), Profiles.ztConfigKey(same))
        assertNotEquals(Profiles.ztConfigKey(base), Profiles.ztConfigKey(base.copy(moonSeed = "0000000000000001")))
        assertNotEquals(Profiles.ztConfigKey(base), Profiles.ztConfigKey(base.copy(networkId = "8056c2e21c000002")))
    }

    @Test
    fun `two profiles with different endpoints are distinguishable and both survive a round trip`() {
        val a = profile(id = "a", name = "A", serverUrl = "http://10.0.2.2:7399")
        val b = profile(id = "b", name = "B", serverUrl = "http://10.0.2.2:7499")
        val book = ProfileBook(listOf(a, b), selectedId = "b", showArchived = false)
        val got = (Profiles.decode(Profiles.encode(book)) as ProfilesRead.Ok).book
        assertEquals(listOf("http://10.0.2.2:7399", "http://10.0.2.2:7499"), got.profiles.map { it.serverUrl })
        assertEquals("b", got.selectedId)
        assertFalse(got.showArchived)
    }

    // ─────────────────── 回车符（CR / CRLF）那一格：业主报的「保存后再加载，第五行看不懂」 ───────────────────

    /**
     * 字段里的 `\r` 与 `\r\n` 必须能原样往返：旧 `encode` 只转义了 `\` `\t` `\n`，`\r` 是裸写的；
     * 而旧 `decode` 用 `String.lines()` 切行，它把 `\r`、`\r\n` 都当行分隔符 ⇒ 一条 profile 被拆成两行，
     * 多出来的那半截既不带头行、也不带 `profile ` 前缀，于是落到 else 分支报「第 N 行看不懂」。
     *
     * 会失败的理由：只要 `escape` 不处理 `\r`，`decode(encode(book))` 就不等于 `book`。
     */
    @Test
    fun `a carriage return inside a field survives a round trip instead of splitting the record`() {
        val book = ProfileBook(
            profiles = listOf(
                profile(id = "cr", name = "家里\r客厅"),
                profile(id = "crlf", name = "店里\r\n后厨", serverUrl = "http://192.0.2.9:7399"),
                profile(id = "cr-url", name = "粘贴进来的地址", serverUrl = "http://10.0.2.2:7399"),
            ),
            selectedId = "crlf",
            showArchived = false,
        )
        val decoded = Profiles.decode(Profiles.encode(book))
        assertTrue("含 \\r 的配置必须能读回来（现在读成：${(decoded as? ProfilesRead.Corrupt)?.reason}）", decoded is ProfilesRead.Ok)
        assertEquals(book.profiles, (decoded as ProfilesRead.Ok).book.profiles)
        assertEquals("crlf", decoded.book.selectedId)
        assertEquals("含 \\r 的数据是我们的新格式，不该被当成修复过的旧数据", 0, decoded.repairedRecords)
    }

    /**
     * 业主报的那句话的**原形**：`else -> Corrupt("第 5 行看不懂…")`。
     *
     * 复现条件（三行头 ＋ 一条配置）：第一个 profile 里**最后一个字段**（这里 `moonSeed`）带着裸 `\r`，
     * 而且 CR 后面还有字符。旧 `encode` 不转义 `\r`，旧 `decode` 用 `lines()` 切行 ⇒ 前半截正好还是 7 个字段
     * （能解成一条配置），后半截落到第 5 行、既不是头行也不带 `profile ` 前缀 ⇒ 那正好就是业主看到的那句。
     *
     * 会失败的理由：旧代码对这个样本返回 Corrupt（见本测试的红字），固定它修好后的行为就是本次修复的标的。
     */
    @Test
    fun `the reported fifth line message is the tail of a record split by a raw CR in the last field`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\t家里\tZEROTIER\thttp://10.0.2.2:7399\t8056c2e21c000001\t0123456789ABCDEF\tFEDCBA9876543210\rFEDCBA9876543210\n"
        val read = Profiles.decode(old)
        assertTrue("修前这里就是「第 5 行看不懂」（业主报的那句），现在：${(read as? ProfilesRead.Corrupt)?.reason}", read is ProfilesRead.Ok)
        val only = (read as ProfilesRead.Ok).book.profiles.single()
        assertEquals("FEDCBA9876543210\rFEDCBA9876543210", only.moonSeed)
        assertEquals("0123456789ABCDEF", only.moonWorld)
        assertEquals("8056c2e21c000001", only.networkId)
    }

    /**
     * 多 profile ＋ 中文 ＋ 制表符 ＋ 反斜杠 ＋ 空的末尾字段（`split("\t")` 会不会吃掉尾部空串）＋ CRLF：
     * 一整套一起往返，任何一个字段被吃掉都要红。
     */
    @Test
    fun `several profiles with odd characters and empty trailing fields round trip exactly`() {
        val book = ProfileBook(
            profiles = listOf(
                profile(id = "p1", name = "家里\t一层\\"),
                profile(
                    id = "p2",
                    name = "店里\r\n后厨（Zerotier）",
                    serverUrl = "http://10.0.2.2:7499",
                    mode = RunMode.ZEROTIER,
                    networkId = "8056c2e21c000001",
                    moonWorld = "0123456789ABCDEF",
                    moonSeed = "",
                ),
                profile(id = "p3", name = "只有名字", serverUrl = "http://127.0.0.1:7399", networkId = "", moonWorld = "FEDCBA9876543210", moonSeed = ""),
            ),
            selectedId = "p3",
            showArchived = true,
        )
        val read = Profiles.decode(Profiles.encode(book)) as ProfilesRead.Ok
        assertEquals(book, read.book)
        assertEquals(0, read.repairedRecords)
    }

    /**
     * **旧格式**（旧 `encode` 写出来的原串）里的裸 `\r`：不改一个字就该能读回来。
     * 裸 `\r` 只可能来自旧 `encode`（本应用从不写 `\r` 行尾），所以它是字段内容，不是行分隔符。
     */
    @Test
    fun `old format records with a raw carriage return are read back without losing a field`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\t家里\r客厅\tDIRECT\thttp://10.0.2.2:7321\t\t\t\n"
        val read = Profiles.decode(old)
        assertTrue("旧格式的裸 \\r 必须能读（现在：${(read as? ProfilesRead.Corrupt)?.reason}）", read is ProfilesRead.Ok)
        val only = (read as ProfilesRead.Ok).book.profiles.single()
        assertEquals("家里\r客厅", only.name)
        assertEquals("http://10.0.2.2:7321", only.serverUrl)
        assertEquals(0, read.repairedRecords)
    }

    /**
     * **旧格式**里被 `\r\n` 拆成两行的 profile：拼回去正好是 7 个字段 ⇒ 确定性恢复，并报告“修复过”。
     * 同时断言没有静默丢条目（被拆的那条还在，字段一个不少）。
     */
    @Test
    fun `old format record split by a CRLF is rejoined and reported as repaired`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 1\n" +
            "profile a\t店里\r\n后厨\tZEROTIER\thttp://10.0.2.2:7399\t8056c2e21c000001\t0123456789ABCDEF\t\n" +
            "profile b\t第二条\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n"
        val read = Profiles.decode(old)
        assertTrue("被 CRLF 拆开的旧记录应能拼回来（现在：${(read as? ProfilesRead.Corrupt)?.reason}）", read is ProfilesRead.Ok)
        read as ProfilesRead.Ok
        assertEquals("两条都在，一条都不许丢", 2, read.book.profiles.size)
        assertEquals("店里\r\n后厨", read.book.profiles[0].name)
        assertEquals("8056c2e21c000001", read.book.profiles[0].networkId)
        assertEquals("0123456789ABCDEF", read.book.profiles[0].moonWorld)
        assertEquals("", read.book.profiles[0].moonSeed)
        assertEquals("第二条", read.book.profiles[1].name)
        assertEquals(1, read.repairedRecords)
    }

    /**
     * 同一条被拆开的旧记录，但字段里留下的是裸 `\n` —— 这也是**旧数据的真实形状之一**：
     * `SharedPreferences` 的 XML 可能会把 `\r` 规整成 `\n`（本轮**没有**用 AVD 实跑验证，见 docs 的“没验到什么”）。
     * 两种形状都得能拼回去，否则修复只在 JVM 上成立。
     */
    @Test
    fun `old format record split by a bare LF is rejoined too`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\t家里\n客厅\tDIRECT\thttp://10.0.2.2:7321\t\t\t\n"
        val read = Profiles.decode(old)
        assertTrue("裸 LF 拆开的旧记录也应能拼回来（现在：${(read as? ProfilesRead.Corrupt)?.reason}）", read is ProfilesRead.Ok)
        read as ProfilesRead.Ok
        assertEquals("家里\n客厅", read.book.profiles.single().name)
        assertEquals(1, read.repairedRecords)
    }

    /**
     * 拼不回去的坏数据**不许**变成“少了条目的 Ok”：要么是 Ok 且条目齐全，要么是 Corrupt。
     * 这是“不静默丢配置”的机械判据 —— 只要它返回 Ok，调用方就可能把少掉条目的书重新 encode 写回去。
     */
    @Test
    fun `a corrupt store never turns into a partial book`() {
        val samples = mapOf(
            "半截 profile 后面跟着看不懂的行，拼不到 7 个字段" to
                "sopho-profiles 1\nselected a\nshowArchived 0\nprofile a\t名字\tDIRECT\thttp://10.0.2.2:7321\n不是字段\n",
            "完整 profile 后面多出一行" to
                "sopho-profiles 1\nselected a\nshowArchived 0\nprofile a\tn\tDIRECT\thttp://10.0.2.2:7321\t\t\t\n多出来的一行\n",
            "两条里后一条被截断" to
                "sopho-profiles 1\nselected a\nshowArchived 0\nprofile a\tn\tDIRECT\thttp://10.0.2.2:7321\t\t\t\nprofile b\t坏\tDIRECT\n",
        )
        for ((why, raw) in samples) {
            val read = Profiles.decode(raw)
            assertTrue("$why ⇒ 必须 Corrupt，得到的却是 $read", read is ProfilesRead.Corrupt)
        }
    }

    /**
     * **业主那句“第五行”真正的那一格**（2026-10-23 在 AVD 上用真 `SharedPreferences` 实测）：旧版把字段里的裸 `\r`
     * 写进 XML，XML 规范又把那个 `\r` 规整成 `\n` 读回来 ⇒ 存下来的串里，第一条配置的**最后一个字段**被切开，
     * 第 4 行仍是“7 个字段的完整记录”，残片落到第 5 行。严格拼接**不许**自己接上（“完整记录后面多一行”看起来一样），
     * 但必须给出一条候选给用户确认 —— 否则用户手上只有“重建”，那就是丢他原来的输入。
     */
    @Test
    fun `a record whose last field was cut by a normalized CR is corrupt with a confirmable candidate`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 1\n" +
            "profile a\t家里\tZEROTIER\thttp://10.0.2.2:7399\t8056c2e21c000001\t0123456789ABCDEF\tFEDCBA98\n" +
            "76543210\n"
        val read = Profiles.decode(old)
        assertTrue("严格模式下这一格必须仍是 Corrupt（不许静默吞行）：$read", read is ProfilesRead.Corrupt)
        read as ProfilesRead.Corrupt
        assertEquals("错误必须指到实际那一行（业主看到的就是“第 5 行”）", true, read.reason.contains("第 5 行"))
        val candidate = read.candidate
        assertNotNull("拼回正好 7 个字段 ⇒ 必须给出候选，否则用户只剩“重建”这一条丢数据的路", candidate)
        val only = candidate!!.profiles.single()
        assertEquals("FEDCBA98\n76543210", only.moonSeed)
        assertEquals("0123456789ABCDEF", only.moonWorld)
        assertEquals("8056c2e21c000001", only.networkId)
        assertEquals("家里", only.name)
        assertEquals("候选必须把 selected / showArchived 一起带上", "a", candidate.selectedId)
        assertTrue(candidate.showArchived)
    }

    /** 候选**不许少条目**：两条配置时，被切的那条拼回来，后一条原样在。 */
    @Test
    fun `a candidate keeps every profile and never swallows the next record`() {
        val old = "sopho-profiles 1\n" +
            "selected b\n" +
            "showArchived 0\n" +
            "profile a\t第一条\tDIRECT\thttp://10.0.2.2:7321\t尾巴\n" +
            "接着写\t\t\n" +
            "profile b\t第二条\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n"
        val read = Profiles.decode(old)
        assertTrue("这条其实是**可确定**的拼回（前一行只有 5 个字段）⇒ 走 Ok/repaired：$read", read is ProfilesRead.Ok)
        read as ProfilesRead.Ok
        assertEquals("被切开的那一条必须拼回来（两条一条不少）", 2, read.book.profiles.size)
        assertEquals("尾巴\n接着写", read.book.profiles[0].networkId)
        assertEquals("第二条", read.book.profiles[1].name)

        val ambiguous = "sopho-profiles 1\n" +
            "selected b\n" +
            "showArchived 0\n" +
            "profile a\t第一条\tDIRECT\thttp://10.0.2.2:7321\t\t\tX\n" +
            "尾部\n" +
            "profile b\t第二条\tDIRECT\thttp://127.0.0.1:7399\t\t\t\n"
        val read2 = Profiles.decode(ambiguous)
        assertTrue("这一格不唯一（“完整记录 + 多一行”）⇒ 严格模式 Corrupt：$read2", read2 is ProfilesRead.Corrupt)
        val candidate = (read2 as ProfilesRead.Corrupt).candidate
        assertNotNull(candidate)
        assertEquals("两条都得在", 2, candidate!!.profiles.size)
        assertEquals("X\n尾部", candidate.profiles[0].moonSeed)
        assertEquals("第二条", candidate.profiles[1].name)
    }

    /** 残片凑不出 7 个字段 ⇒ **没有**候选（不猜、不把半条当一条）。 */
    @Test
    fun `no candidate is offered when the tail cannot complete a seven field record`() {
        val samples = listOf(
            "字段里的残片自己带制表符（接上就超 7 个字段）" to
                "sopho-profiles 1\nselected a\nshowArchived 0\n" +
                "profile a\tn\tDIRECT\thttp://10.0.2.2:7321\t\t\tX\n残片\t还有一段\n",
            "半截记录后面跟着一段完全不像字段的行" to
                "sopho-profiles 1\nselected a\nshowArchived 0\nprofile a\tn\tDIRECT\n这是一句日志\n",
        )
        for ((why, raw) in samples) {
            val read = Profiles.decode(raw)
            assertTrue("$why ⇒ 必须 Corrupt：$read", read is ProfilesRead.Corrupt)
            assertNull("$why ⇒ 不许给候选（不唯一推回内容）", (read as ProfilesRead.Corrupt).candidate)
        }
    }

    /** 字段里不止一个换行（多个裸 `\r` 被 XML 规整）：候选要把几段残片都攒回来，而不是只接一段。 */
    @Test
    fun `a candidate reassembles several fragments of the same field`() {
        val old = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\tn\tDIRECT\thttp://10.0.2.2\n" +
            "7321\t\t\t\n"
        val read = Profiles.decode(old)
        assertTrue("前一行只有 4 个字段、残片 4 段 ⇒ 严格模式就能拼（可确定）：$read", read is ProfilesRead.Ok)
        assertEquals("http://10.0.2.2\n7321", (read as ProfilesRead.Ok).book.profiles.single().serverUrl)

        val multi = "sopho-profiles 1\n" +
            "selected a\n" +
            "showArchived 0\n" +
            "profile a\tn\tDIRECT\thttp://10.0.2.2:7321\tX\n" +
            "Y\n" +
            "Z\t\t\n"
        val read2 = Profiles.decode(multi)
        assertTrue("两段残片才能凑够 7 个字段 ⇒ 严格模式拼不出来：$read2", read2 is ProfilesRead.Corrupt)
        val candidate = (read2 as ProfilesRead.Corrupt).candidate
        assertNotNull("两段残片必须都能攒回候选里", candidate)
        assertEquals("X\nY\nZ", candidate!!.profiles.single().networkId)
    }

    /**
     * **真机实测的那一格（业主第二包也没修掉的那一句）**：`SharedPreferences` 的 XML 往返会在**以换行结尾**的
     * 字符串末尾补上 XML 缩进 —— 2026-10-23 在 AVD `pf5rep01`（android-35）上实测写进去的串末尾多出
     * 4 个空格（尾码点 `[100,101,102,10,32,32,32,32]`）。`Profiles.encode` 正好以 `\n` 结尾
     * ⇒ **每一次真实进程重启后**读回来都多一行「    」，被当成“第 5 行不是本应用认识的记录”。
     *
     * 这一格是**可确定**的（那一行全是空白）——照读，不报错、不丢条目、也不需要用户确认。
     */
    @Test
    fun `the indentation that a real prefs XML round trip appends is not a record`() {
        val book = ProfileBook(
            profiles = listOf(profile(id = "p1", name = "公司")),
            selectedId = "p1",
            showArchived = false,
        )
        val encoded = Profiles.encode(book)
        for (padding in listOf("    ", "  ", "\t", "        ")) {
            val read = Profiles.decode(encoded + padding)
            assertTrue(
                "末尾多出的空白（“$padding”）不许被当成一条记录：${(read as? ProfilesRead.Corrupt)?.reason}",
                read is ProfilesRead.Ok,
            )
            assertEquals("条目不许少", book.profiles, (read as ProfilesRead.Ok).book.profiles)
            assertEquals("这一格不需要“拼回”，不该报告修复", 0, read.repairedRecords)
        }
    }

    /**
     * 给人看的 `reason` 里**不许**回显存下来的配置值（那是明文地址/名字），也不许只说“看不懂”。
     * 用户能看到的那句“怎么办”在 AppState 里拼（原配置未被覆盖 / 已备份 / 可以重建）。
     */
    @Test
    fun `corrupt reasons do not echo stored values`() {
        val samples = listOf(
            "sopho-profiles 1\nselected a\nshowArchived 0\nprofile a\tn\tDIRECT\thttp://10.0.2.2:7321\n不是字段\n",
            "10.0.2.2:7321 这不是首行\n",
            "sopho-profiles 1\nselected -\nshowArchived 0\nprofile a\tn\tNOPE\thttp://10.0.2.2:7321\t\t\t\n",
        )
        for (raw in samples) {
            val reason = (Profiles.decode(raw) as ProfilesRead.Corrupt).reason
            assertFalse("reason 不许回显原值：$reason", reason.contains("10.0.2.2:7321"))
            assertFalse("reason 不许长得像一条内部 dump：$reason", reason.contains("\t"))
        }
    }
}
