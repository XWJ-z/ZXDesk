package com.zxdesk.core.connection

import java.security.MessageDigest

/**
 * FN Connect 查询签名（社区逆向，未公开）。
 * ⚠️ 接口可能变更：常量集中在这里，失败时只改这一个文件。
 */
object FnIdSigner {
    const val CONNECT_PATH = "/api/v1/fn/con"

    // 来自社区实现（fnphoto-tv / FeiNiuMusic / fnnas-api）
    const val AUTHX_PREFIX = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
    const val AUTHX_API_KEY = "zIGtkc3dqZnJpd29qZXJqa2w7c"
    private const val CONNECT_SECRET = "anna"

    /** fn-sign 头：sha256("trim_connect`fnId`ts`anna") */
    fun fnSign(fnId: String, timestamp: Long): String =
        sha256Hex("trim_connect`$fnId`$timestamp`$CONNECT_SECRET")

    /** authx 头：nonce=…&timestamp=…&sign=md5(prefix_path_nonce_ts_md5(body)_apiKey) */
    fun authx(timestamp: Long, nonce: String, body: String, path: String = CONNECT_PATH): String {
        val raw = listOf(
            AUTHX_PREFIX,
            path,
            nonce,
            timestamp.toString(),
            md5Hex(body),
            AUTHX_API_KEY,
        ).joinToString("_")
        return "nonce=$nonce&timestamp=$timestamp&sign=${md5Hex(raw)}"
    }

    fun md5Hex(input: String): String = digest("MD5", input)

    fun sha256Hex(input: String): String = digest("SHA-256", input)

    private fun digest(algorithm: String, input: String): String =
        MessageDigest.getInstance(algorithm)
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
