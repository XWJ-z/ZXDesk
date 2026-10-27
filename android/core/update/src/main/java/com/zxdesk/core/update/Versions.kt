package com.zxdesk.core.update

/**
 * 版本号的解析与比较（纯函数，不依赖网络与 Android）。
 *
 * ⚠️ 不能用字符串比较：`0.2.9` 的字典序排在 `0.2.13` 之后，用它判断「有没有新版」
 * 会把旧版当新版提示。必须逐段按数字比。
 *
 * 支持 `1.2.3`、`v1.2.3`、`1.2`（缺位补 0）、`1.2.3-beta.2`（预发布小于同号正式版）。
 * 解析失败返回 null、比较返回 null —— 调用方自己决定「不可比」时怎么办，
 * ⛔ 不要把它当成 0（当成 0 会得出「两个版本一样」的错误结论）。
 */
data class ParsedVersion(
    /** 主版本三段，缺位补 0。 */
    val nums: List<Int>,
    /** 预发布段；空 = 正式版。 */
    val pre: List<String>,
)

object Versions {

    private val VERSION_RE = Regex(
        "^v?(\\d{1,6})(?:\\.(\\d{1,6}))?(?:\\.(\\d{1,6}))?(?:-([0-9A-Za-z]{1,16}(?:\\.[0-9A-Za-z]{1,16})*))?$",
    )

    fun parse(value: String?): ParsedVersion? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        val match = VERSION_RE.matchEntire(text) ?: return null
        val groups = match.groupValues
        val nums = listOf(
            groups[1].toInt(),
            groups[2].ifEmpty { "0" }.toInt(),
            groups[3].ifEmpty { "0" }.toInt(),
        )
        val pre = if (groups[4].isEmpty()) emptyList() else groups[4].split('.')
        return ParsedVersion(nums, pre)
    }

    /** 左小右 -1、相等 0、左大右 1；任一侧无法解析返回 null。 */
    fun compare(left: String?, right: String?): Int? {
        val a = parse(left) ?: return null
        val b = parse(right) ?: return null

        for (i in 0..2) {
            if (a.nums[i] != b.nums[i]) return if (a.nums[i] > b.nums[i]) 1 else -1
        }

        // 正式版高于同号预发布：1.2.3 > 1.2.3-beta.1
        if (a.pre.isEmpty() && b.pre.isEmpty()) return 0
        if (a.pre.isEmpty()) return 1
        if (b.pre.isEmpty()) return -1

        val length = minOf(a.pre.size, b.pre.size)
        for (i in 0 until length) {
            val x = a.pre[i]
            val y = b.pre[i]
            val xNum = x.all { it.isDigit() }
            val yNum = y.all { it.isDigit() }
            if (xNum && yNum) {
                val diff = x.toLong() - y.toLong()
                if (diff != 0L) return if (diff > 0) 1 else -1
                continue
            }
            // 数字标识小于字母标识（semver 规则）
            if (xNum != yNum) return if (xNum) -1 else 1
            if (x != y) return if (x > y) 1 else -1
        }
        if (a.pre.size == b.pre.size) return 0
        return if (a.pre.size > b.pre.size) 1 else -1
    }

    /** `candidate` 是否比 `current` 新。任一侧无法解析时一律 false（宁可漏提示，不提示错）。 */
    fun isNewer(candidate: String?, current: String?): Boolean = compare(candidate, current) == 1

    fun isValid(value: String?): Boolean = parse(value) != null
}
