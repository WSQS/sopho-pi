package dev.sopho.pi

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.sopho.pi.image.ImageIngest
import dev.sopho.pi.image.IngestResult
import dev.sopho.pi.net.ApiException
import dev.sopho.pi.net.CommandDecision
import dev.sopho.pi.net.CommandFilter
import dev.sopho.pi.net.CommandItem
import dev.sopho.pi.net.CommandProtocol
import dev.sopho.pi.net.CommandRoute
import dev.sopho.pi.net.CommandsOutcome
import dev.sopho.pi.net.CommandsSnapshot
import dev.sopho.pi.net.CompactOutcome
import dev.sopho.pi.net.CreateOutcome
import dev.sopho.pi.net.CreateProtocol
import dev.sopho.pi.net.Destinations
import dev.sopho.pi.net.ImageSendCheck
import dev.sopho.pi.net.MessageRow
import dev.sopho.pi.net.ModelCatalog
import dev.sopho.pi.net.ModelsOutcome
import dev.sopho.pi.net.SendImageGate
import dev.sopho.pi.net.SendOutcome
import dev.sopho.pi.net.SendProtocol
import dev.sopho.pi.net.SessionRow
import dev.sopho.pi.net.SessionForest
import dev.sopho.pi.net.SessionStream
import dev.sopho.pi.net.SettingsProtocol
import dev.sopho.pi.net.SettingsRequest
import dev.sopho.pi.net.SettingsWriteOutcome
import dev.sopho.pi.net.SophoApi
import dev.sopho.pi.net.StreamState
import dev.sopho.pi.net.Transport
import dev.sopho.pi.net.Transports
import dev.sopho.pi.net.TreeEntry
import dev.sopho.pi.net.TreeFetch
import dev.sopho.pi.net.TreeLive
import dev.sopho.pi.net.treeStatusText
import dev.sopho.pi.zt.Moon
import dev.sopho.pi.zt.MoonInput
import dev.sopho.pi.zt.ZtManager
import dev.sopho.pi.zt.ZtStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

enum class RunMode(val label: String, val note: String) {
    DIRECT("直连（HTTP）", "连自己填的私网地址；明文，未做 TLS"),
    ZEROTIER("ZeroTier（libzt）", "经 AAR 的 libzt 用户态协议栈；明文，未验 TLS"),
}

enum class Screen { CONNECT, LIST, DETAIL }

/**
 * 详情页上的二级页（**浮层**，不加 [Screen] 值：那条枚举是宿主导航，二级页不是）。
 * 两者的数据都只在**打开那一刻**去拉（命令清单会为冷会话建 runtime，不能预取）。
 */
enum class Panel { COMMANDS, SETTINGS }

/**
 * 一条会话内的瞬时通知（`session.notice`）。服务端只发给**在线**的 SSE 订阅者、**不落盘** ⇒
 * 断连期间的那几条不会补发，界面必须写清这件事（不拿它冒充“执行结果已持久”）。
 */
data class UiNotice(val id: String, val level: String, val text: String)

/** 待确认的 `/compact`（专用命令要显式确认；`instructions` 可为 null）。 */
data class PendingCompact(val instructions: String?, val origin: String)

/**
 * 原型的全部界面状态与动作。**只有两处写**：详情页的文本发送（`/message` 或 `/steer`）与
 * 列表页的「新建会话」（`POST /api/sessions`）。停止/压缩/归档/改名/切模型都没有入口。
 *
 * 前台语义（如实）：离开前台就断开 SSE（`onPause`），回来时重新对账（`onResume`）——
 * 已知一条挂着的 SSE 会在服务端 pin 住这条会话的 runtime（`docs/plans/android-cross-network-connection.md` §1.3），
 * 而本原型没有后台常驻保证，所以不做「后台挂着」这种假承诺。
 */
class AppState(context: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = Prefs(context)
    private val appContext = context.applicationContext
    private val zt = ZtManager(File(context.filesDir, "zerotier"))

    private var api: SophoApi? = null

    /** 当前**已连接**的端点（连接成功那一刻定下来；切配置/退出时清空）。 */
    private var connectedBaseUrl: String? = null
    private var transport: Transport? = null
    private var stream: SessionStream? = null
    private var streamJob: Job? = null

    var screen by mutableStateOf(Screen.CONNECT)
        private set

    // ── 配置（Profile v1）：连接设置全部收进这里，不再散落在界面上 ──
    var book by mutableStateOf(ProfileBook(emptyList(), null, false))
        private set

    /** 当前选中的配置（App 启动时就是上次选中的那条）。 */
    var selected by mutableStateOf<Profile?>(null)
        private set

    /** 正在编辑的副本（字段改动只落这里，**点保存**才写盘、才成为当前配置）。 */
    var draftProfile by mutableStateOf<Profile?>(null)
        private set

    /** 给人看的提示（迁移说明 / 已保存 等）。 */
    var profileNotice by mutableStateOf<String?>(null)
        private set

    /** 可读错误（校验失败 / 坏数据 / 发送在途不许切换）。 */
    var profileError by mutableStateOf<String?>(null)
        private set

    /**
     * 存下来的配置**读不懂**（[ProfilesRead.Corrupt]）。为 true 时：
     * `profilesRaw` 一字不写（那是用户唯一一份原串，已另存到 `profilesRaw.corrupt`），界面给一个显式的重建出口。
     */
    var profilesUnreadable by mutableStateOf(false)
        private set

    /**
     * 严格拼不回去、但“按原串把后半截拼回上一条”能拼出一整本书时的**候选**（见 [ProfilesRead.Corrupt.candidate]）。
     * 它只是给用户看＋确认用：**不写盘、不自己在内存里当已恢复**（要用户点按钮，再点「保存」）。
     */
    var recoveryCandidate by mutableStateOf<ProfileBook?>(null)
        private set

    /** 用户点了「把原串拼成草稿」：候选进了内存，但 `profilesRaw` 一字未动，等「保存」。 */
    private var recoveryAdmitted = false

    val profiles: List<Profile> get() = book.profiles

    /** 编辑中的副本与已保存那条不一致 ⇒ 有未保存修改（此时连接被拦住，不会默默用旧值连）。 */
    val draftDirty: Boolean get() = draftProfile != null && draftProfile != selected

    /** 编辑区用的 Moon 两值（来自 draft）。 */
    val moonInput: MoonInput
        get() = Moon.parse(draftProfile?.moonWorld ?: "", draftProfile?.moonSeed ?: "")
    var ztStatus by mutableStateOf<ZtStatus>(ZtStatus.Idle)
        private set
    var busy by mutableStateOf(false)
        private set
    var connectError by mutableStateOf<String?>(null)
        private set

    // ── 列表 ──
    var sessions by mutableStateOf<List<SessionRow>>(emptyList())
        private set

    /**
     * 列表是否展示归档会话。**仍是全局开关**（本轮 scope：不跟着 Profile 走），
     * 与 Profile 存在同一块 `profilesRaw` 里，所以重启也回读。
     */
    val showArchived: Boolean get() = book.showArchived

    fun updateShowArchived(value: Boolean) {
        if (!bookWritable()) return
        book = book.copy(showArchived = value)
        prefs.profilesRaw = Profiles.encode(book)
    }

    /**
     * 写盘的准入门：配置读不懂时**一律不写**。`profilesRaw` 是用户唯一一份原串（已备份一份到
     * `profilesRaw.corrupt`），任何地方一写就会把它盖成“空配置”或“半本书”——那才是真丢数据。
     * 出口只有 [rebuildAfterCorrupt]（它先备份再写）。
     */
    private fun bookWritable(): Boolean {
        if (!profilesUnreadable) return true
        profileError = "配置数据还没恢复：先点「重建一条默认配置」（原内容已备份），再做这个改动。"
        return false
    }

    /** 展示树：父在前、子跟随、按真实 parentId；隐藏的归档父会把未归档子提升上来（见 SessionForest）。 */
    val treeEntries: List<TreeEntry> get() = SessionForest.visible(sessions, showArchived)

    /** 被开关藏起来的归档行数（列表为空时用来区分“真的没会话”和“有归档但已隐藏”）。 */
    val hiddenArchivedCount: Int get() = if (showArchived) 0 else sessions.count { it.archived }
    var listNotice by mutableStateOf<String?>(null)
        private set
    var listLoading by mutableStateOf(false)
        private set

    // ── 新建会话（列表页的显式入口；只建空会话，不自动发任务） ──
    /** 表单是否展开。 */
    var createOpen by mutableStateOf(false)
        private set
    var createName by mutableStateOf("")
        private set
    /** 服务器上的工作目录（**不是**手机目录）。 */
    var createCwd by mutableStateOf("")
        private set
    /** 用服务器临时目录（服务端在 `scratchRoot` 下新建）；与 [createCwd] **互斥**（服务端契约）。 */
    var createScratch by mutableStateOf(false)
        private set
    /** 这一发正在飞：界面据此禁用按钮，保证**一次点击只出一个 POST**。 */
    var creating by mutableStateOf(false)
        private set
    var createReceipt by mutableStateOf<String?>(null)
        private set
    var createReceiptTone by mutableStateOf(ReceiptTone.NONE)
        private set

    /**
     * 创建回执的票：切配置/退出会把它作废 ⇒ 旧端点上建出来的会话**不许**把回执写到新端点上
     * （与发送回执用 `detailGeneration` 判归属同一个道理）。
     */
    private var createTickets = 0

    // ── 详情 ──
    /**
     * 详情归属：每次换目标（open / back / disconnect）自增。异步回来的正文与 SSE 回调**两者都对得上**才许改界面：
     * `generation` 相等 **且** 当前 `current?.id` 就是发起那一份的 sessionId。否则就是上一次详情的迟到结果 ⇒ 直接丢弃。
     * （少了这一道，先在 A 上发起一次慢的 /messages、再切到 B，A 的结果回来就会盖掉 B 的正文。）
     */
    private var detailGeneration = 0

    // ── 树实时订阅（`/api/tree/events`） ──
    /**
     * 前台树订阅：事件 ⇒ **合并后的**权威 `GET /api/tree` 重拉（[TreeLive]）。
     * 与详情流同一条前台纪律：连接成功后起、回前台再起、后台/断开/切配置/close 收掉。
     */
    private var treeLive: TreeLive? = null

    /**
     * 树订阅的归属号：**每次 start 与每次 stop 都 +1**，永不重置。
     * 回调在主线程**执行时**拿它比一次 ⇒ stop→回前台这段窗口里已经排队的旧回调（不管是状态还是结果）
     * 都对不上，不会写回（所以订阅实例也**不**跳 stop 复用，见 [startTreeLive]）。
     */
    private var treeEpoch = 0

    /** 列表页那一行「实时」状态（照服务端事实说：未连接就写未连接，不写“已停止/已释放”）。 */
    var treeStreamStatus by mutableStateOf("未订阅（只在前台、且已连接时保持）")
        private set

    /**
     * **真实前台状态**（`onResume` 置真、`onPause` 置假）。
     * 起订阅必须看它，不能用 `screen` 推前台：`connect()` 里那个 `GET /api/tree` 是挂起的，
     * 它回来时 activity 可能已经 onPause 了（`screen` 还是 LIST）—— 那时候起来就会在后台挂一条 SSE。
     */
    private var foreground = false

    var current by mutableStateOf<SessionRow?>(null)
        private set

    /** 会话是否在跑（决定发 `/message` 还是 `/steer`）。来源：列表行 status、SSE snapshot 的 isStreaming、delta/end。 */
    var agentBusy by mutableStateOf(false)
        private set

    /** 输入框草稿：**按会话分开**，只存内存（不落盘、不存任何 token）。 */
    /** 草稿键 = `profileId:sessionId`：不同 Profile 下同一个 server 的同名会话**也不串**。 */
    private val drafts = HashMap<String, String>()

    private fun draftKey(sessionId: String): String = Profiles.draftKey(selected?.id, sessionId)

    /** 当前会话的草稿（界面直接绑它）。 */
    var draft by mutableStateOf("")
        private set

    /** 这一发正在飞：界面据此禁用按钮，并保证**一次点击只出一个请求**。 */
    var sending by mutableStateOf(false)
        private set

    // ── 附件（图片）：与草稿同一道按会话/配置隔离的键，**只存内存** ──
    private val attachments = HashMap<String, Attachment>()
    private var attachmentTickets = 0

    /** 当前会话待发送的那一张图片（null = 没有）。 */
    var attachment by mutableStateOf<Attachment?>(null)
        private set

    /** 正在后台解码/缩图（界面据此禁发，并显示“处理中”）。 */
    var imageIngesting by mutableStateOf(false)
        private set

    /** 选图失败的**可读**原因（不包含文件名/路径/base64）。 */
    var imageNotice by mutableStateOf<String?>(null)
        private set

    // ── 功能盘（加号展开的那三个入口；盘本体在 ui 层） ──
    /** 盘展开时键盘收起（互斥），且主按钮变成 `×`。 */
    var padOpen by mutableStateOf(false)
        private set

    /** 盘内提示（选图失败/组词中/命令页未接入等），与发送回执分开。 */
    var padNotice by mutableStateOf<String?>(null)
        private set

    var padNoticeTone by mutableStateOf(ReceiptTone.NONE)
        private set

    /** 发送回执（成功/失败/未知都说人话）。 */
    var sendReceipt by mutableStateOf<String?>(null)
        private set

    /**
     * 模型侧“能不能读图”的只读接缝（三态：true/false/null）。
     *
     * 接的就是命令/模型设置那条线从 `GET /models` 读回的 `supportsImages`（`canSendImages`）：
     * `false` = 服务端明确说这个模型读不了图 ⇒ 发图前就先拦下，不把图丢进一个必然被拒的请求；
     * `null` = 服务端没说（目录未拉/字段缺失）⇒ **不假装支持，也不假装不支持**，放行给服务端判。
     */
    private val imageModelCapability: Boolean?
        get() = canSendImages

    /** 回执的颜色语义：正常=已接受、错误=确定没发出去、警示=结果未知/不确定。 */
    var sendReceiptTone by mutableStateOf(ReceiptTone.NONE)
        private set

    enum class ReceiptTone { NONE, OK, WARN, ERROR }
    var messages by mutableStateOf<List<MessageRow>>(emptyList())
        private set
    var liveText by mutableStateOf<String?>(null)
        private set
    var historyNotice by mutableStateOf<String?>(null)
        private set
    var streamStatus by mutableStateOf("未连接")
        private set
    var detailError by mutableStateOf<String?>(null)
        private set

    // ───────────────────── 二级页：命令 / 模型与思考（浮层，不是新 Screen） ─────────────────────

    /** 当前打开的二级页（null = 在聊天页）。返回/切会话/切配置一律关掉。 */
    var panel by mutableStateOf<Panel?>(null)
        private set

    // ── 命令清单（实时 API；**只在打开命令页/手动重试时拉**，详情页不预取） ──
    /** 清单归属与迟到结果：每次换会话/切配置/重试自增；旧发一回来就丢。 */
    private var commandTickets = 0
    var commandSnapshot by mutableStateOf<CommandsSnapshot?>(null)
        private set
    var commandsLoading by mutableStateOf(false)
        private set
    var commandsError by mutableStateOf<String?>(null)
        private set
    var commandQuery by mutableStateOf("")
        private set
    var commandFilter by mutableStateOf(CommandFilter.ALL)
        private set
    var commandReceipt by mutableStateOf<String?>(null)
        private set
    var commandReceiptTone by mutableStateOf(ReceiptTone.NONE)
        private set

    /** 待确认的 `/compact`（null = 没有）。 */
    var pendingCompact by mutableStateOf<PendingCompact?>(null)
        private set

    // ── 模型与思考：**真值**（服务端回读）与**本地草案**分开 ──
    private var settingsTickets = 0
    var modelCatalog by mutableStateOf<ModelCatalog?>(null)
        private set
    var modelsLoading by mutableStateOf(false)
        private set
    var modelsError by mutableStateOf<String?>(null)
        private set

    /** 服务端回读的真值（`GET /sessions/{id}` 的 `runtime`）；**不是**用户点选的那个。 */
    var actualModelRef by mutableStateOf<String?>(null)
        private set
    var actualThinkingLevel by mutableStateOf<String?>(null)
        private set

    /** 用户在本页的选择（草案）：写入失败/未知时**原样保留**，且**绝不**拿去当“当前值”显示。 */
    var draftModelRef by mutableStateOf<String?>(null)
        private set
    var draftThinkingLevel by mutableStateOf<String?>(null)
        private set
    var settingsBusy by mutableStateOf(false)
        private set
    var settingsReceipt by mutableStateOf<String?>(null)
        private set
    var settingsReceiptTone by mutableStateOf(ReceiptTone.NONE)
        private set

    /** 服务端给的可支持思考档位（没给 ⇒ 空 = **未知**，界面不摆假档位）。 */
    val thinkingLevels: List<String> get() = modelCatalog?.levels ?: emptyList()

    /**
     * 当前模型的**图片输入能力**（三态）：true=服务端可证支持 / false=服务端明确不支持 / null=未知。
     * 图片按钮的取舍由 U 那条线用；null **不许**当成“支持”。
     */
    val canSendImages: Boolean? get() = modelCatalog?.supportsImages
    val imageCapabilityNote: String
        get() = SettingsProtocol.capabilityNote(canSendImages, modelCatalog?.serverError)

    // ── 会话瞬时通知（`session.notice`）：以前落在 applyEvent 的 `else -> Unit` 里丢掉了 ──
    var notices by mutableStateOf<List<UiNotice>>(emptyList())
        private set
    private var noticeSeq = 0

    /** 用户收起一条通知（只动这一条，不碰别的）。 */
    fun dismissNotice(id: String) {
        notices = notices.filterNot { it.id == id }
    }

    val isZeroTier: Boolean get() = selected?.mode == RunMode.ZEROTIER

    /** 界面上显示的“当前端点与模式”：用**连接成功那一刻**的值（切配置后不会假装还连着旧的）。 */
    val connectedModeLabel: String get() = selected?.mode?.label ?: "（未选配置）"
    val connectedServerUrl: String get() = connectedBaseUrl ?: selected?.serverUrl ?: "—"
    val selectedProfileName: String get() = selected?.name ?: "（无配置）"

    /**
     * 当前节点上**join 着**哪一组 ZeroTier 参数对应的网（null = 没有网）。切配置时据此决定要不要 leave。
     * 它只是产品层的「哪张网」，**不是** native 的生命周期开关：节点本身归进程级 owner（`ZtNode`）管。
     */
    private var runningZtKey: String? = null

    init {
        scope.launch { zt.status.collect { ztStatus = it } }
        loadProfiles()
    }

    // ───────────────────────────── Profile ─────────────────────────────

    private fun loadProfiles() {
        when (val read = Profiles.decode(prefs.profilesRaw)) {
            is ProfilesRead.Ok -> {
                book = read.book
                selected = read.book.profiles.firstOrNull { it.id == read.book.selectedId }
                draftProfile = selected
                if (read.repairedRecords > 0) {
                    // 旧版本写坏的样本能拼回去了：仍然**不写盘**，只留一份原串备份并告知用户。
                    prefs.profilesRaw?.let { prefs.backupCorruptProfiles(it) }
                    profileNotice = "有一条旧格式的配置当初被换行符拆成了两行，已按原样拼回去恢复使用" +
                        "（原始内容另存到 prefs 键 profilesRaw.corrupt）。请核对这条配置；点「保存」就会按新格式写回。"
                }
            }

            ProfilesRead.Empty -> {
                if (prefs.migrationDone) return // 用户把配置全删过：不要再拿老键复活一条
                val migrated = Profiles.migrateLegacy(
                    showArchived = prefs.legacyShowArchived,
                    moonWorld = prefs.legacyMoonWorld,
                    moonSeed = prefs.legacyMoonSeed,
                    defaultServerUrl = DEFAULT_SERVER_URL,
                    newId = newProfileId(),
                )
                book = migrated
                selected = migrated.profiles.first()
                draftProfile = selected
                prefs.profilesRaw = Profiles.encode(migrated)
                prefs.migrationDone = true
                profileNotice = "已把旧设置迁移成一条「" + migrated.profiles.first().name + "」：归档开关与 Moon 原样保留；" +
                    "旧版本没把服务器地址与 network ID 存盘，所以地址用默认值、network ID 留空 —— 历史值无法恢复，请核对后保存。"
            }

            is ProfilesRead.Corrupt -> {
                // 读不懂时**只**另存一份原串：绝不覆盖 profilesRaw，也绝不自动清空/重建。
                prefs.profilesRaw?.let { prefs.backupCorruptProfiles(it) }
                profilesUnreadable = true
                recoveryCandidate = read.candidate
                val hint = if (read.candidate != null) {
                    "从原串看，多出来的那一行像是第一条配置最后一个字段被换行截断的残片（拼回也正好是一条完整配置）。" +
                        "你可以在下面点「把原串拼成草稿」先看这条草稿（**不写盘**），核对无误再点「保存」。"
                } else {
                    "点下面的「重建一条默认配置」可以让应用先能用，原内容仍留在备份里；把备份内容发回来能帮我们定位。"
                }
                profileError = "连接配置读取失败（" + read.reason + "）。原配置没有被自动清空，也没有被重建：" +
                    "原样另存到 prefs 键 profilesRaw.corrupt，profilesRaw 一字未动。" + hint
            }
        }
    }

    /**
     * 用户**明确确认**才走这一步：把候选放进编辑区。此时仍然**不写盘**（`profilesRaw` 一字不动），
     * 用户可以逐个核对字段；点「保存」才写回，点别的（或直接退出）就什么都不写。
     */
    fun admitRecoveryCandidate() {
        val candidate = recoveryCandidate ?: return
        if (blockIfCreating("恢复配置") { profileError = it }) return
        if (sending) {
            profileError = "这一条发送还没有结果：先等它确定，再恢复配置。"
            return
        }
        book = candidate
        selected = candidate.profiles.firstOrNull { it.id == candidate.selectedId }
        draftProfile = selected
        recoveryAdmitted = true
        profileError = null
        profileNotice = "这是按原串拼出的草稿，还没写盘：核对字段后点「保存」才写回；不点保存就什么都不写" +
            "（profilesRaw 与 profilesRaw.corrupt 都还在）。"
    }

    /** 显式重建（只在用户点了按钮时发生）：先把坏数据备份，再建一条默认配置。 */
    fun rebuildAfterCorrupt() {
        prefs.profilesRaw?.let { prefs.backupCorruptProfiles(it) }
        val fresh = Profiles.migrateLegacy(false, "", "", DEFAULT_SERVER_URL, newProfileId())
        book = fresh
        selected = fresh.profiles.first()
        draftProfile = selected
        prefs.profilesRaw = Profiles.encode(fresh)
        prefs.migrationDone = true
        profilesUnreadable = false
        profileError = null
        profileNotice = "已显式重建一条默认配置；损坏的原内容备份在 profilesRaw.corrupt。"
    }

    fun selectProfile(id: String) {
        if (!bookWritable()) return
        val target = book.profiles.firstOrNull { it.id == id } ?: return
        if (target.id == selected?.id) {
            draftProfile = target // 点自己 = 放弃未保存的修改
            return
        }
        if (blockIfCreating("切配置") { profileError = it }) return
        if (sending) {
            profileError = "这一条发送还没有结果：先等它确定（已接受/失败/未知），再切配置。"
            return
        }
        disconnectForProfileSwitch(if (target.mode == RunMode.ZEROTIER) Profiles.ztConfigKey(target) else null)
        book = book.copy(selectedId = target.id)
        selected = target
        draftProfile = target
        prefs.profilesRaw = Profiles.encode(book)
        profileError = null
        profileNotice = "已切换到「" + target.name + "」"
    }

    fun newProfile() {
        if (blockIfCreating("新建/编辑") { profileError = it }) return
        if (sending) {
            profileError = "这一条发送还没有结果：先等它确定，再新建/编辑。"
            return
        }
        draftProfile = Profile(
            id = newProfileId(),
            name = "新配置",
            serverUrl = DEFAULT_SERVER_URL,
            mode = RunMode.DIRECT,
            networkId = "",
            moonWorld = "",
            moonSeed = "",
        )
        profileNotice = "正在新建一条配置：填好之后点「保存」才写盘。"
    }

    fun draftUpdate(transform: (Profile) -> Profile) {
        draftProfile = draftProfile?.let(transform)
    }

    fun discardDraft() {
        draftProfile = selected
        profileError = null
        profileNotice = null
    }

    /** 显式保存：校验 → 写盘 → 成为当前配置。**不联网**（不 start/join/orbit、不发任何请求）。 */
    fun saveDraft() {
        if (profilesUnreadable && !recoveryAdmitted) {
            profileError = "配置数据还没恢复：先点「把原串拼成草稿」核对后保存，或点「重建一条默认配置」（原内容已备份）。"
            return
        }
        val draft = draftProfile ?: return
        if (blockIfCreating("保存") { profileError = it }) return
        if (sending) {
            profileError = "这一条发送还没有结果：先等它确定，再保存。"
            return
        }
        val problem = Profiles.validate(draft)
        if (problem != null) {
            profileError = problem
            return
        }
        val normalized = draft.copy(
            name = draft.name.trim(),
            serverUrl = draft.serverUrl.trim(),
            networkId = draft.networkId.trim(),
            moonWorld = draft.moonWorld.trim(),
            moonSeed = draft.moonSeed.trim(),
        )
        val exists = book.profiles.any { it.id == normalized.id }
        val nextProfiles = if (exists) {
            book.profiles.map { if (it.id == normalized.id) normalized else it }
        } else {
            book.profiles + normalized
        }
        val switched = selected?.id != normalized.id
        if (switched) {
            disconnectForProfileSwitch(if (normalized.mode == RunMode.ZEROTIER) Profiles.ztConfigKey(normalized) else null)
        }
        book = book.copy(profiles = nextProfiles, selectedId = normalized.id)
        prefs.profilesRaw = Profiles.encode(book)
        selected = normalized
        draftProfile = normalized
        profileError = null
        if (recoveryAdmitted) {
            // 用户核对过并显式保存：从这一刻起这份数据就是“能读的”，坏状态解除（原串备份仍在）。
            recoveryAdmitted = false
            recoveryCandidate = null
            profilesUnreadable = false
            profileNotice = "已按草稿保存「" + normalized.name + "」（按新格式写回）；损坏的原串备份仍在 profilesRaw.corrupt。"
            return
        }
        profileNotice = "已保存「" + normalized.name + "」；要连它得点「连接」。"
    }

    /**
     * 删除（界面上还有一步确认）。删当前那条 ⇒ 回退到第一条并**停在配置页**，不自动连接；
     * 发送在途时不许删（与不许切一致）。
     */
    fun deleteProfile(id: String) {
        if (!bookWritable()) return
        if (blockIfCreating("删") { profileError = it }) return
        if (sending) {
            profileError = "这一条发送还没有结果：先等它确定，再删。"
            return
        }
        val remaining = book.profiles.filterNot { it.id == id }
        if (remaining.isEmpty()) {
            profileError = "这是唯一一条配置：先新建一条再删，免得没有可用配置。"
            return
        }
        val wasSelected = id == selected?.id
        if (wasSelected) {
            disconnectForProfileSwitch(null)
            selected = remaining.first()
            draftProfile = selected
        } else if (draftProfile?.id == id) {
            draftProfile = selected
        }
        book = book.copy(profiles = remaining, selectedId = selected?.id)
        prefs.profilesRaw = Profiles.encode(book)
        if (wasSelected) profileNotice = "当前配置已删除，已回退到「" + remaining.first().name + "」；没有自动连接。"
    }

    /** 切配置的隔离：断旧 SSE、让旧请求 generation 过期、清掉与旧端点相关的一切。 */
    private fun disconnectForProfileSwitch(nextZtKey: String?) {
        detailGeneration += 1
        stopStream()
        // 树订阅也属旧端点：换配置/退出时一并收掉，旧端点的迟到结果不得写进新配置的列表。
        stopTreeLive("未订阅（已换配置/未连接）")
        listLoading = false
        // ZeroTier 只在“网络配置变化”时 leave 旧网：同一组 network/moon 不必动它。
        if (runningZtKey != null && runningZtKey != nextZtKey) {
            zt.disconnect()
            runningZtKey = null
        }
        api = null
        transport = null
        connectedBaseUrl = null
        sessions = emptyList()
        current = null
        messages = emptyList()
        liveText = null
        sendReceipt = null
        sendReceiptTone = ReceiptTone.NONE
        resetCreateState()
        resetCommandState()
        resetSettingsState()
        screen = Screen.CONNECT
    }

    /**
     * 换端点时把「新建会话」那块收拾干净：在途回执作废（旧端点建出来的会话不许报到新端点上），
     * 表单清空（里面填的是**上一台服务器**上的路径，不能拿去新建）。在途的 `creating` **不复位**——
     * 复位就等于允许这时再发一个 POST；等那一发自己回来按发票丢掉。
     */
    private fun resetCreateState() {
        createTickets += 1
        createOpen = false
        createName = ""
        createCwd = ""
        createScratch = false
        createReceipt = null
        createReceiptTone = ReceiptTone.NONE
    }

    // ───────────────────────────── 连接 ─────────────────────────────

    fun connect() {
        if (busy) return
        val target = selected
        if (target == null) {
            connectError = "先选一条配置（或新建一条）。"
            return
        }
        if (draftDirty) {
            connectError = "有未保存的修改：先点「保存」再连接（不会默默用旧值连出去）。"
            return
        }
        if (sending) {
            connectError = "这一条发送还没有结果：先等它确定。"
            return
        }
        connectError = null
        profileError = null
        val url = target.serverUrl.trim()
        val refusal = Destinations.refusal(url)
        if (refusal != null) {
            connectError = refusal
            return
        }
        val moonChoice = if (target.mode == RunMode.ZEROTIER) Moon.parse(target.moonWorld, target.moonSeed) else MoonInput.Off
        if (moonChoice is MoonInput.Invalid) {
            connectError = moonChoice.message
            return
        }
        busy = true
        scope.launch {
            try {
                val chosen = when (target.mode) {
                    RunMode.ZEROTIER -> {
                        val key = Profiles.ztConfigKey(target)
                        if (runningZtKey != key) {
                            // 换网只 leave 旧网（`ZtManager.start` 里会先 join 新的）——不停节点、不动 identity。
                            if (runningZtKey != null) zt.disconnect()
                            runningZtKey = null
                        }
                        zt.start(target.networkId, (moonChoice as? MoonInput.Ok)?.config)
                        runningZtKey = key
                        val host = SophoApi.hostOf(url) ?: throw IllegalStateException("地址里取不到主机")
                        val port = SophoApi.portOf(url) ?: 80
                        Transports.overLibzt(host, port)
                    }

                    else -> Transports.plain()
                }
                val client = SophoApi(chosen.client, chosen.postClient, url)
                val rows = client.tree()
                transport = chosen
                api = client
                connectedBaseUrl = url.trimEnd('/')
                sessions = rows
                listNotice = null
                screen = Screen.LIST
                // 连上就挂前台树订阅：列表不再等“进列表/点刷新/回前台”才更新。
                // 只在真前台起（本次 `client.tree()` 挂起期间可能已经 onPause 了）。
                startTreeLive()
            } catch (cancelled: CancellationException) {
                // `close()` / 切配置取消掉这个实例的活：不是连接失败，不写错误、不标失败。
                throw cancelled
            } catch (error: Throwable) {
                connectError = describe(error)
                if (target.mode == RunMode.ZEROTIER) {
                    zt.markFailure(describe(error))
                    runningZtKey = null
                }
            } finally {
                busy = false
            }
        }
    }

    fun ztSelfCheck() {
        scope.launch {
            runCatching { zt.selfCheck() }.onFailure {
                // 取消（Activity 关掉）不是自检失败：不把它写成错误上屏
                if (it is CancellationException) throw it
                zt.markFailure(describe(it))
            }
        }
    }

    /**
     * 手动刷新（列表页「刷新」、新建成功后、从详情回列表时补一发）：走**同一条**合并路径，
     * 所以它不会和事件触发的那一发叠成两条并发 `/tree`。
     * 没订阅（未连接 / 在后台）时什么都不发，也不亮进度（不做一个永远转的旋钮）。
     */
    fun refreshTree() {
        val live = treeLive ?: return
        if (!live.requestRefresh(explicit = true)) return
        listLoading = true
    }

    /**
     * 起前台树订阅（`connect()` 成功后、回前台）。**一次订阅一个实例，实例不跨 stop/pause 复用**：
     * 复用同一实例会让“跨 pause/resume、已经排进主线程队列的旧回调”同时满足 epoch 相同 / 前台已回真 /
     * 实例身份相同三道检查 ⇒ 旧状态与旧结果又被接纳。所以每次先真停旧的、`treeEpoch++`，再建新实例；
     * 旧回调执行时对不上 epoch ⇒ 一律丢弃。
     * 唯一的前台门：`connect()` 的 `GET /api/tree` 是挂起的，它回来时 activity 可能已经 onPause
     *（`screen` 仍是 LIST）—— 用 `screen` 推前台就会在后台挂一条 SSE。
     */
    private fun startTreeLive() {
        if (!foreground) return
        val client = api ?: return
        val chosen = transport ?: return
        val base = connectedBaseUrl ?: return
        // 旧实例先真停（不能只丢引用：那会让旧 SSE 与合并器继续拉 `/tree` 且无人能取消）。
        treeLive?.stop()
        treeLive = null
        val epoch = ++treeEpoch
        val live = TreeLive(
            scope = scope,
            client = chosen.sseClient,
            fetch = {
                // 归属在执行时再核一次：换了连接就掷错（结果本来就没人要），而不是拿旧端点的数据。
                if (api === client) client.tree() else throw IllegalStateException("树订阅已换归属：这一发作废")
            },
            onResult = { _, result, explicit ->
                // TreeLive 的回调在 IO / 合并器线程上 ⇒ 一律回主线程，并在**执行时**核「这个归属还是不是当前的」
                // 与前台。epoch 每次 start/stop 都变，所以 stop→回前台这段里排队的旧回调过不了这一关。
                scope.launch { if (epoch == treeEpoch && foreground) applyTree(result, explicit) }
            },
            onState = { _, state, detail ->
                // 状态文字与结果同一条门：只改 result 那条是不够的（旧“已连接”同样会写回）。
                scope.launch { if (epoch == treeEpoch && foreground) treeStreamStatus = treeStatusText(state, detail) }
            },
        )
        treeLive = live
        live.start(base)
    }

    /**
     * 停前台树订阅并**作废旧归属**（后台 / 断开 / 切配置 / close）。
     * **`treeEpoch++` 是关键**：已经排进主线程队列的旧回调此时对不上 epoch ⇒ 一个都不写。
     * 实例不保留（见 [startTreeLive]）。取消只算“请求取消”：底层连接可能还没回来，这里不写“已释放”。
     */
    private fun stopTreeLive(note: String) {
        treeEpoch += 1
        treeLive?.stop()
        treeLive = null
        treeStreamStatus = note
    }

    /**
     * 一次权威树重拉的回执。**只在归属仍是当前订阅时**调到这里（见 [startTreeLive]）。
     * 失败时如实上屏（事件触发的失败也写，不静默），成功时清掉旧的失败提示。
     */
    private fun applyTree(result: TreeFetch, explicit: Boolean) {
        when (result) {
            is TreeFetch.Loaded -> {
                sessions = result.rows
                listNotice = null
                syncCurrentRow(result.rows)
            }

            is TreeFetch.Failed -> {
                listNotice = if (explicit) {
                    "刷新失败：${result.message}"
                } else {
                    "实时刷新失败：${result.message}（下一次事件或重连会再试）"
                }
            }
        }
        if (explicit) listLoading = false
    }

    /**
     * 树重拉后把详情页手上那一行也换成新的（名字/状态可能变了，回列表时不该还是旧的）。
     * **不动** `agentBusy` —— 那是会话流（`session.snapshot` / `delta` / `end`）的活，不是树的活。
     */
    private fun syncCurrentRow(rows: List<SessionRow>) {
        val row = current ?: return
        val fresh = rows.firstOrNull { it.id == row.id } ?: return
        if (fresh != row) current = fresh
    }

    fun disconnect() {
        // 断开**不撤销**已经发出去的那个创建 POST（服务端可能已经建出来了）：如实说，
        // 别让用户以为“断开了 = 没建”。回到这条配置再连上 + 刷新就能看到它。
        if (creating) {
            profileNotice = "已断开连接：那条创建请求**不会被撤销** —— 服务器可能已经把它建出来了。" +
                "回到这条配置再用「连接」＋「刷新」就能看到它（本应用不会自动重试）。"
        }
        detailGeneration += 1
        stopStream()
        stopTreeLive("未订阅（已断开连接）")
        zt.disconnect()
        runningZtKey = null
        api = null
        transport = null
        connectedBaseUrl = null
        sessions = emptyList()
        listLoading = false
        current = null
        messages = emptyList()
        liveText = null
        sendReceipt = null
        attachment = null
        imageNotice = null
        padOpen = false
        padNotice = null
        padNoticeTone = ReceiptTone.NONE
        resetCreateState()
        resetCommandState()
        resetSettingsState()
        screen = Screen.CONNECT
    }

    // ───────────────────────────── 列表 → 详情 ─────────────────────────────

    fun open(row: SessionRow) {
        detailGeneration += 1
        current = row
        agentBusy = row.status == "working"
        draft = drafts[draftKey(row.id)] ?: ""
        // 附件与草稿同一道键：切会话/切配置不串；切回来还在（只存内存）。
        attachment = attachments[draftKey(row.id)]
        imageNotice = null
        padOpen = false
        padNotice = null
        padNoticeTone = ReceiptTone.NONE
        sendReceipt = null
        sendReceiptTone = ReceiptTone.NONE
        messages = emptyList()
        liveText = null
        historyNotice = null
        detailError = null
        resetCommandState()
        resetSettingsState()
        streamStatus = "连接中…"
        screen = Screen.DETAIL
        loadMessages()
        startStream()
    }

    fun backToList() {
        detailGeneration += 1
        stopStream()
        current = null
        messages = emptyList()
        liveText = null
        resetCommandState()
        resetSettingsState()
        padOpen = false
        padNotice = null
        padNoticeTone = ReceiptTone.NONE
        // 附件与草稿留在 map 里（按 (profileId, sessionId) 分），回来还在；不写盘。
        attachment = null
        imageNotice = null
        screen = if (api != null) Screen.LIST else Screen.CONNECT
        // 回列表补一发刷新：在详情页待着的时候树事件已经把列表维护住了，但列表页上那一帧
        // 可能是进详情前的（比如在详情里新建了子会话）—— 这一发走合并路径，不会和事件那发叠成两条。
        if (screen == Screen.LIST) refreshTree()
    }

    // ───────────────────────────── 新建会话（`POST /api/sessions`） ─────────────────────────────

    /** 点「＋ 新建」：展开/收起表单。创建在途时不许收起（否则回执会落到看不见的地方）。 */
    fun toggleCreateForm() {
        if (creating) {
            createReceipt = "这一发创建还没有结果：等它回来（或超时）再说，不要连点。"
            createReceiptTone = ReceiptTone.WARN
            return
        }
        createOpen = !createOpen
        createReceipt = null
        createReceiptTone = ReceiptTone.NONE
    }

    fun closeCreateForm() {
        if (creating) return
        createOpen = false
    }

    fun onCreateNameChange(text: String) {
        createName = text
    }

    fun onCreateCwdChange(text: String) {
        createCwd = text
    }

    fun updateCreateScratch(value: Boolean) {
        createScratch = value
    }

    /**
     * 创建在途时的同一道闸（与 `sending` 同一理由：在途回执不许落到别的配置/端点上）。
     *
     * 为什么**拦**而不是“允许切、把回执丢掉”：丢掉回执只能保证界面不乱，**不能**说明服务器没建
     * （那个 POST 已经发出去了，客户端没有幂等键可撤销）。拦住的代价比“用户以为没建、实际建了”小。
     */
    private fun blockIfCreating(action: String, report: (String) -> Unit): Boolean {
        if (!creating) return false
        report("这一条创建还没有结果：等它确定（已建/拒绝/未知）再${action}。")
        return true
    }

    /**
     * 建一个**空**会话（第二处、也是唯一一条创建写口）。只出一个 POST：
     * - `creating` 为真时直接返回（**连点不会重复建**）；
     * - 请求体只放服务端认的那几个字段（`name`/`cwd`/`scratch`，见 [CreateProtocol]）：不填就不送，
     *   **不硬编码任何本机路径**；
     * - 201 ⇒ 刷新列表（**不自动打开、更不发任务**）；4xx ⇒ 服务端拒了；5xx/408/断连 ⇒ **结果未知**，
     *   **不自动重发**（服务端没有幂等键，重发一次就多一条会话）；
     * - 失败/未知一律**保留输入**；迟到回执按票丢弃。
     */
    fun createSession() {
        val client = api
        if (client == null) {
            createReceipt = "还没连上服务器：先在配置页点「连接」，再回来新建。"
            createReceiptTone = ReceiptTone.WARN
            return
        }
        if (creating) return
        val plan = CreateProtocol.plan(createName, createCwd, createScratch)
        val ticket = ++createTickets
        creating = true
        createReceipt = null
        createReceiptTone = ReceiptTone.NONE
        scope.launch {
            val outcome = client.createSession(plan)
            // 归属：切了配置/退出了 ⇒ 这条回执不属于当前端点，直接丢掉（不污染新端点的界面）。
            if (ticket != createTickets) {
                creating = false
                return@launch
            }
            when (outcome) {
                is CreateOutcome.Created -> {
                    createOpen = false
                    createName = ""
                    createCwd = ""
                    createScratch = false
                    createReceiptTone = ReceiptTone.OK
                    createReceipt = CreateProtocol.createdText(plan, outcome)
                    // 新会话已在 /api/tree 里（还没跑过回合的会话也看得到）⇒ 刷新一次列表。
                    refreshTree()
                }

                is CreateOutcome.Rejected -> {
                    createReceiptTone = ReceiptTone.ERROR
                    createReceipt = CreateProtocol.failureText(outcome)
                }

                is CreateOutcome.Uncertain, CreateOutcome.Unknown -> {
                    createReceiptTone = ReceiptTone.WARN
                    createReceipt = CreateProtocol.failureText(outcome)
                }
            }
            creating = false
        }
    }

    fun reloadMessages() = loadMessages()

    // ───────────────────────────── 功能盘 ＋ 图片附件 ─────────────────────────────

    /**
     * 加号/×：开或收功能盘。**盘展开 ⇔ 键盘收起**（两者占同一块地方，不能叠在一起）。
     * 界面层负责在盘展开时 `hide()` 键盘并发起 `clearFocus()`；这里只管状态，不碰 IME 控制器。
     */
    fun togglePad() {
        padOpen = !padOpen
        if (padOpen) padNotice = null
        padNoticeTone = ReceiptTone.NONE
    }

    fun closePad() {
        padOpen = false
        padNotice = null
        padNoticeTone = ReceiptTone.NONE
    }

    /** 点输入框：盘收起（回到键盘）。焦点本来就在输入框时也要把盘收掉。 */
    fun onComposerFocus() {
        if (padOpen) closePad()
    }

    /**
     * 功能盘「命令」/「模型与思考」两个入口不在这里占位：它们由下面的 `openCommandPanel()` /
     * `openModelPanel()`（M 线那对真实现）打开，**真清单／真回读**，不是本地模拟。
     */

    /**
     * 用户选完图（Photo Picker 回 `content://`）。**只读进内存**：不落盘、不上传、不自动发送。
     *
     * - 解码/缩放/压缩在 IO 线程；失败一律写可读原因，**不**说“已添加”；
     * - 归属：选图期间用户切了会话/配置 ⇒ 结果丢弃（没票不入账）；
     * - 纯图也允许发送（服务端契约），但**得用户自己点发送**。
     */
    fun onImagePicked(uri: Uri) {
        val id = current?.id ?: return
        if (imageIngesting) {
            padNotice = "上一张图片还在处理中，等它好了再选。"
            padNoticeTone = ReceiptTone.WARN
            return
        }
        val ticket = ++attachmentTickets
        val key = draftKey(id)
        imageIngesting = true
        imageNotice = null
        padNotice = null
        padNoticeTone = ReceiptTone.NONE
        scope.launch {
            val result = withContext(Dispatchers.IO) { ImageIngest.ingest(appContext, uri) }
            imageIngesting = false
            // 归属：切了会话/配置、或者这一发已被后一次选择顶掉 ⇒ 丢掉（不把图塞进别人的会话）。
            if (ticket != attachmentTickets || current?.id != id || draftKey(id) != key) return@launch
            when (result) {
                is IngestResult.Ok -> {
                    val next = Attachment(
                        id = "img-$ticket",
                        payload = result.payload,
                        thumb = result.thumb,
                        width = result.width,
                        height = result.height,
                        originalWidth = result.originalWidth,
                        originalHeight = result.originalHeight,
                        sourceBytes = result.sourceBytes,
                        encodedBytes = result.encodedBytes,
                    )
                    attachments[key] = next
                    attachment = next
                    imageNotice = null
                }

                is IngestResult.Refused -> {
                    imageNotice = result.reason
                }
            }
        }
    }

    /** 移除待发图片：**不动草稿文字**，也不动回执。 */
    fun removeAttachment() {
        val id = current?.id ?: return
        attachments.remove(draftKey(id))
        attachment = null
        imageNotice = null
    }

    /** 发送成功后用：只清“还是发送时那一张”，用户在途中换了图就不动新图。 */
    private fun clearAttachmentIfUnchanged(sessionId: String, sentSnapshotId: String) {
        val key = draftKey(sessionId)
        val now = attachments[key]
        if (now == null || now.id != sentSnapshotId) return
        attachments.remove(key)
        attachment = null
    }

    // ───────────────────────────── 发送（详情页的写路径） ─────────────────────────────

    /** 输入框改字：**按会话**存草稿（切 A→B→A 回来字还在）。 */
    fun onDraftChange(text: String) {
        val id = current?.id ?: return
        drafts[draftKey(id)] = text
        draft = text
    }

    /**
     * 发一条文本。单一入口；一次点击**至多两个**请求（首选路由 ＋ 一次明确的忙闲兜底）。
     * - `sending` 为真时直接返回（**连点不会多发**）；空白不发；
     * - 忙 ⇒ `POST /steer`，闲 ⇒ `POST /message`（与网页同选择）；斜杠形状强制走 `message`（见 [SendProtocol.plan]）；
     * - **仅当**第一个请求是方向明确的入队前 409（message 收到 `session_streaming` / steer 收到
     *   `session_not_streaming`）才切一次路（[SendProtocol.fallback]）；压缩、准入窗口、408/5xx/超时/未知
     *   一律不切、不重发，草稿保留；斜杠命令也不切；
     * - 切路前再校验归属（generation ＋ session id）：用户已离开这条会话就不再发第二发；
     * - 只有**有效 accept 回执**（[SendProtocol.interpretAccepted]）才可能清草稿，而且**只在“草稿还是发送时那份”时**清；
     * - 失败保留草稿；超时/断连 ⇒ “结果未知”上屏，**不自动重发**；5xx 同理；
     * - 回执归属：回来时校验 generation ＋ session id，切会话后的迟到回执一律丢掉，不污染另一条会话。
     */
    fun send() {
        val client = api ?: return
        val row = current ?: return
        if (sending) return
        if (imageIngesting) {
            sendReceipt = "图片还在处理（解码/缩放/压缩）—— 等它好了再发，不然会漏掉这张图。"
            sendReceiptTone = ReceiptTone.WARN
            return
        }
        val snapshot = draft
        // 发送时的那一张图（同 `snapshot`：用户飞行途中换了图，回执回来不许删新图）。
        val imageSnapshot = attachment
        val images = imageSnapshot?.let { listOf(it.payload) } ?: emptyList()
        // 图片闸：数量/体积/格式（我们自己能确定的）＋ 模型侧能力（另一条线给的 canSendImages）。
        // 拒发时**选一个字都不发**，草稿与图片都保留。
        when (val imageCheck = SendImageGate.check(snapshot, images, imageModelCapability)) {
            is ImageSendCheck.Refused -> {
                sendReceipt = imageCheck.receipt
                sendReceiptTone = ReceiptTone.ERROR
                return
            }

            ImageSendCheck.Ok -> Unit
        }
        // ── 命令面板那条线的**语义闸**插在这里（早于 plan()/fallback）：
        // 那一层查 `/commands` 名单：名单内 runnable 命令 + 会话在跑/压缩 ⇒ 一句话都不发，只写回执并 return；
        // `/model`、`/compact` 是专用命令（via）⇒ 不发文本，打开对应二级页/要显式确认。
        //
        // 清单**还没拿到**而文本又像命令：**只为这一次点击**按需拉一次清单（不循环、不自动重试 POST），
        // 拿到后再用真清单判；拉不到就保稿并让用户手动重试 —— **绝不**“仍失败就当普通文本发”
        // （那会把 /model、/compact 当 prompt 发出去，正是要避免的假成功）。
        if (commandSnapshot == null && CommandProtocol.nameIn(snapshot) != null) {
            fetchCommandsThenSend(client, row.id, snapshot)
            return
        }
        when (val gate = commandGate(snapshot)) {
            is SendGate.Proceed -> Unit
            is SendGate.Handled -> {
                sendReceipt = gate.receipt
                sendReceiptTone = gate.tone
                return
            }
        }
        // 本层只做**形状**（不查名单）：斜杠形状由 plan() 强制走 message、fallback 恒 null。
        // 形状命中**不能**在这里 return —— “/tmp 是空的”这类普通文本服务端会当普通 prompt 收下。
        val plan = SendProtocol.plan(row.id, snapshot, agentBusy) ?: run {
            // 纯图（文本为空）不是“内容为空”：服务端契约允许，但**必须有图**。
            val pure = SendProtocol.plan(row.id, "", agentBusy, hasImages = images.isNotEmpty())
            if (pure == null) {
                sendReceipt = "内容为空（或只有空格/换行），没有发送。"
                sendReceiptTone = ReceiptTone.WARN
                return
            }
            pure
        }
        // 图片挂到计划上（不改 plan() 的调用形状，也不改上面那一行）。
        val sendPlan = SendProtocol.withImages(plan, images)
        val generation = detailGeneration
        val sessionId = row.id
        sending = true
        sendReceipt = null
        sendReceiptTone = ReceiptTone.NONE
        scope.launch {
            val first = client.send(sendPlan)
            var usedPlan = sendPlan
            var outcome = first
            var fallbackFrom: SendOutcome.Rejected? = null
            // 兜底只在**同一次点击**内、且归属仍是当前详情时才发生（第一条已确定没入队）。
            if (generation == detailGeneration && current?.id == sessionId) {
                val retry = SendProtocol.fallback(sendPlan, first)
                if (retry != null) {
                    usedPlan = retry
                    fallbackFrom = first as SendOutcome.Rejected
                    outcome = client.send(retry)
                }
            }
            // 归属：切了会话/换了一代 ⇒ 这条回执不属于当前界面，直接丢掉（不污染另一条会话）。
            if (generation != detailGeneration || current?.id != sessionId) {
                // 这一发已经落地（请求本身结束了）⇒ 开关要复位，否则以后都发不出去；
                // 但**不发任何回执**：它属于另一条会话，不能污染当前界面。
                sending = false
                return@launch
            }
            when (outcome) {
                is SendOutcome.Accepted -> {
                    // 用户在这段时间里又打了新字 ⇒ 不能把他的新草稿删掉。
                    val key = draftKey(sessionId)
                    if (SendProtocol.shouldClearDraft(drafts[key] ?: "", snapshot)) {
                        drafts[key] = ""
                        draft = ""
                    }
                    // 图片同理：只清“还是发送时那一张”，在途换了图就保留新图。
                    imageSnapshot?.let { clearAttachmentIfUnchanged(sessionId, it.id) }
                    sendReceiptTone = ReceiptTone.OK
                }
                is SendOutcome.Rejected -> sendReceiptTone = ReceiptTone.ERROR
                is SendOutcome.Uncertain, SendOutcome.Unknown -> sendReceiptTone = ReceiptTone.WARN
            }
            sendReceipt = if (outcome is SendOutcome.Accepted) {
                SendProtocol.acceptedText(usedPlan, outcome, fallbackFrom)
            } else {
                SendProtocol.failureText(outcome)
            }
            if (outcome is SendOutcome.Accepted) {
                // 服务端只是“接受”了；回答会从 SSE / 重拉正文里来。这里先把正文刷新一次（不等下一帧）。
                loadMessages()
            }
            sending = false
        }
    }

    private fun loadMessages() {
        val client = api ?: return
        val row = current ?: return
        val generation = detailGeneration
        val sessionId = row.id
        scope.launch {
            try {
                val page = client.messages(sessionId)
                if (!isCurrentDetail(generation, sessionId)) return@launch
                messages = page.messages.takeLast(MAX_RENDERED_MESSAGES)
                historyNotice = if (page.messages.size > MAX_RENDERED_MESSAGES) {
                    "共 ${page.messages.size} 条（全量接收），只渲染最近 $MAX_RENDERED_MESSAGES 条（服务端没有分页）"
                } else {
                    "共 ${page.messages.size} 条（全量接收）"
                }
                detailError = null
            } catch (error: Throwable) {
                if (!isCurrentDetail(generation, sessionId)) return@launch
                detailError = "拉正文失败：${describe(error)}"
            }
        }
    }

    /** 这一发异步结果还是不是「当前详情」的：generation 与 session id 都要对得上。 */
    private fun isCurrentDetail(generation: Int, sessionId: String): Boolean =
        generation == detailGeneration && screen == Screen.DETAIL && current?.id == sessionId

    // ───────────────────── 二级页：命令 / 模型与思考 ─────────────────────

    /**
     * 打开二级页（**浮层**，不换 [Screen]）。数据**只在此刻拉**：
     * 命令清单会为冷会话建 runtime（`/commands` 走 `withSession`），所以详情页绝**不**预取。
     */
    fun openPanel(target: Panel) {
        if (current == null) return
        panel = target
        when (target) {
            Panel.COMMANDS -> loadCommands()
            Panel.SETTINGS -> loadModels(resetDrafts = true)
        }
    }

    /** 功能盘里的「命令」入口（盘本体归并行那条线，这里只提供这一个接缝）。 */
    fun openCommandPanel() = openPanel(Panel.COMMANDS)

    /** 功能盘里的「模型与思考」入口。 */
    fun openModelPanel() = openPanel(Panel.SETTINGS)

    fun closePanel() {
        panel = null
        pendingCompact = null
    }

    /**
     * 命令/设置这一层的归属判据：票据 + 详情 generation + 会话 id 三样都对得上，才允许写界面。
     * （少了票据这一道，先点一次“重试”再点一次，两个迟到结果会互相盖。）
     */
    private fun owns(ticket: Int, tickets: Int, generation: Int, sessionId: String): Boolean =
        ticket == tickets && generation == detailGeneration && screen == Screen.DETAIL && current?.id == sessionId

    private fun resetCommandState() {
        commandTickets += 1
        commandSnapshot = null
        commandsLoading = false
        commandsError = null
        commandQuery = ""
        commandFilter = CommandFilter.ALL
        commandReceipt = null
        commandReceiptTone = ReceiptTone.NONE
        pendingCompact = null
        panel = null
    }

    private fun resetSettingsState() {
        settingsTickets += 1
        modelCatalog = null
        modelsLoading = false
        modelsError = null
        actualModelRef = null
        actualThinkingLevel = null
        draftModelRef = null
        draftThinkingLevel = null
        settingsBusy = false
        settingsReceipt = null
        settingsReceiptTone = ReceiptTone.NONE
        notices = emptyList()
    }

    /**
     * 拉 `/commands`（打开命令页 / 手动重试）。一次只一发；失败**不**把清单退化成空列表——
     * 空列表会被读成“这些命令都不存在”，而（真正的）未知必要的是“判不了 /model 该不该走专用路”。
     */
    fun loadCommands() {
        val client = api
        if (client == null) {
            commandsError = "还没连上服务器：先在配置页点「连接」。"
            return
        }
        val row = current ?: return
        if (commandsLoading) return
        val ticket = ++commandTickets
        val generation = detailGeneration
        val sessionId = row.id
        commandsLoading = true
        commandsError = null
        commandReceipt = null
        commandReceiptTone = ReceiptTone.NONE
        scope.launch {
            val outcome = client.commands(sessionId)
            if (!owns(ticket, commandTickets, generation, sessionId)) return@launch
            when (outcome) {
                is CommandsOutcome.Loaded -> {
                    commandSnapshot = outcome.snapshot
                    commandsError = null
                    if (outcome.snapshot.builtinError != null) {
                        commandReceipt = "内置命令清单不完整（服务端自报）：" + outcome.snapshot.builtinError
                        commandReceiptTone = ReceiptTone.WARN
                    }
                }

                is CommandsOutcome.Failed -> {
                    commandsError = "命令清单拿不到：" + outcome.failure.message +
                        " —— 拿不到清单时命令一律按“清单未知”处理（发 /model、/compact 会被拦住并说明，不是当普通消息发出去）。"
                }
            }
            commandsLoading = false
        }
    }

    fun onCommandQueryChange(text: String) {
        commandQuery = text
    }

    fun applyCommandFilter(filter: CommandFilter) {
        commandFilter = filter
    }

    /** 命令页要显示的那一列（筛选＋搜索都在这一个纯函数里）。 */
    val visibleCommands: List<CommandItem>
        get() = CommandProtocol.filter(commandSnapshot?.commands ?: emptyList(), commandQuery, commandFilter)

    /**
     * 点选一条命令：**只填入，不执行**（`via=prompt`）；专用命令只做导航/要确认。
     * 点一个条目发一个请求？不——这里一个请求也不发。
     */
    fun chooseCommand(item: CommandItem) {
        val refusal = item.refusal
        if (refusal != null) {
            commandReceipt = "「/${item.name}」不可填：$refusal"
            commandReceiptTone = ReceiptTone.ERROR
            return
        }
        when (item.route) {
            CommandRoute.MODEL -> {
                commandReceipt = "「/${item.name}」是专用命令（via=model）：已打开模型与思考页。" +
                    "在那里选好并点保存才会真的写入服务端 —— 点这一条不会自动切模型。"
                commandReceiptTone = ReceiptTone.OK
                openModelPanel()
            }

            CommandRoute.COMPACT -> {
                pendingCompact = PendingCompact(null, "命令页")
                commandReceipt = "「/${item.name}」是专用命令（via=compact）：下面要你显式确认才会请求压缩。" +
                    "确认只代表“服务端收下这次请求”，不代表“已经压缩完”。"
                commandReceiptTone = ReceiptTone.WARN
            }

            CommandRoute.PROMPT -> {
                onDraftChange(CommandProtocol.fillText(item))
                panel = null
                commandReceipt = null
                commandReceiptTone = ReceiptTone.NONE
                sendReceipt = "已把「/${item.name}」填进输入框（**没有发送**）：补完参数后自己点发送。"
                sendReceiptTone = ReceiptTone.OK
            }

            CommandRoute.UNAVAILABLE -> Unit
        }
    }

    // ───────────────────── 模型与思考（真值 / 草案 / 串行写＋回读） ─────────────────────

    /**
     * 拉 `/models`（含 `thinking` 与每个模型的 `input`/`supportsImages`），再用 `GET /sessions/{id}`
     * 的 `runtime` 对齐**真值**。`resetDrafts` 只在“刚打开本页”时为真（不要把用户未保存的选择默默改掉）。
     */
    fun loadModels(resetDrafts: Boolean = false) {
        val client = api
        if (client == null) {
            modelsError = "还没连上服务器：先在配置页点「连接」。"
            return
        }
        val row = current ?: return
        if (modelsLoading) return
        val ticket = ++settingsTickets
        val generation = detailGeneration
        val sessionId = row.id
        modelsLoading = true
        modelsError = null
        scope.launch {
            val outcome = client.models(sessionId)
            if (!owns(ticket, settingsTickets, generation, sessionId)) return@launch
            if (outcome is ModelsOutcome.Failed) {
                modelsError = "模型目录拿不到：" + outcome.failure.message
                modelsLoading = false
                return@launch
            }
            val catalog = (outcome as ModelsOutcome.Loaded).catalog
            modelCatalog = catalog
            if (catalog.serverError != null) modelsError = "服务端自报模型目录有问题：" + catalog.serverError
            if (catalog.models.isEmpty() && catalog.serverError == null) modelsError = "这个会话没有可选模型（服务端清单是空的）。"
            if (catalog.current != null) actualModelRef = catalog.current
            // 思考档位的真值只在会话详情里 —— 目录里的 `thinking.current` 不当唯一依据。
            val read = runCatching { client.runtimeSettings(sessionId) }.getOrNull()
            if (!owns(ticket, settingsTickets, generation, sessionId)) return@launch
            if (read != null) {
                if (read.model != null) actualModelRef = read.model
                actualThinkingLevel = read.thinkingLevel
            } else if (modelsError == null) {
                modelsError = "模型目录拿到了，但详情回读失败（GET /sessions/{id}）：思考档位的“当前值”仍是旧读数，不能当成已核对。"
            }
            if (resetDrafts) {
                draftModelRef = actualModelRef
                draftThinkingLevel = actualThinkingLevel
                settingsReceipt = null
                settingsReceiptTone = ReceiptTone.NONE
            }
            modelsLoading = false
        }
    }

    /**
     * 选模型（本地草案）。新模型如果给了自己的档位清单、而当前选好的档位不在里面，就把**档位选择**清掉
     * ——这只是本地一致性，**一个请求也不发**（服务端才是真值，写入那一步才验）。
     */
    fun selectDraftModel(ref: String) {
        draftModelRef = ref
        val levels = modelCatalog?.models?.firstOrNull { it.ref == ref }?.thinkingLevels ?: return
        val chosen = draftThinkingLevel ?: return
        if (chosen in levels) return
        draftThinkingLevel = null
        settingsReceipt = "「$ref」的可支持档位里没有「$chosen」：已清掉那个选择（**没有**发任何请求）。"
        settingsReceiptTone = ReceiptTone.WARN
    }

    fun selectDraftThinking(level: String) {
        draftThinkingLevel = level
    }

    /**
     * 保存：**一发写**（模型与档位在同一条 `POST /model` 里，服务端先预校验两者、再串行落地 ⇒ 不会 partial），
     * 写完 **一定** `GET /sessions/{id}` 回读。
     * - 一次点击只出一发写（+1～2 发只读回读）；每个 await 之间都验归属（切会话/换代 ⇒ 旧回执丢掉）；
     * - 忙/拒/不确定 → **不重试**，本地选择保留，`actual*` 一个字不改（只显示服务端回读值）；
     * - 偏差只按“**请求值 vs 回读值**”判（`thinkingChanged` 不当夹取证据：正常 off→high 也是 true）；
     *   本次没请求改档位、而写前档 vs 回读档不同 ⇒ 只如实说“换模型后档位从 X 变成了 Y”
     *   （这一支没有 requested 可比，**不**使用“不是你选的”偏差话术）。
     */
    fun applySettings() {
        val client = api
        if (client == null) {
            settingsReceipt = "还没连上服务器：先在配置页点「连接」。"
            settingsReceiptTone = ReceiptTone.WARN
            return
        }
        val row = current ?: return
        if (settingsBusy) return
        if (sending) {
            settingsReceipt = "这一条发送还没有结果：先等它确定，再改模型/档位。"
            settingsReceiptTone = ReceiptTone.WARN
            return
        }
        val wantModel = draftModelRef
        val wantThinking = draftThinkingLevel
        val modelChanged = wantModel != null && wantModel != actualModelRef
        val levelEdited = wantThinking != null && wantThinking != actualThinkingLevel
        if (!modelChanged && !levelEdited) {
            settingsReceipt = "没有改动：模型与思考档位都还是服务端回读值，一个写请求也没发。"
            settingsReceiptTone = ReceiptTone.WARN
            return
        }
        val ticket = ++settingsTickets
        val generation = detailGeneration
        val sessionId = row.id
        settingsBusy = true
        settingsReceipt = null
        settingsReceiptTone = ReceiptTone.NONE
        scope.launch {
            val lines = ArrayList<String>()
            var tone = ReceiptTone.OK
            val request = SettingsRequest(
                model = if (modelChanged) wantModel else null,
                thinkingLevel = if (levelEdited) wantThinking else null,
            )
            val outcome = client.writeSettings(sessionId, request)
            if (!owns(ticket, settingsTickets, generation, sessionId)) return@launch
            lines += SettingsProtocol.receiptText(outcome, request)
            var applied = false
            when (outcome) {
                is SettingsWriteOutcome.Applied -> {
                    applied = true
                    if (outcome.model != null) actualModelRef = outcome.model
                    if (outcome.thinkingLevel != null) actualThinkingLevel = outcome.thinkingLevel
                }

                is SettingsWriteOutcome.Rejected -> tone = ReceiptTone.ERROR
                is SettingsWriteOutcome.Uncertain, SettingsWriteOutcome.Unknown -> tone = ReceiptTone.WARN
            }
            // 真值回读：请求成不成功都以服务端当刻的 runtime 为准。
            val read = runCatching { client.runtimeSettings(sessionId) }.getOrNull()
            if (!owns(ticket, settingsTickets, generation, sessionId)) return@launch
            if (read == null) {
                lines += "回读失败（GET /sessions/{id}）：上面的“当前值”仍是旧读数，不能当成已生效。"
                if (tone == ReceiptTone.OK) tone = ReceiptTone.WARN
            } else {
                if (read.model != null) actualModelRef = read.model
                actualThinkingLevel = read.thinkingLevel
                lines += "回读（GET /sessions/{id} 的 runtime）：模型=${read.model ?: "（未给）"} · 思考=${read.thinkingLevel ?: "（未给）"}"
            }
            // 目录（档位清单、当前模型标记）可能因换模型而变：重拉一次**只读**的 /models。
            if (modelChanged) {
                val catalogOutcome = client.models(sessionId)
                if (!owns(ticket, settingsTickets, generation, sessionId)) return@launch
                if (catalogOutcome is ModelsOutcome.Loaded) modelCatalog = catalogOutcome.catalog
            }
            // 只有**真写成**（2xx 且回执自证）才让本页选择跟随真值。
            // 忙/拒/不确定一律**保留用户的选择**：抹掉它等于替用户撤回一次他没做成的操作。
            if (applied) {
                draftModelRef = actualModelRef
                draftThinkingLevel = actualThinkingLevel
            }
            settingsReceipt = lines.joinToString("\n").ifBlank { "没有改动。" }
            settingsReceiptTone = tone
            settingsBusy = false
        }
    }

    /** 用户显式确认 `/compact`：`POST /compact` 只发一次；202 只写“已请求”，**不写**“已压缩”。 */
    fun confirmCompact() {
        val pending = pendingCompact ?: return
        val client = api
        if (client == null) {
            commandReceipt = "还没连上服务器：先在配置页点「连接」。"
            commandReceiptTone = ReceiptTone.WARN
            return
        }
        val row = current ?: return
        if (sending || settingsBusy) {
            commandReceipt = "还有一条写请求没定下来：先等它确定，再请求压缩。"
            commandReceiptTone = ReceiptTone.WARN
            return
        }
        val generation = detailGeneration
        val sessionId = row.id
        pendingCompact = null
        commandReceipt = "压缩请求已发出（等待服务端回执）…"
        commandReceiptTone = ReceiptTone.NONE
        scope.launch {
            val outcome = client.compact(sessionId, pending.instructions)
            if (generation != detailGeneration || current?.id != sessionId) return@launch
            val text = when (outcome) {
                is CompactOutcome.Accepted ->
                    "已请求压缩（HTTP ${outcome.httpStatus} accepted）—— 这只表示服务端**收下了这次请求**；" +
                        "压缩有没有跑完、成不成功要看这条会话的正文/SSE（回执不是“已压缩”）" +
                        (if (pending.instructions != null) "；带上了你写的说明" else "")

                is CompactOutcome.Rejected ->
                    "压缩请求被拒（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: ""}）：" +
                        (outcome.message ?: "服务端没给原因") + "。这条**没有**排队，可等会话空了再试。"

                is CompactOutcome.Uncertain ->
                    "压缩请求**结果不确定**（HTTP ${outcome.httpStatus}${outcome.errorCode?.let { " · $it" } ?: ""}）：" +
                        "可能已经开始也可能没有。**不自动重试** —— 先看正文/SSE。"

                CompactOutcome.Unknown ->
                    "压缩请求**结果未知**（超时或连接断了）：可能已经开始也可能没有。**不自动重试** —— 先看正文/SSE。"
            }
            val tone = when (outcome) {
                is CompactOutcome.Accepted -> ReceiptTone.OK
                is CompactOutcome.Rejected -> ReceiptTone.ERROR
                else -> ReceiptTone.WARN
            }
            commandReceipt = text
            commandReceiptTone = tone
            sendReceipt = text
            sendReceiptTone = tone
        }
    }

    fun cancelCompact() {
        pendingCompact = null
    }

    /**
     * 清单未知而文本像命令时那**一次**按需拉取（每个点击最多一次；不循环、不自动重试 POST）。
     *
     * 为什么要它：命令清单只在打开命令页时拉，可用户完全可能**从没打开过命令页**就直接手敲 `/review`。
     * 旧做法是一律拦住（回执让用户“把 / 去掉”），这对常见命令与 `/tmp 是空的` 这类路径都不友好。
     * 现在的口径：**先拉一次再说**——拉到了就按真清单判（注册且 `via=prompt` ⇒ 照常发；`via=model|compact`
     * ⇒ 走专用入口；不可执行/未知 `via` ⇒ 拦住并说明）；拉不到则保稿 + 让用户手动重试，**不发任何 POST**。
     *
     * 归属：拉取前后都核 `owns(...)`（ticket ＋ 详情 generation ＋ 屏幕 ＋ 会话 id）——切会话/切配置/换代之后
     * 回来的一律丢掉，不会把命令发到别的会话上。草稿在等待期间被改过也不再替用户发那句旧文本。
     */
    private fun fetchCommandsThenSend(client: SophoApi, sessionId: String, snapshot: String) {
        val name = CommandProtocol.nameIn(snapshot) ?: return
        if (commandsLoading) {
            sendReceipt = "命令清单还在拉取中：等它回来再点一次发送（这一下没有发出去，草稿与图片都还在）。"
            sendReceiptTone = ReceiptTone.WARN
            return
        }
        val ticket = ++commandTickets
        val generation = detailGeneration
        commandsLoading = true
        // 在途期间 `sending = true`（按钮显示“…”）：这一段确实还没发出去，但一次点击只该有一次“在途”，
        // 也才能挡住连点。回执**不**在这一刻写 —— 写了会让调用方把“正在拉清单”当成“这一发已有结果”。
        sending = true
        sendReceipt = null
        sendReceiptTone = ReceiptTone.NONE
        scope.launch {
            val outcome = client.commands(sessionId)
            commandsLoading = false
            if (!owns(ticket, commandTickets, generation, sessionId)) {
                // 切会话/切配置/换代 ⇒ 迟到结果不落；开关要复位（否则以后都发不出去），但不污染当前界面。
                sending = false
                return@launch
            }
            when (outcome) {
                is CommandsOutcome.Loaded -> commandSnapshot = outcome.snapshot

                is CommandsOutcome.Failed -> {
                    commandsError = "命令清单拿不到：" + outcome.failure.message
                    sending = false
                    sendReceipt = "「/$name」**没有发出去**：命令清单这次也没拿到（${outcome.failure.message}）。" +
                        "草稿保留 —— 去功能盘的命令页点「重试」，或稍后再点一次发送。这一下没有 POST，也不会自动重发。"
                    sendReceiptTone = ReceiptTone.WARN
                    return@launch
                }
            }
            // 草稿在这段时间里被改过（或人已经离开这条会话/这个配置）⇒ 不再替用户发出那句旧文本。
            if (draft != snapshot) {
                sending = false
                sendReceipt = "命令清单已拿到，但草稿在等待期间变了：没有发出去（避免发出你已经改掉的那句）。请再点一次发送。"
                sendReceiptTone = ReceiptTone.WARN
                return@launch
            }
            // 清单在手 ⇒ 回到同一入口，这一次用真清单判。先复位在途位（`send()` 自己开头就会再置位，
            // 两行之间没有挂起点 ⇒ 外面看不到“既不 sending 也没发”的空档）。
            sending = false
            send()
        }
    }

    /** `send()` 的命令语义闸的结果。`Handled` = 已经处理完（含已打开的二级页），**一句话都不发**。 */
    private sealed interface SendGate {
        data object Proceed : SendGate
        data class Handled(val receipt: String, val tone: ReceiptTone) : SendGate
    }

    /**
     * 命令语义闸：从菜单点选和**手敲**走同一条判据（见 [CommandProtocol.dispatch]）。
     * 敲一个 `/model` 不能因为“不是从菜单点的”就变成普通消息。
     */
    private fun commandGate(text: String): SendGate {
        val decision = CommandProtocol.dispatch(commandSnapshot, text, agentBusy || sending)
        return when (decision) {
            CommandDecision.SendAsMessage -> SendGate.Proceed
            is CommandDecision.Busy -> SendGate.Handled(decision.message, ReceiptTone.WARN)
            is CommandDecision.Refused ->
                SendGate.Handled(decision.message, if (decision.warn) ReceiptTone.WARN else ReceiptTone.ERROR)

            is CommandDecision.SwitchModel -> {
                openModelPanel()
                val extra = decision.wanted?.let {
                    "你给的是「$it」：本版不自动写入，请在页面上选中它再点保存。"
                } ?: "请在页面上选择模型（当前值是服务端回读的真值）。"
                SendGate.Handled("「/model」是专用命令：没有当普通消息发出去。已打开模型与思考页。$extra", ReceiptTone.OK)
            }

            is CommandDecision.Compact -> {
                pendingCompact = PendingCompact(decision.instructions, "输入框")
                panel = Panel.COMMANDS
                SendGate.Handled(
                    "「/compact」是专用命令，要显式确认：已打开命令页的确认框（**没有**当普通消息发出去）。" +
                        "确认后也只是“服务端收下这次压缩请求”，不是“已压缩”。",
                    ReceiptTone.WARN,
                )
            }
        }
    }

    // ───────────────────────────── SSE ─────────────────────────────

    private fun startStream() {
        val row = current ?: return
        val chosen = transport ?: return
        stopStream()
        val base = connectedBaseUrl ?: return
        val generation = detailGeneration
        val sessionId = row.id
        val created = SessionStream(
            client = chosen.sseClient,
            baseUrl = base,
            sessionId = sessionId,
            onState = { state, detail ->
                scope.launch { if (isCurrentDetail(generation, sessionId)) applyStreamState(state, detail) }
            },
            onEvent = { type, data ->
                scope.launch { if (isCurrentDetail(generation, sessionId)) applyEvent(type, data) }
            },
        )
        stream = created
        streamJob = scope.launch { created.run() }
    }

    private fun stopStream() {
        stream?.cancel()
        stream = null
        streamJob?.cancel()
        streamJob = null
    }

    private fun applyStreamState(state: StreamState, detail: String?) {
        streamStatus = when (state) {
            // 「连接中…」不再是无限空白：把阶段/已等多久/上次错误（有界）带出来。
            StreamState.CONNECTING -> "连接中…" + (detail?.let { "（$it）" } ?: "")
            StreamState.OPEN -> "● 已连接"
            StreamState.OPEN_AFTER_RECONNECT -> "● 已重连（已按服务端快照重新对账）"
            StreamState.CLOSED -> "○ 未连接（服务端收流，重试中）"
            // 失败那一行要能读到退避与原因：截断从 80 放宽到 200，仍然有界。
            StreamState.FAILED -> "○ 未连接（重试中）" + (detail?.take(200)?.let { "：$it" } ?: "")
        }
        // 连上（含重连）都按服务端当前状态重拉一次正文：服务端不读 Last-Event-ID ⇒ 不相信断线期间的事件。
        if (state == StreamState.OPEN || state == StreamState.OPEN_AFTER_RECONNECT) {
            loadMessages()
            if (state == StreamState.OPEN) liveText = null
        }
    }

    private fun applyEvent(type: String, data: String) {
        when (type) {
            "session.snapshot" -> {
                // 权威快照：清掉本地直播块，正文以后端为准（下一次 GET /messages 就是它）。
                liveText = null
                val payload = runCatching { JSONObject(data) }.getOrNull()
                agentBusy = payload?.optBoolean("isStreaming", agentBusy) ?: agentBusy
                loadMessages()
            }
            "session.delta" -> {
                val payload = runCatching { JSONObject(data) }.getOrNull() ?: return
                if (payload.optString("channel") != "text") return
                val delta = payload.optString("delta", "")
                if (delta.isEmpty()) return
                agentBusy = true // 有正文在流 ⇒ 这一轮在跑（发送时据此选 steer）
                liveText = (liveText ?: "") + delta
            }
            "session.end" -> {
                liveText = null
                agentBusy = false
                loadMessages()
            }
            // 会话瞬时通知（`session.notice`）：服务端只发给**在线**的 SSE 订阅者、不落盘 ⇒ 断连期间的不会补发。
            // 以前这里落在 `else -> Unit` 里丢掉了；现在按“一层最多 6 条 + 用户可逐条收起”呈现。
            "session.notice" -> {
                val payload = runCatching { JSONObject(data) }.getOrNull() ?: return
                val text = payload.optString("text", "")
                if (text.isEmpty()) return
                noticeSeq += 1
                notices = (notices + UiNotice(
                    id = "n$noticeSeq",
                    level = payload.optString("level", "info"),
                    text = text,
                )).takeLast(MAX_NOTICES)
            }
            // 其它事件（工具两相 / 队列 / 压缩 / 建议 …）仍不渲染，也不假装处理。
            else -> Unit
        }
    }

    // ───────────────────────────── 前台/后台 ─────────────────────────────

    fun onResume() {
        foreground = true
        when (screen) {
            Screen.DETAIL -> {
                loadMessages()
                if (streamJob == null) startStream()
                // 详情页在前台**也**挂树订阅：这样返回列表时看到的就是最新状态，而不是进详情前那一帧。
                startTreeLive()
            }

            Screen.LIST -> {
                startTreeLive()
                refreshTree()
            }

            Screen.CONNECT -> Unit
        }
    }

    fun onPause() {
        // 先把前台置假：后面的 stop / 迟到回调都按“不在前台”判，不在后台起任何订阅。
        foreground = false
        // 树订阅与详情流同一条前台纪律：**后台不挂**（本原型没有后台常驻保证，不假装有）。
        stopTreeLive(if (api != null) "○ 已请求停止（只在前台保持订阅）" else "未订阅（未连接）")
        if (screen == Screen.DETAIL) {
            stopStream()
            // 只说「已请求停止」：取消是协作式的，native 若仍阻塞在 read/connect，fd 要等它返回才释放
            // （真机/真网没有证据），所以**不写**「已停止/已释放」。
            streamStatus = "○ 已请求停止；底层连接可能仍在收尾（只在前台保持连接）"
        }
    }

    /**
     * Activity 关掉：取消**本实例**的协程（在途的连接/发送不再往下走），并把**本实例当时持有的**那张网 leave 掉。
     * ⚠️ 取消只是取消这个 AppState 自己的活，**不改**进程级 owner 的状态（节点还在跑，下一位接手者直接用）；
     * 也不 stop 节点（原因见 `ZtNode` 的类注释）。
     * ⚠️ 网的所有权按**租约**算：若这张网已被新实例重新 join（接管），这里就不动它 —— 旧的 close 不许打断新连接。
     */
    fun close() {
        foreground = false
        stopTreeLive("未订阅（已关闭）")
        scope.cancel()
        stopStream()
        zt.disconnect()
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> error.message ?: "HTTP ${error.code}"
        else -> error.message ?: error.javaClass.simpleName
    }

    companion object {
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:7321"

        /** Profile 的稳定 id（本地生成，不联网；只在「新建」时用）。 */
        fun newProfileId(): String = java.util.UUID.randomUUID().toString()

        /** 只渲染最近多少条。注意：正文是**全量接收**的（服务端没有分页参数），这一条只管渲染量。 */
        const val MAX_RENDERED_MESSAGES = 120

        /** 会话瞬时通知最多留几条（多了就顶掉最旧的；不落盘、不补发）。 */
        const val MAX_NOTICES = 6
    }
}
