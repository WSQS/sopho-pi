package dev.sopho.pi.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import dev.sopho.pi.net.ImageKind
import dev.sopho.pi.net.ImageLimits
import dev.sopho.pi.net.ImagePayload
import dev.sopho.pi.net.ImageSniff
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 一次图片摄入的结果。**只在这里做 Bitmap/ContentResolver 的活**（所以它跑在 IO 线程上，
 * 由 `AppState.onImagePicked()` 调度）；判定/缩放算术都在纯函数 [ImageSniff] 里，JVM 可测。
 *
 * 所有失败都是 [Refused] + 一句人话：**不**返回“看起来成功但其实是原图/空图”的东西。
 */
sealed interface IngestResult {
    data class Ok(
        val payload: ImagePayload,
        val thumb: Bitmap,
        val width: Int,
        val height: Int,
        val sourceKind: ImageKind,
        /** 读到的源字节数与最终编码字节数，只用于界面上的“未上传 · 400 KiB”这类说明。 */
        val sourceBytes: Int,
        val encodedBytes: Int,
        val originalWidth: Int,
        val originalHeight: Int,
    ) : IngestResult

    data class Refused(val reason: String) : IngestResult
}

/**
 * 从 Photo Picker 给的 `content://` 读出图片 → 嗅探 → 降采样解码 → 缩到长边上限 → 重编码成
 * JPEG/PNG → base64。
 *
 * 诚实边界（都写在这儿，也写进 docs）：
 * - **只读一次流**，有界读取（超过 [ImageLimits.MAX_SOURCE_BYTES] 立刻拒），不为了“试试看”把整张
 *   大图先吞进内存；
 * - 动图（GIF / 动图 WebP）**拒**，不偷只取第一帧冒充成功；
 * - 解码失败（老 Android 上的 HEIF、损坏文件）**拒**，不说“已添加”；
 * - 输出格式只由 alpha 决定：有透明通道 → PNG（不把透明压成黑底），否则 JPEG；
 * - 超过编码上限时先按 3/4 缩两次，仍超就拒（**不**悄悄发一张超过上限的图）；
 * - **不落盘、不日志、不把 uri 或 base64 写进任何回执**。
 */
object ImageIngest {

    fun ingest(context: Context, uri: Uri): IngestResult {
        val resolver = context.contentResolver
        val bytes = try {
            resolver.openInputStream(uri)?.use { readBounded(it, ImageLimits.MAX_SOURCE_BYTES.toLong()) }
        } catch (error: Exception) {
            return IngestResult.Refused("读不到这个文件（${error.javaClass.simpleName}）—— 没有添加图片。")
        } ?: return IngestResult.Refused(
            "读不到这个文件（或它超过本版读取上限 ${ImageLimits.MAX_SOURCE_BYTES / (1024 * 1024)} MiB）—— 没有添加图片。",
        )
        if (bytes.isEmpty()) return IngestResult.Refused("这个文件是空的 —— 没有添加图片。")

        val head = bytes.copyOfRange(0, minOf(bytes.size, 64))
        val kind = ImageSniff.kindOf(head)
        ImageSniff.rejection(kind, head)?.let { return IngestResult.Refused(it) }

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds) }
        val originalWidth = bounds.outWidth
        val originalHeight = bounds.outHeight
        if (originalWidth <= 0 || originalHeight <= 0) {
            return IngestResult.Refused(
                if (kind == ImageKind.HEIF) {
                    "这台 Android 解不开 HEIF/HEIC 图片（系统解码器版本太低）—— 没有添加图片。请换成 JPEG/PNG。"
                } else {
                    "这个文件解不出图片尺寸（可能已损坏，或扩展名对但内容不是图片）—— 没有添加图片。"
                },
            )
        }

        val sample = ImageSniff.subsampleFor(originalWidth, originalHeight, ImageLimits.MAX_EDGE_PX)
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = try {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        } catch (error: OutOfMemoryError) {
            return IngestResult.Refused(
                "这张图片太大，这台设备解不动（内存不够）—— 没有添加图片。换一张更小的图。",
            )
        } ?: return IngestResult.Refused("解码失败（文件可能已损坏）—— 没有添加图片。")

        val (targetWidth, targetHeight) = ImageSniff.targetSize(decoded.width, decoded.height, ImageLimits.MAX_EDGE_PX)
        var working = if (decoded.width == targetWidth && decoded.height == targetHeight) {
            decoded
        } else {
            val scaled = Bitmap.createScaledBitmap(decoded, targetWidth, targetHeight, true)
            if (scaled !== decoded) decoded.recycle()
            scaled
        }

        var attempts = 0
        while (true) {
            val mime = ImageSniff.outputMime(working.hasAlpha())
            val format = if (mime == "image/png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
            val encoded = ByteArrayOutputStream()
            val ok = runCatching { working.compress(format, ImageLimits.JPEG_QUALITY, encoded) }.getOrDefault(false)
            if (!ok) return IngestResult.Refused("重编码失败（这台设备的编码器拒绝了这个图片）—— 没有添加图片。")
            val out = encoded.toByteArray()
            val reject = ImageSniff.sizeRejection(out.size)
            if (reject == null) {
                val capacity = ImageLimits.THUMB_EDGE_PX
                val (thumbWidth, thumbHeight) = ImageSniff.targetSize(working.width, working.height, capacity)
                val thumb = if (working.width == thumbWidth && working.height == thumbHeight) {
                    working.copy(Bitmap.Config.ARGB_8888, false)
                } else {
                    Bitmap.createScaledBitmap(working, thumbWidth, thumbHeight, true)
                }
                return IngestResult.Ok(
                    payload = ImagePayload(
                        mimeType = mime,
                        base64 = Base64.encodeToString(out, Base64.NO_WRAP),
                    ),
                    thumb = thumb,
                    width = working.width,
                    height = working.height,
                    sourceKind = kind,
                    sourceBytes = bytes.size,
                    encodedBytes = out.size,
                    originalWidth = originalWidth,
                    originalHeight = originalHeight,
                )
            }
            if (attempts >= 2) {
                if (!working.isRecycled) working.recycle()
                return IngestResult.Refused(reject)
            }
            attempts += 1
            val nextWidth = (working.width * 3 / 4).coerceAtLeast(1)
            val nextHeight = (working.height * 3 / 4).coerceAtLeast(1)
            val shrunk = Bitmap.createScaledBitmap(working, nextWidth, nextHeight, true)
            if (shrunk !== working) working.recycle()
            working = shrunk
        }
    }

    /** 有界读：超过上限立刻返回 null（**不**先把整张大图读进来再判）。 */
    private fun readBounded(input: InputStream, maxBytes: Long): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) return null
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
