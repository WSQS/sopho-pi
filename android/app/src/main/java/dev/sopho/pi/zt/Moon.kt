package dev.sopho.pi.zt

/** 一个可选的 Moon（用户自定义 root）：两个 64 位 id，不是 IP:port。 */
data class MoonConfig(val worldId: Long, val seedId: Long)

/** 输入解析结果。`Off` = 没填（默认：不额外 orbit）。 */
sealed interface MoonInput {
    data object Off : MoonInput
    data class Ok(val config: MoonConfig) : MoonInput
    data class Invalid(val message: String) : MoonInput
}

/**
 * `zts_moon_orbit` 的**契约**（按固定 AAR 对应的源码 `zerotier/libzt@a707ea6`，逐行抄在
 * `docs/ops/android-client.md` §11；不是按记忆或按别的发行版猜的）：
 *
 * ```
 * include/ZeroTierSockets.h:1762
 * ZTS_API int ZTCALL zts_moon_orbit(uint64_t moon_roots_id, uint64_t moon_seed);
 *     @param moon_roots_id World ID
 *     @param moon_seed     Seed ID
 *     @return ZTS_ERR_OK / ZTS_ERR_SERVICE（节点不行）/ ZTS_ERR_ARG（参数非法）
 *
 * src/Controls.cpp:648-653
 * int zts_moon_orbit(uint64_t moon_roots_id, uint64_t moon_seed)
 * {
 *     ACQUIRE_SERVICE(ZTS_ERR_SERVICE);      // 服务为空或没在跑 ⇒ 直接 return -2
 *     zts_service->orbit(moon_roots_id, moon_seed);
 *     return ZTS_ERR_OK;                     // ← orbit() 的返回值被丢掉，恒回 0
 * }
 *
 * src/NodeService.cpp:1458-1466
 * int NodeService::orbit(uint64_t moon_roots_id, uint64_t moon_seed)
 * {
 *     if (! moon_roots_id || ! moon_seed) { return ZTS_ERR_ARG; }   // 0 ⇒ -3（但这个 -3 到不了 Java 侧）
 *     if (! _run) { return ZTS_ERR_SERVICE; }
 *     return _node->orbit(NULL, moon_roots_id, moon_seed);
 * }
 * ```
 *
 * ⇒ 两个参数是 **World ID / Seed ID**（各 16 位十六进制），**不是** `moon(ip, port)`。
 * ⇒ Java 侧能看到的返回码只有 **0**（调用被接受）与 **-2**（服务没在跑）；`orbit()` 的真实结果
 *   被 C 层丢掉了，所以 **0 不能当“moon 真的可用”** 用 —— 界面必须如实这么写。
 * ⇒ `zts_moon_orbit` 要求节点在跑（`isRunning`），所以调用点必须在 `zts_start` 之后。
 */
object Moon {

    /** ZeroTierSockets 的错误码（`include/ZeroTierSockets.h` 的 `ZTS_ERR_*`）。 */
    const val ZTS_ERR_OK = 0
    const val ZTS_ERR_SOCKET = -1
    const val ZTS_ERR_SERVICE = -2
    const val ZTS_ERR_ARG = -3
    const val ZTS_ERR_NO_RESULT = -4
    const val ZTS_ERR_GENERAL = -5

    const val HEX_DIGITS = 16

    /** 界面与文档共用的一句提醒：0 不等于“moon 成功”。 */
    const val CAVEAT =
        "返回 0 只表示「调用被接受」：C 层的 zts_moon_orbit 丢掉了 orbit() 的真实返回值（恒回 0），" +
            "所以它既不能证明 moon 可达，也不能证明已生效"

    fun parse(worldText: String, seedText: String): MoonInput {
        val world = worldText.trim()
        val seed = seedText.trim()
        if (world.isEmpty() && seed.isEmpty()) return MoonInput.Off
        if (world.isEmpty() || seed.isEmpty()) {
            return MoonInput.Invalid("Moon 的 World ID 与 Seed ID 要么都填、要么都留空（现在只填了其中一个）")
        }
        val worldId = parseId(world, "World ID") ?: return MoonInput.Invalid(invalidText(world, "World ID"))
        val seedId = parseId(seed, "Seed ID") ?: return MoonInput.Invalid(invalidText(seed, "Seed ID"))
        if (worldId == 0L) return MoonInput.Invalid("World ID 不能是全 0（libzt 的 orbit 对 0 值返回 ZTS_ERR_ARG）")
        if (seedId == 0L) return MoonInput.Invalid("Seed ID 不能是全 0（libzt 的 orbit 对 0 值返回 ZTS_ERR_ARG）")
        return MoonInput.Ok(MoonConfig(worldId, seedId))
    }

    /** 返回码 → 人能读的一句话（`-3` 在 Java 侧实际看不到，但契约里它有定义，照实列出来）。 */
    fun resultText(rc: Int): String = when (rc) {
        ZTS_ERR_OK -> "0（ZTS_ERR_OK：调用被接受）"
        ZTS_ERR_SOCKET -> "$rc（ZTS_ERR_SOCKET：socket 层错误）"
        ZTS_ERR_SERVICE -> "$rc（ZTS_ERR_SERVICE：节点没在跑 —— orbit 必须在 zts_start 之后）"
        ZTS_ERR_ARG -> "$rc（ZTS_ERR_ARG：参数非法）"
        ZTS_ERR_NO_RESULT -> "$rc（ZTS_ERR_NO_RESULT：无结果）"
        ZTS_ERR_GENERAL -> "$rc（ZTS_ERR_GENERAL：一般错误）"
        else -> "$rc（契约外/未预期的返回码）"
    }

    /** 只有 0 算“调用被接受”；负数一律当失败上屏（并且不继续把 Ready 说成成功之外的东西）。 */
    internal fun accepted(rc: Int): Boolean = rc == ZTS_ERR_OK

    private fun invalidText(raw: String, label: String): String =
        "$label 要是 $HEX_DIGITS 位十六进制（现在写的是「$raw」）；它不是 IP:port，也不是网络 ID"

    /** 允许 `0x` 前缀、大小写；按 **无符号** 64 位解析（高位置 1 的 id 会得到负的 Long 位型，位型才是要传的东西）。 */
    private fun parseId(raw: String, label: String): Long? {
        val text = raw.removePrefix("0x").removePrefix("0X")
        if (text.length != HEX_DIGITS) return null
        if (text.any { it.digitToIntOrNull(16) == null }) return null
        return runCatching { java.lang.Long.parseUnsignedLong(text, 16) }.getOrNull()
    }

    /** 上屏用的十六进制（补到 16 位，不受 Long 符号影响）。 */
    fun hex(id: Long): String = java.lang.Long.toUnsignedString(id, 16).padStart(HEX_DIGITS, '0')
}
