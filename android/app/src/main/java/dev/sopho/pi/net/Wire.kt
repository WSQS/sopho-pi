package dev.sopho.pi.net

import org.json.JSONArray
import org.json.JSONObject

/** `/api/tree` 的一行（字段名照服务端 `server/base-logic.mjs` 的树投影，取原型需要的那些）。 */
data class SessionRow(
    val id: String,
    val name: String?,
    val status: String,
    val statusLabel: String,
    val archived: Boolean,
    val cwd: String?,
    val parentId: String?,
    val modifiedAt: String?,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id.take(8)
}

/**
 * 一条消息里的图片。`base64` 来自服务端 `content` 里的 `{type:'image',data,mimeType}` ——
 * 那是**像素本身**（能真的画出来），不是元数据空壳。`images:[{mimeType,bytes}]` 只用来补大小/类型。
 *
 * `base64 == null` 表示服务端只给了元数据、没给像素：界面上要如实说“看不到图片内容”，
 * 不能拿一行“图片”文字冒充看到了图。
 */
data class MessageImage(
    val mimeType: String?,
    val bytes: Int?,
    val base64: String?,
) {
    val canRender: Boolean get() = !base64.isNullOrEmpty()

    // 不把 base64 打进日志（与 ImagePayload 同理）。
    override fun toString(): String =
        "MessageImage(${mimeType ?: "?"}, ${bytes ?: "?"}B, data=${if (canRender) "${base64!!.length}字" else "无"})"
}

/**
 * 一条正文（只保留原型要画的东西：角色 + 文本 + 时间 + 图片）。
 *
 * `text` 是服务端给的**完整正文**：客户端不按字数截断，也就没有“被截断”这个状态。
 */
data class MessageRow(
    val entryId: String,
    val role: String,
    val text: String,
    val timestamp: String?,
    val images: List<MessageImage> = emptyList(),
)

/**
 * `/api/sessions/{id}/messages` 的一页。服务端**没有分页**，所以这一页就是这条会话的全部（渲染侧再限条数）。
 *
 * `messages` 已经是**摆好位置**的渲染序列：正文 ＋ 按锚插回正文流里的 `extras`
 * （见 [MessageOrder]；服务端把两者分成两个数组给，位置靠 `parentId` / 压缩块 `atIndex` / 时间算）。
 */
data class MessagesPage(
    val messages: List<MessageRow>,
)

/** `/api/sessions/{id}` 的极小子集（原型只用来显示名字/cwd/是否在跑）。 */
data class SessionDetail(
    val id: String,
    val name: String?,
    val cwd: String?,
    val working: Boolean,
    val statusLabel: String?,
)

class ApiException(val code: Int, val path: String, val detail: String) :
    Exception("HTTP $code $path：$detail")

/** 服务端错误信封里那两句人话（`error` = 机器码，`message` = 给人看的原因）。 */
data class ApiError(val code: String?, val message: String?)

/**
 * 解析层：只做「服务端原话 → 原型的几个字段」的翻译。
 * **不做**推断（例如不把累计 usage 算成阈值、不拿 event id 当重放保证）。
 */
object Wire {
    fun parseTree(body: String): List<SessionRow> {
        val root = JSONObject(body)
        val array = root.optJSONArray("sessions") ?: JSONArray()
        val rows = ArrayList<SessionRow>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id", "")
            if (id.isEmpty()) continue
            rows += SessionRow(
                id = id,
                name = item.optStringOrNull("name"),
                status = item.optString("status", "idle"),
                statusLabel = item.optString("statusLabel", "闲置"),
                archived = item.optBoolean("archived", false),
                cwd = item.optStringOrNull("cwd"),
                parentId = item.optStringOrNull("parentId"),
                modifiedAt = item.optStringOrNull("modifiedAt"),
            )
        }
        return rows
    }

    /**
     * 正文 ＋ 额外消息**按位置合成一条渲染序列**。
     *
     * 服务端给的是两个数组（`messages` / `extras`），位置信息在每条自己的锚上：
     * `parentId` 指向的正文、压缩块的 `atIndex`、`timestamp`。这里**不排序、不猜**：
     * 顺序完全交给 [MessageOrder.place]（与 `web/render.js` 的 `extraBoundaries()` 逐档一致）。
     *
     * 渲染过滤保持不变（`role` 只要 user/assistant 且正文非空；额外消息要正文非空）：
     * 被过滤掉的正文条目**仍然占一个下标**（锚坐标系是服务端的 `messages` 数组），只是不画。
     */
    fun parseMessages(body: String): MessagesPage {
        val root = JSONObject(body)
        val array = root.optJSONArray("messages") ?: JSONArray()
        val bodies = ArrayList<MessageOrder.Body>(array.length())
        val bodyRows = ArrayList<MessageRow?>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val entryId = item.optString("entryId", "")
            val timestamp = item.optStringOrNull("timestamp")
            val role = item.optString("role", "unknown")
            var row: MessageRow? = null
            if (role == "user" || role == "assistant") {
                var text = item.optString("text", "")
                if (text.isEmpty()) text = textFromParts(item)
                if (text.isNotEmpty()) {
                    // 正文**整段保留**（`text` 为空时才回落到 `parts`，回落出来的也一样是整段）：
                    // 服务端 `/messages` 本来就把整段 text 给全了，客户端在这里切字数只会悄悄丢掉长回复的尾部。
                    row = MessageRow(
                        entryId = entryId,
                        role = role,
                        text = text,
                        timestamp = timestamp,
                        images = imagesOf(item),
                    )
                }
            }
            bodies += MessageOrder.Body(
                entryId = entryId,
                parentId = item.optStringOrNull("parentId"),
                timestamp = timestamp,
                rendered = row != null,
            )
            bodyRows += row
        }
        val extraArray = root.optJSONArray("extras") ?: JSONArray()
        val extras = ArrayList<MessageOrder.Extra>(extraArray.length())
        val extraRows = ArrayList<MessageRow?>(extraArray.length())
        for (index in 0 until extraArray.length()) {
            val item = extraArray.optJSONObject(index) ?: continue
            val entryId = item.optString("entryId", "")
            val timestamp = item.optStringOrNull("timestamp")
            val text = item.optString("text", "")
            // 正文为空的额外消息**照样进锚链**（后来的 extra 可能拿它当 parentId），只是不画。
            extras += MessageOrder.Extra(
                entryId = entryId,
                parentId = item.optStringOrNull("parentId"),
                timestamp = timestamp,
            )
            extraRows += if (text.isEmpty()) {
                null
            } else {
                MessageRow(entryId = entryId, role = "extra", text = text, timestamp = timestamp)
            }
        }
        // 压缩块画在 `messages[atIndex]` 之前 ⇒ 锚在压缩条目上的 extra 落在同一道缝里。
        val compaction = root.optJSONObject("compaction")
        val compactionEntryId = compaction?.optStringOrNull("entryId")
        val compactionAtIndex = compaction
            ?.takeIf { it.has("atIndex") && !it.isNull("atIndex") }
            ?.optInt("atIndex", -1)
            ?.takeIf { it >= 0 }
        val rows = ArrayList<MessageRow>(bodies.size + extras.size)
        for (slot in MessageOrder.place(bodies, extras, compactionEntryId, compactionAtIndex)) {
            when (slot) {
                is MessageOrder.Slot.BodySlot -> bodyRows[slot.index]?.let { rows += it }
                is MessageOrder.Slot.ExtraSlot -> extraRows[slot.index]?.let { rows += it }
            }
        }
        return MessagesPage(messages = rows)
    }

    /**
     * `POST /api/sessions` 的 **201** 回执（只取原型要用的那几个字段）。
     *
     * 缺 `id` 就当**读不懂**（抛出去由调用方按“结果不确定”收场）：服务端说成功、客户端却认不出是哪条会话时，
     * 说“没建成”和“建成了”都是猜 —— 而猜错了就会多建一条。
     */
    fun parseCreatedSession(body: String): CreatedSession {
        val root = JSONObject(body)
        val id = root.optString("id", "")
        require(id.isNotEmpty()) { "创建回执里没有 id" }
        return CreatedSession(
            id = id,
            name = root.optStringOrNull("name"),
            cwd = root.optStringOrNull("cwd"),
            scratch = root.optBoolean("scratch", false),
            // 字段缺失（老服务端）时不当成“记账失败”：只有明确 false 才是那条要提醒的状态。
            placementPersisted = root.optBoolean("placementPersisted", true),
            warningMessage = root.optJSONObject("warning")?.optStringOrNull("message"),
        )
    }

    /**
     * 服务端错误信封（`HttpError.toJSON()` = `{error, message, details?}`）里那两句人话。
     * 读不懂就给 null，不把 HTML/代理页塞进回执。
     */
    fun parseApiError(body: String): ApiError {
        val root = runCatching { JSONObject(body) }.getOrNull() ?: return ApiError(null, null)
        return ApiError(
            code = root.optStringOrNull("error"),
            message = root.optStringOrNull("message"),
        )
    }

    fun parseDetail(body: String): SessionDetail {
        val root = JSONObject(body)
        val runtime = root.optJSONObject("runtime")
        return SessionDetail(
            id = root.optString("id", ""),
            name = root.optStringOrNull("name"),
            cwd = root.optStringOrNull("cwd"),
            working = runtime?.optBoolean("streaming", false) ?: root.optBoolean("streaming", false),
            statusLabel = root.optStringOrNull("statusLabel"),
        )
    }

    private fun textFromParts(item: JSONObject): String {
        val parts = item.optJSONArray("parts") ?: return ""
        val builder = StringBuilder()
        for (index in 0 until parts.length()) {
            val part = parts.optJSONObject(index) ?: continue
            if (part.optString("type") == "text") builder.append(part.optString("text", ""))
        }
        return builder.toString()
    }

    /**
     * 从 `content` 的 image 块里取出**像素**（base64），并用 `images:[{mimeType,bytes}]` 的元数据补大小。
     * 两个数组都是服务端同一次投影的产物（`server/base-logic.mjs` 的 `imageBlocks()` / `contentTextWithImages()`），
     * 所以按下标配对；条数不一致时不报错，缺的元数据就留 null（宁缺不编）。
     */
    private fun imagesOf(item: JSONObject): List<MessageImage> {
        val metadata = item.optJSONArray("images")
        val metaMime = ArrayList<String?>(metadata?.length() ?: 0)
        val metaBytes = ArrayList<Int?>(metadata?.length() ?: 0)
        if (metadata != null) {
            for (index in 0 until metadata.length()) {
                val entry = metadata.optJSONObject(index)
                metaMime += entry?.optStringOrNull("mimeType")
                metaBytes += entry?.takeIf { it.has("bytes") && !it.isNull("bytes") }?.optInt("bytes")
            }
        }
        val content = item.optJSONArray("content")
        val images = ArrayList<MessageImage>(2)
        if (content != null) {
            var imageIndex = 0
            for (index in 0 until content.length()) {
                val block = content.optJSONObject(index) ?: continue
                if (block.optString("type") != "image") continue
                val data = block.optStringOrNull("data")
                images += MessageImage(
                    mimeType = block.optStringOrNull("mimeType") ?: metaMime.getOrNull(imageIndex),
                    bytes = metaBytes.getOrNull(imageIndex),
                    base64 = data,
                )
                imageIndex += 1
            }
        }
        // 只有元数据、没给像素（content 里没有 image 块）：**也要露出来**，
        // 但 `base64 == null` ⇒ 界面如实写“看不到内容”，不画假图。
        if (images.isEmpty() && metadata != null) {
            for (index in 0 until metadata.length()) {
                images += MessageImage(
                    mimeType = metaMime.getOrNull(index),
                    bytes = metaBytes.getOrNull(index),
                    base64 = null,
                )
            }
        }
        return images
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
