package dev.sopho.pi.zt

import com.zerotier.sockets.ZeroTierNative

/**
 * 「配了 Moon 就 orbit 一次」这一小步，单独成类是为了**能用替身测**（`ZtManager` 里那条路径要 native 的
 * `ZeroTierNode`，JVM 单测跑不了）。
 *
 * 调用点（在 `ZtManager.start` 里）必须在 `zts_start` 之后：`zts_moon_orbit` 的 `ACQUIRE_SERVICE`
 * 要求服务在跑，否则直接返回 `ZTS_ERR_SERVICE`(-2)。语义见 [Moon] 的注释。
 */
class MoonLauncher(
    private val orbiter: MoonOrbiter = MoonOrbiter { worldId, seedId ->
        ZeroTierNative.zts_moon_orbit(worldId, seedId)
    },
) {

    /** `text` = 上屏读数（没配置时为 null）；`failure` 非 null ⇒ 这次连接必须中止。 */
    data class Result(val text: String?, val failure: String?)

    fun orbitIfConfigured(moon: MoonConfig?): Result {
        if (moon == null) return Result(text = null, failure = null) // 空 = 不额外 orbit
        val rc = orbiter.orbit(moon.worldId, moon.seedId)
        val text = "Moon orbit ${Moon.resultText(rc)}"
        return if (Moon.accepted(rc)) {
            Result(text = text, failure = null)
        } else {
            Result(text = text, failure = "$text —— 连接中止（${Moon.CAVEAT}）")
        }
    }
}
