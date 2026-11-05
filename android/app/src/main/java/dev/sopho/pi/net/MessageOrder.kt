package dev.sopho.pi.net

import java.time.Instant
import java.time.OffsetDateTime

/**
 * 把 `/messages` 里的 `extras`（`custom_message`）摆回正文流里 —— **逐档照搬** `web/render.js` 的
 * `extraBoundaries()`（2026-10-24 逐行核过），不自己发明一套排序。
 *
 * 为什么不能按 `timestamp` 无脑排：服务端把两种东西**分成两个数组**（`server/base-logic.mjs` 的
 * `messageWire()`）：`messages` 是链序正文（含 `toolResult` / `bashExecution` 这些**不单独画**的条目），
 * `extras` 是 `custom_message`（带 `entryId / parentId / timestamp`，**没有** `atIndex`）。
 * 真正的位置是**锚**：`parentId` / 压缩块的 `atIndex` / 时间，五档优先级（见下）。
 * 无脑按时间排会把同一毫秒内的条目翻面，也会把“父是本 payload 里查不到的条目”的那种错放到末尾之后。
 *
 * 下标坐标系 = **服务端 `messages` 数组**（`toolResult` 之类也占一个下标）—— 与 web 完全一致；
 * 只有真正会被画出来的条目（`role` 是 user/assistant 且有正文）才落在渲染序列里，
 * 因此“边界位 b ⇒ 渲染位置 = 下标 < b 的、会被画出来的条目数”。
 *
 * 红线（沿用 v2.1 原意）：extra 永远是**独立**的「额外消息」块，不并进任何正文；这里只改**摆放位置**。
 */
object MessageOrder {

    /** 一条 `messages` 条目：**不画出来的也占一个下标**（锚坐标系与 web 相同）。 */
    data class Body(
        val entryId: String,
        val parentId: String?,
        val timestamp: String?,
        /** 这条会不会落成界面上的一行（`role` 是 user/assistant 且正文非空）。 */
        val rendered: Boolean,
    )

    /** 一条 `extras` 条目（`custom_message`）：正文为空的那条也进锚链，只是不画。 */
    data class Extra(
        val entryId: String,
        val parentId: String?,
        val timestamp: String?,
    )

    /** 落位结果：要么是 `bodies[index]`，要么是 `extras[index]`；顺序就是渲染顺序。 */
    sealed interface Slot {
        data class BodySlot(val index: Int) : Slot
        data class ExtraSlot(val index: Int) : Slot
    }

    /**
     * @param bodies 服务端 `messages` 的**全部**条目（顺序就是服务端给的链序，不重排）。
     * @param extras 服务端 `extras` 的顺序（服务端按 `getBranch()` 一遍遍历 push ⇒ 就是会话链顺序）。
     * @param compactionEntryId `compaction.entryId`（最近一次压缩；没有就是 null）。
     * @param compactionAtIndex `compaction.atIndex`（压缩块画在 `messages[atIndex]` **之前**）。
     */
    fun place(
        bodies: List<Body>,
        extras: List<Extra>,
        compactionEntryId: String? = null,
        compactionAtIndex: Int? = null,
    ): List<Slot> {
        val renderedCount = bodies.count { it.rendered }
        if (extras.isEmpty()) {
            return bodies.indices.filter { bodies[it].rendered }.map { Slot.BodySlot(it) }
        }
        val indexByEntry = HashMap<String, Int>(bodies.size * 2)
        bodies.forEachIndexed { index, body -> if (body.entryId.isNotEmpty()) indexByEntry[body.entryId] = index }

        // ① parentId 命中 messages[i] ⇒ b = i + 1（落在那条正文**之后**；toolResult 也占下标、也算“那条之后”）
        // ② parentId === compaction.entryId ⇒ b = atIndex（越界/拿不到 ⇒ 末尾）
        // ③ parentId 命中**另一条 extra** ⇒ 与父同边界（先后靠 extras 数组顺序）
        // ④ 都不是 ⇒ 按 timestamp：排在第一条时间**严格更晚**的正文之前
        // ⑤ 连 timestamp 都读不到 ⇒ 末尾（**回落路径**，不是正常路径）
        val boundaryByExtraEntry = HashMap<String, Int>(extras.size * 2)
        val boundaries = IntArray(extras.size)
        for (index in extras.indices) {
            val extra = extras[index]
            val parentIndex = extra.parentId?.let { indexByEntry[it] }
            boundaries[index] = when {
                parentIndex != null -> parentIndex + 1
                compactionEntryId != null && extra.parentId == compactionEntryId ->
                    if (compactionAtIndex != null && compactionAtIndex in 0..bodies.size) compactionAtIndex else bodies.size

                extra.parentId != null && boundaryByExtraEntry.containsKey(extra.parentId) ->
                    boundaryByExtraEntry.getValue(extra.parentId)

                else -> firstBodyAfter(bodies, extra.timestamp)
            }
            if (extra.entryId.isNotEmpty()) boundaryByExtraEntry[extra.entryId] = boundaries[index]
        }

        // 边界位 b ⇒ 渲染位置（下标 < b 的、会被画出来的条目数）。不画出来的条目只推进边界，不占渲染位置。
        val renderedBefore = IntArray(bodies.size + 1)
        for (index in bodies.indices) {
            renderedBefore[index + 1] = renderedBefore[index] + if (bodies[index].rendered) 1 else 0
        }
        val buckets = Array(renderedCount + 1) { ArrayList<Int>(0) }
        for (index in extras.indices) buckets[renderedBefore[boundaries[index]]].add(index)

        val out = ArrayList<Slot>(renderedCount + extras.size)
        buckets[0].forEach { out += Slot.ExtraSlot(it) }
        var placed = 0
        for (index in bodies.indices) {
            if (!bodies[index].rendered) continue
            out += Slot.BodySlot(index)
            placed += 1
            buckets[placed].forEach { out += Slot.ExtraSlot(it) }
        }
        return out
    }

    /**
     * 第一条时间**严格晚于** `timestamp` 的正文的下标；都更早 ⇒ 末尾；一条时间都读不到 ⇒ 末尾（web 的第 ⑤ 档）。
     * 同一毫秒**不算更晚**（严格 `>`）—— 于是同时刻的 extra 落在那些正文**之后**，且不自作主张翻面。
     */
    private fun firstBodyAfter(bodies: List<Body>, timestamp: String?): Int {
        val value = parseTimestamp(timestamp) ?: return bodies.size
        for (index in bodies.indices) {
            val other = parseTimestamp(bodies[index].timestamp) ?: continue
            if (other > value) return index
        }
        return bodies.size
    }

    /** 服务端写的 `entry.timestamp` 是 ISO 8601（`2026-09-01T00:00:03.000Z`）；读不懂就 null，不猜。 */
    private fun parseTimestamp(value: String?): Instant? {
        if (value.isNullOrEmpty()) return null
        runCatching { return Instant.parse(value) }
        return runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
    }
}
