package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.util.Base64
import javax.crypto.Cipher

class FnCryptoTest {

    private fun pemOf(publicKey: java.security.PublicKey): String =
        "-----BEGIN PUBLIC KEY-----\n" +
            Base64.getEncoder().encodeToString(publicKey.encoded) +
            "\n-----END PUBLIC KEY-----\n"

    private val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

    @Test
    fun aesKeyIs32AlphanumericChars() {
        // 实测：16 字符会被服务端静默丢掉，必须 32 位（AES-256）
        val key = FnCrypto.randomAesKey()
        assertEquals(32, key.length)
        assertTrue(key.all { it.isLetterOrDigit() })
    }

    @Test
    fun aesRoundTrip() {
        val key = FnCrypto.randomAesKey()
        val iv = FnCrypto.randomIv()
        assertEquals(16, iv.size)
        val plain = """{"req":"user.login","user":"测试用户","password":"p@ss"}"""
        val encrypted = FnCrypto.aesEncrypt(plain.toByteArray(), key, iv)
        assertEquals(plain, String(FnCrypto.aesDecrypt(encrypted, key, iv)))
    }

    @Test
    fun rsaEncryptsTheKeyWithPkcs1Padding() {
        // 桌面走 JSEncrypt（PKCS1 v1.5），不是 OAEP —— 这条用例钉住这个选择
        val key = FnCrypto.randomAesKey()
        val cipherText = FnCrypto.rsaEncryptKey(key, pemOf(keyPair.public))
        assertEquals(2048 / 8, cipherText.size)
        val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
        cipher.init(Cipher.DECRYPT_MODE, keyPair.private)
        assertEquals(key, String(cipher.doFinal(cipherText)))
    }

    @Test
    fun envelopeHasExpectedShape() {
        val key = FnCrypto.randomAesKey()
        val iv = FnCrypto.randomIv()
        val inner = """{"req":"user.login","reqid":"2"}"""
        val envelope = FnCrypto.envelope(inner, pemOf(keyPair.public), key, iv)
        val parsed = MiniJson.parse(envelope) as Map<*, *>
        assertEquals("encrypted", parsed["req"])
        assertTrue(parsed.containsKey("iv"))
        assertTrue(parsed.containsKey("rsa"))
        assertTrue(parsed.containsKey("aes"))
        // 外层不带 reqid、不带 v（bundle：v: uY ? 1 : undefined，桌面分支是 undefined）
        assertFalse(parsed.containsKey("reqid"))
        assertFalse(parsed.containsKey("v"))

        val aesBytes = Base64.getDecoder().decode(parsed["aes"] as String)
        assertEquals(inner, String(FnCrypto.aesDecrypt(aesBytes, key, iv)))
    }

    @Test
    fun signPrependsBase64Hmac() {
        val secret = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
        val body = """{"req":"appcgi.sac.entry.v1.exchangeEntryToken","reqid":"3"}"""
        val signed = FnCrypto.sign(body, secret)
        assertTrue(signed.endsWith(body))
        val signature = signed.removeSuffix(body)
        assertEquals(44, signature.length) // 32 字节 HMAC 的 base64
        // 同输入同签名
        assertEquals(signed, FnCrypto.sign(body, secret))
    }

    @Test
    fun publicKeyPemIsParsed() {
        val parsed = FnCrypto.parsePublicKey(pemOf(keyPair.public))
        assertEquals("RSA", parsed.algorithm)
    }
}
