package com.zxdesk.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 接口契约的判据：字段不全就整份拒收。
 *
 * 用例里的地址与 hash 都是占位值（RFC 2606 的 example.com + 重复字符），
 * 不代表任何真实发布记录。
 */
class UpdateContractTest {

    private val goodHash = "a".repeat(64)

    private fun payload(
        platform: String = "android",
        version: String = "0.2.13",
        versionCode: String = "15",
        hashLiteral: String = "\"$goodHash\"",
        downloadUrls: String = "[\"https://example.com/app.apk\"]",
        fallbackUrl: String = "\"\"",
        ok: String = "true",
    ): String = """
        {
          "ok": $ok,
          "message": "还没有发布记录",
          "data": {
            "platform": "$platform",
            "channel": "stable",
            "version": "$version",
            "versionCode": $versionCode,
            "hash": $hashLiteral,
            "fileName": "zxdesk-android-$version-debug.apk",
            "fileSize": 9665430,
            "downloadUrls": $downloadUrls,
            "fallbackUrl": $fallbackUrl,
            "releaseNotes": "第一行\n第二行",
            "force": false,
            "minVersion": "",
            "publishedAt": "2026-10-27 20:00:00"
          }
        }
    """.trimIndent()

    @Test
    fun `正常响应解析成固定形状`() {
        val result = UpdateContract.parse(payload())
        assertTrue(result is ManifestResult.Ok)
        val manifest = (result as ManifestResult.Ok).manifest
        assertEquals("android", manifest.platform)
        assertEquals("0.2.13", manifest.version)
        assertEquals(15L, manifest.versionCode ?: -1L)
        assertEquals(9665430L, manifest.fileSize)
        assertEquals(goodHash, manifest.hash)
        assertEquals(listOf("https://example.com/app.apk"), manifest.downloadUrls)
        assertEquals("第一行\n第二行", manifest.notes)
        assertEquals("", manifest.fallbackUrl)
        assertEquals("", manifest.minVersion)
    }

    @Test
    fun `缺 SHA256 整份拒收`() {
        assertTrue(UpdateContract.parse(payload(hashLiteral = "\"\"")) is ManifestResult.Invalid)
        assertTrue(UpdateContract.parse(payload(hashLiteral = "\"abc\"")) is ManifestResult.Invalid)
    }

    @Test
    fun `平台不符拒收`() {
        val result = UpdateContract.parse(payload(platform = "windows"))
        assertTrue(result is ManifestResult.Invalid)
        assertTrue((result as ManifestResult.Invalid).reason.contains("平台不匹配"))
    }

    @Test
    fun `没有可用下载地址拒收`() {
        // 明文公网地址不算可用
        val result = UpdateContract.parse(payload(downloadUrls = "[\"http://example.com/app.apk\"]"))
        assertTrue(result is ManifestResult.Invalid)
    }

    @Test
    fun `接口 ok 不为 true 时带出 message`() {
        val result = UpdateContract.parse(payload(ok = "false"))
        assertTrue(result is ManifestResult.Invalid)
        assertTrue((result as ManifestResult.Invalid).reason.contains("还没有发布记录"))
    }

    @Test
    fun `非 JSON 与缺 data 都拒收`() {
        assertTrue(UpdateContract.parse("<html>") is ManifestResult.Invalid)
        assertTrue(UpdateContract.parse("""{"ok":true}""") is ManifestResult.Invalid)
    }

    @Test
    fun `网盘地址只认 http 与 https`() {
        val ok = UpdateContract.parse(payload(fallbackUrl = "\"https://example.com/pan\""))
        assertEquals("https://example.com/pan", (ok as ManifestResult.Ok).manifest.fallbackUrl)

        val bad = UpdateContract.parse(payload(fallbackUrl = "\"javascript:alert(1)\""))
        assertEquals("", (bad as ManifestResult.Ok).manifest.fallbackUrl)
    }

    @Test
    fun `没有 versionCode 时为 null，不猜`() {
        val result = UpdateContract.parse(payload(versionCode = "null"))
        assertNull((result as ManifestResult.Ok).manifest.versionCode)
    }
}
