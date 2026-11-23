/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.connection

import java.util.concurrent.TimeUnit

/** 网关在 `/app/zxdesk/` 下可能给出的四种响应（决定界面下一步走哪一屏）。 */
enum class GatewayPage {
    /** 真正的应用页面（HTML）。 */
    APP,

    /** 未登录：200 + 纯文本 `invalid token`。 */
    LOGIN_REQUIRED,

    /**
     * 飞牛网关自己的「访问码」页（网关侧的可选校验，不在本项目里）。
     */
    ACCESS_CODE,

    /** 认不出来（网络错误、非常规响应）：⛔ 别据此拦人，按「继续」处理。 */
    UNKNOWN,
}

/**
 * 网关响应的判定规则。
 *
 */
object GatewayBody {
    private const val INVALID_TOKEN = "invalid token"

    /** 网关「访问码」页的特征词：中英文都认，网关改文案时不至于直接失明。 */
    private val ACCESS_CODE_MARKERS = listOf("访问码", "访问口令", "access code", "accesscode")

    /** 网关对未登录会话的 `/app/zxdesk` 下任意路径：200 + text/plain + 正文 `invalid token`。 */
    fun isInvalidToken(body: String): Boolean {
        val head = body.trim().take(256)
        return head.contains(INVALID_TOKEN, ignoreCase = true) && !head.startsWith("<")
    }

    /** 真正的页面（HTML）才算通过。 */
    fun isPage(body: String): Boolean = body.trimStart().startsWith("<") && !isInvalidToken(body)

    /** 是不是网关的「访问码」页。 */
    fun isAccessCode(body: String): Boolean {
        val head = body.take(20_000).lowercase()
        return ACCESS_CODE_MARKERS.any { head.contains(it) }
    }

    /**
     * 把一段响应正文归类。顺序有讲究：
     * ① `invalid token` 是纯文本，最先判；② 访问码页是 HTML，必须排在 [GatewayPage.APP] 之前；
     */
    fun classify(body: String): GatewayPage = when {
        body.isBlank() -> GatewayPage.UNKNOWN
        isInvalidToken(body) -> GatewayPage.LOGIN_REQUIRED
        isAccessCode(body) -> GatewayPage.ACCESS_CODE
        isPage(body) -> GatewayPage.APP
        else -> GatewayPage.UNKNOWN
    }
}

/**
 * 一次探测的结果。
 *
 */
sealed interface GatewayProbeResult {
    /** 服务端真的回了内容，按正文归类。 */
    data class Page(val page: GatewayPage) : GatewayProbeResult

    /** 连不上：DNS 失败、连接被拒、读写超时。 */
    data object Unreachable : GatewayProbeResult
}

class GatewaySessionProbe(
    private val baseUrl: String,
    private val gatewayPath: String = ConnectionPlanner.DEFAULT_GATEWAY_PATH,
    private val timeoutMs: Int = 5000,
) {
    /** 复用一份客户端：同一台 NAS 的探页会连续发生，连接复用能省掉握手。 */
    private val client by lazy {
        okhttp3.OkHttpClient.Builder()
            .dns(DohDns)
            .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            // 不跟跳转：跳过去的多半是登录页，跟着走会把「未登录」测成「有页面」
            .followRedirects(false)
            .build()
    }

    /** 阻塞调用，⛔ 别在主线程跑。 */
    fun isReady(cookieHeader: String?): Boolean = probe(cookieHeader) == GatewayPage.APP

    /** 拉一次 `/login.html`，看它到底是什么页面（登录后用它判「要不要访问码」）。 */
    fun probe(cookieHeader: String?): GatewayPage = when (val result = probeDetailed(cookieHeader)) {
        is GatewayProbeResult.Page -> result.page
        GatewayProbeResult.Unreachable -> GatewayPage.UNKNOWN
    }

    /**
     * 同 [probe]，但把「连不上」单独报出来。
     *
     */
    fun probeDetailed(cookieHeader: String?): GatewayProbeResult {
        val request = okhttp3.Request.Builder()
            .url("$baseUrl$gatewayPath/login.html")
            .header("Accept", "text/html,application/xhtml+xml")
            .apply { if (!cookieHeader.isNullOrBlank()) header("Cookie", cookieHeader) }
            .get()
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                if (response.code != 200) return GatewayProbeResult.Page(GatewayPage.UNKNOWN)
                GatewayProbeResult.Page(GatewayBody.classify(response.body?.string().orEmpty()))
            }
        } catch (_: Exception) {
            GatewayProbeResult.Unreachable
        }
    }
}
