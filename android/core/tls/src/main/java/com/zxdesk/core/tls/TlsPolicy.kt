package com.zxdesk.core.tls

/** 已确认的本机设备证书。 */
data class TofuRecord(
    val host: String,
    val subject: String,
    val sha256: String,
    val confirmedAt: Long,
)

sealed interface TrustDecision {
    object Accept : TrustDecision
    data class AskFirst(val subject: String, val sha256: String) : TrustDecision
    data class AskRotated(
        val subject: String,
        val previousSha256: String,
        val currentSha256: String,
    ) : TrustDecision
    data class Reject(val reason: String) : TrustDecision
}

interface TofuStore {
    fun get(host: String): TofuRecord?
    fun put(record: TofuRecord)
}

/**
 * 自签证书 TOFU 判定：只认本设备证书（`O=fnOS` + `CN=fnOS`）；
 * 指纹一致放行，指纹变化按「轮换」重确认，subject 不符拒绝。
 *
 * ⚠️ 2026-10-23 实测（真机 10.1.2.3:64999）：
 * `X509Certificate.subjectX500Principal.name` 返回 **`CN=fnOS,O=fnOS`** ——
 * **CN 在前**，且逗号后没有空格。原先按 `O=fnOS, CN=fnOS` 写的正则两组都匹配不上，
 * 结果是把自家设备一律拒掉。⇒ 改成按属性解析，不依赖顺序与空格。
 */
object TlsPolicy {
    private const val ORG = "O"
    private const val COMMON_NAME = "CN"
    private const val DEVICE_VALUE = "fnOS"

    fun isDeviceCertificate(subject: String): Boolean {
        var hasOrg = false
        var hasCommonName = false
        for (part in subject.split(',')) {
            val index = part.indexOf('=')
            if (index <= 0) continue
            val key = part.substring(0, index).trim().uppercase()
            val value = part.substring(index + 1).trim()
            if (value != DEVICE_VALUE) continue
            if (key == ORG) hasOrg = true
            if (key == COMMON_NAME) hasCommonName = true
        }
        return hasOrg && hasCommonName
    }

    fun decide(host: String, subject: String, sha256: String, saved: TofuRecord?): TrustDecision {
        if (!isDeviceCertificate(subject)) return TrustDecision.Reject("不是本设备的证书")
        return when {
            saved == null -> TrustDecision.AskFirst(subject, sha256)
            saved.sha256 == sha256 -> TrustDecision.Accept
            else -> TrustDecision.AskRotated(subject, saved.sha256, sha256)
        }
    }
}
