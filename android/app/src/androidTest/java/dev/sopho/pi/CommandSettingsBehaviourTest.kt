package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 命令清单 / 模型与思考这条线的**行为**证据：真 `AppState` ＋ 真 Prefs ＋ 真 OkHttp/TCP，
 * 只把服务端换成同进程内的 [FakeServer]。断言看**服务端侧计数**（收到几次 GET/POST、请求体原文）
 * 与 `AppState` 的状态，不看客户端的自述。
 *
 * 会失败的理由（每条对着一件真事）：
 * - 详情页预取 `/commands` ⇒ `commandGets` 在打开命令页之前就不是 0（会给冷会话建 runtime）；
 * - 点条目顺手发一条 POST ⇒ `postCalls` 里出现 `message`；
 * - 手敲 `/compact`、`/model` 当普通消息发 ⇒ 出现 `message`、却没有 `compact`/`model`；
 * - 清单拿不到时放行斜杠文本 ⇒ 那条“命令”被当 prompt 收下（假成功）；
 * - 切会话后不丢迟到结果 ⇒ 旧清单/旧回执落到新会话上；
 * - 写完不回读 ⇒ `actual*` 只跟着请求值走（分不清“写成了”与“以为写成了”）。
 */
@RunWith(AndroidJUnit4::class)
class CommandSettingsBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    private val sidA = "11111111-1111-4111-8111-111111111111"
    private val sidB = "22222222-2222-4222-8222-222222222222"

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

    // ───────────────────────── 命令清单 ─────────────────────────

    /**
     * `/commands` **只在打开命令页时**拉一次（详情页不预取）：打开详情后 `commandGets` 仍是 0，
     * 打开命令页才变 1。
     */
    @Test
    fun commandListIsFetchedOnlyWhenThePanelOpens() {
        FakeServer("cmdonly").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            val state = openSession(server, "会话 A")

            assertEquals("详情页不许预取命令清单（冷会话会建 runtime）", 0, server.commandGets.get())

            onMain { state.openCommandPanel() }
            waitFor("/commands 回来") { state.commandSnapshot != null }
            assertEquals("打开命令页只发一发", 1, server.commandGets.get())
            assertEquals(Panel.COMMANDS, onMain { state.panel })
            assertEquals("清单里 4 条都在（review/settings/compact/model）", 4, onMain { state.visibleCommands.size })
            assertEquals("一个写请求都没发", 0, server.postCalls.size)
        }
    }

    /** 点可填入的命令：只把 `/name ` 写进输入框、回到聊天、**一个请求都不发**。 */
    @Test
    fun choosingPromptCommandFillsDraftWithoutPosting() {
        FakeServer("cmdfill").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("清单到了") { state.commandSnapshot != null }
            val review = onMain { state.visibleCommands.first { it.name == "review" } }
            onMain { state.chooseCommand(review) }
            waitFor("草稿被填入") { state.draft == "/review " }
            assertNull("点条目后回到聊天（面板关掉）", onMain { state.panel })
            assertEquals("填入不是发送：一个 POST 都没有", 0, server.postCalls.size)
            assertTrue(onMain { state.sendReceipt ?: "" }.contains("没有发送"))
        }
    }

    /**
     * **手敲** `/compact`（不是从菜单点）也必须走专用语义：不发 `/message`，先要显式确认；
     * 确认后**恰好一次** `POST /compact`，body 里没有 instructions。
     */
    @Test
    fun typedCompactOpensConfirmationAndPostsCompactExactlyOnce() {
        FakeServer("cmdcompact").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            server.routeBody["compact"] = """{"accepted":true,"sessionId":"{{sessionId}}"}"""
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("清单到了") { state.commandSnapshot != null }
            onMain { state.closePanel() }

            onMain { state.onDraftChange("/compact") }
            onMain { state.send() }
            waitFor("打开确认框") { state.pendingCompact != null }
            assertEquals("没确认之前不发 compact", 0, server.postCalls.count { it == "compact" })
            assertEquals("也绝不当普通消息发", 0, server.postCalls.count { it == "message" })
            assertEquals("/compact 要跳到命令页确认", Panel.COMMANDS, onMain { state.panel })

            onMain { state.confirmCompact() }
            waitFor("compact 回执回来") { state.commandReceipt?.contains("已请求压缩") == true }
            assertEquals("只发一次 compact", 1, server.postCalls.count { it == "compact" })
            assertEquals("一次 message 都没有", 0, server.postCalls.count { it == "message" })
            assertEquals("body 里没有 instructions（用户没写说明）", "{}", server.postBodies.first { it.first == "compact" }.second)
            val receipt = onMain { state.commandReceipt ?: "" }
            assertTrue("202 只写“已请求”，不写“已压缩”：$receipt", receipt.contains("不是") || receipt.contains("没"))
            assertEquals("草稿保留（命令不消费草稿）", "/compact", onMain { state.draft })
        }
    }

    /** 手敲 `/model x` 也走专用路：打开模型页、不发 message；而且**不自动写入**。 */
    @Test
    fun typedModelOpensSettingsWithoutPostingMessageOrModel() {
        FakeServer("cmdmodel").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            server.modelsBody = modelsBody(current = "m/old", entries = MODELS_TWO)
            server.detailBody = detailBody(model = "m/old", thinking = "off")
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("清单到了") { state.commandSnapshot != null }
            onMain { state.closePanel() }

            onMain { state.onDraftChange("/model m/new") }
            onMain { state.send() }
            waitFor("打开模型页") { state.panel == Panel.SETTINGS }
            assertEquals("不发 message", 0, server.postCalls.count { it == "message" })
            assertEquals("点/敲一下不自动写模型", 0, server.postCalls.count { it == "model" })
            waitFor("模型目录到了") { state.modelCatalog != null }
            assertEquals("真值来自服务端回读", "m/old", onMain { state.actualModelRef })
            assertTrue(
                "回执说清没有当普通消息发",
                onMain { state.sendReceipt ?: "" }.contains("专用命令"),
            )
        }
    }

    /** `runnable=false` 的命令：**不发出去**，也不降级成普通消息；原因照服务端原话。 */
    @Test
    fun unavailableCommandIsNeitherSentNorDowngraded() {
        FakeServer("cmdunavail").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("清单到了") { state.commandSnapshot != null }
            onMain { state.closePanel() }

            onMain { state.onDraftChange("/settings") }
            onMain { state.send() }
            waitFor("回执上来") { state.sendReceipt != null }
            assertEquals("一个 POST 都没有", 0, server.postCalls.size)
            val receipt = onMain { state.sendReceipt ?: "" }
            assertTrue("说清不可执行并带服务端原因：$receipt", receipt.contains("不可执行") && receipt.contains("TUI 专用"))
            assertEquals("草稿保留", "/settings", onMain { state.draft })
        }
    }

    /**
     * 清单拿不到（`/commands` 500）时：斜杠文本被**拦住**（判不出是不是专用命令），
     * 但不带斜杠的普通文本照常发（清单缺失不该拦住聊天）。
     */
    @Test
    fun missingCommandListRefusesSlashButNotPlainText() {
        FakeServer("cmdmissing").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.commandsStatus = 500
            server.commandsBody = """{"error":"internal_error","message":"boom"}"""
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("错误上屏") { state.commandsError != null }
            assertTrue(onMain { state.commandsError ?: "" }.contains("命令清单拿不到"))
            assertNull("失败时不许把清单退化成空列表", onMain { state.commandSnapshot })
            onMain { state.closePanel() }

            onMain { state.onDraftChange("/model m/new") }
            onMain { state.send() }
            waitFor("斜杠被拦住") { state.sendReceipt != null }
            assertEquals("斜杠文本一个 POST 都没有", 0, server.postCalls.size)
            assertTrue(onMain { state.sendReceipt ?: "" }.contains("重试"))
            assertEquals("/model m/new", onMain { state.draft })

            // 普通文本不被拦：这是“清单未知”而不是“不许说话”。
            onMain { state.onDraftChange("帮我看看这个目录") }
            onMain { state.send() }
            waitFor("普通文本发出去了") { server.postCalls.count { it == "message" } == 1 }
            assertEquals("只有那一发普通消息", 1, server.postCalls.size)
        }
    }

    /** 切会话之后，旧会话迟到的 `/commands` 结果**不许**落到新会话上。 */
    @Test
    fun lateCommandListAfterSessionSwitchIsDropped() {
        FakeServer("cmdstale").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"), FakeServer.row(sidB, "会话 B"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "A 的正文")
            server.messageBodies[sidB] = FakeServer.messages("user" to "B 的正文")
            server.commandsBody = commandsBody(COMMANDS_MIN)
            server.commandsDelayMs = 1200
            val state = openSession(server, "会话 A")

            onMain { state.openCommandPanel() }
            waitFor("A 的 /commands 已经发出去（还挂着）") { server.commandGets.get() == 1 }
            assertNull("还没回来", onMain { state.commandSnapshot })

            // 还没等它回来就换会话（走产品路径：回列表 → 点 B）
            onMain { state.backToList() }
            waitFor("回到列表") { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first { it.id == sidB }) }
            waitFor("B 的正文到了") { state.messages.isNotEmpty() }

            Thread.sleep(2000) // 给 A 的迟到响应足够时间窗
            assertNull("A 的命令清单不许落到 B 上", onMain { state.commandSnapshot })
            assertNull(onMain { state.commandsError })
            assertEquals("B 并没有因此去拉 /commands", 1, server.commandGets.get())
            assertEquals("B 的正文还在", listOf("B 的正文"), onMain { state.messages.map { it.text } })
        }
    }

    // ───────────────────────── 通知（session.notice） ─────────────────────────

    /** `session.notice` 帧要上屏（以前落在 `else -> Unit` 里丢掉）；能逐条收起。 */
    @Test
    fun noticeFrameIsKeptAndDismissable() {
        FakeServer("notice").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            val state = openSession(server, "会话 A")
            waitFor("SSE 连上了") { server.hasStream(sidA) }

            assertTrue(
                "推一帧 session.notice",
                server.push(sidA, "session.notice", """{"level":"warn","text":"插件说：注意一下"}"""),
            )
            waitFor("通知进状态") { state.notices.isNotEmpty() }
            val notice = onMain { state.notices.single() }
            assertEquals("插件说：注意一下", notice.text)
            assertEquals("warn", notice.level)

            onMain { state.dismissNotice(notice.id) }
            assertTrue("收起之后就不在了", onMain { state.notices.isEmpty() })
        }
    }

    // ───────────────────────── 模型与思考（写 + 回读） ─────────────────────────

    /**
     * 换模型：**恰好一次** `POST /model`（body 只带 model），随后 `GET /sessions/{id}` 回读，
     * `actualModelRef` 用**回读值**（不是请求值）。
     */
    @Test
    fun modelWritePostsOnceThenReadsBackTheActualValue() {
        FakeServer("settings").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.modelsBody = modelsBody(current = "m/old", entries = MODELS_TWO)
            server.detailBody = detailBody(model = "m/old", thinking = "off")
            server.routeBody["model"] = """{"ok":true,"sessionId":"{{sessionId}}","model":"m/new","previous":"m/old",
                "thinkingLevel":"off","previousThinkingLevel":"off","thinkingLevels":["off","high"],
                "thinkingChanged":false,"matchedBy":"provider/id","persist":false}"""
            val state = openSession(server, "会话 A")

            onMain { state.openModelPanel() }
            // 等**服务端侧**真的收到那次详情回读（不能用“目录里的 current 到了”当证据：
            // 目录的 `current` 会先把 actualModelRef 抬上去，详情回读可能还没回来）。
            waitFor("模型目录 + 详情回读都到了") { state.modelCatalog != null && server.detailGets.size >= 1 }
            waitFor("回读值落到状态") { state.actualModelRef == "m/old" }
            val detailGetsWhenOpened = server.detailGets.size
            assertEquals("打开页只读一次详情", 1, detailGetsWhenOpened)

            onMain { state.selectDraftModel("m/new") }
            // 服务端此刻的真值：写完之后就是 m/new（回读要看到它）。
            server.detailBody = detailBody(model = "m/new", thinking = "off")
            onMain { state.applySettings() }
            waitFor("写完并回读") { state.settingsReceipt != null && !state.settingsBusy }

            assertEquals("只写一次", 1, server.postBodies.count { it.first == "model" })
            val body = server.postBodies.first { it.first == "model" }.second
            val parsed = org.json.JSONObject(body)
            assertEquals("只写 model 那一项", "m/new", parsed.getString("model"))
            assertFalse("body 不夹带 thinkingLevel", parsed.has("thinkingLevel"))
            assertEquals("写完再读一次详情", 2, server.detailGets.size)
            assertEquals("当前值取回读值", "m/new", onMain { state.actualModelRef })
            assertEquals("没有改动之后草案跟随真值", "m/new", onMain { state.draftModelRef })
            assertTrue(
                "回执里写明回读：${onMain { state.settingsReceipt }}",
                onMain { state.settingsReceipt ?: "" }.contains("回读"),
            )
        }
    }

    /**
     * 忙（409 `session_streaming`）：**不重试**，`actual*` 一个字不改，本地选择保留，回执说“没有写入”。
     */
    @Test
    fun busyRejectionKeepsDraftAndActualValue() {
        FakeServer("busy").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "你好")
            server.modelsBody = modelsBody(current = "m/old", entries = MODELS_TWO)
            server.detailBody = detailBody(model = "m/old", thinking = "off")
            server.routeStatus["model"] = 409
            server.routeBody["model"] = """{"error":"session_streaming","message":"fixture busy"}"""
            val state = openSession(server, "会话 A")

            onMain { state.openModelPanel() }
            waitFor("目录到了") { state.modelCatalog != null && state.actualThinkingLevel == "off" }

            onMain { state.selectDraftThinking("high") }
            onMain { state.applySettings() }
            waitFor("回执回来") { state.settingsReceipt != null && !state.settingsBusy }

            assertEquals("只发一次（不自动重试）", 1, server.postBodies.count { it.first == "model" })
            assertEquals("真值不变", "off", onMain { state.actualThinkingLevel })
            assertEquals("本地选择保留", "high", onMain { state.draftThinkingLevel })
            assertEquals(AppState.ReceiptTone.ERROR, onMain { state.settingsReceiptTone })
            val receipt = onMain { state.settingsReceipt ?: "" }
            assertTrue("说清没有写入：$receipt", receipt.contains("没有写入"))
            assertTrue("说清会话忙", receipt.contains("正忙"))
        }
    }

    /** 写请求还挂着就换会话：迟到回执**不许**落到新会话的状态上。 */
    @Test
    fun lateModelWriteAfterSessionSwitchIsDropped() {
        FakeServer("stale").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sidA, "会话 A"), FakeServer.row(sidB, "会话 B"))
            server.messageBodies[sidA] = FakeServer.messages("user" to "A")
            server.messageBodies[sidB] = FakeServer.messages("user" to "B")
            server.modelsBody = modelsBody(current = "m/old", entries = MODELS_TWO)
            server.detailBody = detailBody(model = "m/old", thinking = "off")
            server.routeBody["model"] = """{"ok":true,"sessionId":"{{sessionId}}","model":"m/new","previous":"m/old"}"""
            server.routeDelayMs["model"] = 1200
            val state = openSession(server, "会话 A")

            onMain { state.openModelPanel() }
            waitFor("目录到了") { state.modelCatalog != null }
            onMain { state.selectDraftModel("m/new") }
            onMain { state.applySettings() }
            waitFor("写请求发出去了") { server.postBodies.any { it.first == "model" } }

            onMain { state.backToList() }
            waitFor("回到列表") { state.screen == Screen.LIST }
            onMain { state.open(state.sessions.first { it.id == sidB }) }
            waitFor("B 的正文到了") { state.messages.isNotEmpty() }

            Thread.sleep(2000)
            assertNull("旧会话的写入回执不许落到 B 上", onMain { state.settingsReceipt })
            assertNull("B 的当前模型仍是“未读”", onMain { state.actualModelRef })
            assertEquals("B 的正文没被动过", listOf("B"), onMain { state.messages.map { it.text } })
            assertEquals("只有 A 那一发写", 1, server.postBodies.count { it.first == "model" })
        }
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun newState(): AppState {
        var created: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { created = AppState(app) }
        return created!!.also { state = it }
    }

    private var state: AppState? = null

    private fun waitFor(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        throw AssertionError("等不到：$what（${timeoutMs} ms 超时）")
    }

    /** 走产品路径连到假服务端（Profile → connect → 列表），再打开某一条会话。 */
    private fun openSession(server: FakeServer, name: String): AppState {
        val fresh = newState()
        onMain {
            fresh.newProfile()
            fresh.draftUpdate { it.copy(name = "命令线配置", serverUrl = server.baseUrl) }
            fresh.saveDraft()
        }
        onMain { fresh.connect() }
        waitFor("连上（进列表）") { fresh.screen == Screen.LIST }
        onMain { fresh.open(fresh.sessions.first { it.displayName == name }) }
        waitFor("进入详情") { fresh.screen == Screen.DETAIL }
        return fresh
    }

    companion object {
        /** 形状照真服务端：prompt 条目**没有** uiEntry；`settings` 是典型不可执行的内置命令。 */
        private const val COMMANDS_MIN = """[
          {"name":"review","description":"审查代码改动","source":"prompt","argumentHint":"<path>","path":"/p/review.md",
           "builtin":false,"runnable":true,"reason":null,"tag":null,"via":"prompt","hint":null,"shadowed":null},
          {"name":"settings","description":"多项设置","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":false,"reason":"TUI 专用（pi 的多项设置菜单）。","tag":"TUI 专用",
           "uiEntry":null,"via":null,"hint":null,"shadowed":null},
          {"name":"compact","description":"压缩本会话的上下文","source":"builtin","argumentHint":null,"path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"compact",
           "hint":"发 /compact，网页会调用这条会话的压缩入口。","shadowed":null},
          {"name":"model","description":"切换本会话使用的模型","source":"builtin","argumentHint":"<provider/model>","path":null,
           "builtin":true,"runnable":true,"reason":null,"tag":null,"uiEntry":null,"via":"model",
           "hint":"发 /model <provider/model>。","shadowed":null}
        ]"""

        private fun commandsBody(commands: String, streaming: Boolean = false, canRun: Boolean = true): String =
            """{"sessionId":"{{sid}}","streaming":$streaming,"compacting":false,"canRun":$canRun,""" +
                """"builtinError":null,"builtinHow":"/pi/dist/core/slash-commands.js","commands":$commands}"""

        private const val MODELS_TWO = """[
          {"provider":"m","id":"old","name":"Old","ref":"m/old","reasoning":true,"contextWindow":1000,
           "current":true,"input":["text"],"supportsImages":false,"thinkingLevels":["off","high"]},
          {"provider":"m","id":"new","name":"New","ref":"m/new","reasoning":true,"contextWindow":2000,
           "current":false,"input":["text","image"],"supportsImages":true,"thinkingLevels":["off","high"]}
        ]"""

        private fun modelsBody(current: String?, entries: String): String =
            """{"sessionId":"{{sid}}","hot":true,"error":null,"current":${if (current == null) "null" else "\"$current\""},""" +
                """"source":"scoped","thinking":{"current":"off","levels":["off","high"]},"models":$entries}"""

        private fun detailBody(model: String?, thinking: String?): String {
            val modelJson = if (model == null) {
                "null"
            } else {
                val provider = model.substringBefore('/')
                val id = model.substringAfter('/')
                """{"provider":"$provider","id":"$id"}"""
            }
            return """{"id":"{{sid}}","runtime":{"streaming":false,"model":$modelJson,"thinkingLevel":""" +
                (if (thinking == null) "null" else "\"$thinking\"") + "}}"
        }
    }
}
