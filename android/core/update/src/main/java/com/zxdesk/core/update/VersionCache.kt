/*
 * ZXDesk工作台 Android 客户端
 * 文件：VersionCache.kt
 * 职责：帮助页版本表的落盘格式（编解码，纯函数，可单测）
 */

package com.zxdesk.core.update

/**
 * 帮助页「各端与更新」的本地缓存格式。
 *
 * 串形如：
 * ```
 * fnos=0.9.7,审核中;0.9.6,已上线|windows=0.2.3,已上线
 * ```
 * - `|` 分端，`=` 分键值，`;` 分「最新」与「上一版」，`,` 分版本号与状态；
 * - 这五个字符都不会出现在版本号或状态文案里（状态是 2~4 个汉字），所以不上 JSON ——
 *   少一个解析器，也就少一处能崩的地方。
 *
 * ⚠️ 必须兼容 0.2.17 及以前写的 `fnos=0.9.6`（没有状态、没有上一版）：
 *    解码成「状态未知、无上一版」，⛔ 不能整条丢掉 —— 那会让刚升级上来的用户
 *    看到一排「—」，像是检查失败了。
 */
object VersionCache {

    fun decode(raw: String): Map<String, PlatformRelease> =
        raw.split('|').mapNotNull { part ->
            val at = part.indexOf('=')
            if (at <= 0 || at == part.lastIndex) return@mapNotNull null
            val key = part.substring(0, at)
            // 先按 `;` 把「最新」与「上一版」分开，再各自按 `,` 切
            val body = part.substring(at + 1)
            val semi = body.indexOf(';')
            val selfText = if (semi < 0) body else body.substring(0, semi)
            val prevText = if (semi < 0) "" else body.substring(semi + 1)

            val self = parsePair(selfText) ?: return@mapNotNull null
            if (self.first.isBlank()) return@mapNotNull null
            val previous = parsePair(prevText)?.takeIf { it.first.isNotBlank() }?.let { (v, s) ->
                PreviousRelease(v, s)
            }
            key to PlatformRelease(self.first, self.second, previous)
        }.toMap()

    fun encode(versions: Map<String, PlatformRelease>): String =
        versions.entries.joinToString("|") { (key, release) ->
            buildString {
                append(key).append('=').append(release.version).append(',').append(release.status)
                val prev = release.previous
                if (prev != null) append(';').append(prev.version).append(',').append(prev.status)
            }
        }

    /** `0.9.7,审核中` → `("0.9.7", "审核中")`；没有逗号时状态为空。 */
    private fun parsePair(text: String): Pair<String, String>? {
        if (text.isBlank()) return null
        val comma = text.indexOf(',')
        return if (comma < 0) {
            text.trim() to ""
        } else {
            text.substring(0, comma).trim() to text.substring(comma + 1).trim()
        }
    }
}
