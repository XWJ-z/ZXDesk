package com.zxdesk.core.connection

/**
 * 官方 FN Connect 门户 —— 登录飞牛的入口页。
 *
 * 实测 2026-10-23：`https://fnos.net/<fnid>/`（`https://5ddd.com/<fnid>/` 返回同一份）
 * 是 851 字节的「FN Connect 远程访问」SPA 壳，JS 从 `static2.fnnas.com` 加载，渲染出飞牛登录表单。
 *
 * ⚠️ **中继根 `https://<fnid>.fnos.net/` 不是登录页** —— 那是 NAS 网页 SPA 的桌面壳，
 * 未登录时只会灰屏/转圈（0.2.0 就卡在这里）。⇒ FNID 一律先走门户。
 */
object FnPortal {
    const val HOST = "fnos.net"
    private const val ALT_HOST = "5ddd.com"

    fun urlFor(fnId: String): String = "https://$HOST/${fnId.lowercase()}/"

    /** 门户及其备站（含子域）。注意 `*.fnos.net` 也包含中继主机，调用方要自己先排除中继。 */
    fun isPortalHost(host: String): Boolean = host == HOST || host.endsWith(".$HOST") ||
        host == ALT_HOST || host.endsWith(".$ALT_HOST")
}
