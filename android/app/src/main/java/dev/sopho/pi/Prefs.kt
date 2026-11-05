package dev.sopho.pi

import android.content.Context

/**
 * 应用私有的偏好（`SharedPreferences`）：
 *
 * - `profilesRaw` —— Profile v1 的**整块**（格式见 [Profiles]），连 selectedId 与 showArchived 一起存；
 * - `migrationDone` —— 老键 → Profile 的迁移只做一次的标记；
 * - 老键 `showArchived` / `moonWorld` / `moonSeed` —— **只读**（迁移用），迁移之后不再写；
 * - `profilesRaw.corrupt` —— 读到坏数据时把原串**另存一份**，绝不就地覆盖唯一配置。
 *
 * 明确**不存**：libzt identity（在 `filesDir/zerotier`，libzt 自己维护）、任何口令/令牌。
 * `allowBackup=false`（见 AndroidManifest）——所以也不承诺“有备份”。
 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    var profilesRaw: String?
        get() = sp.getString(KEY_PROFILES_RAW, null)
        set(value) {
            sp.edit().putString(KEY_PROFILES_RAW, value).apply()
        }

    /** 迁移只做一次：即使用户后来把 Profile 全删了，也不该再拿老键“复活”一条。 */
    var migrationDone: Boolean
        get() = sp.getBoolean(KEY_MIGRATION_DONE, false)
        set(value) {
            sp.edit().putBoolean(KEY_MIGRATION_DONE, value).apply()
        }

    /** 坏数据的原样备份（可读错误里会带上它的键名，好让人去捞）。 */
    fun backupCorruptProfiles(raw: String) {
        sp.edit().putString(KEY_PROFILES_RAW_CORRUPT, raw).apply()
    }

    // ── 老键（只读；迁移用）──
    val legacyShowArchived: Boolean get() = sp.getBoolean(KEY_SHOW_ARCHIVED, false)
    val legacyMoonWorld: String get() = sp.getString(KEY_MOON_WORLD, "") ?: ""
    val legacyMoonSeed: String get() = sp.getString(KEY_MOON_SEED, "") ?: ""

    /** 老版本有过 `showArchived` 这个键吗（有 ⇒ 值得迁移）。 */
    val hasLegacyKeys: Boolean get() = sp.contains(KEY_SHOW_ARCHIVED) || sp.contains(KEY_MOON_WORLD) || sp.contains(KEY_MOON_SEED)

    private companion object {
        const val KEY_PROFILES_RAW = "profilesRaw"
        const val KEY_PROFILES_RAW_CORRUPT = "profilesRaw.corrupt"
        const val KEY_MIGRATION_DONE = "profilesMigrationDone"
        const val KEY_SHOW_ARCHIVED = "showArchived"
        const val KEY_MOON_WORLD = "moonWorld"
        const val KEY_MOON_SEED = "moonSeed"
    }
}
