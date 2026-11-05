package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 「新建会话」（B1）的**行为**证据：真实 Android Context ＋ 真 `SharedPreferences` ＋ 真 `AppState` ＋
 * 真 OkHttp/TCP，只把服务端换成同进程内的 [FakeServer]（绑 `127.0.0.1` 的临时端口）。
 *
 * 这一组要回答的是派单里那几条**行为**，不是“代码长什么样”：
 * 一次点击只出一个 POST（重复点／超时都不自动重发）、成功刷新列表且**不自动打开、不发任务**、
 * 4xx 与“结果未知”都保留输入且说法不同、切配置后迟到的创建回执不许污染新端点。
 *
 * **没打到真实服务器**：一次真实 `POST /sessions` 都没有 —— 授权实现 ≠ 授权生产里造会话
 * （见 `docs/ops/android-create-session.md`「没验到什么」）。
 */
@RunWith(AndroidJUnit4::class)
class SessionCreateBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    private val oldId = "11111111-1111-4111-8111-111111111111"
    private val newId = "22222222-2222-4222-8222-222222222222"

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

    // ───────────────────── ① 成功：一个 POST、只送填了的字段、刷新列表、不发任务 ─────────────────────

    /**
     * 填了名字 ＋ 勾「用服务器临时目录」，且目录框里还留着一串字 ⇒
     * 请求体里**只有** `name` 与 `scratch`（`scratch` 与 `cwd` 互斥，服务端契约），
     * 201 之后列表真的重新拉过（新会话出现）、表单清空、停在列表、**没有**任何 `/message`|`/steer`。
     *
     * 会失败的理由：把 `cwd` 一起送 ⇒ 服务端会 400 `invalid_session_location`；不刷新列表 ⇒ 新会话看不见；
     * 若「成功」顺手 open() 或替用户发一条 ⇒ 列表就离开了、或服务端会多出一次 message/steer 调用。
     */
    @Test
    fun successSendsOnlyFilledFieldsRefreshesListAndSendsNoTask() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createBody = FakeServer.created(
                id = newId,
                name = "空会话",
                cwd = "/srv/scratch/$newId",
                scratch = true,
            )

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上（进列表）", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            assertEquals("列表一开始只有那一行", 1, snap(state).sessionCount)
            val treeGetsBefore = server.treeGets.get()

            // 服务端此刻已经多出这条会话（假服务端不模拟状态，直接在树里放上它）。
            server.treeJson = FakeServer.tree(
                FakeServer.row(oldId, "已有会话"),
                FakeServer.row(newId, "空会话"),
            )

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("  空会话  ")
                state.onCreateCwdChange("/srv/ignored-when-scratch")
                state.updateCreateScratch(true)
            }
            assertTrue("表单该展开了", snap(state).createOpen)

            onMain { state.createSession() }
            assertEquals("点下去就进在途态（连点据此被挡）", true, snap(state).creating)
            waitFor("创建那一发结束", diag = { serverLog(server) + snap(state).let { " creating=${it.creating} receipt=${it.createReceipt}" } }) { !state.creating }

            assertEquals("只发了一次创建请求", 1, server.createCalls.get())
            assertEquals("没有自动重发", 1, server.createBodies.size)
            val body = JSONObject(server.createBodies.first())
            assertEquals("名字 trim 后原样送", "空会话", body.optString("name"))
            assertTrue("勾了临时目录 ⇒ 送 scratch:true", body.optBoolean("scratch"))
            assertFalse(
                "勾了临时目录 ⇒ 一个 cwd 都不许送（两者互斥，同送会被 400）: ${server.createBodies.first()}",
                body.has("cwd"),
            )

            // ⚠️ 这里的条件**不能**调 `snap()`：`waitFor` 已经把条件包在 `runOnMainSync` 里了，
            // 再套一层就会撞 "This method can not be called from the main application thread"（本单真错过一次）。
            waitFor("列表被刷新、新会话出现", diag = { serverLog(server) }) { state.sessions.size == 2 }
            assertTrue("确实重新拉过 /api/tree", server.treeGets.get() > treeGetsBefore)
            assertTrue("新会话可打开（列表里就是它）", snap(state).sessionIds.contains(newId))

            val end = snap(state)
            assertEquals("停在列表（不自动打开）", Screen.LIST, end.screen)
            assertNull("不自动打开 ⇒ 没有当前会话", end.currentId)
            assertEquals("回执是“成功”色", AppState.ReceiptTone.OK, end.createTone)
            assertTrue("回执要说已创建：${end.createReceipt}", end.createReceipt!!.contains("已创建"))
            assertTrue("回执要给服务端回的目录：${end.createReceipt}", end.createReceipt!!.contains("/srv/scratch/$newId"))
            assertEquals("成功才清表单（名字）", "", end.createName)
            assertEquals("成功才清表单（目录）", "", end.createCwd)
            assertEquals("成功才清表单（临时目录勾）", false, end.createScratch)
            assertFalse("表单收起（回执仍在列表上）", end.createOpen)
            assertEquals("**没有**替你发任务：一条 message/steer 都没有", 0, server.postCalls.size)
        }
    }

    /**
     * 服务端说 201、但 placement 没写成（`placementPersisted:false` ＋ `warning`）⇒
     * 回执必须说「会话**已经建出来了**、不要重试创建」，而不是含糊的“失败”。
     *
     * 会失败的理由：把 placementPersisted 当成“没建成”来回执，用户就会再点一次 —— 那会撞 live-cwd 守卫。
     */
    @Test
    fun placementWriteFailureIsReportedAsCreatedAndMustNotBeRetried() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createBody = FakeServer.created(
                id = newId,
                name = null,
                cwd = "/srv/scratch/$newId",
                scratch = true,
                placementPersisted = false,
                warning = "session was created, but its placement record could not be written",
            )

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.updateCreateScratch(true)
                state.createSession()
            }
            waitFor("创建那一发结束", diag = { serverLog(server) }) { !state.creating }

            val receipt = snap(state).createReceipt!!
            assertEquals("仍算“已创建”（成功色）", AppState.ReceiptTone.OK, snap(state).createTone)
            assertTrue("必须说清会话已经建出来了：$receipt", receipt.contains("已经建出来了"))
            assertTrue("必须点名不要重试：$receipt", receipt.contains("不要重试创建"))
            assertTrue("服务端 warning 原文要带上：$receipt", receipt.contains("placement record could not be written"))
            assertEquals("只发了一次", 1, server.createCalls.get())
        }
    }

    // ───────────────────── ② 连点只出一发；③ 4xx 保留输入；④ 未知保留输入且不重发 ─────────────────────

    /**
     * 创建挂着 600 ms 期间连点三次 ⇒ 服务端只收到 **1** 个创建请求。
     *
     * 会失败的理由：去掉 `creating` 这道闸，三次点击就是三个 POST ⇒ 三条会话（服务端没有幂等键）。
     */
    @Test
    fun duplicateTapsProduceExactlyOneCreatePost() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createDelayMs = 600

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("连点")
                state.createSession()
                state.createSession()
                state.createSession()
            }
            waitFor("那一发结束", diag = { serverLog(server) }) { !state.creating }
            Thread.sleep(300) // 再等一会儿，看看有没有“后补”的第二发

            assertEquals("连点只出一个 POST", 1, server.createCalls.get())
            assertEquals("只出一个请求体", 1, server.createBodies.size)
        }
    }

    /**
     * 服务端 400（例如 `invalid_cwd`）⇒ 回执是“没有建成”的错误色、带上服务端原因，**输入一个字都不清**，
     * 表单仍开着（用户可以直接改了重试），且只发过一次。
     *
     * 会失败的理由：失败也清表单，用户就得重打一遍；把 4xx 当“未知”回执，用户会以为可能建成了。
     */
    @Test
    fun rejectionKeepsInputAndShowsServerReason() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createStatus = 400
            server.createBody = """{"error":"invalid_cwd","message":"cwd must be a string or null"}"""

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("要保留的名字")
                state.onCreateCwdChange("/srv/x")
                state.createSession()
            }
            waitFor("那一发结束", diag = { serverLog(server) }) { !state.creating }

            val end = snap(state)
            assertEquals("错误色", AppState.ReceiptTone.ERROR, end.createTone)
            val receipt = end.createReceipt!!
            assertTrue("要写“没有建成”：$receipt", receipt.contains("没有建成"))
            assertTrue("要带服务端的码：$receipt", receipt.contains("invalid_cwd"))
            assertTrue("要带服务端的原因：$receipt", receipt.contains("cwd must be a string or null"))
            assertTrue("要说不自动重发：$receipt", receipt.contains("不会自动重发"))
            assertEquals("输入保留（名字）", "要保留的名字", end.createName)
            assertEquals("输入保留（目录）", "/srv/x", end.createCwd)
            assertTrue("表单仍开着（可以直接改）", end.createOpen)
            assertEquals("只发了一次", 1, server.createCalls.get())
        }
    }

    /**
     * 服务端不回响应、直接把连接关掉（客户端拿到 IOException）⇒ 回执是**“未知”**（警示色），
     * 输入保留，**一个字节都没有自动重发**。
     *
     * 会失败的理由：把它写成“没建成”就是撒谎（会话可能已经建出来了）；自动重发就会多建一条。
     */
    @Test
    fun unknownResultKeepsInputAndNeverAutoResends() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createAbort = true

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("结果未知的名字")
                state.createSession()
            }
            waitFor("那一发结束（连接被掐）", 20_000, diag = { serverLog(server) }) { !state.creating }
            Thread.sleep(600)

            val end = snap(state)
            assertEquals("警示色（不确定/未知）", AppState.ReceiptTone.WARN, end.createTone)
            val receipt = end.createReceipt!!
            assertTrue("要写“未知”：$receipt", receipt.contains("未知"))
            assertTrue("要说不自动重发：$receipt", receipt.contains("不自动重发"))
            assertTrue("要指向“先刷新看列表”：$receipt", receipt.contains("刷新"))
            assertEquals("输入保留", "结果未知的名字", end.createName)
            assertEquals("**没有**自动重发", 1, server.createCalls.get())
        }
    }

    // ───────────────── ④b 什么才算“已建”与“确定拒”（不是 2xx，也不是所有 4xx） ─────────────────

    /**
     * 服务端 4xx 但**认不出 error 码**（代理/网关/中间人换过的响应）⇒ 回执必须是“不确定”，
     * 不能说“确定没建”（那样用户就会放心重建）。
     *
     * 会失败的理由：把“除 408 以外的 4xx 全当确定拒”写死，这条就会拿到 ERROR 色。
     */
    @Test
    fun unrecognizedRejectionIsTreatedAsUncertain() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createStatus = 400
            server.createBody = "<html>proxy error</html>" // 读不出 error/message

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("保守处理的")
                state.createSession()
            }
            waitFor("那一发结束", diag = { serverLog(server) }) { !state.creating }

            val end = snap(state)
            assertEquals("认不出错误码 ⇒ 警示色，不是“错误”色", AppState.ReceiptTone.WARN, end.createTone)
            assertTrue("要说不确定：${end.createReceipt}", end.createReceipt!!.contains("不确定"))
            assertTrue("要指向先刷新看列表", end.createReceipt!!.contains("刷新"))
            assertEquals("输入保留", "保守处理的", end.createName)
            assertEquals("只发一次", 1, server.createCalls.get())
        }
    }

    /**
     * 状态码不是 2xx（500），但回执里已经带着这条会话的 id ⇒ 按产物说话：**已建、不要重建**，
     * 并且照样刷新列表把它找出来。
     *
     * 会失败的理由：只看状态码就会把一条已经建好的会话报成“失败”，用户重建就会多一条。
     */
    @Test
    fun errorStatusWithASessionInBodyCountsAsCreated() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(oldId, "已有会话"))
            server.createStatus = 500
            server.createBody = FakeServer.created(
                id = newId,
                name = "状态码不对但建出来了",
                cwd = "/srv/scratch/$newId",
                scratch = true,
                placementPersisted = false,
                warning = "placement write failed",
            )

            val state = newState()
            saveProfile(state, "配置 S", server.baseUrl)
            onMain { state.connect() }
            waitFor("连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }
            server.treeJson = FakeServer.tree(
                FakeServer.row(oldId, "已有会话"),
                FakeServer.row(newId, "状态码不对但建出来了"),
            )

            onMain {
                state.toggleCreateForm()
                state.updateCreateScratch(true)
                state.createSession()
            }
            waitFor("那一发结束", diag = { serverLog(server) }) { !state.creating }

            val end = snap(state)
            assertEquals("算“已建”（成功色）", AppState.ReceiptTone.OK, end.createTone)
            val receipt = end.createReceipt!!
            assertTrue("要写明已经建出来了：$receipt", receipt.contains("已经建出来了"))
            assertTrue("要写明不要重建：$receipt", receipt.contains("不要重建"))
            assertTrue("也要如实报状态码：$receipt", receipt.contains("500"))
            waitFor("仍然刷新了列表（新会话可打开）", diag = { serverLog(server) }) {
                state.sessions.any { it.id == newId }
            }
            assertEquals("只发一次创建", 1, server.createCalls.get())
            assertEquals("**没有**替你发任务", 0, server.postCalls.size)
        }
    }

    // ───────────────────── ⑤ 在途时不换配置；真断开也不把“可能已建”说成“没建” ─────────────────

    /**
     * 创建挂着 1.5 s 时去点另一条配置：**被拒绝并说明原因**（选中、屏幕、盘上都不变），
     * 然后那一发正常落在**原来的**端点上。
     *
     * 会失败的理由：只挡 `sending` 不挡 `creating` 的话，切走的瞬间端点就被清空了，回执没处落；
     * 更糟的是用户会以为“在 B 上建的”。
     */
    @Test
    fun profileSwitchIsRefusedWhileCreateIsInFlight() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(oldId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(oldId, "B 的会话"))
                a.createDelayMs = 1500

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)
                selectByName(state, "配置 A")
                onMain { state.connect() }
                waitFor("A 连上", diag = { serverLog(a) }) { state.screen == Screen.LIST }

                val idA = snap(state).selectedId!!
                onMain {
                    state.toggleCreateForm()
                    state.onCreateNameChange("A 上建的")
                    state.createSession()
                }
                waitFor("A 确实收到了创建请求（还挂着）", 10_000, diag = { serverLog(a) }) { a.createCalls.get() == 1 }

                val rawBefore = rawProfiles()
                selectByNameRaw(state, "配置 B")
                val after = snap(state)
                assertNotNull("在途时切配置要被拒绝并说明原因", after.profileError)
                assertTrue("理由要说“创建”：${after.profileError}", after.profileError!!.contains("创建"))
                assertEquals("选中不变", idA, after.selectedId)
                assertEquals("仍停在列表（端点没被切走）", Screen.LIST, after.screen)
                assertEquals("被拒绝的切换不落盘", rawBefore, rawProfiles())

                waitFor("那一发结束", 15_000, diag = { serverLog(a) }) { !state.creating }
                assertEquals("A 只收到一次", 1, a.createCalls.get())
                assertEquals("B 一次都没收到", 0, b.createCalls.get())
                val end = snap(state)
                assertEquals("回执落在原来的端点上（成功色）", AppState.ReceiptTone.OK, end.createTone)
                assertEquals("还停在 A 的列表上", idA, end.selectedId)
            }
        }
    }

    /**
     * 创建在途时**退出连接**：那个 POST **不会被撤销** ⇒ 界面必须说“服务器可能已经建出来了、不会自动重试、
     * 回到这条配置再刷新就能看到它”；迟到的回执不许上屏；重连 + 刷新后确实能看到那条会话。
     *
     * 会失败的理由：把“退出”当成“取消创建”就是在骗人（会话可能已经存在）；若回执不判归属，
     * 它会在连接页/新端点上冒出一句“已创建”。
     */
    @Test
    fun disconnectDuringCreateSaysServerMayStillHaveCreatedIt() {
        FakeServer("A").use { a ->
            a.treeJson = FakeServer.tree(FakeServer.row(oldId, "A 的会话"))
            a.createDelayMs = 1000

            val state = newState()
            saveProfile(state, "配置 A", a.baseUrl)
            onMain { state.connect() }
            waitFor("A 连上", diag = { serverLog(a) }) { state.screen == Screen.LIST }

            onMain {
                state.toggleCreateForm()
                state.onCreateNameChange("退出时还没回来")
                state.createSession()
            }
            waitFor("A 收到了创建请求（还挂着）", 10_000, diag = { serverLog(a) }) { a.createCalls.get() == 1 }

            onMain { state.disconnect() }
            val notice = snap(state).profileNotice
            assertNotNull("断开时要给一句说明", notice)
            assertTrue("必须说服务器可能已经建出来了：$notice", notice!!.contains("已经把它建出来了"))
            assertTrue("必须说不会自动重试：$notice", notice.contains("不会自动重试"))
            assertTrue("要给找回路径（连接＋刷新）：$notice", notice.contains("刷新"))

            // 服务端那边确实建出来了（假服务端：把新会话放进树里 = “服务器已经建好”）。
            a.treeJson = FakeServer.tree(
                FakeServer.row(oldId, "A 的会话"),
                FakeServer.row(newId, "退出时还没回来"),
            )

            waitFor("那一发结束（回执被丢弃）", 15_000, diag = { serverLog(a) }) { !state.creating }
            Thread.sleep(300)
            assertNull("迟到的回执不许上屏", snap(state).createReceipt)
            assertEquals("回执色也不留", AppState.ReceiptTone.NONE, snap(state).createTone)
            assertEquals("A 只建了一次（没有自动重发）", 1, a.createCalls.get())

            // 回到这条配置再连上 + 刷新 ⇒ 那条会话能找到（不谎称“没建”）。
            onMain { state.connect() }
            waitFor("重新连上", diag = { serverLog(a) }) { state.screen == Screen.LIST }
            waitFor("刷新后看到那条会话", diag = { serverLog(a) }) { state.sessions.any { it.id == newId } }
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private data class Snap(
        val screen: Screen,
        val profiles: List<Profile>,
        val selectedId: String?,
        val sessionCount: Int,
        val sessionIds: List<String>,
        val currentId: String?,
        val createOpen: Boolean,
        val createName: String,
        val createCwd: String,
        val createScratch: Boolean,
        val creating: Boolean,
        val createReceipt: String?,
        val createTone: AppState.ReceiptTone,
        val profileError: String?,
        val profileNotice: String?,
    )

    private fun snap(state: AppState): Snap = onMain {
        Snap(
            screen = state.screen,
            profiles = state.profiles,
            selectedId = state.selected?.id,
            sessionCount = state.sessions.size,
            sessionIds = state.sessions.map { it.id },
            currentId = state.current?.id,
            createOpen = state.createOpen,
            createName = state.createName,
            createCwd = state.createCwd,
            createScratch = state.createScratch,
            creating = state.creating,
            createReceipt = state.createReceipt,
            createTone = state.createReceiptTone,
            profileError = state.profileError,
            profileNotice = state.profileNotice,
        )
    }

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun rawProfiles(): String? = prefs().getString("profilesRaw", null)

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
        assertEquals("保存并选中「$name」", name, snap(state).selectedId?.let { id ->
            snap(state).profiles.first { it.id == id }.name
        })
    }

    private fun selectByName(state: AppState, name: String) {
        val id = snap(state).profiles.first { it.name == name }.id
        onMain { state.selectProfile(id) }
        assertEquals("点了「$name」就该切过去", id, snap(state).selectedId)
    }

    /** 只管点，不管成不成（用来验“被拒绝”那条）。 */
    private fun selectByNameRaw(state: AppState, name: String) {
        val id = snap(state).profiles.first { it.name == name }.id
        onMain { state.selectProfile(id) }
    }

    private fun serverLog(server: FakeServer): String =
        " [server ${server.label}@${server.port}] tree=${server.treeGets.get()} creates=${server.createCalls.get()}" +
            " posts=${server.postCalls.size}"
}
