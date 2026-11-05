package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 命令清单这条线的**纯逻辑**证据（不碰 OkHttp、不碰 Compose）：
 * 解析（缺字段/坏条目/归属）、三态（streaming/compacting/canRun）、筛选，
 * 以及最要紧的那件事 —— **用户这段文本该走哪条执行路**。
 *
 * 会失败的理由（每条都对着一个真实契约）：
 * - 把 `uiEntry` 当必填 ⇒ prompt / skill 条目整页作废（服务端只在 builtin 那支给这个键）；
 * - `via` 认不出来时默认当普通消息 ⇒ `/model`、`/compact` 会变成“假成功”；
 * - 忙的时候还把命令发下去 ⇒ 用户以为排队了（服务端其实会 409 `command_while_streaming`）；
 * - 清单没拿到时放行斜杠文本 ⇒ 判不出它是专用命令，发出去就可能假成功。
 */
class CommandsProtocolTest {

    private val sid = "11111111-1111-4111-8111-111111111111"

    private fun body(
        streaming: String = "false",
        compacting: String = "false",
        canRun: String = "true",
        commands: String = COMMANDS,
    ): String = """{"sessionId":"$sid","streaming":$streaming,"compacting":$compacting,"canRun":$canRun,""" +
        """"builtinError":null,"builtinHow":"/pi/dist/core/slash-commands.js","commands":$commands}"""

    private fun snapshot(commands: String = COMMANDS): CommandsSnapshot =
        CommandsWire.parse(body(commands = commands), sid)

    // ───────────────────────── 解析 ─────────────────────────

    /**
     * prompt / skill 命令**没有** `uiEntry` 键（服务端只在 builtin 那支给）⇒ 必须照常解析成 null，
     * 不能整页报错、也不能给一个编出来的值。
     */
    @Test
    fun promptCommandWithoutUiEntryParsesToNull() {
        val parsed = snapshot()
        val review = parsed.commands.first { it.name == "review" }
        assertNull("prompt 条目本来就没有 uiEntry", review.uiEntry)
        assertEquals(CommandRoute.PROMPT, review.route)
        assertNull("能执行就没有 refusal", review.refusal)
        assertEquals("6 条全在", 6, parsed.commands.size)
        assertEquals("没有读不懂的条目", 0, parsed.skipped)
    }

    /** 单条坏了（没有 name）⇒ 跳过并计数；**不整页作废**（其余命令仍然可用）。 */
    @Test
    fun malformedItemIsSkippedAndCounted() {
        val parsed = snapshot(
            """[{"description":"没有名字的坏条目"},{"name":"review","source":"prompt","runnable":true,"via":"prompt"},""" +
                """{"name":"compact","source":"builtin","runnable":true,"via":"compact"}]""",
        )
        assertEquals(2, parsed.commands.size)
        assertEquals(1, parsed.skipped)
    }

    /** 回执的 sessionId 与目标不符 ⇒ 抛（拿别的会话的清单比“没拿到”更危险）。 */
    @Test
    fun sessionIdMismatchIsRefused() {
        val other = """{"sessionId":"22222222-2222-4222-8222-222222222222","commands":[]}"""
        try {
            CommandsWire.parse(other, sid)
            fail("sessionId 不符时必须抛")
        } catch (expected: CommandsParseException) {
            assertTrue("报错要说清是归属不符", expected.message!!.contains("不符"))
        }
    }

    /** 没有 `commands` 数组 ⇒ 抛（形状不对 ≠ “一条命令都没有”）。 */
    @Test
    fun missingCommandsArrayIsRefused() {
        try {
            CommandsWire.parse("""{"sessionId":"$sid"}""", sid)
            fail("缺 commands 数组时必须抛")
        } catch (expected: CommandsParseException) {
            assertTrue(expected.message!!.contains("commands"))
        }
    }

    /**
     * `streaming` / `compacting` / `canRun` 都是三态：缺失 ⇒ 未知（null），**不能**说成“空闲/可执行”。
     * 只给了 streaming ⇒ 按定义推；明说 canRun=false ⇒ 以它为准。
     */
    @Test
    fun runStateIsTriState() {
        val unknown = CommandsWire.parse("""{"sessionId":"$sid","commands":[]}""", sid)
        assertNull("三个字段都没给 ⇒ 未知", unknown.runnableNow)
        assertNull("unknown 时也不该给出 blockedReason", unknown.blockedReason)
        assertNull(unknown.streaming)
        assertNull(unknown.compacting)
        assertNull(unknown.canRun)

        val streamingOnly = CommandsWire.parse("""{"sessionId":"$sid","streaming":true,"commands":[]}""", sid)
        assertEquals(false, streamingOnly.runnableNow)
        assertTrue("说清是被什么挡住的", streamingOnly.blockedReason!!.contains("跑"))

        val compactingOnly = CommandsWire.parse("""{"sessionId":"$sid","compacting":true,"commands":[]}""", sid)
        assertEquals(false, compactingOnly.runnableNow)
        assertTrue(compactingOnly.blockedReason!!.contains("压缩"))

        val explicit = CommandsWire.parse("""{"sessionId":"$sid","canRun":false,"commands":[]}""", sid)
        assertEquals(false, explicit.runnableNow)
        assertTrue(explicit.blockedReason!!.contains("canRun=false"))
    }

    // ───────────────────────── 执行路由 ─────────────────────────

    /** 名单里没有这个斜杠词（“/tmp 是空的”这种普通文本）⇒ 照网页：当普通消息。 */
    @Test
    fun unknownSlashTextGoesAsPlainMessage() {
        val decision = CommandProtocol.dispatch(snapshot(), "/tmp 是空的", busy = false)
        assertEquals(CommandDecision.SendAsMessage, decision)
    }

    /** `via=prompt`（扩展 / prompt 模板 / skill）⇒ 照旧走 `/message`（服务端自己会把命令展开）。 */
    @Test
    fun promptCommandSendsAsMessage() {
        assertEquals(CommandDecision.SendAsMessage, CommandProtocol.dispatch(snapshot(), "/review src/", busy = false))
        assertEquals(CommandDecision.SendAsMessage, CommandProtocol.dispatch(snapshot(), "/skill:foo", busy = false))
    }

    /** `via=compact` ⇒ 专用路（要显式确认），参数原样带上；**不能**当普通消息。 */
    @Test
    fun compactCommandTakesDedicatedRoute() {
        assertEquals(CommandDecision.Compact(null), CommandProtocol.dispatch(snapshot(), "/compact", busy = false))
        assertEquals(
            CommandDecision.Compact("保留最近的 20 条"),
            CommandProtocol.dispatch(snapshot(), "  /compact   保留最近的 20 条 ", busy = false),
        )
    }

    /** `via=model` ⇒ 专用路（跳模型页）；带参数/不带参数都要能拿到参数原文。 */
    @Test
    fun modelCommandTakesDedicatedRoute() {
        assertEquals(CommandDecision.SwitchModel(null), CommandProtocol.dispatch(snapshot(), "/model", busy = false))
        assertEquals(
            CommandDecision.SwitchModel("litellm/deepseek-flash"),
            CommandProtocol.dispatch(snapshot(), "/model litellm/deepseek-flash", busy = false),
        )
    }

    /** `runnable=false` ⇒ 拒绝，并把**服务端给的原因**原话带出来（不当普通消息、不假装有入口）。 */
    @Test
    fun unavailableCommandIsRefusedWithServerReason() {
        val decision = CommandProtocol.dispatch(snapshot(), "/settings", busy = false)
        if (decision !is CommandDecision.Refused) throw AssertionError("必须是 Refused：$decision")
        val refused = decision
        assertTrue("带出服务端的原因原话", refused.message.contains("TUI 专用"))
        assertTrue("说清没有发出去", refused.message.contains("没有"))
        assertFalse("确定不可执行 ⇒ 不用警示色", refused.warn)
    }

    /**
     * `runnable=true` 但 `via` 缺失/不认识 ⇒ **不可执行**（不能默认降级成普通消息）。
     * 这是本单的硬口径：未知路由不许冒充已知语义。
     */
    @Test
    fun unknownViaIsUnavailableNotPlainMessage() {
        val parsed = snapshot("""[{"name":"mystery","source":"extension","runnable":true,"via":null}]""")
        val item = parsed.commands.single()
        assertEquals(CommandRoute.UNAVAILABLE, item.route)
        assertTrue("refusal 要说清 via 缺失", item.refusal!!.contains("via=缺失"))
        val decision = CommandProtocol.dispatch(parsed, "/mystery", busy = false)
        assertTrue("必须是拒绝，不是 SendAsMessage", decision is CommandDecision.Refused)

        val unknownValue = snapshot("""[{"name":"weird","source":"extension","runnable":true,"via":"telepathy"}]""")
        assertEquals(CommandRoute.UNAVAILABLE, unknownValue.commands.single().route)
        assertTrue(CommandProtocol.dispatch(unknownValue, "/weird", busy = false) is CommandDecision.Refused)
    }

    /** 会话在跑（SSE 说忙）⇒ 名单内命令一律拒（服务端也会 409 `command_while_streaming`）。 */
    @Test
    fun busySessionRefusesKnownCommands() {
        val decision = CommandProtocol.dispatch(snapshot(), "/review x", busy = true)
        if (decision !is CommandDecision.Busy) throw AssertionError("必须 Busy：$decision")
        val busyDecision = decision
        assertTrue(busyDecision.message.contains("不能插话也不能排队"))

        // 清单自己也说 streaming=true 时同理（即便调用方传 busy=false）。
        val streamingSnapshot = CommandsWire.parse(body(streaming = "true", canRun = "false"), sid)
        assertTrue(CommandProtocol.dispatch(streamingSnapshot, "/compact", busy = false) is CommandDecision.Busy)
    }

    /**
     * 清单还没拿到（null）而文本像命令 ⇒ 拒绝并给两条出路。
     * 理由：这时判不出 `/model` 与“/tmp 是空的”的区别，发出去就是赌——赌错就成假成功。
     */
    @Test
    fun nullSnapshotRefusesSlashTextWithEscapeHatch() {
        val decision = CommandProtocol.dispatch(null, "/model x", busy = false)
        if (decision !is CommandDecision.Refused) throw AssertionError("必须 Refused：$decision")
        val refused = decision
        assertTrue(refused.warn)
        assertTrue("给重试这条路", refused.message.contains("重试"))
        assertTrue("给“确认是普通文本”这条路", refused.message.contains("去掉"))
        // 不带斜杠的普通文本照常发（清单缺失不该拦住聊天）。
        assertEquals(CommandDecision.SendAsMessage, CommandProtocol.dispatch(null, "你好", busy = false))
    }

    // ───────────────────────── 筛选与填入 ─────────────────────────

    @Test
    fun filterByKindAndQuery() {
        val parsed = snapshot()
        val all = CommandProtocol.filter(parsed.commands, "", CommandFilter.ALL)
        assertEquals(6, all.size)
        val runnable = CommandProtocol.filter(parsed.commands, "", CommandFilter.RUNNABLE)
        assertEquals("只有 settings 不可执行", 5, runnable.size)
        val unavailable = CommandProtocol.filter(parsed.commands, "", CommandFilter.UNAVAILABLE)
        assertEquals(listOf("settings"), unavailable.map { it.name })

        // 空查询/大小写：名字与描述都参与匹配（与网页 filteredCommands 同口径）。
        assertEquals(listOf("review"), CommandProtocol.filter(parsed.commands, "REVI", CommandFilter.ALL).map { it.name })
        assertEquals(
            listOf("compact"),
            CommandProtocol.filter(parsed.commands, "压缩", CommandFilter.ALL).map { it.name },
        )
        assertEquals(0, CommandProtocol.filter(parsed.commands, "不存在的词", CommandFilter.ALL).size)
    }

    /** 填入形状照网页：有参数提示或 `via=model` ⇒ 带一个尾空格（方便继续补参数）。 */
    @Test
    fun fillTextShapeMatchesWeb() {
        val parsed = snapshot()
        assertEquals("/review ", CommandProtocol.fillText(parsed.commands.first { it.name == "review" }))
        assertEquals("/compact", CommandProtocol.fillText(parsed.commands.first { it.name == "compact" }))
        assertEquals("/model ", CommandProtocol.fillText(parsed.commands.first { it.name == "model" }))
    }

    /** 参数提示缺失 ⇒ 说“未知”，不编一个形状出来。 */
    @Test
    fun argumentLabelSaysUnknownWhenServerGivesNothing() {
        val parsed = snapshot("""[{"name":"review","source":"prompt","runnable":true,"via":"prompt","argumentHint":null}]""")
        assertTrue(parsed.commands.single().argumentLabel.contains("未知"))
    }

    companion object {
        /** 形状逐字照 `server/base-logic.mjs` 的 `allCommands()`（含 prompt 条目**没有** uiEntry 这件事）。 */
        private const val COMMANDS = """[
          {"name":"review","description":"审查代码改动","source":"prompt","argumentHint":"<path>","path":"/p/review.md",
           "builtin":false,"runnable":true,"reason":null,"tag":null,"via":"prompt","hint":null,"shadowed":null},
          {"name":"compact","description":"压缩本会话的上下文","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"compact",
           "hint":"发 /compact，网页会调用这条会话的压缩入口。","shadowed":null},
          {"name":"model","description":"切换本会话使用的模型","source":"builtin","argumentHint":"<provider/model>","path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"model",
           "hint":"发 /model <provider/model>；输入 /model 空格会列候选。","shadowed":null},
          {"name":"settings","description":"多项设置","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":false,"reason":"TUI 专用（pi 的多项设置菜单：主题 / transport / 图片 / 自动压缩…，网页里没有这份菜单）。",
           "tag":"TUI 专用","uiEntry":null,"via":null,"hint":null,"shadowed":null},
          {"name":"skill:foo","description":"一个 skill","source":"skill","argumentHint":null,"path":"/p/skills/foo/SKILL.md",
           "builtin":false,"runnable":true,"reason":null,"tag":null,"via":"prompt","hint":null,"shadowed":null},
          {"name":"shadowed-one","description":"被同名 prompt 覆盖的内置命令","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"prompt","hint":null,
           "shadowed":{"name":"shadowed-one","source":"prompt","description":"同名的 prompt 模板","path":"/p/shadowed-one.md"}}
        ]"""
    }
}
