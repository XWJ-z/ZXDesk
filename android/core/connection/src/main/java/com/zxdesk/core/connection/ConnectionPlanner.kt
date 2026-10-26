package com.zxdesk.core.connection

/** 选路结果：一条可加载的基址 + 需要的流程。 */
data class ConnectPlan(
    val baseUrl: String,
    val gatewayPath: String,
    /** 明文 HTTP（只可能是私网 8990）。 */
    val cleartext: Boolean,
    /** true = 8990 直连，不需要飞牛登录；false = 走网关/中继，先登飞牛。 */
    val direct: Boolean,
)

sealed interface PlanResult {
    data class Ready(val plan: ConnectPlan) : PlanResult

    /** [reason] 直接显示给用户，⛔ 别塞异常类名。 */
    data class Failure(val reason: String) : PlanResult
}

/**
 * 把「解析后的输入」变成「加载哪条地址、走哪条流程」。
 *
 * 三条硬规则（来自方案 §五 / §七.4）：
 * 1. **8990 永远明文**：它是本应用的局域网救援端口，用户写 `https://ip:8990` 也按 http 走；
 * 2. **明文只允许私网 IP**：公网地址给 `http://` 一律拒；
 * 3. **不写 scheme 时**：勾了 HTTPS 用 https，没勾用 `http://IP:8990`。
 */
object ConnectionPlanner {
    /** 本应用的直连救援端口（明文）。 */
    const val DIRECT_PORT = 8990
    const val DEFAULT_GATEWAY_PATH = "/app/zxdesk"

    fun plan(target: Target, preferHttps: Boolean = true): PlanResult = when (target) {
        is Target.Invalid -> PlanResult.Failure(target.reason)
        // FNID 要先联网解析，选路在 NasDataSource 里做
        is Target.FnId -> PlanResult.Failure("FNID 需要先解析，请检查网络后重试")
        is Target.Host -> planHost(target, preferHttps)
    }

    private fun planHost(t: Target.Host, preferHttps: Boolean): PlanResult {
        val host = t.host
        if (host.isBlank()) return PlanResult.Failure("地址不能为空")
        val isIp = t.kind == TargetKind.IP
        val gatewayPath = t.path?.takeIf { it.isNotBlank() } ?: DEFAULT_GATEWAY_PATH

        // 规则 1：8990 一律明文直连
        if (t.port == DIRECT_PORT) {
            if (!isIp) return PlanResult.Failure("8990 是局域网直连端口，请填内网 IP")
            if (!isPrivateAddress(host)) {
                return PlanResult.Failure("8990 只用于局域网，公网请改用 HTTPS 或 FNID")
            }
            return PlanResult.Ready(
                ConnectPlan(
                    baseUrl = "http://$host:$DIRECT_PORT",
                    gatewayPath = gatewayPath,
                    cleartext = true,
                    direct = true,
                ),
            )
        }

        val scheme = t.scheme ?: if (preferHttps) "https" else "http"

        // 规则 2：明文只允许私网 IP
        if (scheme == "http") {
            if (!isIp || !isPrivateAddress(host)) {
                return PlanResult.Failure("明文只允许局域网 IP，公网地址必须使用 HTTPS")
            }
            val port = t.port ?: DIRECT_PORT
            return PlanResult.Ready(
                ConnectPlan(
                    baseUrl = "http://$host:$port",
                    gatewayPath = gatewayPath,
                    cleartext = true,
                    direct = port == DIRECT_PORT,
                ),
            )
        }

        val baseUrl = if (t.port != null) "https://$host:${t.port}" else "https://$host"
        return PlanResult.Ready(
            ConnectPlan(baseUrl = baseUrl, gatewayPath = gatewayPath, cleartext = false, direct = false),
        )
    }

    /** 私网判定：10/8、172.16/12、192.168/16、169.254/16、127/8；IPv6 的 fc00::/7、fe80::/10、::1。 */
    fun isPrivateAddress(host: String): Boolean {
        if (host.equals("localhost", ignoreCase = true)) return true
        if (InputParser.isIpv4(host)) {
            val a = host.substringBefore('.').toInt()
            val b = host.split('.')[1].toInt()
            return a == 10 || a == 127 ||
                (a == 172 && b in 16..31) ||
                (a == 192 && b == 168) ||
                (a == 169 && b == 254)
        }
        if (InputParser.isIpv6(host)) {
            val head = host.lowercase()
            return head == "::1" || head.startsWith("fc") || head.startsWith("fd") ||
                head.startsWith("fe8") || head.startsWith("fe9") ||
                head.startsWith("fea") || head.startsWith("feb")
        }
        return false
    }
}
