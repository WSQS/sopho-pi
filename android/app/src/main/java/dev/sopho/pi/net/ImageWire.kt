package dev.sopho.pi.net

import org.json.JSONArray
import org.json.JSONObject

/**
 * 一张待发送/已回显的图片。`base64` 里**不含** `data:` 前缀（与 `docs/session-format.md` 的
 * `ImageContent { type:'image', data, mimeType }` 一致，服务端 `imageBlocks()` 也是按这个形状量字节的）。
 *
 * ⚠️ 这里的东西**不进日志、不进回执**：`toString()` 被覆写成只给尺寸，避免谁把整个对象打进日志时
 * 把 base64 或照片路径带出去。
 */
data class ImagePayload(
    val mimeType: String,
    val base64: String,
) {
    /** base64 解码后的字节数（只用于上限判断与展示；不重复分配解码缓冲）。 */
    val decodedBytes: Int get() = ((base64.length.toLong() * 3) / 4).toInt()

    override fun toString(): String = "ImagePayload($mimeType, ${decodedBytes}B)"
}

/**
 * 本轮采用的**安全默认**上限（不是业主要的正式数值）：
 * 单条消息 1 张、源文件 ≤ 8 MiB（读进内存前就挡）、编码后单图 ≤ 2 MiB、长边 ≤ 2048。
 *
 * 选这个数是为了：① 请求体不至于把手机内存/Host 内存打穿；② 与常见"一次贴一张截图"的用法一致。
 * 正式的数量/体积限制**没有**由用户定过，界面上要如实说"安全默认"，别写成产品规则。
 */
object ImageLimits {
    const val MAX_IMAGES_PER_MESSAGE = 1
    const val MAX_ENCODED_BYTES = 2 * 1024 * 1024
    const val MAX_SOURCE_BYTES = 8 * 1024 * 1024
    const val MAX_EDGE_PX = 2048
    const val THUMB_EDGE_PX = 512
    const val JPEG_QUALITY = 85

    /** 只接受这两种**输出** MIME（HEIC/WebP 先解再重编码；GIF 动图直接拒）。 */
    val ACCEPTED_MIMES = setOf("image/jpeg", "image/png")
}

/** 源文件按**magic bytes** 分类（不看 ContentResolver 给的 mime：那个可以随便写）。 */
enum class ImageKind { JPEG, PNG, GIF, WEBP, HEIF, UNKNOWN }

/**
 * 纯判断层：只吃字节头、宽高、大小 —— 不碰 Bitmap、不碰 Uri、不碰 ContentResolver，
 * 所以这些规则能在 JVM 单测里逐条钉住（解码/压缩那部分在 [dev.sopho.pi.image.ImageIngest]）。
 */
object ImageSniff {

    /** 只看头部十来个字节就够：JPEG / PNG / GIF / WebP / HEIF(ftyp) / 其它。 */
    fun kindOf(head: ByteArray): ImageKind {
        fun byte(index: Int): Int = head.getOrNull(index)?.toInt()?.and(0xFF) ?: -1
        fun ascii(offset: Int, length: Int): String {
            if (head.size < offset + length) return ""
            return String(head, offset, length, Charsets.US_ASCII)
        }
        if (byte(0) == 0xFF && byte(1) == 0xD8 && byte(2) == 0xFF) return ImageKind.JPEG
        if (byte(0) == 0x89 && byte(1) == 0x50 && byte(2) == 0x4E && byte(3) == 0x47) return ImageKind.PNG
        if (ascii(0, 3) == "GIF") return ImageKind.GIF
        if (ascii(0, 4) == "RIFF" && ascii(8, 4) == "WEBP") return ImageKind.WEBP
        // ISO-BMFF：偏移 4 起是 "ftyp"，brand 里 heic/heix/mif1/msf1/avif 都走系统 HEIF 解码器。
        if (ascii(4, 4) == "ftyp") return ImageKind.HEIF
        return ImageKind.UNKNOWN
    }

    /**
     * 动图判定（只用于**如实拒绝**，不做"取首帧冒充成功"）：
     * - GIF：一律按动图风险处理 —— 本版不接（拒绝原因写清，不静默换成静态图）；
     * - WebP：头部 64 字节里出现 `ANIM` chunk ⇒ 动图；静态 WebP 照常接。
     */
    fun animationReason(kind: ImageKind, head: ByteArray): String? = when (kind) {
        ImageKind.GIF ->
            "GIF 动图本轮不支持：它可能有多帧，本应用不会偷偷只发第一帧来冒充成功。" +
                "请换成 JPEG/PNG（或先把它另存成静态图）。"
        ImageKind.WEBP -> {
            val window = head.copyOfRange(0, minOf(head.size, 64))
            if (String(window, Charsets.ISO_8859_1).contains("ANIM")) {
                "动图 WebP 本轮不支持（同样不偷偷只发第一帧）；请换成静态图片。"
            } else {
                null
            }
        }
        else -> null
    }

    /** 这个源文件能不能被我们接（null = 可以；非 null = 给人看的拒绝原因）。 */
    fun rejection(kind: ImageKind, head: ByteArray): String? = when (kind) {
        ImageKind.UNKNOWN -> "这个文件不是能认出的图片（本轮只接 JPEG / PNG / HEIF / 静态 WebP）。"
        else -> animationReason(kind, head)
    }

    /**
     * 解码时的降采样倍数（`BitmapFactory.Options.inSampleSize` 只能是 2 的幂）：
     * 取"降完仍**不小于**长边上限"的最大倍数 —— 解码结果不会小于目标尺寸（不会因为降采样而丢分辨率），
     * 也不会比目标大过 2 倍。
     */
    fun subsampleFor(width: Int, height: Int, maxEdge: Int): Int {
        if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
        val longEdge = maxOf(width, height)
        var sample = 1
        while (sample < 64 && longEdge / (sample * 2) >= maxEdge) {
            sample *= 2
        }
        return sample
    }

    /** 目标尺寸：**不放大**（小图保持原尺寸），长边压到上限以内，宽高比按整数四舍五入保住。 */
    fun targetSize(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 0 to 0
        val longEdge = maxOf(width, height)
        if (longEdge <= maxEdge) return width to height
        val scale = maxEdge.toDouble() / longEdge
        val w = Math.round(width * scale).toInt().coerceAtLeast(1)
        val h = Math.round(height * scale).toInt().coerceAtLeast(1)
        return w to h
    }

    /**
     * 输出格式只由**有没有 alpha** 决定：有透明通道就 PNG（压成 JPEG 会变成黑底/白底，等于改图），
     * 否则 JPEG（体积小得多）。两种都是服务端 `imageBlocks()` 认得的 `mimeType`。
     */
    fun outputMime(hasAlpha: Boolean): String = if (hasAlpha) "image/png" else "image/jpeg"

    /** 编码后体积是否超限（给人看的话也在这里定，免得 UI 各自编一套）。 */
    fun sizeRejection(bytes: Int): String? = when {
        bytes <= 0 -> "这张图片读出来是空的。"
        bytes > ImageLimits.MAX_ENCODED_BYTES ->
            "这张图片处理后还有 ${bytes / 1024} KiB，超过本版的安全默认上限 " +
                "${ImageLimits.MAX_ENCODED_BYTES / 1024} KiB（不是产品规则，只是本轮的安全默认）。" +
                "换一张更小的图，或先裁掉一部分。"
        else -> null
    }

    fun sourceTooLarge(sizeBytes: Long): String? =
        if (sizeBytes > ImageLimits.MAX_SOURCE_BYTES) {
            "这个文件有 ${sizeBytes / (1024 * 1024)} MiB，超过本版读取上限 " +
                "${ImageLimits.MAX_SOURCE_BYTES / (1024 * 1024)} MiB（安全默认）。换一张更小的图。"
        } else {
            null
        }
}

/**
 * `POST …/message|steer` 的请求体。**形状是暂定契约，须与后端（S 那条线）对齐后才许当成已支持**：
 * `{ text: string, images: [{ mimeType, data }] }`，`data` = base64（无 `data:` 前缀）。
 *
 * 不带图片时**一个字节都不变**（仍是 `{text}`）—— 老的文本发送路径行为与旧包完全一致。
 */
object SendPayload {
    fun body(text: String, images: List<ImagePayload>): String {
        val root = JSONObject().put("text", text)
        if (images.isNotEmpty()) {
            val array = JSONArray()
            for (image in images) {
                array.put(JSONObject().put("mimeType", image.mimeType).put("data", image.base64))
            }
            root.put("images", array)
        }
        return root.toString()
    }

    /**
     * 服务端回执里**图片被接收的证据**。约定（暂定，须与 S 对齐）：回执带 `images: <条数>`；
     * 也接受 `images` 是数组（长度即条数）。
     *
     * 返回 null = 回执里**没有**任何图片凭据 ⇒ 调用方只能当"服务端没确认图片"处理，
     * 不许把本地预览当成已送达。
     */
    fun imageAck(json: JSONObject?): Int? {
        if (json == null || !json.has("images") || json.isNull("images")) return null
        val value = json.opt("images")
        return when (value) {
            is Int -> value
            is Number -> value.toInt()
            is JSONArray -> value.length()
            else -> null
        }
    }

    /** 发送前对图片本身做的最后一道体检（数量/体积/MIME）。null = 通过。 */
    fun preflight(images: List<ImagePayload>): String? {
        if (images.size > ImageLimits.MAX_IMAGES_PER_MESSAGE) {
            return "本版一条消息最多带 ${ImageLimits.MAX_IMAGES_PER_MESSAGE} 张图片（安全默认，不是用户定的规则）。"
        }
        for (image in images) {
            if (image.mimeType !in ImageLimits.ACCEPTED_MIMES) {
                return "不认得的图片格式 ${image.mimeType}：本版只发 JPEG / PNG。"
            }
            if (image.decodedBytes <= 0) return "这张图片读出来是空的。"
            if (image.decodedBytes > ImageLimits.MAX_ENCODED_BYTES) {
                return ImageSniff.sizeRejection(image.decodedBytes)
            }
        }
        return null
    }
}

/**
 * 服务端收不收 `images` —— 依据是 **S 那条线给出的契约（2026-10-25，分支 `wt/child-f77c84d5`）**，
 * 不是本客户端自己猜的：
 * - `{text?, images?:[{mimeType, data(base64)}]}`，纯图合法；`steer` **也**收图（SDK 0.85.1 的
 *   `AgentSession.steer(text, images?)` 已核）；
 * - 服务端上限 4 张 / 单图 4 MiB / 只收 jpeg|png / text ≤ 1 MiB / body ≤ 24 MiB（客户端比它更严）；
 * - 入队前就拒的具体码：`invalid_images` / `invalid_image_data` / `too_many_images` /
 *   `image_too_large` / `body_too_large` / `unsupported_image_type` / `model_does_not_support_images`。
 *
 * ⚠️ **但契约不是运行时证据**：旧服务端（没这个改动的那一版）会把 `images` 静默忽略、照样回 202。
 * 所以 "图片真的进去了" 只能由**回执**证明（[SendPayload.imageAck]）：回执里没有图片凭据时，
 * 这一发在 [SendProtocol.interpretAccepted] 里归 `images_not_acknowledged`（WARN、草稿与图片都保留），
 * 绝不把本地预览说成已经发出去。
 */

/** 带图发送的判定结果（纯逻辑，JVM 可测）。 */
sealed interface ImageSendCheck {
    data object Ok : ImageSendCheck

    /** 拒发：回执原样上屏，**草稿与图片都保留**（一个字都不删）。 */
    data class Refused(val receipt: String) : ImageSendCheck
}

/**
 * 带图发送的**发送前**判定集中在这里，理由都写进回执（用户看到的就是它）：
 * 数量/体积/格式（我们自己能确定的事实）、模型侧能力（[modelCapability]，由另一条线从服务端
 * `/models` 的 `input` 读，三态：true/false/null）。
 *
 * 路由不在这里判：忙时照旧走 `steer`（S 已核 SDK 支持图片），绝不为了发文字而悄悄丢掉图片。
 * "服务端到底收没收到图" 由回执证明，见 [SendProtocol.interpretAccepted] 的 `imagesAcked`。
 */
object SendImageGate {
    fun check(
        text: String,
        images: List<ImagePayload>,
        modelCapability: Boolean?,
    ): ImageSendCheck {
        if (images.isEmpty()) return ImageSendCheck.Ok
        SendPayload.preflight(images)?.let { return ImageSendCheck.Refused(it) }

        // 模型侧**明确**没有读图能力：发了就是让用户以为模型看过图。null（服务端没说）不拦，
        // 但回执仍要由服务端确认图片（见 interpretAccepted）。
        if (modelCapability == false) {
            return ImageSendCheck.Refused(
                "服务器把这条会话的模型声明为不可读图（/models 的 input 里没有 image）—— " +
                    "发出去只会让模型看到一段它读不了的输入。草稿与图片都保留。",
            )
        }
        return ImageSendCheck.Ok
    }
}
