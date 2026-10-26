package com.zxdesk.app.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 私密小仓库：用 Android Keystore 里的 AES-256-GCM 密钥加密后落盘。
 *
 * 存的是「长期登录凭据」（`longToken` / `secret` / 会话 Cookie）。这些值一旦泄漏就等于账号被人接管，
 * 所以 ⛔ 不进普通 SharedPreferences 明文。
 *
 * 为什么不用 `androidx.security:security-crypto`：那套要额外拉 Tink（编译期依赖重，本机 4GB 内存吃紧），
 * 而这里只需要「一个 key + AES/GCM」，Keystore 原生就够，代码也更少。
 *
 * 密钥在 Keystore 里，卸载 App 或用户清数据即失效；[get] 解密失败（密钥被系统作废）时返回 null 并自清，
 * 让上层回登录页 —— ⛔ 不要让解密异常冒到界面。
 */
class SecureStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun put(key: String, plain: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        // 版本号 + IV 长度写在前面：以后换算法/换 IV 长度能识别旧数据，而不是解出一堆乱码
        val blob = byteArrayOf(VERSION) + byteArrayOf(iv.size.toByte()) + iv + body
        prefs.edit().putString(key, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
    }

    fun get(key: String): String? {
        val raw = prefs.getString(key, null) ?: return null
        return try {
            val blob = Base64.decode(raw, Base64.NO_WRAP)
            if (blob.isEmpty() || blob[0] != VERSION) return null
            val ivLen = blob[1].toInt()
            if (blob.size < 2 + ivLen) return null
            val iv = blob.copyOfRange(2, 2 + ivLen)
            val body = blob.copyOfRange(2 + ivLen, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        } catch (e: Exception) {
            // 密钥失效（换机恢复备份 / 用户清凭据）时只能作废：留着也解不开，还挡住新登录
            Log.w(TAG, "解密失败，清掉这条凭据", e)
            remove(key)
            null
        }
    }

    fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }

    fun has(key: String): Boolean = prefs.contains(key)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 每次加密都由系统给随机 IV（本类自己存 IV，不依赖这里，但要求它别固定）
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val TAG = "SecureStore"
        const val NAME = "zxdesk_secure"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "zxdesk_session_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val VERSION: Byte = 1
    }
}
