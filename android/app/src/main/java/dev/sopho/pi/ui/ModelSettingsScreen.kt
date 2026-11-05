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
import dev.sopho.pi.net.ModelEntry

/**
 * 「模型与思考」页（详情页的二级浮层）。
 *
 * 三条硬口径（决定这个页面长什么样）：
 * 1. **当前值只显示服务端回读值**（`GET /sessions/{id}` 的 `runtime.model` / `runtime.thinkingLevel`）；
 *    用户点选的是“本页选择”（草案），**不冒充**当前值。
 * 2. **档位清单不硬编码**：`thinking.levels` 没给就写“未知”，不摆一排看着能点的假档位；
 *    模型自己的 `thinkingLevels` 只用来预览“这个模型支持哪些档位”。
 * 3. 保存是**串行**的（先模型、再档位），写完**一定回读**；忙/拒/不确定一律**不自动重试**，
 *    选择保留，并如实说“没写进去/不知道写没写”。
 */
@Composable
fun ModelSettingsScreen(state: AppState) {
    BackHandler { state.closePanel() }
    val catalog = state.modelCatalog
    val dirty = isDirty(state)

    Column(modifier = Modifier.fillMaxSize().background(Tokens.bg)) {
        TopBar(
            title = "模型与思考",
            subtitle = "改的是这条会话（persist=false，不改全局配置）",
            onBack = { state.closePanel() },
            actions = {
                ActionButton(
                    label = if (state.modelsLoading) "加载中…" else "重拉",
                    enabled = !state.modelsLoading,
                ) { state.loadModels() }
            },
        )

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            state.modelsError?.let { NoticeLine(it, Tokens.slotError) }
            if (catalog == null && state.modelsLoading) {
                NoticeLine("正在拉模型目录与思考档位…", Tokens.slotIdle)
            }
            NoticeLine(
                text = "当前（服务端回读）：模型=${state.actualModelRef ?: "（服务端未给）"} · " +
                    "思考=${state.actualThinkingLevel ?: "（服务端未给）"}",
                color = Tokens.slotIdle,
            )
            NoticeLine(
                text = if (dirty) "本页选择还没写入：模型=${state.draftModelRef ?: "—"} · 思考=${state.draftThinkingLevel ?: "—"}" +
                    "（这只是选择，不是当前值）" else "本页选择与当前值一致（没有待写入的改动）。",
                color = if (dirty) Tokens.slotWarning else Tokens.slotIdle,
            )
            state.settingsReceipt?.let { NoticeLine(it, receiptColor(state.settingsReceiptTone)) }
            NoticeLine(state.imageCapabilityNote, Tokens.slotIdle)
        }

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(start = 10.dp, end = 10.dp, bottom = 14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item(key = "models-label") {
                SectionLabel("模型 · 来源=${catalog?.source ?: "未知"}${if (catalog?.hot == true) " · 热 runtime" else ""}")
            }
            if (catalog != null && catalog.models.isEmpty()) {
                item(key = "models-empty") {
                    NoticeLine("这个会话没有可选模型（服务端清单是空的）。", Tokens.slotWarning)
                }
            }
            items(catalog?.models ?: emptyList(), key = { it.ref }) { entry ->
                ModelRow(
                    entry = entry,
                    isActual = entry.ref == state.actualModelRef,
                    isChosen = entry.ref == state.draftModelRef,
                    onClick = { state.selectDraftModel(entry.ref) },
                )
            }
            item(key = "thinking-label") { SectionLabel("思考档位") }
            item(key = "thinking-body") { ThinkingChooser(state) }
            item(key = "hint") {
                Text(
                    text = "点选只改本页选择：不发请求。点「保存」才写入（先写模型，再写档位；每次写完都回读服务端真值）。" +
                        "会话在跑/压缩时服务端会 409 拒写 —— 本应用不自动重试，你的选择会保留。",
                    style = MaterialTheme.typography.labelSmall,
                    color = Tokens.muted,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            item(key = "save") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ActionButton(
                        label = when {
                            state.settingsBusy -> "写入中…"
                            !dirty -> "没有可保存的改动"
                            else -> "保存（写入并回读）"
                        },
                        accent = true,
                        enabled = dirty && !state.settingsBusy,
                    ) { state.applySettings() }
                }
            }
        }
    }
}

private fun isDirty(state: AppState): Boolean {
    val modelChanged = state.draftModelRef != null && state.draftModelRef != state.actualModelRef
    val thinkingChanged = state.draftThinkingLevel != null && state.draftThinkingLevel != state.actualThinkingLevel
    return modelChanged || thinkingChanged
}

@Composable
private fun ModelRow(entry: ModelEntry, isActual: Boolean, isChosen: Boolean, onClick: () -> Unit) {
    val slot = when {
        isChosen -> Tokens.slotUser
        isActual -> Tokens.slotSuccess
        else -> Tokens.slotIdle
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .slot(slot)
            .background(Tokens.panel)
            .clickable { onClick() }
            .padding(start = 10.dp, end = 9.dp, top = 7.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val marks = buildList {
            if (isActual) add("当前（服务端）")
            if (isChosen) add("已选（未写）")
        }
        Text(
            text = entry.ref + if (marks.isEmpty()) "" else "　· " + marks.joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
            color = Tokens.bright,
        )
        val meta = buildList {
            entry.name?.let { add(it) }
            add(
                when (entry.reasoning) {
                    true -> "推理：支持"
                    false -> "推理：不支持"
                    null -> "推理：未知"
                },
            )
            add(
                when (entry.supportsImages) {
                    true -> "图片输入：支持"
                    false -> "图片输入：不支持"
                    null -> "图片输入：未知（服务端没给 input）"
                },
            )
            entry.contextWindow?.let { add("上下文 ${it}") }
        }
        Text(meta.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = Tokens.muted)
        entry.thinkingLevels?.let { levels ->
            Text(
                text = "该模型的思考档位：" + levels.joinToString(", "),
                style = MaterialTheme.typography.labelSmall,
                color = Tokens.muted,
            )
        }
    }
}

@Composable
private fun ThinkingChooser(state: AppState) {
    val levels = state.thinkingLevels
    if (levels.isEmpty()) {
        NoticeLine(
            text = "思考档位清单：服务端没给（`thinking.levels` 缺失或没有当前模型）⇒ 这里**不摆**任何档位。" +
                "本应用不硬编码 off/low/high 这类值；换一个有档位清单的模型或重拉一次再看。",
            color = Tokens.slotWarning,
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // 档位最多 7 个：按 3 个一行贴，避免窄屏溢出。
        levels.chunked(3).forEach { rowLevels ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                rowLevels.forEach { level ->
                    val chosen = state.draftThinkingLevel == level
                    val actual = state.actualThinkingLevel == level
                    ActionButton(
                        label = level + if (actual) "（当前）" else "",
                        accent = chosen,
                    ) { state.selectDraftThinking(level) }
                }
            }
        }
        Text(
            text = "当前（服务端回读）：" + (state.actualThinkingLevel ?: "（服务端未给）") +
                "；本页选择：" + (state.draftThinkingLevel ?: "（未选）"),
            style = MaterialTheme.typography.labelSmall,
            color = Tokens.muted,
        )
    }
}
