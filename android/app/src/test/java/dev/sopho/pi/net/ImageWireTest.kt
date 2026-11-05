package dev.sopho.pi.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 图片的**纯判断层**：嗅探、动图拒绝、降采样/目标尺寸、输出格式、体积上限、请求体形状、回执凭据。
 * 这里一条都不碰 Bitmap（真正的解码在 `dev.sopho.pi.image.ImageIngest`，由仪表化用例用真 Bitmap 覆盖）。
 */
class ImageWireTest {

    private fun pngHeader(): ByteArray = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    )

    private fun jpegHeader(): ByteArray = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())

    private fun gifHeader(): ByteArray = "GIF89a".toByteArray(Charsets.US_ASCII) + ByteArray(8)

    private fun webpHeader(animated: Boolean): ByteArray {
        val body = "RIFF".toByteArray(Charsets.US_ASCII) + ByteArray(4) + "WEBP".toByteArray(Charsets.US_ASCII)
        val extra = if (animated) "VP8X\u0000\u0000\u0000\u0000ANIM".toByteArray(Charsets.ISO_8859_1) else ByteArray(12)
        return body + extra
    }

    private fun heifHeader(): ByteArray =
        ByteArray(4) + "ftypheic".toByteArray(Charsets.US_ASCII) + ByteArray(8)

    // ── 嗅探 ──

    @Test
    fun kindOf_readsMagicBytes_notFileExtension() {
        assertEquals(ImageKind.JPEG, ImageSniff.kindOf(jpegHeader()))
        assertEquals(ImageKind.PNG, ImageSniff.kindOf(pngHeader()))
        assertEquals(ImageKind.GIF, ImageSniff.kindOf(gifHeader()))
        assertEquals(ImageKind.WEBP, ImageSniff.kindOf(webpHeader(animated = false)))
        assertEquals(ImageKind.HEIF, ImageSniff.kindOf(heifHeader()))
        assertEquals(ImageKind.UNKNOWN, ImageSniff.kindOf("hello world".toByteArray()))
        assertEquals(ImageKind.UNKNOWN, ImageSniff.kindOf(ByteArray(0)))
    }

    @Test
    fun gifIsRefusedHonestly_insteadOfSendingOnlyTheFirstFrame() {
        val reason = ImageSniff.rejection(ImageKind.GIF, gifHeader())
        assertTrue(reason != null && reason.contains("GIF"))
        assertTrue("不能假装成功", reason!!.contains("不会偷偷只发第一帧"))
    }

    @Test
    fun animatedWebpIsRefused_staticWebpIsAccepted() {
        assertNull(ImageSniff.rejection(ImageKind.WEBP, webpHeader(animated = false)))
        val animated = ImageSniff.rejection(ImageKind.WEBP, webpHeader(animated = true))
        assertTrue(animated != null && animated.contains("动图"))
    }

    @Test
    fun unknownFileIsRefused_withTheSupportedList() {
        val reason = ImageSniff.rejection(ImageKind.UNKNOWN, ByteArray(16))
        assertTrue(reason != null && reason.contains("JPEG"))
    }

    // ── 解码/编码的算术 ──

    @Test
    fun subsampleFor_keepsDecodedBitmapWithinTwiceTheLimit() {
        assertEquals(1, ImageSniff.subsampleFor(1000, 800, 2048))
        assertEquals(1, ImageSniff.subsampleFor(2048, 1000, 2048))
        assertEquals(2, ImageSniff.subsampleFor(4096, 1000, 2048))
        assertEquals(4, ImageSniff.subsampleFor(8192, 1000, 2048))
        // 退化输入不炸
        assertEquals(1, ImageSniff.subsampleFor(0, 0, 2048))
        assertEquals(1, ImageSniff.subsampleFor(-5, 10, 2048))
    }

    @Test
    fun targetSize_neverUpscales_andKeepsAspectRatio() {
        assertEquals(800 to 600, ImageSniff.targetSize(800, 600, 2048))
        assertEquals(2048 to 1024, ImageSniff.targetSize(4096, 2048, 2048))
        assertEquals(1024 to 2048, ImageSniff.targetSize(2048, 4096, 2048))
        val (w, h) = ImageSniff.targetSize(3000, 1000, 2048)
        assertEquals(2048, w)
        assertTrue("比例要保住（±1px）", kotlin.math.abs(h - 683) <= 1)
    }

    @Test
    fun outputMime_onlyDependsOnAlpha_becauseFlatteningWouldChangeTheImage() {
        assertEquals("image/png", ImageSniff.outputMime(hasAlpha = true))
        assertEquals("image/jpeg", ImageSniff.outputMime(hasAlpha = false))
    }

    @Test
    fun sizeRejection_saysItIsASafeDefault_notAProductRule() {
        assertNull(ImageSniff.sizeRejection(1024))
        val reason = ImageSniff.sizeRejection(ImageLimits.MAX_ENCODED_BYTES + 1)!!
        assertTrue(reason.contains("安全默认"))
        assertTrue(reason.contains("不是产品规则"))
        assertTrue(ImageSniff.sizeRejection(0) != null)
    }

    @Test
    fun sourceTooLarge_isJudgedBeforeReadingTheWholeFile() {
        assertNull(ImageSniff.sourceTooLarge(ImageLimits.MAX_SOURCE_BYTES.toLong()))
        val reason = ImageSniff.sourceTooLarge(ImageLimits.MAX_SOURCE_BYTES + 1L)!!
        assertTrue(reason.contains("安全默认"))
    }

    // ── 请求体 ──

    @Test
    fun payloadWithoutImages_isByteForByteTheOldShape() {
        // 老文本发送路径：body 仍然只有 text 一个字段，形状不因本轮而变。
        val body = SendPayload.body("你好", emptyList())
        assertEquals(setOf("text"), JSONObject(body).keys().asSequence().toSet())
        assertEquals("你好", JSONObject(body).getString("text"))
    }

    @Test
    fun payloadWithImages_carriesMimeAndRawBase64() {
        val body = SendPayload.body("看这张", listOf(ImagePayload("image/png", "QUJD")))
        val root = JSONObject(body)
        assertEquals("看这张", root.getString("text"))
        val images = root.getJSONArray("images")
        assertEquals(1, images.length())
        assertEquals("image/png", images.getJSONObject(0).getString("mimeType"))
        assertEquals("QUJD", images.getJSONObject(0).getString("data"))
        assertTrue("默认不带 data: 前缀", !images.getJSONObject(0).getString("data").startsWith("data:"))
    }

    @Test
    fun pureImagePayload_hasEmptyTextAndOneImage() {
        val body = SendPayload.body("", listOf(ImagePayload("image/jpeg", "QUJD")))
        val root = JSONObject(body)
        assertEquals("", root.getString("text"))
        assertEquals(1, root.getJSONArray("images").length())
    }

    @Test
    fun imagePayloadToString_neverContainsBase64() {
        val payload = ImagePayload("image/jpeg", "c2VjcmV0LWRhdGE=")
        assertTrue(!payload.toString().contains("c2VjcmV0"))
        assertTrue(payload.toString().contains("image/jpeg"))
    }

    // ── 回执凭据 ──

    @Test
    fun imageAck_readsCount_fromNumberOrArray() {
        assertEquals(1, SendPayload.imageAck(JSONObject("{\"images\":1}")))
        assertEquals(2, SendPayload.imageAck(JSONObject("{\"images\":[{\"mimeType\":\"image/png\"},{\"mimeType\":\"image/png\"}]}")))
        assertNull(SendPayload.imageAck(JSONObject("{}")))
        assertNull(SendPayload.imageAck(JSONObject("{\"images\":null}")))
        assertNull(SendPayload.imageAck(null))
    }

    // ── 发送前的体检 ──

    @Test
    fun preflight_blocksTooManyAndOversizedImages() {
        assertNull(SendPayload.preflight(emptyList()))
        val two = List(2) { ImagePayload("image/png", "QUJD") }
        assertTrue(SendPayload.preflight(two)!!.contains("最多"))

        val huge = "A".repeat(((ImageLimits.MAX_ENCODED_BYTES / 3) + 10) * 4)
        val oversized = listOf(ImagePayload("image/png", huge))
        assertTrue(SendPayload.preflight(oversized)!!.contains("安全默认"))

        val wrongMime = listOf(ImagePayload("image/gif", "QUJD"))
        assertTrue(SendPayload.preflight(wrongMime)!!.contains("image/gif"))
    }

    @Test
    fun preflight_acceptsOneNormalImage() {
        assertNull(SendPayload.preflight(listOf(ImagePayload("image/jpeg", "QUJD"))))
        assertNull(SendPayload.preflight(listOf(ImagePayload("image/png", "QUJD"))))
    }
}
