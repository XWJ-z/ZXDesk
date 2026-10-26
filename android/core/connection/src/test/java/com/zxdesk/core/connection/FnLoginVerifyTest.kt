package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.util.Base64

/**
 * `user.2fa.loginVerify` 的请求体与信封。
 *
 * 这组用例是 0.2.6 的核心回归：0.2.5 用明文/HMAC 发这个包，服务端要么不处理（验证器一直转），
 * 要么判码错（邮箱码重发多少次都没用）。所以「是不是 encrypted 信封」必须是断言，不是注释。
 */
class FnLoginVerifyTest {

    private fun parse(json: String): Map<*, *> = MiniJson.parse(json) as Map<*, *>

    private fun totpInner() = FnLoginVerify.inner(
        reqid = "11",
        accessToken = "acc-token",
        deviceName = "Android-ZXDesk",
        deviceId = "did-123",
        si = "748918410105",
        totpCode = "123456",
    )

    private fun emailInner() = FnLoginVerify.inner(
        reqid = "12",
        accessToken = "acc-token",
        deviceName = "Android-ZXDesk",
        deviceId = "did-123",
        si = "748918410105",
        email = "me@example.com",
        emailCode = "A1B2C3",
    )

    @Test
    fun totpCarriesCodeAndNoEmailFields() {
        val map = parse(totpInner())
        assertEquals("user.2fa.loginVerify", map["req"])
        assertEquals("11", map["reqid"])
        assertEquals("123456", map["code"])
        assertEquals("acc-token", map["accessToken"])
        assertEquals(false, map["isTrustedDevice"] as? Boolean)
        assertEquals(1L, (map["stay"] as? Number)?.toLong())
        assertEquals("Browser", map["deviceType"])
        assertEquals("did-123", map["did"])
        assertEquals("748918410105", map["si"])
        assertFalse(map.containsKey("email"))
        assertFalse(map.containsKey("emailCode"))
    }

    @Test
    fun trustFlagIsSentAsBooleanTrue() {
        // 「信任此设备」就是这个字段：true 才换得到 longToken（30 天免 2FA）
        val trusted = FnLoginVerify.inner(
            reqid = "13", accessToken = "a", deviceName = "d", deviceId = "i", si = "1",
            totpCode = "123456", trusted = true,
        )
        assertEquals(true, parse(trusted)["isTrustedDevice"] as? Boolean)
        assertEquals(false, parse(totpInner())["isTrustedDevice"] as? Boolean)
    }

    @Test
    fun emailCarriesCodeAndAddressAndNoOtpCode() {
        val map = parse(emailInner())
        assertEquals("me@example.com", map["email"])
        assertEquals("A1B2C3", map["emailCode"])
        assertFalse(map.containsKey("code"))
        assertEquals("acc-token", map["accessToken"])
    }

    @Test
    fun siIsAStringSoTheServerDoesNotLosePrecision() {
        // si 是 18 位整数；当数字发出去会被 JS/Double 截断（2.16E17），必须带引号
        val raw = totpInner()
        assertTrue(raw.contains("\"si\":\"748918410105\""))
    }

    @Test
    fun envelopeIsAesRsaNotPlaintext() {
        // 真正的回归点：发给服务端的必须是 encrypted 信封，而不是这段 JSON 本身
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pem = "-----BEGIN PUBLIC KEY-----\n" +
            Base64.getEncoder().encodeToString(pair.public.encoded) +
            "\n-----END PUBLIC KEY-----\n"
        val key = FnCrypto.randomAesKey()
        val iv = FnCrypto.randomIv()
        val inner = totpInner()
        val envelope = FnCrypto.envelope(inner, pem, key, iv)

        val outer = parse(envelope)
        assertEquals("encrypted", outer["req"])
        assertFalse("明文包不能再出现在外层", envelope.contains("user.2fa.loginVerify"))

        // 用同一把 key/iv 解回来，应与 inner 逐字相同（证明字段没在加密前被改坏）
        val aesBytes = Base64.getDecoder().decode(outer["aes"] as String)
        assertEquals(inner, String(FnCrypto.aesDecrypt(aesBytes, key, iv)))
    }
}
