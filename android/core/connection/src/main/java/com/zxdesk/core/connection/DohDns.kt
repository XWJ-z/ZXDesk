/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.connection

import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Dns

/**
 * 先系统、后 DoH 的解析器。
 *
 */
internal class DohResolver(
    private val systemLookup: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() },
    private val dohLookup: (String) -> DohResult = DohProbe::lookup,
    private val now: () -> Long = System::currentTimeMillis,
    /** 「系统解析不通、改走公共解析」时回调一次，供上层写日志。 */
    private val onFallback: (String) -> Unit = {},
) : Dns {
    private companion object {
        /** 成功缓存时长，贴合中继 TTL。 */
        const val OK_TTL_MS = 60_000L

        /** 失败缓存时长：只防抖，不拦人重试。 */
        const val FAIL_TTL_MS = 5_000L
    }

    /** 一条解析结论：要么一批地址，要么一个待抛的异常；[expiresAt] 到了就重查。 */
    private class Entry(val ips: List<InetAddress>, val error: UnknownHostException?, val expiresAt: Long)

    private val cache = ConcurrentHashMap<String, Entry>()

    /** 每个域名一把锁；用完不删，域名数量有限，留着比反复创建便宜。 */
    private val gates = ConcurrentHashMap<String, Any>()

    override fun lookup(hostname: String): List<InetAddress> {
        val name = hostname.trim()
        if (name.isEmpty()) throw UnknownHostException("主机名为空")
        // IP 字面量本来就不过解析，⛔ 别为它去问 DoH
        if (DnsCheck.isIpLiteral(name)) return listOf(InetAddress.getByName(name))

        valid(name)?.let { return orThrow(it) }
        val gate = gates.computeIfAbsent(name) { Any() }
        synchronized(gate) {
            // 双检：并发时后进来的线程直接用前一个刚填好的结果
            valid(name)?.let { return orThrow(it) }
            val entry = resolve(name)
            cache[name] = entry
            return orThrow(entry)
        }
    }

    /**
     * 连不上时强制重查一次，绕过成功缓存。
     *
     */
    fun refreshIfChanged(host: String): List<InetAddress>? {
        val name = host.trim()
        if (name.isEmpty() || DnsCheck.isIpLiteral(name)) return null
        val previous = cache[name]
        val entry = fromDoh(name, previous?.error, notify = false)
        cache[name] = entry
        if (entry.error != null) return null
        val before = previous?.ips?.mapNotNull { it.hostAddress }.orEmpty()
        return if (entry.ips.mapNotNull { it.hostAddress } == before) null else entry.ips
    }

    private fun valid(name: String): Entry? = cache[name]?.takeIf { it.expiresAt > now() }

    private fun orThrow(entry: Entry): List<InetAddress> {
        entry.error?.let { throw it }
        return entry.ips
    }

    private fun resolve(name: String): Entry {
        var systemError: UnknownHostException? = null
        val fromSystem = runCatching { systemLookup(name) }.getOrElse { e ->
            systemError = e as? UnknownHostException
                ?: UnknownHostException("解析不了 $name").apply { initCause(e) }
            emptyList()
        }
        // 系统解析有结果就用它，⛔ 不要再问 DoH（那是一次白花的往返）
        if (fromSystem.isNotEmpty()) return Entry(fromSystem, null, now() + OK_TTL_MS)
        return fromDoh(name, systemError, notify = true)
    }

    /**
     * 只问公共解析，不碰系统解析。
     * @param systemFailure 系统那次异常，挂成最终异常的 cause
     */
    private fun fromDoh(name: String, systemFailure: UnknownHostException?, notify: Boolean): Entry {
        when (val doh = dohLookup(name)) {
            is DohResult.Found -> {
                val ips = doh.ips.mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
                if (ips.isNotEmpty()) {
                    if (notify) onFallback(name)
                    return Entry(ips, null, now() + OK_TTL_MS)
                }
            }
            // 中继没记录 / DoH 都到不了：都归到「解析不了」，文案由上层按三态给
            DohResult.NoRecord, DohResult.Unreachable -> Unit
        }
        val failure = UnknownHostException("Unable to resolve host \"$name\": no address").apply {
            if (systemFailure != null) initCause(systemFailure)
        }
        return Entry(emptyList(), failure, now() + FAIL_TTL_MS)
    }
}

/**
 * 全局唯一的解析器，给所有 OkHttp 客户端挂 `.dns(...)` 用。
 *
 */
object DohDns : Dns {
    /**
     * 发生「系统解析不通、改走公共解析」时的通知口。
     *
     */
    @Volatile
    var onFallback: ((String) -> Unit)? = null

    private val resolver = DohResolver(onFallback = { host -> onFallback?.invoke(host) })

    override fun lookup(hostname: String): List<InetAddress> = resolver.lookup(hostname)

    /** 见 [DohResolver.refreshIfChanged]。 */
    fun refreshIfChanged(host: String): List<InetAddress>? = resolver.refreshIfChanged(host)
}

/**
 * 飞牛中继域名：`<fnid>.fnos.net`。GeoDNS，同一域名可能给出不同区域的节点。
 *
 */
fun isRelayHost(host: String): Boolean =
    host.equals("fnos.net", ignoreCase = true) || host.endsWith(".fnos.net", ignoreCase = true)

/**
 * 「解析到了但连不上」要不要强制重查一次。
 *
 */
internal fun shouldRetryWithFreshDns(host: String, error: Throwable, alreadyRetried: Boolean): Boolean {
    if (alreadyRetried || !isRelayHost(host)) return false
    var current: Throwable? = error
    var depth = 0
    while (current != null && depth < 6) {
        if (current is ConnectException || current is SocketTimeoutException) return true
        current = current.cause
        depth++
    }
    return false
}
