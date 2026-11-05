package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.fail

/**
 * 「命令清单**还没拿到**时手敲一条斜杠命令」这条路的**行为证据**（真 Context／Prefs／AppState／OkHttp，
 * 只把服务端换成本进程内的 [FakeServer]）。
 *
 * 背景：命令清单只在打开命令页时拉，但用户完全可能**从没打开过命令页**就直接敲 `/review`。旧做法是一律拦住
 * （回执让用户"把 / 去掉"），这会让常见命令与 `/tmp 是空的` 这类路径都没法直接发。现在的口径是
 * **为这一次点击按需拉一次清单**，然后按真清单判：
 *
 * - 拉到且**注册过**（`via=prompt`）⇒ 照常按 message 发出去（命令名不当普通文本猜，走服务端真 via）；
 * - 拉到但 `via=model|compact` ⇒ 走专用入口（模型页/压缩确认），**不发文本**；
 * - **拉不到** ⇒ 一句都不发（0 POST）、草稿保留、让用户手动重试 —— **绝不**退化成"当普通文本发"；
 * - 切会话/切配置之后迟到的清单结果**不落**（不会把命令发到别的会话/配置上）；
 * - 每个点击**最多一次** `GET /commands`，且**不**自动重发 POST。
 *
 * 这一组**不碰**真实服务端（一次真实 POST 都没有）。
 */
@RunWith(AndroidJUnit4::class)
class CommandLazyListBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

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

    // ───────── ① 从没打开过命令页：/review 注册过（via=prompt）⇒ 拉一次清单后按 message 发出去 ─────────

    @Test
    fun neverOpenedPanelSendsRegisteredPromptCommandAfterOneLazyFetch() {
        val sid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
        FakeServer("lazy-ok").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sid, "会话 A"))
            server.messageBodies[sid] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            server.routeStatus["message"] = 202
            server.routeBody["message"] = FakeServer.acceptedMessage()

            val state = openSession(server, "会话 A")
            assertEquals("进详情页不许预取清单", 0, server.commandGets.get())

            onMain { state.onDraftChange("/review src/App.kt") }
            onMain { state.send() }
            waitFor("这一发结束（含一次按需拉清单）", timeoutMs = 15_000, diag = { snap(state) + serverLog(server) }) {
                state.sendReceipt?.contains("已接受") == true
            }

            assertEquals("只为这一次点击拉**一次**清单", 1, server.commandGets.get())
            assertEquals(
                "注册过、via=prompt ⇒ 照常按 message 发（不猜、不走 steer）：${server.postCalls}",
                listOf("message"),
                server.postCalls.toList(),
            )
            assertEquals("接受了才清草稿", "", onMain { state.draft })
            assertTrue(
                "回执照实说“已接受”（不是“已执行”）：${onMain { state.sendReceipt }}",
                onMain { state.sendReceipt }!!.contains("已接受"),
            )
        }
    }

    // ───────── ② 清单拉不到：一句都不发、草稿保留、让用户手动重试（绝不降级为普通文本）─────────

    @Test
    fun failedLazyFetchKeepsDraftAndPostsNothing() {
        val sid = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"
        FakeServer("lazy-fail").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sid, "会话 A"))
            server.messageBodies[sid] = FakeServer.messages("user" to "你好")
            server.commandsStatus = 500
            server.commandsBody = """{"error":"internal_error","message":"boom"}"""

            val state = openSession(server, "会话 A")
            onMain { state.onDraftChange("/review src/App.kt") }
            onMain { state.send() }
            waitFor("拦下来了", timeoutMs = 15_000, diag = { snap(state) + serverLog(server) }) {
                state.sendReceipt?.contains("没有发出去") == true
            }

            assertEquals("拉不到清单 ⇒ 一个 POST 都没有", 0, server.postCalls.size)
            assertEquals("只拉了那一次（不循环、不自动重试）", 1, server.commandGets.get())
            assertEquals("草稿保留", "/review src/App.kt", onMain { state.draft })
            val receipt = onMain { state.sendReceipt }!!
            assertTrue("回执要给出可操作的重试路径：$receipt", receipt.contains("重试"))
            assertTrue("回执要写明没有 POST/不会自动重发：$receipt", receipt.contains("没有 POST"))
            assertTrue(
                "**不许**出现“当普通文本发”这种降级话术：$receipt",
                !receipt.contains("当普通文本") && !receipt.contains("按普通消息"),
            )
            assertEquals("回执是警示色（不是“确定失败”，因为清单可能只是暂时拿不到）", AppState.ReceiptTone.WARN, onMain { state.sendReceiptTone })
        }
    }

    // ───────── ③ 按需拉清单的“在途”阶段：别人不得半路换配置；换走之后迟到的结果不落、不发 ─────────

    @Test
    fun inflightLazyFetchBlocksProfileSwitchAndLateResultDoesNotSend() {
        val sidA = "cccccccc-1111-4111-8111-cccccccccccc"
        val sidB = "dddddddd-1111-4111-8111-dddddddddddd"
        FakeServer("lazy-late").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"), FakeServer.row(sidB, "会话 B"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "A 的正文")
            server.messageBodies[sidB] = FakeServer.messages("user" to "B 的正文")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            server.commandsDelayMs = 600
            server.routeBody["message"] = FakeServer.acceptedMessage()

            val state = newState()
            onMain {
                state.newProfile()
                state.draftUpdate { it.copy(name = "甲", serverUrl = server.baseUrl) }
                state.saveDraft()
            }
            onMain {
                state.newProfile()
                state.draftUpdate { it.copy(name = "乙", serverUrl = "http://127.0.0.1:9") }
                state.saveDraft()
            }
            onMain { state.selectProfile(state.profiles.first { it.name == "甲" }.id) }
            onMain { state.connect() }
            waitFor("连上（进列表）") { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first { it.id == sidA }) }
            waitFor("进入详情 A") { state.screen == Screen.DETAIL }

            onMain { state.onDraftChange("/review src/App.kt") }
            onMain { state.send() }
            // 拉清单在途（600 ms）——这一段也算“这一发还没结果”。
            waitFor("按需拉取已发出", timeoutMs = 5_000, diag = { snap(state) + serverLog(server) }) {
                server.commandGets.get() == 1
            }
            assertEquals("按需拉清单在途时就该占住在途位", true, onMain { state.sending })

            // ① 别人不得在“在途”时换配置（既有采用项：发送在途禁止切配置，不假装 cancel 网络 = 没发送）。
            onMain { state.selectProfile(state.profiles.first { it.name == "乙" }.id) }
            assertEquals("切配置被拒：仍停在甲", "甲", onMain { state.selectedProfileName })
            assertTrue(
                "要如实说“这一发还没结果，先等它”：${onMain { state.profileError }}",
                (onMain { state.profileError } ?: "").contains("还没有结果"),
            )

            // ② 真的换走（退列表 —— 细节页的 generation 变了）⇒ 迟到的清单结果不落、不发。
            onMain { state.backToList() }
            waitFor("回到列表") { state.screen == Screen.LIST }
            Thread.sleep(1_200)
            assertEquals("换走之后**不许**发任何 POST：${server.postCalls}", 0, server.postCalls.size)
            assertNull("迟到的清单不落到列表界面", onMain { state.commandSnapshot })
            assertEquals("也不该把那一刻的草稿当成“已发送”清掉", "/review src/App.kt", onMain { state.draft })
        }
    }

    // ───────── 小工具（与其它行为用例同一套）─────────

    private fun commandsBody(commands: String): String =
        """{"sessionId":"{{sid}}","streaming":false,"compacting":false,"canRun":true,""" +
            """"builtinError":null,"builtinHow":"/pi/dist/core/slash-commands.js","commands":$commands}"""

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun newState(): AppState {
        var state: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { state = AppState(app) }
        return state!!.also { created += it }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun waitFor(what: String, timeoutMs: Long = 10_000, diag: () -> String = { "" }, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        fail("等不到：$what（${timeoutMs} ms 超时）${runCatching { diag() }.getOrDefault("")}")
    }

    private fun openSession(server: FakeServer, name: String): AppState {
        val fresh = newState()
        onMain {
            fresh.newProfile()
            fresh.draftUpdate { it.copy(name = "惰性清单配置", serverUrl = server.baseUrl) }
            fresh.saveDraft()
        }
        onMain { fresh.connect() }
        waitFor("连上（进列表）") { fresh.screen == Screen.LIST }
        onMain { fresh.open(fresh.sessions.first { it.displayName == name }) }
        waitFor("进入详情") { fresh.screen == Screen.DETAIL }
        return fresh
    }

    private fun snap(state: AppState): String = "screen=${state.screen} sending=${state.sending} " +
        "receipt=${state.sendReceipt} tone=${state.sendReceiptTone} draft=${state.draft} " +
        "catalog=${state.commandSnapshot != null} loading=${state.commandsLoading}"

    private fun serverLog(server: FakeServer): String =
        " commandGets=${server.commandGets.get()} postCalls=${server.postCalls}"

    private companion object {
        /** 只保留这条测试需要的那几条：`review`（via=prompt，可执行）、`model`、`compact`、`settings`（不可执行）。 */
        private const val COMMANDS_MIN = """[
          {"name":"review","description":"审查代码改动","source":"prompt","argumentHint":"<path>","path":"/p/review.md",
           "builtin":false,"runnable":true,"reason":null,"tag":null,"via":"prompt","hint":null,"shadowed":null},
          {"name":"settings","description":"多项设置","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":false,"reason":"TUI 专用。","tag":"TUI 专用",
           "uiEntry":null,"via":null,"hint":null,"shadowed":null},
          {"name":"compact","description":"压缩本会话的上下文","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"compact",
           "hint":"发 /compact，网页会调用这条会话的压缩入口。","shadowed":null},
          {"name":"model","description":"切换本会话使用的模型","source":"builtin","argumentHint":"<provider/model>","path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"model",
           "hint":null,"shadowed":null}
        ]"""
    }
}
