package com.zxdesk.core.update

import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/** 拉取版本清单的结果。 */
sealed interface FetchResult {
    data class Ok(val manifest: UpdateManifest) : FetchResult

    /** 404 = 该端还没有发布记录。它和「已是最新」在界面上是同一个结论，不算错误。 */
    data object NotPublished : FetchResult

    data class Failed(val kind: Kind, val message: String) : FetchResult {
        enum class Kind {
            /** 地址不是 https（本机回环除外）。 */
            INSECURE,

            /** 非 2xx（404 已单独处理）。 */
            HTTP,
            NETWORK,
            TIMEOUT,

            /** 响应能拿到但内容不合格（缺 hash / 平台不符 / 不是 JSON）。 */
            INVALID,
        }
    }
}

/**
 * 版本接口客户端：拉 `/api/version/android` 并交给 [UpdateContract] 校验。
 *
 * 失败分两类，处理方式不同：
 * - 「还没有发布记录 / 网络不通 / 接口 5xx」→ 安静收场（客户端不能因为更新服务挂了就打不开）；
 * - 「响应内容不合格」→ 记下来但不打扰用户，界面上仍是「检查失败」。
 */
class UpdateClient(
    private val http: OkHttpClient = defaultHttpClient(),
    private val timeoutMs: Long = 8_000,
) {

    fun fetchLatest(apiUrl: String): FetchResult {
        val checked = UpdateUrls.check(apiUrl)
        if (checked !is UrlCheck.Ok) {
            val reason = (checked as UrlCheck.Failed).reason
            return FetchResult.Failed(FetchResult.Failed.Kind.INSECURE, reason)
        }

        val request = Request.Builder()
            .url(checked.uri.toString())
            .header("accept", "application/json")
            .get()
            .build()
        val call = http.newCall(request)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)

        return try {
            call.execute().use { response ->
                when {
                    response.code == 404 -> FetchResult.NotPublished
                    !response.isSuccessful ->
                        FetchResult.Failed(FetchResult.Failed.Kind.HTTP, "HTTP ${response.code}")
                    else -> {
                        val body = response.body?.string()
                        if (body.isNullOrBlank()) {
                            FetchResult.Failed(FetchResult.Failed.Kind.INVALID, "响应为空")
                        } else {
                            when (val parsed = UpdateContract.parse(body)) {
                                is ManifestResult.Ok -> FetchResult.Ok(parsed.manifest)
                                is ManifestResult.Invalid ->
                                    FetchResult.Failed(FetchResult.Failed.Kind.INVALID, parsed.reason)
                            }
                        }
                    }
                }
            }
        } catch (e: SocketTimeoutException) {
            FetchResult.Failed(FetchResult.Failed.Kind.TIMEOUT, "请求超时（$timeoutMs 毫秒）")
        } catch (e: InterruptedIOException) {
            // OkHttp 的 call 超时与线程中断都归到这里：区分「超时」与「取消」看 call 状态
            if (call.isCanceled()) {
                FetchResult.Failed(FetchResult.Failed.Kind.NETWORK, "请求已取消")
            } else {
                FetchResult.Failed(FetchResult.Failed.Kind.TIMEOUT, "请求超时（$timeoutMs 毫秒）")
            }
        } catch (e: Exception) {
            FetchResult.Failed(FetchResult.Failed.Kind.NETWORK, e.message ?: e.toString())
        }
    }

    companion object {

        /**
         * 更新链路共用的 HTTP 客户端。
         *
         * ⚠️ 不设整体 call 超时，改由每次调用用 `call.timeout()` 定 —— 版本接口 8 秒，
         * 下载安装包要给足时间（十兆级文件在慢网下远超 10 秒）。
         */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }
}
