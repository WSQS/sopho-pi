package dev.sopho.pi.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 输入区的两份**纯逻辑**：
 * 1. 主按钮三态（空＋ / 有可发内容发送 / 盘开×）；
 * 2. “已经上屏的文本” —— 组词（IME composition）中的拼音不算可发送内容。
 *
 * 这里只吃 String ＋ 组词区间的下标，所以能在 JVM 上直接钉；真正的 `TextFieldValue.composition`
 * 由仪表化用例（真 Compose 语义）覆盖，两者合起来才说明“组词不会误发”。
 */
class ComposerLogicTest {

    @Test
    fun emptyDraft_showsPlus() {
        assertEquals(PrimaryMode.PLUS, primaryModeFor("", hasImage = false, padOpen = false))
        assertEquals(PrimaryMode.PLUS, primaryModeFor("   \n ", hasImage = false, padOpen = false))
    }

    @Test
    fun typedText_switchesToSend() {
        assertEquals(PrimaryMode.SEND, primaryModeFor("你好", hasImage = false, padOpen = false))
    }

    @Test
    fun imageAlone_isSendable_withoutAnyText() {
        assertEquals(PrimaryMode.SEND, primaryModeFor("", hasImage = true, padOpen = false))
    }

    @Test
    fun openPad_winsOverEverything_includingALongDraft() {
        assertEquals(PrimaryMode.CLOSE, primaryModeFor("已经打了很多字", hasImage = true, padOpen = true))
    }

    @Test
    fun compositionOnlyText_isNotSendable() {
        // "nihao" 是还没上屏的拼音：整段都在 composition 里 ⇒ 没有已上屏文本。
        val text = "nihao"
        assertEquals("", committedText(text, 0, text.length))
        assertEquals(PrimaryMode.PLUS, primaryModeFor(committedText(text, 0, text.length), hasImage = false, padOpen = false))
    }

    @Test
    fun compositionAfterCommittedText_keepsOnlyTheCommittedPart() {
        // 已经上屏 "你好" + 正在组词 "shijie"：已上屏部分非空 ⇒ 可以发送“你好”。
        val text = "你好shijie"
        assertEquals("你好", committedText(text, 2, text.length))
    }

    @Test
    fun committedTextWithoutComposition_isTheWholeText() {
        assertEquals("你好", committedText("你好", -1, -1))
        assertEquals("你好", committedText("你好", 3, 3))
    }

    @Test
    fun compositionRangeIsClamped_toTheText() {
        // 区间越界：结束点夹到文本长度（开始点是合法下标）。
        assertEquals("ab", committedText("ab", 2, 99))
        // 非法的 composition 区间（负下标/倒置）一律当“没有组词区” ⇒ 整段文本都算已上屏。
        assertEquals("abc", committedText("abc", -5, 1))
        assertEquals("abc", committedText("abc", 2, 1))
    }
}
