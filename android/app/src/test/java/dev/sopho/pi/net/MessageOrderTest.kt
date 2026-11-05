package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 钉住「额外消息（`extras`）在正文流里的落位」—— 规则照 `web/render.js` 的 `extraBoundaries()`
 * （五档锚），这里只测**纯逻辑**：不碰 OkHttp、不碰 Compose、不碰真实服务。
 *
 * 反证臂（都会真红）：把「按 `parentId` 落位」去掉 ⇒ 第 1/3/6 条红；把「不画出来的条目也占下标」
 * 改成先过滤再取锚 ⇒ 第 5 条红（extra 会跑到工具结果前面）；把「严格大于」改成「大于等于」⇒ 第 4 条红；
 * 把边界换成「末尾」回落 ⇒ 第 2/3 条红；`takeLast(120)` 改成「先拼末尾再截」⇒ 最后一条红。
 */
class MessageOrderTest {

    private fun body(
        id: String,
        parentId: String?,
        timestamp: String?,
        rendered: Boolean = true,
    ) = MessageOrder.Body(id, parentId, timestamp, rendered)

    private fun extra(id: String, parentId: String?, timestamp: String?) =
        MessageOrder.Extra(id, parentId, timestamp)

    /** 把落位结果译成「谁」的字符串，断言时一眼能读。 */
    private fun names(
        bodies: List<MessageOrder.Body>,
        extras: List<MessageOrder.Extra>,
        compactionEntryId: String? = null,
        compactionAtIndex: Int? = null,
    ): List<String> = MessageOrder.place(bodies, extras, compactionEntryId, compactionAtIndex).map { slot ->
        when (slot) {
            is MessageOrder.Slot.BodySlot -> bodies[slot.index].entryId
            is MessageOrder.Slot.ExtraSlot -> extras[slot.index].entryId
        }
    }

    // ── ① parentId 命中正文：落在那条正文**之后**，不是堆到末尾 ─────────────────────────

    @Test
    fun `an extra anchored on a message sits right after it instead of at the end`() {
        val bodies = listOf(
            body("u1", parentId = null, timestamp = "2026-09-01T00:00:01.000Z"),
            body("a1", parentId = "u1", timestamp = "2026-09-01T00:00:02.000Z"),
            body("u2", parentId = "a1", timestamp = "2026-09-01T00:00:03.000Z"),
            body("a2", parentId = "u2", timestamp = "2026-09-01T00:00:04.000Z"),
        )
        val extras = listOf(extra("x1", parentId = "a1", timestamp = "2026-09-01T00:00:02.500Z"))

        assertEquals(listOf("u1", "a1", "x1", "u2", "a2"), names(bodies, extras))
    }

    @Test
    fun `several extras anchored at different messages keep their own places and extras order`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
            body("u2", "a1", "2026-09-01T00:00:03.000Z"),
            body("a2", "u2", "2026-09-01T00:00:04.000Z"),
        )
        val extras = listOf(
            extra("x1", parentId = "u2", timestamp = "2026-09-01T00:00:03.500Z"),
            extra("x2", parentId = "a1", timestamp = "2026-09-01T00:00:02.100Z"),
            extra("x3", parentId = "u2", timestamp = "2026-09-01T00:00:03.600Z"),
        )

        // x1/x3 同锚（u2 之后）⇒ 先后按 extras 数组顺序；x2 锚在 a1 之后。
        assertEquals(listOf("u1", "a1", "x2", "u2", "x1", "x3", "a2"), names(bodies, extras))
    }

    // ── ② 压缩块：锚在 compaction 条目上 ⇒ 落在 messages[atIndex] 之前（与压缩块同一道缝）─────

    @Test
    fun `an extra anchored on the compaction entry lands at its atIndex`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
            body("u2", "a1", "2026-09-01T00:00:03.000Z"),
        )
        val extras = listOf(extra("x1", parentId = "c1", timestamp = "2026-09-01T00:00:02.500Z"))

        assertEquals(
            listOf("u1", "a1", "u2", "x1"),
            names(bodies, extras, compactionEntryId = "c1", compactionAtIndex = 3),
        )
        assertEquals(
            listOf("u1", "x1", "a1", "u2"),
            names(bodies, extras, compactionEntryId = "c1", compactionAtIndex = 1),
        )
        // 越界的 atIndex ⇒ 末尾（web 的同一档回落），不是“插到第 0 条之前”。
        assertEquals(listOf("u1", "a1", "u2", "x1"), names(bodies, extras, compactionEntryId = "c1", compactionAtIndex = 99))
        // 服务端说“没压缩过”（`{entryId:null, atIndex:null, note:…}`）⇒ 第二档根本不成立，
        // 落到第四档时间錨：02.500 之后的第一条正文是 u2 ⇒ 落在 a1 之后、u2 之前。
        assertEquals(listOf("u1", "a1", "x1", "u2"), names(bodies, extras, compactionEntryId = null, compactionAtIndex = null))
    }

    // ── ③ 两条连续的 extra：后一条锚在前一条上 ⇒ 同边界，顺序由 extras 数组保住 ─────────────

    @Test
    fun `a chained extra shares its parent extra's boundary`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
            body("u2", "a1", "2026-09-01T00:00:03.000Z"),
        )
        val extras = listOf(
            extra("x1", parentId = "a1", timestamp = "2026-09-01T00:00:02.100Z"),
            extra("x2", parentId = "x1", timestamp = "2026-09-01T00:00:02.200Z"),
        )

        assertEquals(listOf("u1", "a1", "x1", "x2", "u2"), names(bodies, extras))
    }

    // ── ④ 父在本 payload 里查不到 ⇒ 按 timestamp：第一条**严格更晚**的正文之前 ─────────────

    @Test
    fun `an unanchorable parent falls back to the timestamp of the first strictly later message`() {
        val bodies = listOf(
            body("u1", "model-change-1", "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
            body("u2", "a1", "2026-09-01T00:00:03.000Z"),
        )
        val extras = listOf(extra("x1", parentId = "model-change-1", timestamp = "2026-09-01T00:00:02.000Z"))

        // 同一毫秒**不算更晚**（严格 >）⇒ 落在 a1 之后、u2 之前。
        assertEquals(listOf("u1", "a1", "x1", "u2"), names(bodies, extras))
    }

    @Test
    fun `an extra whose parent id is absent from the page is placed by time, not at the end`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:05.000Z"),
            body("a1", "u1", "2026-09-01T00:00:06.000Z"),
        )
        val extras = listOf(extra("x1", parentId = "missing-entry", timestamp = "2026-09-01T00:00:01.000Z"))

        assertEquals(listOf("x1", "u1", "a1"), names(bodies, extras))
    }

    // ── ⑤ 连 timestamp 都没有 ⇒ 末尾（回落路径），且顺序仍是 extras 数组顺序 ───────────────

    @Test
    fun `an extra without any anchor falls back to the end in extras order`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
        )
        val extras = listOf(
            extra("x1", parentId = null, timestamp = null),
            extra("x2", parentId = "gone", timestamp = null),
        )

        assertEquals(listOf("u1", "a1", "x1", "x2"), names(bodies, extras))
    }

    @Test
    fun `when no message carries a readable timestamp the extra also falls back to the end`() {
        val bodies = listOf(
            body("u1", null, null),
            body("a1", "u1", "不是时间"),
        )
        val extras = listOf(extra("x1", parentId = "gone", timestamp = "2026-09-01T00:00:01.000Z"))

        assertEquals(listOf("u1", "a1", "x1"), names(bodies, extras))
    }

    // ── 不画出来的条目（toolResult / bashExecution）仍占下标：锚坐标系不能被“先过滤”挪动 ────

    @Test
    fun `a non rendered entry still holds its index so an anchor on it stays after the tool call`() {
        val bodies = listOf(
            body("u1", null, "2026-09-01T00:00:01.000Z"),
            body("a1", "u1", "2026-09-01T00:00:02.000Z"),
            body("tool-result-1", "a1", "2026-09-01T00:00:02.500Z", rendered = false),
            body("u2", "tool-result-1", "2026-09-01T00:00:03.000Z"),
        )
        // 这条 extra 的时间戳**比所有正文都早**：只有“先取锚（不画出来的工具结果也占下标）
        // 再换算到渲染序列”才会把它放在那次工具调用之后；若先把不画的条目过滤掉再去取锚，
        // 父就查不到了，会落到时间回落档 ⇒ 跑到最前面。
        val extras = listOf(
            extra("x-after-tool", parentId = "tool-result-1", timestamp = "2026-09-01T00:00:00.500Z"),
            extra("x-after-assistant", parentId = "a1", timestamp = "2026-09-01T00:00:02.100Z"),
        )

        assertEquals(
            listOf("u1", "a1", "x-after-tool", "x-after-assistant", "u2"),
            names(bodies, extras),
        )
    }

    // ── 窗口：`takeLast(120)` 只截“按位置排好的序列”，不因末尾堆 extras 丢掉正文 ─────────────

    @Test
    fun `the last 120 items keep the newest bodies because extras stay at their anchors`() {
        // 130 条正文；3 条 extra 锚在第 2 条正文之后（很老），1 条锚在最后一条正文之后（最新）。
        val bodies = (0 until 130).map { index ->
            body(
                id = "b%03d".format(index),
                parentId = if (index == 0) null else "b%03d".format(index - 1),
                timestamp = "2026-09-01T00:%02d:%02d.000Z".format(index / 60, index % 60),
            )
        }
        val extras = listOf(
            extra("early-1", parentId = "b001", timestamp = "2026-09-01T00:00:01.500Z"),
            extra("early-2", parentId = "b001", timestamp = "2026-09-01T00:00:01.600Z"),
            extra("early-3", parentId = "b001", timestamp = "2026-09-01T00:00:01.700Z"),
            extra("newest", parentId = "b129", timestamp = "2026-09-01T00:02:09.500Z"),
        )
        val placed = MessageOrder.place(bodies, extras).map { slot ->
            when (slot) {
                is MessageOrder.Slot.BodySlot -> bodies[slot.index].entryId
                is MessageOrder.Slot.ExtraSlot -> extras[slot.index].entryId
            }
        }
        assertEquals("最早的 extra 也要排在它锚定的正文之后", listOf("b000", "b001", "early-1", "early-2", "early-3", "b002"), placed.take(6))

        val window = placed.takeLast(120)
        assertEquals(120, window.size)
        assertEquals("窗口最后一项是最新的那条（锚在最后一条正文上的 extra）", "newest", window.last())
        assertEquals("窗口里留下 119 条正文", 119, window.count { it.startsWith("b") })
        assertEquals("老 extra 不该占掉窗口里的正文位置", 1, window.count { !it.startsWith("b") })
    }
}
