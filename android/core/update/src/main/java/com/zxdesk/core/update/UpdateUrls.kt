package com.zxdesk.core.update

import java.net.URI

/** [UpdateUrls.check] 的结果：通过则给可用的 [URI]，否则给一句人话原因。 */
sealed interface UrlCheck {
    data class Ok(val uri: URI, val loopback: Boolean = false) : UrlCheck
    data class Failed(val reason: String) : UrlCheck
}

/**
 * 更新链路的地址安全规则（纯函数）。
 *
 * 只放行 https。明文 http 只给本机回环（本地联调 / 自检）——
 * 版本清单与安装包都建立在「传输层没有被替换」这个前提上：
 * 一旦允许公网 http，中间人既能改版本号也能改 hash，SHA256 校验会跟着一起失效。
 */
object UpdateUrls {

    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "::1", "[::1]")

    fun check(raw: String?): UrlCheck {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return UrlCheck.Failed("地址为空")

        val uri = try {
            URI(text)
        } catch (e: Exception) {
            return UrlCheck.Failed("不是合法 URL")
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        if (host.isNullOrBlank()) return UrlCheck.Failed("地址里没有主机名")

        if (scheme == "https") return UrlCheck.Ok(uri)
        if (scheme == "http" && host in LOOPBACK_HOSTS) return UrlCheck.Ok(uri, loopback = true)
        return UrlCheck.Failed("只允许 https（收到 $scheme://$host）")
    }

    /**
     * 在版本接口地址上追加通道参数。
     * ⚠️ 只认 `stable` / `beta`：其它值一律回落到 `stable`，免得服务端收到不认识的通道。
     */
    fun withChannel(base: String, channel: String): UrlCheck {
        val checked = check(base)
        if (checked !is UrlCheck.Ok) return checked
        val name = if (channel == "beta") "beta" else "stable"
        val text = checked.uri.toString()
        val separator = if (text.contains('?')) "&" else "?"
        return check("$text${separator}channel=$name")
    }
}
