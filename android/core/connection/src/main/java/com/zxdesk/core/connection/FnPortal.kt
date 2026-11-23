/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.connection

/**
 * 官方 FN Connect 门户 —— 登录飞牛的入口页。
 *
 */
object FnPortal {
    const val HOST = "fnos.net"
    private const val ALT_HOST = "5ddd.com"

    fun urlFor(fnId: String): String = "https://$HOST/${fnId.lowercase()}/"

    /** 门户及其备站（含子域）。注意 `*.fnos.net` 也包含中继主机，调用方要自己先排除中继。 */
    fun isPortalHost(host: String): Boolean = host == HOST || host.endsWith(".$HOST") ||
        host == ALT_HOST || host.endsWith(".$ALT_HOST")
}
