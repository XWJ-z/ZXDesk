package com.zxdesk.app.store

import android.content.Context
import com.zxdesk.core.connection.FnSession
import com.zxdesk.core.connection.MiniJson
import com.zxdesk.core.datasource.AccountScope
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow

/**
 * 「上次登录」快照 —— 杀进程重开时用它直接回到 ZXDesk，不必再输密码/验证码。
 *
 * 存的内容都算凭据（`longToken`、`secret`、会话 Cookie），因此整段 JSON 交给 [SecureStore] 加密，
 * ⛔ 明文不落盘、⛔ 密码永不存。
 */
data class SavedSession(
    /** 用户当时输入的地址，用于登录页预填（不是连接用的 baseUrl）。 */
    val address: String,
    val https: Boolean,
    val user: String,
    val baseUrl: String,
    val gatewayPath: String,
    val flow: EntryFlow,
    val relayHost: String?,
    val portalUrl: String?,
    val cleartext: Boolean,
    val token: String,
    val longToken: String?,
    val secret: String?,
    val entryToken: String?,
    /** `/app/ticket` 回来的 `Set-Cookie`（已是 `name=value`）；其余 Cookie 由上面几个字段重建。 */
    val cookies: List<String>,
    val savedAt: Long,
) {
    /** 还原成 WebView 能直接用的 [Entry]（不需要任何网络请求）。 */
    fun entry(): Entry = Entry(
        baseUrl = baseUrl,
        gatewayPath = gatewayPath,
        accountScope = AccountScope.NAS,
        flow = flow,
        relayHost = relayHost,
        portalUrl = portalUrl,
        cleartext = cleartext,
        // 这里把 Cookie 也塞回会话里：WebView 启动时会写进 CookieManager，
        // 于是「会话还有效」这种情况连一次 WS 都不用建。
        fnSession = FnSession(
            token = token,
            secret = secret,
            longToken = longToken,
            entryToken = entryToken,
            setCookies = cookies,
        ),
    )

    fun toJson(): String = buildString {
        append('{')
        append("\"address\":").append(MiniJson.quote(address))
        append(",\"https\":").append(https)
        append(",\"user\":").append(MiniJson.quote(user))
        append(",\"baseUrl\":").append(MiniJson.quote(baseUrl))
        append(",\"gatewayPath\":").append(MiniJson.quote(gatewayPath))
        append(",\"flow\":").append(MiniJson.quote(flow.name))
        append(",\"relayHost\":").append(relayHost?.let { MiniJson.quote(it) } ?: "null")
        append(",\"portalUrl\":").append(portalUrl?.let { MiniJson.quote(it) } ?: "null")
        append(",\"cleartext\":").append(cleartext)
        append(",\"token\":").append(MiniJson.quote(token))
        append(",\"longToken\":").append(longToken?.let { MiniJson.quote(it) } ?: "null")
        append(",\"secret\":").append(secret?.let { MiniJson.quote(it) } ?: "null")
        append(",\"entryToken\":").append(entryToken?.let { MiniJson.quote(it) } ?: "null")
        append(",\"cookies\":[")
        cookies.forEachIndexed { index, cookie ->
            if (index > 0) append(',')
            append(MiniJson.quote(cookie))
        }
        append(']')
        append(",\"savedAt\":").append(savedAt)
        append('}')
    }

    companion object {
        fun fromJson(text: String): SavedSession? = runCatching {
            val map = MiniJson.parse(text) as? Map<*, *> ?: return null
            SavedSession(
                address = map["address"] as? String ?: return null,
                https = map["https"] as? Boolean ?: true,
                user = map["user"] as? String ?: "",
                baseUrl = map["baseUrl"] as? String ?: return null,
                gatewayPath = map["gatewayPath"] as? String ?: "/app/zxdesk",
                flow = EntryFlow.valueOf(map["flow"] as? String ?: EntryFlow.GATEWAY.name),
                relayHost = map["relayHost"] as? String,
                portalUrl = map["portalUrl"] as? String,
                cleartext = map["cleartext"] as? Boolean ?: false,
                token = map["token"] as? String ?: "",
                longToken = map["longToken"] as? String,
                secret = map["secret"] as? String,
                entryToken = map["entryToken"] as? String,
                cookies = (map["cookies"] as? List<*>)
                    ?.mapNotNull { it as? String }
                    .orEmpty(),
                savedAt = MiniJson.anyToLong(map["savedAt"]) ?: 0L,
            )
        }.getOrNull()

        /** 从一次成功连接里抠出快照。 */
        fun of(entry: Entry, address: String, https: Boolean, user: String, session: FnSession): SavedSession =
            SavedSession(
                address = address,
                https = https,
                user = user,
                baseUrl = entry.baseUrl,
                gatewayPath = entry.gatewayPath,
                flow = entry.flow,
                relayHost = entry.relayHost,
                portalUrl = entry.portalUrl,
                cleartext = entry.cleartext,
                token = session.token,
                longToken = session.longToken,
                secret = session.secret,
                entryToken = session.entryToken,
                cookies = session.setCookies,
                savedAt = System.currentTimeMillis(),
            )
    }
}

/** 快照的读写入口（加密由 [SecureStore] 负责）。 */
class SessionStore(context: Context) {
    private val secure = SecureStore(context)

    fun save(session: SavedSession) {
        secure.put(KEY, session.toJson())
    }

    fun load(): SavedSession? {
        val raw = secure.get(KEY) ?: return null
        return SavedSession.fromJson(raw)
    }

    fun clear() {
        secure.remove(KEY)
    }

    fun has(): Boolean = secure.has(KEY)

    private companion object {
        const val KEY = "saved_session"
    }
}
