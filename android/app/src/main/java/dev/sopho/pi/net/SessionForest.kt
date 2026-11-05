package dev.sopho.pi.net

/**
 * 展示树里的一行：`depth` 从 0 起（0 = 根），`promoted` = 父被隐藏（归档）时被提到更近的可见祖先。
 */
data class TreeEntry(
    val row: SessionRow,
    val depth: Int,
    val promoted: Boolean = false,
)

/**
 * 把 `/api/tree` 的一维 `sessions` 摊成「父在前、子跟随」的展示树。
 *
 * 依据（真服务 `GET /api/tree`，868 行，2026-10-22 实测）：
 * - 每行带 `parentId`；760 行非空、108 行为根，**0 行**指向列表外的 id ⇒ `parentId` 是可解析的有效键，
 *   不需要拿 `parentSessionPath` 去猜（那条只作“服务端确实给了父关系”的第二来源，本类不用它）。
 * - 深度分布 `{0:108, 1:474, 2:244, 3:42}`；实测 0 个环 —— 但环/缺父仍按规则兜住，不靠数据干净。
 *
 * 规则（每条都有单测）：
 * 1. **根**：`parentId` 为空／指向不存在的行／指向自己／祖先链成环 ⇒ 当根（不丢行、不无限递归）。
 * 2. **父被隐藏**（归档且 `showArchived=false`）⇒ 子**提升**到最近一个可见祖先（`promoted=true`），
 *    而不是跟着一起藏掉 —— 真服务里这种行有 39 条（父归档、子未归档）。
 * 3. **顺序**：根与兄弟都沿用服务端给的顺序。
 * 4. **深度夹在 [0, MAX_DEPTH]**：窄屏里 6 层以后再缩进只会把正文挤没。
 * 5. **每一行恰好出现一次**（DFS 的 emitted 集合 + 末尾兜底追加）。
 *
 * 未采用的替代（写在这里，免得以后被当成“漏了”）：把孤儿子树按 `parentSessionPath` 重新挂到别的父上；
 * 或者按 `createdAt` 重排兄弟。前者要解析路径、会和 `parentId` 冲突，后者会打乱服务端顺序 —— 都不在本单范围。
 */
object SessionForest {

    /** 缩进上限：再深的层级继续缩进，窄屏上正文就没了。 */
    const val MAX_DEPTH = 6

    fun visible(rows: List<SessionRow>, showArchived: Boolean): List<TreeEntry> {
        // 同一个 id 出现多次时只认第一份（保证「每条恰一次」）。
        val present = LinkedHashMap<String, SessionRow>(rows.size)
        for (row in rows) present.putIfAbsent(row.id, row)

        val parentOf = HashMap<String, String?>(present.size)
        val promotedOf = HashMap<String, Boolean>(present.size)

        for ((id, row) in present) {
            var cursor: String? = row.parentId
            var promoted = false
            val chain = ArrayList<String>()
            var parent: String? = null
            while (true) {
                val upId = cursor?.takeIf { it.isNotEmpty() } ?: break
                // 指向自己 / 祖先链里出现过 ⇒ 成环：当根，别继续爬。
                if (upId == id || chain.contains(upId)) break
                chain.add(upId)
                val up = present[upId] ?: break // 缺父（指向列表外）⇒ 当根
                if (showArchived || !up.archived) {
                    parent = upId
                    break
                }
                promoted = true // 这一层被隐藏了，继续往上找可见祖先
                cursor = up.parentId
            }
            parentOf[id] = parent
            promotedOf[id] = promoted
        }

        val children = HashMap<String, MutableList<String>>(present.size)
        val roots = ArrayList<String>()
        // 隐藏的行（归档且开关关着）本身**不输出**：它的未归档子在上面已经被提升到更近的可见祖先。
        fun isVisible(id: String): Boolean = showArchived || !(present[id]?.archived ?: false)
        for (id in present.keys) {
            if (!isVisible(id)) continue
            val parent = parentOf[id]
            if (parent == null) roots.add(id) else children.getOrPut(parent) { ArrayList() }.add(id)
        }

        val out = ArrayList<TreeEntry>(present.size)
        val emitted = HashSet<String>(present.size)
        val stack = ArrayDeque<Pair<String, Int>>()
        for (id in roots.asReversed()) stack.addLast(id to 0)
        while (stack.isNotEmpty()) {
            val (id, depth) = stack.removeLast()
            if (!emitted.add(id)) continue
            val row = present[id] ?: continue
            val capped = if (depth > MAX_DEPTH) MAX_DEPTH else depth
            out.add(TreeEntry(row, capped, promotedOf[id] == true))
            val kids = children[id] ?: continue
            for (kid in kids.asReversed()) stack.addLast(kid to depth + 1)
        }

        // 兜底：理论上只有“成环但仍有可行父”的极端形状会留下，按服务端顺序当根补上（绝不漏行）。
        for (id in present.keys) {
            if (!isVisible(id) || emitted.contains(id)) continue
            if (!emitted.add(id)) continue
            out.add(TreeEntry(present.getValue(id), 0, promotedOf[id] == true))
        }
        return out
    }
}
