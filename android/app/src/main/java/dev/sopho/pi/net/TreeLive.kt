package dev.sopho.pi.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/** 一次权威树重拉的结果：成功带行、失败带原因（合并器不把异常抛给调用方，只负责节奏与归属）。 */
sealed class TreeFetch {
    data class Loaded(val rows: List<SessionRow>) : TreeFetch()
    data class Failed(val message: String) : TreeFetch()
}

/**
 * 前台「树实时订阅」：`GET /api/tree/events` 的帧 ⇒ **合并后的**权威 `GET /api/tree` 重拉。
 *
 * 为什么中间要有合并这一层（三条都是踩过的形状，不是“架构”）：
 *
 * 1. **不发请求风暴**：一发事件一发 `/tree` 会把上游的慢放大成全树扫描的并发风暴
 *    （见 `docs/plans/diagnosis-2026-10-09-tree-under-command-load.md`）。⇒ 同一时刻**最多一发在飞**；
 *    在飞期间的请求只置 `dirty`。
 * 2. **不丢最终状态**：在飞那一发回来后若 `dirty` 还立着，**再补一发** —— 合并可以省请求，但绝不
 *    让列表停在“事件已发生、界面还是旧的”那个状态上。
 * 3. **归属**：`stop()`（后台 / 断开 / 切配置 / close）之后，旧流回调与在飞结果**一个字节都不许写**。
 *    每次 `start()` 拿一个新 generation，`stop()` 立刻把它作废；结果回来时按 generation 核对，
 *    旧的一律丢弃（连“不重发”一起丢 —— 旧归属不许再驱动任何网络动作）。generation 是**单调递增**的
 *    长整数，所以“新实例又从 1 开始”这种撞号不会发生（调用方另有一层它自己的 epoch，见 `AppState`）。
 *
 * 生命周期与 [SessionStream] 同一条前台纪律：只在前台挂着；断线由 [ReconnectBackoff] 退避重连，
 * **重连后一定重新对账**（服务端不读 `Last-Event-ID`，断线期间的事件不会补发）。
 *
 * ⚠️ `stop()` 取消的是 OkHttp 的 Call 与在飞的刷新协程；**native fd 是否真被 close 没有真机证据**
 * （libzt 的 `ZeroTierSocket.isClosed()` 只反映它自己调用过 close，看不到对端半关）⇒ 这里不写“已释放”。
 */
class TreeLive(
    private val scope: CoroutineScope,
    private val client: OkHttpClient,
    /** 权威重拉（`SophoApi.tree()`；单测里是可控制的假实现）。 */
    private val fetch: suspend () -> List<SessionRow>,
    /** 一次重拉的回执。**只有归属仍是当前 generation 时才会收到**；旧归属的迟到结果不会到这里。 */
    private val onResult: (generation: Long, result: TreeFetch, explicit: Boolean) -> Unit,
    /**
     * 流状态（连接中/已连接/已重连/收流/失败 + 人话细节），**带 generation**：
     *
     * 与 [onResult] 同一条门 —— 只给结果带归属、不给状态带，是上一版的缺口：
     * 旧归属的“● 已连接”照样可能写进主状态。调用方应在执行时拿它与自己的归属号比一次。
     */
    private val onState: (generation: Long, state: StreamState, detail: String?) -> Unit,
    private val headersTimeoutMs: Long = SSE_HEADERS_TIMEOUT_MS,
) {
    private val lock = Any()

    /** 单调递增的归属号：`start`/`stop` 各 +1。**不**按实例重置（撞号会把旧结果放进新归属）。 */
    private var epoch = 0L
    private var started = false
    private var dirty = false
    private var dirtyExplicit = false

    /**
     * 「在飞」标记**绑在 generation 上**（-1 = 没有在飞的）。不能用一个裸 boolean：
     * 旧归属的循环退出时，它的收尾（`finally`）可能跑在**新**归属的循环已经跑之后，
     * 把布尔值清零 ⇒ 下一次事件就会再起第二条并发 GET（合并器失效）。绑 generation 后，
     * 旧循环的收尾只摘它自己的标记，动不到新归属。
     */
    private var refreshingGeneration = -1L

    private var stream: TreeEventsStream? = null
    private var streamJob: Job? = null
    private var refreshJob: Job? = null

    fun generation(): Long = synchronized(lock) { epoch }

    /**
     * 起订阅（**起的同时对账一次**：连接成功后、回前台都走这里 —— 断线期间/后台期间错过的事件
     * 靠这一发补上）。**同一实例重复调用 = 先作废旧归属再起新的，只留一条流**（旧流 cancel、旧循环
     * 与在飞结果作废），所以“同一订阅对象”本身就是唯一拥有者：调用方不需要、也不许另建一个再把旧的漏着。
     */
    fun start(baseUrl: String) {
        val claimed = synchronized(lock) {
            val prev = stream
            epoch += 1
            started = true
            dirty = true
            dirtyExplicit = false
            stream = null
            prev to epoch
        }
        val previous = claimed.first
        val generation = claimed.second
        previous?.cancel()
        streamJob?.cancel()
        streamJob = null
        // 旧归属那一发若还阻塞在读里，cancel 只会在它下一次挂起时生效；结果由 generation 核对丢掉。
        refreshJob?.cancel()
        refreshJob = null

        val created = TreeEventsStream(
            client = client,
            baseUrl = baseUrl,
            onState = { state, detail ->
                // 旧归属的状态一行都不许上屏（它可能是上一条端点/上一次前台的残响）。
                if (synchronized(lock) { generation == epoch }) {
                    // 连上（含重连）都重新对账一次：服务端不读 Last-Event-ID ⇒ 不相信断线期间的事件。
                    if (state == StreamState.OPEN || state == StreamState.OPEN_AFTER_RECONNECT) {
                        requestRefresh(explicit = false)
                    }
                    onState(generation, state, detail)
                }
            },
            onFrame = { type, _ ->
                if (TreeEvents.isTreeFrame(type)) {
                    synchronized(lock) {
                        if (generation == epoch && started) {
                            dirty = true
                            kick()
                        }
                    }
                }
            },
            headersTimeoutMs = headersTimeoutMs,
        )
        synchronized(lock) { if (generation == epoch) stream = created }
        streamJob = scope.launch { created.run() }
        // 起订就对账一发（不依赖第一帧到得多快：连接建立的这一小段里树也可能已经变了）。
        synchronized(lock) { kick() }
    }

    /**
     * 停订阅（后台 / 断开 / 切配置 / close / Activity 关掉）。立刻作废旧归属：
     * 旧流回调、在飞重拉的结果、还没跑的那一发，全部作废；旧归属不会因此再发任何请求。
     */
    fun stop() {
        val previous = synchronized(lock) {
            epoch += 1
            started = false
            dirty = false
            dirtyExplicit = false
            val prev = stream
            stream = null
            prev
        }
        previous?.cancel()
        streamJob?.cancel()
        streamJob = null
        refreshJob?.cancel()
        refreshJob = null
    }

    /**
     * 请一次刷新（用户点「刷新」/ 新建成功 / 从详情回列表时补一发）。
     *
     * @return false = 当前没订阅（后台/未连接）⇒ 什么都没发；这时不亮进度、也不留一个永远转的旋钮。
     *         下次 [start] 会自己补一次对账。
     */
    fun requestRefresh(explicit: Boolean = false): Boolean = synchronized(lock) {
        if (!started) return false
        dirty = true
        if (explicit) dirtyExplicit = true
        kick()
        true
    }

    // ───────────────────────────── 合并器 ─────────────────────────────

    /** 保证“有一发在飞”的协程在跑。**必须在持锁时调用**。 */
    private fun kick() {
        val generation = epoch
        if (refreshingGeneration == generation) return
        refreshingGeneration = generation
        refreshJob = scope.launch { refreshLoop(generation) }
    }

    private suspend fun refreshLoop(generation: Long) {
        try {
            while (true) {
                val explicit = synchronized(lock) {
                    // 归属换掉 / 已停 / 没活：退出（`dirty` 已在 stop/start 里清掉，不会留下没人管的待办）。
                    if (generation != epoch || !started || !dirty) return
                    dirty = false
                    val wasExplicit = dirtyExplicit
                    dirtyExplicit = false
                    wasExplicit
                }

                val result = try {
                    TreeFetch.Loaded(fetch())
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    TreeFetch.Failed(error.message ?: error.javaClass.simpleName)
                }

                // 归属核对在**回调之前**：旧归属的结果不写字、也不再驱动下一发。
                synchronized(lock) { if (generation != epoch) return }
                onResult(generation, result, explicit)
            }
        } finally {
            // 收尾时把「在飞」摘掉；若这之间又有 dirty 攒下（事件恰好在最后那一发回来后到），补一发。
            // 少了这一步，`dirty` 会有一次没人管的时刻 —— 列表就停在旧状态上（“丢最终状态”）。
            val again = synchronized(lock) {
                if (refreshingGeneration == generation) refreshingGeneration = -1L
                generation == epoch && started && dirty
            }
            if (again) synchronized(lock) { kick() }
        }
    }
}
