/*
 * ZXDesk工作台 Android 客户端
 */

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
     * 已同意的许可协议版本（0 = 没同意过）。
     * 协议正文的版本号变大时会重新询问 —— 只存布尔量就没法区分「同意过旧版」。
     */
    var eulaAcceptedVersion: Int
        get() = sp.getInt(KEY_EULA_ACCEPTED, 0)
        set(value) {
            sp.edit().putInt(KEY_EULA_ACCEPTED, value).apply()
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

    /**
     * 最近一次「检查更新」的时间戳与结果（0 = 从没查过）。
     *
     */
    var lastUpdateCheckAt: Long
        get() = sp.getLong(KEY_UPDATE_CHECK_AT, 0L)
        set(value) {
            sp.edit().putLong(KEY_UPDATE_CHECK_AT, value).apply()
        }

    /**
     * 上一次检查是否落在**长窗口**里：成功（拿到清单 / 没有发布记录）与 **429 被限流**都算长窗口 10 分钟；
     * 其余失败只挡 5 秒（防连点，但不耽误排障）。
     */
    var lastUpdateCheckOk: Boolean
        get() = sp.getBoolean(KEY_UPDATE_CHECK_OK, false)
        set(value) {
            sp.edit().putBoolean(KEY_UPDATE_CHECK_OK, value).apply()
        }

    /**
     * 上一次**成功**检查到的服务端版本号（空串 = 还没有结果）。
     *
     */
    var updateLatestVersion: String
        get() = sp.getString(KEY_UPDATE_LATEST, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_UPDATE_LATEST, value).apply()
        }

    /** 上次检查的结论：服务端那版比本机新。 */
    var updateAvailable: Boolean
        get() = sp.getBoolean(KEY_UPDATE_AVAILABLE, false)
        set(value) {
            sp.edit().putBoolean(KEY_UPDATE_AVAILABLE, value).apply()
        }

    /** 上次检查的结论：这一版是**强制更新**（服务端点名 force 或本机低于 minVersion）。 */
    var updateMustUpdate: Boolean
        get() = sp.getBoolean(KEY_UPDATE_MUST, false)
        set(value) {
            sp.edit().putBoolean(KEY_UPDATE_MUST, value).apply()
        }

    /** 上次检查拿到的更新说明（换版本时随清单一起更新）。 */
    var updateNotes: String
        get() = sp.getString(KEY_UPDATE_NOTES, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_UPDATE_NOTES, value).apply()
        }

    /** 上次检查**成功**的时间戳（0 = 从没查过）；失败不写这里，免得把已有结论的时间冲掉。 */
    var updateCheckedAt: Long
        get() = sp.getLong(KEY_UPDATE_CHECKED_AT, 0L)
        set(value) {
            sp.edit().putLong(KEY_UPDATE_CHECKED_AT, value).apply()
        }

    /**
     * 用户**主动退出登录**过（登录成功后清零）。
     *
     */
    var signedOut: Boolean
        get() = sp.getBoolean(KEY_SIGNED_OUT, false)
        set(value) {
            sp.edit().putBoolean(KEY_SIGNED_OUT, value).apply()
        }

    /** 连续连接失败次数（成功后清零）。 */
    var connectFailCount: Int
        get() = sp.getInt(KEY_CONNECT_FAILS, 0)
        set(value) {
            sp.edit().putInt(KEY_CONNECT_FAILS, value).apply()
        }

    /** 冷却截止时间戳（0 = 不在冷却）。过了这个点才允许再发起连接。 */
    var connectCooldownUntil: Long
        get() = sp.getLong(KEY_CONNECT_COOLDOWN, 0L)
        set(value) {
            sp.edit().putLong(KEY_CONNECT_COOLDOWN, value).apply()
        }

    /** 最近一次连接尝试的时间戳（失败记账时更新）：**5 分钟无操作就把失败计数清零**。 */
    var connectLastAttemptAt: Long
        get() = sp.getLong(KEY_CONNECT_LAST, 0L)
        set(value) {
            sp.edit().putLong(KEY_CONNECT_LAST, value).apply()
        }

    /**
     * 帮助页「各端与更新」上次**成功**拉取的时间戳（0 = 没查过）。
     *
     */
    var versionsCheckedAt: Long
        get() = sp.getLong(KEY_VERSIONS_CHECKED, 0L)
        set(value) {
            sp.edit().putLong(KEY_VERSIONS_CHECKED, value).apply()
        }

    /**
     *
     * 为什么要落盘：10 分钟窗口挡住重复请求，如果结果只在内存里，**重进帮助页就只剩一排「—」**
     */
    var versionsCache: String
        get() = sp.getString(KEY_VERSIONS_CACHE, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_VERSIONS_CACHE, value).apply()
        }

    /**
     * 上次运行时的 versionCode（0 = 从没记过）。
     *
     */
    var lastRunVersionCode: Int
        get() = sp.getInt(KEY_RUN_VERSION, 0)
        set(value) {
            sp.edit().putInt(KEY_RUN_VERSION, value).apply()
        }

    /**
     * 公告接口上次成功拉取的时间戳（0 = 从没查过）。
     *
     */
    var noticeCheckedAt: Long
        get() = sp.getLong(KEY_NOTICE_CHECKED, 0L)
        set(value) {
            sp.edit().putLong(KEY_NOTICE_CHECKED, value).apply()
        }

    /**
     * 上一次**成功**的公告响应原文（整段 JSON）。
     *
     */
    var noticeCache: String
        get() = sp.getString(KEY_NOTICE_CACHE, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_NOTICE_CACHE, value).apply()
        }

    /**
     * 已读公告的 `notice_id`，逗号分隔（服务端 id 形如 `20261028-android-001`，不含逗号）。
     *
     */
    var noticeReadIds: String
        get() = sp.getString(KEY_NOTICE_READ_IDS, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_NOTICE_READ_IDS, value).apply()
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
        const val KEY_EULA_ACCEPTED = "eula_accepted_version"
        const val KEY_DEVICE = "device_id"
        const val KEY_UPDATE_CHECK_AT = "update_check_at"
        const val KEY_UPDATE_CHECK_OK = "update_check_ok"
        const val KEY_UPDATE_LATEST = "update_latest_version"
        const val KEY_UPDATE_AVAILABLE = "update_available"
        const val KEY_UPDATE_MUST = "update_must"
        const val KEY_UPDATE_NOTES = "update_notes"
        const val KEY_UPDATE_CHECKED_AT = "update_checked_at"
        const val KEY_CONNECT_FAILS = "connect_fail_count"
        const val KEY_CONNECT_COOLDOWN = "connect_cooldown_until"
        const val KEY_CONNECT_LAST = "connect_last_attempt_at"
        const val KEY_VERSIONS_CHECKED = "versions_checked_at"
        const val KEY_VERSIONS_CACHE = "versions_cache"
        const val KEY_RUN_VERSION = "run_version_code"
        const val KEY_NOTICE_CHECKED = "notice_checked_at"
        const val KEY_NOTICE_CACHE = "notice_cache"
        const val KEY_NOTICE_READ_IDS = "notice_read_ids"
        const val KEY_SIGNED_OUT = "signed_out"
        const val TOFU_PREFIX = "tofu_"
    }
}
