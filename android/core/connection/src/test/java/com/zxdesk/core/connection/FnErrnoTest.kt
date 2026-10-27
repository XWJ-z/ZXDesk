package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FnErrnoTest {
    private fun message(errno: Long?): String =
        fnErrnoMessage(if (errno == null) emptyMap<String, Any?>() else mapOf("errno" to errno))

    @Test
    fun wrongPasswordIsExplained() {
        // 实测：假账号 → 131072
        assertEquals("飞牛账号或密码不正确", message(131072L))
    }

    @Test
    fun badParamsIsExplained() {
        // 实测：缺 user / 缺 si → 8192
        assertEquals("飞牛拒绝了这个请求（参数不被接受，协议可能变了）", message(8192L))
    }

    @Test
    fun twoFactorErrnosHaveText() {
        // 135168 在飞牛那边是 E_INVALID_TOKEN，2FA 登录时前端按「验证码错」提示；
        // 但也可能是 accessToken 失效了，所以文案里要带后退路。
        assertTrue(message(135168L).startsWith("验证码不正确"))
        assertTrue(message(135168L).contains("重新登录"))
        assertEquals("邮箱验证码不正确", message(102570106L))
        assertEquals("验证码发得太频繁，请稍后再试", message(102570108L))
        assertEquals("登录会话已过期，请重新登录", message(102570109L))
        assertEquals("验证码已过期，请重新获取", message(102570111L))
    }

    @Test
    fun taskSheetErrnosAreAllCovered() {
        //  点名的五个，一个都不能落到「飞牛返回 errno=…」
        listOf(135168L, 102570111L, 102570108L, 102570109L, 102570114L).forEach {
            assertFalse("errno=$it 没有文案", message(it).contains("飞牛返回 errno="))
        }
        assertEquals("验证器时间异常，请校准手机时间", message(102570114L))
        assertEquals("验证码不正确", message(102570104L))
    }

    @Test
    fun unknownAndMissingErrnoFallBack() {
        assertTrue(message(999L).contains("999"))
        assertTrue(message(null).contains("没有说明原因"))
    }

    @Test
    fun twoFactorFlagsComeFromLoginResponse() {
        // 真实响应：result=succ 但没有 token，只有 accessToken
        val text = """
            {"isTwofaEnforced":true,"isBindTwofaSecret":true,"isBindSecureEmail":true,
             "secureEmail":"me@example.com","isTrustedDevice":false,
             "accessToken":"zBVdT8FxBY1EnJHK6uPmQ8K1yxbVNpqL","result":"succ","reqid":"2"}
        """.trimIndent()
        @Suppress("UNCHECKED_CAST")
        val map = MiniJson.parse(text) as Map<String, Any?>
        assertEquals(true, map["isTwofaEnforced"])
        assertEquals(true, map["isBindTwofaSecret"])
        assertEquals(true, map["isBindSecureEmail"])
        assertEquals("me@example.com", map["secureEmail"])
        assertEquals("zBVdT8FxBY1EnJHK6uPmQ8K1yxbVNpqL", map["accessToken"])
        assertEquals(null, map["token"])
    }
}
