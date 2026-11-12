/*
 * ZXDesk工作台 Android 客户端
 * 文件：LocalProxy.kt
 * 职责：只监听本机的 HTTP 代理，接管 WebView 的解析与转发
 */

package com.zxdesk.core.connection

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * 代理只监听本机回环。
 *
 * ⛔ 别改成 `0.0.0.0`：那等于给同一个 WiFi 下的所有人开一个开放代理。
 */
const val PROXY_HOST: String = "127.0.0.1"

/**
 * `ProxyConfig.Builder.addProxyRule` 要的那条规则。
 *
 * ⚠️ **只写代理地址本身**（`host:port`）。`PROXY host:port` 是 PAC / 旧框架的写法，
 * 传给 androidx 的 `addProxyRule` 属于非法规则，`setProxyOverride` 会抛 `IllegalArgumentException`；
 * 那个异常一旦被吞掉，覆盖就永远设不上，页面表现依旧是 `ERR_NAME_NOT_RESOLVED` ——
 * 看起来像「解析还是不通」，实际是代理从没生效。
 */
fun proxyRuleFor(port: Int): String = "$PROXY_HOST:$port"

/**
 * 本机 HTTP 代理，只为 WebView 而生。
 *
 * 为什么必须有它：Chromium 只认系统解析，`shouldInterceptRequest` 又拿不到 POST body，
 * 想让它绕过被拦的域名，只剩**传输层**这一条路 —— 页面把请求交给一个只在本机监听的代理，
 * 由代理自己解析目标地址。这也正是阿里云 HTTPDNS 的官方做法。
 *
 * 三条硬约束：
 * - **只监听 `127.0.0.1`**：别让局域网里任何设备连进来当跳板；
 * - **日志不记路径与查询串**：那些里有网关票据；
 * - **端口取 0**：由系统分配，自己挑端口迟早撞上别人的。
 *
 * ⚠️ 阻塞实现，每连接一个线程。并发上限见 [maxConnections]，超了直接 502，
 *    不排队 —— 排队只会把「页面打不开」变成「页面转圈」。
 */
class LocalProxy(
    /** 目标地址的解析方式，默认走 [DohDns]（系统不通时改走公共解析）。 */
    private val resolver: (String) -> List<InetAddress> = { DohDns.lookup(it) },
    /** 一行日志。⛔ 别把路径与查询串塞进来。 */
    private val log: (String) -> Unit = {},
    private val connectTimeoutMs: Int = 15_000,
    private val idleTimeoutMs: Int = 5 * 60 * 1000,
    private val maxConnections: Int = 64,
) {
    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val live: MutableSet<Socket> = Collections.newSetFromMap(ConcurrentHashMap())

    /** 实际监听的端口；`0` = 没起。 */
    @Volatile
    var port: Int = 0
        private set

    /**
     * 起服务，返回系统分配的端口。
     *
     * 重复调用返回同一个端口 —— 上层可能因为「解析又被拦了」再叫一次，不该起第二个。
     */
    @Synchronized
    fun start(): Int {
        server?.let { return port }
        val socket = ServerSocket()
        socket.reuseAddress = true
        // ⛔ 绑 0.0.0.0：那等于给同一 WiFi 下的所有人开一个开放代理
        socket.bind(InetSocketAddress(InetAddress.getByName(PROXY_HOST), 0))
        server = socket
        port = socket.localPort
        acceptThread = thread(name = "zxdesk-proxy-accept", isDaemon = true) { acceptLoop(socket) }
        log("代理监听 127.0.0.1:$port")
        return port
    }

    /**
     * 停服务：关监听、断掉所有存活连接、释放端口。
     *
     * ⚠️ 必须真的能断掉 —— 存活连接里卡着读的线程只会在 socket 关闭时才退，
     *    光关监听的话端口还在被占用，下次 [start] 也还能起，但那批线程会一直挂着。
     */
    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        server = null
        live.forEach { runCatching { it.close() } }
        live.clear()
        acceptThread = null
        port = 0
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (true) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                // 关监听时 accept 会抛，正常退出
                return
            }
            if (live.size >= maxConnections) {
                runCatching { reject(client) }
                continue
            }
            live += client
            thread(name = "zxdesk-proxy-conn", isDaemon = true) {
                try {
                    handle(client)
                } catch (_: IOException) {
                    // 客户端提前断开是常态，不记
                } finally {
                    live -= client
                    runCatching { client.close() }
                }
            }
        }
    }

    private fun handle(client: Socket) {
        client.soTimeout = idleTimeoutMs
        val input = BufferedInputStream(client.getInputStream())
        val head = readHead(input) ?: return
        val requestLine = head.lineSequence().firstOrNull()?.trim().orEmpty()
        val parts = requestLine.split(' ')
        if (parts.size < 3) {
            respond(client, "400 Bad Request")
            return
        }
        val method = parts[0]
        val target = parts[1]
        if (method.equals("CONNECT", ignoreCase = true)) {
            tunnel(client, input, target)
        } else {
            forward(client, input, head, method, target)
        }
    }

    /** `CONNECT host:port`：建一条裸隧道，之后双向照抄字节。 */
    private fun tunnel(client: Socket, input: InputStream, target: String) {
        // IPv6 目标在 CONNECT 里带方括号，解析前先剥掉
        val host = target.substringBeforeLast(':', target).removePrefix("[").removeSuffix("]")
        val portNumber = target.substringAfterLast(':', "443").toIntOrNull() ?: 443
        val upstream = connect(host, portNumber) ?: return respond(client, "502 Bad Gateway")
        client.getOutputStream().apply {
            write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            flush()
        }
        // 反向先起线程，正向留在当前线程 —— 两边都必须能独立读到 EOF
        val back = thread(name = "zxdesk-proxy-up", isDaemon = true) {
            pump(upstream.getInputStream(), client)
            runCatching { upstream.close() }
        }
        pump(input, upstream)
        runCatching { upstream.shutdownInput() }
        back.join(1000)
        runCatching { upstream.close() }
    }

    /** 普通请求：把绝对 URI 改写成 origin-form 再转发，响应原样回写。 */
    private fun forward(client: Socket, input: InputStream, head: String, method: String, target: String) {
        val url = runCatching { java.net.URI(target) }.getOrNull()
        val host = url?.host
        if (host.isNullOrBlank()) {
            respond(client, "400 Bad Request")
            return
        }
        val portNumber = if (url.port > 0) url.port else 80
        val path = (url.rawPath.takeIf { it.isNotEmpty() } ?: "/") +
            (url.rawQuery?.let { "?$it" } ?: "")
        val upstream = connect(host, portNumber) ?: return respond(client, "502 Bad Gateway")

        val lines = head.split("\r\n")
        val contentLength = lines.firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()?.toLongOrNull() ?: 0L
        val rewritten = buildString {
            append("$method $path HTTP/1.1\r\n")
            lines.drop(1).forEach { line ->
                if (line.isBlank()) return@forEach
                // 逐跳头不能往下游带；连接语义统一收成 close，收完这一轮就断
                if (line.startsWith("Proxy-Connection:", ignoreCase = true)) return@forEach
                if (line.startsWith("Connection:", ignoreCase = true)) return@forEach
                append(line).append("\r\n")
            }
            append("Connection: close\r\n\r\n")
        }
        upstream.getOutputStream().apply {
            write(rewritten.toByteArray(Charsets.ISO_8859_1))
            flush()
        }
        // 请求体按 Content-Length 抄；⛔ 不支持 chunked 请求体（本项目没有这种请求）
        copyExactly(input, upstream.getOutputStream(), contentLength)
        pump(upstream.getInputStream(), client)
        runCatching { upstream.close() }
    }

    private fun connect(host: String, portNumber: Int): Socket? {
        val ips = runCatching { resolver(host) }.getOrNull()
        if (ips.isNullOrEmpty()) {
            log("解析失败 $host:$portNumber")
            return null
        }
        // 多地址时逐个试：GeoDNS 常给一串，第一个不通不代表都不可达
        for (ip in ips) {
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(ip, portNumber), connectTimeoutMs)
                log("已连接 $host:$portNumber")
                return socket
            } catch (_: IOException) {
                runCatching { socket.close() }
            }
        }
        log("连不上 $host:$portNumber")
        return null
    }

    /**
     * 单向转抄。读到 EOF 时**只半关对端**（`shutdownOutput`），
     * ⛔ 别把整条 socket 关掉 —— 另一个方向可能还有数据没传完。
     */
    private fun pump(src: InputStream, dst: Socket) {
        val output: OutputStream = try {
            dst.getOutputStream()
        } catch (_: IOException) {
            return
        }
        val buffer = ByteArray(BUFFER_SIZE)
        try {
            while (true) {
                val read = src.read(buffer)
                if (read < 0) break
                output.write(buffer, 0, read)
                output.flush()
            }
        } catch (_: IOException) {
            // 任何一端断开都算这次传输结束
        }
        runCatching { dst.shutdownOutput() }
    }

    private fun copyExactly(src: InputStream, dst: OutputStream, count: Long) {
        var left = count
        val buffer = ByteArray(BUFFER_SIZE)
        while (left > 0) {
            val read = src.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
            if (read < 0) return
            dst.write(buffer, 0, read)
            left -= read
        }
        runCatching { dst.flush() }
    }

    /** 读到空行为止（含头部），上限 [MAX_HEAD]；超了当坏请求。 */
    private fun readHead(input: InputStream): String? {
        val out = java.io.ByteArrayOutputStream()
        var matched = 0
        while (out.size() < MAX_HEAD) {
            val b = input.read()
            if (b < 0) return null
            out.write(b)
            matched = when {
                matched == 0 && b == CR -> 1
                matched == 1 && b == LF -> 2
                matched == 2 && b == CR -> 3
                matched == 3 && b == LF -> 4
                b == CR -> 1
                else -> 0
            }
            if (matched == 4) return out.toString("ISO-8859-1")
        }
        return null
    }

    private fun respond(client: Socket, status: String) {
        runCatching {
            client.getOutputStream().apply {
                write("HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                flush()
            }
        }
    }

    private fun reject(client: Socket) {
        respond(client, "502 Bad Gateway")
        client.close()
    }

    private companion object {
        /** 32 KB：够大的读写块，又不至于每连接吃一兆。 */
        const val BUFFER_SIZE = 32 * 1024

        /** 头部上限，挡住把无限长的一行当请求发过来的情况。 */
        const val MAX_HEAD = 32 * 1024

        const val CR = 13
        const val LF = 10
    }
}
