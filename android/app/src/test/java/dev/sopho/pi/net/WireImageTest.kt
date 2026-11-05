package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/messages` 里的**图片回显**：像素来自服务端 `content` 的 image 块（`{type:'image',mimeType,data}`），
 * `images:[{mimeType,bytes}]` 只是元数据。两种都要能读出区别 ——
 * “只给了元数据”与“给了像素”在界面上是两句话，不能混。
 */
class WireImageTest {

    private fun messages(body: String) = Wire.parseMessages(body)

    @Test
    fun imagePixelsComeFromContentBlocks() {
        val json = """
            {"messages":[
              {"entryId":"e1","role":"user","timestamp":"t1",
               "text":"看这张\n[图片：image/png，3 字节（网页暂不显示图片内容）]",
               "content":[{"type":"text","text":"看这张"},
                          {"type":"image","mimeType":"image/png","data":"QUJD"}],
               "images":[{"mimeType":"image/png","bytes":3}]}
            ]}
        """.trimIndent()
        val row = messages(json).messages.single()
        assertEquals(1, row.images.size)
        val image = row.images.single()
        assertEquals("image/png", image.mimeType)
        assertEquals(3, image.bytes)
        assertEquals("QUJD", image.base64)
        assertTrue("有像素才算能看到", image.canRender)
    }

    @Test
    fun metadataOnly_isHonestlyNotRenderable() {
        val json = """
            {"messages":[
              {"entryId":"e1","role":"user","timestamp":"t1","text":"[图片：image/jpeg，9 字节]",
               "images":[{"mimeType":"image/jpeg","bytes":9}]}
            ]}
        """.trimIndent()
        val image = messages(json).messages.single().images.single()
        assertEquals("image/jpeg", image.mimeType)
        assertEquals(9, image.bytes)
        assertNull(image.base64)
        assertTrue("没有像素就不许说成能看到", !image.canRender)
        assertTrue("toString 不泄露像素", !image.toString().contains("QUJD"))
    }

    @Test
    fun textOnlyMessagesHaveNoImages() {
        val json = """
            {"messages":[{"entryId":"e1","role":"assistant","text":"纯文字","content":[{"type":"text","text":"纯文字"}]}]}
        """.trimIndent()
        assertTrue(messages(json).messages.single().images.isEmpty())
    }

    @Test
    fun messageOrderAndExtrasAreUnaffectedByImages() {
        val json = """
            {"messages":[
              {"entryId":"a","role":"user","text":"一","content":[]},
              {"entryId":"b","role":"user","text":"图","content":[{"type":"image","mimeType":"image/png","data":"QUJD"}]}
            ],
            "extras":[{"entryId":"x","parentId":"b","text":"额外"}],
            "compaction":null}
        """.trimIndent()
        val rows = messages(json).messages
        assertEquals(listOf("一", "图", "额外"), rows.map { it.text })
        assertEquals(1, rows[1].images.size)
        assertTrue(rows[0].images.isEmpty())
    }

    @Test
    fun extraImages_doNotBleedIntoTheBodyRow() {
        // 额外消息那一格没有 content/图片字段：正文行的图片不许被算到 extra 上。
        val json = """
            {"messages":[{"entryId":"a","role":"user","text":"图","content":[{"type":"image","mimeType":"image/png","data":"QUJD"}]}],
             "extras":[{"entryId":"x","parentId":"a","text":"额外"}]}
        """.trimIndent()
        val rows = messages(json).messages
        assertEquals(2, rows.size)
        assertTrue(rows.last().images.isEmpty())
        assertEquals("extra", rows.last().role)
    }
}
