/*
 * ZXDesk工作台 Android 客户端
 * 文件：AllVersions.kt
 * 职责：各端最新版本（含状态）的解析 —— 一次请求拿全，供帮助页展示
 */

package com.zxdesk.core.update

import com.zxdesk.core.connection.MiniJson

/**
 * 帮助页「各端与更新」的一行：接口键、显示名、去哪更新的一句话。
 *
 * ⚠️ 只列**接口里真有**的四端（`GET /api/version` 的 `data`）。
 *
 * ⭐ 2026-11-03 起**状态不再写死在这里**：`已上线 / 审核中 / 可用` 由 `app_version.status`
 *    随接口下发（[PlatformRelease.status]）。以前写死在客户端，飞牛过审、Edge 上架都得改代码发版；
 *    现在库里改一行就全网生效。⛔ 不要为了「有个兜底」在这里再写一份默认状态 ——
 *    服务端没给就不显示徽章，比显示一个过期的假状态好。
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
 * 鸿蒙现在不在服务端 `PLATFORMS` 白名单里（那个常量只有四端），所以正常情况下拿不到；
 * 一旦线上把 `harmonyos` 加进 `app_version` 与白名单，客户端**这次不用改**就能显示它的版本与状态。
 * 拿不到时页面保持「— / 规划中」，⛔ 不编版本号。
 */
val OPTIONAL_PLATFORMS: List<String> = listOf("harmonyos")

/**
 * 上一版的摘要（只有版本号与状态，没有 hash / 下载地址 —— 那些只属于最新版）。
 *
 * 为什么需要它：一个端可能**同时存在两个不同状态的版本**。
 * 典型两种：
 * ① 0.9.7 刚发 GitHub、应用中心还在审，0.9.6 早就上架 —— 只显示「0.9.7 审核中」，
 *    用户看不出「现在到底能装哪个」；
 * ② 0.9.6 已上线、0.9.7 审核中 —— 同上。
 * 所以最新版状态**不是可用**时，帮助页会在下面补一行「上一版 0.9.6 · 已上线」。
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
 * 与 [`UpdateContract`] 的区别：那个要的是**本端**的完整清单（hash / 下载地址，缺一不可），
 * 这个只挑 `version` 与 `status` —— 帮助页只展示这两样，拿不到 hash 也不该整页作废。
 *
 * ⚠️ 仍然是**严格**的：`ok != true`、缺 `data`、四端一个版本都没有 ⇒ 全部算失败，
 * ⛔ 不拿「—」冒充「已是最新」。
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
     * ⚠️ 这里**不比版本号新旧**：服务端已按 `published_at` 取过，
     *    客户端再比一次只可能得出相反结论，然后把服务端的口径悄悄改掉。
     */
    private fun previousOf(raw: Any?): PreviousRelease? {
        val row = raw as? Map<*, *> ?: return null
        val version = (row["version"] as? String)?.trim().orEmpty()
        if (version.isEmpty()) return null
        return PreviousRelease(version, (row["status"] as? String)?.trim().orEmpty())
    }
}
