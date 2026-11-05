/*
 * ZXDesk工作台 Android 客户端
 * 文件：DohProbe.kt
 * 职责：DNS 失败时的 DoH 复核，只做诊断，不参与连接
 */

package com.zxdesk.core.connection

/**
 * DoH 复核的结果，三态 —— 这三态对应三种完全不同的处置，⛔ 不能合并成「没查到」：
 *
 * - [Found]：域名有记录，是**本地 DNS** 坏了（缓存 / 过滤 / 私人 DNS）。开关飞行模式或换 WiFi 就能好；
 * - [NoRecord]：域名确实没有 A 记录 —— 飞牛中继那边此刻没这台设备，通常十几分钟自愈；
 * - [Unreachable]：连 DoH 都到不了，说明手机整体没网，先修网络。
 */
internal sealed interface DohResult {
    data class Found(val ips: List<String>) : DohResult
    data object NoRecord : DohResult
    data object Unreachable : DohResult
}

/**
 * 用公共 DoH 复核一次 A 记录。
 *
 * 为什么需要它：`EAI_NODATA` 在用户眼里只有一个意思 ——「连不上」，但真实原因可能是
 * 「本地 DNS 负缓存了」也可能是「中继记录真的没了」，两者处置完全不同。
 * 0.2.18 真机（2026-11-03 09:05）就卡在这个歧义上：同一时刻 DDNS 域名好好的，
 * 只有 `*.fnos.net` 解析不了。
 *
 * ⚠️ **只诊断、不改地址**：拿到 IP 也不拿它去建连 —— 中继证书绑的是域名，
 *    换成 IP 之后 TLS 必然对不上，表现会从「解析失败」变成更难懂的「证书错误」。
 * ⚠️ 走 IP 直连端点（`223.5.5.5`），不再依赖一次 DNS 解析。
 */
internal object DohProbe {
    private val endpoints = listOf(
        "https://223.5.5.5/resolve",
        "https://1.12.12.12/resolve",
    )

    private val client by lazy {
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .readTimeout(TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
    }

    /** 阻塞调用，⛔ 别在主线程跑。总预算 2 × [TIMEOUT_MS]。 */
    fun lookup(host: String): DohResult {
        var reachable = false
        for (base in endpoints) {
            try {
                val url = "$base?name=$host&type=A"
                val request = okhttp3.Request.Builder()
                    .url(url)
                    .header("accept", "application/dns-json")
                    .get()
                    .build()
                client.newCall(request).execute().use { response ->
                    // 只要有 HTTP 响应就算「网络可达」—— 5xx / 4xx 也证明路是通的，
                    // 后面「没有记录」与「没网」才分得开。
                    reachable = true
                    if (!response.isSuccessful) return@use
                    val body = response.body?.string().orEmpty()
                    val ips = parseIps(body)
                    if (ips.isNotEmpty()) return DohResult.Found(ips)
                }
            } catch (_: Exception) {
                // 这个端点不通就换下一个；两个都不通才算 Unreachable
            }
        }
        return if (reachable) DohResult.NoRecord else DohResult.Unreachable
    }

    /** 从 DoH 的 JSON 里挑出 A 记录（`Answer[].type == 1`）。 */
    private fun parseIps(body: String): List<String> {
        val root = runCatching { MiniJson.parse(body) as? Map<*, *> }.getOrNull() ?: return emptyList()
        val answers = root["Answer"] as? List<*> ?: return emptyList()
        return answers.mapNotNull { row ->
            val map = row as? Map<*, *> ?: return@mapNotNull null
            if (MiniJson.anyToLong(map["type"]) != 1L) return@mapNotNull null
            (map["data"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
        }
    }

    private const val TIMEOUT_MS = 2_000L
}
