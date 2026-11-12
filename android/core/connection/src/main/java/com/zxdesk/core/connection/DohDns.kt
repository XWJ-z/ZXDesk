/*
 * ZXDesk工作台 Android 客户端
 * 文件：DohDns.kt
 * 职责：OkHttp 的自定义解析器，系统解析失败时改走公共 DoH
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
 * 为什么可以「拿 DoH 的 IP 去建连」：TCP 连的是 IP，但 TLS 的 SNI、证书校验与 `Host` 头
 * 用的都是 **URL 里的域名**，三者互不影响。所以解析这一层换了来源，安全语义一点没变。
 * ⛔ 只有把 IP 直接写进 URL（`https://203.0.113.7/...`）才会撞上证书不匹配 —— 这里不是那种做法。
 *
 * 缓存两条时间线：
 * - 成功 60 秒：贴合飞牛中继的 TTL，⛔ 不要更长 —— 中继 IP 会轮换，缓存久了会连到已经下线的节点；
 * - 失败 5 秒：一次网络抖动不该让同一次登录把两个端点连打两遍。
 *
 * 同一域名的并发查询只发一次（[gates] 按域名加锁），避免首屏几个请求同时穿到 DoH。
 *
 * ⚠️ 两个依赖都可注入，单测据此覆盖各条分支，⛔ 不碰网络也不碰真实时钟。
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
     * 存在的理由：系统解析**成功**了却给了不可达的节点（`fnos.net` 是 GeoDNS），
     * 这时没有任何异常能提示「该重查」，只能由建连失败的那一侧主动叫一次。
     *
     * ⚠️ **必须跳过系统解析**：GeoDNS 对同一个出口每次都给同一批地址，
     * 走系统那条路重查等于把刚才那批坏地址再抄一遍，判「没变」⇒ 兜底形同虚设。
     *
     * @return 新地址；与失败前那批相同时返回 `null`（换了还是同一批，重试没有意义）
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
     *
     * @param systemFailure 系统那次异常，挂成最终异常的 cause
     * @param notify 是否通知上层「这次绕过了系统解析」；强制重查时不通知 ——
     *   那条路本来就是系统给了地址却没连通，不属于「系统解析失败」
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
 * 必须是同一个实例：缓存与并发合并都挂在实例上，每个客户端各建一个就等于没有缓存。
 */
object DohDns : Dns {
    /**
     * 发生「系统解析不通、改走公共解析」时的通知口。
     *
     * 接在解析器上而不是逐处调用点：登录、票据、探页、FNID 查询四个入口都会经过这里，
     * 挂一处就全覆盖。上层据它写日志，并在需要时决定给 WebView 启用本机代理。
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
 * 公开给上层用：判断「这次建连失败该不该换地址」需要它 —— 只有走中继的连接才谈得上
 * 「换了个节点也许就通了」，局域网 IP 与自己的域名换节点等于换了个说法。
 */
fun isRelayHost(host: String): Boolean =
    host.equals("fnos.net", ignoreCase = true) || host.endsWith(".fnos.net", ignoreCase = true)

/**
 * 「解析到了但连不上」要不要强制重查一次。
 *
 * 三个条件缺一不可：目标确实是中继域名、失败是建连类（连不上 / 超时）、本次还没重试过。
 * ⛔ 「还没重试过」由调用方用自己的标志位保证 —— 这条兜底只许走一次，
 * 否则一个连不通的节点会把登录拖成无限重连。
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
