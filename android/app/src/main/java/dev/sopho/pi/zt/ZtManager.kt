package dev.sopho.pi.zt

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.coroutineContext

/** libzt 节点的可见状态（连接页只显示这几种，失败必须带原因）。 */
sealed interface ZtStatus {
    data object Idle : ZtStatus
    data class Working(val text: String, val nodeId: String?) : ZtStatus

    /**
     * 自检读数。`nodeId` **只在节点已经跑起来时**才有：libzt 在未启动时 `zts_node_get_id` 给的是
     * 负的错误码（-2），不是 ID ⇒ 自检不能承诺「先拿 ID 去授权」。
     */
    data class SelfChecked(val nodeId: String?, val detail: String) : ZtStatus

    data class Ready(
        val nodeId: String,
        val address: String?,
        val networkId: String,
        /** Moon 那一行的读数（null = 没配置 Moon，没调用过 orbit）。 */
        val moon: String? = null,
    ) : ZtStatus
    data class Failed(val text: String, val nodeId: String?) : ZtStatus
}

/** 把 `zts_moon_orbit` 抽成可注入的一步（真实现调 AAR；单测可换成假的）。 */
fun interface MoonOrbiter {
    fun orbit(worldId: Long, seedId: Long): Int
}

class ZtException(message: String) : Exception(message)

/**
 * `zts_addr_is_assigned` 返回码的分类。
 *
 * 契约按**固定 revision 的源码**（`zerotier/libzt@a707ea6`，原始行号见 `docs/ops/android-client.md` §6）：
 * `include/ZeroTierSockets.h` 写「`1` if true, `0` if false」；实现在 `src/NodeService.cpp`
 * 的 `addrIsAssigned()`（`net_id == 0` ⇒ `ZTS_ERR_ARG`(-3)，否则 `getFirstAssignedAddr(...) != ZTS_ERR_NO_RESULT`），
 * 入口在 `src/Controls.cpp`（`ACQUIRE_SERVICE(0)` —— 服务未就绪时直接返回 **0**）。
 *
 * ⇒ **只有正数算「已分配」**；0 = 还没分配（继续等）；负数 = 如实报错。
 * （旧的 `rc != 0` 会把 -3/-2 当成「已分配」 —— 那正是本次修掉的东西。）
 */
enum class AddressProbe { ASSIGNED, NOT_YET, ERROR }

internal fun addressProbe(rc: Int): AddressProbe = when {
    rc > 0 -> AddressProbe.ASSIGNED
    rc == 0 -> AddressProbe.NOT_YET
    else -> AddressProbe.ERROR
}

/**
 * libzt 生命周期（应用内用户态协议栈，**不是** `VpnService`）。
 *
 * 流程照 `docs/plans/android-feishu-dispatcher-reuse.md` §2.9 V1 的形状，并补上那份调研指出的缺口：
 * 把「拿到虚拟 IP」(`zts_addr_is_assigned`) 作为独立就绪点 —— `isNetworkTransportReady` 通过 ≠ 有地址。
 *
 * **这一层不再自己持有 native 句柄**：native 的服务是进程全局的，所有 init/start/join/leave 都走
 * [ZtNode]（进程里唯一）并串行 ⇒ 换一个 `ZtManager`（例如 Activity 重建）**不等于**换一个新的 native 实例，
 * 也不会再出现「上一次连接失败/超时后节点还跑着，下一次 start 拿 identity 去 init 就返回 -2」。
 * 每个失败都按「哪一步 + 哪个码 + 能不能恢复」如实报（见 [ZtStage]）。
 *
 * identity 落在应用私有目录（`filesDir/zerotier`），且 `allowBackup=false`（见 AndroidManifest 注释）。
 */
class ZtManager(
    private val storageDir: File,
    private val node: ZtNode = ZtRuntime.node,
    private val timeoutMs: Long = TIMEOUT_MS,
    private val pollMs: Long = POLL_MS,
) {

    private val mutableStatus = MutableStateFlow<ZtStatus>(ZtStatus.Idle)
    val status: StateFlow<ZtStatus> = mutableStatus

    /** 本次 `start()` 的起点：每个 Working 阶段都带上“已经等了多久”，不让界面只看到一句不动的文字。 */
    private var startedAtMs = 0L

    /** 上一次成功应用的 Moon（null = 没配置）；用于不静默忽略 Moon 变更，也用于同网同 Moon 的幂等判断。 */
    private var appliedMoon: MoonConfig? = null

    /**
     * 本 manager 的租约身份（一个 Activity/AppState 一个 `ZtManager`）。
     * 只有**把网 join 成功**的 manager 才持有它；`disconnect` / 失败清理都拿它去问 [ZtNode]，
     * 不是持有者就不动 native —— 这样旧实例晚到的 close 无法把新实例刚连上的网 leave 掉。
     */
    private val lease = Any()

    /** 节点 ID 文本：只有节点跑起来之后才有（未启动时 native 给的是错误码，不是 ID）。 */
    fun nodeIdText(): String? = node.nodeId()?.let { formatNodeId(it) }

    /**
     * 本机自检：只做 identity 的 `zts_init_from_storage`，**不启动节点、不 join、不 orbit、不发包**。
     *
     * ⚠️ **自检拿不到可授权的节点 ID**：`zts_node_get_id` 在节点未启动时返回 -2 错误码
     * （`ACQUIRE_SERVICE(ZTS_ERR_SERVICE)`，`src/Controls.cpp:606-610`），本应用以前那句
     * 「先自检拿 ID 去 ZeroTier Central 授权，再点连接」是**做不到的承诺**，已删。
     * 授权顺序只能反过来：点连接（启动节点）→ 看到节点 ID → 去 Central 授权 → 等地址分配。
     *
     * 节点**已经**跑着时，自检也不再调 init（服务在跑时 init 只会返回 -2），只读一次状态。
     */
    suspend fun selfCheck(): Unit = withContext(Dispatchers.IO) {
        val storage = storageDir.absolutePath
        val diag = storageDiagnostics()
        when (val result = node.ensureInitialized(storage)) {
            is ZtResult.Ok -> mutableStatus.value =
                ZtStatus.SelfChecked(nodeIdText(), selfCheckDetail(storage, diag))
            is ZtResult.Failed -> throw ZtException(failedText(result))
        }
    }

    /**
     * 启动节点、orbit（可选）、join 一张网，等到有地址。
     *
     * 顺序为什么是这样：`zts_moon_orbit` 的 `ACQUIRE_SERVICE` 要求服务在跑 ⇒ orbit 只能在 start 之后；
     * moon 是「用户自定义 root」，要在网络开始寻路前就在 roots 里 ⇒ 在 join **之前**。
     *
     * 幂等：已经 Ready 且 networkId 相同 ⇒ 直接返回，不重发任何 native 调用。
     * 失败/超时：**只**把这次 join 的网撤掉（不停节点、不动 identity），owner 仍如实记为「在跑」；
     * 取消（Activity 关闭）不算失败，**不清 owner 状态**。
     */
    suspend fun start(networkIdText: String, moon: MoonConfig? = null): Unit = withContext(Dispatchers.IO) {
        val networkIdHex = networkIdText.trim()
        if (networkIdHex.length != 16 || networkIdHex.any { it.digitToIntOrNull(16) == null }) {
            throw ZtException("network ID 要是 16 位十六进制（现在是「$networkIdHex」）")
        }
        val ready = mutableStatus.value
        val networkId = parseNetworkId(networkIdHex)
        if (
            ready is ZtStatus.Ready &&
            ready.networkId == networkIdHex &&
            appliedMoon == moon &&
            node.isJoinedBy(networkId, lease)
        ) {
            return@withContext
        }

        startedAtMs = System.currentTimeMillis()
        storageDir.mkdirs()
        emitWorking("加载 identity / 启动节点…", nodeIdText())
        val started = node.ensureStarted(storageDir.absolutePath)
        if (started is ZtResult.Failed) throw ZtException(failedText(started))

        try {
            emitWorking("等待节点上线…", nodeIdText())
            waitFor(ZtStage.WAIT_ONLINE) { node.isOnline() }

            val moonStep = MoonLauncher(MoonOrbiter { worldId, seedId -> node.orbit(worldId, seedId) })
                .orbitIfConfigured(moon)
            moonStep.text?.let { emitWorking(it, nodeIdText()) }
            moonStep.failure?.let { throw ZtException("${ZtStage.MOON_ORBIT.label}：$it") }

            emitWorking("加入网络 $networkIdHex…", nodeIdText())
            coroutineContext.ensureActive()
            val joined = node.join(networkId, lease)
            if (joined is ZtResult.Failed) throw ZtException(failedText(joined))

            emitWorking("等待网络就绪…", nodeIdText())
            waitFor(ZtStage.WAIT_TRANSPORT) { node.isTransportReady(networkId) }

            emitWorking("等待分配地址…（未授权时停在这一步）", nodeIdText())
            var lastAddressRc = 0
            waitFor(
                ZtStage.WAIT_ADDRESS,
                detail = { "最后一次 zts_addr_is_assigned 返回 $lastAddressRc（0 = 还没分配；负数 = 错误码，不是「已分配」）" },
            ) {
                lastAddressRc = node.addrIsAssigned(networkId, ZTS_AF_INET)
                when (addressProbe(lastAddressRc)) {
                    AddressProbe.ASSIGNED -> true
                    AddressProbe.NOT_YET -> false
                    AddressProbe.ERROR -> throw ZtException(
                        "zts_addr_is_assigned 返回错误码 $lastAddressRc（${ZtsErr.name(lastAddressRc)}）—— 这不是「已分配」",
                    )
                }
            }

            val address = node.ipv4(networkId)
            appliedMoon = moon
            val moonNote = when {
                moonStep.text != null ->
                    moonStep.text + "（本进程不做 deorbit：切换/清空 Moon 时旧 Moon 可能仍留在 roots）"
                node.hasOrbitedMoon() ->
                    "未配置 Moon；本进程此前 orbit 过的 Moon 不会被移除（要清掉请重启应用进程）"
                else -> null
            }
            mutableStatus.value = ZtStatus.Ready(nodeIdText() ?: "（未取到节点 ID）", address, networkIdHex, moonNote)
        } catch (cancelled: CancellationException) {
            // 取消 ≠ 失败：这里**不许**清 owner 状态，也不许顺手 leave 掉节点（下一位接手者可能正要用它）。
            throw cancelled
        } catch (error: Throwable) {
            // 失败清理：只撤掉**本实例持有的**网（不是本实例的就不动；不停节点、不动 identity）。
            val cleanup = node.disconnect(lease)
            throw if (cleanup == null) error else ZtException("${describe(error)}；失败清理也报：$cleanup")
        }
    }

    /**
     * 断开：**只 leave 网络，不停节点**（原因见 [ZtNode] 的类注释）。
     * 只对**本实例持有的**那张网生效（不是自己 join 的就不动它）；重复调用幂等。
     * leave 失败就如实报（那张网可能仍在节点上），不假装已经断开。
     */
    fun disconnect() {
        val note = node.disconnect(lease)
        mutableStatus.value = if (note == null) ZtStatus.Idle else ZtStatus.Failed(note, nodeIdText())
    }

    fun markFailure(text: String) {
        mutableStatus.value = ZtStatus.Failed(text, nodeIdText())
    }

    private fun emitWorking(text: String, nodeId: String?) {
        mutableStatus.value = ZtStatus.Working("$text · 已等 ${elapsedText()}", nodeId)
    }

    private fun elapsedText(): String {
        val elapsed = (System.currentTimeMillis() - startedAtMs).coerceAtLeast(0)
        return if (elapsed < 1_000) "${elapsed}ms" else String.format(java.util.Locale.ROOT, "%.1fs", elapsed / 1000.0)
    }

    private suspend fun waitFor(stage: ZtStage, detail: () -> String = { "" }, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            delay(pollMs)
        }
        val extra = detail()
        val suffix = if (extra.isEmpty()) "" else "（$extra）"
        throw ZtException("${stage.label}超时（${timeoutMs} ms）$suffix：检查 network ID，以及 ZeroTier Central 是否已授权这个节点")
    }

    /**
     * identity 目录的可写性读数（**不读 identity 内容**，只报路径与三件事）。
     *
     * 注意它**不参与** -2 的判据：`zts_init_from_storage` 把 `setHomePath` 的返回码丢掉了
     * （`src/Controls.cpp:85-89`）⇒ 目录真的不可写也只会表现为节点 `run()` 里的
     * 「home path could not be created」(`NodeService.cpp:213-238`)，不是 -2。
     */
    private fun storageDiagnostics(): String {
        val created = storageDir.mkdirs()
        return "mkdirs=$created，isDirectory=${storageDir.isDirectory}，canWrite=${storageDir.canWrite()}"
    }

    private fun selfCheckDetail(storage: String, diag: String): String {
        val head = if (node.phase() == ZtNode.Phase.STARTED) {
            "identity 已加载；节点已在运行（自检没有再调 init —— 服务在跑时 init 只会返回 -2）"
        } else {
            "identity 已建/已读（未启动节点、未连网）；未启动时 libzt 不给节点 ID（zts_node_get_id 返回 -2 错误码，不是 ID）"
        }
        return "$head · $storage · $diag · ${node.describe()}"
    }

    private fun parseNetworkId(hex: String): Long = java.lang.Long.parseUnsignedLong(hex, 16)

    private fun describe(error: Throwable): String = error.message ?: error.javaClass.simpleName

    /** 失败一律按「哪一步：哪个码 + 人话」上屏（不笼统说「初始化失败」）。 */
    private fun failedText(failure: ZtResult.Failed): String = "${failure.stage.label}：${failure.text}"

    companion object {
        private const val TIMEOUT_MS = 30_000L
        private const val POLL_MS = 100L
        private const val ZTS_AF_INET = 2 // libzt 的 family 常量（AF_INET）；AAR 里没有导出这个常量

        fun formatNodeId(id: Long): String = java.lang.Long.toHexString(id).padStart(10, '0')
    }
}
