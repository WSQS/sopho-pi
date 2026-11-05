package dev.sopho.pi.net

import org.json.JSONArray
import org.json.JSONObject

/**
 * `GET /api/sessions/{id}/commands` 的**投影 ＋ 纯逻辑**。
 *
 * 服务端契约（`server/base-logic.mjs` 的 `allCommands()` / `/commands` 路由，2026-10-25 逐行复核）：
 * `{sessionId, streaming, compacting, canRun, commands[]}`，每条命令
 * `{name, description, source, argumentHint, builtin, runnable, reason, tag, via, hint, shadowed, path}`
 * —— 但 **`uiEntry` 只出现在 builtin 那一支**（prompt / skill / extension 的条目里根本没有这个键），
 * 所以本层**按「缺字段 = null」解析**，不要求字段齐全，也不拿缺失字段编值。
 *
 * 这里只做三件事：把回执翻译成 [CommandsSnapshot]；把它筛成界面要的一列；
 * 决定**用户敲进输入框的那段文本**到底该走哪条执行路（[CommandProtocol.dispatch]）。
 * 不碰 OkHttp、不碰 Compose —— 这些判据都能在 JVM 单测里钉住。
 */
data class ShadowedCommand(
    val name: String,
    val source: String?,
    val description: String?,
    val path: String?,
)

/** 一条命令（字段名逐字照服务端；缺的一律 null）。 */
data class CommandItem(
    val name: String,
    val description: String? = null,
    val source: String? = null,
    val argumentHint: String? = null,
    val builtin: Boolean = false,
    val runnable: Boolean = false,
    val reason: String? = null,
    val tag: String? = null,
    val uiEntry: String? = null,
    val via: String? = null,
    val hint: String? = null,
    val path: String? = null,
    val shadowed: ShadowedCommand? = null,
) {
    /**
     * 执行路由。**只有**服务端明确给出的 `via` 才认：
     * `prompt`（扩展 / prompt 模板 / skill ⇒ 走 `/message` 投这段文本）、`compact`、`model`；
     * 其余（`null` 或没见过的值）⇒ [CommandRoute.UNAVAILABLE] —— **不发明**「当普通消息发」这条默认路。
     */
    val route: CommandRoute
        get() = when {
            !runnable -> CommandRoute.UNAVAILABLE
            via == "prompt" -> CommandRoute.PROMPT
            via == "compact" -> CommandRoute.COMPACT
            via == "model" -> CommandRoute.MODEL
            else -> CommandRoute.UNAVAILABLE
        }

    /** 不能执行的**原因原话**（能执行就是 null）；缺失时如实说“服务端没给路由”。 */
    val refusal: String?
        get() = when (route) {
            CommandRoute.UNAVAILABLE -> reason?.takeIf { it.isNotBlank() }
                ?: "服务端没有给这条命令可执行的路由（via=${via ?: "缺失"}，runnable=$runnable）：本客户端不把它当普通消息发出去。"

            else -> null
        }

    /** 来源标签（人类可读；不猜）。 */
    val sourceLabel: String
        get() = when (source) {
            "builtin" -> "内置"
            "prompt" -> "prompt 模板"
            "skill" -> "skill"
            "extension" -> "扩展"
            "promptCommand" -> "prompt"
            null -> "来源未给"
            else -> source
        }

    /** 参数提示：服务端没给就写「未知」，不编。 */
    val argumentLabel: String get() = argumentHint?.takeIf { it.isNotBlank() } ?: "未知（服务端没给参数提示）"
}

enum class CommandRoute { PROMPT, COMPACT, MODEL, UNAVAILABLE }

/**
 * 一次 `/commands` 的读结果。
 *
 * `streaming` / `compacting` / `canRun` 都是**三态**（null = 服务端没给这个字段）：
 * 三态是为了不在字段缺失时把「不知道」说成「可以执行」。
 */
data class CommandsSnapshot(
    val sessionId: String,
    val streaming: Boolean? = null,
    val compacting: Boolean? = null,
    val canRun: Boolean? = null,
    val commands: List<CommandItem> = emptyList(),
    val skipped: Int = 0,
    val builtinError: String? = null,
    val builtinHow: String? = null,
) {
    /** 服务端明说 `canRun` 就用它；只给了 streaming/compacting 就按定义推；都没有 ⇒ null（不知道）。 */
    val runnableNow: Boolean?
        get() = canRun ?: when {
            streaming == null && compacting == null -> null
            else -> streaming != true && compacting != true
        }

    /** 会话当刻为什么不能跑命令（能跑 = null）。 */
    val blockedReason: String?
        get() = when {
            compacting == true -> "这条会话正在压缩（compacting=true）"
            streaming == true -> "这条会话正在跑一轮（streaming=true）"
            runnableNow == false -> "服务端说此刻 canRun=false"
            else -> null
        }
}

/** 回执读不懂 / 不属于这条会话：调用方按“拿不到清单”处理（不猜、不缓存成空清单冒充已知）。 */
class CommandsParseException(message: String) : Exception(message)

object CommandsWire {
    /**
     * 解析 `/commands` 回执。
     *
     * - 回执里的 `sessionId` 与目标不符 ⇒ 抛（拿别的会话的清单比“没拿到”更危险）；
     * - 缺 `commands` 数组 ⇒ 抛（那是形状不对，不是“一条命令都没有”）；
     * - 单条坏了（不是对象 / 没有 name）⇒ **跳过并计数**（[CommandsSnapshot.skipped]），不整页作废。
     */
    fun parse(body: String, expectedSessionId: String): CommandsSnapshot {
        val root = runCatching { JSONObject(body) }.getOrNull()
            ?: throw CommandsParseException("命令清单回执不是 JSON：" + body.take(200).replace('\n', ' '))
        val echo = root.optStringOrNull("sessionId")
        if (echo != null && !echo.equals(expectedSessionId, ignoreCase = true)) {
            throw CommandsParseException("命令清单回执的 sessionId=$echo 与目标 $expectedSessionId 不符")
        }
        val array = root.optJSONArray("commands")
            ?: throw CommandsParseException("命令清单回执里没有 commands 数组")
        val items = ArrayList<CommandItem>(array.length())
        var skipped = 0
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index)
            val name = item?.optStringOrNull("name")
            if (item == null || name == null) {
                skipped += 1
                continue
            }
            items += CommandItem(
                name = name,
                description = item.optStringOrNull("description"),
                source = item.optStringOrNull("source"),
                argumentHint = item.optStringOrNull("argumentHint"),
                builtin = item.optBoolean("builtin", false),
                runnable = item.optBoolean("runnable", false),
                reason = item.optStringOrNull("reason"),
                tag = item.optStringOrNull("tag"),
                uiEntry = item.optStringOrNull("uiEntry"),
                via = item.optStringOrNull("via"),
                hint = item.optStringOrNull("hint"),
                path = item.optStringOrNull("path"),
                shadowed = item.optJSONObject("shadowed")?.let { shadow ->
                    ShadowedCommand(
                        name = shadow.optStringOrNull("name") ?: "",
                        source = shadow.optStringOrNull("source"),
                        description = shadow.optStringOrNull("description"),
                        path = shadow.optStringOrNull("path"),
                    )
                },
            )
        }
        return CommandsSnapshot(
            sessionId = expectedSessionId,
            streaming = root.optBooleanOrNull("streaming"),
            compacting = root.optBooleanOrNull("compacting"),
            canRun = root.optBooleanOrNull("canRun"),
            commands = items,
            skipped = skipped,
            builtinError = root.optStringOrNull("builtinError"),
            builtinHow = root.optStringOrNull("builtinHow"),
        )
    }
}

/** 命令页的三档筛选（界面上的三个按钮；`ALL` 是默认）。 */
enum class CommandFilter(val label: String) {
    ALL("全部"),
    RUNNABLE("可执行"),
    UNAVAILABLE("不可执行"),
}

/**
 * 一次「用户这段文本该怎么执行」的决定。**纯逻辑**，不含 UI 类型（颜色/组件）。
 *
 * 为什么它必须存在（而不是在 `send()` 里散着判）：`/model`、`/compact` 是**专用命令**
 * （服务端 `WEB_BUILTINS` 里 `via` 就是它们），把它们当普通文本发出去，服务端会把整段 `/compact`
 * 当 prompt 收下 —— 那就是“假成功”。所以「从菜单点」和「手敲」走**同一条**判据。
 */
sealed interface CommandDecision {
    /** 不是命令（或不在名单里）⇒ 照旧走 message / steer（与网页同语义）。 */
    data object SendAsMessage : CommandDecision

    /** 名单内的命令，但会话此刻不能跑命令（在跑 / 压缩中）：一句都不发。 */
    data class Busy(val message: String) : CommandDecision

    /** 名单内但不可执行 / 清单没拿到：一句都不发，把原因说清。`warn=true` ⇒ 警示色（不是“确定失败”）。 */
    data class Refused(val message: String, val warn: Boolean) : CommandDecision

    /** `via=model` 的专用命令：打开模型页（不自动写入）。 */
    data class SwitchModel(val wanted: String?) : CommandDecision

    /** `via=compact` 的专用命令：要显式确认，然后 `POST /compact`。 */
    data class Compact(val instructions: String?) : CommandDecision
}

object CommandProtocol {

    /** 这段文本的命令名（与 `SendProtocol.looksLikeSlashCommand` 同一形状；不是命令就是 null）。 */
    fun nameIn(text: String): String? {
        val trimmed = text.trim()
        if (!trimmed.startsWith("/")) return null
        return trimmed.substring(1).takeWhile { !it.isWhitespace() }.takeIf { it.isNotEmpty() }
    }

    /** 命令名之后的参数原文（空 ⇒ null）。 */
    fun argumentIn(text: String): String? {
        val name = nameIn(text) ?: return null
        val trimmed = text.trim()
        return trimmed.removePrefix("/$name").trim().takeIf { it.isNotEmpty() }
    }

    /** 名单里那条命令（没有就 null）。名字按 `nameIn` 的同一规则取，不做模糊匹配。 */
    fun lookup(snapshot: CommandsSnapshot?, text: String): CommandItem? {
        val name = nameIn(text) ?: return null
        return snapshot?.commands?.firstOrNull { it.name == name }
    }

    /**
     * 界面筛选：先按三档过滤，再按查询串匹配名字或描述（与网页 `filteredCommands` 同一口径：
     * `name.includes(q) || description.includes(q)`，大小写不敏感；空查询就是全部）。
     */
    fun filter(list: List<CommandItem>, query: String, filter: CommandFilter): List<CommandItem> {
        val byKind = when (filter) {
            CommandFilter.ALL -> list
            CommandFilter.RUNNABLE -> list.filter { it.route != CommandRoute.UNAVAILABLE }
            CommandFilter.UNAVAILABLE -> list.filter { it.route == CommandRoute.UNAVAILABLE }
        }
        val lowered = query.trim().lowercase()
        if (lowered.isEmpty()) return byKind
        return byKind.filter { item ->
            item.name.lowercase().contains(lowered) ||
                (item.description ?: "").lowercase().contains(lowered) ||
                (item.argumentHint ?: "").lowercase().contains(lowered)
        }
    }

    /**
     * 点选一条可填入的命令时写进输入框的文本（**只是填入，不发送**）。
     * 形状照网页 `chooseCommandItem`：有参数提示或 `via=model` 时带一个尾空格，方便继续补参数。
     */
    fun fillText(item: CommandItem): String {
        val trailing = item.argumentHint != null || item.route == CommandRoute.MODEL
        return "/" + item.name + if (trailing) " " else ""
    }

    /**
     * 用户这段文本该走哪条路（`send()` 的命令语义闸就是它）。
     *
     * 判据顺序与理由：
     * 1. **不可执行优先**：`runnable=false` 或 `via` 认不出来 ⇒ 拒绝。忙不忙都不能让一条“根本没入口”的命令
     *    看起来像被执行了；也不把它降级成普通消息（那正是本单要堵的“假成功”）。
     * 2. **忙 ⇒ 拒绝**（名单内的命令）：服务端 `rejectStreamingCommand()` 也会 409 `command_while_streaming`，
     *    但客户端先说清，免得用户以为排队了。`/compact`、`/model` 也一视同仁（它们也不能插话）。
     * 3. 清单没拿到（`null`）而文本**像命令** ⇒ 拒绝：这时判不出它是 `/model` 还是“/tmp 是空的”，
     *    发出去可能是假成功。给出两条明确出路（重试加载 / 去掉开头的 `/`）。
     * 4. 名单里没有这个名字 ⇒ 照网页：当普通消息（`/tmp 是空的` 这类真实文本不该被拦死）。
     */
    fun dispatch(snapshot: CommandsSnapshot?, text: String, busy: Boolean): CommandDecision {
        val name = nameIn(text) ?: return CommandDecision.SendAsMessage
        if (snapshot == null) {
            return CommandDecision.Refused(
                "「/$name」现在判不了：这条会话的命令清单还没拿到（或上一次加载失败），而命令**不能**当普通消息发出去 " +
                    "（服务端会把 /model、/compact 这类当命令处理，202 也证明不了执行结果）。" +
                    "请在功能盘的命令页点「重试」；若这段确实是普通文本，请把开头的「/」去掉再发。",
                warn = true,
            )
        }
        val item = snapshot.commands.firstOrNull { it.name == name }
            ?: return CommandDecision.SendAsMessage
        val refusal = item.refusal
        if (refusal != null) {
            return CommandDecision.Refused(
                "「/${item.name}」在本会话不可执行：$refusal 这句**没有**发出去，也没有当普通消息降级发送。",
                warn = false,
            )
        }
        if (busy || snapshot.streaming == true || snapshot.compacting == true) {
            return CommandDecision.Busy(
                "会话正在" + (if (snapshot.compacting == true) "压缩" else "跑") + " —— 命令「/${item.name}」不能插话也不能排队，" +
                    "这句没有发出去。等这一轮结束再发；草稿已保留。",
            )
        }
        return when (item.route) {
            CommandRoute.PROMPT -> CommandDecision.SendAsMessage
            CommandRoute.COMPACT -> CommandDecision.Compact(argumentIn(text))
            CommandRoute.MODEL -> CommandDecision.SwitchModel(argumentIn(text))
            CommandRoute.UNAVAILABLE -> CommandDecision.Refused(
                "「/${item.name}」在本会话不可执行：" + (item.refusal ?: "服务端没给路由") + " 这句**没有**发出去。",
                warn = false,
            )
        }
    }
}

/** `{...}` 里那个键存在且是真布尔才取值；缺失/`null` ⇒ null（三态，不把缺失当 false）。 */
internal fun JSONObject.optBooleanOrNull(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    return optBoolean(key)
}

/** 一次只读请求的失败（`httpStatus = null` ⇒ 请求本身就没成：超时/断连）。 */
data class ApiFailure(val httpStatus: Int?, val code: String?, val message: String)

sealed interface CommandsOutcome {
    data class Loaded(val snapshot: CommandsSnapshot) : CommandsOutcome
    data class Failed(val failure: ApiFailure) : CommandsOutcome
}

/**
 * `POST /compact` 的结果。**202 `accepted:true` 只是“请求已收下”** —— 压缩有没有跑完要看正文/SSE，
 * 回执文案不许写成“已压缩”。
 */
sealed interface CompactOutcome {
    data class Accepted(val httpStatus: Int) : CompactOutcome
    data class Rejected(val httpStatus: Int, val errorCode: String?, val message: String?, val detail: String) : CompactOutcome
    data class Uncertain(val httpStatus: Int, val errorCode: String?, val detail: String) : CompactOutcome
    data object Unknown : CompactOutcome
}
