/*
 * ZXDesk工作台 Android 客户端
 * 文件：AccountStore.kt
 * 职责：保存过的账号清单，多 NAS / 多账号切换的数据来源
 */

package com.zxdesk.app.store

import android.content.Context
import com.zxdesk.core.connection.MiniJson

/**
 * 一个保存过的 NAS 账号（地址 ＋ 飞牛账号）。
 *
 * 只存「去哪、用谁」—— 密码不在这里（见 [CredentialStore]，加密后另存），会话也不在这里
 * （见 [SessionStore]，只保留最近一次登录）。
 */
data class Account(
    /** 用户当初输入的地址（IP / 域名 / FNID），用于回填登录页。 */
    val address: String,
    val user: String,
    val https: Boolean = true,
    /** 上次使用时间：列表按它倒序，最近用的排最上面。 */
    val lastUsedAt: Long = 0L,
) {
    /** 去重键：同一台设备上的同一个账号算一条。 */
    val key: String get() = address.trim() + "\u0001" + user.trim()

    /** 列表里的主标题：有账号就显示账号，没有就退回地址。 */
    val title: String get() = user.trim().ifBlank { address.trim() }
}

/**
 * 保存过的账号清单（多 NAS / 多账号切换）。
 *
 * 存 `SharedPreferences` 明文：这里只有地址与账号名，**没有任何凭据**；密码走 [CredentialStore]，
 * 会话走 [SessionStore]，两者都经 Android Keystore 加密。
 *
 * ⚠️ 上限 [MAX_ACCOUNTS] 条：超出时淘汰最久未用的，避免这份清单无限增长。
 */
class AccountStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** 全部账号，按最近使用倒序。 */
    fun list(): List<Account> =
        decode(prefs.getString(KEY, null)).sortedWith(
            compareByDescending<Account> { it.lastUsedAt }.thenBy { it.address },
        )

    /**
     * 记一条账号（存在则更新 https 与最近使用时间），返回更新后的清单。
     *
     * @param address 用户输入的地址
     * @param user 飞牛账号
     * @param https 当时是否为 HTTPS
     * @return 更新后的清单（已排序）
     */
    fun remember(address: String, user: String, https: Boolean): List<Account> {
        val target = Account(address.trim(), user.trim(), https, System.currentTimeMillis())
        if (target.address.isBlank() || target.user.isBlank()) return list()
        val kept = list().filterNot { it.key == target.key }
        write((kept + target).sortedByDescending { it.lastUsedAt }.take(MAX_ACCOUNTS))
        return list()
    }

    /** 删掉一条账号（不存在则原样返回）。 */
    fun remove(address: String, user: String): List<Account> {
        val key = Account(address, user).key
        write(list().filterNot { it.key == key })
        return list()
    }

    private fun write(items: List<Account>) {
        prefs.edit().putString(KEY, encode(items)).apply()
    }

    private fun encode(items: List<Account>): String = buildString {
        append('[')
        items.forEachIndexed { index, item ->
            if (index > 0) append(',')
            append('{')
            append("\"address\":").append(MiniJson.quote(item.address))
            append(",\"user\":").append(MiniJson.quote(item.user))
            append(",\"https\":").append(item.https)
            append(",\"lastUsedAt\":").append(item.lastUsedAt)
            append('}')
        }
        append(']')
    }

    private fun decode(raw: String?): List<Account> {
        if (raw.isNullOrBlank()) return emptyList()
        val list = runCatching { MiniJson.parse(raw) as? List<*> }.getOrNull() ?: return emptyList()
        return list.mapNotNull { row ->
            val map = row as? Map<*, *> ?: return@mapNotNull null
            val address = (map["address"] as? String)?.trim().orEmpty()
            val user = (map["user"] as? String)?.trim().orEmpty()
            if (address.isBlank() || user.isBlank()) return@mapNotNull null
            Account(
                address = address,
                user = user,
                https = map["https"] as? Boolean ?: true,
                lastUsedAt = MiniJson.anyToLong(map["lastUsedAt"]) ?: 0L,
            )
        }.distinctBy { it.key }
    }

    private companion object {
        const val NAME = "zxdesk"
        const val KEY = "saved_accounts"

        /** 清单上限：够用且不会让登录页的选择界面无限长。 */
        const val MAX_ACCOUNTS = 20
    }
}
