package dev.sopho.pi.net

import dev.sopho.pi.net.SendOutcome
import dev.sopho.pi.net.SendProtocol
import dev.sopho.pi.net.SendRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住发送那条路的**可测层**（不碰 OkHttp、不碰 Compose、不碰真实服务）：
 * 走哪条路由（闲 message / 忙 steer）、空白不发、回执语义（202 只是“接受”不是“已回答”）、
 * 409 的方向码怎么说、失败/未知保留草稿并且**不自动重发**、成功只清“还是发送时那份”的草稿。
 *
 * 真实 HTTP 那层由 `docs/ops/android-client.md` §13 的假 API 记录与 AVD 截图负责。
 */
class SendProtocolTest {

    @Test
    fun `blank input is never sent`() {
        assertNull(SendProtocol.plan("s1", "", busy = false))
        assertNull(SendProtocol.plan("s1", "   \n\t ", busy = true))
    }

    @Test
    fun `idle goes to message and busy goes to steer with the same body`() {
        val idle = SendProtocol.plan("s1", "  你好  ", busy = false)!!
        assertEquals(SendRoute.MESSAGE, idle.route)
        assertEquals("message", idle.route.path)
        assertEquals("你好", idle.text) // 只 trim，不自己改写内容

        val busy = SendProtocol.plan("s1", "补一句", busy = true)!!
        assertEquals(SendRoute.STEER, busy.route)
        assertEquals("steer", busy.route.path)
    }

    @Test
    fun `body carries only text and the target session id`() {
        val plan = SendProtocol.plan("abc-123", "hi", busy = false)!!
        assertEquals("abc-123", plan.sessionId)
        assertEquals("hi", plan.text)
    }

    @Test
    fun `accepted 202 is worded as accepted, never as answered`() {
        val plan = SendProtocol.plan("session-abcdef", "hi", busy = false)!!
        val text = SendProtocol.acceptedText(plan, SendOutcome.Accepted(SendRoute.MESSAGE, 202))
        assertTrue(text.contains("已接受"))
        assertTrue(text.contains("HTTP 202"))
        assertTrue(text.contains("session-"))
        assertTrue(text.contains("不是“已回答”"))
        // 反面：不许把 202 说成模型已经回答
        assertFalse(text.contains("已回答】"))
        assertFalse(text.contains("模型回答："))
    }

    @Test
    fun `steer receipt names the steer route`() {
        val plan = SendProtocol.plan("s1", "hi", busy = true)!!
        val text = SendProtocol.acceptedText(plan, SendOutcome.Accepted(SendRoute.STEER, 202))
        assertTrue(text.contains("插话（steer）"))
    }

    @Test
    fun `busy conflicts explain both directions and say nothing was sent`() {
        val streaming = SendProtocol.failureText(SendOutcome.Rejected(409, "session_streaming", "busy"))
        assertTrue(streaming.contains("session_streaming"))
        assertTrue(streaming.contains("没有"))
        val idle = SendProtocol.failureText(SendOutcome.Rejected(409, "session_not_streaming", "idle"))
        assertTrue(idle.contains("session_not_streaming"))
        val compacting = SendProtocol.failureText(SendOutcome.Rejected(409, "session_compacting", "compacting"))
        assertTrue(compacting.contains("session_compacting"))
    }

    @Test
    fun `unknown and uncertain results keep the draft and forbid auto resend`() {
        for (outcome in listOf(
            SendOutcome.Unknown,
            SendOutcome.Uncertain(500, "internal", "boom"),
            SendOutcome.Rejected(409, "session_streaming", "busy"),
        )) {
            assertTrue(SendProtocol.keepsDraft(outcome))
        }
        val unknown = SendProtocol.failureText(SendOutcome.Unknown)
        assertTrue(unknown.contains("未知"))
        assertTrue(unknown.contains("不自动重发"))
        val uncertain = SendProtocol.failureText(SendOutcome.Uncertain(503, null, "boom"))
        assertTrue(uncertain.contains("不确定"))
        assertTrue(uncertain.contains("不自动重发"))
    }

    @Test
    fun `only the four pre-enqueue error codes count as safely retryable`() {
        // busyConflict() 与 requireText() 都在入队前抛 —— 这四个码才是“确定没发出去”。
        assertTrue(SendProtocol.safeToRetry(SendOutcome.Rejected(409, "session_streaming", "")))
        assertTrue(SendProtocol.safeToRetry(SendOutcome.Rejected(409, "session_not_streaming", "")))
        assertTrue(SendProtocol.safeToRetry(SendOutcome.Rejected(409, "session_compacting", "")))
        assertTrue(SendProtocol.safeToRetry(SendOutcome.Rejected(400, "invalid_text", "")))

        // 其余 4xx 一律**不**默认安全：没有可识别 error、代理/网关、路径错、改写的响应都不证明没写过。
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Rejected(400, null, "<html>proxy</html>")))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Rejected(404, "session_not_found", "")))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Rejected(408, null, "timeout")))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Rejected(429, "too_many", "")))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Uncertain(500, null, "")))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Unknown))
        assertFalse(SendProtocol.safeToRetry(SendOutcome.Accepted(SendRoute.MESSAGE, 202)))
    }

    @Test
    fun `408 is a timeout status and an unrecognized rejection is worded as uncertain`() {
        assertTrue(SendProtocol.isTimeoutStatus(408))
        assertFalse(SendProtocol.isTimeoutStatus(409))
        val text = SendProtocol.failureText(SendOutcome.Rejected(400, null, "<html>proxy</html>"))
        assertTrue(text.contains("不确定"))
        assertTrue(text.contains("不自动重发"))
        assertFalse(text.contains("没有**发出去"))
    }

    @Test
    fun `accepted does not keep a draft by itself`() {
        assertFalse(SendProtocol.keepsDraft(SendOutcome.Accepted(SendRoute.MESSAGE, 202)))
    }

    @Test
    fun `draft is only cleared when it is still exactly what was sent`() {
        // 用户在飞行途中没动过 ⇒ 清
        assertTrue(SendProtocol.shouldClearDraft("你好", "你好"))
        // 用户又编辑了 ⇒ 新草稿必须留住
        assertFalse(SendProtocol.shouldClearDraft("你好，再补一句", "你好"))
        // 用户清空了又重新打字 ⇒ 也不算“还是那份”
        assertFalse(SendProtocol.shouldClearDraft("x", "你好"))
    }

    // ─────────────── 忙闲竞态：只切一次、只认入队前的具体 409 ───────────────

    @Test
    fun `message 409 session_streaming falls back to steer exactly once`() {
        val plan = SendProtocol.plan("s1", "补一句", busy = false)!!
        assertEquals(SendRoute.MESSAGE, plan.route)
        val rejected = SendOutcome.Rejected(409, "session_streaming", "busy")
        val retry = SendProtocol.fallback(plan, rejected)!!
        assertEquals("闲时被 409 ⇒ 改走 steer", SendRoute.STEER, retry.route)
        assertEquals("同一句、同一条会话，只换路由", plan.text, retry.text)
        assertEquals(plan.sessionId, retry.sessionId)
        // 第二次 steer 也回 session_streaming = 准入窗口 ⇒ 不许再切回去
        assertNull(SendProtocol.fallback(retry, SendOutcome.Rejected(409, "session_streaming", "admission")))
    }

    @Test
    fun `steer 409 session_not_streaming falls back to message exactly once`() {
        val plan = SendProtocol.plan("s1", "补一句", busy = true)!!
        assertEquals(SendRoute.STEER, plan.route)
        val rejected = SendOutcome.Rejected(409, "session_not_streaming", "idle")
        val retry = SendProtocol.fallback(plan, rejected)!!
        assertEquals("忙时被 409 ⇒ 改走 message", SendRoute.MESSAGE, retry.route)
        // steer 收到 session_streaming = 准入窗口（不是“已闲”那个方向）⇒ 不许切回 message
        assertNull(SendProtocol.fallback(plan, SendOutcome.Rejected(409, "session_streaming", "admission")))
    }

    @Test
    fun `compaction and admission window stop instead of switching routes`() {
        val message = SendProtocol.plan("s1", "hi", busy = false)!!
        val steer = SendProtocol.plan("s1", "hi", busy = true)!!
        // 压缩：两条路都没有可投递的位置
        assertNull(SendProtocol.fallback(message, SendOutcome.Rejected(409, "session_compacting", "compacting")))
        assertNull(SendProtocol.fallback(steer, SendOutcome.Rejected(409, "session_compacting", "compacting")))
        // 准入窗口：message 回 session_streaming 时切到 steer，但 steer 同样回 session_streaming ⇒ 停
        val admissionSteer = SendProtocol.fallback(message, SendOutcome.Rejected(409, "session_streaming", "admission"))!!
        assertNull(SendProtocol.fallback(admissionSteer, SendOutcome.Rejected(409, "session_streaming", "admission")))
    }

    @Test
    fun `unknown uncertain 408 and unrecognized rejections never switch routes`() {
        val message = SendProtocol.plan("s1", "hi", busy = false)!!
        for (outcome in listOf(
            SendOutcome.Unknown,
            SendOutcome.Uncertain(500, "internal", "boom"),
            SendOutcome.Uncertain(202, "invalid_accept_receipt", "no accepted:true"),
            SendOutcome.Rejected(408, "session_streaming", "gateway timeout"),
            SendOutcome.Rejected(409, null, "proxy"),
            SendOutcome.Rejected(409, "command_while_streaming", "command"),
            SendOutcome.Rejected(400, "invalid_text", "empty"),
            SendOutcome.Accepted(SendRoute.MESSAGE, 202),
        )) {
            assertNull("$outcome 不证明没入队/不需要切路", SendProtocol.fallback(message, outcome))
        }
    }

    @Test
    fun `slash shaped text is forced to message and never switches to steer`() {
        // 忙会话上的命令：首选也只能是 message（命令永远不以 steer 形态出现）
        val busyCommand = SendProtocol.plan("s1", "/model gpt-5", busy = true)!!
        assertEquals(SendRoute.MESSAGE, busyCommand.route)
        assertNull(SendProtocol.fallback(busyCommand, SendOutcome.Rejected(409, "session_streaming", "busy")))

        // 闲会话也一样
        val idleCommand = SendProtocol.plan("s1", "/compact", busy = false)!!
        assertEquals(SendRoute.MESSAGE, idleCommand.route)
        assertNull(SendProtocol.fallback(idleCommand, SendOutcome.Rejected(409, "session_streaming", "busy")))

        // 形状照服务端 commandNameIn()：`/` 后第一个 token 非空才算命令形状
        assertTrue(SendProtocol.looksLikeSlashCommand("/model"))
        assertTrue(SendProtocol.looksLikeSlashCommand("/name foo"))
        assertFalse("单独的 / 服务端当普通文本", SendProtocol.looksLikeSlashCommand("/"))
        assertFalse("`/ foo` 第一个 token 为空，服务端不当命令", SendProtocol.looksLikeSlashCommand("/ foo"))
        assertFalse(SendProtocol.looksLikeSlashCommand("普通文本"))

        // 普通文本哪怕以 / 开头也可能只是内容（“/tmp 是空的”不被当成命令形状）—— 这里形状命中，所以不切路；
        // 但它仍会被允许作为一条 message 发出去（plan 不拦）。
        assertEquals(SendRoute.MESSAGE, SendProtocol.plan("s1", "/tmp 是空的", busy = true)!!.route)
    }

    @Test
    fun `fallback receipt says which route was accepted and that it switched only once`() {
        val plan = SendProtocol.plan("session-abcdef", "hi", busy = false)!!
        val first = SendOutcome.Rejected(409, "session_streaming", "busy")
        val text = SendProtocol.acceptedText(plan.copy(route = SendRoute.STEER), SendOutcome.Accepted(SendRoute.STEER, 202), first)
        assertTrue(text.contains("已接受"))
        assertTrue(text.contains("插话（steer）"))
        assertTrue(text.contains("409 session_streaming"))
        assertTrue(text.contains("只切了这一次"))
        assertTrue("首次那句确实没入队要写清", text.contains("没有入队"))
        // 没有切路时不许凭空多出这句
        assertFalse(SendProtocol.acceptedText(plan, SendOutcome.Accepted(SendRoute.MESSAGE, 202)).contains("只切了这一次"))
    }

    // ─────────────── 2xx 不等于 accepted：回执必须能证明“这一条、这条路由、这条会话” ───────────────

    @Test
    fun `accept receipt requires accepted true matching session and route semantics`() {
        val message = SendProtocol.plan("AAAAAAAA-1111-4111-8111-111111111111", "hi", busy = false)!!
        val steer = message.copy(route = SendRoute.STEER)

        assertEquals(
            SendOutcome.Accepted(SendRoute.MESSAGE, 202),
            SendProtocol.interpretAccepted(message, 202, true, message.sessionId, null),
        )
        assertEquals(
            "sessionId 大小写不敏感（服务端用完整 uuid，回执就是它）",
            SendOutcome.Accepted(SendRoute.STEER, 202),
            SendProtocol.interpretAccepted(steer, 202, true, message.sessionId.lowercase(), "steer"),
        )

        val noAccepted = SendProtocol.interpretAccepted(message, 202, null, message.sessionId, null)
        assertTrue(noAccepted is SendOutcome.Uncertain)
        assertEquals("invalid_accept_receipt", (noAccepted as SendOutcome.Uncertain).errorCode)

        val wrongSession = SendProtocol.interpretAccepted(message, 202, true, "another-session", null)
        assertTrue(wrongSession is SendOutcome.Uncertain)
        assertEquals("session_id_mismatch", (wrongSession as SendOutcome.Uncertain).errorCode)

        val wrongModeOnSteer = SendProtocol.interpretAccepted(steer, 202, true, message.sessionId, null)
        assertTrue("steer 回执必须带 mode:steer", wrongModeOnSteer is SendOutcome.Uncertain)
        assertEquals("route_mismatch", (wrongModeOnSteer as SendOutcome.Uncertain).errorCode)

        val contradictingMessage = SendProtocol.interpretAccepted(message, 202, true, message.sessionId, "steer")
        assertTrue("message 回执不可能 mode:steer", contradictingMessage is SendOutcome.Uncertain)

        // 2xx 但回执读不懂 ⇒ 草稿保留（不能只凭状态码吞草稿）
        assertTrue(SendProtocol.keepsDraft(noAccepted))
    }

    @Test
    fun `command_while_streaming is a pre-enqueue rejection with its own wording`() {
        val outcome = SendOutcome.Rejected(409, "command_while_streaming", "command")
        assertTrue(SendProtocol.safeToRetry(outcome))
        val text = SendProtocol.failureText(outcome)
        assertTrue(text.contains("command_while_streaming"))
        assertTrue(text.contains("不能插话也不能排队"))
        assertTrue(text.contains("没有发出去"))
        assertTrue("不许把它写成 steer 那条已闲的通知", !text.contains("其实已经闲下来"))
    }
}
