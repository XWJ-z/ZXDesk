/*
 * ZXDesk工作台 Android 客户端
 * 文件：GatewayProbe.kt
 * 职责：网关响应的判定，按正文区分应用页、访问码页与未登录
 */

package com.zxdesk.core.connection

/** 网关在 `/app/zxdesk/` 下可能给出的四种响应（决定界面下一步走哪一屏）。 */
enum class GatewayPage {
    /** 真正的应用页面（HTML）。 */
    APP,

    /** 未登录：200 + 纯文本 `invalid token`。 */
    LOGIN_REQUIRED,

    /**
     * 飞牛网关自己的「访问码」页（网关侧的可选校验，不在本项目里）。
     * ⚠️ 这一页也是 HTML，所以必须**先**判它、再判 [APP]，否则会被当成应用页直接进去（然后白屏）。
     */
    ACCESS_CODE,

    /** 认不出来（网络错误、非常规响应）：⛔ 别据此拦人，按「继续」处理。 */
    UNKNOWN,
}

/**
 * 网关响应的判定规则。
 *
 * 为什么不用「轮询 Cookie 里有没有 `Trim-MC-token`」当唯一判据：
 * 那个 cookie 名属于网关既有约定，**没法在本机真登录验证**；
 * 名字一旦不对，就会一直等到超时。这里改成直接问服务端：
 * 原生 GET `<base>/app/zxdesk/login.html`（带 WebView 的 Cookie），以正文为准。
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
     * ③ 剩下的 HTML 才算应用页。
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
 * 为什么要比 [GatewayPage] 多一档：`probe()` 把网络异常也归进 [GatewayPage.UNKNOWN]，
 * 而「回前台重连」必须分得开两件事 ——
 * **网络不通**（等它恢复就行，⛔ 不能把人踢回登录页）与**会话失效**（要换 token 或重登）。
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
     * ⚠️ 只有**建立连接 / 读响应**抛异常才算 [GatewayProbeResult.Unreachable]；
     * 服务端给了非 200 或认不出的正文仍算 [GatewayProbeResult.Page]，那是服务端在说话，不是网络断。
     */
    fun probeDetailed(cookieHeader: String?): GatewayProbeResult {
        val connection = try {
            (java.net.URL("$baseUrl$gatewayPath/login.html").openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                setRequestProperty("Accept", "text/html,application/xhtml+xml")
                if (!cookieHeader.isNullOrBlank()) setRequestProperty("Cookie", cookieHeader)
            }
        } catch (_: Exception) {
            return GatewayProbeResult.Unreachable
        }
        return try {
            if (connection.responseCode != 200) return GatewayProbeResult.Page(GatewayPage.UNKNOWN)
            val body = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            GatewayProbeResult.Page(GatewayBody.classify(body))
        } catch (_: Exception) {
            GatewayProbeResult.Unreachable
        } finally {
            connection.disconnect()
        }
    }
}
