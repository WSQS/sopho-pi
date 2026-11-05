package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/messages` 的**正文长度**：客户端不按字数截断 —— 长正文（> 旧上限 6000 字）必须**整段**到渲染层。
 *
 * 修前 [Wire.parseMessages] 把每条正文切到 `MAX_TEXT_CHARS`（6000）并接一句「…（已截断，只显示前 6000 字）」，
 * 于是长回复的**尾部**在安卓上看不到（完整保留是这条线的要求）。
 * 服务端 `/messages` 本来就把整段 `text` 给全（`server/base-logic.mjs` 的 `contentText(entry.content)`），
 * 所以这里钉的是「解析层不许再把服务端给全的正文切掉」。
 *
 * 反证臂：把 `Wire.parseMessages` 改回 `text.take(6000) + "…（已截断…）"`（或重新引入 `MAX_TEXT_CHARS`）
 * ⇒ 前三条当场全红（实测：`4 tests completed, 3 failed`，红原文里能看见那句「…（已截断，只显示前 6000 字）」）。
 * 第四条（额外消息）修前修后都绿 —— 额外消息**本来就没被切过**，它守的是“别把截断又加到这条路上”。
 */
class WireMessageTextTest {

    private fun messagesJson(vararg items: String) = "{\"messages\":[" + items.joinToString(",") + "]}"

    private fun textMessage(id: String, role: String, text: String, parts: String? = null): String = buildString {
        append("{\"entryId\":\"").append(id).append('"')
        append(",\"role\":\"").append(role).append('"')
        append(",\"timestamp\":\"2026-10-26T00:00:00.000Z\"")
        append(",\"text\":\"").append(text).append('"')
        if (parts != null) append(",\"parts\":").append(parts)
        append('}')
    }

    /** 尾部标记是**最后几个字符**：截断最先丢掉的就是它们。 */
    private val tailMark = "|尾部标记-END"

    private fun longBody(head: String, length: Int) = head + "a".repeat(length) + tailMark

    @Test
    fun `long user and assistant bodies keep their tail instead of being cut at 6000`() {
        val userBody = longBody("用户说：", 7000)
        val assistantBody = longBody("助手答：", 12000)
        val page = Wire.parseMessages(
            messagesJson(
                textMessage("u1", "user", userBody),
                textMessage("a1", "assistant", assistantBody),
            ),
        )
        assertEquals("两条都要画出来", 2, page.messages.size)
        val user = page.messages[0]
        val assistant = page.messages[1]
        assertEquals("user 正文整段保留", userBody, user.text)
        assertEquals("assistant 正文整段保留", assistantBody, assistant.text)
        assertEquals("字数不许少一个", userBody.length, user.text.length)
        assertEquals("字数不许少一个", assistantBody.length, assistant.text.length)
        assertTrue("尾部标记还在", user.text.endsWith(tailMark))
        assertTrue("尾部标记还在", assistant.text.endsWith(tailMark))
        assertFalse("不再追加截断提示", user.text.contains("已截断"))
        assertFalse("不再追加截断提示", assistant.text.contains("已截断"))
    }

    @Test
    fun `the old 6000 character boundary no longer cuts anything`() {
        val exactly6000 = "b".repeat(6000)
        val oneOver = "c".repeat(6000) + "Z"
        val page = Wire.parseMessages(
            messagesJson(
                textMessage("e1", "assistant", exactly6000),
                textMessage("e2", "assistant", oneOver),
            ),
        )
        assertEquals(exactly6000.length, page.messages[0].text.length)
        assertEquals("正好 6000 字与修前一致（本来就不切）", exactly6000, page.messages[0].text)
        assertEquals("多一个字也不再切", oneOver, page.messages[1].text)
        assertEquals(6001, page.messages[1].text.length)
        assertTrue("第 6001 个字（修前正好被丢掉的那一个）还在", page.messages[1].text.endsWith("Z"))
    }

    @Test
    fun `parts fallback is also kept whole`() {
        val head = "p".repeat(6500)
        val parts = "[{\"type\":\"text\",\"text\":\"$head\"},{\"type\":\"text\",\"text\":\"$tailMark\"}]"
        val page = Wire.parseMessages(messagesJson(textMessage("a1", "assistant", "", parts)))
        val text = page.messages.single().text
        assertEquals("回落出来的正文同样整段", head + tailMark, text)
        assertEquals(head.length + tailMark.length, text.length)
        assertTrue(text.endsWith(tailMark))
        assertFalse(text.contains("已截断"))
    }

    @Test
    fun `long extras text is untouched too`() {
        val body = "x".repeat(7000) + tailMark
        val json = """
            {"messages":[{"entryId":"u1","role":"user","text":"问","timestamp":"t1"}],
             "extras":[{"entryId":"x1","parentId":"u1","timestamp":"t2","customType":"sopho.delegation",
                        "display":true,"text":"$body"}]}
        """.trimIndent()
        val extra = Wire.parseMessages(json).messages.single { it.role == "extra" }
        assertEquals(body, extra.text)
        assertTrue(extra.text.endsWith(tailMark))
    }
}
