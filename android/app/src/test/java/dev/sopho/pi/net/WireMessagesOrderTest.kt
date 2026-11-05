package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/messages` 的**解析层**：服务端给的 `messages` / `extras` / `compaction` 三个字段，
 * 解析后要成为**一条按位置排好的渲染序列**（业主反馈：「额外消息全堆最后」）。
 *
 * 用的全是**合成 fixtures**（不碰真实会话、不读聊天正文），形状照
 * `test/fixtures/messages-parity.golden.json`（真实 `/messages` 的归一化读数）：
 * `messages[i]` 带 `entryId / parentId / timestamp / role`，
 * `extras[i]` 带 `entryId / parentId / timestamp / display / customType / text`，
 * `compaction = {entryId, atIndex}`，且 `toolResult` 这类条目**也在 `messages` 里占下标**。
 *
 * 反证臂：把 `Wire.parseMessages` 换回「先 messages、再 `rows += extras`」的旧形状 ⇒ 本类几乎全红
 * （`... without extras ...` 与空页那两条除外）—— 那正是业主看到的样子。
 */
class WireMessagesOrderTest {

    private fun page(body: String) = Wire.parseMessages(body)

    private fun order(body: String): List<String> = page(body).messages.map { message ->
        when (message.role) {
            "extra" -> "×" + message.text
            else -> message.text
        }
    }

    private fun message(
        id: String,
        parentId: String?,
        role: String,
        text: String,
        timestamp: String?,
    ): String = buildString {
        append("{\"entryId\":\"").append(id).append('"')
        append(",\"parentId\":").append(if (parentId == null) "null" else "\"$parentId\"")
        append(",\"timestamp\":").append(if (timestamp == null) "null" else "\"$timestamp\"")
        append(",\"role\":\"").append(role).append('"')
        append(",\"text\":\"").append(text).append('"')
        append('}')
    }

    private fun extra(id: String, parentId: String?, text: String, timestamp: String?): String = buildString {
        append("{\"entryId\":\"").append(id).append('"')
        append(",\"parentId\":").append(if (parentId == null) "null" else "\"$parentId\"")
        append(",\"timestamp\":").append(if (timestamp == null) "null" else "\"$timestamp\"")
        append(",\"customType\":\"sopho.delegation\",\"display\":true")
        append(",\"text\":\"").append(text).append('"')
        append('}')
    }

    @Test
    fun `extras come back to their anchors instead of being appended to the end`() {
        val messages = listOf(
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z"),
            message("a1", "u1", "assistant", "A1", "2026-09-01T00:00:02.000Z"),
            message("t1", "a1", "toolResult", "TOOL", "2026-09-01T00:00:02.500Z"),
            message("u2", "t1", "user", "U2", "2026-09-01T00:00:03.000Z"),
            message("a2", "u2", "assistant", "A2", "2026-09-01T00:00:04.000Z"),
        )
        val extras = listOf(
            // 锚在工具结果上，且时间戳**比正文都早**：只有“不画出来的条目也占锚下标”才会留在这里；
            // 若先过滤再取锚，它就落到时间回落档 ⇒ 跑到 U1 前面。
            extra("x1", "t1", "X-ON-TOOL", "2026-09-01T00:00:00.500Z"),
            // 锚在助手正文上。
            extra("x2", "a1", "X-AFTER-A1", "2026-09-01T00:00:02.000Z"),
            // 父是本 payload 里查不到的条目（例如 model_change）⇒ 按 timestamp：A1 之后、U2 之前。
            extra("x3", "model-change-1", "X-BY-TIME", "2026-09-01T00:00:02.000Z"),
            // 锚在前一条 extra 上 ⇒ 与它同边界。
            extra("x4", "x2", "X-CHAINED", "2026-09-01T00:00:02.200Z"),
            // 锚在 U2 上 ⇒ 落在 U2 之后、A2 之前。
            extra("x5", "u2", "X-AFTER-U2", "2026-09-01T00:00:03.500Z"),
            // 没有任何锚 ⇒ 末尾（回落路径）。
            extra("x6", null, "X-NO-ANCHOR", null),
        )
        val body = """{"messages":[""" + messages.joinToString(",") +
            """],"extras":[""" + extras.joinToString(",") +
            """],"compaction":{"entryId":"c1","atIndex":4}}"""

        // 同一个边界位上的几条 extra 按 `extras` 数组顺序（服务端按会话链顺序 push），不重排。
        assertEquals(
            listOf(
                "U1", "A1",
                "×X-ON-TOOL", "×X-AFTER-A1", "×X-BY-TIME", "×X-CHAINED",
                "U2", "×X-AFTER-U2", "A2", "×X-NO-ANCHOR",
            ),
            order(body),
        )
    }

    @Test
    fun `an extra anchored on the compaction entry lands at atIndex`() {
        val body = """{"messages":[""" +
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z") + "," +
            message("a1", "u1", "assistant", "A1", "2026-09-01T00:00:02.000Z") +
            """],"extras":[""" +
            extra("x1", "c1", "X-COMPACTION", "2026-09-01T00:00:02.500Z") +
            """],"compaction":{"entryId":"c1","atIndex":1,"note":"…"}}"""

        assertEquals(listOf("U1", "×X-COMPACTION", "A1"), order(body))
    }

    @Test
    fun `an empty compaction block from the server is not an anchor`() {
        val body = """{"messages":[""" +
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z") +
            """],"extras":[""" +
            extra("x1", "c1", "X", "2026-09-01T00:00:02.500Z") +
            """],"compaction":{"entryId":null,"atIndex":null,"note":"没有压缩过"}}"""

        assertEquals(listOf("U1", "×X"), order(body))
    }

    /** 同一条会话刷新两次（同样的 payload）顺序必须一样 —— 只有方向、没有随机。 */
    @Test
    fun `the same payload always produces the same order`() {
        val body = """{"messages":[""" +
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z") + "," +
            message("a1", "u1", "assistant", "A1", "2026-09-01T00:00:02.000Z") +
            """],"extras":[""" +
            extra("x1", "u1", "X1", "2026-09-01T00:00:01.000Z") + "," +
            extra("x2", "u1", "X2", "2026-09-01T00:00:01.000Z") +
            """]}"""

        assertEquals(order(body), order(body))
        // 同一毫秒的正文不算“更晚”：两条 extra 都落在 U1 之后（按 extras 顺序），A1 之前。
        assertEquals(listOf("U1", "×X1", "×X2", "A1"), order(body))
    }

    /** 既有渲染过滤不许被这次改动带歪：非 user/assistant、空正文照样不画，但仍占锚下标。 */
    @Test
    fun `rendering filters are unchanged while filtered entries still hold their index`() {
        val body = """{"messages":[""" +
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z") + "," +
            message("b1", "u1", "bashExecution", "BASH", "2026-09-01T00:00:02.000Z") + "," +
            message("a2", "b1", "assistant", "", "2026-09-01T00:00:03.000Z") + "," +
            message("a3", "a2", "assistant", "A3", "2026-09-01T00:00:04.000Z") +
            """],"extras":[""" +
            extra("x1", "b1", "X-AFTER-BASH", "2026-09-01T00:00:00.500Z") +
            """]}"""

        assertEquals(listOf("U1", "×X-AFTER-BASH", "A3"), order(body))
    }

    /** `extras` 缺失 / 空白（老服务端或没有额外消息的会话）⇒ 行为与改动前逐字相同。 */
    @Test
    fun `a payload without extras keeps the plain message order`() {
        val messages = """{"messages":[""" +
            message("u1", null, "user", "U1", "2026-09-01T00:00:01.000Z") + "," +
            message("a1", "u1", "assistant", "A1", "2026-09-01T00:00:02.000Z") +
            """]}"""
        assertEquals(listOf("U1", "A1"), order(messages))
        assertEquals(
            listOf("U1", "A1"),
            order("""{"messages":[{"role":"user","text":"U1"},{"role":"assistant","text":"A1"}],"extras":[]}"""),
        )
    }

    /** 空页面（空会话）不报错：没有正文、没有额外消息 ⇒ 空序列，不是异常。 */
    @Test
    fun `an empty page parses to an empty list`() {
        assertTrue(page("""{"messages":[],"extras":[],"compaction":{"entryId":null,"atIndex":null}}""").messages.isEmpty())
        assertTrue(page("""{}""").messages.isEmpty())
    }
}
