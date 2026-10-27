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

    private val VERSION_RE = Regex("版本\\s*(\\d+)")

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

    fun versionOf(text: String): Int =
        VERSION_RE.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: FALLBACK_VERSION
}
