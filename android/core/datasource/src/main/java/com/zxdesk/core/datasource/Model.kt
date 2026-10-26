package com.zxdesk.core.datasource

import com.zxdesk.core.connection.FnSession

/** 三种数据源模式；一期只实现 [NAS]。 */
enum class DataSourceKind { NAS, LOCAL, HYBRID }

/** 账号作用域：NAS 账号 / 本机账号。 */
enum class AccountScope { NAS, LOCAL }

/**
 * 连接流程。
 *
 * - [DIRECT]：`http://<IP>:8990` 直连 ZXDesk，不需要飞牛登录；
 * - [GATEWAY]：走飞牛网关（64999 / 自定义域名 / FNID 中继），
 *   **必须先登录飞牛**，否则 `/app/zxdesk` 下的请求一律返回纯文本 `invalid token`。
 */
enum class EntryFlow { DIRECT, GATEWAY }

/** 登录时收集的连接参数。 */
data class Profile(
    val address: String,
    val username: String? = null,
    /** 登录页「HTTPS 安全访问」开关；只影响「没写 scheme 且不是 8990」的输入。 */
    val preferHttps: Boolean = true,
)

/** 交给 WebView 的唯一入口。 */
data class Entry(
    val baseUrl: String,
    val gatewayPath: String,
    val accountScope: AccountScope,
    val flow: EntryFlow = EntryFlow.DIRECT,
    /** FNID 中继主机；非空时跳转前要补写一次 `mode=relay` Cookie（门户正常会自己种）。 */
    val relayHost: String? = null,
    /**
     * FNID 的官方门户（`https://fnos.net/<fnid>/`）：**先在这里登录飞牛**，
     * 登录完它会跳到中继主机，App 再换成 [zxDeskLoginUrl]。
     * ⚠️ 中继根本身不是登录页（是 NAS 桌面 SPA 的空壳），⛔ 别再直接加载它。
     */
    val portalUrl: String? = null,
    /** 明文 HTTP（只可能是私网 8990）。 */
    val cleartext: Boolean = false,
    /**
     * 原生 WS 登录拿到的会话（0.2.2）。非空 ⇒ WebView 直接写 Cookie 进 ZXDesk，
     * ⛔ 不再走门户、⛔ 也不等那个根本不存在的 `Trim-MC-token`。
     */
    val fnSession: FnSession? = null,
) {
    /** WebView 该从哪一页开始。 */
    val startUrl: String
        get() = when {
            flow == EntryFlow.DIRECT -> zxDeskLoginUrl
            // ⚠️ 已有原生会话就直奔 ZXDesk —— 别再把门户加载一遍（否则白转一圈又回到登录）
            fnSession != null -> zxDeskLoginUrl
            portalUrl != null -> portalUrl
            else -> "${baseUrl.trimEnd('/')}/"
        }

    /** 登录飞牛之后要去的 ZXDesk 登录页。 */
    val zxDeskLoginUrl: String get() = "${baseUrl.trimEnd('/')}$gatewayPath/login.html"
}
