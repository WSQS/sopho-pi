package dev.sopho.pi.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 唯一一套调色板：逐值抄自 `web/index.html` 的 `:root` 与 `web/slot.css` 的 `:root`。
 * 安卓屏**不另造外观**（见 items/android-client/item.md：v0 沿用现有设计语言，不做第二套规格）。
 */
object Tokens {
    val bg = Color(0xFF0F1013)
    val panel = Color(0xFF121318)
    val raised = Color(0xFF16171C)
    val line = Color(0xFF292B31)
    val muted = Color(0xFF7C7F8A)
    val text = Color(0xFFC7C9CF)
    val bright = Color(0xFFE3E8E4)
    val accent = Color(0xFF8ABEB7)
    val danger = Color(0xFFE06868)

    // web/slot.css 的语义色
    val slotIdle = Color(0xFF4D5058)
    val slotWorking = Color(0xFF7BC47F)
    val slotUnread = Color(0xFFD65D5D)
    val slotDark = Color(0xFF292B31)
    val slotUser = Color(0xFF8ABEB7)
    val slotAssistant = Color(0xFFC7C9CF)
    val slotSuccess = Color(0xFF7BC47F)
    val slotError = Color(0xFFE06868)
    val slotWarning = Color(0xFFD8B45A)
    val slotExtra = Color(0xFF9B79B8)
    val slotPending = Color(0xFF7F9BAF)
}

val Mono = FontFamily.Monospace

/** v2.2 的共享左槽原语：1px 其余边 ＋ 贴最左 3px 语义色槽。 */
fun Modifier.slot(color: Color): Modifier = this
    .border(1.dp, Tokens.line, RoundedCornerShape(2.dp))
    .drawBehind {
        drawRect(
            color = color,
            topLeft = Offset.Zero,
            size = Size(3.dp.toPx(), size.height),
        )
    }

fun sessionSlot(status: String, archived: Boolean): Color = when {
    archived -> Tokens.slotDark
    status == "working" -> Tokens.slotWorking
    status == "unread" -> Tokens.slotUnread
    else -> Tokens.slotIdle
}

fun roleSlot(role: String): Color = when (role) {
    "user" -> Tokens.slotUser
    "assistant" -> Tokens.slotAssistant
    "extra" -> Tokens.slotExtra
    else -> Tokens.slotIdle
}

@Composable
fun SophoTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = Tokens.bg,
            surface = Tokens.panel,
            onSurface = Tokens.text,
            onBackground = Tokens.text,
            primary = Tokens.accent,
            onPrimary = Tokens.bg,
            error = Tokens.danger,
        ),
        typography = Typography(
            titleMedium = TextStyle(fontFamily = Mono, fontSize = 15.sp),
            bodyMedium = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp),
            bodySmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp),
            labelSmall = TextStyle(fontFamily = Mono, fontSize = 11.sp, lineHeight = 15.sp),
        ),
        content = content,
    )
}
