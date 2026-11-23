/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.datasource

import com.zxdesk.core.connection.FnSession

/** 三种数据源模式；一期只实现 [NAS]。 */
enum class DataSourceKind { NAS, LOCAL, HYBRID }

/** 账号作用域：NAS 账号 / 本机账号。 */
enum class AccountScope { NAS, LOCAL }

/**
 * 连接流程。
 *
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
     */
    val portalUrl: String? = null,
    /** 明文 HTTP（只可能是私网 8990）。 */
    val cleartext: Boolean = false,
    /**
     * 不再走门户、⛔ 也不等那个根本不存在的 `Trim-MC-token`。
     */
    val fnSession: FnSession? = null,
    /**
     * FNID 解析时顺带拿到的**局域网地址**（`data.ipv4` 里的第一个），没有就为 null。
     *
     */
    val lanHint: String? = null,
) {
    /** WebView 该从哪一页开始。 */
    val startUrl: String
        get() = when {
            flow == EntryFlow.DIRECT -> zxDeskLoginUrl
            fnSession != null -> zxDeskLoginUrl
            portalUrl != null -> portalUrl
            else -> "${baseUrl.trimEnd('/')}/"
        }

    /** 登录飞牛之后要去的 ZXDesk 登录页。 */
    val zxDeskLoginUrl: String get() = "${baseUrl.trimEnd('/')}$gatewayPath/login.html"
}
