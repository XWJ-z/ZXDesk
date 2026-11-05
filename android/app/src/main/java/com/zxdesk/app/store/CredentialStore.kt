/*
 * ZXDesk工作台 Android 客户端
 * 文件：CredentialStore.kt
 * 职责：「记住密码」的多账号存取，整份映射作为一段 Keystore 密文落盘
 */

package com.zxdesk.app.store

import android.content.Context
import com.zxdesk.core.connection.MiniJson

/** 本机记住的一组登录凭据（地址 ＋ 账号 ＋ 密码）。 */
data class SavedCredential(
    val address: String,
    val user: String,
    val password: String,
)

/**
 * 「记住密码」的存取（多账号）。
 *
 * 复用 [SecureStore]（Android Keystore AES-256-GCM）：整份「地址＋账号 → 密码」的映射作为一个
 * JSON 密文落盘，⛔ 明文不落盘、⛔ 不进日志、⛔ 不进诊断文本 —— 本类不打印任何内容。
 * `allowBackup="false"` 已在 Manifest 声明：Keystore 密文跨机本来就解不开，别让系统备份白拷一份。
 *
 * ⚠️ 兼容 0.2.16 之前的**单条**格式（键 [LEGACY_KEY]）：老用户升级后第一次读取仍能取到密码，
 *    下一次保存时自动并入新格式并删掉旧键。
 */
class CredentialStore(context: Context) {
    private val secure = SecureStore(context)

    /**
     * 记下某个账号的密码（已存在则覆盖）。
     *
     * @param address 用户输入的地址（与账号一起构成键）
     * @param user 飞牛账号
     * @param password 明文密码，只在内存里过一手
     */
    fun save(address: String, user: String, password: String) {
        val target = SavedCredential(address.trim(), user.trim(), password)
        if (target.address.isBlank() || target.user.isBlank() || password.isBlank()) return
        val key = keyOf(target.address, target.user)
        val kept = loadAll().filterNot { keyOf(it.address, it.user) == key }
        // ⚠️ 必须 takeLast：target 是刚写进来的那条，`take` 保留的是最早的 20 条 ——
        //    第 21 个账号保存时，被丢掉的恰恰是用户刚输入的那一条（看着像「记住密码没生效」）。
        write((kept + target).takeLast(MAX_ENTRIES))
    }

    /**
     * 取某个账号的密码。
     *
     * @return 没有保存过（或解不开）时为 null
     */
    fun load(address: String, user: String): SavedCredential? {
        val key = keyOf(address.trim(), user.trim())
        return loadAll().firstOrNull { keyOf(it.address, it.user) == key }
    }

    /** 这个账号是否存着密码。 */
    fun has(address: String, user: String): Boolean = load(address, user) != null

    /** 删掉某个账号的密码。 */
    fun clear(address: String, user: String) {
        val key = keyOf(address.trim(), user.trim())
        write(loadAll().filterNot { keyOf(it.address, it.user) == key })
    }

    /** 删掉全部账号的密码（用户主动清除时用）。 */
    fun clearAll() {
        secure.remove(KEY)
        secure.remove(LEGACY_KEY)
    }

    private fun loadAll(): List<SavedCredential> {
        val current = decodeList(secure.get(KEY))
        if (current.isNotEmpty()) return current
        // 旧格式只存一条：读出来当唯一一条，等下次 save 时自然迁移
        return listOfNotNull(decodeOne(secure.get(LEGACY_KEY)))
    }

    private fun write(items: List<SavedCredential>) {
        if (items.isEmpty()) {
            secure.remove(KEY)
            // ⚠️ 0.3.1：旧键必须一起删。只删新键的话，下一次 `loadAll()` 会从 0.2.16 之前的
            //    单条格式里把刚删掉的那条读回来 —— 用户看到的是「清除了密码，重启又回来了」。
            //    这一条与下面那行是同一件事的两半，⛔ 别只留一处。
            secure.remove(LEGACY_KEY)
            return
        }
        val text = buildString {
            append('[')
            items.forEachIndexed { index, item ->
                if (index > 0) append(',')
                append('{')
                append("\"address\":").append(MiniJson.quote(item.address))
                append(",\"user\":").append(MiniJson.quote(item.user))
                append(",\"password\":").append(MiniJson.quote(item.password))
                append('}')
            }
            append(']')
        }
        secure.put(KEY, text)
        // 新格式写成功就删掉旧键：否则删掉某个账号后旧键还在，会出现「删了又回来」
        secure.remove(LEGACY_KEY)
    }

    private fun decodeList(raw: String?): List<SavedCredential> {
        if (raw.isNullOrBlank()) return emptyList()
        val list = runCatching { MiniJson.parse(raw) as? List<*> }.getOrNull() ?: return emptyList()
        return list.mapNotNull { fromNode(it) }.distinctBy { keyOf(it.address, it.user) }
    }

    /** 解析 0.2.16 之前的单条 JSON（`{address,user,password}`）。 */
    private fun decodeOne(raw: String?): SavedCredential? {
        if (raw.isNullOrBlank()) return null
        val node = runCatching { MiniJson.parse(raw) }.getOrNull() ?: return null
        return fromNode(node)
    }

    private fun fromNode(node: Any?): SavedCredential? {
        val map = node as? Map<*, *> ?: return null
        val address = (map["address"] as? String)?.trim().orEmpty()
        val user = (map["user"] as? String)?.trim().orEmpty()
        val password = map["password"] as? String ?: return null
        if (address.isBlank() || user.isBlank() || password.isBlank()) return null
        return SavedCredential(address, user, password)
    }

    private fun keyOf(address: String, user: String): String = address + "\u0001" + user

    private companion object {
        /** 多账号格式：`[{address,user,password}]`，整段密文。 */
        const val KEY = "saved_credentials"

        /** 0.2.16 之前的单条格式，只读兼容。 */
        const val LEGACY_KEY = "saved_credential"

        /** 上限：与账号清单同量级，超出淘汰最早写入的。 */
        const val MAX_ENTRIES = 20
    }
}
