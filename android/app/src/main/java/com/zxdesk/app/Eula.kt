/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app

import android.content.Context

/**
 * 许可协议正文与版本号。
 *
 */
object Eula {

    private const val ASSET = "eula.txt"

    /** 解析不出时按 1 处理：宁可少问一次，也不能每次启动都弹。 */
    private const val FALLBACK_VERSION = 1

    /** 主版本占的位宽：`版本 1.1` → 101，`版本 2.0` → 200。 */
    private const val MAJOR_STEP = 100

    /**
     * 「版本 x.y」→ 整数。
     *
     */
    private val VERSION_RE = Regex("版本\\s*(\\d+)(?:\\.(\\d+))?")

    @Volatile
    private var cached: String? = null

    /** 读协议全文；读不到返回空串（调用方据此跳过一次询问，别把用户锁在门外）。 */
    fun text(context: Context): String {
        cached?.let { return it }
        val loaded = runCatching {
            context.assets.open(ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() }
        }.getOrDefault("")
        if (loaded.isNotEmpty()) cached = loaded
        return loaded
    }

    fun versionOf(text: String): Int {
        val match = VERSION_RE.find(text) ?: return FALLBACK_VERSION
        val major = match.groupValues[1].toIntOrNull() ?: return FALLBACK_VERSION
        val minor = match.groupValues[2].toIntOrNull() ?: 0
        return major * MAJOR_STEP + minor
    }
}
