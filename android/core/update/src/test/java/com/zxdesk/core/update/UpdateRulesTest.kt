package com.zxdesk.core.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「要不要更新」的判据。
 *
 * 最容易错的两处：① 本机已经比清单新时不能提示「更新」（否则等于引导降级）；
 * ② `force` 只在确实有新版时才谈强制，否则最新版用户会被拦住。
 */
class UpdateRulesTest {

    private fun manifest(
        version: String,
        code: Long? = null,
        force: Boolean = false,
        minVersion: String = "",
    ): UpdateManifest = UpdateManifest(
        platform = "android",
        channel = "stable",
        version = version,
        versionCode = code,
        hash = "a".repeat(64),
        fileName = "zxdesk-android-$version-debug.apk",
        fileSize = 1_000,
        downloadUrls = listOf("https://example.com/app.apk"),
        fallbackUrl = "",
        notes = "",
        force = force,
        minVersion = minVersion,
        publishedAt = "",
    )

    @Test
    fun `清单版本更高就是有新版`() {
        assertTrue(UpdateRules.isNewerThan(manifest("0.2.13", 15), "0.2.11", 13))
        assertTrue(UpdateRules.isNewerThan(manifest("0.3.0"), "0.2.13", 15))
    }

    @Test
    fun `同版本与旧清单都不算有新版`() {
        assertFalse(UpdateRules.isNewerThan(manifest("0.2.13", 15), "0.2.13", 15))
        // ⛔ 本机比清单新时也不能提示：否则就是引导用户降级
        assertFalse(UpdateRules.isNewerThan(manifest("0.2.11", 13), "0.2.13", 15))
    }

    @Test
    fun `版本号相同但 versionCode 更大也算新`() {
        assertTrue(UpdateRules.isNewerThan(manifest("0.2.13", 16), "0.2.13", 15))
    }

    @Test
    fun `只有 versionName 时按名字判`() {
        assertTrue(UpdateRules.isNewerThan(manifest("0.2.14"), "0.2.13", 15))
        assertFalse(UpdateRules.isNewerThan(manifest("0.2.13"), "0.2.13", 15))
        // 0.2.9 的字符串序在 0.2.13 之后，按字符串比会得出「有新版」
        assertFalse(UpdateRules.isNewerThan(manifest("0.2.9"), "0.2.13", 15))
    }

    @Test
    fun `force 只对确实有新版时生效`() {
        assertTrue(UpdateRules.requiresUpdate(manifest("0.2.14", 16, force = true), "0.2.13", 15))
        // 已经是最新版，服务端还挂着 force 记录（旧数据）也不能拦人
        assertFalse(UpdateRules.requiresUpdate(manifest("0.2.13", 15, force = true), "0.2.13", 15))
    }

    @Test
    fun `低于最低支持版本要强制更新`() {
        assertTrue(UpdateRules.requiresUpdate(manifest("0.2.14", 16, minVersion = "0.2.13"), "0.2.11", 13))
        // 本机已经高于最低版本 ⇒ 只是普通更新
        assertFalse(UpdateRules.requiresUpdate(manifest("0.2.14", 16, minVersion = "0.2.10"), "0.2.13", 15))
        // 最低版本写坏了（不可解析）⇒ 不强制
        assertFalse(UpdateRules.requiresUpdate(manifest("0.2.14", 16, minVersion = "next"), "0.2.13", 15))
    }
}
