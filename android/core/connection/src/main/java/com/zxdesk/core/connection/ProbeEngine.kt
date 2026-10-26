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
