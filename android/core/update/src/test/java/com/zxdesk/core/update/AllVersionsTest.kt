package com.zxdesk.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `GET /api/version` 的解析判据。
 *
 * 关键是**两种服务端都要认**：
 * ① 新版带 `status`（`app_version.status` 那一列）→ 版本与状态都拿出来；
 * ② 老版没有 `status` 键 → 版本照常拿，状态留空（页面不显示徽章）。
 *
 * ⛔ 第二种不能算失败：服务端与客户端是分开升级的，先装新客户端不该看到「检查失败」。
 */
class AllVersionsTest {

    private fun payload(rows: String): String = """
        {
          "ok": true,
          "channel": "stable",
          "data": { $rows }
        }
    """.trimIndent()

    private fun row(version: String, status: String?): String {
        val statusField = if (status == null) "" else ", \"status\": \"$status\""
        return """{ "version": "$version", "versionCode": null$statusField }"""
    }

    @Test
    fun `带 status 时版本与状态都解析出来`() {
        val json = payload(
            listOf(
                "\"fnos\": " + row("0.9.6", "审核中"),
                "\"windows\": " + row("0.2.3", "已上线"),
                "\"android\": " + row("0.2.18", "已上线"),
                "\"edge\": " + row("0.1.8", "可用"),
            ).joinToString(","),
        )
        val result = AllVersionsContract.parse(json)
        assertTrue(result is AllVersionsResult.Ok)
        val versions = (result as AllVersionsResult.Ok).versions
        assertEquals(4, versions.size)
        assertEquals("0.9.6", versions["fnos"]?.version)
        assertEquals("审核中", versions["fnos"]?.status)
        assertEquals("可用", versions["edge"]?.status)
    }

    @Test
    fun `老服务端没有 status 键时版本照常可用`() {
        val json = payload(
            listOf(
                "\"fnos\": " + row("0.9.5", null),
                "\"windows\": " + row("0.2.3", null),
                "\"android\": " + row("0.2.14", null),
                "\"edge\": " + row("0.1.8", null),
            ).joinToString(","),
        )
        val result = AllVersionsContract.parse(json)
        assertTrue(result is AllVersionsResult.Ok)
        val versions = (result as AllVersionsResult.Ok).versions
        assertEquals("0.2.14", versions["android"]?.version)
        // 空状态 = 服务端没配，页面据此不显示徽章（⛔ 不编一个默认值）
        assertEquals("", versions["android"]?.status)
    }

    @Test
    fun `缺 version 的端被跳过，全部缺 version 算失败`() {
        val partial = payload(
            listOf(
                "\"android\": { \"status\": \"已上线\" }",
                "\"windows\": " + row("0.2.3", "已上线"),
            ).joinToString(","),
        )
        val ok = AllVersionsContract.parse(partial) as AllVersionsResult.Ok
        assertEquals(1, ok.versions.size)
        assertNull(ok.versions["android"])

        val empty = payload("\"android\": { \"status\": \"已上线\" }")
        assertTrue(AllVersionsContract.parse(empty) is AllVersionsResult.Failed)
    }

    @Test
    fun `ok 不为 true 时按失败处理`() {
        val result = AllVersionsContract.parse("""{"ok":false,"message":"no version published yet"}""")
        assertTrue(result is AllVersionsResult.Failed)
        assertEquals("no version published yet", (result as AllVersionsResult.Failed).message)
    }

    @Test
    fun `鸿蒙出现时一并收录，不出现也不影响其它端`() {
        val json = payload(
            listOf(
                "\"android\": " + row("0.2.18", "已上线"),
                "\"harmonyos\": " + row("0.1.0", "内测中"),
            ).joinToString(","),
        )
        val ok = AllVersionsContract.parse(json) as AllVersionsResult.Ok
        assertEquals("0.1.0", ok.versions["harmonyos"]?.version)
        assertEquals("内测中", ok.versions["harmonyos"]?.status)
    }

    @Test
    fun `解析 previous：上一版的版本号与状态`() {
        val json = payload(
            """
            "fnos": { "version": "0.9.7", "status": "审核中",
                      "previous": { "version": "0.9.6", "status": "已上线" } },
            "windows": { "version": "0.2.3", "status": "已上线", "previous": null }
            """.trimIndent(),
        )
        val ok = AllVersionsContract.parse(json) as AllVersionsResult.Ok
        assertEquals("0.9.6", ok.versions["fnos"]?.previous?.version)
        assertEquals("已上线", ok.versions["fnos"]?.previous?.status)
        // 只有一版的端：服务端给 null，客户端不能编出一条上一版
        assertNull(ok.versions["windows"]?.previous)
    }

    @Test
    fun `previous 结构不对时当没有上一版`() {
        val json = payload(
            """
            "fnos": { "version": "0.9.7", "status": "审核中",
                      "previous": { "version": "", "status": "已上线" } },
            "edge": { "version": "0.1.8", "status": "可用", "previous": "0.1.7" }
            """.trimIndent(),
        )
        val ok = AllVersionsContract.parse(json) as AllVersionsResult.Ok
        assertNull(ok.versions["fnos"]?.previous)
        assertNull(ok.versions["edge"]?.previous)
    }
}
