package dev.sopho.pi

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.sopho.pi.net.MessageRow
import dev.sopho.pi.ui.DetailScreen
import dev.sopho.pi.ui.SophoTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 详情页的**真实 Compose 排列顺序**（业主反馈：「消息顺序不对，额外消息全堆最后」）。
 *
 * 数据是同进程内的 [FakeServer]（真 `AppState` ＋ 真 OkHttp ＋ 真 `/messages` 解析），只把服务端换掉；
 * payload 是**合成 fixture**，形状照真实 `/messages`（`messages` 与 `extras` 是两个数组，
 * 位置靠 `parentId` / 压缩块 `atIndex` / `timestamp`，`toolResult` 也在 `messages` 里占下标）。
 *
 * 断言的是**屏幕上的纵向位置**（不是内部列表），所以它同时覆盖“解析顺序”与“真的画在这个位置”：
 * ① 锚在助手回复上的额外消息落在它**下面**、下一条正文**上面**（不是整段最后）；
 * ② 锚在工具结果上的那条同理（工具结果本身不画，但仍是锚）；
 * ③ 没有锚的那条按回落留在最后；
 * ④ 重拉一次（同一份 payload）后顺序不变。
 *
 * 会失败的理由：把 `Wire.parseMessages` 换回「先 messages、再拼 extras」（旧形状）⇒ 三条额外消息全跑到
 * 最后一张卡下面；把不画的条目先过滤再取锚 ⇒ 锚在工具结果上的那条会消失或跑到最前面。
 */
@RunWith(AndroidJUnit4::class)
class MessageOrderUiTest {

    @get:Rule
    val rule = createComposeRule()

    private val app: Context = ApplicationProvider.getApplicationContext()
    private var state: AppState? = null

    private val sessionId = "aaaaaaaa-0000-4000-8000-000000000001"

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
    }

    @After
    fun tearDown() {
        state?.let { s -> runCatching { onMain { s.close() } } }
        state = null
        prefs().edit().clear().commit()
    }

    /**
     * 一条**混合时间线**（合成的，不是聊天正文）：
     * 正文 u1 → a1 → [工具结果 t1，不单独画] → u2 → a2；
     * 额外消息 e1 锚在 t1 上（时间戳甚至比所有正文都早）、e2 锚在 a2 上、e3 没有任何锚。
     */
    private fun timeline(): String {
        fun message(id: String, parentId: String?, role: String, text: String, timestamp: String?) = buildString {
            append("{\"entryId\":\"").append(id).append('"')
            append(",\"parentId\":").append(if (parentId == null) "null" else "\"$parentId\"")
            append(",\"timestamp\":").append(if (timestamp == null) "null" else "\"$timestamp\"")
            append(",\"role\":\"").append(role).append('"')
            append(",\"text\":\"").append(text).append('"').append('}')
        }
        fun extra(id: String, parentId: String?, text: String, timestamp: String?) = buildString {
            append("{\"entryId\":\"").append(id).append('"')
            append(",\"parentId\":").append(if (parentId == null) "null" else "\"$parentId\"")
            append(",\"timestamp\":").append(if (timestamp == null) "null" else "\"$timestamp\"")
            append(",\"customType\":\"sopho.delegation\",\"display\":true")
            append(",\"text\":\"").append(text).append('"').append('}')
        }
        val messages = listOf(
            message("u1", null, "user", "家长消息 1", "2026-10-24T09:00:00.000Z"),
            message("a1", "u1", "assistant", "助手回复 1", "2026-10-24T09:00:02.000Z"),
            message("t1", "a1", "toolResult", "工具结果（不单独成行）", "2026-10-24T09:00:03.000Z"),
            message("u2", "t1", "user", "家长消息 2", "2026-10-24T09:00:05.000Z"),
            message("a2", "u2", "assistant", "助手回复 2", "2026-10-24T09:00:07.000Z"),
        )
        val extras = listOf(
            extra("e1", "t1", "子会话回话 ①", "2026-10-24T09:00:00.500Z"),
            extra("e2", "a2", "子会话回话 ②", "2026-10-24T09:00:07.500Z"),
            extra("e3", null, "子会话回话 ③", null),
        )
        return """{"messages":[""" + messages.joinToString(",") +
            """],"extras":[""" + extras.joinToString(",") +
            """],"compaction":{"entryId":null,"atIndex":null,"note":"没有压缩过"}}"""
    }

    /** 期望的**渲染顺序**（屏幕上从上到下）。 */
    private val expectedOrder = listOf(
        "家长消息 1",
        "助手回复 1",
        "子会话回话 ①",
        "家长消息 2",
        "助手回复 2",
        "子会话回话 ②",
        "子会话回话 ③",
    )

    private fun assertVerticalOrder(order: List<String>, when_: String) {
        val tops = order.map { text ->
            val node = rule.onNodeWithText(text)
            node.assertIsDisplayed()
            node.getUnclippedBoundsInRoot().top
        }
        tops.forEachIndexed { index, top ->
            if (index == 0) return@forEachIndexed
            assertTrue(
                "$when_：第 ${index + 1} 张卡（「${order[index]}」）必须在上一张（「${order[index - 1]}」）下面；" +
                    "实测 top = ${tops.map { it.value }}",
                top > tops[index - 1],
            )
        }
    }

    @Test
    fun extrasAreDrawnAtTheirAnchorsAndStayThereAfterARefetch() {
        FakeServer("M").use { server ->
            server.treeJson = FakeServer.tree(FakeServer.row(sessionId, "额外消息穿插"))
            server.messageBodies[sessionId] = timeline()

            val created = newState()
            saveProfile(created, "顺序配置", server.baseUrl)
            onMain { created.connect() }
            waitFor("连上（进列表）") { created.screen == Screen.LIST }

            val row = onMain { created.sessions.first { it.id == sessionId } }
            onMain { created.open(row) }
            rule.setContent { SophoTheme { DetailScreen(created) } }
            rule.waitForIdle()
            waitFor("正文到齐（7 条：5 正文过滤后 4 条 ＋ 3 额外消息）") {
                created.messages.size == expectedOrder.size
            }
            rule.waitForIdle()

            // 内部顺序（解析层）与屏幕顺序（Compose）都对得上。
            assertEquals(
                listOf("user", "assistant", "extra", "user", "assistant", "extra", "extra"),
                created.messages.map(MessageRow::role),
            )
            assertEquals(3, rule.onAllNodesWithText("额外消息").fetchSemanticsNodes().size)
            assertVerticalOrder(expectedOrder, "首次打开")

            // 重拉一次：同一份 payload ⇒ 顺序不许变（“刷新后仍正确”）。
            val getsBefore = server.messageGets.size
            onMain { created.reloadMessages() }
            waitFor("重拉回来") { server.messageGets.size > getsBefore }
            rule.waitForIdle()
            waitFor("重拉后仍是 7 条") { created.messages.size == expectedOrder.size }
            rule.waitForIdle()
            assertEquals(
                listOf("user", "assistant", "extra", "user", "assistant", "extra", "extra"),
                created.messages.map(MessageRow::role),
            )
            assertVerticalOrder(expectedOrder, "重拉之后")
        }
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    private fun prefs() = app.getSharedPreferences("sopho-prefs", Context.MODE_PRIVATE)

    private fun newState(): AppState {
        var created: AppState? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { created = AppState(app) }
        return created!!.also { state = it }
    }

    private fun saveProfile(target: AppState, name: String, url: String) {
        onMain {
            target.newProfile()
            target.draftUpdate { it.copy(name = name, serverUrl = url) }
            target.saveDraft()
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun waitFor(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (onMain { condition() }) return
            Thread.sleep(20)
        }
        throw AssertionError("等不到：$what（${timeoutMs} ms 超时）")
    }
}
