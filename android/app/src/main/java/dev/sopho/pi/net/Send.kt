package dev.sopho.pi.net

/**
 * 两条**服务端已经存在**的投递路由（不自己发明消息类型）。
 *
 * 契约（`server/base-logic.mjs` 的路由表 + `web/app.js` 的 `send()`，2026-10-24 逐行复核）：
 * - `POST /sessions/{id}/message` body `{text}` → **202** `{accepted:true, sessionId}`；
 * - `POST /sessions/{id}/steer`   body `{text}` → **202** `{accepted:true, mode:'steer', sessionId}`；
 * - 两者都先过 `rejectStreamingCommand()`：会话在跑、内容又是**已注册的斜杠命令** ⇒ 409 `command_while_streaming`；
 * - 然后 `busyConflict()` 在**入队之前**抛：压缩 ⇒ 409 `session_compacting`；准入窗口（`admissionPending`）⇒ 409 `session_streaming`；
 *   message 另有 `isStreaming` ⇒ 409 `session_streaming`，steer 另有 `!isStreaming` ⇒ 409 `session_not_streaming`；
 * - 空文本 400 `invalid_text`。
 * - **只有**上面这些具体 code 才证明“没入队”（见 [SendProtocol.safeToRetry]）；408/无可识别 `error` 的 4xx/5xx/超时断连
 *   都**不**证明——4xx 不等于“确定没发出去”。
 */
enum class SendRoute(val path: String, val label: String) {
    MESSAGE("message", "普通消息"),
    STEER("steer", "插话（steer）"),
}

data class SendPlan(
    val sessionId: String,
    val route: SendRoute,
    val text: String,
    /** 这一发带的图片（最多 [ImageLimits.MAX_IMAGES_PER_MESSAGE] 张；空 = 纯文本，行为与旧包完全相同）。 */
    val images: List<ImagePayload> = emptyList(),
) {
    val hasImages: Boolean get() = images.isNotEmpty()

    // 不把 base64 打进日志/异常：只给“张数 + 文本长度”。
    override fun toString(): String =
        "SendPlan(${sessionId.take(8)}, ${route.path}, text=${text.length}字, images=${images.size})"
}

/**
 * 一次发送的结果。**注意 202 只是“接受”**（accepted），不是“模型已回答” —— 回执文案必须这么写。
 */
sealed interface SendOutcome {
    data class Accepted(val route: SendRoute, val httpStatus: Int) : SendOutcome

    /** 4xx：**只有 [SendProtocol.safeToRetry] 认的那几个具体 code** 才明确没入队；其余 4xx 与 5xx 同属“不确定”。 */
    data class Rejected(val httpStatus: Int, val errorCode: String?, val detail: String) : SendOutcome

    /** 5xx：服务端报错了，但**不知道**报错前有没有入队 ⇒ 不许自动重发。 */
    data class Uncertain(val httpStatus: Int, val errorCode: String?, val detail: String) : SendOutcome

    /** 超时/断连/读不到响应：**不知道**服务端是否接受。 */
    data object Unknown : SendOutcome
}

/**
 * 发送这条路径上的**纯逻辑**（决定走哪条、回执怎么说、草稿何时能清）。
 * 放在这里是为了能用 JVM 单测钉住：不碰 OkHttp、不碰 Compose。
 */
object SendProtocol {

    /**
     * 空白（含只有空格/换行）**不发**；斜杠形状**强制走 message**（命令可以留在 `/message`，永远不以 steer 形态出现）；
     * 其余忙 ⇒ steer，闲 ⇒ message。
     *
     * `hasImages = true` 时“空文本”不再等于“没内容”：纯图允许（服务端契约 2026-10-25）。
     * 文本这一列的老行为（空/空白不发、斜杠形状走 message、忙闲选路）一字未改；
     * 老的调用方 `plan(id, text, busy)` 仍然照旧能编、结果也一样（默认参数）。
     */
    fun plan(sessionId: String, text: String, busy: Boolean, hasImages: Boolean = false): SendPlan? {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && !hasImages) return null
        val route = when {
            looksLikeSlashCommand(trimmed) -> SendRoute.MESSAGE
            busy -> SendRoute.STEER
            else -> SendRoute.MESSAGE
        }
        // 纯图时 text 原样留空串（**不**把空白 trim 成伪文本，也不编造占位文字）。
        return SendPlan(sessionId, route, if (trimmed.isEmpty()) "" else trimmed)
    }

    /** 把发送前已经过 [SendImageGate] 的图片挂到计划上（不改 `plan()` 的调用形状）。 */
    fun withImages(plan: SendPlan, images: List<ImagePayload>): SendPlan =
        if (images.isEmpty()) plan else plan.copy(images = images)

    /**
     * 成功时**只清“还是发送时那份”的草稿**：用户在飞行途中又打了新字，就不能把他的新草稿删掉。
     * `draftNow` 是现在输入框里的内容，`sentSnapshot` 是按下发送那一刻的原文。
     */
    fun shouldClearDraft(draftNow: String, sentSnapshot: String): Boolean = draftNow == sentSnapshot

    /**
     * 这句是不是“斜杠形状”的文本（**保守**：宁可把它留在首选路由，也不替用户改投 steer）。
     *
     * 形状照服务端 `commandNameIn()`：`/` 开头，且 `/` 后面第一个 token 非空。
     * 客户端**不查** `/commands` 名单（那是命令面板那条线的只读入口）：只要像命令就不切路 ——
     * 真命令在忙时会被 `rejectStreamingCommand()` 409 `command_while_streaming`，把它当普通文本送去 steer 是假成功。
     */
    fun looksLikeSlashCommand(text: String): Boolean {
        if (!text.startsWith("/")) return false
        return text.substring(1).takeWhile { !it.isWhitespace() }.isNotEmpty()
    }

    /**
     * 一次点击内**至多一次**的跨路由切换（业主 2026-10-24 反馈：发送时会话在跑却只回 409，而不是把话投进去）。
     *
     * 只认两条**方向明确、且服务端在入队前就会抛**的具体拒绝：
     * - 先按普通消息发 ⇒ 409 `session_streaming`（SSE 说闲、其实这一轮刚开跑）：改走 steer 一次；
     * - 先按 steer 发 ⇒ 409 `session_not_streaming`（SSE 说忙、其实这一轮刚结束）：改走 message 一次。
     *
     * **不是**“遇到 409 就换条路”：
     * - 压缩（`session_compacting`）没有可投递的路 ⇒ 不切；
     * - steer 也回 `session_streaming` 是准入窗口（`admissionPending`，HTTP 面没有等价的入队路径）⇒ 第二次就停；
     * - 408/5xx/无可识别 `error`/超时断连一律不知道有没有入队 ⇒ 不切、不重发；
     * - 斜杠形状的文本不走忙闲切路（见 [looksLikeSlashCommand]）⇒ 不切。
     *
     * 调用方**只许调一次**并直接采用结果；本函数自己不形成循环。
     */
    fun fallback(plan: SendPlan, outcome: SendOutcome): SendPlan? {
        val rejected = outcome as? SendOutcome.Rejected ?: return null
        if (rejected.httpStatus != 409) return null
        if (looksLikeSlashCommand(plan.text)) return null
        val next = when {
            plan.route == SendRoute.MESSAGE && rejected.errorCode == "session_streaming" -> SendRoute.STEER
            plan.route == SendRoute.STEER && rejected.errorCode == "session_not_streaming" -> SendRoute.MESSAGE
            else -> null
        } ?: return null
        return plan.copy(route = next)
    }

    /**
     * 2xx **不等于**“已接受”：回执必须能证明“这一条、按这条路由、进了这条会话”。
     * 三个条件缺一个都归 [SendOutcome.Uncertain]（草稿保留、不自动重发）：
     * - `accepted == true`；
     * - `sessionId` 与目标会话逐字相等（忽略大小写）；
     * - steer 回执必须 `mode == "steer"`；message 回执的 `mode` 只许缺省或 `"message"`。
     *
     * 带图时再加一个条件（[imagesSent] > 0）：回执必须给出**图片凭据**（[imagesAcked] == 发送张数）。
     * 旧服务端会把 `images` 静默忽略、照回 202 —— 没凭据就不许当“已发送”，归
     * `images_not_acknowledged`（WARN、草稿与图片都保留）。
     */
    fun interpretAccepted(
        plan: SendPlan,
        httpStatus: Int,
        accepted: Boolean?,
        sessionId: String?,
        mode: String?,
        imagesSent: Int = plan.images.size,
        imagesAcked: Int? = null,
    ): SendOutcome {
        if (accepted != true) {
            return SendOutcome.Uncertain(httpStatus, "invalid_accept_receipt", "HTTP $httpStatus 但没有 accepted:true")
        }
        if (sessionId == null || !sessionId.equals(plan.sessionId, ignoreCase = true)) {
            return SendOutcome.Uncertain(
                httpStatus,
                "session_id_mismatch",
                "回执 sessionId=${sessionId ?: "（缺）"} 与目标 ${plan.sessionId} 不符",
            )
        }
        val routeOk = when (plan.route) {
            SendRoute.STEER -> mode == "steer"
            SendRoute.MESSAGE -> mode == null || mode == "message"
        }
        if (!routeOk) {
            return SendOutcome.Uncertain(
                httpStatus,
                "route_mismatch",
                "回执 mode=${mode ?: "（缺）"} 与 ${plan.route.path} 不符",
            )
        }
        if (imagesSent > 0 && (imagesAcked ?: 0) < imagesSent) {
            return SendOutcome.Uncertain(
                httpStatus,
                "images_not_acknowledged",
                "回执没有确认图片（发 $imagesSent 张，回执说 ${imagesAcked ?: "没有"}）",
            )
        }
        return SendOutcome.Accepted(plan.route, httpStatus)
    }

    /** `fallbackFrom` 非空 = 这一条是切过一次路由才被接受的；回执必须把“只切了一次”说清。 */
    fun acceptedText(
        plan: SendPlan,
        outcome: SendOutcome.Accepted,
        fallbackFrom: SendOutcome.Rejected? = null,
    ): String {
        val img = if (plan.hasImages) "（带 ${plan.images.size} 张图片，服务端回执已确认）" else ""
        val base = "已接受（HTTP ${outcome.httpStatus} · ${outcome.route.label}）$img · 目标 ${shortId(plan.sessionId)} —— " +
            "这只表示服务端收下了这一条；模型是否回答要看正文/直播块（不是“已回答”）"
        if (fallbackFrom == null) return base
        val firstRoute = if (outcome.route == SendRoute.STEER) SendRoute.MESSAGE else SendRoute.STEER
        return "$base —— 第一次按${firstRoute.label}发时被 409 ${fallbackFrom.errorCode} 拒" +
            "（服务端在入队前拒，那句没有入队），已自动改走${outcome.route.label}一次；只切了这一次。"
    }

    fun failureText(outcome: SendOutcome): String = when (outcome) {
        is SendOutcome.Accepted -> acceptedText(
            SendPlan("", outcome.route, ""),
            outcome,
        )

        is SendOutcome.Rejected -> when (outcome.errorCode) {
            "session_streaming" ->
                "发送失败（409 session_streaming）：这条会话正在跑 —— 这句**没有**发出去（服务端在入队前就拒了）。" +
                    "等这一轮结束再点一次。"

            "command_while_streaming" ->
                "发送失败（409 command_while_streaming）：会话正在跑，斜杠命令**不能插话也不能排队** —— 这句没有发出去。" +
                    "等这一轮跑完再发。"

            "session_not_streaming" ->
                "发送失败（409 session_not_streaming）：这条会话其实已经闲下来了 —— 这句**没有**发出去。" +
                    "再点一次就会按普通消息发送。"

            "session_compacting" ->
                "发送失败（409 session_compacting）：正在压缩，这句既没有发送也没有排队；等压缩完成再点一次。"

            "invalid_text" -> "发送失败（400 invalid_text）：内容是空的，没有发出去。"

            "invalid_images" ->
                "发送失败（400 invalid_images）：服务端不认这个图片列表（形状/字段不对）—— 没有入队，" +
                    "草稿与图片都保留。"

            "invalid_image_data" ->
                "发送失败（400 invalid_image_data）：服务端说图片数据解不开（base64 坏了）—— 没有入队，" +
                    "草稿与图片都保留；重新选一次图片再试。"

            "too_many_images" ->
                "发送失败（413 too_many_images）：服务端一次收 4 张，本版客户端更严只发 1 张 —— 没有入队，" +
                    "草稿与图片都保留。"

            "image_too_large" ->
                "发送失败（413 image_too_large）：服务端单图上限 4 MiB，本版客户端更严（2 MiB）—— 没有入队，" +
                    "草稿与图片都保留。"

            "body_too_large" ->
                "发送失败（413 body_too_large）：整个请求体超过服务端上限 —— 没有入队，" +
                    "草稿与图片都保留；换张更小的图。"

            "unsupported_image_type" ->
                "发送失败（415 unsupported_image_type）：服务端只收 image/jpeg 与 image/png —— 没有入队，" +
                    "草稿与图片都保留。"

            "model_does_not_support_images" ->
                "发送失败（409 model_does_not_support_images）：这一轮的模型读不了图 —— 消息没有入队，" +
                    "草稿与图片都保留。换一个能读图的模型再发。"

            else -> if (safeToRetry(outcome)) {
                "发送失败（HTTP ${outcome.httpStatus} · ${outcome.errorCode}）：这句**没有**发出去，草稿保留，可手动重试。"
            } else {
                "发送结果**不确定**（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: "（没有可识别的 error）"}）：" +
                    "这个码不证明服务端没入队。**不自动重发** —— 请先看这条会话的正文/直播块，确认没收到再手动点一次。草稿已保留。"
            }
        }

        is SendOutcome.Uncertain ->
            if (outcome.errorCode == "images_not_acknowledged") {
                // 服务端回了 202 但**没有**图片凭据（典型：旧服务端把 images 静默忽略）。
                // 不许写成“已发送”：文本可能已收下，图片有没有进去不知道 ⇒ 两边都不清。
                "发送结果**不确定**（HTTP ${outcome.httpStatus} · images_not_acknowledged）：服务端收下了这条请求，" +
                    "但回执里**没有确认图片** —— 文本可能已经进去了，图片很可能被忽略了。**不自动重发**：" +
                    "先看正文确认，再手动决定。草稿与图片都保留。"
            } else {
                "发送结果**不确定**（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: ""}）：" +
                    "服务端报错了，但报错前有可能已经收下。**不自动重发** —— 请先看这条会话的正文/直播块，" +
                    "确认没收到再手动点一次。草稿已保留。"
            }

        SendOutcome.Unknown ->
            "发送结果**未知**（请求超时或连接断了）：服务端可能已经收下，也可能没有。**不自动重发** —— " +
                "请先看这条会话的正文/直播块确认，确认没收到再手动点一次。草稿已保留。"
    }

    /** 草稿是否应该保留（失败/未知一律保留；成功由 [shouldClearDraft] 决定）。 */
    fun keepsDraft(outcome: SendOutcome): Boolean = outcome !is SendOutcome.Accepted

    /**
     * 哪些结果**可以**被静默当成“肯定没入队”（调用方可用于“手动重试”的提示）。
     *
     * 只有**已核过入队前抛**的那几个具体 code 算：`busyConflict()`（`server/base-logic.mjs:3327-3335`）、
     * `rejectStreamingCommand()`（`:5151-5163`）与 `requireText()`（`:822-827`）都在**入队之前**抛，
     * 所以这些码确实没进会话：文本那五个 ＋ 图片契约（S 线 2026-10-25）里的
     * `invalid_images` / `invalid_image_data` / `too_many_images` / `image_too_large` / `body_too_large` /
     * `unsupported_image_type` / `model_does_not_support_images`（服务端在下标/写盘之前校验）。
     * `session_streaming` / `session_not_streaming` / `session_compacting` / `command_while_streaming` / `invalid_text`。
     *
     * 其余一律**不**算安全：408、没有可识别 `error` body 的 4xx（代理/网关/网关超时、被中间人换过的响应）、
     * 404 `session_not_found`（路径可能错了，但也不证明“没写过”）、5xx、IO 超时 —— 全部归“结果未知”。
     * 本应用**从不**自动重发；这个判据只影响回执措辞与是否允许“一键重试”这类 UI 提示。
     */
    private val REJECTED_BEFORE_ENQUEUE = setOf(
        "invalid_text",
        "invalid_images",
        "invalid_image_data",
        "too_many_images",
        "image_too_large",
        "body_too_large",
        "unsupported_image_type",
        "model_does_not_support_images",
        "session_streaming",
        "session_not_streaming",
        "session_compacting",
        "command_while_streaming",
    )

    fun safeToRetry(outcome: SendOutcome): Boolean =
        outcome is SendOutcome.Rejected && outcome.errorCode in REJECTED_BEFORE_ENQUEUE

    /** 408（网关/服务端超时）即使带 4xx 外壳也不证明没入队 ⇒ 归“结果未知”。 */
    fun isTimeoutStatus(httpStatus: Int): Boolean = httpStatus == 408

    fun shortId(sessionId: String): String = sessionId.take(8)
}
