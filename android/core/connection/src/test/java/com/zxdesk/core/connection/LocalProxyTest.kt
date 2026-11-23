/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.connection

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [LocalProxy] 的传输正确性。
 *
 */
class LocalProxyTest {

    private val loopback: List<InetAddress> = listOf(InetAddress.getByName("127.0.0.1"))
    private val toClose = mutableListOf<ServerSocket>()
    private var proxy: LocalProxy? = null

    @After
    fun tearDown() {
        proxy?.stop()
        toClose.forEach { runCatching { it.close() } }
    }

    @Test
    fun `代理规则只写地址本身不带 PAC 前缀`() {
        // 这一条是真机踩出来的：写成 `PROXY 127.0.0.1:8899` 会被 androidx 判成非法规则，
        // setProxyOverride 抛 IllegalArgumentException，覆盖从没生效，页面还是 ERR_NAME_NOT_RESOLVED。
        val rule = proxyRuleFor(8899)
        assertEquals("127.0.0.1:8899", rule)
        assertTrue("⛔ 不许带 PROXY / DIRECT 这类 PAC 前缀", !rule.contains("PROXY", ignoreCase = true))
        assertTrue("⛔ 不许带 scheme", !rule.startsWith("http"))
        assertTrue("⛔ 不许带路径或斜杠", !rule.contains("/"))
    }

    @Test
    fun `CONNECT 隧道两个方向字节一致`() {
        val echo = echoServer()
        val port = newProxy()
        Socket("127.0.0.1", port).use { client ->
            client.soTimeout = 10_000
            client.getOutputStream().apply {
                write(connectHead("my-nas.fnos.net", echo.localPort))
                flush()
            }
            val input = BufferedInputStream(client.getInputStream())
            assertTrue("应该回 200 Connection Established", awaitEstablished(input))

            val payload = ByteArray(1024 * 1024) { (it % 251).toByte() }
            val reader = startReader(input, payload.size)
            client.getOutputStream().apply {
                write(payload)
                flush()
            }
            val echoed = reader.get(20_000)
            assertTrue("1 MB 负载必须原样回来", echoed != null && echoed.contentEquals(payload))
        }
        runCatching { echo.close() }
    }

    @Test
    fun `绝对 URI 改写成 origin-form 再转发`() {
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        toClose += server
        val seen = AtomicReference<String>()
        thread(isDaemon = true) {
            runCatching {
                server.accept().use { socket ->
                    val input = BufferedInputStream(socket.getInputStream())
                    seen.set(readLine(input))
                    while (true) {
                        val line = readLine(input)
                        if (line.isEmpty()) break
                    }
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello".toByteArray())
                        flush()
                    }
                }
            }
        }
        val port = newProxy()

        Socket("127.0.0.1", port).use { client ->
            client.soTimeout = 10_000
            client.getOutputStream().apply {
                write(
                    ("GET http://my-nas.fnos.net:${server.localPort}/app/zxdesk?q=1 HTTP/1.1\r\n" +
                        "Host: my-nas.fnos.net:${server.localPort}\r\n\r\n").toByteArray(),
                )
                flush()
            }
            val body = BufferedInputStream(client.getInputStream()).readBytes().toString(Charsets.UTF_8)
            assertTrue("响应要原样回给客户端", body.contains("hello"))
        }
        assertEquals("请求行必须是 origin-form，带绝对 URI 上游认不出来", "GET /app/zxdesk?q=1 HTTP/1.1", seen.get())
    }

    @Test
    fun `解析不了目标时回 502`() {
        val port = newProxy(resolver = { throw UnknownHostException("my-nas.fnos.net") })
        Socket("127.0.0.1", port).use { client ->
            client.soTimeout = 10_000
            client.getOutputStream().apply {
                write("CONNECT my-nas.fnos.net:443 HTTP/1.1\r\n\r\n".toByteArray())
                flush()
            }
            // 502 时连接会被关掉，读不到任何东西也算对
            val text = runCatching {
                BufferedInputStream(client.getInputStream()).readBytes().toString(Charsets.UTF_8)
            }.getOrDefault("")
            assertTrue("连不上目标要如实回 502，⛔ 不能挂着让页面无限转圈", text.contains("502"))
        }
    }

    @Test
    fun `停掉之后还能再起并照常转发`() {
        val echo = echoServer()
        val first = LocalProxy(resolver = { loopback }).apply { start() }
        first.stop()
        assertEquals("停了就该释放端口", 0L, first.port.toLong())

        val second = LocalProxy(resolver = { loopback })
        proxy = second
        val port = second.start()
        assertTrue(port > 0)
        Socket("127.0.0.1", port).use { client ->
            client.soTimeout = 10_000
            client.getOutputStream().apply {
                write(connectHead("my-nas.fnos.net", echo.localPort))
                flush()
            }
            val input = BufferedInputStream(client.getInputStream())
            assertTrue(awaitEstablished(input))
            val reader = startReader(input, 4)
            client.getOutputStream().apply {
                write("ping".toByteArray())
                flush()
            }
            assertEquals("再起一次也要能正常转发", "ping", reader.get(10_000)?.toString(Charsets.UTF_8))
        }
    }

    @Test
    fun `八条并发隧道不串包`() {
        val echo = echoServer()
        val port = newProxy()
        val started = CountDownLatch(8)
        val results = arrayOfNulls<String>(8)
        val threads = (0 until 8).map { index ->
            thread(isDaemon = true) {
                runCatching {
                    val token = "conn-$index-" + "x".repeat(512)
                    Socket("127.0.0.1", port).use { client ->
                        client.soTimeout = 15_000
                        client.getOutputStream().apply {
                            write(connectHead("my-nas.fnos.net", echo.localPort))
                            flush()
                        }
                        val input = BufferedInputStream(client.getInputStream())
                        awaitEstablished(input)
                        started.countDown()
                        started.await()
                        val reader = startReader(input, token.toByteArray().size)
                        client.getOutputStream().apply {
                            write(token.toByteArray())
                            flush()
                        }
                        results[index] = reader.get(15_000)?.toString(Charsets.UTF_8)
                    }
                }
            }
        }
        threads.forEach { it.join(30_000) }
        results.forEachIndexed { index, got ->
            assertEquals("第 $index 条串包了", "conn-$index-" + "x".repeat(512), got)
        }
    }

    private fun newProxy(resolver: ((String) -> List<InetAddress>)? = null): Int {
        val instance = LocalProxy(resolver = resolver ?: { loopback })
        proxy = instance
        return instance.start()
    }

    /** CONNECT 头。目标端口必须指向本机假服务，⛔ 别写 443 —— 那会连到真实端口上。 */
    private fun connectHead(host: String, targetPort: Int): ByteArray =
        "CONNECT $host:$targetPort HTTP/1.1\r\nHost: $host:$targetPort\r\n\r\n".toByteArray()

    /** 本机回显服务：收到多少原样吐回多少；每个连接一条线程。 */
    private fun echoServer(): ServerSocket {
        val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        toClose += server
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    runCatching {
                        val buffer = ByteArray(32 * 1024)
                        val input = socket.getInputStream()
                        val output = socket.getOutputStream()
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            output.flush()
                        }
                    }
                    runCatching { socket.close() }
                }
            }
        }
        return server
    }

    /** 后台读满 [size] 字节；读不够就返回 null，让断言报「没收到」而不是挂死。 */
    private fun startReader(input: InputStream, size: Int): AtomicReference<ByteArray?> {
        val holder = AtomicReference<ByteArray?>()
        thread(isDaemon = true) {
            runCatching {
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (out.size() < size) {
                    val read = input.read(buffer, 0, minOf(buffer.size, size - out.size()))
                    if (read < 0) break
                    out.write(buffer, 0, read)
                }
                holder.set(if (out.size() == size) out.toByteArray() else null)
            }
        }
        return holder
    }

    private fun readLine(input: InputStream): String {
        val out = ByteArrayOutputStream()
        while (out.size() < 8192) {
            val b = input.read()
            if (b < 0 || b == '\n'.code) break
            if (b != '\r'.code) out.write(b)
        }
        return out.toString("ISO-8859-1")
    }

    /**
     * 等 CONNECT 的应答，并且把**头部整块**读完。
     *
     */
    private fun awaitEstablished(input: InputStream): Boolean {
        val status = readLine(input)
        if (!status.contains("200")) return false
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) return true
        }
    }

    private fun AtomicReference<ByteArray?>.get(timeoutMs: Long): ByteArray? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            get()?.let { return it }
            Thread.sleep(10)
        }
        return get()
    }
}
