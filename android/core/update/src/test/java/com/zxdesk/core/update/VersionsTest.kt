package com.zxdesk.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 版本比较的判据。
 *
 * 核心用例是 `0.2.9 → 0.2.13`：字符串序会把它判成「已是最新」，
 * 这是这个类存在的唯一理由。
 */
class VersionsTest {

    /** 比较结果不可比时直接判失败 —— ⛔ 不要拿 0 兜底（0 表示「一样」，会把错判成正常）。 */
    private fun cmp(left: String?, right: String?): Int =
        Versions.compare(left, right) ?: throw AssertionError("无法比较：$left vs $right")

    @Test
    fun `逐段按数字比，字符串序不算数`() {
        assertEquals(1, cmp("0.2.13", "0.2.9"))
        assertEquals(-1, cmp("0.2.9", "0.2.13"))
        assertTrue(Versions.isNewer("0.2.13", "0.2.9"))
        assertFalse(Versions.isNewer("0.2.9", "0.2.13"))
    }

    @Test
    fun `缺位补零`() {
        assertEquals(0, cmp("1.2", "1.2.0"))
        assertEquals(1, cmp("1.2.1", "1.2"))
        assertEquals(0, cmp("v1.2.3", "1.2.3"))
    }

    @Test
    fun `正式版高于同号预发布`() {
        assertEquals(1, cmp("1.2.3", "1.2.3-beta.2"))
        assertEquals(-1, cmp("1.2.3-beta.2", "1.2.3"))
        assertEquals(1, cmp("1.2.3-beta.10", "1.2.3-beta.9"))
        assertEquals(-1, cmp("1.2.3-beta.2", "1.2.3-beta.10"))
    }

    @Test
    fun `无法解析时返回 null，不当成零`() {
        assertNull(Versions.compare("abc", "1.0.0"))
        assertNull(Versions.compare("1.0.0", ""))
        assertNull(Versions.compare(null, "1.0.0"))
        assertFalse(Versions.isNewer("abc", "1.0.0"))
        assertFalse(Versions.isValid("1.2.3.4"))
    }

    @Test
    fun `解析结果带预发布段`() {
        val parsed = Versions.parse("v0.2.13-rc.1")
        assertEquals(listOf(0, 2, 13), parsed?.nums)
        assertEquals(listOf("rc", "1"), parsed?.pre)
    }

    @Test
    fun `首尾空白可以容忍`() {
        assertTrue(Versions.isValid("  0.2.13  "))
        assertEquals(0, cmp(" 0.2.13 ", "0.2.13"))
    }
}
