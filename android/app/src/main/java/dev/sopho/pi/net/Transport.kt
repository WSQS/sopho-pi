package dev.sopho.pi.net

import okhttp3.ConnectionPool
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * 原型只连「自己控制的回环/私网」。真正的收窄在这里（应用层），不是全局 `usesCleartextTraffic`：
 * 公网地址直接拒绝并说明原因 —— 见 items/android-client/item.md「限制」。
 */
object Destinations {
    /** null = 可以连；否则是直接上屏的中文拒绝原因。 */
    fun refusal(urlText: String): String? {
        val url: HttpUrl = urlText.trim().toHttpUrlOrNull()
            ?: return "地址不合法：$urlText（形如 http://10.0.2.2:7399）"
        if (url.scheme == "https") {
            return "https 未验：libzt 之上没有 TLS 证据，这里只走明文 http"
        }
        if (url.scheme != "http") return "只支持 http://"
        if (!isPrivateHost(url.host)) {
            return "只用明文连回环/私网地址：${url.host} 不像私网 —— 公网入口暂不支持"
        }
        return null
    }

    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase()
        if (h == "localhost" || h == "10.0.2.2") return true
        val octets = h.split('.')
        if (octets.size != 4) return false
        val parts = octets.map { it.toIntOrNull() ?: return false }
        if (parts.any { it < 0 || it > 255 }) return false
        val (a, b) = parts[0] to parts[1]
        return when {
            a == 127 -> true                                  // 回环
            a == 10 -> true                                   // 10/8（含模拟器→宿主的 10.0.2.2）
            a == 192 && b == 168 -> true                      // 192.168/16
            a == 172 && b in 16..31 -> true                   // 172.16/12
            a == 169 && b == 254 -> true                      // 链路本地
            a == 100 && b in 64..127 -> true                  // CGNAT（Tailscale 等）
            else -> false
        }
    }
}

/** 一套 HTTP 客户端：普通请求有读超时；SSE 那套的读超时用来判「心跳断了」；POST 那套**不许隐式重放**。 */
class Transport(
    val client: OkHttpClient,
    val sseClient: OkHttpClient,
    /** 发送专用：`retryOnConnectionFailure(false)` + 不跟重定向 + 不装 authenticator。 */
    val postClient: OkHttpClient,
)

object Transports {
    /**
     * 服务端 SSE 的心跳是 15 s（`server/base-logic.mjs` 的 `beginSse`），所以读超时给 40 s：
     * 超过这个时间一个字节都没有 = 这条流已经死了 ⇒ 由调用方重连并重新对账。
     */
    private const val SSE_READ_TIMEOUT_SECONDS = 40L

    /**
     * SSE 专用 client **不复用连接**：libzt 的 `ZeroTierSocket.isClosed()` 只反映它自己调用过 close，
     * 看不到对端半关；池里的旧连接一旦半死，重连会一直读到假死连接上（读超时又曾被 AAR 的单位 bug
     * 放大到小时级）。每条 SSE 连接都新建/新建失败就 close，代价是每次重连走一次 libzt connect，
     * 换来的是“失败可见、不挂旧连接”。
     *
     * 这里先把 GET client `build()` 出来，再用它的 `newBuilder()`：OkHttp 的 `newBuilder()` 会
     * **共享同一个 ConnectionPool 对象**，所以下面必须显式换上 `ConnectionPool(0, …)` ——
     * GET client 自己的池不受影响；POST 用的是另一个独立 builder，池也是另一个。
     */
    private fun sseClientOf(getClient: OkHttpClient): OkHttpClient = getClient
        .newBuilder()
        .readTimeout(SSE_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectionPool(ConnectionPool(0, 1, TimeUnit.MILLISECONDS))
        .build()

    /**
     * 发送（POST）专用的那一套：**关掉隐式重放**。
     *
     * OkHttp 的默认 `retryOnConnectionFailure=true` 会在“请求可能已经写上去了”的连接故障上换路由重试，
     * 而服务端这两个写口**没有幂等键** ⇒ 一次隐式重发就可能变成两条消息。所以这里三样全关：
     * `retryOnConnectionFailure(false)`、`followRedirects(false)`、`followSslRedirects(false)`；
     * 也没装 `authenticator`（装了也会在 401 时自动重试）。超时一律当成“结果未知”上屏，不自动重发。
     */
    private fun postBuilder(): OkHttpClient.Builder = OkHttpClient.Builder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)

    fun plain(): Transport {
        val base = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(25, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
        val getClient = base.build()
        return Transport(
            client = getClient,
            sseClient = sseClientOf(getClient),
            postClient = postBuilder().build(),
        )
    }

    fun overLibzt(host: String, port: Int): Transport {
        val base = OkHttpClient.Builder()
            .socketFactory(dev.sopho.pi.zt.ZeroTierSocketsSocketFactory(host, port))
            // 这个值现在会真的进 native：socket 适配层把它传给 zts_connect（0 会变成 10s，不再是 native 的 30s）。
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(25, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
        val getClient = base.build()
        return Transport(
            client = getClient,
            sseClient = sseClientOf(getClient),
            postClient = postBuilder()
                .socketFactory(dev.sopho.pi.zt.ZeroTierSocketsSocketFactory(host, port))
                .connectTimeout(15, TimeUnit.SECONDS)
                .build(),
        )
    }
}
