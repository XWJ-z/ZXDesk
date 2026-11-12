/*
 * ZXDesk工作台 Android 客户端
 * 文件：DnsCheck.kt
 * 职责：建连前的解析诊断，分清系统解析与公共解析各自的结果
 */

package com.zxdesk.core.connection

import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * 一次解析诊断的结论。
 *
 * 它**不拦人**：只要公共解析查到了地址，建连照常进行（真的连由 [DohDns] 负责）。
 * 诊断只用于两件事 —— 写一行「解析：公共解析」的日志，以及告诉上层
 * 「这次绕过了系统解析」，让 WebView 侧知道要不要启用本机代理。
 */
class DnsReport internal constructor(
    /** 被诊断的域名。 */
    val host: String,
    /** 系统解析拿到的地址；空 = 系统这条路不通。 */
    val systemIps: List<InetAddress>,
    /** 公共 DoH 拿到的地址；空 = 没查到，或压根不用查。 */
    val dohIps: List<String>,
) {
    /** 系统解析不通、公共解析查到了 —— 本次会绕过系统解析建连。 */
    val bypassedSystemDns: Boolean get() = systemIps.isEmpty() && dohIps.isNotEmpty()
}

/**
 * 建连前的解析诊断。
 *
 * 为什么不在这里阻断：换了解析器之后，「系统解析失败」不再是死路 ——
 * 公共解析查到地址就能连上。这里再抛异常只会把一条本来能走通的路提前掐断。
 *
 * 唯一失败的情况是**两条路都不通**：这时才如实报错，文案按没网 / 中继无此设备分流。
 *
 * ⚠️ 阻塞调用（公共解析最长 3 秒），⛔ 别在主线程跑。
 */
object DnsCheck {
    /**
     * 诊断 [host]。
     *
     * IP 字面量直接返回空报告 —— 它本来就不查解析。
     *
     * @throws IOException 系统解析与公共解析都拿不到地址
     */
    fun inspect(host: String): DnsReport = inspect(
        host = host,
        systemLookup = { name -> InetAddress.getAllByName(name).toList() },
        dohLookup = DohProbe::lookup,
    )

    /** 同上，两个解析器都可注入 —— 单测据此覆盖各条分流，不碰网络。 */
    internal fun inspect(
        host: String,
        systemLookup: (String) -> List<InetAddress>,
        dohLookup: (String) -> DohResult,
    ): DnsReport {
        val name = host.trim()
        if (name.isEmpty() || isIpLiteral(name)) return DnsReport(name, emptyList(), emptyList())
        var first: UnknownHostException? = null
        val resolved = runCatching { systemLookup(name) }.getOrElse { e ->
            if (e is UnknownHostException) first = e
            emptyList()
        }
        // 系统解析有结果就是正常情况，⛔ 不要再去问公共解析（白花一次往返）
        if (resolved.isNotEmpty()) return DnsReport(name, resolved, emptyList())
        return when (val doh = dohLookup(name)) {
            is DohResult.Found -> DnsReport(name, emptyList(), doh.ips)
            DohResult.NoRecord, DohResult.Unreachable ->
                throw IOException(dnsFailureMessage(name, doh), first)
        }
    }

    /** 是不是 IP 字面量（IPv4 点分 / 带冒号的 IPv6）；只做粗判，范围校验归 [InputParser]。 */
    fun isIpLiteral(value: String): Boolean =
        value.contains(':') || IPV4.matches(value.trim())

    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
}
