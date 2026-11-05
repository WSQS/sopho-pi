package dev.sopho.pi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sopho.pi.AppState

@Composable
fun TopBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Tokens.panel)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (onBack != null) {
            Text(
                text = "‹ 返回",
                style = MaterialTheme.typography.bodySmall,
                color = Tokens.accent,
                modifier = Modifier.clickable { onBack() }.padding(end = 4.dp),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = Tokens.bright,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        actions()
    }
}

@Composable
fun ActionButton(label: String, accent: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val color = when {
        !enabled -> Tokens.slotDark
        accent -> Tokens.accent
        else -> Tokens.slotIdle
    }
    Box(
        modifier = Modifier
            .slot(color)
            .background(Tokens.raised)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 10.dp, vertical = 7.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = if (enabled) Tokens.text else Tokens.muted,
        )
    }
}

@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        enabled = enabled,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = Tokens.text),
        cursorBrush = SolidColor(Tokens.accent),
        modifier = Modifier
            .fillMaxWidth()
            .slot(if (value.isBlank()) Tokens.slotIdle else Tokens.slotUser)
            .background(Tokens.panel)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        decorationBox = { innerTextField ->
            Box {
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        style = MaterialTheme.typography.bodyMedium,
                        color = Tokens.muted,
                    )
                }
                innerTextField()
            }
        },
    )
}

/** 多行输入（发送框用）：允许换行，高度自增到外层 `heightIn` 的上限。 */
@Composable
fun MultiLineField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = Tokens.text),
        cursorBrush = SolidColor(Tokens.accent),
        modifier = Modifier.fillMaxWidth(),
        decorationBox = { innerTextField ->
            Box {
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        style = MaterialTheme.typography.bodyMedium,
                        color = Tokens.muted,
                    )
                }
                innerTextField()
            }
        },
    )
}

/** 一条「槽 + 文字」的提示行（notice / 错误 / 限制说明都走它，不另造外观）。 */
@Composable
fun NoticeLine(text: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .slot(color)
            .background(Tokens.panel)
            .padding(horizontal = 9.dp, vertical = 6.dp),
    ) {
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = Tokens.text)
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = Tokens.muted,
        modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
    )
}

/**
 * 回执色（与详情页那四处逐字一致的表，抽出来给二级页复用；**不另造一套配色**）。
 * 语义不变：正常=已接受、警示=结果不确定/需注意、错误=确定没做成。
 */
fun receiptColor(tone: AppState.ReceiptTone): Color = when (tone) {
    AppState.ReceiptTone.OK -> Tokens.slotSuccess
    AppState.ReceiptTone.WARN -> Tokens.slotWarning
    AppState.ReceiptTone.ERROR -> Tokens.slotError
    AppState.ReceiptTone.NONE -> Tokens.slotIdle
}
