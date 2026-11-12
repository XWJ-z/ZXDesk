/*
 * ZXDesk工作台 Android 客户端
 * 文件：Eula.kt
 * 职责：许可协议正文的读取与版本号提取
 */

package com.zxdesk.app

import android.content.Context

/**
 * 许可协议正文与版本号。
 *
 * 正文的唯一来源是 `assets/eula.txt`；协议版本从正文首段的「版本 x.y」里解析 ——
 * ⛔ 不要再另存一个常量：两处不同步就会出现「条款改了，但没有重新征求同意」。
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
     * ⚠️ **必须连次版本一起算**。只取整数部分的话 `1.0` 与 `1.1` 都会解析成 1：
     * 协议改了版本号、老用户却不会再看到它 —— 那等于打着升版的旗号没升。
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
