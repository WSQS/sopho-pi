package dev.sopho.pi.net

import dev.sopho.pi.net.CreateOutcome
import dev.sopho.pi.net.CreatePlan
import dev.sopho.pi.net.CreateProtocol
import dev.sopho.pi.net.CreatedSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住「新建会话」那条路的**可测层**（不碰 OkHttp、不碰 Compose、不碰真实服务）：
 * 请求体里到底放了哪些字段（`scratch` 与 `cwd` 互斥、留空就不送、**不硬编码本机路径**）、
 * 返回码的语义（只有 2xx 才算建出来；5xx/408 = 不确定）、回执怎么说（建在哪、**没发任务**、
 * 不确定时**不自动重发**、失败保留输入）。
 *
 * 真实 HTTP 那层（真 OkHttp ＋ 真 TCP ＋ 假服务端）由 `androidTest/.../SessionCreateBehaviourTest.kt`
 * 负责；真实服务器上的创建**没有**做过 —— 授权实现≠授权在生产里造会话，见
 * `docs/ops/android-create-session.md`「没验到什么」。
 */
class SessionCreateTest {

    private val created = CreatedSession(
        id = "1b2c3d4e-0000-4000-8000-000000000001",
        name = "新会话",
        cwd = "/srv/work/tmp-1b2c",
        scratch = false,
        placementPersisted = true,
        warningMessage = null,
    )

    // ───────────────────────────── 请求体 ─────────────────────────────

    @Test
    fun `empty form sends no fields at all - no invented path`() {
        val plan = CreateProtocol.plan("", "   ", scratch = false)
        assertNull("空白名字当“没填”，不送空串", plan.name)
        assertNull("空白目录当“没填”，不送空串", plan.cwd)
        // 关键：留空 = 什么都不送（服务端用自己的默认目录）。客户端**不许**自己塞一个本机路径。
        assertTrue("什么都不填就什么都不送：${CreateProtocol.bodyFields(plan)}", CreateProtocol.bodyFields(plan).isEmpty())
    }

    @Test
    fun `scratch and cwd are mutually exclusive by construction`() {
        // 勾了临时目录 ⇒ 目录框里即使还留着字，也**一个 cwd 字段都不许送**（服务端契约：两者互斥会 400）。
        val plan = CreateProtocol.plan("名字", "/srv/work/x", scratch = true)
        val fields = CreateProtocol.bodyFields(plan)
        assertEquals(setOf("name", "scratch"), fields.keys)
        assertEquals(true, fields["scratch"])
        assertFalse("勾了临时目录就不许带 cwd", fields.containsKey("cwd"))
    }

    @Test
    fun `typed server cwd is trimmed and sent as cwd only`() {
        val plan = CreateProtocol.plan("  名字  ", "  /srv/work/x  ", scratch = false)
        val fields = CreateProtocol.bodyFields(plan)
        assertEquals(setOf("name", "cwd"), fields.keys)
        assertEquals("名字", fields["name"])
        assertEquals("/srv/work/x", fields["cwd"])
        assertFalse(fields.containsKey("scratch"))
    }

    @Test
    fun `name only leaves the directory to the server`() {
        val fields = CreateProtocol.bodyFields(CreateProtocol.plan("只有名字", "", scratch = false))
        assertEquals(setOf("name"), fields.keys)
        assertEquals("只有名字", fields["name"])
    }

    // ───────────────────────────── 返回码 ─────────────────────────────

    @Test
    fun `only 2xx is http success - and success still needs the entity`() {
        assertEquals(CreateProtocol.Status.SUCCESS, CreateProtocol.classify(201, null))
        assertEquals(CreateProtocol.Status.SUCCESS, CreateProtocol.classify(200, null))
        // 2xx 只是 HTTP 层说成功：`SophoApi` 还要求回执里解出 `id` 才算“已建”。
        // 所以这里**不存在**一个叫 CREATED 的分类（那样就会把 2xx 直接当成“已建”）。
    }

    @Test
    fun `only the three pre-create codes may be called a definite rejection`() {
        // server/base-logic.mjs:8731-8733 —— 这三个在 queueSessionCreate/withSession 之前就抛。
        assertEquals(CreateProtocol.Status.REJECTED, CreateProtocol.classify(400, "invalid_scratch"))
        assertEquals(CreateProtocol.Status.REJECTED, CreateProtocol.classify(400, "invalid_session_location"))
        assertEquals(CreateProtocol.Status.REJECTED, CreateProtocol.classify(400, "invalid_cwd"))
    }

    @Test
    fun `every other 4xx is conservatively unknown - not a retryable rejection`() {
        // `invalid_name` 是在 withSession(create:true) **建完之后**才抛的 ⇒ 不许说“确定没建”。
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(400, "invalid_name"))
        // 读不出 error（代理/网关/中间人换过的响应）⇒ 不知道。
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(400, null))
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(409, "session_streaming"))
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(404, "not_found"))
        // 408 长着 4xx 的脸，也可能是网关超时 ⇒ 即使带了那三个码之一也不算“确定拒”。
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(408, "invalid_cwd"))
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(302, null))
    }

    @Test
    fun `5xx is uncertain - the session may already exist`() {
        // 服务端是**建完之后**才写名字/placement 的 ⇒ 报错之前会话可能已经存在 ⇒ 不许说“没建成”。
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(500, null))
        assertEquals(CreateProtocol.Status.UNCERTAIN, CreateProtocol.classify(503, "upstream unavailable"))
    }

    // ───────────────────────────── 回执 ─────────────────────────────

    @Test
    fun `created receipt names the server-returned cwd and says no task was sent`() {
        val plan = CreateProtocol.plan("名字", "/srv/work/x", scratch = false)
        val text = CreateProtocol.createdText(plan, CreateOutcome.Created(201, created))
        assertTrue(text.contains("已创建"))
        assertTrue(text.contains("HTTP 201"))
        assertTrue(text.contains("/srv/work/tmp-1b2c")) // 服务端回的那个目录
        assertTrue(text.contains("1b2c3d4e")) // 短 id（前 8 位）
        assertTrue("必须写明只建了空会话、没发任务", text.contains("没有"))
        assertTrue(text.contains("空会话"))
        // 反面：不许把这句写成“模型已回答”
        assertFalse(text.contains("已回答》"))
        assertFalse(text.contains("模型回答："))
    }

    @Test
    fun `scratch receipt says the server made the directory`() {
        val text = CreateProtocol.createdText(
            CreateProtocol.plan("", "", scratch = true),
            CreateOutcome.Created(201, created.copy(scratch = true)),
        )
        assertTrue(text.contains("服务器临时目录"))
    }

    @Test
    fun `placement failure is reported as already-created and must not be retried`() {
        val text = CreateProtocol.createdText(
            CreateProtocol.plan("", "", scratch = true),
            CreateOutcome.Created(
                201,
                created.copy(placementPersisted = false, warningMessage = "placement write failed"),
            ),
        )
        assertTrue("必须说清会话已经建出来了", text.contains("已经建出来了"))
        assertTrue("必须点名不要重试", text.contains("不要重试创建"))
        assertTrue("服务端 warning 原话要带上", text.contains("placement write failed"))
    }

    @Test
    fun `odd status with a session in the body is still worded as already created`() {
        // 契约上 201 才正常；但只要回执里已经有这条会话（id），就不许让用户再建一次。
        val text = CreateProtocol.createdText(
            CreateProtocol.plan("", "", scratch = true),
            CreateOutcome.Created(500, created),
        )
        assertTrue("必须说清已经建出来了：$text", text.contains("已经建出来了"))
        assertTrue("必须点名不要重建：$text", text.contains("不要重建"))
        assertTrue("也要如实报状态码：$text", text.contains("HTTP 状态码是 500"))
    }

    @Test
    fun `rejected receipt says definitely not created and keeps the input`() {
        val outcome = CreateOutcome.Rejected(400, "invalid_cwd", "cwd must be a string or null", "…")
        val text = CreateProtocol.failureText(outcome)
        assertTrue(text.contains("没有建成"))
        assertTrue(text.contains("确定"))
        assertTrue(text.contains("HTTP 400"))
        assertTrue(text.contains("invalid_cwd"))
        assertTrue("要把服务端的原因上屏", text.contains("cwd must be a string or null"))
        assertTrue(text.contains("不会自动重发"))
        assertTrue(text.contains("你填的内容都还在"))
        assertTrue("失败要保留输入", CreateProtocol.keepsInput(outcome))
    }

    @Test
    fun `uncertain and unknown receipts forbid auto resend and point at the list`() {
        for (outcome in listOf(
            CreateOutcome.Uncertain(500, "internal_error", "boom"),
            CreateOutcome.Uncertain(408, null, "timeout"),
            CreateOutcome.Unknown,
        )) {
            val text = CreateProtocol.failureText(outcome)
            assertTrue("$text", text.contains("不自动重发"))
            assertTrue("$text", text.contains("刷新"))
            assertTrue("$text", text.contains("你填的内容都还在"))
            assertTrue(CreateProtocol.keepsInput(outcome))
        }
        assertTrue(CreateProtocol.failureText(CreateOutcome.Uncertain(500, null, "")).contains("不确定"))
        assertTrue(CreateProtocol.failureText(CreateOutcome.Unknown).contains("未知"))
    }

    @Test
    fun `created does not keep the input - success clears the form`() {
        assertFalse(CreateProtocol.keepsInput(CreateOutcome.Created(201, created)))
    }
}
