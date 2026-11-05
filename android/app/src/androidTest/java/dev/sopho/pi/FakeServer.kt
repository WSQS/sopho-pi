package dev.sopho.pi

import dev.sopho.pi.net.SessionRow
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * 仪表化测试进程里的**最小假服务端**（只跑在测试进程内，绑 `127.0.0.1` 的**临时端口**）。
 *
 * 为什么不是外部进程：本轮验的是「AppState 在真实 Android Context + 真实 Prefs 下的行为」，
 * 而 AppState 用的是**真 OkHttp / 真 TCP**。所以只把「服务端」换成可控的假货，其余一概是真的：
 * 不开固定端口、不起宿主机进程、不碰 7331/7321，也不碰上一个会话留下的 7399/7499。
 *
 * 能力（够这几组行为用，不多做）：
 * - `GET /api/tree` → 由 [treeJson] 决定；
 * - `GET /api/sessions/{id}/messages` → 由 [messageBodies] 决定，可加 [messageDelays] 让某个 GET **慢回来**；
 * - `GET /api/sessions/{id}/events` → SSE：先回 `retry: 1000`，然后一直挂着，[push] 往里推帧；
 * - `POST /api/sessions/{id}/message|steer` → 由 [postStatus]/[postBody]/[postDelayMs] 决定；
 * - `POST /api/sessions`（建空会话）→ 由 [createStatus]/[createBody]/[createDelayMs]/[createAbort] 决定。
 *
 * 观测点（都是**服务端侧**的计数，不是客户端自述）：收到了几次 GET、几次 POST、SSE 开/关、推帧成功失败。
 */
class FakeServer(val label: String) : Closeable {

    private val serverSocket = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    val port: Int = serverSocket.localPort
    val baseUrl: String get() = "http://127.0.0.1:$port"

    @Volatile private var running = true

    // ── 可编排的响应 ──
    @Volatile var treeJson: String = """{"sessions":[]}"""
    val messageBodies = ConcurrentHashMap<String, String>()
    val messageDelays = ConcurrentHashMap<String, Long>()
    @Volatile var postStatus: Int = 202
    @Volatile var postBody: String = """{"accepted":true,"sessionId":"{{sessionId}}"}"""
    @Volatile var postDelayMs: Long = 0L
    /** 按路由覆盖（`message` / `steer`）：没覆盖的键回落到上面的 postStatus/postBody/postDelayMs。 */
    val routeStatus = ConcurrentHashMap<String, Int>()
    val routeBody = ConcurrentHashMap<String, String>()
    val routeDelayMs = ConcurrentHashMap<String, Long>()

    // ── 新建会话（`POST /api/sessions`）──
    /** 201 回执：形状照 `server/base-logic.mjs` 的 `POST /sessions`（summary ＋ scratch/placement 等）。 */
    @Volatile var createStatus: Int = 201
    @Volatile var createBody: String = created(
        id = "22222222-2222-4222-8222-222222222222",
        name = "新的空会话",
        cwd = "/srv/scratch/22222222-2222-4222-8222-222222222222",
        scratch = true,
    )
    @Volatile var createDelayMs: Long = 0L

    /** true ⇒ 收到创建请求就把连接关掉，不写任何响应（客户端拿到 IOException ⇒ “结果未知”）。 */
    @Volatile var createAbort: Boolean = false

    // ── 命令清单 / 模型目录 / 会话详情（M 线：命令与模型设置）──
    /** `{{sid}}` 会被换成 URL 上那条会话的 id。 */
    @Volatile var commandsStatus: Int = 200
    @Volatile var commandsBody: String =
        """{"sessionId":"{{sid}}","streaming":false,"compacting":false,"canRun":true,"commands":[]}"""
    @Volatile var commandsDelayMs: Long = 0L

    @Volatile var modelsStatus: Int = 200
    @Volatile var modelsBody: String =
        """{"sessionId":"{{sid}}","hot":true,"error":null,"current":null,"source":"none","models":[]}"""
    @Volatile var modelsDelayMs: Long = 0L

    /** `GET /sessions/{id}`（详情回读：`runtime.model` / `runtime.thinkingLevel`）。 */
    @Volatile var detailStatus: Int = 200
    @Volatile var detailBody: String =
        """{"id":"{{sid}}","runtime":{"streaming":false,"model":null,"thinkingLevel":null}}"""
    @Volatile var detailDelayMs: Long = 0L

    // ── 服务端侧观测 ──
    val treeGets = AtomicInteger()
    /** 收到 `/messages` 的 sessionId（按到达顺序）。 */
    val messageGets = CopyOnWriteArrayList<String>()
    /** 延迟过完、**真的写回去**的 `/messages`（用来证明「迟到的响应确实回来了」）。 */
    val messageDelivered = CopyOnWriteArrayList<String>()
    /** 收到 POST 的路径尾段（`message` / `steer`）。 */
    val postCalls = CopyOnWriteArrayList<String>()
    /** 每条发送 POST 的（路由, 请求体原文）—— 用来断言“切路只换路由、不换那句话”。 */
    val postBodies = CopyOnWriteArrayList<Pair<String, String>>()
    /** 收到创建请求的次数，以及每一条的**请求体原文**（用来断言“只送服务端认的那几个字段”）。 */
    val createCalls = AtomicInteger()
    val createBodies = CopyOnWriteArrayList<String>()
    val sseOpened = CopyOnWriteArrayList<String>()
    /** 客户端主动关掉的流（服务端读返回 -1 / 异常） —— 用来证明「切配置先断旧 SSE」。 */
    val sseClosed = CopyOnWriteArrayList<String>()
    val ssePushesOk = AtomicInteger()
    val ssePushesFailed = AtomicInteger()

    /** 收到 `GET /commands` 的次数（断言“只在打开命令页/手动重试时拉”，不预取）。 */
    val commandGets = AtomicInteger()
    /** 收到 `GET /models` 的次数。 */
    val modelGets = AtomicInteger()
    /** 收到 `GET /sessions/{id}`（详情回读）的 sessionId 列表。 */
    val detailGets = CopyOnWriteArrayList<String>()

    private val streams = ConcurrentHashMap<String, SseConn>()

    private val acceptThread = Thread({ acceptLoop() }, "fake-$label-accept").apply {
        isDaemon = true
        start()
    }

    private inner class SseConn(private val out: OutputStream) {
        private val lock = Any()
        private var seq = 0

        fun send(type: String, data: String) {
            synchronized(lock) {
                seq += 1
                out.write("id: $seq\nevent: $type\ndata: $data\n\n".toByteArray())
                out.flush()
            }
        }
    }

    /** 往某个会话的流里推一帧。返回 false = 现在没有开着的流（或写失败），并记进 [ssePushesFailed]。 */
    fun push(sessionId: String, type: String, data: String): Boolean {
        val conn = streams[sessionId]
        if (conn == null) {
            ssePushesFailed.incrementAndGet()
            return false
        }
        return try {
            conn.send(type, data)
            ssePushesOk.incrementAndGet()
            true
        } catch (_: Throwable) {
            ssePushesFailed.incrementAndGet()
            false
        }
    }

    fun hasStream(sessionId: String): Boolean = streams.containsKey(sessionId)

    private fun acceptLoop() {
        while (running) {
            val socket = try {
                serverSocket.accept()
            } catch (_: Throwable) {
                return
            }
            val worker = Thread({ serve(socket) }, "fake-$label-conn")
            worker.isDaemon = true
            worker.start()
        }
    }

    private fun serve(socket: Socket) {
        try {
            val input: InputStream = socket.getInputStream()
            val out: OutputStream = socket.getOutputStream()
            val requestLine = readAsciiLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1]
            var contentLength = 0
            while (true) {
                val line = readAsciiLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0 && line.substring(0, colon).trim().equals("Content-Length", ignoreCase = true)) {
                    contentLength = line.substring(colon + 1).trim().toIntOrNull() ?: 0
                }
            }
            if (contentLength > 0) {
                // 必须**按字节**读：Content-Length 是字节数，而正文可能是中文（多字节 UTF-8）——
                // 当字符数读会一直等到超时（本夹具自己踩过一次：那条 POST 永远也没“到”）。
                val bytes = ByteArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = input.read(bytes, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                lastPostBody = String(bytes, 0, read, Charsets.UTF_8)
            }
            route(method, path, input, out)
        } catch (_: Throwable) {
            // 客户端断开/取消：假服务端不当错误处理（真实服务的表现也一样：连接没了就没了）。
        } finally {
            runCatching { socket.close() }
        }
    }

    /** 按字节读一行（只用于请求行与头，全是 ASCII；不预读、不做缓冲，SSE 那半边直接用同一个流）。 */
    private fun readAsciiLine(input: InputStream): String? {
        val builder = StringBuilder()
        while (true) {
            val byte = input.read()
            if (byte < 0) return if (builder.isEmpty()) null else builder.toString()
            if (byte == '\n'.code) return builder.toString().trimEnd('\r')
            builder.append(byte.toChar())
        }
    }

    @Volatile
    var lastPostBody: String = ""

    private fun route(method: String, path: String, input: InputStream, out: OutputStream) {
        when {
            method == "GET" && path == "/api/tree" -> {
                treeGets.incrementAndGet()
                respond(out, 200, "application/json", treeJson)
            }

            method == "GET" && path.startsWith("/api/sessions/") && path.endsWith("/messages") -> {
                val sessionId = path.removePrefix("/api/sessions/").removeSuffix("/messages")
                messageGets += sessionId
                val delay = messageDelays[sessionId] ?: 0L
                if (delay > 0) Thread.sleep(delay)
                messageDelivered += sessionId
                respond(out, 200, "application/json", messageBodies[sessionId] ?: """{"messages":[]}""")
            }

            // 命令清单 / 模型目录 / 详情回读（M 线）：都是只读 GET，形状照真服务端。
            method == "GET" && path.startsWith("/api/sessions/") && path.endsWith("/commands") -> {
                val sessionId = path.removePrefix("/api/sessions/").removeSuffix("/commands")
                commandGets.incrementAndGet()
                if (commandsDelayMs > 0) Thread.sleep(commandsDelayMs)
                respond(out, commandsStatus, "application/json", commandsBody.replace("{{sid}}", sessionId))
            }

            method == "GET" && path.startsWith("/api/sessions/") && path.endsWith("/models") -> {
                val sessionId = path.removePrefix("/api/sessions/").removeSuffix("/models")
                modelGets.incrementAndGet()
                if (modelsDelayMs > 0) Thread.sleep(modelsDelayMs)
                respond(out, modelsStatus, "application/json", modelsBody.replace("{{sid}}", sessionId))
            }

            // 详情（回读）：路径里**不再有**后续段才命中（messages/events/commands/models 都含 `/`）。
            method == "GET" && path.startsWith("/api/sessions/") &&
                !path.removePrefix("/api/sessions/").contains('/') -> {
                val sessionId = path.removePrefix("/api/sessions/")
                detailGets += sessionId
                if (detailDelayMs > 0) Thread.sleep(detailDelayMs)
                respond(out, detailStatus, "application/json", detailBody.replace("{{sid}}", sessionId))
            }

            method == "GET" && path.startsWith("/api/sessions/") && path.endsWith("/events") -> {
                val sessionId = path.removePrefix("/api/sessions/").removeSuffix("/events")
                out.write(
                    (
                        "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/event-stream\r\n" +
                            "Cache-Control: no-cache\r\n" +
                            "Connection: close\r\n\r\n" +
                            "retry: 1000\n\n"
                        ).toByteArray(),
                )
                out.flush()
                val conn = SseConn(out)
                streams[sessionId] = conn
                sseOpened += sessionId
                // 阻塞读到客户端关流（EOF）为止 —— 这一半就是「旧 SSE 有没有被断」的证据。
                try {
                    while (input.read() >= 0) {
                        // 客户端不会往 SSE 上写东西；读到 -1/异常 = 它把连接关了。
                    }
                } catch (_: Throwable) {
                    // 同上：连接被掐就是我们要观测的那件事。
                }
                streams.remove(sessionId, conn)
                sseClosed += sessionId
            }

            method == "POST" && path == "/api/sessions" -> {
                createCalls.incrementAndGet()
                createBodies += lastPostBody
                if (createDelayMs > 0) Thread.sleep(createDelayMs)
                // 直接关连接（不写响应）：客户端看到的是 IOException ⇒ 结果"未知"，不是"没建成"。
                if (createAbort) return
                respond(out, createStatus, "application/json", createBody)
            }

            method == "POST" && path.startsWith("/api/sessions/") -> {
                val routeName = path.substringAfterLast('/')
                // body 里的 `{{sessionId}}` 换成 URL 上那条会话（服务端真回执就是带 sessionId 的）。
                val sessionId = path.removePrefix("/api/sessions/").substringBefore('/')
                postCalls += routeName
                postBodies += routeName to lastPostBody
                val delay = routeDelayMs[routeName] ?: postDelayMs
                if (delay > 0) Thread.sleep(delay)
                val body = (routeBody[routeName] ?: postBody).replace("{{sessionId}}", sessionId)
                respond(out, routeStatus[routeName] ?: postStatus, "application/json", body)
            }

            else -> respond(out, 404, "application/json", """{"error":"not_found"}""")
        }
    }

    private fun respond(out: OutputStream, status: Int, contentType: String, body: String) {
        val bytes = body.toByteArray()
        val head = "HTTP/1.1 $status ${reason(status)}\r\n" +
            "Content-Type: $contentType; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray())
        out.write(bytes)
        out.flush()
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        202 -> "Accepted"
        400 -> "Bad Request"
        404 -> "Not Found"
        409 -> "Conflict"
        500 -> "Internal Server Error"
        else -> "Status"
    }

    override fun close() {
        running = false
        streams.keys.toList().forEach { id -> streams.remove(id) }
        runCatching { serverSocket.close() }
        runCatching { acceptThread.join(500) }
    }

    // ── 测试里拼 JSON 的小工具（只覆盖这几组要用的形状，字段名照服务端真 schema）──

    companion object {
        fun tree(vararg rows: SessionRow): String = buildString {
            append("""{"sessions":[""")
            rows.forEachIndexed { index, row ->
                if (index > 0) append(',')
                append("{\"id\":\"${row.id}\",\"name\":\"${row.name ?: row.id}\",\"status\":\"${row.status}\",")
                append("\"statusLabel\":\"闲置\",\"archived\":false}")
            }
            append("]}")
        }

        /** 一行会话（原型只画 user/assistant 且有正文的，所以别塞别的 role）。 */
        fun row(id: String, name: String, status: String = "idle"): SessionRow =
            SessionRow(id, name, status, "闲置", false, "/tmp/$name", null, null)

        /**
         * `POST /sessions` 的 201 回执（只含本组测试要断言的字段；字段名宇母级照服务端形状）。
         * `placementPersisted=false` 时就像服务端那样带一句 `warning`。
         */
        fun created(
            id: String,
            name: String?,
            cwd: String,
            scratch: Boolean = false,
            placementPersisted: Boolean = true,
            warning: String? = null,
        ): String = buildString {
            append("{\"id\":\"$id\",\"name\":")
            append(if (name == null) "null" else "\"$name\"")
            append(",\"cwd\":\"$cwd\",\"status\":\"idle\",\"statusLabel\":\"闲置\",\"archived\":false")
            append(",\"scratch\":$scratch,\"placementPersisted\":$placementPersisted")
            append(",\"warning\":")
            append(if (warning == null) "null" else "{\"code\":\"placement_write_failed\",\"message\":\"$warning\"}")
            append("}")
        }

        fun messages(vararg entries: Pair<String, String>): String = buildString {
            append("""{"messages":[""")
            entries.forEachIndexed { index, (role, text) ->
                if (index > 0) append(',')
                append("{\"entryId\":\"e$index\",\"role\":\"$role\",\"text\":\"$text\"}")
            }
            append("]}")
        }

        /** `POST /sessions/{id}/message` 的 202 回执（`{{sessionId}}` 由假服务端换成 URL 上的会话）。 */
        fun acceptedMessage(sessionId: String = "{{sessionId}}"): String =
            """{"accepted":true,"sessionId":"$sessionId"}"""

        /**
         * 带**图片凭据**的 202（契约暂定：`images: <服务端实际接收的张数>`）。
         * 客户端据此才敢把带图发送算成“已接受”；没有这个字段就只能报“图片未被确认”。
         */
        fun acceptedMessageWithImages(count: Int, sessionId: String = "{{sessionId}}"): String =
            """{"accepted":true,"sessionId":"$sessionId","images":$count}"""

        fun acceptedSteerWithImages(count: Int, sessionId: String = "{{sessionId}}"): String =
            """{"accepted":true,"mode":"steer","sessionId":"$sessionId","images":$count}"""

        /** `POST /sessions/{id}/steer` 的 202 回执（带 `mode:'steer'`，与真服务端一致）。 */
        fun acceptedSteer(sessionId: String = "{{sessionId}}"): String =
            """{"accepted":true,"mode":"steer","sessionId":"$sessionId"}"""

        /** 入队前的忙冲突形状（`{error, message}`）。 */
        fun conflict(code: String): String =
            """{"error":"$code","message":"fixture conflict"}"""
    }
}
