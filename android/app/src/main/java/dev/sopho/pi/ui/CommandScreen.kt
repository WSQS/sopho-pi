package dev.sopho.pi.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.sopho.pi.AppState
import dev.sopho.pi.net.CommandFilter
import dev.sopho.pi.net.CommandItem
import dev.sopho.pi.net.CommandRoute
import dev.sopho.pi.net.CommandsSnapshot
import dev.sopho.pi.PendingCompact

/**
 * 命令页（详情页的二**级浮层**，不是新 Screen）。
 *
 * 只画**服务端真给的东西**：
 * - 清单来自 `GET /commands`（打开这一页才拉；失败就说失败 + 重试，不退化成空清单冒充“没有命令”）；
 * - 每条显示名字 / 来源 / 参数提示（没给就写“未知”）/ 能不能执行（不能就把服务端的原因原话摆出来）；
 * - 点可执行条目**只填入输入框**，不发送、不弹窗假装执行；`via=compact|model` 走专用路（确认框 / 模型页）；
 * - 会话在跑/压缩时整页仍可浏览，但每一条都按下发会被拒处理（回执里写清“没有发出去”）。
 */
@Composable
fun CommandScreen(state: AppState) {
    BackHandler { state.closePanel() }
    val snapshot = state.commandSnapshot

    Column(modifier = Modifier.fillMaxSize().background(Tokens.bg)) {
        TopBar(
            title = "命令",
            subtitle = "实时清单（打开这一页才向服务端拉）· 点选只填入，不执行",
            onBack = { state.closePanel() },
            actions = {
                ActionButton(
                    label = if (state.commandsLoading) "加载中…" else "重拉",
                    enabled = !state.commandsLoading,
                ) { state.loadCommands() }
            },
        )

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (snapshot == null) {
                NoticeLine(
                    text = if (state.commandsLoading) {
                        "正在拉取 /commands…（冷会话要先把 runtime 起来，可能要等几秒）"
                    } else {
                        "还没有清单：点右上「重拉」。拿不到清单时命令一律按“清单未知”处理 —— 这是如实说明，不是空清单。"
                    },
                    color = Tokens.slotIdle,
                )
            }
            state.commandsError?.let { NoticeLine(it, Tokens.slotError) }
            snapshot?.let { NoticeLine(describeSnapshot(it), snapshotTone(it)) }
            Field(
                value = state.commandQuery,
                onValueChange = { state.onCommandQueryChange(it) },
                placeholder = "按名字或描述筛（例如 rev / review）",
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CommandFilter.values().forEach { filter ->
                    ActionButton(
                        label = filter.label,
                        accent = state.commandFilter == filter,
                    ) { state.applyCommandFilter(filter) }
                }
            }
            state.commandReceipt?.let { NoticeLine(it, receiptColor(state.commandReceiptTone)) }
            state.pendingCompact?.let { CompactConfirm(state, it) }
        }

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(start = 10.dp, end = 10.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val list = state.visibleCommands
            if (list.isEmpty()) {
                item(key = "empty") {
                    NoticeLine(
                        text = if (snapshot == null) {
                            "没有可显示的清单（还没拿到）。"
                        } else {
                            "没有匹配「${state.commandFilter.label}」+ 查询「${state.commandQuery}」的命令。"
                        },
                        color = Tokens.slotIdle,
                    )
                }
            }
            items(list, key = { it.name }) { item ->
                CommandRow(item) { state.chooseCommand(item) }
            }
            item(key = "foot") {
                Text(
                    text = "点「可填入」只写进输入框（带一个尾空格），不会发送；参数提示服务端没给就写「未知」。" +
                        "不可执行的条目保留服务端给的原因/替代入口，本应用不发明执行方式；" +
                        "/compact 与 /model 是专用命令，必须走确认/专用页，不会当普通消息发出去。",
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

private fun describeSnapshot(snapshot: CommandsSnapshot): String {
    val runState = when (snapshot.runnableNow) {
        true -> "服务端当刻：可以执行命令（canRun=true）"
        false -> "服务端当刻：不能执行命令 —— ${snapshot.blockedReason ?: "canRun=false"}"
        null -> "服务端没给 streaming / compacting / canRun：是否在跑**未知**（不猜）"
    }
    val skipped = if (snapshot.skipped > 0) "；另有 ${snapshot.skipped} 条读不懂，已跳过" else ""
    return "$runState · 收到 ${snapshot.commands.size} 条$skipped"
}

private fun snapshotTone(snapshot: CommandsSnapshot) =
    if (snapshot.runnableNow == false) Tokens.slotWarning else Tokens.slotIdle

/** 一条命令：名字 / 状态标 / 描述 / 来源与参数提示 / 不能执行的原因。 */
@Composable
private fun CommandRow(item: CommandItem, onClick: () -> Unit) {
    val runnable = item.route != CommandRoute.UNAVAILABLE
    val reason = item.refusal
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .slot(if (runnable) Tokens.slotUser else Tokens.slotDark)
            .background(Tokens.panel)
            .clickable { onClick() }
            .padding(start = 10.dp, end = 9.dp, top = 7.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = "/" + item.name + "　" + if (runnable) routeLabel(item) else "不可执行",
            style = MaterialTheme.typography.bodyMedium,
            color = Tokens.bright,
        )
        item.description?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = Tokens.text)
        }
        Text(
            text = "来源：${item.sourceLabel}" + (item.argumentHint?.let { " · 参数：$it" } ?: "") +
                (item.hint?.let { " · $it" } ?: ""),
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        if (reason != null) {
            Text("为什么不能执行：$reason", style = MaterialTheme.typography.labelSmall, color = Tokens.slotWarning)
        }
        item.shadowed?.let { shadow ->
            Text(
                "同名来源：「${shadow.name}」（${shadow.source ?: "来源未给"}）—— 服务端标了 shadowed，以它的字段为准",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
    }
}

private fun routeLabel(item: CommandItem): String = when (item.route) {
    CommandRoute.PROMPT -> "可填入"
    CommandRoute.COMPACT -> "专用：/compact（要确认）"
    CommandRoute.MODEL -> "专用：/model（跳模型页）"
    CommandRoute.UNAVAILABLE -> "不可执行"
}

/** `/compact` 的显式确认（点了才发一次 `POST /compact`；202 只代表“已接受”）。 */
@Composable
private fun CompactConfirm(state: AppState, pending: PendingCompact) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .slot(Tokens.slotWarning)
            .background(Tokens.panel)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text("/compact · 专用命令（via=compact）", style = MaterialTheme.typography.bodyMedium, color = Tokens.bright)
        Text(
            text = "压缩会改写这条会话的上下文（由服务端 pi 自己压）。" +
                "点「确认请求压缩」只代表服务端**收下**这次请求，不代表已经压缩完；结果要看正文/SSE。" +
                (pending.instructions?.let { " 这次会带上说明：$it" } ?: "（没有带说明）"),
            style = MaterialTheme.typography.bodySmall,
            color = Tokens.text,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton(label = "取消") { state.cancelCompact() }
            ActionButton(
                label = if (state.settingsBusy) "忙…" else "确认请求压缩",
                accent = true,
            ) { state.confirmCompact() }
        }
    }
}
