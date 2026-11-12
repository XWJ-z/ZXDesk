/*
 * ZXDesk工作台 Android 客户端
 * 文件：FnDnsMessageTest.kt
 * 职责：解析失败文案的回归测试，三态各说各的、都不许漏内部异常名
 */

package com.zxdesk.core.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这条文案会进失败卡片，用户据此决定下一步，所以三态必须**处置不同**：
 * 域名有记录却是系统解析不通 → App 自己已经绕过去了；
 * 中继没记录 → 只能等；没网 → 先修网络。
 *
 * ⛔ 一律不许出现「缓存」「飞行模式」「破折号」「括号」——
 * 那些是把环境问题说成用户能一键修好的假办法。
 */
class FnDnsMessageTest {

    private val host = "my-nas.fnos.net"

    @Test
    fun `未复核时点名域名并排除账号密码的误导`() {
        val text = dnsFailureMessage(host)
        assertTrue(text.contains(host))
        assertTrue(text.contains("不是 FNID 错了"))
        assertTrue(text.contains("不是账号密码错"))
    }

    @Test
    fun `公共解析有记录时不产出失败文案`() {
        // 「查到地址」这条路根本不进失败卡片：解析器拿到地址就照常建连了。
        // 落到这里只可能是有人误用，兜一句不误导的话，⛔ 不能说成「系统解析不可用」。
        val text = dnsFailureMessage(host, DohResult.Found(listOf("203.0.113.9")))
        assertTrue(text.contains(host))
        assertFalse(text, text.contains("203.0.113.9"))
    }

    @Test
    fun `公共解析也查不到时说明中继侧没有记录`() {
        val text = dnsFailureMessage(host, DohResult.NoRecord)
        assertTrue(text.contains(host))
        assertTrue(text.contains("没有解析记录"))
        assertTrue(text.contains("自愈"))
        assertTrue(text.contains("不是账号被风控"))
    }

    @Test
    fun `公共解析都到不了时先让人查网络`() {
        val text = dnsFailureMessage(host, DohResult.Unreachable)
        assertTrue(text.contains("公共解析都到不了"))
        assertTrue(text.contains("网络"))
    }

    @Test
    fun `不许把环境问题写成用户能一键修好的假办法`() {
        val all = listOf(
            dnsFailureMessage(host),
            dnsFailureMessage(host, DohResult.Found(listOf("203.0.113.9"))),
            dnsFailureMessage(host, DohResult.NoRecord),
            dnsFailureMessage(host, DohResult.Unreachable),
        )
        all.forEach { text ->
            assertFalse(text, text.contains("缓存"))
            assertFalse(text, text.contains("飞行模式"))
            assertFalse(text, text.contains("——"))
            assertFalse(text, text.contains("（"))
            assertFalse(text, text.contains("）"))
        }
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
            assertFalse(text, text.contains("Exception"))
            assertFalse(text, text.contains("EAI_"))
            assertFalse(text, text.contains("UnknownHost"))
        }
    }
}
