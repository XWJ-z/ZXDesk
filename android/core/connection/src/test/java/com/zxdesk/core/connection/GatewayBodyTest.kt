package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayBodyTest {
    @Test
    fun invalidTokenBodyIsNotAPage() {
        assertTrue(GatewayBody.isInvalidToken("invalid token"))
        assertFalse(GatewayBody.isPage("invalid token"))
        assertEquals(GatewayPage.LOGIN_REQUIRED, GatewayBody.classify("invalid token"))
    }

    @Test
    fun htmlPageIsReady() {
        val body = "<!doctype html><html><head><title>ZXDesk</title></head></html>"
        assertTrue(GatewayBody.isPage(body))
        assertFalse(GatewayBody.isInvalidToken(body))
        assertEquals(GatewayPage.APP, GatewayBody.classify(body))
    }

    @Test
    fun emptyBodyIsNotReady() {
        assertFalse(GatewayBody.isPage(""))
        assertEquals(GatewayPage.UNKNOWN, GatewayBody.classify(""))
    }

    @Test
    fun accessCodePageIsDetectedBeforeApp() {
        // 访问码页也是 HTML —— 顺序判错就会被当成应用页直接进去，然后白屏
        val zh = "<!doctype html><html><body><h3>请输入访问码</h3><input id=code></body></html>"
        assertEquals(GatewayPage.ACCESS_CODE, GatewayBody.classify(zh))
        val en = "<html><body><h3>Enter the Access Code</h3></body></html>"
        assertEquals(GatewayPage.ACCESS_CODE, GatewayBody.classify(en))
        val camel = "<html><body>accessCode</body></html>"
        assertEquals(GatewayPage.ACCESS_CODE, GatewayBody.classify(camel))
    }

    @Test
    fun normalAppPageIsNotMistakenForAccessCode() {
        val body = "<!doctype html><html><body><div id=app>今天</div></body></html>"
        assertEquals(GatewayPage.APP, GatewayBody.classify(body))
    }

    @Test
    fun nonHtmlNonTokenBodyIsUnknown() {
        // 网关抽风回一段纯文本：⛔ 不能当成「要访问码」，也不能当成登录失效
        assertEquals(GatewayPage.UNKNOWN, GatewayBody.classify("Bad Gateway"))
    }
}
