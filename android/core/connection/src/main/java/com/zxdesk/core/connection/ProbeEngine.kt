/*
 * ZXDesk工作台 Android 客户端
 * 文件：ProbeEngine.kt
 * 职责：候选链路的串行探测，先探通再下载
 */

package com.zxdesk.core.connection

/** 候选链路。 */
data class Candidate(
    val url: String,
    val priority: Int,
    val cleartext: Boolean = false,
    val gateway: Boolean = false,
)

data class ProbeResult(val baseUrl: String, val gateway: Boolean)

interface ProbeEngine {
    suspend fun probe(candidates: List<Candidate>): ProbeResult?
}
