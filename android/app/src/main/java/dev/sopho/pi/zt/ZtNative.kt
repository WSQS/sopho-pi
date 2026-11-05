package dev.sopho.pi.zt

import com.zerotier.sockets.ZeroTierNative
import com.zerotier.sockets.ZeroTierNode

/** libzt 的错误码（固定 AAR 的上游 `include/ZeroTierSockets.h:34-44`，revision a707ea6）。 */
internal object ZtsErr {
    const val OK = 0
    const val SOCKET = -1
    const val SERVICE = -2
    const val ARG = -3
    const val NO_RESULT = -4
    const val GENERAL = -5

    fun name(code: Int): String = when (code) {
        OK -> "ZTS_ERR_OK"
        SOCKET -> "ZTS_ERR_SOCKET"
        SERVICE -> "ZTS_ERR_SERVICE"
        ARG -> "ZTS_ERR_ARG"
        NO_RESULT -> "ZTS_ERR_NO_RESULT"
        GENERAL -> "ZTS_ERR_GENERAL"
        else -> "契约外的返回码"
    }

    /**
     * `ZTS_ERR_SERVICE`（-2）在**初始化类**调用上的唯一来源（源码 ＋ AAR 里 x86_64 `libzt.so` 的
     * `zts_init_from_storage@0xdbcf0` 反汇编两处都对过）：
     * `ACQUIRE_SERVICE_OFFLINE` 里 `zts_service && zts_service->isRunning()` 为真
     * （`src/Events.hpp:40-47`）—— 也就是**本进程里已经有一个 libzt 服务在跑**。
     * 同宏里 `init_subsystems()` 的返回码被丢弃，`zts_init_from_storage` 又把 `setHomePath()` 的返回码丢掉
     * （`src/Controls.cpp:85-89`）⇒ identity 目录的读写权限**进不了**这条 -2 判据。
     */
    fun serviceHint(code: Int): String = when (code) {
        SERVICE ->
            "ZTS_ERR_SERVICE（-2）只有一条来源：本进程里 libzt 服务已在运行，而 init/start 只允许在服务没跑时调用。" +
                "这与 identity 目录的读写权限无关。本应用从不调用 zts_node_stop()，所以这个状态在本进程内不可恢复" +
                "（重启应用进程即可；不要清数据、不要卸载、不要删 identity）。"
        ARG -> "ZTS_ERR_ARG（-3）：参数非法（例如路径为空），与网络/权限无关。"
        else -> ""
    }
}

/** 一次 libzt 调用落在哪一步 —— 失败时必须按这一步报，不笼统说「初始化失败」。 */
enum class ZtStage(val label: String) {
    INIT_IDENTITY("identity 初始化（initFromStorage）"),
    START_NODE("启动节点（zts_node_start）"),
    WAIT_ONLINE("等待节点上线"),
    MOON_ORBIT("Moon orbit（zts_moon_orbit）"),
    JOIN_NETWORK("加入网络（zts_net_join）"),
    WAIT_TRANSPORT("等待网络就绪"),
    WAIT_ADDRESS("等待分配地址"),
}

/** 生命周期调用的结果：成功，或「哪一步 + 哪个码 + 人话」。 */
sealed interface ZtResult {
    data object Ok : ZtResult
    data class Failed(val stage: ZtStage, val code: Int?, val text: String) : ZtResult
}

/**
 * libzt 的 native 调用面（真实现直接转 AAR；JVM 单测换成按真实契约建模的假货）。
 *
 * 为什么要有这一层：native 状态**不属于**任何一个 wrapper 对象 —— `ZeroTierNode` 只是几个
 * `static native` 的薄壳（固定 AAR 里 `ZeroTierNode.class` 的构造器字节码是空的，`ZeroTierNative` 的静态块
 * 只做 `System.loadLibrary` + `zts_init`（存 JavaVM），`libzt.so` 里没有 `JNI_OnLoad`），
 * 真正有状态的是进程全局的 `NodeService* zts_service`（`src/Controls.cpp:51-55`）。
 * ⇒ **拿一个新 wrapper 不等于一个新的 native 实例**；要钉住调用次数/序列/失败清理，就必须能在单测里换掉 native。
 */
interface ZtNative {
    fun initFromStorage(path: String): Int
    fun start(): Int
    fun isOnline(): Boolean
    fun join(networkId: Long): Int
    fun leave(networkId: Long): Int
    fun isTransportReady(networkId: Long): Boolean
    fun addrIsAssigned(networkId: Long, family: Int): Int
    fun nodeId(): Long
    fun ipv4(networkId: Long): String?
    fun orbit(worldId: Long, seedId: Long): Int
}

/** 真实现：整个进程只有这一个 `ZeroTierNode`（native 侧本来就只有一个服务）。 */
internal class AarZtNative : ZtNative {

    private val node = ZeroTierNode()

    override fun initFromStorage(path: String): Int = node.initFromStorage(path)

    override fun start(): Int = node.start()

    // 故意**没有** stop：`zts_node_stop()` 的 JNI 壳无条件 `DetachCurrentThread` ⇒ 真机 SIGABRT
    // （`src/bindings/java/JavaSockets.cxx:454-459`；2026-10-23 AVD 实测），且它会与自己的 service 线程
    // 竞争删除进程全局实例（`src/Controls.cpp:530-550`）。接口上不给这个方法，就没人能误调。

    override fun isOnline(): Boolean = node.isOnline

    override fun join(networkId: Long): Int = node.join(networkId)

    override fun leave(networkId: Long): Int = node.leave(networkId)

    override fun isTransportReady(networkId: Long): Boolean = node.isNetworkTransportReady(networkId)

    override fun addrIsAssigned(networkId: Long, family: Int): Int =
        ZeroTierNative.zts_addr_is_assigned(networkId, family)

    override fun nodeId(): Long = node.id

    override fun ipv4(networkId: Long): String? = node.getIPv4Address(networkId)?.hostAddress

    override fun orbit(worldId: Long, seedId: Long): Int = ZeroTierNative.zts_moon_orbit(worldId, seedId)
}

/**
 * 进程级唯一 owner（native 侧本来就是进程全局的一个服务）。
 *
 * 生命周期只有这几种状态，而且**只能通过这里**改变：
 * - `NOT_STARTED`：还没 init、也没 start；
 * - `STARTED`：native 服务在跑（本应用**从不**让它停，见 [ZtNode] 的说明）；网络可以留、也可以已经被 leave 掉；
 * - `BROKEN`：native 报了「本进程内不可恢复」的码（典型就是 -2），记录下来、**不再重试**。
 */
object ZtRuntime {
    val node: ZtNode by lazy { ZtNode(AarZtNative()) }
}
