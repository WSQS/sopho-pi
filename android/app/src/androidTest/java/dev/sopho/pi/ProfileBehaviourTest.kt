package dev.sopho.pi

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch

/**
 * Profile v1 的**行为**证据：真实 Android Context ＋ 真实 `SharedPreferences` ＋ 真实 `AppState`，
 * 只把服务端换成同进程内的 [FakeServer]（真 OkHttp、真 TCP）。
 *
 * 这组测试要回答的不是「序列化对不对」（那是 `app/src/test/.../ProfileTest.kt` 的纯函数覆盖面），
 * 而是 `docs/ops/android-client.md` §15 最后那句「未验」—— 切换后列表/详情/SSE 隔离、草稿隔离、
 * 删除当前项回退、重建后回读 selected —— 在**状态机层面**到底成不成立。
 *
 * 每个用例的注释写清：这一发驱动了哪条产品路径、断言看的是哪个状态、以及它为什么能失败
 * （不能失败的断言不算证据）。
 */
@RunWith(AndroidJUnit4::class)
class ProfileBehaviourTest {

    private val app: Context = ApplicationProvider.getApplicationContext()
    private val created = mutableListOf<AppState>()

    /** 两个假服务端都返回**同一个** sessionId —— 这是本组测试的关键：串不串不能靠 id 不同来掩盖。 */
    private val sameId = "11111111-1111-4111-8111-111111111111"

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

    // ───────────────────────────── ① 端到端隔离（同一 sessionId） ─────────────────────────────

    /**
     * A 上的 `/messages` 是慢的（3 s），切到 B 之后才回来 ⇒ 它**不许**改写 B 的正文/条数。
     *
     * 会失败的理由：`AppState.loadMessages()` 的回调里若不做归属判断，A 的迟到结果会直接写 `messages`
     * 与 `historyNotice`（这正是 v1 咬过的「标题是 B、正文是 A」）。
     */
    @Test
    fun staleMessagesFromOldProfileAreDropped() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(sameId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(sameId, "B 的会话"))
                a.messageBodies[sameId] = FakeServer.messages("user" to "A 的正文标记", "assistant" to "A 慢样本")
                a.messageDelays[sameId] = 3000
                b.messageBodies[sameId] = FakeServer.messages("user" to "B 的正文标记")

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)
                // saveDraft 的副作用是「保存即选中」—— 此刻选中的是 B，先切回 A。
                selectByName(state, "配置 A")

                onMain { state.connect() }
                waitFor("A 连上（进列表）") { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("A 的 /messages 真的发出来了（服务端已收到、但还挂着 3 s）", diag = { snap(state).let { " screen=${it.screen} current=${it.currentId} detailError=${it.detailError} stream=${it.streamStatus}" } + serverLog(a) + serverLog(b) }) { a.messageGets.size >= 1 }
                assertEquals("A 的 /messages 还挂着（一条都没写回去）", 0, a.messageDelivered.size)

                // 还没等 A 回，就切到 B —— 走的是产品里的 selectProfile（= 点列表里那条配置）
                selectByName(state, "配置 B")
                val afterSwitch = snap(state)
                assertEquals("切配置回到连接页", Screen.CONNECT, afterSwitch.screen)
                assertEquals("旧列表必须清空", 0, afterSwitch.sessionCount)
                assertNull("旧详情必须清空", afterSwitch.currentId)
                assertEquals("旧正文必须清空", emptyList<String>(), afterSwitch.messageTexts)

                onMain { state.connect() }
                waitFor("B 连上") { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("B 的正文到了") { state.messages.isNotEmpty() }
                assertEquals(listOf("B 的正文标记"), snap(state).messageTexts)

                // 服务端侧证明：A 那几发**真的写回去了**（不是「客户端提前取消所以什么也没发生」）
                waitFor("A 的迟到响应真的回来了", 15_000) { a.messageDelivered.size == a.messageGets.size }
                Thread.sleep(1500) // 给「写进状态」这件事足够的时间窗

                val end = snap(state)
                assertEquals("最终只该剩 B 那一行", listOf("B 的正文标记"), end.messageTexts)
                assertEquals("「共 N 条」也必须属于 B", "共 1 条（全量接收）", end.historyNotice)
                assertEquals("选中的仍是 B", "配置 B", end.selectedName)
                assertEquals("旧端点那几次 GET 确实发生过", a.messageGets.size, a.messageDelivered.size)
            }
        }
    }

    /**
     * 旧 Profile 的 SSE 帧**在新 Profile 打开后才被投递**：它不许改写新详情的直播块，也不许把
     * `agentBusy` 改成「在跑」（那会决定下一条发送走 `/steer` 还是 `/message`）。
     *
     * 怎么把它做成确定性的：把主线程占住一段时间，让 A 的那一帧在这段窗口里被 OkHttp 读进
     * `onEvent`，其 `scope.launch` 排到主线程队列**之后**才执行 —— 那正是「旧 SSE 迟到」的真实窗口。
     * 会失败的理由：`onEvent` 回调里若不做归属判断，这一帧照样 `applyEvent`，新详情上就会冒出旧直播块。
     */
    @Test
    fun staleSseFrameFromOldProfileIsDropped() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(sameId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(sameId, "B 的会话"))
                a.messageBodies[sameId] = FakeServer.messages("assistant" to "A 的正文")
                b.messageBodies[sameId] = FakeServer.messages("assistant" to "B 的正文")

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)
                selectByName(state, "配置 A")

                onMain { state.connect() }
                waitFor("A 连上") { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("A 的 SSE 连上了") { a.hasStream(sameId) }
                assertNull("这时候还没有直播块", snap(state).liveText)

                val entered = CountDownLatch(1)
                val pusher = Thread {
                    entered.await()
                    Thread.sleep(120)
                    a.push(sameId, "session.delta", """{"channel":"text","delta":"A-旧SSE直播标记"}""")
                }.apply { isDaemon = true; start() }

                val bId = snap(state).profiles.first { it.name == "配置 B" }.id
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    entered.countDown()
                    Thread.sleep(1500) // 这一帧在这段时间里进来并排队
                    state.selectProfile(bId)
                }
                assertEquals("那一帧在服务端侧确实推出去了", 1, a.ssePushesOk.get())
                waitFor("切配置时旧 SSE 被断开（服务端读到 EOF）") { a.sseClosed.contains(sameId) }

                // ★ 关键：**在打开 B 之前**先断言。`open()` 自己会把 liveText 清成 null，
                // 所以“先打开 B、再断言 liveText 为空”是一种假绿（改守卫也照样绿）—— 这里踩过一次，改掉了。
                Thread.sleep(1200) // 让排在主线程队列里的那一帧真正执行
                val afterSwitch = snap(state)
                assertNull("旧 Profile 的直播块不许落在切配置后的状态上", afterSwitch.liveText)
                assertEquals("agentBusy 不许被旧帧改成「在跑」（它决定下一条发送走 /steer 还是 /message）", false, afterSwitch.agentBusy)
                assertEquals("切配置后也不该留下旧正文", emptyList<String>(), afterSwitch.messageTexts)
                assertEquals("切配置后停在连接页", Screen.CONNECT, afterSwitch.screen)

                // 再用 B 打开同一个 sessionId：正文只能是 B 的
                onMain { state.connect() }
                waitFor("B 连上") { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("B 的正文到了") { state.messages.isNotEmpty() }
                Thread.sleep(1000)

                val end = snap(state)
                assertNull("新详情上也没有旧直播块", end.liveText)
                assertEquals(listOf("B 的正文"), end.messageTexts)
                assertTrue("旧流确实被断过（不是靠「还没连上」蒙过去的）", a.sseClosed.contains(sameId))
            }
        }
    }

    // ───────────────────────────── ② 草稿按 (profileId, sessionId) 隔离 ─────────────────────────────

    /**
     * 两个配置指向不同服务端、但会话 id 相同；草稿 111/222 各归各家，来回切两次都不串。
     *
     * 会失败的理由：草稿键若只用 `sessionId`，切回来会读到另一条配置的草稿（下方 `draftKey` 反证臂）。
     */
    @Test
    fun draftsAreIsolatedPerProfile() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(sameId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(sameId, "B 的会话"))
                a.messageBodies[sameId] = FakeServer.messages("user" to "A 的正文")
                b.messageBodies[sameId] = FakeServer.messages("user" to "B 的正文")

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)

                selectByName(state, "配置 A")
                openFirstSession(state, "A", a)
                onMain { state.onDraftChange("111") }
                assertEquals("A 上的草稿就是 111", "111", snap(state).draft)

                selectByName(state, "配置 B")
                openFirstSession(state, "B", b)
                assertEquals("B 上不许看见 A 的草稿", "", snap(state).draft)
                onMain { state.onDraftChange("222") }

                selectByName(state, "配置 A")
                openFirstSession(state, "A(第二次)", a)
                assertEquals("切回 A：草稿还是 111", "111", snap(state).draft)

                selectByName(state, "配置 B")
                openFirstSession(state, "B(第二次)", b)
                assertEquals("切回 B：草稿还是 222", "222", snap(state).draft)

                // 反证用的键：同一 profile 下不同会话仍要分开（顺手把「按会话」这一半也钉住）
                assertEquals(
                    false,
                    Profiles.draftKey("p1", "s1") == Profiles.draftKey("p2", "s1"),
                )
            }
        }
    }

    // ───────────────────────────── ③ 发送在途：不许切/改/删，旧回执不污染 ─────────────────────────────

    /**
     * 一条 POST `/message` 挂住 3 s 还没回来时：选择/新建/保存/删除**一律拒绝**且不落盘；
     * 等它回来时目标会话已经不在详情上 ⇒ 那条回执**不许**写进当前状态。
     *
     * 会失败的理由：`sending` 守卫若不存在，`selectProfile` 会照常切（并清空在途中的一切），
     * `saveDraft` 会写盘；回执若不判归属，会作为一条「已接受」落到别的界面上。
     */
    @Test
    fun sendingInFlightBlocksProfileOpsAndStaleReceiptIsDropped() {
        FakeServer("A").use { a ->
            FakeServer("B").use { b ->
                a.treeJson = FakeServer.tree(FakeServer.row(sameId, "A 的会话"))
                b.treeJson = FakeServer.tree(FakeServer.row(sameId, "B 的会话"))
                a.messageBodies[sameId] = FakeServer.messages("assistant" to "A 的正文")
                b.messageBodies[sameId] = FakeServer.messages("assistant" to "B 的正文")
                a.postDelayMs = 8000 // 足够长：后面那串拒绝都要发生在它还没回来的时候
                a.postStatus = 202

                val state = newState()
                saveProfile(state, "配置 A", a.baseUrl)
                saveProfile(state, "配置 B", b.baseUrl)
                selectByName(state, "配置 A")
                // 首次运行（prefs 空）会先迁移出一条「默认连接」，所以这里不是 2 而是 3 —— 直接钉住它，
                // 后面两处「条数不变」都用同一个数，免得把「被拒绝的新建竟然多了一条」蒙过去。
                val profileCount = snap(state).profiles.size
                assertEquals("默认连接 + 本组新建的两条", 3, profileCount)

                onMain { state.connect() }
                waitFor("A 连上") { state.screen == Screen.LIST }
                onMain { state.open(state.sessions.first()) }
                waitFor("正文到了", diag = { snap(state).let { " screen=${it.screen} current=${it.currentId} detailError=${it.detailError} stream=${it.streamStatus}" } + serverLog(a) }) { state.messages.isNotEmpty() }

                onMain { state.onDraftChange("在途这一句") }
                onMain { state.send() }
                assertEquals("发了之后 sending 必须为真", true, snap(state).sending)
                waitFor("POST 已经打到服务端、正挂着 8 s", diag = { serverLog(a) + snap(state).let { " sending=${it.sending} receipt=${it.sendReceipt} draft=${it.draft} detailError=${it.detailError}" } }) { a.postCalls.size == 1 }

                val idA = snap(state).selectedId!!
                val idB = snap(state).profiles.first { it.name == "配置 B" }.id
                val rawBefore = rawProfiles()

                selectByNameRaw(state, "配置 B")
                val afterSelect = snap(state)
                assertNotNull("发送在途时选另一条配置要被拒绝且说明原因", afterSelect.profileError)
                assertEquals("被拒绝的切换不许改选中", "配置 A", afterSelect.selectedName)
                assertEquals("被拒绝的切换不许落盘", rawBefore, rawProfiles())
                assertEquals("详情还挂在这条会话上（没被拒绝的切换清掉）", sameId, afterSelect.currentId)

                onMain { state.newProfile() }
                val afterNew = snap(state)
                assertNotNull("发送在途时新建要被拒绝", afterNew.profileError)
                assertEquals("新建被拒绝后草稿区仍是已保存那条（不算「有未保存修改」）", "配置 A", afterNew.draftName)
                assertEquals("配置条数不变", profileCount, afterNew.profiles.size)
                assertEquals("不落盘", rawBefore, rawProfiles())

                onMain { state.draftUpdate { it.copy(name = "改个名") } }
                onMain { state.saveDraft() }
                val afterSave = snap(state)
                assertNotNull("发送在途时保存要被拒绝", afterSave.profileError)
                assertEquals("保存被拒绝后名字没被写进配置", "配置 A", afterSave.selectedName)
                assertEquals("不落盘", rawBefore, rawProfiles())

                onMain { state.deleteProfile(idA) }
                val afterDelete = snap(state)
                assertNotNull("发送在途时删要被拒绝", afterDelete.profileError)
                assertEquals("配置条数不变（一条都没删）", profileCount, afterDelete.profiles.size)
                assertEquals("选中不变", idA, afterDelete.selectedId)
                assertEquals("不落盘", rawBefore, rawProfiles())

                onMain { state.draftUpdate { it.copy(name = "配置 A") } } // 撤回临时改名，免得影响后面的断言

                // 允许的动作：退回列表（这不改端点、不改盘）。这一下让详情归属换代 ⇒ 回执该被丢掉。
                onMain { state.backToList() }
                assertEquals(Screen.LIST, snap(state).screen)

                waitFor("那一发 POST 已经结束", 20_000) { !state.sending }
                assertEquals("只发了一次（没有自动重发）", listOf("message"), a.postCalls.toList())
                assertNull("迟到（且已不属于当前详情）的回执不许上屏", snap(state).sendReceipt)
                assertEquals("回执不再挂起后，选中与盘上内容还是原来那份", rawBefore, rawProfiles())

                // 在途结束后，切换才被允许
                selectByNameRaw(state, "配置 B")
                assertEquals("在途结束后切换成功", idB, snap(state).selectedId)
                assertEquals("切换后回到连接页", Screen.CONNECT, snap(state).screen)
            }
        }
    }

    // ───────────────────────────── ④ 落盘/重建/删除回退/迁移 ─────────────────────────────

    /**
     * 老键 → Profile 的迁移只做一次；重建 AppState 从同一份 prefs 读回 selected 与
     * URL/network/Moon；删掉当前条目回退到第一条并落盘。
     *
     * 会失败的理由：迁移若不写 `migrationDone`，第二次启动会再迁一条（配置变两条）；
     * 若保存/删除不落盘，重建后读回来的是旧值。
     */
    @Test
    fun saveDeleteAndRecreateReadBackFromSamePrefs() {
        FakeServer("S").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sameId, "S 的会话"))

            // 老版本留下的三个键（地址/networkId 当年根本没落盘）
            prefs().edit()
                .putBoolean("showArchived", true)
                .putString("moonWorld", "aaaaaaaaaaaaaaaa")
                .putString("moonSeed", "0123456789abcdef")
                .commit()

            val first = newState()
            val migrated = snap(first)
            assertEquals("迁移只生成一条配置", 1, migrated.profiles.size)
            assertEquals("迁移出来的名字", Profiles.DEFAULT_PROFILE_NAME, migrated.selectedName)
            assertEquals("归档开关原样保留", true, migrated.showArchived)
            assertEquals("Moon(World) 原样保留", "aaaaaaaaaaaaaaaa", migrated.selectedMoonWorld)
            assertEquals("Moon(Seed) 原样保留", "0123456789abcdef", migrated.selectedMoonSeed)
            assertEquals("旧版本没存 networkId ⇒ 留空，不编造", "", migrated.selectedNetworkId)
            assertNotNull("首次迁移要给人一句说明", migrated.profileNotice)
            val afterMigration = rawProfiles()

            val second = newState()
            assertEquals("第二次启动不许再迁移出一条", 1, snap(second).profiles.size)
            assertNull("第二次启动不该再报迁移说明", snap(second).profileNotice)
            assertEquals("第二次启动不该再写盘（内容一字不变）", afterMigration, rawProfiles())

            // 新建 + 保存一条 ZeroTier 配置：**不联网**、不动 libzt
            onMain {
                second.newProfile()
                second.draftUpdate {
                    it.copy(
                        name = "第二台",
                        serverUrl = server.baseUrl,
                        mode = RunMode.ZEROTIER,
                        networkId = "8056c2e21c000001",
                        moonWorld = "aaaaaaaaaaaaaaaa",
                        moonSeed = "0123456789abcdef",
                    )
                }
                second.saveDraft()
            }
            val afterSave = snap(second)
            assertNull("保存不该报错：${afterSave.profileError}", afterSave.profileError)
            assertEquals("保存即选中", "第二台", afterSave.selectedName)
            assertEquals("保存不联网：libzt 仍是 Idle（没有 start/join/orbit）", true, afterSave.ztIdle)
            // 真服务端侧计数：保存/选中那条 ZeroTier 配置期间**一个请求都没打到它**
            assertEquals("保存不联网：没有 tree 请求", 0, server.treeGets.get())
            assertEquals("保存不联网：没有 /messages 请求", 0, server.messageGets.size)
            assertEquals("保存不联网：没有任何写请求", 0, server.postCalls.size)

            // 真落盘：直接读 prefs 的 XML 文件（不是读内存）
            waitForPrefsFileContains("8056c2e21c000001")

            val third = newState()
            val reloaded = snap(third)
            assertEquals("重建后选中的就是上次保存那条", "第二台", reloaded.selectedName)
            assertEquals("URL 回读", server.baseUrl, reloaded.selectedUrl)
            assertEquals("networkId 回读", "8056c2e21c000001", reloaded.selectedNetworkId)
            assertEquals("mode 回读", RunMode.ZEROTIER, reloaded.selectedMode)
            assertEquals("Moon world 回读", "aaaaaaaaaaaaaaaa", reloaded.selectedMoonWorld)
            assertEquals("Moon seed 回读", "0123456789abcdef", reloaded.selectedMoonSeed)
            assertEquals("showArchived 跟着整块回读", true, reloaded.showArchived)

            // 删掉当前那条 ⇒ 回退到第一条、停在配置页、不自动连接
            onMain { third.deleteProfile(reloaded.selectedId!!) }
            val afterDelete = snap(third)
            assertEquals("回退到第一条", Profiles.DEFAULT_PROFILE_NAME, afterDelete.selectedName)
            assertEquals("只剩一条", 1, afterDelete.profiles.size)
            assertEquals("停在连接页（不自动连接）", Screen.CONNECT, afterDelete.screen)
            assertNotNull("要说明回退了什么", afterDelete.profileNotice)
            assertEquals("删除也不联网：一个请求都没有", 0, server.treeGets.get())

            val fourth = newState()
            assertEquals("回退也是落盘的：重建后仍是第一条", Profiles.DEFAULT_PROFILE_NAME, snap(fourth).selectedName)
            assertEquals(1, snap(fourth).profiles.size)
        }
    }

    /**
     * 坏数据：可读错误上屏、**原串不被覆盖**、只有显式重建才动盘（并且先把原串备份到 `.corrupt`）。
     */
    @Test
    fun corruptDataIsReportedNotOverwritten() {
        prefs().edit().putString("profilesRaw", "这不是格式").commit()

        val state = newState()
        val broken = snap(state)
        assertNotNull("坏数据必须有可读错误", broken.profileError)
        assertTrue("错误要能给人看：${broken.profileError}", broken.profileError!!.contains("首行不是"))
        assertEquals("坏数据不许就地覆盖", "这不是格式", rawProfiles())
        assertNull("坏数据时不该假装有选中配置", broken.selectedId)

        onMain { state.rebuildAfterCorrupt() }
        assertEquals(
            "显式重建前先把原串备份",
            "这不是格式",
            prefs().getString("profilesRaw.corrupt", null),
        )
        assertEquals("重建后有一条默认可用的配置", 1, snap(state).profiles.size)
        assertNull("重建后错误消失", snap(state).profileError)

        val again = newState()
        assertEquals("重建结果可读回", 1, snap(again).profiles.size)
        assertNull("重建结果可读回（无错误）", snap(again).profileError)
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    /** 状态的**快照**：所有字段在主线程上一次取齐，断言就都在同一个时点上做。 */
    private data class Snap(
        val screen: Screen,
        val profiles: List<Profile>,
        val selectedId: String?,
        val selectedName: String?,
        val selectedUrl: String?,
        val selectedNetworkId: String?,
        val selectedMode: RunMode?,
        val selectedMoonWorld: String?,
        val selectedMoonSeed: String?,
        val draftName: String?,
        val showArchived: Boolean,
        val draft: String,
        val messageTexts: List<String>,
        val historyNotice: String?,
        val liveText: String?,
        val agentBusy: Boolean,
        val sending: Boolean,
        val sendReceipt: String?,
        val profileError: String?,
        val profileNotice: String?,
        val sessionCount: Int,
        val currentId: String?,
        val detailError: String?,
        val streamStatus: String,
        val ztIdle: Boolean,
    )

    private fun snap(state: AppState): Snap = onMain {
        Snap(
            screen = state.screen,
            profiles = state.profiles,
            selectedId = state.selected?.id,
            selectedName = state.selected?.name,
            selectedUrl = state.selected?.serverUrl,
            selectedNetworkId = state.selected?.networkId,
            selectedMode = state.selected?.mode,
            selectedMoonWorld = state.selected?.moonWorld,
            selectedMoonSeed = state.selected?.moonSeed,
            draftName = state.draftProfile?.name,
            showArchived = state.showArchived,
            draft = state.draft,
            messageTexts = state.messages.map { it.text },
            historyNotice = state.historyNotice,
            liveText = state.liveText,
            agentBusy = state.agentBusy,
            sending = state.sending,
            sendReceipt = state.sendReceipt,
            profileError = state.profileError,
            profileNotice = state.profileNotice,
            sessionCount = state.sessions.size,
            currentId = state.current?.id,
            detailError = state.detailError,
            streamStatus = state.streamStatus,
            ztIdle = state.ztStatus is dev.sopho.pi.zt.ZtStatus.Idle,
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

    /** 新建一个 AppState（= 应用重启一次；同一份 prefs、同一份 Context）。 */
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

    /** 走产品路径新建+改名+保存一条 DIRECT 配置（`newProfile` → `draftUpdate` → `saveDraft`）。 */
    private fun saveProfile(state: AppState, name: String, url: String) {
        onMain {
            state.newProfile()
            state.draftUpdate { it.copy(name = name, serverUrl = url) }
            state.saveDraft()
        }
        val after = snap(state)
        assertNull("保存「$name」不该报错：${after.profileError}", after.profileError)
        assertEquals("保存即选中", name, after.selectedName)
    }

    private fun selectByName(state: AppState, name: String) {
        selectByNameRaw(state, name)
        assertEquals("点了「$name」就该切过去", name, snap(state).selectedName)
    }

    private fun selectByNameRaw(state: AppState, name: String) {
        val id = snap(state).profiles.first { it.name == name }.id
        onMain { state.selectProfile(id) }
    }

    private fun openFirstSession(state: AppState, label: String, server: FakeServer) {
        if (snap(state).screen != Screen.LIST) {
            onMain { state.connect() }
            waitFor("$label 连上", diag = { serverLog(server) }) { state.screen == Screen.LIST }
        }
        onMain { state.open(state.sessions.first()) }
        waitFor("$label 的正文到了", diag = { snap(state).let { " screen=${it.screen} current=${it.currentId} detailError=${it.detailError} stream=${it.streamStatus}" } + serverLog(server) }) {
            state.messages.isNotEmpty()
        }
    }

    private fun serverLog(server: FakeServer): String =
        " [server ${server.label}@${server.port}] tree=${server.treeGets.get()} msgGets=${server.messageGets.size}" + 
            " msgDelivered=${server.messageDelivered.size} sseOpened=${server.sseOpened.size} posts=${server.postCalls.size}"

    private fun prefsXmlFile(): File = File(app.applicationInfo.dataDir, "shared_prefs/sopho-prefs.xml")

    private fun waitForPrefsFileContains(needle: String) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val file = prefsXmlFile()
            if (file.isFile && file.readText().contains(needle)) return
            Thread.sleep(50)
        }
        fail("prefs 的 XML 文件里没等到「$needle」（路径 ${prefsXmlFile()}）")
    }
}
