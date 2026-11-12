/*
 * ZXDesk工作台 Android 客户端
 * 文件：DnsCheckTest.kt
 * 职责：解析诊断各条分流的回归测试
 */

package com.zxdesk.core.connection

import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * [DnsCheck] 的分流。
 *
 * 它**不拦人**：只要公共解析查到了地址就放行，由 [DohDns] 真的连上。
 * 所以这里的判据是「什么时候放行、什么时候才报错」，放错一次就是把一条能走通的路提前掐断。
 * 两个解析器都注入，不碰网络。
 */
class DnsCheckTest {

    private val anIp: InetAddress = InetAddress.getByName("192.0.2.10")

    @Test
    fun `IP 字面量两个解析器都不碰`() {
        val report = DnsCheck.inspect(
            host = "192.0.2.10",
            systemLookup = { fail("IP 字面量不该走系统解析"); emptyList() },
            dohLookup = { fail("IP 字面量不该走公共解析"); DohResult.NoRecord },
        )
        assertFalse(report.bypassedSystemDns)
    }

    @Test
    fun `系统解析有结果就不问公共解析`() {
        val report = DnsCheck.inspect(
            host = "my-nas.example.com",
            systemLookup = { listOf(anIp) },
            dohLookup = { fail("系统解析成功时不该再问公共解析"); DohResult.NoRecord },
        )
        assertEquals(listOf(anIp), report.systemIps)
        assertFalse(report.bypassedSystemDns)
    }

    @Test
    fun `系统解析失败但公共解析有记录时放行`() {
        val report = DnsCheck.inspect(
            host = "my-nas.example.com",
            systemLookup = { throw UnknownHostException("my-nas.example.com") },
            dohLookup = { DohResult.Found(listOf("203.0.113.7")) },
        )
        // 这一条是本次修复的核心：以前这里是抛异常，等于把能走通的路掐断
        assertTrue("应判成本次绕过系统解析", report.bypassedSystemDns)
        assertEquals(listOf("203.0.113.7"), report.dohIps)
    }

    @Test
    fun `两条路都没有记录才报错`() {
        val thrown = runCatching {
            DnsCheck.inspect(
                host = "my-nas.example.com",
                systemLookup = { throw UnknownHostException("my-nas.example.com") },
                dohLookup = { DohResult.NoRecord },
            )
        }.exceptionOrNull()
        assertTrue(thrown is IOException)
        assertTrue(thrown?.message.orEmpty().contains("没有解析记录"))
    }

    @Test
    fun `连公共解析都到不了也算报错`() {
        val thrown = runCatching {
            DnsCheck.inspect(
                host = "my-nas.example.com",
                systemLookup = { throw UnknownHostException("my-nas.example.com") },
                dohLookup = { DohResult.Unreachable },
            )
        }.exceptionOrNull()
        assertTrue(thrown is IOException)
        assertTrue("没网与中继无设备要说成两件事", thrown?.message.orEmpty().contains("公共解析都到不了"))
    }

    @Test
    fun `报错时把系统那次异常挂成 cause`() {
        val systemError = UnknownHostException("my-nas.example.com")
        val thrown = runCatching {
            DnsCheck.inspect(
                host = "my-nas.example.com",
                systemLookup = { throw systemError },
                dohLookup = { DohResult.Unreachable },
            )
        }.exceptionOrNull()
        assertEquals(systemError, thrown?.cause)
    }
}
