package dev.sopho.pi

/**
 * 一条**本地命名连接配置**（Profile v1）。它替代之前散落在连接页上的字段：
 * 服务器地址 / 运行模式 / ZeroTier network ID / Moon 两个 id 都归它。
 *
 * 归档显示开关**不**在 Profile 里（本单明确：那一项仍是全局，见 items/android-client/item.md）。
 */
data class Profile(
    val id: String,
    val name: String,
    val serverUrl: String,
    val mode: RunMode,
    val networkId: String,
    val moonWorld: String,
    val moonSeed: String,
)

data class ProfileBook(
    val profiles: List<Profile>,
    val selectedId: String?,
    val showArchived: Boolean,
)

/** 读盘结果：**损坏不静默清空** —— 调用方必须把 `Corrupt` 原样上屏，并保留原串。 */
sealed interface ProfilesRead {
    /** 还没有任何 Profile（首次运行 / 需要迁移）。 */
    data object Empty : ProfilesRead

    data class Ok(val book: ProfileBook, val repairedRecords: Int = 0) : ProfilesRead

    /** 存下来的东西读不懂：`reason` 只说**位置与怎么回事**（不回显存下来的值）；
     * “该怎么办”由调用方补上（AppState 拼“原配置未被覆盖 / 已备份 / 可重建”）。
     *
     * `candidate`：**不唯一确定**时给出的“按原串拼回去”的候选（例如第一条配置的**最后一个字段**被换行截断、
     * 残片落在下一行：拼回也正好是 7 个字段，但同样能读成“完整记录后面多出来一行”）。
     * 这一格**不许**当成 Ok 自己在内存里生效、更不许写盘 —— 必须由用户在界面上明确确认后，
     * 再点「保存」才写回（取消就一字不写）。可确定那一格（拼回才凑够 7 个字段）走 [Ok] 的 `repairedRecords`，与这里分开。 */
    data class Corrupt(val reason: String, val candidate: ProfileBook? = null) : ProfilesRead
}

/**
 * Profile 的存取格式：**零依赖的行格式**（不用 JSON，好单测、也没有 `org.json` 在 JVM 单测里的坑）。
 *
 * ```
 * sopho-profiles 1
 * selected <profileId|->
 * showArchived <0|1>
 * profile <id>\t<name>\t<mode>\t<serverUrl>\t<networkId>\t<moonWorld>\t<moonSeed>
 * ```
 * 字段里的 `\`、制表符、换行、回车分别转义成 `\\` `\t` `\n` `\r`。
 *
 * **回车必须转义**：Android 的粘贴/剪贴板会把 Windows 换行（`\r\n`）原样带进来，而记录之间只认 `\n`；
 * 旧版本把 `\r` 裸写过，于是 `String.lines()`（它也把 `\r`、`\r\n` 当行分隔符）把一条配置切成两条，
 * 多出来的半截既不是头行也不带 `profile ` 前缀，落到 else 分支报「第 N 行看不懂」——
 * 这就是业主 2026-10-23 报的那句（复现与读数见 docs/ops/android-client.md §18）。
 *
 * 迁移：老版本把 `showArchived / moonWorld / moonSeed` 存在各自单独的键里，地址与 network ID **根本没落盘**。
 * 首次迁移把它们收进一条「默认连接」：地址沿用当前默认值、network ID 留空（**不编造历史值**），
 * Moon 与归档偏好原样保留。迁移只做一次（`profilesRaw` 存在就不再迁移）。
 */
object Profiles {

    const val SCHEMA_VERSION = 1
    const val DEFAULT_PROFILE_NAME = "默认连接"

    private const val HEADER = "sopho-profiles 1"
    private const val SELECTED = "selected "
    private const val SHOW_ARCHIVED = "showArchived "
    private const val PROFILE_LINE = "profile "

    fun encode(book: ProfileBook): String = buildString {
        appendLine(HEADER)
        appendLine("$SELECTED${book.selectedId ?: "-"}")
        appendLine("$SHOW_ARCHIVED${if (book.showArchived) "1" else "0"}")
        for (profile in book.profiles) {
            append(PROFILE_LINE)
            append(
                listOf(
                    profile.id,
                    profile.name,
                    profile.mode.name,
                    profile.serverUrl,
                    profile.networkId,
                    profile.moonWorld,
                    profile.moonSeed,
                ).joinToString("\t") { escape(it) },
            )
            appendLine()
        }
    }

    fun decode(raw: String?): ProfilesRead {
        if (raw.isNullOrBlank()) return ProfilesRead.Empty
        val strict = parse(recordsOf(raw, greedy = false))
        if (strict !is ProfilesRead.Corrupt) return strict
        // 严格拼不回去时，**只**多算一条候选给用户确认：把「不是记录开头」的行也当成同一条记录的最后一段。
        // 候选绝不替换 profilesRaw、绝不自己在内存里当 Ok（见 [ProfilesRead.Corrupt.candidate]）。
        val candidate = (parse(recordsOf(raw, greedy = true)) as? ProfilesRead.Ok)?.book
        return strict.copy(candidate = candidate)
    }

    /** 严格（`greedy=false`）／候选（`greedy=true`）共用的解析：只认 7 个字段的 `profile` 记录。 */
    private fun parse(recordsWithRepairs: Pair<List<Record>, Int>): ProfilesRead {
        val (records, repairedRecords) = recordsWithRepairs
        val header = records.firstOrNull()
        if (header == null || header.text != HEADER) {
            return ProfilesRead.Corrupt("首行不是本应用的格式标记「$HEADER」")
        }
        var selectedId: String? = null
        var hasSelected = false
        var showArchived = false
        var hasShowArchived = false
        val profiles = ArrayList<Profile>()
        for (record in records.drop(1)) {
            val line = record.text
            val where = "第 ${record.line} 行"
            when {
                line.startsWith(SELECTED) -> {
                    val value = line.removePrefix(SELECTED)
                    selectedId = if (value == "-") null else unescape(value)
                    hasSelected = true
                }

                line.startsWith(SHOW_ARCHIVED) -> {
                    showArchived = line.removePrefix(SHOW_ARCHIVED) == "1"
                    hasShowArchived = true
                }

                line.startsWith(PROFILE_LINE) -> {
                    val fields = line.removePrefix(PROFILE_LINE).split("\t")
                    if (fields.size != 7) {
                        return ProfilesRead.Corrupt("$where 的字段数不对：读到 ${fields.size} 个，应该是 7 个")
                    }
                    val mode = RunMode.entries.firstOrNull { it.name == unescape(fields[2]) }
                        ?: return ProfilesRead.Corrupt("$where 的连接方式读不懂")
                    profiles += Profile(
                        id = unescape(fields[0]),
                        name = unescape(fields[1]),
                        serverUrl = unescape(fields[3]),
                        mode = mode,
                        networkId = unescape(fields[4]),
                        moonWorld = unescape(fields[5]),
                        moonSeed = unescape(fields[6]),
                    )
                }

                // 错误里**只**说位置和“怎么回事”，不回显存下来的值（那是用户的明文地址/名字）。
                else -> return ProfilesRead.Corrupt("$where 不是本应用认识的记录")
            }
        }
        if (!hasSelected || !hasShowArchived) return ProfilesRead.Corrupt("缺少必要的一行（selected / showArchived）")
        val ids = profiles.map { it.id }.toSet()
        return ProfilesRead.Ok(
            ProfileBook(
                profiles = profiles,
                // 选中的那条不存在了（手改过/被删）⇒ 退回第一条，不静默保留悬空 id。
                selectedId = selectedId?.takeIf { it in ids } ?: profiles.firstOrNull()?.id,
                showArchived = showArchived,
            ),
            repairedRecords = repairedRecords,
        )
    }

    /** 一条逻辑记录 ＋ 它在存下来的原串里的物理行号（1 起算；错误信息用它指位置）。 */
    private class Record(val line: Int, var text: String)

    /**
     * 把存下来的原串切成逻辑记录，**尽量不丢任何字节**：
     *
     * 1. 只按 `\n` 切：`encode` 追的就是 `\n`。旧版本裸写的 `\r` 留在字段里当内容，
     *    不再像 `String.lines()` 那样被当成行分隔符（那会把一条配置拆成两条）。
     * 2. 旧版本写成“一条配置分两行”的样本（字段里的 `\r\n`）：如果上一行是**字段不足 7 个的** `profile` 行、
     *    而这一行又不是任何已知记录的开头，就用 `\n` 把两行拼回去（字节不少一个）——
     *    拼回去后是不是正好 7 个字段，由调用方按正常规则校验；拼不出 7 个就报 Corrupt，不猜。
     * 3. 行尾的**一个** `\r` 当作 CRLF 行尾吃掉（本应用从不写 `\r` 行尾），空白行丢弃。
     *    真机的 `SharedPreferences` 会在串尾补 XML 缩进（实测 4 个空格）⇒ 那一行全是空白，同样不算记录。
     *
     * `greedy=false`：**可确定**那一格。拼回之后必定正好 7 个字段才接（旧记录只有一个字段被切开时必然成立）。
     * `greedy=true`：**候选**那一格（只在严格模式已经失败后才算一次，结果交给用户确认）。此时把后面所有
     *             “不是记录开头”的行都先算作同一条记录的最后一段，能不能凑出 7 个字段由 [parse] 判。
     */
    private fun recordsOf(raw: String, greedy: Boolean): Pair<List<Record>, Int> {
        val records = ArrayList<Record>()
        var repaired = 0
        for ((index, physical) in raw.split('\n').withIndex()) {
            val previous = records.lastOrNull()
            if (previous != null && isSplitProfileRecord(previous.text, physical, greedy)) {
                previous.text = previous.text + "\n" + physical
                repaired += 1
            } else {
                records += Record(line = index + 1, text = physical)
            }
        }
        val normalized = records.mapNotNull { record ->
            val text = record.text.removeSuffix("\r")
            // 空白行丢弃：既是“空行不算记录”，也是**真机那一格**——`SharedPreferences` 的 XML 往返
            // 会在以换行结尾的串末尾补上 XML 缩进（2026-10-23 实测为 4 个空格，尾码点 `[10,32,32,32,32]`），
            // `encode` 正好以 `\n` 结尾 ⇒ 不丢这一行，每次真实进程重启后就多出“第 5 行看不懂”。
            // 全空白的行不能编码出任何一条合法记录（头行/selected/showArchived/profile 都以非空白开头）。
            if (text.isBlank()) null else Record(record.line, text)
        }
        return normalized to repaired
    }

    /**
     * 上一行是 `profile` 行、这一行又不是任何已知记录的开头 ⇒ 这一行可能是**同一条记录被换行切开**的后半截。
     *
     * - 严格模式：只有「接上之后正好 7 个字段」才接（这时它是唯一能读通的解释）；
     * - 候选模式：接上（还不满 7 个字段）就先攒着 —— 多段残片（字段里不止一个换行）也能攒成一条，
     *   但**只作为候选**，见 [ProfilesRead.Corrupt.candidate]。
     */
    private fun isSplitProfileRecord(previous: String, line: String, greedy: Boolean): Boolean {
        if (line.isEmpty() || !previous.startsWith(PROFILE_LINE)) return false
        if (isKnownRecordStart(line)) return false
        val fieldsSoFar = previous.removePrefix(PROFILE_LINE).split("\t").size
        val afterJoin = (fieldsSoFar - 1) + line.split("\t").size
        if (greedy) return afterJoin <= 7
        return fieldsSoFar < 7 && afterJoin == 7
    }

    private fun isKnownRecordStart(line: String): Boolean =
        line.startsWith(HEADER) || line.startsWith(SELECTED) || line.startsWith(SHOW_ARCHIVED) ||
            line.startsWith(PROFILE_LINE)

    /** 老版本的三个键 → 一条「默认连接」。地址/networkId 旧版本没存 ⇒ 用当前默认值、networkId 留空。 */
    fun migrateLegacy(
        showArchived: Boolean,
        moonWorld: String,
        moonSeed: String,
        defaultServerUrl: String,
        newId: String,
    ): ProfileBook = ProfileBook(
        profiles = listOf(
            Profile(
                id = newId,
                name = DEFAULT_PROFILE_NAME,
                serverUrl = defaultServerUrl,
                mode = RunMode.DIRECT,
                networkId = "",
                moonWorld = moonWorld,
                moonSeed = moonSeed,
            ),
        ),
        selectedId = newId,
        showArchived = showArchived,
    )

    /** 保存前的校验：返回 null = 可以存；否则是给人看的中文原因。 */
    fun validate(profile: Profile): String? {
        if (profile.name.isBlank()) return "配置名字不能是空的"
        val refusal = dev.sopho.pi.net.Destinations.refusal(profile.serverUrl)
        if (refusal != null) return refusal
        if (profile.mode == RunMode.ZEROTIER) {
            val networkId = profile.networkId.trim()
            if (networkId.length != 16 || networkId.any { it.digitToIntOrNull(16) == null }) {
                return "ZeroTier 模式的 network ID 要是 16 位十六进制（现在是「$networkId」）"
            }
            val moon = dev.sopho.pi.zt.Moon.parse(profile.moonWorld, profile.moonSeed)
            if (moon is dev.sopho.pi.zt.MoonInput.Invalid) return moon.message
        }
        return null
    }

    /** 草稿键：`profileId:sessionId` —— 不同 Profile 下同一个 server 的同名会话也不串。 */
    fun draftKey(profileId: String?, sessionId: String): String = (profileId ?: "-") + ":" + sessionId

    /** ZeroTier 这一层“要不要重启节点”的判据：只比会影响节点的字段。 */
    fun ztConfigKey(profile: Profile): String =
        "${profile.networkId.trim().lowercase()}|${profile.moonWorld.trim().lowercase()}|${profile.moonSeed.trim().lowercase()}"

    private fun escape(text: String): String = text
        .replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")

    /** 反解：新加了 `\r`；旧格式里没有 `\r` 这个转义 ⇒ 旧数据照样读，含义不变（`\\r` 仍是“反斜杠＋r”）。 */
    private fun unescape(text: String): String = buildString {
        var index = 0
        while (index < text.length) {
            val char = text[index]
            if (char == '\\' && index + 1 < text.length) {
                when (text[index + 1]) {
                    't' -> append('\t')
                    'n' -> append('\n')
                    'r' -> append('\r')
                    '\\' -> append('\\')
                    else -> append(text[index + 1])
                }
                index += 2
            } else {
                append(char)
                index += 1
            }
        }
    }
}
