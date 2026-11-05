package dev.sopho.pi.zt

/**
 * 一个进程里**唯一**的 libzt 生命周期 owner（native 侧本来就只有一个服务，见 [ZtRuntime]）。
 *
 * 规矩只有四条，全部在同一个锁里执行（所以没有「先看一眼 isRunning 再调用」那种 TOCTOU）：
 * 1. `init` 只做一次，而且只在服务**没在跑**时做（跑着时 `zts_init_from_storage` 会返回 -2）；
 * 2. `start` 只在没启动时做，成功一次之后**再调也只算「已启动」**，不重发 native 调用；
 * 3. **从不调用 `zts_node_stop()`**，两条独立理由：
 *    - JNI 层 `Java_com_zerotier_sockets_ZeroTierNative_zts_1node_1stop` **无条件**调
 *      `java_detach_from_thread()`（`src/bindings/java/JavaSockets.cxx:454-459`）⇒ 在 ART 上直接
 *      SIGABRT「attempting to detach while still running code」（2026-10-23 在专属 AVD 上实测到，见 docs §18）；
 *    - 就算不崩：`_runNodeService` 在 `run()` 返回后会无条件 `delete zts_service; zts_service = 0`
 *      （`src/Controls.cpp:530-550`），而它是进程全局的 —— 紧接着再 start，新线程就会在旧线程刚删掉的
 *      对象上 `run()`（或对 nullptr 解引用）。
 *    所以节点的寿命 = 进程的寿命；「断开」= `zts_net_leave`，不是停节点；
 * 4. native 一旦报出本进程内不可恢复的码（典型 -2），记进 [Phase.BROKEN] 并**不再重试**，
 *    不假装「又是未启动状态」；
 * 5. 节点里「此刻 join 着的那张网」只有**一个持有者**（租约/lease）：谁 join 成功就把租约换给它；
 *    `disconnect` 只有**当前**持有者叫得动，别人的迟到 `close()`/失败清理一律是空操作。
 *    为什么需要这一条：native 状态是进程全局的，而 `ZtManager`（进而 `AppState`）是每个 Activity 一个 ——
 *    没有租约的话，「旧实例晚到的 close」会把新实例刚 join 的网 leave 掉。
 *
 * 由此，失败/超时之后 owner 的状态仍然是「native 在跑」（[Phase.STARTED]）—— 这是**事实**：
 * native 确实还在跑，只是没有网。重试只是重新 join，不重新 init/start。
 */
class ZtNode(private val native: ZtNative) {

    enum class Phase { NOT_STARTED, STARTED, BROKEN }

    /** 本进程 init 过的 identity 目录。init 是进程级一次性动作：不重复、也不中途换目录。 */
    private var initializedPath: String? = null
    private var started = false
    private var broken: ZtResult.Failed? = null

    /** 节点上此刻留着的那张网（null = 没 join 任何网）。 */
    private var joinedNetwork: Long? = null

    /**
     * 本进程里已经 orbit 过的 Moon（World, Seed）。
     * `zts_moon_orbit` 是进程级 roots 表上的动作：同一个 moon 重复 orbit 没有收益，
     * 而“同 network 同 Moon、不同 serverUrl”的 Profile 切换/新 Activity 接管会走到这里 ——
     * 记下来就能做到**零多余 native 调用**。换 Moon 时仍会 orbit 新的；旧 moon 不会被移除（本单不做 deorbit）。
     */
    private var orbitedMoon: Pair<Long, Long>? = null

    /**
     * 那张网的持有者（谁 join 成功就归谁）。租约与 [joinedNetwork] 在**同一把锁**里一起改，
     * 所以没有「先看是谁的、再调用」那种 TOCTOU：非持有者的 leave 请求根本进不去 native。
     */
    private var lease: Any? = null

    @Synchronized
    fun phase(): Phase = when {
        broken != null -> Phase.BROKEN
        started -> Phase.STARTED
        else -> Phase.NOT_STARTED
    }

    /** 本进程是否已经 orbit 过至少一个 Moon（用于“旧 Moon 不会被移除”的如实提示）。 */
    @Synchronized
    fun hasOrbitedMoon(): Boolean = orbitedMoon != null

    /** 这张网是否仍由 [owner] 持有：`ZtManager` 的 Ready 可能因别的实例 leave 而过期，不能只信自己的状态。 */
    @Synchronized
    fun isJoinedBy(networkId: Long, owner: Any): Boolean = joinedNetwork == networkId && lease === owner

    /** 诊断用：owner 自己怎么看自己（不含任何 identity 内容）。 */
    @Synchronized
    fun describe(): String = buildString {
        append("owner=").append(phase().name)
        append("，init 目录=").append(initializedPath ?: "（还没 init）")
        append("，已 join 的网=").append(joinedNetwork?.let { hex(it) } ?: "（无）")
        append("，持有者=").append(if (lease == null) "（无）" else "有一个 ZtManager")
        broken?.let { append("，先前的失败停在「").append(it.stage.label).append("」") }
    }

    /**
     * 只做 identity 的 `initFromStorage`（不启动节点）。
     *
     * ⚠️ 节点**已经**跑着时**不**再调 init：那样只会拿到 -2（服务在跑时不允许 init 类调用），
     * 而 identity 早在 start 之前就已经加载过了 —— 所以这里直接算成功。
     */
    @Synchronized
    fun ensureInitialized(storagePath: String): ZtResult {
        broken?.let { return it }
        val already = initializedPath
        if (already != null) {
            if (already == storagePath) return ZtResult.Ok
            return markBroken(
                ZtStage.INIT_IDENTITY,
                null,
                "本进程已按另一个目录初始化过 identity（$already）；libzt 的 init 是进程级一次性动作，" +
                    "中途换目录必须重启应用进程 —— 本应用不删、不搬 identity。${describe()}",
            )
        }
        val rc = native.initFromStorage(storagePath)
        if (rc != ZtsErr.OK) {
            return markBroken(
                ZtStage.INIT_IDENTITY,
                rc,
                "initFromStorage($storagePath) 返回 $rc ${ZtsErr.name(rc)}。${ZtsErr.serviceHint(rc)}",
            )
        }
        initializedPath = storagePath
        return ZtResult.Ok
    }

    /** identity 一次 + 启动一次。已经启动就直接返回（**不重发** init/start 这两个 native 调用）。 */
    @Synchronized
    fun ensureStarted(storagePath: String): ZtResult {
        val init = ensureInitialized(storagePath)
        if (init !is ZtResult.Ok) return init
        if (started) return ZtResult.Ok
        val rc = native.start()
        if (rc != ZtsErr.OK) {
            return markBroken(
                ZtStage.START_NODE,
                rc,
                "zts_node_start() 返回 $rc ${ZtsErr.name(rc)}。${ZtsErr.serviceHint(rc)}",
            )
        }
        started = true
        return ZtResult.Ok
    }

    /**
     * 让节点只留在 [networkId] 这张网上：先 leave 掉之前那张（**不是**停节点），再 join；
     * 成功后**租约换给 [owner]**（同网也一样：换个实例连同一张网也是归属转移，不因 networkId 相等就把 leave 权留给旧的）。
     *
     * 同网重复 join 是幂等的（不发 native 的 join）；换网时「先 leave 旧网、再 join 新网」的顺序不变。
     */
    @Synchronized
    fun join(networkId: Long, owner: Any): ZtResult {
        broken?.let { return it }
        if (!started) {
            return ZtResult.Failed(
                ZtStage.JOIN_NETWORK,
                null,
                "节点还没启动就不该 join（本应用不会先 join 再 start）。${describe()}",
            )
        }
        val current = joinedNetwork
        if (current == networkId) {
            lease = owner // 同网接管：只换持有者，一次 native 调用都不发
            return ZtResult.Ok
        }
        if (current != null) {
            joinedNetwork = null
            lease = null
            val leaveRc = native.leave(current)
            if (leaveRc != ZtsErr.OK) {
                return ZtResult.Failed(
                    ZtStage.JOIN_NETWORK,
                    leaveRc,
                    "zts_net_leave(${hex(current)}) 返回 $leaveRc ${ZtsErr.name(leaveRc)}：" +
                        "旧网没撤干净，不能在新网上再叠一张（identity 不受影响）。",
                )
            }
        }
        val rc = native.join(networkId)
        if (rc != ZtsErr.OK) {
            return ZtResult.Failed(
                ZtStage.JOIN_NETWORK,
                rc,
                "zts_net_join(${hex(networkId)}) 返回 $rc ${ZtsErr.name(rc)}。",
            )
        }
        joinedNetwork = networkId
        lease = owner
        return ZtResult.Ok
    }

    /**
     * Moon orbit（可选一步）。节点没在跑时**不发**这个调用，直接返回 -2 —— 与 native 的
     * `ACQUIRE_SERVICE(ZTS_ERR_SERVICE)` 判据一致（`src/Controls.cpp:648-653`）。
     * 同一个 moon 重复 orbit 是幂等语义（ZT core 里就是往 roots 表里放同一个 moon）。
     */
    @Synchronized
    fun orbit(worldId: Long, seedId: Long): Int {
        if (broken != null || !started) return ZtsErr.SERVICE
        if (orbitedMoon == (worldId to seedId)) return ZtsErr.OK // 同一个 moon 已经在 roots 里：不重发 native
        val rc = native.orbit(worldId, seedId)
        if (rc == ZtsErr.OK) orbitedMoon = worldId to seedId
        return rc
    }

    /**
     * 断开 = **只 leave 网络，不停节点**（为什么不停见类注释）。
     *
     * **只有当前持有者叫得动**：不是 [owner] 的网 ⇒ 空操作（返回 null，不动 native）。
     * 这条是「旧实例晚到的 close / 失败清理不许把新实例刚连上的网 leave 掉」的机械保证。
     * 重复调用天然幂等：第一次 leave 后 `joinedNetwork` 已是 null。
     *
     * 返回 null = 本来就没 join / 不是持有者 / leave 成功；非 null = 要如实上屏的读数。
     */
    @Synchronized
    fun disconnect(owner: Any): String? {
        val net = joinedNetwork ?: return null
        if (lease !== owner) return null
        joinedNetwork = null
        lease = null
        val rc = native.leave(net)
        return if (rc == ZtsErr.OK) null else
            "zts_net_leave(${hex(net)}) 返回 $rc ${ZtsErr.name(rc)}（这张网可能仍留在节点上）"
    }

    @Synchronized
    fun isOnline(): Boolean = started && broken == null && native.isOnline()

    @Synchronized
    fun isTransportReady(networkId: Long): Boolean = started && native.isTransportReady(networkId)

    /** 与 native 一致：服务没在跑时 `zts_addr_is_assigned` 自己也返回 0（`ACQUIRE_SERVICE(0)`）。 */
    @Synchronized
    fun addrIsAssigned(networkId: Long, family: Int): Int =
        if (started) native.addrIsAssigned(networkId, family) else 0

    /** 节点 ID 只在节点跑起来之后才有；未启动时 native 给的是负的错误码，这里如实返回 null。 */
    @Synchronized
    fun nodeId(): Long? = if (started) native.nodeId().takeIf { it > 0 } else null

    @Synchronized
    fun ipv4(networkId: Long): String? = if (started) native.ipv4(networkId) else null

    private fun markBroken(stage: ZtStage, code: Int?, text: String): ZtResult.Failed {
        val failure = ZtResult.Failed(stage, code, text)
        broken = failure
        return failure
    }

    private fun hex(id: Long): String = java.lang.Long.toHexString(id).padStart(16, '0')
}
