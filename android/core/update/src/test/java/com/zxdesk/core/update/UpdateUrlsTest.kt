package com.zxdesk.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 更新链路的地址规则：公网只许 https，明文只给本机回环。 */
class UpdateUrlsTest {

    @Test
    fun `公网 https 通过`() {
        val checked = UpdateUrls.check("https://api.example.com/api/version/android")
        assertTrue(checked is UrlCheck.Ok)
    }

    @Test
    fun `公网 http 一律拒绝`() {
        val checked = UpdateUrls.check("http://api.example.com/api/version/android")
        assertTrue(checked is UrlCheck.Failed)
        assertTrue((checked as UrlCheck.Failed).reason.contains("只允许 https"))
    }

    @Test
    fun `明文只放行本机回环`() {
        listOf(
            "http://127.0.0.1:18992/api/version/android",
            "http://localhost:18992/api/version/android",
            "http://[::1]:18992/api/version/android",
        ).forEach { url ->
            val checked = UpdateUrls.check(url)
            assertTrue("$url 应放行", checked is UrlCheck.Ok)
            assertTrue((checked as UrlCheck.Ok).loopback)
        }
    }

    @Test
    fun `空地址与非法地址给原因`() {
        assertTrue(UpdateUrls.check("") is UrlCheck.Failed)
        assertTrue(UpdateUrls.check(null) is UrlCheck.Failed)
        assertTrue(UpdateUrls.check("不是URL") is UrlCheck.Failed)
        assertTrue(UpdateUrls.check("ftp://example.com/x") is UrlCheck.Failed)
    }

    @Test
    fun `通道参数追加在地址末尾`() {
        val checked = UpdateUrls.withChannel("https://api.example.com/api/version/android", "beta")
        assertEquals("https://api.example.com/api/version/android?channel=beta", checked.let {
            (it as UrlCheck.Ok).uri.toString()
        })
    }

    @Test
    fun `未知通道回落到 stable`() {
        val checked = UpdateUrls.withChannel("https://api.example.com/api/version/android", "nightly")
        assertEquals("https://api.example.com/api/version/android?channel=stable", (checked as UrlCheck.Ok).uri.toString())
    }

    @Test
    fun `已有查询参数时用与号连接`() {
        val checked = UpdateUrls.withChannel("https://api.example.com/api/version/android?x=1", "stable")
        assertEquals(
            "https://api.example.com/api/version/android?x=1&channel=stable",
            (checked as UrlCheck.Ok).uri.toString(),
        )
    }
}
