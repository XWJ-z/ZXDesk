package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FnIdSignerTest {
    @Test
    fun md5OfEmptyString() {
        assertEquals("d41d8cd98f00b204e9800998ecf8427e", FnIdSigner.md5Hex(""))
    }

    @Test
    fun sha256OfEmptyString() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            FnIdSigner.sha256Hex(""),
        )
    }

    @Test
    fun fnSignIsSha256Hex() {
        val sign = FnIdSigner.fnSign("abcde", 1700000000000L)
        assertEquals(64, sign.length)
        assertTrue(sign.all { it in "0123456789abcdef" })
    }

    @Test
    fun authxHasExpectedShape() {
        val header = FnIdSigner.authx(
            timestamp = 1700000000000L,
            nonce = "123456",
            body = "{\"fnId\":\"abcde\"}",
        )
        assertTrue(header.startsWith("nonce=123456&timestamp=1700000000000&sign="))
        assertEquals(32, header.substringAfter("sign=").length)
    }
}
