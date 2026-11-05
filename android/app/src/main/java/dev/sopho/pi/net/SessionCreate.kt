package dev.sopho.pi.net

/**
 * 新建会话（`POST /api/sessions` → B → A 的 `POST /sessions`）的**纯逻辑**：拼请求体里该放哪些字段、
 * 结果怎么分类、回执怎么说。放这里是为了能用 JVM 单测钉住 —— 不碰 OkHttp、不碰 Compose，
 * 也刻意**不用 `org.json`**（JVM 单测里那个是 android.jar 的空壳，用了就测不动）。
 *
 * 契约（`server/base-logic.mjs` 的 `POST /sessions`，2026-10-23 逐行核过）：
 * - body 只有三个可填字段：`name`（可空）、`cwd`（**服务器上**的路径，可空）、`scratch`（bool）；
 * - `scratch:true` 与 `cwd` **互斥**：同时给 ⇒ 400 `invalid_session_location`；
 * - 什么都不给 ⇒ 在**服务器**的默认目录建（`SOPHO_DEFAULT_CWD` 或服务端进程的 cwd）—— 就是网页「项目根」那条；
 * - `scratch:true` ⇒ 服务端在 `<scratchRoot>/<新会话id>` 新建目录（目录名由服务端定，客户端不猜、不硬编码）；
 * - 成功 = **201**，回执带 `id / name / cwd / scratch / placementPersisted / warning`；
 * - 创建**只建空会话**：客户端不给 `task`、也不发任何消息 ⇒ 不会有模型回合。
 *
 * `postClient` 沿用发送那一套（`retryOnConnectionFailure(false)` ＋ 不跟重定向）⇒ 这条路**不会隐式重发** POST
 * （服务端没有幂等键，重发一次就多一条会话）。
 */
data class CreatePlan(val name: String?, val cwd: String?, val scratch: Boolean)

/** 201 回执里原型要用的那几个字段（字段名照服务端 `summaryFromManager` ＋ `POST /sessions` 的附加字段）。 */
data class CreatedSession(
    val id: String,
    val name: String?,
    val cwd: String?,
    val scratch: Boolean,
    /** 服务端有没有把这条会话的 placement 记录写进 `placement.json`（false = 已建但记账失败，**不要重试**）。 */
    val placementPersisted: Boolean,
    val warningMessage: String?,
)

/** 一次创建的结果。**201 只说「建出来了」**，不是「模型已回答」—— 这里连任务都没发。 */
sealed interface CreateOutcome {
    data class Created(val httpStatus: Int, val session: CreatedSession) : CreateOutcome

    /** 4xx：服务端拒了这条请求（没有接受）。 */
    data class Rejected(val httpStatus: Int, val errorCode: String?, val message: String?, val detail: String) : CreateOutcome

    /** 5xx / 回执看不懂：会话**可能已经建出来了**（服务端是建完之后才写名字/placement 的）⇒ 不许自动重发。 */
    data class Uncertain(val httpStatus: Int, val errorCode: String?, val detail: String) : CreateOutcome

    /** 超时/断连/读不到响应：**不知道**建没建。 */
    data object Unknown : CreateOutcome
}

object CreateProtocol {

    /**
     * 表单 → 请求体。空白名字/目录都当“没填”（不送空串：服务端会 `path.resolve('')` 成服务端进程的 cwd，
     * 那是猜出来的位置，不是用户说的位置）。`scratch` 打开时**一律不带 `cwd`** —— 两者互斥由构造保证。
     */
    fun plan(name: String, cwd: String, scratch: Boolean): CreatePlan = CreatePlan(
        name = name.trim().takeIf { it.isNotEmpty() },
        cwd = if (scratch) null else cwd.trim().takeIf { it.isNotEmpty() },
        scratch = scratch,
    )

    /** 真正要写进 JSON 的字段（键名照契约；不含任何默认/本机路径）。 */
    fun bodyFields(plan: CreatePlan): Map<String, Any> {
        val fields = LinkedHashMap<String, Any>()
        plan.name?.let { fields["name"] = it }
        if (plan.scratch) {
            fields["scratch"] = true
        } else {
            plan.cwd?.let { fields["cwd"] = it }
        }
        return fields
    }

    enum class Status {
        /** HTTP 层说成功 —— **不等于“已建”**：还必须从回执里解出会话实体（`id`）。 */
        SUCCESS,

        /** 核过**在建之前**就抛的具体码 ⇒ 确定没建（见 `REJECTED_BEFORE_CREATE`）。 */
        REJECTED,

        /** 其余（408 / 5xx / 来源不明的 4xx / 认不出的码）⇒ **不知道建没建**。 */
        UNCERTAIN,
    }

    /**
     * 返回码 ＋ 错误码 → 语义。
     *
     * ⚠️ 只有**核过在建之前就抛**的那三个码（`server/base-logic.mjs:8731-8733`）才算“确定没建”：
     * `invalid_scratch` / `invalid_session_location` / `invalid_cwd`。其余 4xx **一律保守当“不知道”**：
     * 例如 `invalid_name` 是在 `withSession(create:true)` **建完之后**才抛的；网关/代理换过的响应、
     * 读不出 `error` 的 4xx 也不证明“没建”。408 即使长着 4xx 的脸也可能是网关超时 ⇒ 同样不算“确定拒”。
     */
    fun classify(httpStatus: Int, errorCode: String?): Status = when {
        httpStatus in 200..299 -> Status.SUCCESS
        httpStatus == 408 -> Status.UNCERTAIN
        httpStatus >= 500 -> Status.UNCERTAIN
        httpStatus in 400..499 && errorCode in REJECTED_BEFORE_CREATE -> Status.REJECTED
        else -> Status.UNCERTAIN
    }

    /**
     * `POST /sessions` 里在 `withSession(create:true)` **之前**抛的码。只有这三个能说“肯定没多出一条会话”；
     * `invalid_name` **不在**里面（它在建完之后才检查）。
     */
    private val REJECTED_BEFORE_CREATE = setOf(
        "invalid_scratch",
        "invalid_session_location",
        "invalid_cwd",
    )

    /** 成功回执：说清建在哪（**服务端回的 cwd**，不是用户填的那串）、只建了空会话、列表会刷新。 */
    fun createdText(plan: CreatePlan, outcome: CreateOutcome.Created): String {
        val session = outcome.session
        val name = session.name?.takeIf { it.isNotBlank() }
            ?: "（无名字：列表里显示 id 前 8 位）"
        val where = session.cwd?.takeIf { it.isNotBlank() } ?: "（服务端没回 cwd）"
        val kind = if (session.scratch) "服务器临时目录（服务端新建的）" else "服务器上的目录"
        // 状态码不是 2xx、但回执里已经有这条会话（id）⇒ 按产物说话：已建，而且**不许重建**。
        val oddStatus = if (outcome.httpStatus in 200..299) {
            ""
        } else {
            "；⚠️ HTTP 状态码是 ${outcome.httpStatus}（不是 201），但回执里有这条会话的 id —— " +
                "**已经建出来了，不要重建**"
        }
        val note = if (session.placementPersisted) {
            ""
        } else {
            val warning = session.warningMessage?.takeIf { it.isNotBlank() }
                ?.let { "（服务端 warning：$it）" } ?: ""
            "；⚠️ 会话**已经建出来了**，但服务端没把它的 placement 记录写进 placement.json$warning" +
                " —— **不要重试创建**（会撞 live-cwd 守卫）；/tree 仍看得到它"
        }
        return "已创建（HTTP ${outcome.httpStatus}）·「$name」· $kind：$where · id ${SendProtocol.shortId(session.id)}$note$oddStatus。" +
            "只建了空会话：**没有**替你发任何任务（这里没有「模型已回答」这回事）。" +
            "列表会刷新（刷新失败会另给提示），点那一行可以打开它。"
    }

    /** 失败/未知的词：**确定拒**只有那三个码；其余一律“不确定”⇒ 先看列表、**不自动重发**。 */
    fun failureText(outcome: CreateOutcome): String = when (outcome) {
        is CreateOutcome.Created -> "已创建（HTTP ${outcome.httpStatus}）· id ${SendProtocol.shortId(outcome.session.id)}"

        is CreateOutcome.Rejected -> {
            val code = outcome.errorCode?.let { " · $it" } ?: ""
            val reason = outcome.message?.takeIf { it.isNotBlank() }?.let { "服务端说：$it" } ?: "服务端没有给原因"
            "没有建成（HTTP ${outcome.httpStatus}$code）：这个码是**在建之前**抛的，所以**确定**没多出来一条会话" +
                "（$reason）。改完再点一次就行（本应用不会自动重发）。你填的内容都还在。"
        }

        is CreateOutcome.Uncertain -> {
            val code = outcome.errorCode?.let { " · $it" } ?: ""
            "创建结果**不确定**（HTTP ${outcome.httpStatus}$code）：服务端报错了，但报错前有可能**已经建出来**" +
                "（服务端是建完之后才写名字/placement 的；读不出 `error` 的 4xx 也不证明没建）。**不自动重发** —— " +
                "先点「刷新」看列表里有没有那条会话，确认没有再多点一次。你填的内容都还在。"
        }

        CreateOutcome.Unknown ->
            "创建结果**未知**（请求超时或连接断了）：服务端可能已经建出来了，也可能没有。**不自动重发** —— " +
                "先点「刷新」看列表里有没有那条会话，确认没有再多点一次。你填的内容都还在。"
    }

    /** 输入是否该保留（失败/未知一律保留；成功才清空表单）。 */
    fun keepsInput(outcome: CreateOutcome): Boolean = outcome !is CreateOutcome.Created
}
