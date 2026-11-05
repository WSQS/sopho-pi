package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住「列表怎么摊成展示树」这件事：归档默认隐藏、隐藏归档父时未归档子必须留下、
 * 多层/缺父/成环都不能丢行、每行恰一次。
 *
 * 数据形状照真服务的 `/api/tree`：一维 `sessions` + 每行 `parentId`
 * （实测 868 行 / 760 行有 parentId / 0 行指向列表外 / 深度 {0:108,1:474,2:244,3:42} / 0 环，
 * 见 `docs/ops/android-client.md` §11；其中「父归档、子未归档」有 39 行，正是本测试第 2 组）。
 */
class SessionForestTest {

    private fun row(
        id: String,
        parentId: String? = null,
        archived: Boolean = false,
        name: String = id,
    ) = SessionRow(
        id = id,
        name = name,
        status = "idle",
        statusLabel = "闲置",
        archived = archived,
        cwd = null,
        parentId = parentId,
        modifiedAt = null,
    )

    private fun ids(entries: List<TreeEntry>) = entries.map { it.row.id }

    @Test
    fun `archived sessions are hidden by default and appear when the switch is on`() {
        val rows = listOf(row("a", archived = true), row("b"))
        assertEquals(listOf("b"), ids(SessionForest.visible(rows, showArchived = false)))
        assertEquals(listOf("a", "b"), ids(SessionForest.visible(rows, showArchived = true)))
    }

    @Test
    fun `non-archived child of a hidden archived parent is kept and promoted`() {
        val rows = listOf(row("parent", archived = true), row("child", parentId = "parent"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("child"), ids(shown))
        val entry = shown.single()
        assertEquals(0, entry.depth) // 提到根，而不是跟着父一起消失
        assertTrue(entry.promoted)
    }

    @Test
    fun `child is promoted to the nearest visible ancestor, not to the root when one exists`() {
        val rows = listOf(
            row("root"),
            row("mid", parentId = "root", archived = true),
            row("leaf", parentId = "mid"),
        )
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("root", "leaf"), ids(shown))
        assertEquals(1, shown[1].depth) // 挂到 root 下面
        assertTrue(shown[1].promoted)
    }

    @Test
    fun `hiding an archived parent does not also hide its non-archived grandchildren`() {
        val rows = listOf(
            row("root"),
            row("mid", parentId = "root", archived = true),
            row("leaf", parentId = "mid"),
            row("deeper", parentId = "leaf"),
        )
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("root", "leaf", "deeper"), ids(shown))
        assertEquals(listOf(0, 1, 2), shown.map { it.depth })
    }

    @Test
    fun `parents come before their children and depth follows the real chain`() {
        val rows = listOf(row("c", parentId = "b"), row("a"), row("b", parentId = "a"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("a", "b", "c"), ids(shown))
        assertEquals(listOf(0, 1, 2), shown.map { it.depth })
    }

    @Test
    fun `sibling order follows the server order`() {
        val rows = listOf(
            row("p"),
            row("s2", parentId = "p"),
            row("s1", parentId = "p"),
            row("s3", parentId = "p"),
        )
        assertEquals(listOf("p", "s2", "s1", "s3"), ids(SessionForest.visible(rows, false)))
    }

    @Test
    fun `missing parent is treated as a root`() {
        val rows = listOf(row("orphan", parentId = "not-in-this-response"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("orphan"), ids(shown))
        assertEquals(0, shown.single().depth)
    }

    @Test
    fun `a two-node cycle never recurses forever and loses nothing`() {
        val rows = listOf(row("a", parentId = "b"), row("b", parentId = "a"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("a", "b"), ids(shown))
        assertEquals(2, ids(shown).toSet().size)
    }

    @Test
    fun `a self-parenting row is a root`() {
        val rows = listOf(row("self", parentId = "self"), row("kid", parentId = "self"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("self", "kid"), ids(shown))
        assertEquals(listOf(0, 1), shown.map { it.depth })
    }

    @Test
    fun `every row appears exactly once even when an id repeats in the response`() {
        val rows = listOf(row("a"), row("a"), row("b", parentId = "a"))
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(listOf("a", "b"), ids(shown))
    }

    @Test
    fun `indent depth is capped so the narrow screen keeps room for text`() {
        val rows = (0..9).map { index ->
            row("n$index", parentId = if (index == 0) null else "n${index - 1}")
        }
        val shown = SessionForest.visible(rows, showArchived = false)
        assertEquals(10, shown.size)
        assertEquals(SessionForest.MAX_DEPTH, shown.map { it.depth }.max())
    }

    @Test
    fun `with the switch on, an archived parent keeps its children under it`() {
        val rows = listOf(row("parent", archived = true), row("child", parentId = "parent"))
        val shown = SessionForest.visible(rows, showArchived = true)
        assertEquals(listOf("parent", "child"), ids(shown))
        assertEquals(listOf(0, 1), shown.map { it.depth })
        assertTrue(shown.none { it.promoted })
    }
}
