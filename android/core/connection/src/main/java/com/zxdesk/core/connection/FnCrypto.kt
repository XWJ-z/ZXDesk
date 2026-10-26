package com.zxdesk.core.connection

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 飞牛 WS 登录用的密码学（照 fnOS 桌面 bundle 的真实实现，2026-10-23 抓包核对）。
 *
 * ⚠️ 与网上社区文档/任务单不一致的两处（实测为准）：
 * 1. **AES 是 256 位不是 128 位** —— 密钥是 32 个 `[0-9a-zA-Z]` 字符（bundle：`gY=$q.create(mUe(hY),32)`），
 *    按 UTF-8 字节当 key；16 字符的做法服务端会**静默丢掉那一帧**（不报错，只等超时）。
 * 2. **RSA 是 PKCS1 v1.5 不是 OAEP** —— 桌面走的是 `JSEncrypt.encrypt(key)`（`uY=!1` 分支），
 *    信封里也就不带 `v` 字段（`v: uY?1:undefined`）。
 */
object FnCrypto {
    private const val ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val KEY_LENGTH = 32
    private const val IV_LENGTH = 16
    private const val AES = "AES/CBC/PKCS5Padding"
    private const val RSA = "RSA/ECB/PKCS1Padding"

    /** 32 个字母数字；bundle 用的就是 62 字符表随机取 32 位。 */
    fun randomAesKey(random: java.util.Random = java.util.Random()): String =
        buildString(KEY_LENGTH) { repeat(KEY_LENGTH) { append(ALPHABET[random.nextInt(ALPHABET.length)]) } }

    fun randomIv(): ByteArray = ByteArray(IV_LENGTH).also { java.security.SecureRandom().nextBytes(it) }

    /** AES-256-CBC/PKCS7（Java 里叫 PKCS5Padding，16 字节块等价）。 */
    fun aesEncrypt(plain: ByteArray, key: String, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(AES)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES"), IvParameterSpec(iv))
        return cipher.doFinal(plain)
    }

    fun aesDecrypt(cipherText: ByteArray, key: String, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(AES)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES"), IvParameterSpec(iv))
        return cipher.doFinal(cipherText)
    }

    /** `-----BEGIN PUBLIC KEY-----` 的 SPKI PEM → RSA 公钥。 */
    fun parsePublicKey(pem: String): PublicKey {
        val body = pem
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace(Regex("\\s"), "")
        val der = Base64.getDecoder().decode(body)
        return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der))
    }

    /** RSA PKCS1 v1.5 加密 AES 密钥（32 字符，按 UTF-8 字节）。 */
    fun rsaEncryptKey(key: String, publicKeyPem: String): ByteArray {
        val cipher = Cipher.getInstance(RSA)
        cipher.init(Cipher.ENCRYPT_MODE, parsePublicKey(publicKeyPem))
        return cipher.doFinal(key.toByteArray(Charsets.UTF_8))
    }

    /**
     * 加密信封：`{"req":"encrypted","iv":b64,"rsa":b64,"aes":b64}`。
     * ⛔ 不带 `v`、⛔ 不带外层 `reqid`（reqid 在 AES 里那个明文 JSON 上）。
     */
    fun envelope(innerJson: String, publicKeyPem: String, key: String, iv: ByteArray): String {
        val aes = aesEncrypt(innerJson.toByteArray(Charsets.UTF_8), key, iv)
        val rsa = rsaEncryptKey(key, publicKeyPem)
        return buildString {
            append("{\"req\":\"encrypted\",\"iv\":")
            append(MiniJson.quote(b64(iv)))
            append(",\"rsa\":")
            append(MiniJson.quote(b64(rsa)))
            append(",\"aes\":")
            append(MiniJson.quote(b64(aes)))
            append('}')
        }
    }

    /** 登录之后，明文请求前要加签名：`base64(HMAC-SHA256(b64decode(secret), json)) + json`。 */
    fun sign(json: String, secretBase64: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(Base64.getDecoder().decode(secretBase64), "HmacSHA256"))
        return b64(mac.doFinal(json.toByteArray(Charsets.UTF_8))) + json
    }

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun sha256Hex(input: String): String =
        MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
