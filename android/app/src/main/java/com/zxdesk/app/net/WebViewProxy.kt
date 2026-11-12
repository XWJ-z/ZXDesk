/*
 * ZXDesk工作台 Android 客户端
 * 文件：WebViewProxy.kt
 * 职责：把本机代理挂到 WebView 上，并在不需要时拆掉
 */

package com.zxdesk.app.net

import android.content.Context
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.zxdesk.app.log.AppLog
import com.zxdesk.core.connection.DohDns
import com.zxdesk.core.connection.LocalProxy
import com.zxdesk.core.connection.proxyRuleFor
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * WebView 的代理覆盖。
 *
 * 为什么要动 WebView：Chromium 只认系统解析，系统解析被拦时页面根本发不出请求；
 * `shouldInterceptRequest` 又拿不到 POST body，接管不了请求层。唯一可行的是**传输层** ——
 * 页面把所有请求交给一个只监听 `127.0.0.1` 的代理，由代理自己解析目标。
 *
 * 三条纪律：
 * - **只在需要时开**：解析被绕过，或 WebView 报了 `ERROR_HOST_LOOKUP`。正常网络下⛔ 不开，
 *   否则等于给所有请求多绕一跳，首屏白白变慢；
 * - **必须能拆干净**：断开 / 退出 / 换地址 / 页面销毁都要 [disable]，否则下次进页面还挂着一个死代理；
 * - **不重试成死循环**：调用方一次性闸（参照 `cacheRetryUsed`），这里只管「开与关」。
 *
 * ⚠️ 依赖只开了这一道口子：只碰 `ProxyController` 与 `WebViewFeature`，别拿它做别的事。
 */
object WebViewProxy {
    private const val TAG = "Proxy"

    /** 代理设置是异步生效的；超过这个时间还没回调就当没成，别让首屏一直等。 */
    private const val APPLY_TIMEOUT_MS = 3_000L

    /** 「登录阶段绕过过系统解析」的有效期：只用于首屏那一次判断。 */
    private const val BYPASS_WINDOW_MS = 5 * 60 * 1000L

    private val local = LocalProxy(log = { line -> AppLog.i(TAG, line) })

    @Volatile
    private var enabled = false

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var bypassedAt = 0L

    /** 内核是否支持代理覆盖。低于 WebView 72 就不支持，⛔ 别靠解析版本号判断。 */
    fun isSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    /** 当前是否真的在生效。上层据此决定要不要 reload —— 已经在跑就别白重载一次。 */
    fun isActive(): Boolean = enabled

    /** 登录阶段判定「系统解析被绕过」时记一笔，WebView 首帧据此决定要不要先起代理。 */
    fun noteResolutionBypassed() {
        bypassedAt = SystemClock.elapsedRealtime()
    }

    /** 最近是否发生过「系统解析被绕过」。窗口按 [BYPASS_WINDOW_MS] 算。 */
    fun recentlyBypassed(): Boolean {
        val at = bypassedAt
        return at != 0L && SystemClock.elapsedRealtime() - at <= BYPASS_WINDOW_MS
    }

    /**
     * 起代理并让 WebView 走它。
     *
     * ⚠️ 返回 true 之后**才**能 `loadUrl` —— 覆盖是异步生效的，抢跑那一页还是走系统解析。
     *
     * 四种失败**各记一行**，⛔ 别再合成一句「没能起来」：内核不支持 / 监听起不来 /
     * 覆盖被拒 / 覆盖超时，处置完全不同，混在一句里下次还得再猜一遍。
     *
     * @param host 打不开的那个域名。给了就先确认应用自己解不解析得动 ——
     *   离线时系统与公共解析都不通，这时挂代理只会把「离线」变成「502」。
     * @return 是否已生效；false 时调用方按普通失败路径处理，⛔ 别在这里重试
     */
    suspend fun enable(context: Context, host: String? = null): Boolean {
        if (!isSupported()) {
            AppLog.w(TAG, "代理：内核不支持 PROXY_OVERRIDE，需 WebView 72 及以上")
            return false
        }
        if (enabled) return true
        if (!host.isNullOrBlank() && !canResolve(host)) {
            AppLog.w(TAG, "代理：目标域名系统与公共解析都查不到，跳过")
            return false
        }
        appContext = context.applicationContext
        val port = runCatching { local.start() }.getOrElse { e ->
            AppLog.w(TAG, "代理：监听起不来 · " + e.javaClass.simpleName + " · " + (e.message ?: "无消息"))
            return false
        }
        when (val result = withTimeoutOrNull(APPLY_TIMEOUT_MS) { apply(context, port) }) {
            ApplyResult.Applied -> {
                enabled = true
                AppLog.i(TAG, "代理：已启用 $port")
                return true
            }
            null -> {
                local.stop()
                AppLog.w(TAG, "代理：覆盖超时 · ${APPLY_TIMEOUT_MS}ms 未回调，已回滚")
                return false
            }
            is ApplyResult.Rejected -> {
                local.stop()
                AppLog.w(TAG, "代理：覆盖被拒 · " + result.reason)
                return false
            }
        }
    }

    /** 拆掉覆盖并停掉监听。可以重复调用。 */
    fun disable() {
        if (!enabled) {
            // 可能是上次没拆干净，也可能是根本没开过 —— 停一次没有副作用
            local.stop()
            return
        }
        enabled = false
        val context = appContext
        if (context != null && isSupported()) {
            runCatching {
                ProxyController.getInstance().clearProxyOverride(ContextCompat.getMainExecutor(context)) {
                    // 清完后本地代理才真正没人用
                    local.stop()
                    AppLog.i(TAG, "代理：已清除")
                }
            }.onFailure { local.stop() }
        } else {
            local.stop()
        }
    }

    /**
     * 应用自己的解析能不能拿到地址。
     *
     * 用 [DohDns] 而不是系统解析：系统解析正是被拦的那条路。离线时它会抛，这里返回 false，
     * 调用方转去走「磁盘缓存」那条老路 —— 那才是离线该有的样子。
     */
    private suspend fun canResolve(host: String): Boolean = withContext(Dispatchers.IO) {
        runCatching { DohDns.lookup(host) }.getOrNull()?.isNotEmpty() == true
    }

    private suspend fun apply(context: Context, port: Int): ApplyResult {
        val executor = ContextCompat.getMainExecutor(context)
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine { continuation ->
                // 规则串的构造也必须在 runCatching 里：规则非法时 `build()` 本身就会抛，
                // 漏在外面就是一个没人接的 IllegalArgumentException。
                runCatching {
                    val config = ProxyConfig.Builder().addProxyRule(proxyRuleFor(port)).build()
                    ProxyController.getInstance().setProxyOverride(config, executor) {
                        if (continuation.isActive) continuation.resume(ApplyResult.Applied)
                    }
                }.onFailure { e ->
                    // 规则非法时就是这里抛 —— 带上类名，别再吞成一句「没起来」
                    if (continuation.isActive) {
                        continuation.resume(ApplyResult.Rejected(e.javaClass.simpleName + " · " + (e.message ?: "无消息")))
                    }
                }
            }
        }
    }

    private sealed interface ApplyResult {
        data object Applied : ApplyResult
        data class Rejected(val reason: String) : ApplyResult
    }
}
