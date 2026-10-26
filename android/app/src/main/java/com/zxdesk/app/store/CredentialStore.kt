package com.zxdesk.app.store

import android.content.Context
import com.zxdesk.core.connection.MiniJson

/** 本机记住的登录凭据（地址 + 账号 + 密码）。 */
data class SavedCredential(
    val address: String,
    val user: String,
    val password: String,
)

/**
 * 「记住密码」的存取（任务单 AND-008 §三.2）。
 *
 * 复用 [SecureStore]（Android Keystore AES-256-GCM）：整条 JSON 密文落盘，
 * ⛔ 明文不落盘、⛔ 进日志、⛔ 进诊断文本 —— 本类不打印任何内容。
 * `allowBackup="false"` 已在 Manifest 声明：Keystore 密文跨机本来就解不开，别让系统备份白拷一份。
 */
class CredentialStore(context: Context) {
    private val secure = SecureStore(context)

    fun save(address: String, user: String, password: String) {
        if (address.isBlank() || user.isBlank() || password.isBlank()) return
        secure.put(KEY, encode(address, user, password))
    }

    fun load(): SavedCredential? {
        val raw = secure.get(KEY) ?: return null
        val map = runCatching { MiniJson.parse(raw) as? Map<*, *> }.getOrNull() ?: return null
        val address = map?.get("address") as? String ?: return null
        val user = map["user"] as? String ?: return null
        val password = map["password"] as? String ?: return null
        return SavedCredential(address, user, password)
    }

    fun clear() {
        secure.remove(KEY)
    }

    fun has(): Boolean = secure.has(KEY)

    private fun encode(address: String, user: String, password: String): String = buildString {
        append('{')
        append("\"address\":").append(MiniJson.quote(address))
        append(",\"user\":").append(MiniJson.quote(user))
        append(",\"password\":").append(MiniJson.quote(password))
        append('}')
    }

    private companion object {
        const val KEY = "saved_credential"
    }
}
