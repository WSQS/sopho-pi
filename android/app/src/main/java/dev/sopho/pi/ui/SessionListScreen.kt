package dev.sopho.pi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sopho.pi.AppState
import dev.sopho.pi.net.SessionRow

/** 每层缩进多少 dp：窄屏上 6 层（`SessionForest.MAX_DEPTH`）后不再缩进，正文还剩得下字。 */
private const val INDENT_DP = 10

@Composable
fun SessionListScreen(state: AppState) {
    Column(modifier = Modifier.fillMaxSize().background(Tokens.bg)) {
        TopBar(
            title = "会话",
            subtitle = "${state.selectedProfileName} · ${state.connectedModeLabel} · ${state.connectedServerUrl}",
            actions = {
                // B1：业主报「列表没有创建会话」⇒ 这里是常驻入口（强调色，一眼看得到）。
                ActionButton("＋ 新建", accent = true) { state.toggleCreateForm() }
                ActionButton("刷新") { state.refreshTree() }
                ActionButton("退出") { state.disconnect() }
            },
        )
        val entries = state.treeEntries
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // 归档开关：只筛“展示”，不动服务端归档态（本应用没有归档写口）。
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = (if (state.showArchived) "☑" else "☐") + " 显示归档会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (state.showArchived) Tokens.bright else Tokens.muted,
                    modifier = Modifier
                        .clickable { state.updateShowArchived(!state.showArchived) }
                        .padding(vertical = 4.dp),
                )
                Text(
                    text = if (state.showArchived) {
                        "（已含归档）"
                    } else if (state.hiddenArchivedCount > 0) {
                        "（已隐藏 ${state.hiddenArchivedCount} 条归档）"
                    } else {
                        "（没有归档）"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                )
            }
            // 列表是不是「活的」只照服务端事实说：已连接 / 未连接（重试中）/ 已请求停止。
            // 它不冒充“零延迟”：一帧事件到界面要经过一次**合并后**的 `GET /api/tree`（见 `AppState.startTreeLive`）。
            Text(
                text = "列表实时：" + state.treeStreamStatus,
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
            state.listNotice?.let { NoticeLine(it, Tokens.slotError) }
            // 创建回执不放在表单里：成功时表单会关上，回执必须还能看见。
            state.createReceipt?.let { NoticeLine(it, receiptColor(state.createReceiptTone)) }
            if (state.createOpen) CreateSessionForm(state)
            if (entries.isEmpty() && !state.listLoading) {
                Text(
                    text = when {
                        state.sessions.isEmpty() -> "暂无会话（/api/tree 回的是空数组）"
                        state.hiddenArchivedCount > 0 ->
                            "没有未归档会话；另有 ${state.hiddenArchivedCount} 条归档已隐藏 —— 打开上面的「显示归档会话」可查看"
                        else -> "暂无会话"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Tokens.muted,
                )
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 10.dp,
                end = 10.dp,
                bottom = 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            items(entries, key = { it.row.id }) { entry ->
                SessionRowItem(entry.row, entry.depth, entry.promoted) { state.open(entry.row) }
            }
        }
    }
}

@Composable
private fun SessionRowItem(row: SessionRow, depth: Int, promoted: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            // 缩进只缩这张卡片（左槽跟着走），所以左槽与状态始终贴在行首、层级也看得出来。
            .padding(start = (depth * INDENT_DP).dp)
            .slot(sessionSlot(row.status, row.archived))
            .background(Tokens.panel)
            .clickable { onClick() }
            .padding(start = 10.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
    ) {
        // 每行**只有一行**（业主 2026-10-23 裁定）：长名靠 ellipsis；**没有** cwd 副行；
        // 「父已隐藏，已提升」也不许撑出第二行 —— 用一个行内小记号承担，语义写在无障碍描述里。
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (promoted) {
                Text(
                    text = "↑",
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                    modifier = Modifier.semantics { contentDescription = "父已隐藏，已提升" },
                )
            }
            Text(
                text = row.displayName,
                style = MaterialTheme.typography.bodyMedium,
                color = Tokens.bright,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (row.archived) "归档" else row.statusLabel,
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
                maxLines = 1,
            )
        }
    }
}

/**
 * 新建会话表单（B1）：名称 ＋ **服务器**上的工作目录（或勾「用服务器临时目录」）。
 *
 * 两句最容易被误读的事写在界面上（不是只写在文档里）：
 * 1) 这个目录是**服务器**上的路径，不是这台手机上的 —— App 不猜、也不写死任何本机路径；
 * 2) 只建**空**会话，不会替你发任何任务（也没有「已回答」这回事）。
 */
@Composable
private fun CreateSessionForm(state: AppState) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel("新建会话（只在服务器上建一个空会话，不会替你发任务）")
        Field(
            value = state.createName,
            onValueChange = { state.onCreateNameChange(it) },
            placeholder = "会话名称（可空）",
            enabled = !state.creating,
        )
        Field(
            value = state.createCwd,
            onValueChange = { state.onCreateCwdChange(it) },
            placeholder = "服务器工作目录（绝对路径，不是手机目录）",
            enabled = !state.creating && !state.createScratch,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = (if (state.createScratch) "☑" else "☐") + " 用服务器临时目录",
                style = MaterialTheme.typography.bodySmall,
                color = if (state.createScratch) Tokens.bright else Tokens.muted,
                modifier = Modifier
                    .clickable(enabled = !state.creating) { state.updateCreateScratch(!state.createScratch) }
                    .padding(vertical = 4.dp),
            )
            Text(
                text = "（目录由服务端自己新建）",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
        Text(
            text = "目录填的是「服务器」上的路径（不是这台手机上的）；留空＝服务器的默认目录。" +
                "App 不猜目录、也不写死任何本机路径。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionButton(
                label = if (state.creating) "创建中…" else "创建空会话",
                accent = true,
                enabled = !state.creating,
            ) { state.createSession() }
            ActionButton("取消", enabled = !state.creating) { state.closeCreateForm() }
        }
    }
}
