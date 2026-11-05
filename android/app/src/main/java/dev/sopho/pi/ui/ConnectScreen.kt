package dev.sopho.pi.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.sopho.pi.AppState
import dev.sopho.pi.Profile
import dev.sopho.pi.RunMode
import dev.sopho.pi.zt.Moon
import dev.sopho.pi.zt.MoonInput
import dev.sopho.pi.zt.ZtStatus

/**
 * 配置页（Profile v1）：连接设置**按配置保存**，不再散落在界面上。
 *
 * 交互边界（业主本单要求）：
 * - 字段改动只进编辑副本，点「保存」才写盘；有未保存修改时「连接」被拦住（不会默默用旧值连出去）。
 * - 保存 / 选择本身**不联网**（不 start/join/orbit、不发任何请求）；只有「连接」会。
 * - 删除要两段确认；删当前那条会回退到第一条并停在配置页，不自动连接。
 */
@Composable
fun ConnectScreen(state: AppState) {
    val context = LocalContext.current
    var confirmDelete by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("sopho · 配置", style = MaterialTheme.typography.titleMedium, color = Tokens.bright)
        Text(
            "连接设置按配置保存（地址 / 模式 / ZeroTier network / Moon）。只在详情页发送文本；没有停止、压缩、归档、改名。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )

        SectionLabel("配置（● = 当前选中；点一行即切换）")
        if (state.profiles.isEmpty()) {
            Text(
                "还没有配置：点下面的「新建」建一条，或如果是从旧版本升级上来的，迁移应该已经给你建了一条「默认连接」。",
                style = MaterialTheme.typography.bodySmall,
                color = Tokens.muted,
            )
        }
        state.profiles.forEach { profile ->
            ProfileRow(
                profile = profile,
                selected = profile.id == state.selected?.id,
                onClick = {
                    confirmDelete = false
                    state.selectProfile(profile.id)
                },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton("新建") { state.newProfile() }
            ActionButton("保存") { state.saveDraft() }
            ActionButton("放弃修改") { state.discardDraft() }
        }
        state.selected?.let { current ->
            ActionButton(
                label = if (confirmDelete) "确认删除「${current.name}」" else "删除当前配置",
                enabled = state.profiles.size > 1,
            ) {
                if (confirmDelete) {
                    state.deleteProfile(current.id)
                    confirmDelete = false
                } else {
                    confirmDelete = true
                }
            }
        }

        state.profileNotice?.let { NoticeLine(it, Tokens.slotIdle) }
        state.profileError?.let { NoticeLine(it, Tokens.slotError) }
        // 配置读不懂时唯一出口（`rebuildAfterCorrupt` 先备份原串再写）—— 没这个按钮，
        // 错误里说“可以重建”就是一句用户做不到的话。
        if (state.profilesUnreadable) {
            state.recoveryCandidate?.let { candidate ->
                ActionButton("把原串拼成草稿（先不写盘，核对后点保存）") { state.admitRecoveryCandidate() }
                NoticeLine(
                    "候选：按原串能拼回 ${candidate.profiles.size} 条配置；这一步只放进编辑区，profilesRaw 一字不写。",
                    Tokens.slotWarning,
                )
            }
            ActionButton("重建一条默认配置（原内容保留为备份）") { state.rebuildAfterCorrupt() }
        }
        if (state.draftDirty) {
            NoticeLine("有未保存的修改：点「保存」才会写盘；此时「连接」不会用旧值偷偷连出去。", Tokens.slotWarning)
        }

        val draft = state.draftProfile
        if (draft != null) {
            Editor(state = state, draft = draft)
        }

        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionButton(
                label = if (state.busy) "连接中…" else "连接",
                accent = true,
                enabled = !state.busy && !state.draftDirty && state.selected != null,
                onClick = { state.connect() },
            )
            Text(
                text = "连 = 用**已保存**的当前配置去 GET /api/tree",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
        state.connectError?.let { NoticeLine(it, Tokens.slotError) }

        if (state.selected?.mode == RunMode.ZEROTIER) {
            ZeroTierPanel(
                state = state.ztStatus,
                onCopy = { text ->
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("node id", text))
                    Toast.makeText(context, "已复制节点 ID", Toast.LENGTH_SHORT).show()
                },
                onSelfCheck = { state.ztSelfCheck() },
            )
        }

        Spacer(Modifier.height(6.dp))
        Text(
            "限制：只走明文 http，且只接受回环/私网地址；https 在 libzt 之上没有证据，这里不做 https 连接。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        Text(
            "配置里只存地址/模式/network/Moon（明文偏好），不存任何口令或令牌；归档显示开关目前仍是全局设置。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
    }
}

@Composable
private fun ProfileRow(profile: Profile, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .slot(if (selected) Tokens.slotUser else Tokens.slotIdle)
            .background(Tokens.panel)
            .clickable { onClick() }
            .padding(start = 10.dp, end = 9.dp, top = 7.dp, bottom = 7.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = (if (selected) "● " else "○ ") + profile.name,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Tokens.bright,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = profile.mode.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                )
            }
            Text(
                text = profile.serverUrl + if (profile.mode == RunMode.ZEROTIER) " · net ${profile.networkId.ifBlank { "（未填）" }}" else "",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
    }
}

/** 编辑区：只改 draft，点「保存」才生效。 */
@Composable
private fun Editor(state: AppState, draft: Profile) {
    SectionLabel("编辑「${draft.name}」")
    Field(
        value = draft.name,
        onValueChange = { value -> state.draftUpdate { it.copy(name = value) } },
        placeholder = "配置名字（例如 家里 / 公司 / 测试）",
    )
    Field(
        value = draft.serverUrl,
        onValueChange = { value -> state.draftUpdate { it.copy(serverUrl = value) } },
        placeholder = "http://10.0.2.2:7321",
    )
    RunMode.entries.forEach { option ->
        ModeOption(
            option = option,
            selected = draft.mode == option,
            onClick = { state.draftUpdate { it.copy(mode = option) } },
        )
    }
    if (draft.mode == RunMode.ZEROTIER) {
        SectionLabel("ZeroTier network ID（16 位十六进制）")
        Field(
            value = draft.networkId,
            onValueChange = { value -> state.draftUpdate { it.copy(networkId = value) } },
            placeholder = "例如 8056c2e21c000001",
        )
        SectionLabel("Moon（可选；两个都留空 = 不额外 orbit）")
        Field(
            value = draft.moonWorld,
            onValueChange = { value -> state.draftUpdate { it.copy(moonWorld = value) } },
            placeholder = "World ID：16 位十六进制",
        )
        Field(
            value = draft.moonSeed,
            onValueChange = { value -> state.draftUpdate { it.copy(moonSeed = value) } },
            placeholder = "Seed ID：16 位十六进制",
        )
        Text(
            text = "含义：libzt 的 zts_moon_orbit(World ID, Seed ID) —— 两个 64 位 id，不是 IP:port。改动要重新连接才生效。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        when (val moon = state.moonInput) {
            is MoonInput.Invalid -> NoticeLine(moon.message, Tokens.slotError)
            is MoonInput.Ok -> Text(
                text = "已填：world ${Moon.hex(moon.config.worldId)} / seed ${Moon.hex(moon.config.seedId)}（连接时 orbit）",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.accent,
            )
            MoonInput.Off -> Text(
                text = "未填：不加额外 root，只走默认 planet。",
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
    }
}

@Composable
private fun ModeOption(option: RunMode, selected: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .slot(if (selected) Tokens.slotUser else Tokens.slotIdle)
            .background(Tokens.panel)
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = (if (selected) "● " else "○ ") + option.label,
            style = MaterialTheme.typography.bodyMedium,
            color = Tokens.bright,
        )
        Text(option.note, style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
    }
}

@Composable
private fun ZeroTierPanel(state: ZtStatus, onCopy: (String) -> Unit, onSelfCheck: () -> Unit) {
    val (nodeId, statusText, slotColor) = when (state) {
        is ZtStatus.Idle -> Triple(null, "未启动：点「连接」时按当前配置的 network/Moon 启动", Tokens.slotIdle)
        is ZtStatus.Working -> Triple(state.nodeId, state.text, Tokens.slotPending)
        is ZtStatus.SelfChecked -> Triple(state.nodeId, state.detail, Tokens.slotIdle)
        is ZtStatus.Ready -> Triple(
            state.nodeId,
            "已就绪 · 地址 ${state.address ?: "（节点未回报 IPv4）"} · 网络 ${state.networkId}" +
                (state.moon?.let { " · $it" } ?: ""),
            Tokens.slotSuccess,
        )
        is ZtStatus.Failed -> Triple(state.nodeId, "失败：${state.text}", Tokens.slotError)
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .slot(slotColor)
            .background(Tokens.panel)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("节点 ID ${nodeId ?: "—"}", style = MaterialTheme.typography.bodySmall, color = Tokens.bright)
            if (nodeId != null) ActionButton("复制") { onCopy(nodeId) }
        }
        Text(statusText, style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
        ActionButton("自检（不连网）") { onSelfCheck() }
        Text(
            "自检只做 identity 目录的 initFromStorage：不启动节点、不 join、不发包。" +
                "**未启动时 libzt 不给节点 ID**（zts_node_get_id 返回 -2 错误码，不是 ID）——" +
                "所以「先自检拿 ID 去 Central 授权再连接」做不到：顺序只能是「连接（启动节点）→ 看到节点 ID → 去 Central 授权 → 等地址」。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
        // 这条不能省：断开只 leave 网，不停 native 节点（这版 AAR 停节点会让进程崩）——
        // 所以界面不能让人把「退出」读成「已经彻底断网了」。
        Text(
            "**「退出」只把网 leave 掉，不停节点**：libzt 仍在进行里跑（这版 AAR 停节点会让进程崩）。" +
                "节点寿命＝进程寿命，要彻底停下请结束应用进程（最近任务里划掉）。",
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.slotWarning,
        )
    }
}
