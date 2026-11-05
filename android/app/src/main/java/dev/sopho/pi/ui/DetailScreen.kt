package dev.sopho.pi.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sopho.pi.AppState
import dev.sopho.pi.Attachment
import dev.sopho.pi.Panel
import dev.sopho.pi.net.MessageImage
import dev.sopho.pi.net.MessageRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun DetailScreen(state: AppState) {
    val row = state.current ?: return

    // 二级页（命令 / 模型与思考）：整屏独占；返回键先关它们（由各自 composable 里的 BackHandler 注册）。
    when (state.panel) {
        Panel.COMMANDS -> {
            CommandScreen(state)
            return
        }

        Panel.SETTINGS -> {
            ModelSettingsScreen(state)
            return
        }

        null -> Unit
    }

    BackHandler { state.backToList() }

    val sessionKey = row.id
    val listState = rememberLazyListState()

    // ── 滚动归属：粘着底边，还是用户自己停在历史里 ──
    // 「是否粘住底边」只在**方向明确**时改：手指把内容往上翻、或惯性还在往下翻 ⇒ 松手；
    // 已经滚到最底 ⇒ 重新粘住。它不能由「最后一条是否可见」推：流式增量让**同一条**变长时最后一条一直可见、
    // 120 条截断后条数也不变 —— 这两种情况 `messages.size` / `itemCount` 的效应都看不见。
    // 按会话重来（`remember(sessionKey)`）：从列表重新点进来 ⇒ 回到「粘住」并重新定位到底。
    var stuck by remember(sessionKey) { mutableStateOf(true) }
    val dragged by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(sessionKey, listState) {
        snapshotFlow { dragged to listState.canScrollForward }
            .collect { (dragging, canForward) ->
                when {
                    // 底边（含列表尾部内边距）已经到视口：无论谁滚到这里都重新粘上，跟随要能自己续上。
                    !canForward -> stuck = true
                    // 手指正在上翻：立刻松手，别跟流式增量抢位置。
                    dragging -> stuck = false
                }
            }
    }
    // 跟随：粘着时，布局每变一次就把「末条的底边」对齐到视口底边。
    // 判据是布局给的 `canScrollForward`（还能不能往下翻），不是条数：同一条变长也会被它看见。
    LaunchedEffect(sessionKey, stuck) {
        if (!stuck) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo }.collect {
            if (listState.canScrollForward) snapToContentBottom(listState)
        }
    }
    // 发送之后把视线带回底部（不然刚发的那一句可能在屏外）：这是一次明确的用户意图 ⇒ 重新粘到底边。
    LaunchedEffect(state.sendReceipt, state.sending) {
        if (state.sending) stuck = true
    }

    // 大图预览：点缩略图/正文里的图才开；不是“选图页”，只有关闭。
    var peek by remember(sessionKey) { mutableStateOf<Bitmap?>(null) }
    var peekCaption by remember(sessionKey) { mutableStateOf("未上传") }

    Column(modifier = Modifier.fillMaxSize().background(Tokens.bg).imePadding()) {
        TopBar(
            title = row.displayName,
            subtitle = row.cwd ?: "（无 cwd）",
            onBack = { state.backToList() },
            actions = { ActionButton("重拉") { state.reloadMessages() } },
        )

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${state.selectedProfileName} · ${state.connectedModeLabel}", style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
                Text(state.streamStatus, style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
                Text(
                    text = if (state.agentBusy) "· 这一轮在跑（发送＝插话）" else "· 空闲（发送＝新消息）",
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                )
            }
            state.historyNotice?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
            }
            // 会话瞬时通知（`session.notice`）：服务端只发给**在线**的 SSE 订阅者、不落盘 ⇒ 断线期间的不补发。
            // 点一下收起（不堆叠、不永久占位）。
            state.notices.forEach { notice ->
                val color = when (notice.level) {
                    "error" -> Tokens.slotError
                    "warn", "warning" -> Tokens.slotWarning
                    else -> Tokens.slotIdle
                }
                NoticeLine(
                    text = notice.text + "　（瞬时通知 · 不落盘；断线期间的不补发 · 点这一行收起）",
                    color = color,
                    modifier = Modifier.clickable { state.dismissNotice(notice.id) },
                )
            }
            state.detailError?.let { NoticeLine(it, Tokens.slotError) }
        }

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            state = listState,
            contentPadding = PaddingValues(start = 10.dp, end = 10.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(state.messages, key = { it.entryId.ifEmpty { it.timestamp ?: it.hashCode().toString() } }) { message ->
                MessageCard(
                    message,
                    onPeek = { bitmap, caption ->
                        peek = bitmap
                        peekCaption = caption
                    },
                )
            }
            state.liveText?.let { live ->
                item(key = "live") {
                    MessageCard(
                        MessageRow(
                            entryId = "live",
                            role = "assistant",
                            text = live,
                            timestamp = null,
                        ),
                        live = true,
                    )
                }
            }
        }

        // 发送回执：202 只说“接受”，失败说“没发出去/草稿保留”，超时说“结果未知、别自动重发”。
        state.sendReceipt?.let { receipt ->
            val color = when (state.sendReceiptTone) {
                AppState.ReceiptTone.OK -> Tokens.slotSuccess
                AppState.ReceiptTone.WARN -> Tokens.slotWarning
                AppState.ReceiptTone.ERROR -> Tokens.slotError
                AppState.ReceiptTone.NONE -> Tokens.slotIdle
            }
            NoticeLine(receipt, color, modifier = Modifier.padding(horizontal = 10.dp))
        }

        Composer(
            state = state,
            onPeekAttachment = {
                state.attachment?.let { current ->
                    peek = current.thumb
                    peekCaption = "本地图片 · ${current.label} · 未上传"
                }
            },
        )
    }

    peek?.let { bitmap ->
        PeekOverlay(
            bitmap = bitmap,
            caption = peekCaption,
            onClose = { peek = null },
        )
    }
}

/** 点缩略图/正文图片才有的大图：铺满、只有 ×（还有系统返回键）。绝不是选图页。 */
@Composable
private fun PeekOverlay(bitmap: Bitmap, caption: String, onClose: () -> Unit) {
    // 后注册的 BackHandler 先拿到返回键：大图开着时返回键先关大图，不会直接退出详情页。
    BackHandler { onClose() }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Tokens.bg.copy(alpha = 0.96f))
            .testTag("peek"),
    ) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = "待发送图片大图",
            modifier = Modifier.fillMaxSize().padding(16.dp),
            contentScale = ContentScale.Fit,
        )
        Text(
            text = caption,
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp),
        )
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(10.dp)
                .size(48.dp)
                .slot(Tokens.slotIdle)
                .background(Tokens.raised)
                .clickable { onClose() }
                .testTag("peek-close"),
            contentAlignment = Alignment.Center,
        ) {
            Text("×", style = MaterialTheme.typography.bodyMedium, color = Tokens.bright)
        }
    }
}

/** 主按钮的三种态（同一颗节点只换外观与行为）：空＋ / 有可发内容发送 / 盘开×。 */
enum class PrimaryMode { PLUS, SEND, CLOSE }

/**
 * 主按钮**该显示什么** —— 纯逻辑，JVM 单测直接钉。
 *
 * `committedText` 必须是**已经上屏**的那部分（组词中的拼音不算，见 [committedText]）：
 * 没上屏的文字不是可发送内容，否则点一下就把半截拼音发出去。
 */
fun primaryModeFor(committedText: String, hasImage: Boolean, padOpen: Boolean): PrimaryMode = when {
    padOpen -> PrimaryMode.CLOSE
    committedText.isNotBlank() || hasImage -> PrimaryMode.SEND
    else -> PrimaryMode.PLUS
}

/**
 * 输入框里“已经上屏”的文本：把 composition 区间（中文输入法还没上屏的拼音/候选）摘掉。
 *
 * Compose 的 `TextFieldValue.composition` 就是 IME 的 composing region；它非空时 `text` 里已经有
 * 那些拼音字符，但用户并没有“输入完成”。本函数把这段剪掉 ⇒ 主按钮不会被半截拼音点亮。
 */
fun committedText(text: String, compositionStart: Int, compositionEnd: Int): String {
    if (compositionStart < 0 || compositionEnd <= compositionStart) return text
    val start = compositionStart.coerceIn(0, text.length)
    val end = compositionEnd.coerceIn(start, text.length)
    return text.removeRange(start, end)
}

/** 底部输入区：附件条 → 输入框 ＋ 右侧同位单按钮 → 功能盘（三格）。 */
@Composable
private fun Composer(state: AppState, onPeekAttachment: () -> Unit) {
    val sessionKey = state.current?.id ?: ""

    // TextFieldValue（不是 String）：要读 composition，才能做到“组词中不误发”。
    var field by remember(sessionKey) { mutableStateOf(TextFieldValue(state.draft)) }
    // 外部改草稿（发送成功清空）要反映到输入框；组词中不打断 IME。
    LaunchedEffect(state.draft) {
        if (field.composition == null && state.draft != field.text) {
            field = TextFieldValue(state.draft, TextRange(state.draft.length))
        }
    }

    // 盘展开 ⇒ 键盘收起那条 `LaunchedEffect` 在 [ComposerBody] 里（离那片 UI 更近，
    // 也让仪表化用例能真的验“盘展开 ⇒ 输入框失焦”）。

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        // 取消（null）什么都不改：草稿、已有图片、回执都不动。
        if (uri != null) state.onImagePicked(uri)
    }

    ComposerBody(
        field = field,
        onFieldChange = { next ->
            field = next
            state.onDraftChange(next.text)
        },
        onFocus = { state.onComposerFocus() },
        sending = state.sending,
        imageIngesting = state.imageIngesting,
        padOpen = state.padOpen,
        attachment = state.attachment,
        imageNotice = state.imageNotice,
        padNotice = state.padNotice,
        onPrimary = {
            when (primaryModeFor(committedTextOf(field), state.attachment != null, state.padOpen)) {
                PrimaryMode.CLOSE -> state.closePad()
                PrimaryMode.PLUS -> state.togglePad()
                PrimaryMode.SEND -> state.send()
            }
        },
        onRemoveAttachment = { state.removeAttachment() },
        onPeekAttachment = onPeekAttachment,
        onCommands = { state.openCommandPanel() },
        onModels = { state.openModelPanel() },
        onPickImage = {
            // 同一手势里直接开系统选图器（无 setTimeout）；选完由 picker 回调收盘回聊天。
            state.closePad()
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
    )
}

/** `TextFieldValue` → 已上屏文本（组词区间剪掉）。见 [committedText] 的注释。 */
fun committedTextOf(field: TextFieldValue): String = committedText(
    field.text,
    field.composition?.start ?: -1,
    field.composition?.end ?: -1,
)

/**
 * 输入区的**本体**（状态全部由调用方持有）。
 *
 * 拆出来是为了让仪表化用例能用真 Compose 去驱动它：组词（`TextFieldValue.composition`）
 * 在主线程上没法用 `performTextInput` 造出来，但可以用这个**同一个** composable 注入一个带
 * composition 的 `TextFieldValue` —— 断言的就是线上那一段代码，不是副本。
 *
 * 键盘与功能盘**互斥**也在这里：盘一展开就 `clearFocus()` ＋ `hide()` 键盘（两者占同一块地方），
 * 点回输入框就收盘（由调用方的 `onFocus` 接）。
 */
@Composable
internal fun ComposerBody(
    field: TextFieldValue,
    onFieldChange: (TextFieldValue) -> Unit,
    onFocus: () -> Unit,
    sending: Boolean,
    imageIngesting: Boolean,
    padOpen: Boolean,
    attachment: Attachment?,
    imageNotice: String?,
    padNotice: String?,
    onPrimary: () -> Unit,
    onRemoveAttachment: () -> Unit,
    onPeekAttachment: () -> Unit,
    onCommands: () -> Unit,
    onModels: () -> Unit,
    onPickImage: () -> Unit,
) {
    // 组词中点主按钮的轻提示（不是回执、不产生发送）。
    var composeNote by remember { mutableStateOf<String?>(null) }

    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    // 盘展开 ⇒ 键盘收起（两者占同一块地方）。收起只收盘，不动草稿与焦点。
    LaunchedEffect(padOpen) {
        if (padOpen) {
            focus.clearFocus()
            keyboard?.hide()
        }
    }

    val composition = field.composition
    val committed = committedTextOf(field)
    val mode = primaryModeFor(committed, attachment != null, padOpen)
    val composing = composition != null && composition.collapsed.not()

    Column(modifier = Modifier.fillMaxWidth().background(Tokens.panel)) {
        // 输入行上方的图片预览（图文同在；移除不动草稿）。
        attachment?.let { current ->
            AttachBar(
                attachment = current,
                onPeek = onPeekAttachment,
                onRemove = onRemoveAttachment,
            )
        }
        imageNotice?.let { NoticeLine(it, Tokens.slotWarning, Modifier.padding(horizontal = 10.dp, vertical = 4.dp)) }
        composeNote?.let { NoticeLine(it, Tokens.slotWarning, Modifier.padding(horizontal = 10.dp, vertical = 4.dp)) }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp, max = 122.dp)
                    .testTag("composer-field")
                    .slot(Tokens.slotUser)
                    .background(Tokens.raised)
                    .padding(horizontal = 9.dp, vertical = 8.dp),
            ) {
                BasicTextField(
                    value = field,
                    onValueChange = { next ->
                        composeNote = null
                        onFieldChange(next)
                    },
                    enabled = !sending,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = Tokens.text),
                    cursorBrush = SolidColor(Tokens.accent),
                    modifier = Modifier
                        .fillMaxWidth()
                        .onFocusChanged { if (it.isFocused) onFocus() },
                    decorationBox = { innerTextField ->
                        Box {
                            if (field.text.isEmpty()) {
                                Text(
                                    text = "在这里输入文本（Enter 换行）；图片只在你点发送时才提交",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = Tokens.muted,
                                )
                            }
                            innerTextField()
                        }
                    },
                )
            }
            PrimaryButton(
                mode = mode,
                busy = sending || imageIngesting,
                onClick = {
                    if (composing) {
                        // 组词中：只说一句，不发送、不产生回执（未上屏的文字不当可发送文本）。
                        composeNote = "组词中：等输入法把字上屏后再点。这里不会把还没上屏的拼音当发送内容。"
                    } else {
                        composeNote = null
                        onPrimary()
                    }
                },
            )
        }

        if (padOpen) {
            PadPanel(
                notice = padNotice,
                onCommands = onCommands,
                onModels = onModels,
                onPickImage = onPickImage,
            )
        }
    }
}

/**
 * 右侧那颗**同位单按钮**：同一颗节点、同一 60×48 尺寸，只按状态换字与颜色。
 * 不在输入时重建、不换位置 —— 焦点因此不会掉（Compose 里就是同一个 composable 槽位）。
 */
@Composable
private fun PrimaryButton(mode: PrimaryMode, busy: Boolean, onClick: () -> Unit) {
    val label = when (mode) {
        PrimaryMode.PLUS -> "＋"
        PrimaryMode.SEND -> if (busy) "…" else "发送"
        PrimaryMode.CLOSE -> "×"
    }
    val accent = mode == PrimaryMode.SEND || mode == PrimaryMode.CLOSE
    Box(
        modifier = Modifier
            .width(60.dp)
            .height(48.dp)
            .border(1.dp, if (accent) Tokens.accent else Tokens.line, RoundedCornerShape(2.dp))
            .background(Tokens.raised)
            .clickable { onClick() }
            .testTag("composer-primary"),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium.copy(
                color = if (accent) Tokens.accent else Tokens.bright,
            ),
        )
    }
}

/** 输入行上方的待发图片条：缩略图（点开大图）＋ 说明 ＋ 移除。 */
@Composable
private fun AttachBar(attachment: Attachment, onPeek: () -> Unit, onRemove: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .slot(Tokens.slotUser)
                .background(Tokens.raised)
                .clickable { onPeek() }
                .testTag("attach-thumb"),
        ) {
            Image(
                bitmap = attachment.thumb.asImageBitmap(),
                contentDescription = "待发送图片缩略图（点开看大图）",
                modifier = Modifier.fillMaxSize().padding(1.dp),
                contentScale = ContentScale.Crop,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("图片", style = MaterialTheme.typography.bodySmall, color = Tokens.text)
            Text(
                text = "${attachment.label} · 未上传",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        ActionButton("移除", enabled = true) { onRemove() }
    }
}

/** 功能盘：只放**已确认的三个入口**；它占的是键盘那块地方（明确不是键盘）。 */
@Composable
private fun PadPanel(
    notice: String?,
    onCommands: () -> Unit,
    onModels: () -> Unit,
    onPickImage: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Tokens.panel)
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .testTag("func-pad"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("功能盘 · 不是键盘", style = MaterialTheme.typography.labelSmall, color = Tokens.bright)
            Text(
                "它顶在输入行下面（键盘的位置）；点输入框回到键盘",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PadCell("／", "命令", Modifier.weight(1f), onCommands)
            PadCell("◇", "模型与思考", Modifier.weight(1f), onModels)
            PadCell("▣", "发送图片", Modifier.weight(1f), onPickImage)
        }
        notice?.let { NoticeLine(it, Tokens.slotWarning) }
    }
}

@Composable
private fun PadCell(glyph: String, label: String, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier = modifier
            .height(68.dp)
            .slot(Tokens.slotIdle)
            .background(Tokens.raised)
            .clickable { onClick() }
            .padding(horizontal = 6.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(glyph, style = MaterialTheme.typography.bodyMedium, color = Tokens.accent)
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MessageCard(
    message: MessageRow,
    live: Boolean = false,
    onPeek: (Bitmap, String) -> Unit = { _, _ -> },
) {
    val color = if (live) Tokens.slotPending else roleSlot(message.role)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .slot(color)
            .background(Tokens.panel)
            .padding(start = 10.dp, end = 9.dp, top = 7.dp, bottom = 8.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text = roleLabel(message.role) + if (live) " · 直播中" else "",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // 图片块：**像素来自服务端 content 的 image 块**（不是元数据空壳）。
            // 服务端只给元数据、没给像素时如实写“看不到内容”，不画一个假的框冒充。
            for (index in message.images.indices) {
                MessageImageBlock(
                    image = message.images[index],
                    caption = "消息里的图片 · ${message.images[index].mimeType ?: "类型未知"}",
                    onPeek = onPeek,
                )
            }
            Text(
                text = message.text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (message.role == "user") Tokens.bright else Tokens.text,
            )
        }
    }
}

@Composable
private fun MessageImageBlock(image: MessageImage, caption: String, onPeek: (Bitmap, String) -> Unit) {
    if (!image.canRender) {
        NoticeLine(
            text = "服务端只给了图片元数据（${image.mimeType ?: "类型未知"}，" +
                "${image.bytes?.let { "$it 字节" } ?: "大小未知"}），没有像素 —— 这里看不到内容。",
            color = Tokens.slotWarning,
        )
        return
    }
    val bitmap by produceState<Bitmap?>(initialValue = null, key1 = image.base64) {
        value = withContext(Dispatchers.IO) { decodeBase64Bounded(image.base64!!, 1200) }
    }
    val decoded = bitmap
    if (decoded == null) {
        Text(
            "（这张图片本机解不开，没法显示）",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        return
    }
    val aspect = if (decoded.height > 0) decoded.width.toFloat() / decoded.height else 1f
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 260.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(Tokens.raised)
            .clickable { onPeek(decoded, caption) },
    ) {
        Image(
            bitmap = decoded.asImageBitmap(),
            contentDescription = caption,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(aspect)
                .heightIn(max = 260.dp),
            contentScale = ContentScale.Fit,
        )
    }
}

/** 把 base64 解码成有界位图（先读尺寸再降采样）：不在主线程做，也不解一整张原始大图。 */
private fun decodeBase64Bounded(base64: String, maxEdge: Int): Bitmap? = runCatching {
    val bytes = Base64.decode(base64, Base64.NO_WRAP)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    var longEdge = maxOf(bounds.outWidth, bounds.outHeight)
    while (longEdge / 2 >= maxEdge) {
        longEdge /= 2
        sample *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
}.getOrNull()

private fun roleLabel(role: String): String = when (role) {
    "user" -> "用户"
    "assistant" -> "助手"
    "extra" -> "额外消息"
    else -> role
}

/**
 * 把「最后一条的底边」对齐到视口底边。
 *
 * `scrollToItem(last, 0)` 只对齐**顶边**：末条超过一屏时它的底边还在屏外，读到的最后一段恰好看不见。
 * 这里给 `scrollOffset` 最大值，由布局把它夹到「最后能滚到的地方」（含 `contentPadding` 的底边）。
 * 循环最多三次且在「滚不动」时立刻停：布局没变化就不再来一遍（避免「量一次滚一次」的空转）。
 */
private suspend fun snapToContentBottom(list: LazyListState) {
    repeat(3) {
        val last = list.layoutInfo.totalItemsCount - 1
        if (last < 0 || !list.canScrollForward) return
        val before = list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset
        list.scrollToItem(last, Int.MAX_VALUE)
        if (before == (list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset)) return
    }
}
