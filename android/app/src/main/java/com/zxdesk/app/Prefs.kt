package com.zxdesk.app

import android.content.Context
import com.zxdesk.core.tls.TofuRecord

/** 本机偏好：上次输入的地址、HTTPS 开关、已确认的设备证书（TOFU）。 */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    var lastAddress: String
        get() = sp.getString(KEY_ADDRESS, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_ADDRESS, value).apply()
        }

    var preferHttps: Boolean
        get() = sp.getBoolean(KEY_HTTPS, true)
        set(value) {
            sp.edit().putBoolean(KEY_HTTPS, value).apply()
        }

    /** 记住飞牛账号（密码的「是否记住」是另一回事，见 [rememberPassword]）。 */
    var lastUser: String
        get() = sp.getString(KEY_USER, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_USER, value).apply()
        }

    /** 是否记住密码（默认 true）；密码本体在 [com.zxdesk.app.store.CredentialStore]，这里只存开关。 */
    var rememberPassword: Boolean
        get() = sp.getBoolean(KEY_REMEMBER, true)
        set(value) {
            sp.edit().putBoolean(KEY_REMEMBER, value).apply()
        }

    /** 左滑抽屉的首次提示是否已经弹过（只弹一次）。 */
    var drawerHintShown: Boolean
        get() = sp.getBoolean(KEY_DRAWER_HINT, false)
        set(value) {
            sp.edit().putBoolean(KEY_DRAWER_HINT, value).apply()
        }

    /**
     * 设备标识（登录时当 `did`）。
     * 格式照 fnOS 前端的 `jX()`：`<时间36进制>-<13位随机>-<13位随机>`，一次性生成后不再变。
     */
    fun deviceId(): String {
        sp.getString(KEY_DEVICE, null)?.takeIf { it.isNotBlank() }?.let { return it }
        fun segment(): String {
            val alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
            val random = java.util.Random()
            return buildString { repeat(13) { append(alphabet[random.nextInt(alphabet.length)]) } }
        }
        val id = "${System.currentTimeMillis().toString(36)}-${segment()}-${segment()}"
        sp.edit().putString(KEY_DEVICE, id).apply()
        return id
    }

    fun tofu(host: String): TofuRecord? {
        val raw = sp.getString(TOFU_PREFIX + host, null) ?: return null
        val parts = raw.split('|')
        if (parts.size < 3) return null
        return TofuRecord(
            host = host,
            subject = parts[0],
            sha256 = parts[1],
            confirmedAt = parts[2].toLongOrNull() ?: 0L,
        )
    }

    fun saveTofu(record: TofuRecord) {
        val value = "${record.subject}|${record.sha256}|${record.confirmedAt}"
        sp.edit().putString(TOFU_PREFIX + record.host, value).apply()
    }

    private companion object {
        const val NAME = "zxdesk"
        const val KEY_ADDRESS = "last_address"
        const val KEY_HTTPS = "prefer_https"
        const val KEY_USER = "last_user"
        const val KEY_REMEMBER = "remember_password"
        const val KEY_DRAWER_HINT = "drawer_hint_shown"
        const val KEY_DEVICE = "device_id"
        const val TOFU_PREFIX = "tofu_"
    }
}
