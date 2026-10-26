package com.zxdesk.core.connection

import java.net.URI

/**
 * 输入识别：FNID / 域名 / IP / 完整 URL。
 *
 * 判定顺序与任务单（批 1 §二 A）逐条对应，顺序不能改：
 * 完整 URL → `[v6]:port` → `host:port` → 裸 IPv6 → IPv4 → 含 `.` 的域名 → FNID → 认不出。
 *
 * ⚠️ 已知取舍：不带点也不带端口的主机名（如 `localhost`、`nas`）会命中 FNID 正则，
 * 按 FNID 处理 —— 局域网请填 IP（`192.168.x.x`）或带端口（`nas:8990`）。
 */
object InputParser {
    /** FNID：字母开头，总长 5~32，允许中间有 `-`，⛔ 不允许以 `-` 结尾。 */
    private val FN_ID = Regex("^[a-zA-Z][a-zA-Z0-9-]{4,31}$")

    fun parse(raw: String): Target {
        val text = raw.trim().trimEnd('/')
        if (text.isEmpty()) return Target.Invalid("请输入 NAS 地址")

        if (text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true)) {
            val uri = runCatching { URI(text) }.getOrNull() ?: return Target.Invalid("地址格式不正确")
            val host = uri.host ?: return Target.Invalid("地址里没有主机名")
            return Target.Host(
                host = host,
                port = uri.port.takeIf { it > 0 },
                scheme = uri.scheme?.lowercase(),
                path = uri.path?.takeIf { it.isNotBlank() },
                kind = kindOf(host),
            )
        }

        // [fe80::1]:8990
        if (text.startsWith("[")) {
            val end = text.indexOf(']')
            if (end < 0) return Target.Invalid("IPv6 地址缺少右方括号")
            val host = text.substring(1, end)
            if (!isIpv6(host)) return Target.Invalid("IPv6 地址格式不正确")
            val rest = text.substring(end + 1)
            val port = when {
                rest.isEmpty() -> null
                rest.startsWith(":") -> rest.drop(1).toIntOrNull()
                    ?: return Target.Invalid("端口不是数字")
                else -> return Target.Invalid("地址格式不正确")
            }
            return Target.Host(host, port, null, null, TargetKind.IP)
        }

        val colons = text.count { it == ':' }
        if (colons == 1) {
            val host = text.substringBefore(':')
            val port = text.substringAfter(':').toIntOrNull()
            if (host.isNotEmpty() && port != null) {
                return Target.Host(host, port, null, null, kindOf(host))
            }
        } else if (colons > 1 && isIpv6(text)) {
            return Target.Host(text, null, null, null, TargetKind.IP)
        }

        return when {
            isIpv4(text) -> Target.Host(text, null, null, null, TargetKind.IP)
            text.contains('.') -> Target.Host(text, null, null, null, TargetKind.DOMAIN)
            FN_ID.matches(text) && !text.endsWith('-') -> Target.FnId(text.lowercase())
            else -> Target.Invalid("无法识别，请输入 IP、域名或 FNID")
        }
    }

    private fun kindOf(host: String): TargetKind =
        if (isIpv4(host) || isIpv6(host)) TargetKind.IP else TargetKind.DOMAIN

    fun isIpv4(text: String): Boolean {
        val parts = text.split('.')
        if (parts.size != 4) return false
        return parts.all { part ->
            part.isNotEmpty() && part.length <= 3 &&
                part.all { it.isDigit() } && part.toInt() in 0..255
        }
    }

    fun isIpv6(text: String): Boolean =
        text.count { it == ':' } >= 2 &&
            text.all { it.isDigit() || it in "abcdefABCDEF:." }
}
