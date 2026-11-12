/*
 * ZXDesk工作台 Android 客户端
 * 文件：DohDnsTest.kt
 * 职责：DohDns 各条分流的回归测试，不碰网络也不碰真实时钟
 */

package com.zxdesk.core.connection

import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * [DohResolver] 的分流。
 *
 * 两个关键判据：**什么时候才去问公共解析**（多问一次就是一次白花的往返），
 * 以及**什么时候不再问**（缓存与并发合并，问多了首屏就要等）。
 * 系统解析、公共解析、时钟三样全注入，用例不依赖外网。
 */
class DohDnsTest {

    private val address = InetAddress.getByName("203.0.113.7")

    @Test
    fun `系统解析成功时不用公共解析`() {
        var dohCalls = 0
        val resolver = DohResolver(
            systemLookup = { listOf(address) },
            dohLookup = { dohCalls++; DohResult.Found(listOf("198.51.100.1")) },
        )
        assertEquals(listOf(address), resolver.lookup("my-nas.example.com"))
        assertEquals("系统解析成功还去问公共解析就是白花一次往返", 0, dohCalls)
    }

    @Test
    fun `系统解析失败时改走公共解析`() {
        var fallback = 0
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = { DohResult.Found(listOf("203.0.113.7")) },
            onFallback = { fallback++ },
        )
        val ips = resolver.lookup("my-nas.example.com")
        assertEquals(listOf(address), ips)
        assertEquals("绕过系统解析要能通知到上层", 1, fallback)
    }

    @Test
    fun `成功的结果缓存六十秒`() {
        var dohCalls = 0
        var clock = 0L
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = { dohCalls++; DohResult.Found(listOf("203.0.113.7")) },
            now = { clock },
        )
        resolver.lookup("my-nas.example.com")
        clock = 59_000L
        resolver.lookup("my-nas.example.com")
        assertEquals("60 秒内不该再发请求", 1, dohCalls)
        // 中继 TTL 是 60 秒，IP 会轮换 —— 过期必须重查
        clock = 61_000L
        resolver.lookup("my-nas.example.com")
        assertEquals(2, dohCalls)
    }

    @Test
    fun `失败只缓存五秒不拦人重试`() {
        var dohCalls = 0
        var clock = 0L
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = { dohCalls++; DohResult.Unreachable },
            now = { clock },
        )
        runCatching { resolver.lookup("my-nas.example.com") }
        runCatching { resolver.lookup("my-nas.example.com") }
        assertEquals("一次抖动不该让两个端点被打两遍", 1, dohCalls)
        clock = 6_000L
        runCatching { resolver.lookup("my-nas.example.com") }
        assertEquals("过了防抖窗口要允许重试", 2, dohCalls)
    }

    @Test
    fun `同一域名的并发查询只发一次`() {
        val calls = AtomicInteger()
        val started = CountDownLatch(1)
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = {
                calls.incrementAndGet()
                started.countDown()
                Thread.sleep(150)
                DohResult.Found(listOf("203.0.113.7"))
            },
        )
        val threads = (1..8).map {
            Thread { runCatching { resolver.lookup("my-nas.example.com") } }.apply { start() }
        }
        started.await()
        threads.forEach { it.join(5_000) }
        assertEquals("八条并发应该合并成一次查询", 1, calls.get())
    }

    @Test
    fun `两个端点都失败时抛 UnknownHostException 并带上系统那次`() {
        val systemError = UnknownHostException("my-nas.example.com")
        val resolver = DohResolver(
            systemLookup = { throw systemError },
            dohLookup = { DohResult.Unreachable },
        )
        val thrown = runCatching { resolver.lookup("my-nas.example.com") }.exceptionOrNull()
        assertTrue(thrown is UnknownHostException)
        assertEquals("排障要看得到系统那次失败", systemError, thrown?.cause)
    }

    @Test
    fun `公共解析没有记录也抛 UnknownHostException`() {
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = { DohResult.NoRecord },
        )
        val thrown = runCatching { resolver.lookup("my-nas.example.com") }.exceptionOrNull()
        assertTrue(thrown is UnknownHostException)
    }

    @Test
    fun `IP 字面量直通不查解析`() {
        val resolver = DohResolver(
            systemLookup = { fail("IP 字面量不该走系统解析"); emptyList() },
            dohLookup = { fail("IP 字面量不该走公共解析"); DohResult.NoRecord },
        )
        assertEquals("192.0.2.10", resolver.lookup("192.0.2.10").single().hostAddress)
    }

    @Test
    fun `强制重查只在地址变了时返回`() {
        var round = 0
        val resolver = DohResolver(
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = {
                round++
                DohResult.Found(if (round == 1) listOf("203.0.113.7") else listOf("198.51.100.9"))
            },
        )
        resolver.lookup("my-nas.example.com")
        val fresh = resolver.refreshIfChanged("my-nas.example.com")
        assertNotNull("查到了新地址就该返回", fresh)
        assertEquals("198.51.100.9", fresh?.single()?.hostAddress)
        // 再查一次还是同一批：重试没有意义
        assertNull(resolver.refreshIfChanged("my-nas.example.com"))
    }

    @Test
    fun `系统解析成功但地址不可达时也能重查出新地址`() {
        val bad = InetAddress.getByName("203.0.113.7")
        val good = InetAddress.getByName("198.51.100.9")
        val resolver = DohResolver(
            // GeoDNS：同一个出口每次都给同一批地址，重查也不会换
            systemLookup = { listOf(bad) },
            dohLookup = { DohResult.Found(listOf("198.51.100.9")) },
        )
        assertEquals(bad, resolver.lookup("my-nas.fnos.net").single())
        val fresh = resolver.refreshIfChanged("my-nas.fnos.net")
        // 重查若还走系统解析，这里永远是 null —— 兜底就形同虚设
        assertNotNull("重查必须跳过系统解析，直接问公共解析", fresh)
        assertEquals(good, fresh?.single())
    }

    @Test
    fun `系统成功且公共解析也给同一批地址时判没变`() {
        val same = InetAddress.getByName("203.0.113.7")
        val resolver = DohResolver(
            systemLookup = { listOf(same) },
            dohLookup = { DohResult.Found(listOf("203.0.113.7")) },
        )
        resolver.lookup("my-nas.fnos.net")
        assertNull("换了还是同一批，重试没有意义", resolver.refreshIfChanged("my-nas.fnos.net"))
    }

    @Test
    fun `强制重查不通知绕过系统解析`() {
        var fallback = 0
        val resolver = DohResolver(
            systemLookup = { listOf(address) },
            dohLookup = { DohResult.Found(listOf("198.51.100.9")) },
            onFallback = { fallback++ },
        )
        resolver.lookup("my-nas.fnos.net")
        resolver.refreshIfChanged("my-nas.fnos.net")
        // 这条路径系统是给了地址的，只是连不上，不属于「系统解析失败」
        assertEquals(0, fallback)
    }

    @Test
    fun `中继域名连不上才允许强制重查一次`() {
        val connect = ConnectException("failed to connect")
        assertTrue(shouldRetryWithFreshDns("my-nas.fnos.net", connect, alreadyRetried = false))
        assertTrue(shouldRetryWithFreshDns("my-nas.fnos.net", SocketTimeoutException("timeout"), false))
        // 已经兜过一次就不再兜，否则连不通的节点会把登录拖成无限重连
        assertFalse(shouldRetryWithFreshDns("my-nas.fnos.net", connect, alreadyRetried = true))
        // 不是中继域名：GeoDNS 那套解释不成立，别乱重试
        assertFalse(shouldRetryWithFreshDns("my-nas.example.com", connect, false))
        // 不是建连类失败：解析错了就是解析错了，重试同一个域名没意义
        assertFalse(shouldRetryWithFreshDns("my-nas.fnos.net", UnknownHostException("x"), false))
    }

    @Test
    fun `包装过的建连失败也算`() {
        val wrapped = java.io.IOException("handshake", ConnectException("refused"))
        assertTrue(shouldRetryWithFreshDns("my-nas.fnos.net", wrapped, false))
    }
}
