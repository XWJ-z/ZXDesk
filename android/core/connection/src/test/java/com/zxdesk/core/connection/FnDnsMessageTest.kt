/*
 * ZXDesk工作台 Android 客户端
 * 文件：FnDnsMessageTest.kt
 * 职责：DNS 失败文案的回归测试，三态各说各的、都不许漏内部异常名
 */

package com.zxdesk.core.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这条文案是 0.2.17 真机事故（`Unable to resolve host`）与 0.2.18 真机误判
 * （`*.fnos.net` 解析不了被当成「账号风控」，2026-11-03 09:05）的直接产物。
 *
 * 三态必须**处置不同**，否则用户会按错误的办法修：
 * 本地 DNS 坏了 → 开关飞行模式；中继没记录 → 只能等 / 换地址；没网 → 先修网络。
 */
class FnDnsMessageTest {

    private val host = "my-nas.fnos.net"

    @Test
    fun `未复核时点名域名并排除账号密码的误导`() {
        val text = dnsFailureMessage(host)
        assertTrue(text.contains(host))
        assertTrue(text.contains("不是 FNID 错了"))
        assertTrue(text.contains("不是账号密码错"))
        assertTrue(text.contains("局域网 IP"))
    }

    @Test
    fun `DoH 有记录时判成本地 DNS 问题`() {
        val text = dnsFailureMessage(host, DohResult.Found(listOf("203.0.113.9")))
        assertTrue(text.contains(host))
        assertTrue(text.contains("203.0.113.9"))
        assertTrue(text.contains("本地 DNS"))
        assertTrue(text.contains("不是风控"))
        // 处置必须是「换网 / 飞行模式」，不能让人干等
        assertTrue(text.contains("飞行模式"))
    }

    @Test
    fun `DoH 也查不到时说明中继侧没有记录`() {
        val text = dnsFailureMessage(host, DohResult.NoRecord)
        assertTrue(text.contains(host))
        assertTrue(text.contains("没有解析记录"))
        assertTrue(text.contains("自愈"))
        assertTrue(text.contains("不是账号被风控"))
        // 出口：DDNS 或局域网
        assertTrue(text.contains("DDNS"))
    }

    @Test
    fun `DoH 都到不了时先让人查网络`() {
        val text = dnsFailureMessage(host, DohResult.Unreachable)
        assertTrue(text.contains("公共 DNS 都到不了"))
        assertTrue(text.contains("网络"))
    }

    @Test
    fun `不把内部异常名甩给用户`() {
        val all = listOf(
            dnsFailureMessage(host),
            dnsFailureMessage(host, DohResult.Found(listOf("203.0.113.9"))),
            dnsFailureMessage(host, DohResult.NoRecord),
            dnsFailureMessage(host, DohResult.Unreachable),
        )
        all.forEach { text ->
            assertFalse(text.contains("Exception"))
            assertFalse(text.contains("EAI_"))
            assertFalse(text.contains("UnknownHost"))
        }
    }
}
