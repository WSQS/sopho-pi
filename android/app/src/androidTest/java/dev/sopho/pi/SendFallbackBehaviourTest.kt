package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 业主反馈「发送时会话在跑返回 409 而不是入队」的行为证据：真实 Context/Prefs/AppState/OkHttp，
 * 只把服务端换成本进程内的 [FakeServer]（`127.0.0.1` 临时端口）。
 *
 * 这一组钉住的是**竞态兜底的边界**，不是“所有 409 都解决”：
 * - 闲/忙判断与真实状态错开一格时，**同一次点击内至多切一次**路（message→steer / steer→message）；
 * - 准入窗口（两条路都 409 `session_streaming`）与压缩（`session_compacting`）**不切、不重发**，草稿保留；
 * - 斜杠形状从不走 steer（`/steer` 会先被 `rejectStreamingCommand` 拒），只在 message 上如实失败；
 * - 5xx/无有效 accept 回执/超时都**不算已接受**，不切路、不重发；
 * - 连点与切会话/迟到回执仍按 `sending` ＋ generation 隔离。
 *
 * **没打到真实服务器**：一次真实 POST 都没有（授权实现 ≠ 授权在生产里写）。
 */
@RunWith(AndroidJUnit4::class)
class SendFallbackBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    private val idleId = "11111111-1111-4111-8111-111111111111"
    private val busyId = "33333333-3333-4333-8333-333333333333"

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun tearDown() {
        created.forEach { state -> runCatching { onMain { state.close() } } }
        created.clear()
        prefs().edit().clear().commit()
    }

    // ───────── ① 客户端以为闲、服务端其实在跑：message 409 → steer 一次 ─────────

    /**
     * 会失败的理由：不做兜底 ⇒ 用户只看到“会话正在跑”的 409；若兜底做成循环或重发 ⇒ POST 计数超过 2；
     * 若切路后仍按原草稿清空条件之外乱清 ⇒ 用户新打的字被吞。
     */
    @Test
    fun idleSseButServerStreamingFallsBackToSteerOnceAndClearsDraft() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(idleId, "闲会话"))
            server.messageBodies[idleId] = FakeServer.messages("assistant" to "旧正文")
            // 客户端按 /message 发（SSE 说闲），服务端此刻其实在跑；steer 才接得住。
            server.routeStatus["message"] = 409
            server.routeBody["message"] = FakeServer.conflict("session_streaming")
            server.routeStatus["steer"] = 202
            server.routeBody["steer"] = FakeServer.acceptedSteer()

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { snap(state).toString() + serverLog(server) }) { state.messages.isNotEmpty() }

            onMain { state.onDraftChange("竞态这一句") }
            onMain { state.send() }
            assertEquals("点下去就进在途态（连点据此被挡）", true, snap(state).sending)
            waitFor("这一发（含一次切路）结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals(
                "先 message、被入队前 409 后**只**切一次 steer：${server.postCalls}",
                listOf("message", "steer"),
                server.postCalls.toList(),
            )
            assertEquals(
                "切路只换路由，不换那句话（body 只有 {text}）",
                listOf("message" to "竞态这一句", "steer" to "竞态这一句"),
                server.postBodies.map { (route, body) -> route to JSONObject(body).optString("text") },
            )
            val end = snap(state)
            assertEquals("最终是 accepted ⇒ 成功色", AppState.ReceiptTone.OK, end.sendTone)
            assertTrue("回执要说清已接受与实际走的路由：${end.receipt}", end.receipt!!.contains("已接受"))
            assertTrue("要说清是 steer 接住的：${end.receipt}", end.receipt.contains("插话（steer）"))
            assertTrue("要如实说第一发 409 没入队：${end.receipt}", end.receipt.contains("409 session_streaming"))
            assertTrue("要写明只切了这一次：${end.receipt}", end.receipt.contains("只切了这一次"))
            assertEquals("有效 accept 回执且草稿未变 ⇒ 才清空", "", end.draft)
        }
    }

    // ───────── ② 客户端以为忙、服务端其实已闲：steer 409 → message 一次 ─────────

    @Test
    fun busySseButServerIdleFallsBackToMessageOnceAndClearsDraft() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(busyId, "忙会话", status = "working"))
            server.messageBodies[busyId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["steer"] = 409
            server.routeBody["steer"] = FakeServer.conflict("session_not_streaming")
            server.routeStatus["message"] = 202
            server.routeBody["message"] = FakeServer.acceptedMessage()

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { snap(state).toString() + serverLog(server) }) { state.messages.isNotEmpty() }
            assertTrue("列表说 working ⇒ 客户端应选 steer", snap(state).agentBusy)

            onMain { state.onDraftChange("已经结束了") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals(
                "先 steer、被入队前 409 后**只**切一次 message：${server.postCalls}",
                listOf("steer", "message"),
                server.postCalls.toList(),
            )
            val end = snap(state)
            assertEquals(AppState.ReceiptTone.OK, end.sendTone)
            assertTrue("回执点明最终是普通消息：${end.receipt}", end.receipt!!.contains("普通消息"))
            assertTrue("要如实说第一发 409 没入队：${end.receipt}", end.receipt.contains("409 session_not_streaming"))
            assertTrue(end.receipt.contains("只切了这一次"))
            assertEquals("", end.draft)
        }
    }

    // ───────── ③ 准入窗口：两条路都 409 session_streaming ⇒ 第二次就停、保草稿 ─────────

    /**
     * 会失败的理由：把 `session_streaming` 当成“任何路由都能重试” ⇒ 会在两条路之间来回切／重发；
     * 或把这种情况回执成“已发送/排队”。这里 HTTP 面**没有**等价的入队路径，必须如实说没发出去。
     */
    @Test
    fun admissionWindowBoth409StopsAfterOneSwitchAndKeepsDraft() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(idleId, "准入窗口"))
            server.messageBodies[idleId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["message"] = 409
            server.routeBody["message"] = FakeServer.conflict("session_streaming")
            server.routeStatus["steer"] = 409
            server.routeBody["steer"] = FakeServer.conflict("session_streaming")

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { screenDiag(state) + serverLog(server) }) { state.messages.isNotEmpty() }

            onMain { state.onDraftChange("准入窗口那句") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals(
                "message → steer 各一次就停（不循环、不第三次）：${server.postCalls}",
                listOf("message", "steer"),
                server.postCalls.toList(),
            )
            val end = snap(state)
            assertEquals("这句确实没入队 ⇒ 错误色", AppState.ReceiptTone.ERROR, end.sendTone)
            assertTrue("回执要写 session_streaming：${end.receipt}", end.receipt!!.contains("session_streaming"))
            assertTrue("要写“没有发出去”：${end.receipt}", end.receipt.contains("没有"))
            assertEquals("失败/未入队 ⇒ 草稿一个字不丢", "准入窗口那句", end.draft)
        }
    }

    // ───────── ④ 压缩：没有可投递的路 ⇒ 不切、不重发、保草稿 ─────────

    @Test
    fun compactionDoesNotSwitchOrResendAndKeepsDraft() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(idleId, "压缩中"))
            server.messageBodies[idleId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["message"] = 409
            server.routeBody["message"] = FakeServer.conflict("session_compacting")
            // 若客户端错误地切到 steer，它会“成功” —— 用它当反证：必须一次都不打到 steer。
            server.routeStatus["steer"] = 202
            server.routeBody["steer"] = FakeServer.acceptedSteer()

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { screenDiag(state) + serverLog(server) }) { state.messages.isNotEmpty() }

            onMain { state.onDraftChange("压缩时这句") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals("压缩时一次都不许切到 steer：${server.postCalls}", listOf("message"), server.postCalls.toList())
            val end = snap(state)
            assertEquals(AppState.ReceiptTone.ERROR, end.sendTone)
            assertTrue("${end.receipt}", end.receipt!!.contains("session_compacting"))
            assertTrue("要写“既没有发送也没有排队”：${end.receipt}", end.receipt.contains("没有发送也没有排队"))
            assertEquals("压缩未入队 ⇒ 草稿保留", "压缩时这句", end.draft)
        }
    }

    // ───────── ⑤ 斜杠形状：忙也不走 steer；只如实失败 ─────────

    /**
     * 会失败的理由：把 `/model`、`/compact` 这类命令当普通文本补发到 `/steer` ⇒ 服务端
     * `rejectStreamingCommand()` 先 409 `command_while_streaming`（`/steer`/`/follow-up` 都会），
     * 客户端若再报“已接受”就是假成功。命令的语义闸由命令面板那条线负责；这里只钉形状。
     *
     * ⚠️ 2026-10-25 集成补充（断言本身未改）：命令清单**未加载**时手敲斜杠，客户端会**先按需拉一次**
     * `/commands` 再用真清单判（切会话/切配置后迟到的结果不落；拉不到才保稿拦下）。本用例的假服务端提供了
     * 一份（空的）清单 ⇒ `/model` **不在清单里** ⇒ 按既有无猜策略当普通文本走 message，所以下面的
     * “只许打在 message 上”仍成立。清单**拉不到**那一支由 `CommandLazyListBehaviourTest` 钉住（0 POST、保稿）。
     */
    @Test
    fun slashCommandShapeNeverGoesToSteerEvenOnABusySession() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(busyId, "忙会话", status = "working"))
            server.messageBodies[busyId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["message"] = 409
            server.routeBody["message"] = FakeServer.conflict("command_while_streaming")
            server.routeStatus["steer"] = 202
            server.routeBody["steer"] = FakeServer.acceptedSteer()

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { screenDiag(state) + serverLog(server) }) { state.messages.isNotEmpty() }
            assertTrue("会话是忙的（若按忙闲选择就会走 steer）", snap(state).agentBusy)

            onMain { state.onDraftChange("/model gpt-5") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals("命令形状只许打在 message 上，绝不补发 steer：${server.postCalls}", listOf("message"), server.postCalls.toList())
            val end = snap(state)
            assertEquals(AppState.ReceiptTone.ERROR, end.sendTone)
            assertTrue("回执要写 command_while_streaming：${end.receipt}", end.receipt!!.contains("command_while_streaming"))
            assertTrue("要写“不能插话也不能排队”：${end.receipt}", end.receipt.contains("不能插话也不能排队"))
            assertEquals("命令没发出去 ⇒ 草稿保留", "/model gpt-5", end.draft)
        }
    }

    // ───────── ⑥ 5xx / 无效 accept 回执：不确定，不切路、不重发 ─────────

    @Test
    fun serverErrorAndInvalidAcceptReceiptNeverSwitchOrResend() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(idleId, "服务端报错"))
            server.messageBodies[idleId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["message"] = 500
            server.routeBody["message"] = """{"error":"internal_error"}"""
            server.routeStatus["steer"] = 202
            server.routeBody["steer"] = FakeServer.acceptedSteer()

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { screenDiag(state) + serverLog(server) }) { state.messages.isNotEmpty() }

            onMain { state.onDraftChange("500 这句") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals("5xx 不知道有没有入队 ⇒ 不切、不重发：${server.postCalls}", listOf("message"), server.postCalls.toList())
            val end = snap(state)
            assertEquals(AppState.ReceiptTone.WARN, end.sendTone)
            assertTrue("${end.receipt}", end.receipt!!.contains("不确定"))
            assertTrue("${end.receipt}", end.receipt.contains("不自动重发"))
            assertEquals("不确定 ⇒ 草稿保留", "500 这句", end.draft)
        }
    }

    /**
     * 2xx 但回执没有 `sessionId`/`accepted:true`：**不许**只凭状态码当已接受（更不能吞草稿）。
     */
    @Test
    fun successStatusWithoutAValidAcceptReceiptKeepsDraft() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(idleId, "回执读不懂"))
            server.messageBodies[idleId] = FakeServer.messages("assistant" to "旧正文")
            server.routeStatus["message"] = 202
            server.routeBody["message"] = """{"ok":true}"""

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first()) }
            waitFor("正文到了", diag = { screenDiag(state) + serverLog(server) }) { state.messages.isNotEmpty() }

            onMain { state.onDraftChange("回执不清") }
            onMain { state.send() }
            waitFor("这一发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(server) }) { !state.sending }

            assertEquals("不确定就不许再切一次路：${server.postCalls}", listOf("message"), server.postCalls.toList())
            val end = snap(state)
            assertEquals(AppState.ReceiptTone.WARN, end.sendTone)
            assertTrue("${end.receipt}", end.receipt!!.contains("不确定"))
            assertEquals("没有有效 accept 回执 ⇒ 草稿保留", "回执不清", end.draft)
        }
    }

    // ───────── ⑦ 连点 / 在途切配置 / 离开详情：不重复发，迟到回执不上屏 ─────────

    /**
     * 会失败的理由：切路那一发（steer）还挂着时连点 ⇒ 若 `sending` 没盖住兜底段就会多打；切配置若不被拒，
     * 回执照样落到另一条配置的界面；离开详情后若仍继续切路，第二发会打到已经离开的会话上。
     */
    @Test
    fun duplicateTapsAndLeavingDetailDuringFallbackDoNotSendAgain() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(idleId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(idleId, "B 的会话"))
                a.messageBodies[idleId] = FakeServer.messages("assistant" to "A 的正文")
                b.messageBodies[idleId] = FakeServer.messages("assistant" to "B 的正文")
                a.routeStatus["message"] = 409
                a.routeBody["message"] = FakeServer.conflict("session_streaming")
                a.routeStatus["steer"] = 202
                a.routeBody["steer"] = FakeServer.acceptedSteer()
                a.routeDelayMs["steer"] = 3000 // 第二发挂在半路，给连点/切配置/离开详情留窗口

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)
                selectByName(state, "配置 A")
                onMain { state.connect() }
                waitFor("A 连上", diag = { serverLog(a) }) { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("A 的正文到了", diag = { screenDiag(state) + serverLog(a) }) { state.messages.isNotEmpty() }

                onMain { state.onDraftChange("连点这一句") }
                onMain { state.send() }
                waitFor("第一发已经回来、第二发（steer）正挂着", diag = { serverLog(a) + snap(state).toString() }) {
                    a.postCalls.toList() == listOf("message", "steer")
                }

                // 连点：sending 盖住整段（含兜底那一发）
                onMain { state.send() }
                assertEquals("连点不许再发：${a.postCalls}", listOf("message", "steer"), a.postCalls.toList())

                // 在途切配置：被拒，且不落盘/不改选中
                val rawBefore = prefs().getString("profilesRaw", null)
                val idB = snap(state).profiles.first { it.name == "配置 B" }.id
                onMain { state.selectProfile(idB) }
                val during = snap(state)
                assertNotNull("发送在途时切配置要被拒绝并说明原因", during.profileError)
                assertEquals("被拒绝的切换不许改选中", "配置 A", during.profileName)
                assertEquals("被拒绝的切换不许落盘", rawBefore, prefs().getString("profilesRaw", null))

                // 离开详情：归属换代 ⇒ 第二发已落地但回执不许上屏；也不许再补发第三发
                onMain { state.backToList() }
                assertEquals(Screen.LIST, snap(state).screen)
                waitFor("第二发结束", timeoutMs = 15_000, diag = { snap(state).toString() + serverLog(a) }) { !state.sending }

                assertEquals("全程只有一发点击 = 两发请求：${a.postCalls}", listOf("message", "steer"), a.postCalls.toList())
                assertNull("离开详情后的迟到回执不许上屏", snap(state).receipt)
                // 草稿按会话留在 A 上；回到这条会话应当还在（失败/未知一律保留）
                onMain { state.open(state.sessions.first()) }
                waitFor("重新打开 A 的正文", diag = { screenDiag(state) + serverLog(a) }) { state.messages.isNotEmpty() }
                assertEquals("草稿仍在这条会话上", "连点这一句", snap(state).draft)
            }
        }
    }

    // ───────────────────────────── 测试辅助 ─────────────────────────────

    private data class Snap(
        val screen: Screen,
        val profiles: List<Profile>,
        val profileName: String?,
        val currentId: String?,
        val agentBusy: Boolean,
        val sending: Boolean,
        val receipt: String?,
        val sendTone: AppState.ReceiptTone,
        val draft: String,
        val profileError: String?,
    )

    private fun snap(state: AppState): Snap = onMain {
        Snap(
            screen = state.screen,
            profiles = state.profiles,
            profileName = state.selected?.name,
            currentId = state.current?.id,
            agentBusy = state.agentBusy,
            sending = state.sending,
            receipt = state.sendReceipt,
            sendTone = state.sendReceiptTone,
            draft = state.draft,
            profileError = state.profileError,
        )
    }

    private fun screenDiag(state: AppState): String = onMain {
        " screen=${state.screen} current=${state.current?.id} sending=${state.sending} draft=${state.draft} detailError=${state.detailError}"
    }

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun newState(): AppState {
        var state: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { state = AppState(app) }
        return state!!.also { created += it }
    }

    private fun waitFor(
        what: String,
        timeoutMs: Long = 10_000,
        diag: () -> String = { "" },
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        fail("等不到：$what（${timeoutMs} ms 超时）${runCatching { diag() }.getOrDefault("")}")
    }

    private fun saveProfile(state: AppState, name: String, url: String) {
        onMain {
            state.newProfile()
            state.draftUpdate { it.copy(name = name, serverUrl = url) }
            state.saveDraft()
        }
        assertEquals("保存并选中「$name」", name, snap(state).profileName)
    }

    private fun selectByName(state: AppState, name: String) {
        val id = snap(state).profiles.first { it.name == name }.id
        onMain { state.selectProfile(id) }
        assertEquals("点了「$name」就该切过去", name, snap(state).profileName)
    }

    private fun serverLog(server: FakeServer): String =
        " [server ${server.label}@${server.port}] tree=${server.treeGets.get()} posts=${server.postCalls}"
}
