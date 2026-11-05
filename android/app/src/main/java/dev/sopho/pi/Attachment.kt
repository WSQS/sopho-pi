package dev.sopho.pi

import android.graphics.Bitmap
import dev.sopho.pi.net.ImagePayload

/**
 * 输入行上方那一张待发送的图片。**只存内存**（不落盘、不进 prefs、不写日志）——
 * 进程被杀/重启后草稿里的图就没了，界面上照实说“本地图片 · 未上传”。
 *
 * `id` 用来认「发送时那一张」：用户在请求在途时换了图，回执回来**不许**把新图删掉
 * （与文本草稿的 `shouldClearDraft` 同一个道理）。
 */
class Attachment(
    val id: String,
    val payload: ImagePayload,
    val thumb: Bitmap,
    val width: Int,
    val height: Int,
    val originalWidth: Int,
    val originalHeight: Int,
    val sourceBytes: Int,
    val encodedBytes: Int,
) {
    /** 缩略图旁那行小字：尺寸与大小（**不**含文件名/路径，也不含 base64）。 */
    val label: String get() = "$width×$height · ${encodedBytes / 1024} KiB"

    override fun toString(): String = "Attachment($id, ${payload.mimeType}, ${width}x$height)"
}
