/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.update

import com.zxdesk.core.connection.MiniJson

/**
 * 帮助页「各端与更新」的一行：接口键、显示名、去哪更新的一句话。
 *
 */
data class VersionPlatform(val key: String, val label: String, val note: String)

/** 顺序即页面从上到下的顺序，与 `Project/server/update-api` 的口径一致。 */
val VERSION_PLATFORMS: List<VersionPlatform> = listOf(
    VersionPlatform("fnos", "飞牛 fnOS", "应用中心搜「ZXDesk 工作台」，或官网下载最新体验包"),
    VersionPlatform("windows", "Windows", "官网下载安装包"),
    VersionPlatform("android", "安卓", "抽屉「检查更新」，或官网下载"),
    VersionPlatform("edge", "Edge 扩展", "官网下载安装包"),
)

/**
 * 接口里「可能出现、但不保证有」的端。
 *
 */
val OPTIONAL_PLATFORMS: List<String> = listOf("harmonyos")

/**
 * 上一版的摘要（只有版本号与状态，没有 hash / 下载地址 —— 那些只属于最新版）。
 *
 */
data class PreviousRelease(val version: String, val status: String)

/** 某一个端的查询结果：版本号 ＋ 状态文案（状态可能为空 = 服务端没配）＋ 上一版摘要。 */
data class PlatformRelease(
    val version: String,
    val status: String,
    val previous: PreviousRelease? = null,
)

/** 拉取结果：成功给 `key → 版本与状态`；失败给一句人话。 */
sealed interface AllVersionsResult {
    data class Ok(val versions: Map<String, PlatformRelease>) : AllVersionsResult
    data class Failed(val message: String) : AllVersionsResult
}

/**
 * `GET /api/version`（不带平台）的解析。
 *
 */
object AllVersionsContract {

    fun parse(payload: String): AllVersionsResult {
        val root = try {
            MiniJson.parse(payload) as? Map<*, *>
        } catch (e: Exception) {
            null
        } ?: return AllVersionsResult.Failed("响应不是合法 JSON")

        if (root["ok"] != true) {
            val message = (root["message"] as? String)?.takeIf { it.isNotBlank() }
            return AllVersionsResult.Failed(message ?: "接口返回失败")
        }
        val data = root["data"] as? Map<*, *> ?: return AllVersionsResult.Failed("响应缺 data")

        val versions = buildMap {
            (VERSION_PLATFORMS.map { it.key } + OPTIONAL_PLATFORMS).forEach { key ->
                val row = data[key] as? Map<*, *> ?: return@forEach
                val version = (row["version"] as? String)?.trim().orEmpty()
                if (version.isEmpty()) return@forEach
                // 状态是可选的：老服务端没有这一列时是空串，页面据此不显示徽章
                val status = (row["status"] as? String)?.trim().orEmpty()
                put(key, PlatformRelease(version, status, previousOf(row["previous"])))
            }
        }
        if (versions.isEmpty()) return AllVersionsResult.Failed("更新服务器上还没有发布记录")
        return AllVersionsResult.Ok(versions)
    }

    /**
     * `previous` → [PreviousRelease]。缺字段 / 不是对象 / 版本号为空，一律当「没有上一版」。
     *
     */
    private fun previousOf(raw: Any?): PreviousRelease? {
        val row = raw as? Map<*, *> ?: return null
        val version = (row["version"] as? String)?.trim().orEmpty()
        if (version.isEmpty()) return null
        return PreviousRelease(version, (row["status"] as? String)?.trim().orEmpty())
    }
}
