package com.zxdesk.core.connection

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** FNID 查询结果（字段对应 `POST /api/v1/fn/con` 的 `data`）。 */
data class FnIdAddresses(
    val lanIpv4: List<String> = emptyList(),
    val lanIpv6: List<String> = emptyList(),
    val publicIpv4: List<String> = emptyList(),
    val publicIpv6: List<String> = emptyList(),
    /** 中继主机，已去掉端口。实测形如 `<fnid>.fnos.net`（⛔ 不是 5ddd.com）。 */
    val relay: List<String> = emptyList(),
    val httpPort: Int = DEFAULT_HTTP_PORT,
    val httpsPort: Int = DEFAULT_HTTPS_PORT,
) {
    val relayHost: String? get() = relay.firstOrNull()
}

/** 实测值：FNID 的 `port` 返回 64999/64888，社区文档里的 5666/5667 在本机不通。 */
const val DEFAULT_HTTPS_PORT = 64999
const val DEFAULT_HTTP_PORT = 64888

interface FnIdResolver {
    suspend fun resolve(fnId: String): FnIdAddresses
}

/** 解析失败。[message] 会原样显示在登录页/错误页，所以写成用户读得懂的话。 */
open class FnIdException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** FNID 不存在 / 已解绑：重试没有意义，⛔ 不要走备用接口再问一遍。 */
class FnIdNotFoundException(message: String) : FnIdException(message)

/**
 * 真解析：`POST https://5ddd.com/api/v1/fn/con`（备用 `fnos.net`）。
 * 用 `HttpURLConnection`，不引 OkHttp —— 一次 POST、无连接复用需求。
 */
class HttpFnIdResolver(
    private val endpoints: List<String> = listOf(PRIMARY_ENDPOINT, FALLBACK_ENDPOINT),
    private val timeoutMs: Int = 8000,
) : FnIdResolver {

    override suspend fun resolve(fnId: String): FnIdAddresses = withContext(Dispatchers.IO) {
        var lastError: Throwable? = null
        for (endpoint in endpoints) {
            try {
                return@withContext query(endpoint, fnId)
            } catch (e: FnIdNotFoundException) {
                throw e
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw FnIdException(
            "连不上 FNID 服务器，请检查网络后重试" + (lastError?.message?.let { "（$it）" } ?: ""),
            lastError,
        )
    }

    private fun query(endpoint: String, fnId: String): FnIdAddresses {
        val body = "{\"fnId\":\"$fnId\"}"
        val timestamp = System.currentTimeMillis()
        val nonce = (1_000_000 + (Math.random() * 9_000_000).toLong()).toString()
        val connection = (java.net.URL(endpoint + FnIdSigner.CONNECT_PATH).openConnection()
            as java.net.HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("authx", FnIdSigner.authx(timestamp, nonce, body))
            setRequestProperty("fn-sign", FnIdSigner.fnSign(fnId, timestamp))
            setRequestProperty("User-Agent", USER_AGENT)
        }
        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes().toString(Charsets.UTF_8) }
                .orEmpty()
            if (status !in 200..299) throw FnIdException("FNID 服务器返回 HTTP $status")
            return when (val parsed = FnIdResponse.parse(text)) {
                is FnIdResponse.Ok -> parsed.addresses
                is FnIdResponse.NotFound -> throw FnIdNotFoundException(
                    "找不到这个 FNID（${parsed.message.ifBlank { "code=${parsed.code}" }}）",
                )
                is FnIdResponse.Bad -> throw FnIdException(parsed.reason)
            }
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val PRIMARY_ENDPOINT = "https://5ddd.com"
        const val FALLBACK_ENDPOINT = "https://fnos.net"
        private const val USER_AGENT = "okhttp/4.12.0"
    }
}
