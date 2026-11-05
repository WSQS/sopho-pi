package dev.sopho.pi.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * HTTP 面。**写方法只有四条**：
 * - [send]（发文本，`/message` 或 `/steer`；图片那条 payload 由并行的 U 线扩展）；
 * - [createSession]（建空会话，`POST /api/sessions`）；
 * - [writeSettings]（切模型 / 写思考档位，**同一条** `POST /api/sessions/{id}/model`）；
 * - [compact]（`POST /api/sessions/{id}/compact`，显式确认之后才调）。
 * 其余都是只读 GET（树 / 正文 / 详情 / 命令清单 / 模型目录）。停止与归档、改名、回答 question **仍然没有**入口。
 * 四条写**都走同一套** `postClient`（关掉隐式重放、不跟重定向）：没有幂等键的写不许被库悄悄重发。
 *
 * 端点一律走 B（`server/app.mjs`）的 `/api/…`：A 上没有 `/api` 前缀，B 会去掉前缀反代给 A。
 * （注释里不能写「斜杠星号」—— Kotlin 的块注释可嵌套，那会把这一整段注释吞掉。）
 *
 * `postClient` 是发送专用的那一套：关掉 `retryOnConnectionFailure`、不跟重定向、不装 authenticator ——
 * 目的是本路径**不会隐式重发 POST**（服务端没有幂等键，重发就可能变成两条）。
 */
class SophoApi(
    private val client: OkHttpClient,
    private val postClient: OkHttpClient,
    rawBaseUrl: String,
) {
    private val baseUrl = rawBaseUrl.trim().trimEnd('/')

    suspend fun tree(): List<SessionRow> = Wire.parseTree(get("/api/tree"))

    /** 服务端 `/messages` 没有分页参数，所以这里拿到的是这条会话全量；渲染侧再限条数。 */
    suspend fun messages(sessionId: String): MessagesPage =
        Wire.parseMessages(get("/api/sessions/$sessionId/messages"))

    /**
     * 唯一一条写路径：`POST /api/sessions/{id}/message|steer`，body 由 [SendPayload] 构：
     * 纯文本仍是 `{text}`；带图时 `{text, images:[{mimeType,data}]}`（形状按后端契约 2026-10-25）。
     *
     * 返回码映射（契约见 [SendRoute]）：
     * - 2xx ⇒ 先过 [SendProtocol.interpretAccepted]：回执必须带 `accepted:true`、`sessionId` 与目标相符、
     *   route 语义相符、**带图时还要有图片凭据**，否则归 [SendOutcome.Uncertain]（2xx **不等于**已接受，
     *   草稿不能因此清掉）；
     * - 4xx ⇒ [SendOutcome.Rejected]（只有 [SendProtocol.safeToRetry] 认的具体码才算“确定没发出去”）；
     * - 5xx ⇒ [SendOutcome.Uncertain]（报错前可能已入队）；
     * - IO 异常（超时/断连）⇒ [SendOutcome.Unknown]（不知道接没接受）。
     *
     * 本函数**只发一次**；跨路由兜底（至多一次）在 `AppState.send()` 的同一发点击内做。
     */
    suspend fun send(plan: SendPlan): SendOutcome = withContext(Dispatchers.IO) {
        val payload = SendPayload.body(plan.text, plan.images)
        val request = Request.Builder()
            .url("$baseUrl/api/sessions/${plan.sessionId}/${plan.route.path}")
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .header("accept", "application/json")
            .build()
        try {
            postClient.newCall(request).execute().use { response ->
                val body = response.body?.string() ?: ""
                val json = runCatching { JSONObject(body) }.getOrNull()
                val errorCode = json?.optString("error")?.takeIf { it.isNotEmpty() }
                when {
                    response.isSuccessful -> SendProtocol.interpretAccepted(
                        plan = plan,
                        httpStatus = response.code,
                        accepted = json?.let { if (it.has("accepted")) it.optBoolean("accepted") else null },
                        sessionId = json?.optString("sessionId")?.takeIf { it.isNotEmpty() },
                        mode = json?.optString("mode")?.takeIf { it.isNotEmpty() },
                        imagesAcked = SendPayload.imageAck(json),
                    )
                    // 408 即使长着 4xx 的脸也不证明没入队（网关超时是典型）⇒ 结果未知。
                    response.code == 408 -> SendOutcome.Uncertain(response.code, errorCode, body.take(300))
                    response.code >= 500 -> SendOutcome.Uncertain(response.code, errorCode, body.take(300))
                    else -> SendOutcome.Rejected(response.code, errorCode, body.take(300))
                }
            }
        } catch (error: IOException) {
            SendOutcome.Unknown
        }
    }

    /**
     * 建一个**空**会话：`POST /api/sessions`（body 只有 `name` / `cwd` / `scratch` 里填了的那些，
     * 见 [CreateProtocol]）。走的是**同一套** `postClient`（不自动重试、不跟重定向）。
     *
     * **“已建”的凭据是回执里的会话实体（id），不是 2xx**：
     * - 回执能解出 `id` ⇒ [CreateOutcome.Created]（哪怕状态码不是 2xx：会话已经存在了，就不许让用户再建一次）；
     * - 2xx 但解不出 `id` ⇒ [CreateOutcome.Uncertain]（服务端说成功、客户端认不出是哪条，说“没建”和“建了”都是猜）；
     * - 其余按 [CreateProtocol.classify]：只有核过在建之前就抛的 4xx 码算 `Rejected`，408/5xx/认不出的码 → `Uncertain`；
     * - IO ⇒ [CreateOutcome.Unknown]。
     */
    suspend fun createSession(plan: CreatePlan): CreateOutcome = withContext(Dispatchers.IO) {
        val payload = JSONObject().apply {
            CreateProtocol.bodyFields(plan).forEach { (key, value) -> put(key, value) }
        }.toString()
        val request = Request.Builder()
            .url("$baseUrl/api/sessions")
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .header("accept", "application/json")
            .build()
        try {
            postClient.newCall(request).execute().use { response ->
                val body = response.body?.string() ?: ""
                val error = Wire.parseApiError(body)
                // 回执里有会话实体（id）就以它为准（状态码对不对都先按“已建”说）。
                val parsed = runCatching { Wire.parseCreatedSession(body) }.getOrNull()
                when {
                    parsed != null -> CreateOutcome.Created(response.code, parsed)

                    CreateProtocol.classify(response.code, error.code) == CreateProtocol.Status.REJECTED ->
                        CreateOutcome.Rejected(response.code, error.code, error.message, body.take(300))

                    CreateProtocol.classify(response.code, error.code) == CreateProtocol.Status.SUCCESS ->
                        CreateOutcome.Uncertain(
                            response.code,
                            error.code,
                            "HTTP ${response.code} 但回执读不懂：" + body.take(300).replace('\n', ' '),
                        )

                    else -> CreateOutcome.Uncertain(response.code, error.code, body.take(300))
                }
            }
        } catch (error: IOException) {
            CreateOutcome.Unknown
        }
    }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(baseUrl + path)
            .header("accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw ApiException(response.code, path, body.take(300).replace('\n', ' '))
            }
            body
        }
    }

    /**
     * 只读 GET，但**把状态码与正文原样拿回来**（命令清单 / 模型目录要区分“服务端拒了”与“形状不对”）。
     * 不做重试、不跟重定向（`client` 就是连接时那一套）。
     */
    private suspend fun getRaw(path: String): Pair<Int, String> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(baseUrl + path)
            .header("accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            response.code to (response.body?.string() ?: "")
        }
    }

    /**
     * 只写一次 POST（**专用** `postClient`：不隐式重发、不跟重定向）。返回 null = IO 失败（超时/断连），
     * 调用方据此归“结果未知”，**绝不重发**。
     */
    private suspend fun postRaw(path: String, json: String): Pair<Int, String>? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(baseUrl + path)
            .post(json.toRequestBody(JSON_MEDIA_TYPE))
            .header("accept", "application/json")
            .build()
        try {
            postClient.newCall(request).execute().use { response ->
                response.code to (response.body?.string() ?: "")
            }
        } catch (_: IOException) {
            null
        }
    }

    // ─────────────────── 命令清单（只读；打开命令页/手动重试才调） ───────────────────

    /**
     * `GET /api/sessions/{id}/commands`。服务端会 `withSession`（冷会话要建 runtime）⇒ 本方法**不预取**，
     * 也不带缓存：每次调用就是一发新请求。
     */
    suspend fun commands(sessionId: String): CommandsOutcome = try {
        val (status, body) = getRaw("/api/sessions/$sessionId/commands")
        if (status !in 200..299) {
            val error = Wire.parseApiError(body)
            CommandsOutcome.Failed(ApiFailure(status, error.code, error.message ?: body.take(200).replace('\n', ' ')))
        } else {
            CommandsOutcome.Loaded(CommandsWire.parse(body, sessionId))
        }
    } catch (error: IOException) {
        CommandsOutcome.Failed(ApiFailure(null, null, "请求失败：" + (error.message ?: error.javaClass.simpleName)))
    } catch (error: CommandsParseException) {
        CommandsOutcome.Failed(ApiFailure(200, "unreadable_commands", error.message ?: "命令清单读不懂"))
    }

    // ─────────────────── 模型目录与思考档位（只读 ＋ 一次写） ───────────────────

    /** `GET /api/sessions/{id}/models`（含 `thinking` 与每个模型的 `input`/`supportsImages`）。 */
    suspend fun models(sessionId: String): ModelsOutcome = try {
        val (status, body) = getRaw("/api/sessions/$sessionId/models")
        if (status !in 200..299) {
            val error = Wire.parseApiError(body)
            ModelsOutcome.Failed(ApiFailure(status, error.code, error.message ?: body.take(200).replace('\n', ' ')))
        } else {
            ModelsOutcome.Loaded(SettingsWire.parseModels(body, sessionId))
        }
    } catch (error: IOException) {
        ModelsOutcome.Failed(ApiFailure(null, null, "请求失败：" + (error.message ?: error.javaClass.simpleName)))
    } catch (error: SettingsParseException) {
        ModelsOutcome.Failed(ApiFailure(200, "unreadable_models", error.message ?: "模型目录读不懂"))
    }

    /**
     * 写模型 / 思考档位：**同一条** `POST /api/sessions/{id}/model`（body 只放本次要写的字段）。
     * 只发一次；2xx 也要过 [SettingsWire.interpretWrite] 的自证。
     */
    suspend fun writeSettings(sessionId: String, request: SettingsRequest): SettingsWriteOutcome {
        val raw = postRaw("/api/sessions/$sessionId/model", SettingsWire.requestBody(request))
            ?: return SettingsWriteOutcome.Unknown
        return SettingsWire.interpretWrite(raw.first, raw.second, request, sessionId)
    }

    /** `GET /api/sessions/{id}` 的 `runtime.model` / `runtime.thinkingLevel`（真值回读）。 */
    suspend fun runtimeSettings(sessionId: String): RuntimeReadback =
        SettingsWire.parseReadback(get("/api/sessions/$sessionId"))

    /**
     * `POST /api/sessions/{id}/compact`：**202 accepted 只是“请求已收下”** —— 压缩有没有做完要看正文/SSE。
     * 只发一次，不重试。
     */
    suspend fun compact(sessionId: String, instructions: String?): CompactOutcome {
        val payload = JSONObject().apply {
            if (instructions != null && instructions.isNotBlank()) put("instructions", instructions.trim())
        }.toString()
        val raw = postRaw("/api/sessions/$sessionId/compact", payload) ?: return CompactOutcome.Unknown
        val (status, body) = raw
        val json = runCatching { JSONObject(body) }.getOrNull()
        val code = json?.optString("error")?.takeIf { it.isNotEmpty() }
        val message = json?.optString("message")?.takeIf { it.isNotEmpty() }
        return when {
            status == 408 -> CompactOutcome.Uncertain(status, code, body.take(300))
            status >= 500 -> CompactOutcome.Uncertain(status, code, body.take(300))
            // “已接受”必须有凭据：`accepted:true` 且 `sessionId` 与目标相符（与发送同一条纪律）。
            status in 200..299 -> {
                val accepted = json?.let { if (it.has("accepted")) it.optBoolean("accepted") else null }
                val echo = json?.optString("sessionId")?.takeIf { it.isNotEmpty() }
                when {
                    accepted != true -> CompactOutcome.Uncertain(status, "invalid_accept_receipt", "HTTP $status 但没有 accepted:true")
                    echo != null && !echo.equals(sessionId, ignoreCase = true) ->
                        CompactOutcome.Uncertain(status, "session_id_mismatch", "回执 sessionId=$echo 与目标 $sessionId 不符")

                    else -> CompactOutcome.Accepted(status)
                }
            }

            else -> CompactOutcome.Rejected(status, code, message, body.take(300))
        }
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun hostOf(url: String): String? = url.trim().toHttpUrlOrNull()?.host
        fun portOf(url: String): Int? = url.trim().toHttpUrlOrNull()?.port
    }
}
