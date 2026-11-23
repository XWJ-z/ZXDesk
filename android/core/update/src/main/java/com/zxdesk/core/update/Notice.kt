/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.update

import com.zxdesk.core.connection.MiniJson
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * 一条公告（对应服务端 `app_notice` 表的一行）。
 *
 */
data class Notice(
    val id: String,
    val title: String,
    val content: String,
    /** 重要公告：列表里给红边、标题加粗。 */
    val important: Boolean,
    /** 置顶：排在列表最前（服务端已经排好，客户端不再重排）。 */
    val pinned: Boolean,
    val publishedAt: String?,
)

/**
 * 一次公告查询的完整结果。
 *
 */
data class NoticeBundle(
    val marquee: String = "",
    val notices: List<Notice> = emptyList(),
    /**
     * 响应里**根本没有 `marquee` 这个键** —— 说明服务端跑的还是旧版 `server.js`
     * （`readMarquee` 那批没部署上去）。
     */
    val marqueeMissing: Boolean = false,
) {
    val isEmpty: Boolean get() = marquee.isBlank() && notices.isEmpty()
}

sealed interface NoticeResult {
    /** [raw] 是响应原文：调用方要把它整段落盘，冷启动时用同一套解析读回来。 */
    data class Ok(val bundle: NoticeBundle, val raw: String) : NoticeResult

    data class Failed(val message: String) : NoticeResult
}

/**
 * `GET /api/notices/:platform` 的响应解析。
 *
 */
object NoticeContract {

    const val PLATFORM = "android"

    fun parse(payload: String): NoticeResult {
        val root = runCatching { MiniJson.parse(payload) as? Map<*, *> }.getOrNull()
            ?: return NoticeResult.Failed("响应不是合法 JSON")
        if (root["ok"] != true) {
            val message = (root["message"] as? String)?.takeIf { it.isNotBlank() } ?: "未说明原因"
            return NoticeResult.Failed("接口返回失败：$message")
        }
        val rows = root["data"] as? List<*> ?: return NoticeResult.Failed("响应缺 data")
        val notices = rows.mapNotNull { toNotice(it) }
        val hasMarqueeKey = root.containsKey("marquee")
        val marquee = (root["marquee"] as? String)?.trim().orEmpty()
        return NoticeResult.Ok(
            NoticeBundle(marquee = marquee, notices = notices, marqueeMissing = !hasMarqueeKey),
            payload,
        )
    }

    /**
     * 单条转换。
     *
     */
    private fun toNotice(node: Any?): Notice? {
        val map = node as? Map<*, *> ?: return null
        val id = (map["id"] as? String)?.trim().orEmpty()
        if (id.isEmpty()) return null
        val title = (map["title"] as? String)?.trim().orEmpty().ifEmpty { "公告" }
        return Notice(
            id = id,
            title = title,
            content = (map["content"] as? String)?.trim().orEmpty(),
            important = (map["level"] as? String) == "important",
            pinned = map["pinned"] == true,
            publishedAt = (map["publishedAt"] as? String)?.takeIf { it.isNotBlank() },
        )
    }
}

/**
 * 公告客户端。
 *
 */
class NoticeClient(
    private val http: OkHttpClient = defaultHttpClient(),
    private val timeoutMs: Long = 8_000,
) {

    fun fetch(apiUrl: String): NoticeResult {
        val checked = UpdateUrls.check(apiUrl)
        if (checked !is UrlCheck.Ok) {
            val reason = (checked as UrlCheck.Failed).reason
            return NoticeResult.Failed("公告地址不可用：$reason")
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
                val body = response.body?.string()
                when {
                    !response.isSuccessful -> NoticeResult.Failed("HTTP ${response.code}")
                    body.isNullOrBlank() -> NoticeResult.Failed("响应为空")
                    else -> NoticeContract.parse(body)
                }
            }
        } catch (e: Exception) {
            NoticeResult.Failed(e.message ?: "网络请求失败")
        }
    }

    companion object {
        /** 与更新链路共用一套超时口径：8 秒拿不到就当失败，别拖着抽屉。 */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }
}
