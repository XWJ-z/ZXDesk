/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.update

/**
 * 帮助页「各端与更新」的本地缓存格式。
 *
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
