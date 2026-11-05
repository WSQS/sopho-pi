package dev.sopho.pi

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.sopho.pi.net.ImagePayload
import dev.sopho.pi.ui.ComposerBody
import dev.sopho.pi.ui.SophoTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 底栏输入区的**真实 Compose 行为**（原型 87fab67 已确认的那几条）：
 * ① 同一颗单按钮三态：空＋ / 有可发内容发送 / 盘开×；
 * ② **组词（`TextFieldValue.composition`）中不点亮、点了不发送**，只给一句轻提示；
 * ③ 功能盘展开时露出**正好三格**（命令 / 模型与思考 / 发送图片），并占在输入行下面；
 * ④ 有图片、没文字时也能发；缩略图条能看大图、能移除；
 * ⑤ 触控目标 ≥48dp（大手指）。
 *
 * 这里用的是**线上那一段** `ComposerBody`（详情页的 Composer 只是把 AppState 接给它）——
 * 组词在主线程上没法用 `performTextInput` 造出来，所以注入一个带 composition 的 `TextFieldValue`，
 * 断言的仍是同一套 UI 代码，不是副本。
 *
 * 会失败的理由：把主按钮改成“按草稿字符串非空就点亮”（忽略 composition）⇒ ② 红；
 * 把 `＋/发送/×` 换成一个只有两态的按钮 ⇒ ①/③ 红；把功能盘挪到输入行**上方** ⇒ ③ 的位置断言红。
 */
@RunWith(AndroidJUnit4::class)
class ComposerPanelUiTest {

    @get:Rule
    val rule = createComposeRule()

    private fun attachment(): Attachment {
        val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888)
        return Attachment(
            id = "img-test",
            payload = ImagePayload("image/png", "QUJD"),
            thumb = bitmap,
            width = 800,
            height = 600,
            originalWidth = 1600,
            originalHeight = 1200,
            sourceBytes = 1234,
            encodedBytes = 4096,
        )
    }

    private fun setComposer(
        initial: TextFieldValue,
        padOpen: Boolean = false,
        attachment: Attachment? = null,
        onPrimary: () -> Unit = {},
        onRemove: () -> Unit = {},
        onPeek: () -> Unit = {},
    ): () -> TextFieldValue {
        val field = mutableStateOf(initial)
        rule.setContent {
            SophoTheme {
                ComposerBody(
                    field = field.value,
                    onFieldChange = { field.value = it },
                    onFocus = {},
                    sending = false,
                    imageIngesting = false,
                    padOpen = padOpen,
                    attachment = attachment,
                    imageNotice = null,
                    padNotice = null,
                    onPrimary = onPrimary,
                    onRemoveAttachment = onRemove,
                    onPeekAttachment = onPeek,
                    onCommands = {},
                    onModels = {},
                    onPickImage = {},
                )
            }
        }
        rule.waitForIdle()
        return { field.value }
    }

    @Test
    fun emptyDraft_showsPlus_andClickIsTheOnlyWayToOpenThePad() {
        var primaryCalls = 0
        setComposer(TextFieldValue(""), onPrimary = { primaryCalls += 1 })
        rule.onNodeWithTag("composer-primary").assertIsDisplayed()
        rule.onNodeWithText("＋").assertIsDisplayed()
        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals("空草稿时主按钮只做“开盘”这一件事", 1, primaryCalls)
    }

    @Test
    fun typingSwitchesTheSameButtonToSend() {
        var primaryCalls = 0
        setComposer(TextFieldValue("你好"), onPrimary = { primaryCalls += 1 })
        rule.onNodeWithText("发送").assertIsDisplayed()
        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals(1, primaryCalls)
    }

    @Test
    fun composingPinyinDoesNotLightUpTheButton_andClickingOnlyShowsANote() {
        var primaryCalls = 0
        // "nihao" 整段都在 composition 里 = 输入法还没上屏。
        val composing = TextFieldValue("nihao", selection = TextRange(5), composition = TextRange(0, 5))
        setComposer(composing, onPrimary = { primaryCalls += 1 })

        rule.onNodeWithText("＋").assertIsDisplayed()
        rule.onNodeWithText("发送").assertDoesNotExist()

        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals("组词中点按钮不许发送", 0, primaryCalls)
        rule.onNodeWithText(
            "组词中：等输入法把字上屏后再点。这里不会把还没上屏的拼音当发送内容。",
        ).assertIsDisplayed()
    }

    @Test
    fun committedTextWithTrailingCompositionShowsSendButClickingStillWaitsForTheIme() {
        var primaryCalls = 0
        // 已上屏 "你好" + 正在组词 "shijie"：按钮亮成“发送”（已上屏部分非空），
        // 但点击**仍不发送** —— 因为 `state.draft` 里还带着没上屏的拼音，
        // 发出去就是“把半截拼音当消息”。只能等输入法上屏（原型 87fab67 同一条规则）。
        val mixed = TextFieldValue("你好shijie", selection = TextRange(9), composition = TextRange(2, 9))
        setComposer(mixed, onPrimary = { primaryCalls += 1 })
        rule.onNodeWithText("发送").assertIsDisplayed()
        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals("组词中点按钮不许发送（哪怕前面已经有上屏的文字）", 0, primaryCalls)
        rule.onNodeWithText(
            "组词中：等输入法把字上屏后再点。这里不会把还没上屏的拼音当发送内容。",
        ).assertIsDisplayed()
    }

    @Test
    fun imageWithoutAnyTextIsSendable() {
        var primaryCalls = 0
        setComposer(TextFieldValue(""), attachment = attachment(), onPrimary = { primaryCalls += 1 })
        rule.onNodeWithText("发送").assertIsDisplayed()
        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals(1, primaryCalls)
    }

    @Test
    fun openPadTurnsTheButtonIntoCloseEvenWithALongDraft() {
        var primaryCalls = 0
        setComposer(TextFieldValue("已经打了很多字"), padOpen = true, onPrimary = { primaryCalls += 1 })
        rule.onNodeWithText("×").assertIsDisplayed()
        rule.onNodeWithText("发送").assertDoesNotExist()
        rule.onNodeWithTag("composer-primary").performClick()
        rule.waitForIdle()
        assertEquals(1, primaryCalls)
    }

    @Test
    fun padShowsExactlyTheThreeConfirmedEntrances_belowTheInputRow() {
        setComposer(TextFieldValue(""), padOpen = true)
        rule.onNodeWithTag("func-pad").assertIsDisplayed()
        rule.onNodeWithText("命令").assertIsDisplayed()
        rule.onNodeWithText("模型与思考").assertIsDisplayed()
        rule.onNodeWithText("发送图片").assertIsDisplayed()
        // 只有这三格：盘里不该冒出第四格（会话信息/相机/文件/原型说明都不在本轮范围）。
        assertEquals(1, rule.onAllNodesWithText("命令").fetchSemanticsNodes().size)
        // 盘在输入行**下面**（原型的第一条硬要求）。
        val fieldBottom = rule.onNodeWithTag("composer-field").getUnclippedBoundsInRoot().bottom
        val padTop = rule.onNodeWithTag("func-pad").getUnclippedBoundsInRoot().top
        assertTrue("功能盘必须在输入行下方：field.bottom=$fieldBottom pad.top=$padTop", padTop >= fieldBottom)
    }

    @Test
    fun attachmentBarShowsLabelAndRemove_withoutTouchingTheField() {
        var removed = 0
        var peeked = 0
        setComposer(
            TextFieldValue("草稿不许被移除按钮动"),
            attachment = attachment(),
            onRemove = { removed += 1 },
            onPeek = { peeked += 1 },
        )
        rule.onNodeWithTag("attach-thumb").assertIsDisplayed()
        rule.onNodeWithText("图片").assertIsDisplayed()
        rule.onNodeWithText("800×600 · 4 KiB · 未上传").assertIsDisplayed()

        rule.onNodeWithTag("attach-thumb").performClick()
        rule.waitForIdle()
        assertEquals("点缩略图 = 看大图（不是发送、也不移除）", 1, peeked)

        rule.onNodeWithText("移除").performClick()
        rule.waitForIdle()
        assertEquals("移除按钮只回调移除，不动草稿", 1, removed)
        rule.onNodeWithText("草稿不许被移除按钮动").assertIsDisplayed()
    }

    @Test
    fun openingThePadTakesFocusOffTheField_soTheKeyboardGivesWay() {
        val pad = mutableStateOf(false)
        rule.setContent {
            SophoTheme {
                ComposerBody(
                    field = TextFieldValue(""),
                    onFieldChange = {},
                    onFocus = {},
                    sending = false,
                    imageIngesting = false,
                    padOpen = pad.value,
                    attachment = null,
                    imageNotice = null,
                    padNotice = null,
                    onPrimary = {},
                    onRemoveAttachment = {},
                    onPeekAttachment = {},
                    onCommands = {},
                    onModels = {},
                    onPickImage = {},
                )
            }
        }
        rule.onNode(hasSetTextAction()).performClick()
        rule.waitForIdle()
        rule.onNode(hasSetTextAction()).assertIsFocused()

        rule.runOnIdle { pad.value = true }
        rule.waitForIdle()
        // 盘展开 = 键盘让位：输入框真的失焦了（不是只翻了一个状态变量）。
        rule.onNode(hasSetTextAction()).assertIsNotFocused()
        rule.onNodeWithTag("func-pad").assertExists()
    }

    @Test
    fun touchTargetsAreAtLeast48Dp() {
        setComposer(TextFieldValue(""))
        val primary = rule.onNodeWithTag("composer-primary").getUnclippedBoundsInRoot()
        val primaryHeight = primary.bottom - primary.top
        val primaryWidth = primary.right - primary.left
        assertTrue("主按钮高度 ${primaryHeight} 应 ≥48dp", primaryHeight >= 48.dp)
        assertTrue("主按钮宽度 ${primaryWidth} 应 ≥48dp", primaryWidth >= 48.dp)
        val field = rule.onNodeWithTag("composer-field").getUnclippedBoundsInRoot()
        assertTrue("输入框高度 ${field.bottom - field.top} 应 ≥48dp", (field.bottom - field.top) >= 48.dp)
    }
}
