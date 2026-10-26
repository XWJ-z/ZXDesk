package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FnSessionTest {
    @Test
    fun sessionCookiesForRelayCarryBothTokens() {
        val session = FnSession(token = "tk", secret = "s", entryToken = "et")
        val cookies = session.cookies(relayHost = "demo-nas.fnos.net")
        assertEquals(2, cookies.size)
        assertEquals("fnos-token=tk; Path=/; Secure; SameSite=Strict", cookies[0])
        assertEquals("entry-token=et; Path=/; Secure; Domain=.demo-nas.fnos.net", cookies[1])
    }

    @Test
    fun withoutEntryTokenOnlySessionCookie() {
        val cookies = FnSession(token = "tk").cookies(relayHost = "nas.example.com")
        assertEquals(1, cookies.size)
        assertFalse(cookies[0].contains("entry-token"))
    }

    @Test
    fun domainModeEntryTokenHasNoDomainAttribute() {
        // 自定义域名写 Domain=.nas.example.com 会把 Cookie 撒到别的子域，非中继就不带 Domain
        val cookies = FnSession(token = "tk", entryToken = "et").cookies(relayHost = null)
        assertEquals("entry-token=et; Path=/; Secure", cookies[1])
    }

    @Test
    fun ticketCookiesFromServerWinOverFallback() {
        // /app/ticket 回的 Set-Cookie 才是真会话；自己拼的 fnos-token 只是兜底，同名时不能重复写
        val session = FnSession(
            token = "tk",
            setCookies = listOf("fnos-token=from-ticket"),
        )
        val cookies = session.cookies(relayHost = null)
        assertEquals(1, cookies.size)
        assertEquals("fnos-token=from-ticket; Path=/; Secure", cookies[0])
    }

    @Test
    fun serverCookieOfAnotherNameIsKeptAlongside() {
        val session = FnSession(token = "tk", setCookies = listOf("app-session=abc"))
        val cookies = session.cookies(relayHost = null)
        assertEquals(2, cookies.size)
        assertTrue(cookies.any { it.startsWith("fnos-token=tk") })
        assertTrue(cookies.any { it.startsWith("app-session=abc") })
    }

    @Test
    fun longTokenIsCookieWith30Days() {
        // 勾了「信任此设备」才有 longToken；Cookie 要带 Max-Age，否则杀进程就丢（30 天 = 2592000 秒）
        val cookies = FnSession(token = "tk", longToken = "lt").cookies(relayHost = null)
        val long = cookies.first { it.startsWith("fnos-long-token=") }
        assertTrue(long.contains("Max-Age=2592000"))
        assertTrue(long.contains("SameSite=Strict"))
        assertEquals(LONG_TOKEN_MAX_AGE, 30 * 24 * 60 * 60)
    }

    @Test
    fun withoutLongTokenNoLongCookie() {
        val cookies = FnSession(token = "tk").cookies(relayHost = null)
        assertFalse(cookies.any { it.contains("fnos-long-token") })
    }

    @Test
    fun cookieNameIsNotTrimMcToken() {
        // 0.2.0/0.2.1 等错名字白等了两版；这条用例防止回退
        val joined = FnSession(token = "tk", entryToken = "et").cookies("x.fnos.net").joinToString(";")
        assertFalse(joined.contains("Trim-MC-token"))
    }

    @Test
    fun cookieHeaderKeepsOnlyNameValuePairs() {
        // 原生探测（HttpURLConnection）只认 name=value，属性带上反而会被当成别的 cookie 名
        val header = FnSession(token = "tk", longToken = "lt", entryToken = "et")
            .cookieHeader(relayHost = "demo-nas.fnos.net")
        assertEquals("fnos-token=tk; fnos-long-token=lt; entry-token=et", header)
        assertFalse(header.contains("Path="))
        assertFalse(header.contains("Secure"))
    }
}
