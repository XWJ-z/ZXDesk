package com.zxdesk.core.update

import com.zxdesk.core.connection.MiniJson

/**
 * 版本清单（服务端 `/api/version/android` 的 `data` 段）。
 *
 * 契约见 `Project/server/update-api/README.md`：字段名是 camelCase，`hash` 是 APK 的 SHA256（小写 hex），
 * `versionCode` 只有 Android 端才有。
 */
data class UpdateManifest(
    val platform: String,
    val channel: String,
    val version: String,
    /** Android 的 versionCode；服务端没给时为 null（此时只能比 versionName）。 */
    val versionCode: Long?,
    val hash: String,
    val fileName: String,
    val fileSize: Long,
    val downloadUrls: List<String>,
    /** 网盘兜底地址；空串 = 没配，界面不显示手动更新入口。 */
    val fallbackUrl: String,
    val notes: String,
    val force: Boolean,
    val minVersion: String,
    val publishedAt: String,
)

sealed interface ManifestResult {
    data class Ok(val manifest: UpdateManifest) : ManifestResult
    data class Invalid(val reason: String) : ManifestResult
}

/**
 * 把接口响应校验成固定形状。
 *
 * 任何一项不合格都**整份拒收** —— 半份数据比没有数据更危险：
 * 例如缺 hash 时若「宽容地」继续下载，就等于关掉了完整性校验。
 */
object UpdateContract {

    const val PLATFORM = "android"

    /** 缺 SHA256 的清单一律拒收：没有 hash 的包无法证明「下下来的就是发布的那份」。 */
    private val HASH_RE = Regex("^[0-9a-f]{64}$")

    fun parse(payload: String, platform: String = PLATFORM): ManifestResult {
        val root = try {
            MiniJson.parse(payload) as? Map<*, *>
        } catch (e: Exception) {
            return ManifestResult.Invalid("响应不是合法 JSON")
        } ?: return ManifestResult.Invalid("响应不是对象")

        if (root["ok"] != true) {
            val message = (root["message"] as? String)?.takeIf { it.isNotBlank() } ?: "未说明原因"
            return ManifestResult.Invalid("接口返回失败：$message")
        }
        val data = root["data"] as? Map<*, *> ?: return ManifestResult.Invalid("响应缺 data")

        val actualPlatform = data.str("platform")
        if (actualPlatform != platform) {
            return ManifestResult.Invalid("平台不匹配（期望 $platform，收到 $actualPlatform）")
        }

        val version = data.str("version")
        if (!Versions.isValid(version)) return ManifestResult.Invalid("版本号无法解析：$version")

        val hash = data.str("hash").lowercase()
        if (!HASH_RE.matches(hash)) return ManifestResult.Invalid("缺 SHA256 或格式不对")

        val fileName = data.str("fileName")
        if (fileName.isEmpty()) return ManifestResult.Invalid("缺安装包文件名")

        val fileSize = MiniJson.anyToLong(data["fileSize"]) ?: 0L
        if (fileSize < 0) return ManifestResult.Invalid("文件大小不合法：${data["fileSize"]}")

        // 网盘兜底：客户端连续下载失败后引导手动更新。⛔ 只放行 http(s)，其它一律当没配
        val fallbackUrl = data.str("fallbackUrl").takeIf { it.startsWith("http://") || it.startsWith("https://") }.orEmpty()

        val rawUrls = (data["downloadUrls"] as? List<*>)?.map { it?.toString()?.trim().orEmpty() }.orEmpty()
        val downloadUrls = rawUrls.filter { it.isNotEmpty() && UpdateUrls.check(it) is UrlCheck.Ok }
        if (downloadUrls.isEmpty()) return ManifestResult.Invalid("没有可用的 https 下载地址")

        val versionCode = MiniJson.anyToLong(data["versionCode"])?.takeIf { it > 0 }

        return ManifestResult.Ok(
            UpdateManifest(
                platform = actualPlatform,
                channel = data.str("channel"),
                version = version,
                versionCode = versionCode,
                hash = hash,
                fileName = fileName,
                fileSize = fileSize,
                downloadUrls = downloadUrls,
                fallbackUrl = fallbackUrl,
                notes = data.str("releaseNotes"),
                force = data["force"] == true,
                minVersion = data.str("minVersion"),
                publishedAt = data.str("publishedAt"),
            ),
        )
    }

    private fun Map<*, *>.str(key: String): String = (this[key] as? String)?.trim().orEmpty()
}

/**
 * 「要不要更新」的判据（纯函数，有单测）。
 *
 * 单独拿出来是因为它是整个更新链路上的**唯一业务决定**：判错一次要么天天骚扰用户，
 * 要么明明有新版本却提示「已是最新」。界面与网络都不该各写一份。
 */
object UpdateRules {

    /**
     * 清单是否比本机版本新。
     *
     * `versionCode` 比 `versionName` 可靠（`0.2.9` 与 `0.2.13` 按字符串排会倒过来），
     * 两者都给时**任一判新即可**；服务端没给 `versionCode` 时只看 `versionName`。
     * ⚠️ 本机比清单新（或一样）时一律 false —— 不提示降级。
     */
    fun isNewerThan(manifest: UpdateManifest, currentVersion: String, currentCode: Long): Boolean {
        val byCode = manifest.versionCode != null && manifest.versionCode > currentCode
        val byName = Versions.isNewer(manifest.version, currentVersion)
        return byCode || byName
    }

    /**
     * 是否必须更新：服务端点名 `force`，或本机版本低于清单里的最低支持版本。
     * 只在「确实有新版」时才谈强制 —— 否则用户在最新版上会被一个无意义的红字拦住。
     */
    fun requiresUpdate(manifest: UpdateManifest, currentVersion: String, currentCode: Long): Boolean {
        if (!isNewerThan(manifest, currentVersion, currentCode)) return false
        if (manifest.force) return true
        if (!Versions.isValid(manifest.minVersion)) return false
        return Versions.isNewer(manifest.minVersion, currentVersion)
    }
}
