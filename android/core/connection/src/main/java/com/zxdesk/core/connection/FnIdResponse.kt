package com.zxdesk.core.connection

/**
 * `POST /api/v1/fn/con` 的响应解析。
 *
 * 结构样本（字段名照抄真实响应；**IP / FNID 已全部脱敏**，公网段为文档保留段）：
 * ```json
 * {"msg":"","code":0,"data":{"ddns":null,"ipv4":["10.1.2.4"],
 *  "ipv6":[],"publicIpv4":["203.0.113.7"],"publicIpv6":["2001:db8:..."],
 *  "fn":["demo-nas.fnos.net:443"],"port":{"httpsPort":64999,"httpPort":64888},
 *  "checkSum":"8812","ver":"3.0.0","forbbidPublicIpv6":false}}
 * ```
 */
object FnIdResponse {
    sealed interface Result

    data class Ok(val addresses: FnIdAddresses) : Result

    /** `code != 0`：FNID 错 / 不存在 / 已解绑。 */
    data class NotFound(val code: Long, val message: String) : Result

    /** 结构不对（不是 JSON、缺 data、没有任何地址）。 */
    data class Bad(val reason: String) : Result

    fun parse(text: String): Result {
        val root = runCatching { MiniJson.parse(text) }.getOrElse { return Bad("返回的不是合法 JSON") }
        if (root !is Map<*, *>) return Bad("返回结构不是对象")

        val code = MiniJson.anyToLong(root["code"]) ?: 0L
        val message = root["msg"] as? String ?: ""
        if (code != 0L) return NotFound(code, message)

        val data = root["data"] as? Map<*, *> ?: return Bad("返回缺少 data")
        val ports = data["port"] as? Map<*, *>
        val addresses = FnIdAddresses(
            lanIpv4 = data.strings("ipv4"),
            lanIpv6 = data.strings("ipv6"),
            publicIpv4 = data.strings("publicIpv4"),
            publicIpv6 = data.strings("publicIpv6"),
            relay = data.strings("fn").map { it.substringBefore(':') }.filter { it.isNotBlank() },
            httpPort = MiniJson.anyToLong(ports?.get("httpPort"))?.toInt() ?: DEFAULT_HTTP_PORT,
            httpsPort = MiniJson.anyToLong(ports?.get("httpsPort"))?.toInt() ?: DEFAULT_HTTPS_PORT,
        )
        val empty = addresses.lanIpv4.isEmpty() && addresses.lanIpv6.isEmpty() &&
            addresses.publicIpv4.isEmpty() && addresses.publicIpv6.isEmpty() &&
            addresses.relay.isEmpty()
        if (empty) return Bad("这个 FNID 没有可用地址（设备可能离线）")
        return Ok(addresses)
    }

    private fun Map<*, *>.strings(key: String): List<String> =
        (this[key] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
}
