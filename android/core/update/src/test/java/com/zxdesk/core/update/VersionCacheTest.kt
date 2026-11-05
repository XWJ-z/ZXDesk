package com.zxdesk.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 帮助页版本表的落盘格式。
 *
 * 这一层最容易悄悄坏：**新写的串必须能被下一次读回来**，老版本写的串
 * （0.2.17 的 `fnos=0.9.6`）也不能读丢 —— 否则用户升级后打开帮助页是一排「—」。
 */
class VersionCacheTest {

    @Test
    fun `编解码往返：版本、状态、上一版都不丢`() {
        val source = mapOf(
            "fnos" to PlatformRelease("0.9.7", "审核中", PreviousRelease("0.9.6", "已上线")),
            "windows" to PlatformRelease("0.2.3", "已上线"),
            "android" to PlatformRelease("0.2.18", "已上线", PreviousRelease("0.2.17", "")),
        )
        val decoded = VersionCache.decode(VersionCache.encode(source))
        assertEquals(source, decoded)
        assertEquals("0.9.6", decoded["fnos"]?.previous?.version)
        assertEquals("已上线", decoded["fnos"]?.previous?.status)
        assertNull(decoded["windows"]?.previous)
        // 上一版状态为空 = 服务端没配，保留空串而不是编一个
        assertEquals("", decoded["android"]?.previous?.status)
    }

    @Test
    fun `兼容旧客户端写的格式：只有版本号`() {
        val decoded = VersionCache.decode("fnos=0.9.5|windows=0.2.3")
        assertEquals("0.9.5", decoded["fnos"]?.version)
        assertEquals("", decoded["fnos"]?.status)
        assertNull(decoded["fnos"]?.previous)
        assertEquals(2, decoded.size)
    }

    @Test
    fun `空串与残缺段被跳过，不抛异常`() {
        assertTrue(VersionCache.decode("").isEmpty())
        assertTrue(VersionCache.decode("|").isEmpty())
        val decoded = VersionCache.decode("fnos|windows=0.2.3")
        assertEquals(1, decoded.size)
        assertEquals("0.2.3", decoded["windows"]?.version)
    }

    @Test
    fun `没有上一版时不写分号`() {
        val encoded = VersionCache.encode(mapOf("fnos" to PlatformRelease("0.9.6", "已上线")))
        assertEquals("fnos=0.9.6,已上线", encoded)
    }
}
