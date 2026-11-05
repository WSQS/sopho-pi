package dev.sopho.pi.net

import org.json.JSONArray
import org.json.JSONObject

/**
 * 「模型与思考档位」这一条线的**投影 ＋ 纯逻辑**。
 *
 * 服务端契约定稿（`wt/child-f77c84d5`，2026-10-25 S 线，逐条对过）：
 * - 读：`GET /api/sessions/{id}/models` = `{sessionId, hot, error, current, source, models[]}`
 *   ＋ 追加 `thinking:{current, levels}`；每个 `models[]` 项追加 `input`（`["text"]` / `["text","image"]`、
 *   读不到 ⇒ null）与派生 `supportsImages`（true/false/null 三态）以及该模型自己的 `thinkingLevels`；
 * - 写：**复用** `POST /api/sessions/{id}/model`（稳定宿主的 `SESSION_PATH` 白名单里没有 `/thinking`，
 *   新开一条 action 会掉到兜底 proxy、不再是 owner 路由）。body 支持 `{model?}`、`{thinkingLevel?}` 或两者；
 *   至少一个。思考-only 的回执是 `{ok, sessionId, model, thinkingLevel, previousThinkingLevel,
 *   thinkingLevels, thinkingChanged, persist:false}`，换模型时在原有字段上追加同一组；
 *   `thinkingChanged` = `previousThinkingLevel → thinkingLevel`（写前→写后**真值**）确实变了，**与请求值无关**
 *   ⇒ **不能**拿它当“服务端夹取/换了别的档”的证据（正常 off→high 也会是 true）。客户端只据两件事开口：
 *   ① `requested` vs 回读 `actual` 不等 ⇒ “和你选的不同”；② 本次**没要求改档位**且 `previous != actual`
 *   ⇒ 才说“换模型连同把档位从 X 改成了 Y（你这次没选档位）”。换模型那一种**没有 requested 可比**，
 *   所以绝不用“不是你选的”这种偏差说法。
 *
 * 三条不许越的线：
 * 1. **档位清单不硬编码**：服务端没给 `levels` 就是未知（空），界面照实说未知，不摆一排假档位；
 * 2. **三态能力**：`supportsImages == null` ≠ 支持，也 ≠ 不支持；不许拿“名字里有 vision”来猜；
 * 3. **回执里的 `thinkingLevel` 是写后回读值**，但客户端仍会自己再 `GET /sessions/{id}` 对账一遍
 *    （[SettingsWire.parseReadback]）—— 两步不一致就如实说“回读不一致”，不把请求值当已生效。
 */
data class ModelEntry(
    val provider: String?,
    val id: String?,
    val name: String?,
    val ref: String,
    val reasoning: Boolean?,
    val contextWindow: Int?,
    val current: Boolean,
    /** 原样 `input` 数组；服务端没给/读不到 ⇒ null（未知）。 */
    val input: List<String>?,
    /** 派生：`input` 含 `"image"` ⇒ true；`input` 给了但不含 ⇒ false；`input` 缺失 ⇒ null。 */
    val supportsImages: Boolean?,
    /** 该模型自己的可支持思考档位；null ⇒ 未知（不编）。 */
    val thinkingLevels: List<String>?,
)

data class ThinkingCatalog(
    val current: String?,
    val levels: List<String>?,
)

data class ModelCatalog(
    val sessionId: String,
    val current: String?,
    val source: String?,
    val hot: Boolean?,
    /** 服务端在回执里自报的 `error`（`null` = 没报错）。 */
    val serverError: String?,
    val models: List<ModelEntry>,
    val thinking: ThinkingCatalog?,
) {
    val currentEntry: ModelEntry?
        get() = models.firstOrNull { it.current } ?: models.firstOrNull { it.ref == current }

    /** 当前模型的可支持档位（`thinking.levels` 优先，回落到当前模型自己的清单；都没有 ⇒ null）。 */
    val levels: List<String>?
        get() = thinking?.levels ?: currentEntry?.thinkingLevels

    /** 当前模型的图片输入能力（三态；没有目录/没有当前模型 ⇒ null）。 */
    val supportsImages: Boolean?
        get() = currentEntry?.supportsImages
}

/** `GET /sessions/{id}` 的 `runtime` 里那两个**真值**字段（回读用）。 */
data class RuntimeReadback(val model: String?, val thinkingLevel: String?)

/** 一次写入请求（两个字段都可空，但**不能都空**）。 */
data class SettingsRequest(val model: String?, val thinkingLevel: String?) {
    init {
        require(model != null || thinkingLevel != null) { "SettingsRequest 至少要有一个字段" }
    }
}

sealed interface SettingsWriteOutcome {
    /**
     * 2xx 且回执**自证**了这次写：`ok:true`、`sessionId` 与目标一致，并且本次请求涉及的那个字段
     * 在回执里给了值（`model` / `thinkingLevel`）。
     */
    data class Applied(
        val httpStatus: Int,
        val model: String?,
        val previousModel: String?,
        val thinkingLevel: String?,
        val previousThinkingLevel: String?,
        val thinkingLevels: List<String>?,
        val thinkingChanged: Boolean?,
        /** 服务端自报的偏差：只在“请求了 thinkingLevel 且回读 != 请求值”时出现（正常成功没有这个字段）。 */
        val partial: Boolean?,
        val matchedBy: String?,
        val persist: Boolean?,
    ) : SettingsWriteOutcome

    /** 4xx：服务端当面拒了（忙、档位不认识、模型不支持、模型名歧义/不存在…）。**不自动重试**。 */
    data class Rejected(
        val httpStatus: Int,
        val errorCode: String?,
        val message: String?,
        val detail: String,
        val levels: List<String>?,
        val candidates: List<String>?,
    ) : SettingsWriteOutcome

    /** 5xx / 408 / 认不出的 2xx：**不确定**服务端写没写。 */
    data class Uncertain(val httpStatus: Int, val errorCode: String?, val detail: String) : SettingsWriteOutcome

    /** 超时 / 断连 / 读不到响应：**不知道**。 */
    data object Unknown : SettingsWriteOutcome
}

class SettingsParseException(message: String) : Exception(message)

object SettingsWire {

    /**
     * `/models` 回执 → [ModelCatalog]。
     *
     * - `sessionId` 与目标不符 ⇒ 抛（别的会话的模型目录比“没有目录”更危险）；
     * - 缺 `models` 数组 ⇒ 抛（形状不对，不是“没有模型”）；
     * - 已知的坏条目**跳过**并计入 `skipped`（名字/ref 都没有的条目没意义），不整页作废。
     */
    fun parseModels(body: String, expectedSessionId: String): ModelCatalog {
        val root = runCatching { JSONObject(body) }.getOrNull()
            ?: throw SettingsParseException("模型目录回执不是 JSON：" + body.take(200).replace('\n', ' '))
        val echo = root.optStringOrNull("sessionId")
        if (echo != null && !echo.equals(expectedSessionId, ignoreCase = true)) {
            throw SettingsParseException("模型目录回执的 sessionId=$echo 与目标 $expectedSessionId 不符")
        }
        val array = root.optJSONArray("models")
            ?: throw SettingsParseException("模型目录回执里没有 models 数组")
        val entries = ArrayList<ModelEntry>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optStringOrNull("id")
            val provider = item.optStringOrNull("provider")
            val ref = item.optStringOrNull("ref") ?: if (provider != null && id != null) "$provider/$id" else id
            if (ref == null) continue
            val input = item.optStringList("input")
            entries += ModelEntry(
                provider = provider,
                id = id,
                name = item.optStringOrNull("name"),
                ref = ref,
                reasoning = item.optBooleanOrNull("reasoning"),
                contextWindow = item.optIntOrNull("contextWindow"),
                current = item.optBoolean("current", false),
                input = input,
                // 服务端给了 supportsImages 就用它；否则由 input **派生**（input 缺失 ⇒ null，不猜）。
                supportsImages = item.optBooleanOrNull("supportsImages")
                    ?: input?.let { values -> values.any { it.equals("image", ignoreCase = true) } },
                thinkingLevels = item.optStringList("thinkingLevels"),
            )
        }
        val thinkingObject = root.optJSONObject("thinking")
        val thinking = if (thinkingObject == null) {
            null
        } else {
            ThinkingCatalog(
                current = thinkingObject.optStringOrNull("current"),
                levels = thinkingObject.optStringList("levels"),
            )
        }
        return ModelCatalog(
            sessionId = expectedSessionId,
            current = root.optStringOrNull("current"),
            source = root.optStringOrNull("source"),
            hot = root.optBooleanOrNull("hot"),
            serverError = root.optStringOrNull("error"),
            models = entries,
            thinking = thinking,
        )
    }

    /** `GET /sessions/{id}` 的 `runtime.model` / `runtime.thinkingLevel`（缺就 null，不猜）。 */
    fun parseReadback(body: String): RuntimeReadback {
        val root = runCatching { JSONObject(body) }.getOrNull()
            ?: throw SettingsParseException("会话详情回执不是 JSON：" + body.take(200).replace('\n', ' '))
        val runtime = root.optJSONObject("runtime")
        val model = runtime?.optJSONObject("model")
        val modelRef = if (model == null) {
            runtime?.optStringOrNull("model")
        } else {
            val provider = model.optStringOrNull("provider")
            val id = model.optStringOrNull("id")
            when {
                provider != null && id != null -> "$provider/$id"
                id != null -> id
                else -> null
            }
        }
        return RuntimeReadback(
            model = modelRef,
            // pi 的档位是字符串枚举；服务端读不到就给 null —— 客户端不补一个默认档位。
            thinkingLevel = runtime?.optStringOrNull("thinkingLevel"),
        )
    }

    /** 写请求的 body（只放本次真的要写的那几个字段）。 */
    fun requestBody(request: SettingsRequest): String = JSONObject().apply {
        request.model?.let { put("model", it) }
        request.thinkingLevel?.let { put("thinkingLevel", it) }
    }.toString()

    /**
     * 写回执 → [SettingsWriteOutcome]。**2xx 不等于写成了**：必须能证明“这一条、这条会话、这个字段”。
     *
     * - `ok` 明确不等于 true ⇒ [SettingsWriteOutcome.Uncertain]（服务端说成功却解不出实体时，说“成功了”和
     *   “没成功”都是猜）；
     * - 回执 `sessionId` 与目标不符 ⇒ [SettingsWriteOutcome.Uncertain]；
     * - 本次要写的字段在回执里没值 ⇒ [SettingsWriteOutcome.Uncertain]（没有回读值就不许标“已生效”）；
     * - 4xx ⇒ [SettingsWriteOutcome.Rejected]（含 `details.levels` / `details.candidates`，能拿就给）；
     * - 408（网关超时）与 5xx ⇒ [SettingsWriteOutcome.Uncertain]。
     */
    fun interpretWrite(
        httpStatus: Int,
        body: String,
        request: SettingsRequest,
        expectedSessionId: String,
        ioFailure: Boolean = false,
    ): SettingsWriteOutcome {
        if (ioFailure) return SettingsWriteOutcome.Unknown
        val root = runCatching { JSONObject(body) }.getOrNull()
        val code = root?.optStringOrNull("error")
        val message = root?.optStringOrNull("message")
        val detail = body.take(300).replace('\n', ' ')
        if (httpStatus == 408 || httpStatus >= 500) {
            return SettingsWriteOutcome.Uncertain(httpStatus, code, detail)
        }
        if (httpStatus !in 200..299) {
            val details = root?.optJSONObject("details")
            return SettingsWriteOutcome.Rejected(
                httpStatus = httpStatus,
                errorCode = code,
                message = message,
                detail = detail,
                levels = details?.optStringList("levels"),
                candidates = details?.optStringList("candidates"),
            )
        }
        if (root == null) {
            return SettingsWriteOutcome.Uncertain(httpStatus, "unreadable_receipt", "HTTP $httpStatus 但回执不是 JSON：$detail")
        }
        if (root.has("ok") && !root.optBoolean("ok", false)) {
            return SettingsWriteOutcome.Uncertain(httpStatus, "ok_false", "HTTP $httpStatus 但回执 ok=false：$detail")
        }
        val echo = root.optStringOrNull("sessionId")
        if (echo != null && !echo.equals(expectedSessionId, ignoreCase = true)) {
            return SettingsWriteOutcome.Uncertain(httpStatus, "session_id_mismatch", "回执 sessionId=$echo 与目标 $expectedSessionId 不符")
        }
        if (request.model != null && root.optStringOrNull("model") == null) {
            return SettingsWriteOutcome.Uncertain(httpStatus, "no_model_in_receipt", "HTTP $httpStatus 但回执里没有写后模型值")
        }
        if (request.thinkingLevel != null && root.optStringOrNull("thinkingLevel") == null) {
            return SettingsWriteOutcome.Uncertain(httpStatus, "no_thinking_level_in_receipt", "HTTP $httpStatus 但回执里没有写后思考档位")
        }
        return SettingsWriteOutcome.Applied(
            httpStatus = httpStatus,
            model = root.optStringOrNull("model"),
            previousModel = root.optStringOrNull("previous"),
            thinkingLevel = root.optStringOrNull("thinkingLevel"),
            previousThinkingLevel = root.optStringOrNull("previousThinkingLevel"),
            thinkingLevels = root.optStringList("thinkingLevels"),
            thinkingChanged = root.optBooleanOrNull("thinkingChanged"),
            partial = root.optBooleanOrNull("partial"),
            matchedBy = root.optStringOrNull("matchedBy"),
            persist = root.optBooleanOrNull("persist"),
        )
    }
}

/**
 * 写入这一层的人话与自查（纯函数；不含解析也不含网络）。
 * 单独拆出来是因为 AppState 只该依赖这些判据，不该为了回执文案去拉整个回执解析器。
 */
object SettingsProtocol {

    /** 写回执的人话（**逐字带 HTTP 码与回读值**；不写“已生效”以外的承诺）。 */
    fun receiptText(outcome: SettingsWriteOutcome, request: SettingsRequest): String = when (outcome) {
        is SettingsWriteOutcome.Applied -> {
            val parts = ArrayList<String>()
            request.model?.let { wanted ->
                val actual = outcome.model ?: "（回执未给）"
                val previous = outcome.previousModel ?: "（未给）"
                val how = outcome.matchedBy?.let { "（匹配方式：$it）" } ?: ""
                parts += "模型已写入：$previous → $actual$how；请求值是 $wanted"
            }
            request.thinkingLevel?.let { wanted ->
                val actual = outcome.thinkingLevel ?: "（回执未给）"
                val previous = outcome.previousThinkingLevel ?: "（未给）"
                parts += "思考档位已写入：$previous → $actual（请求值 $wanted）"
                // 偏差的唯一判据是“**请求值 vs 回读值**”；`thinkingChanged` 不是证据（正常 off→high 也是 true）。
                // 服务端另给 `partial:true` 就是同一事实的自报值 ⇒ 两者取或（它是权威、我们的是独立核对）。
                if (actual != wanted || outcome.partial == true) {
                    parts += "⚠️ 服务端落地的档位是 $actual，和你在本页选的 $wanted 不同（以服务端回读为准；可能被夹取或该模型不支持）"
                }
            }
            // 连带动：本次没要求改档位（只换模型），而写前后档位真值不同 ⇒ 那才是服务端带来的副作用。
            // 注意：这一支**没有 requested 可比**，所以只说“换模型后档位变成 Y”，不说成“不是你选的”（那是偏差话术）。
            if (request.thinkingLevel == null && request.model != null) {
                val before = outcome.previousThinkingLevel
                val after = outcome.thinkingLevel
                if (before != null && after != null && before != after) {
                    parts += "⚠️ 这次只要求换模型：服务端连同把思考档位从 $before 改成了 $after（你这次没有选档位；本应用不会代你重选）"
                }
            }
            val persist = if (outcome.persist == false) "；persist=false（只写这条会话，没改全局配置）" else ""
            parts.joinToString("；") + "（HTTP ${outcome.httpStatus}$persist）"
        }

        is SettingsWriteOutcome.Rejected -> when (outcome.errorCode) {
            "session_streaming", "session_compacting" ->
                "没有写入（HTTP ${outcome.httpStatus} · ${outcome.errorCode}）：会话正忙，服务端在写入前就拒了。" +
                    "本地选择保留，等你再点一次保存（本应用不会自动重试）。"

            "invalid_thinking_level" -> "没有写入：服务端不认识这个思考档位（HTTP ${outcome.httpStatus} · invalid_thinking_level）" +
                (outcome.levels?.let { "；服务端给的合法档位：${it.joinToString(", ")}" } ?: "；服务端没给合法档位清单") +
                "。"

            "thinking_level_unsupported" -> "没有写入：这个档位**当前模型不支持**（HTTP ${outcome.httpStatus} · thinking_level_unsupported）" +
                (outcome.levels?.let { "；该模型可支持：${it.joinToString(", ")}" } ?: "") + "。服务端没有静默改成别的档位。"

            "ambiguous_model" -> "没有写入：这个模型名在多个 provider 下都存在（HTTP ${outcome.httpStatus} · ambiguous_model）" +
                (outcome.candidates?.let { "；候选：${it.joinToString(", ")}" } ?: "") + "。"

            "model_not_found" -> "没有写入：这条会话的模型清单里没有它（HTTP ${outcome.httpStatus} · model_not_found）。"

            "model_switch_unavailable" -> "没有写入：这个 runtime 不提供切模型（HTTP ${outcome.httpStatus} · model_switch_unavailable）。"

            else -> "没有写入（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: ""}）：" +
                (outcome.message ?: "服务端没给原因") + "。本地选择保留，可手动再点一次保存。"
        }

        is SettingsWriteOutcome.Uncertain ->
            "**不确定写没写**（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: ""}）：" +
                "服务端报错了或回执不自证，报错前可能已经写进去。**不自动重试** —— 先点「重拉」看服务端的真值，" +
                "再决定要不要手动再点保存。"

        SettingsWriteOutcome.Unknown ->
            "**结果未知**（请求超时或连接断了）：服务端可能已经写入，也可能没有。**不自动重试** —— " +
                "先点「重拉」看服务端真值，再决定要不要手动再点保存。"
    }

    /** 图片输入能力那句话（给功能盘的图片按钮用；三态，未知不许说成支持）。 */
    fun capabilityNote(supportsImages: Boolean?, catalogError: String?): String = when (supportsImages) {
        true -> "服务端给了模型输入能力：当前模型的 input 含 image（可发图）。"
        false -> "服务端明确说当前模型**不接受**图片输入（input 不含 image）⇒ 这个按钮不会发图。"
        null -> "服务端没给当前模型的输入能力（input 缺失或模型目录还没加载）⇒ 无法证明模型能读图" +
            (catalogError?.let { "（服务端自报：$it）" } ?: "") + "；即使发送也只能以服务端回执为准。"
    }
}

/** 只取字符串数组；键缺失/不是数组 ⇒ null（未知，不变成空数组冒充“一个都没有”）。 */
internal fun JSONObject.optStringList(key: String): List<String>? {
    if (!has(key) || isNull(key)) return null
    val array: JSONArray = optJSONArray(key) ?: return null
    val values = ArrayList<String>(array.length())
    for (index in 0 until array.length()) {
        val value = array.optString(index, "")
        if (value.isNotEmpty()) values += value
    }
    return values
}

internal fun JSONObject.optIntOrNull(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    return optInt(key)
}

sealed interface ModelsOutcome {
    data class Loaded(val catalog: ModelCatalog) : ModelsOutcome
    data class Failed(val failure: ApiFailure) : ModelsOutcome
}
