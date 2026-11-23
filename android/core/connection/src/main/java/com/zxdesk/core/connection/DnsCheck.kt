/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.connection

import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * 一次解析诊断的结论。
 *
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
 */
object DnsCheck {
    /**
     * 诊断 [host]。
     *
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
