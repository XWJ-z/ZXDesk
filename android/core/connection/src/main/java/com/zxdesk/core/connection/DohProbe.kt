/*
 * ZXDesk工作台 Android 客户端
 * 文件：DohProbe.kt
 * 职责：公共 DNS over HTTPS 查询，给 DohDns 与解析诊断共用
 */

package com.zxdesk.core.connection

/**
 * DoH 查询的结果，三态 —— 这三态对应三种完全不同的处置，⛔ 不能合并成「没查到」：
 *
 * - [Found]：域名有记录。系统解析失败而这里有记录 ⇒ **本机 DNS 这条路断了**，
 *   但域名本身好的，拿这批地址按原域名建连是合法的（SNI 与证书校验仍用域名）。
 *   见 [DohDns]。
 * - [NoRecord]：域名确实没有记录 —— 飞牛中继那边此刻没这台设备，通常十几分钟自愈；
 * - [Unreachable]：连 DoH 都到不了，说明手机整体没网，先修网络。
 */
internal sealed interface DohResult {
    data class Found(val ips: List<String>) : DohResult
    data object NoRecord : DohResult
    data object Unreachable : DohResult
}

/**
 * 用公共 DoH 查一次记录。
 *
 * 为什么应用侧要自己解析：Chromium 与 `HttpURLConnection` 都只认系统解析，
 * 而部分运营商 / 路由器 / 私人 DNS 会把 `*.fnos.net` 这类泛解析子域过滤掉或负缓存。
 * 这时同网络的飞牛官方 APP 能连、我们不能，差别就在解析这一层。
 *
 * 端点写死成 IP（`223.5.5.5` / `1.12.12.12`），⛔ 不用域名端点 —— 用域名端点等于
 * 把「解析不了」这道坎又搬到门口。
 *
 * ⚠️ 阻塞调用，总预算见 [TOTAL_BUDGET_MS]，⛔ 别在主线程跑。
 */
internal object DohProbe {
    /** 两个端点按顺序试，先通先算。阿里与腾讯的 JSON 接口字段一致。 */
    private val endpoints = listOf(
        "https://223.5.5.5/resolve",
        "https://1.12.12.12/resolve",
    )

    /** `application/dns-json` 的 `type` 值：A = 1，AAAA = 28。 */
    private const val TYPE_A = 1L
    private const val TYPE_AAAA = 28L

    private const val ENDPOINT_TIMEOUT_MS = 1_500L

    /** 一整轮（A ＋ AAAA、两个端点）的总预算，超了直接按已有结果收尾。 */
    private const val TOTAL_BUDGET_MS = 3_000L

    private val client by lazy {
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(ENDPOINT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .readTimeout(ENDPOINT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
    }

    /**
     * 查 [host] 的记录：先 A，没有结果再 AAAA。
     *
     * 为什么要 AAAA：纯 IPv6 网络下 A 记录为空但 AAAA 有值，只查 A 会误判成「中继没有这台设备」。
     */
    fun lookup(host: String): DohResult {
        val deadline = System.nanoTime() + TOTAL_BUDGET_MS * 1_000_000
        var reachable = false
        for (type in listOf(TYPE_A to "A", TYPE_AAAA to "AAAA")) {
            for (base in endpoints) {
                val remaining = (deadline - System.nanoTime()) / 1_000_000
                if (remaining <= 0) return conclude(reachable)
                when (val result = query(base, host, type.first, type.second, minOf(ENDPOINT_TIMEOUT_MS, remaining))) {
                    is DohResult.Found -> return result
                    DohResult.NoRecord -> reachable = true
                    DohResult.Unreachable -> Unit
                }
            }
        }
        return conclude(reachable)
    }

    private fun conclude(reachable: Boolean): DohResult =
        if (reachable) DohResult.NoRecord else DohResult.Unreachable

    /** 打一个端点。**任何** HTTP 响应都算「网络可达」—— 4xx / 5xx 也证明路是通的。 */
    private fun query(base: String, host: String, typeCode: Long, typeName: String, timeoutMs: Long): DohResult {
        return try {
            // 每次现算超时：总预算快用完时不能让最后一个端点还按整份超时去等
            val attempt = client.newBuilder()
                .connectTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                .build()
            val request = okhttp3.Request.Builder()
                .url("$base?name=$host&type=$typeName")
                .header("accept", "application/dns-json")
                .get()
                .build()
            attempt.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return DohResult.NoRecord
                val ips = parseIps(response.body?.string().orEmpty(), typeCode)
                if (ips.isEmpty()) DohResult.NoRecord else DohResult.Found(ips)
            }
        } catch (_: Exception) {
            // 端点不通（超时 / 被拦 / 证书不对）：交给下一个端点
            DohResult.Unreachable
        }
    }

    /** 从 DoH 的 JSON 里挑出指定类型的记录（`Answer[].data`）。 */
    private fun parseIps(body: String, typeCode: Long): List<String> {
        val root = runCatching { MiniJson.parse(body) as? Map<*, *> }.getOrNull() ?: return emptyList()
        val answers = root["Answer"] as? List<*> ?: return emptyList()
        return answers.mapNotNull { row ->
            val map = row as? Map<*, *> ?: return@mapNotNull null
            if (MiniJson.anyToLong(map["type"]) != typeCode) return@mapNotNull null
            (map["data"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
        }
    }
}
