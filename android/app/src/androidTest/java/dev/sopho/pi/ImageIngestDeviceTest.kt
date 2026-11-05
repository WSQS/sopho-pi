package dev.sopho.pi

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.sopho.pi.image.ImageIngest
import dev.sopho.pi.image.IngestResult
import dev.sopho.pi.net.ImageKind
import dev.sopho.pi.net.ImageLimits
import dev.sopho.pi.net.MessageRow
import dev.sopho.pi.net.Wire
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * **真 Bitmap / 真 ContentResolver** 的图片摄入：解码、降采样、缩放、重编码、base64、拒绝路径。
 *
 * 这些不能在 JVM 单测里做（`android.graphics` 在那里是桩），所以用真设备/模拟器跑；
 * 纯算术与嗅探那部分已在 `ImageWireTest`（JVM）里钉过，两边合起来才说明整条链路。
 *
 * 会失败的理由：把长边上限去掉 ⇒ 尺寸断言红；把 alpha 图压成 JPEG ⇒ MIME 断言红；
 * 把 GIF 当静态图接 ⇒ 动图拒绝用例红；把“解不开”当成成功 ⇒ 损坏文件用例红。
 */
@RunWith(AndroidJUnit4::class)
class ImageIngestDeviceTest {

    private val app: Context = ApplicationProvider.getApplicationContext()

    @Before
    @After
    fun clean() {
        app.cacheDir.listFiles()?.forEach { it.delete() }
    }

    @Test
    fun largePngWithAlpha_isScaledToTheLimit_andStaysPng() {
        val uri = writeBitmap("big.png", 3000, 1500, Bitmap.CompressFormat.PNG, alpha = true)
        val result = ImageIngest.ingest(app, uri)
        assertTrue("应当成功：$result", result is IngestResult.Ok)
        val ok = result as IngestResult.Ok

        assertEquals("有透明通道就用 PNG（压成 JPEG 会改图）", "image/png", ok.payload.mimeType)
        assertEquals("长边压到上限", ImageLimits.MAX_EDGE_PX, maxOf(ok.width, ok.height))
        assertEquals("原尺寸如实回报（不冒充原图）", 3000, ok.originalWidth)
        assertTrue("宽高比要保住", kotlin.math.abs(ok.height - 1024) <= 2)
        assertTrue("缩略图长边 ≤ ${ImageLimits.THUMB_EDGE_PX}", maxOf(ok.thumb.width, ok.thumb.height) <= ImageLimits.THUMB_EDGE_PX)

        val decoded = Base64.decode(ok.payload.base64, Base64.NO_WRAP)
        assertEquals("base64 就是真 PNG 字节", ImageKind.PNG, dev.sopho.pi.net.ImageSniff.kindOf(decoded.copyOfRange(0, 16)))
        assertEquals("编码字节数与 base64 自洽", decoded.size, ok.encodedBytes)
        assertTrue("不许超过客户端安全上限", ok.encodedBytes <= ImageLimits.MAX_ENCODED_BYTES)
    }

    @Test
    fun smallOpaqueJpeg_isNotUpscaled_andStaysJpeg() {
        val uri = writeBitmap("small.jpg", 640, 480, Bitmap.CompressFormat.JPEG, alpha = false)
        val ok = ImageIngest.ingest(app, uri) as IngestResult.Ok
        assertEquals("image/jpeg", ok.payload.mimeType)
        assertEquals(640, ok.width)
        assertEquals(480, ok.height)
        val decoded = Base64.decode(ok.payload.base64, Base64.NO_WRAP)
        assertEquals(ImageKind.JPEG, dev.sopho.pi.net.ImageSniff.kindOf(decoded.copyOfRange(0, 16)))
    }

    @Test
    fun gifIsRefused_notSilentlyConvertedToItsFirstFrame() {
        val file = File(app.cacheDir, "anim.gif")
        file.writeBytes("GIF89a".toByteArray(Charsets.US_ASCII) + ByteArray(64))
        val result = ImageIngest.ingest(app, Uri.fromFile(file))
        assertTrue(result is IngestResult.Refused)
        assertTrue((result as IngestResult.Refused).reason.contains("GIF"))
    }

    @Test
    fun brokenFileIsRefused_withoutPretendingItWorked() {
        val file = File(app.cacheDir, "broken.png")
        file.writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02, 0x03))
        val result = ImageIngest.ingest(app, Uri.fromFile(file))
        assertTrue(result is IngestResult.Refused)
        assertTrue((result as IngestResult.Refused).reason.isNotBlank())
    }

    @Test
    fun messageImageBlockIsParsedWithRealPixels() {
        // 1×1 PNG（真字节）——用来证明渲染层拿到的是像素，不是只有元数据。
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val out = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        val base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        val json = """{"messages":[{"entryId":"e1","role":"user","text":"[图片：image/png]",
            "content":[{"type":"image","mimeType":"image/png","data":"$base64"}],
            "images":[{"mimeType":"image/png","bytes":${out.size()}}]}]}"""
        val row: MessageRow = Wire.parseMessages(json).messages.single()
        assertEquals(1, row.images.size)
        assertTrue("要能画出来（像素在）", row.images.single().canRender)
        assertEquals("image/png", row.images.single().mimeType)
        assertEquals(out.size(), row.images.single().bytes)
    }

    private fun writeBitmap(
        name: String,
        width: Int,
        height: Int,
        format: Bitmap.CompressFormat,
        alpha: Boolean,
    ): Uri {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        for (x in 0 until width step 16) {
            for (y in 0 until height step 16) {
                val color = if (alpha) {
                    // 半透明：逼出 PNG 这条路（压成 JPEG 会变成黑底）。
                    0x8033CC66.toInt()
                } else {
                    0xFF224466.toInt()
                }
                bitmap.setPixel(x, y, color)
            }
        }
        val file = File(app.cacheDir, name)
        file.outputStream().use { bitmap.compress(format, 90, it) }
        bitmap.recycle()
        return Uri.fromFile(file)
    }
}
