/*
 * ZXDesk工作台 Android 客户端
 * 文件：Notice.kt
 * 职责：服务端公告（app_notice / app_notice_marquee）的模型、解析与拉取
 */

package com.zxdesk.core.update

import com.zxdesk.core.connection.MiniJson
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * 一条公告（对应服务端 `app_notice` 表的一行）。
 *
 * [id] 是**业务 id**（表里的 `notice_id`，形如 `20261028-android-001`）：
 * 客户端拿它记「这条我读过了」，所以它发出后不能改 —— 改了等于同一条公告又弹一次。
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
 * [marquee] 与 [notices] 是**两张表**：前者是长期挂着的横幅（`app_notice_marquee`），
 * 不参与已读；后者是公告列表（`app_notice`），有条目级的已读。
 */
data class NoticeBundle(
    val marquee: String = "",
    val notices: List<Notice> = emptyList(),
    /**
     * 响应里**根本没有 `marquee` 这个键** —— 说明服务端跑的还是旧版 `server.js`
     * （`readMarquee` 那批没部署上去）。
     *
     * 只用于日志：界面上就是「没有跑马灯」，⛔ 不弹错误 —— 公告列表本身是好的，
     * 不该因为少一条横幅就让用户看到报错。真机核对见 `test-contract.js` 的三条 marquee 断言。
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
 * 与版本清单不同，公告的**空结果是正常状态**（服务端也可能回 200 + 空数组），
 * 所以这里不把「没有公告」当失败 —— 界面上就是「暂无公告」。
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
     * ⚠️ **没有 id 的公告直接丢掉**：已读是按 id 记的，没 id 就永远弹不完。
     * 服务端 `toNoticeDto` 里 `id` 取自 `notice_id`，正常不会为空；为空说明那条数据没录好。
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
 * 与版本接口同一个域、同一套 https 规则；差别只在没有 channel 参数 ——
 * 公告是全网一份，不分稳定 / 测试通道。
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
