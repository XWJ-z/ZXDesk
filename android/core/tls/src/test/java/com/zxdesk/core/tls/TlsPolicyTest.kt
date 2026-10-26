package com.zxdesk.core.tls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TlsPolicyTest {
    /** 方案文档里的写法（O 在前、带空格）。 */
    private val deviceSubject = "O=fnOS, CN=fnOS"

    /** Java `subjectX500Principal.name` 的真实输出：CN 在前、无空格（2026-10-23 真机实测）。 */
    private val realSubject = "CN=fnOS,O=fnOS"

    @Test
    fun realDeviceSubjectIsRecognized() {
        // 回归：原正则只认 O 在前，真机证书会被一律拒绝
        assertTrue(TlsPolicy.isDeviceCertificate(realSubject))
        assertTrue(TlsPolicy.isDeviceCertificate("CN=fnOS, O=fnOS"))
        assertTrue(TlsPolicy.isDeviceCertificate(deviceSubject))
    }

    @Test
    fun otherCertificateIsNotDevice() {
        assertFalse(TlsPolicy.isDeviceCertificate("CN=other"))
        assertFalse(TlsPolicy.isDeviceCertificate("O=fnOS"))
        assertFalse(TlsPolicy.isDeviceCertificate("CN=fnOS"))
        assertFalse(TlsPolicy.isDeviceCertificate("CN=fnOS,O=Synology"))
        assertFalse(TlsPolicy.isDeviceCertificate(""))
    }

    @Test
    fun nonDeviceCertificateIsRejected() {
        val decision = TlsPolicy.decide("nas.local", "CN=other", "aa", null)
        assertTrue(decision is TrustDecision.Reject)
    }

    @Test
    fun firstUseAsksForConfirmation() {
        val decision = TlsPolicy.decide("nas.local", deviceSubject, "aa", null)
        assertEquals(TrustDecision.AskFirst(deviceSubject, "aa"), decision)
    }

    @Test
    fun realSubjectAsksForConfirmation() {
        assertEquals(
            TrustDecision.AskFirst(realSubject, "aa"),
            TlsPolicy.decide("10.1.2.3", realSubject, "aa", null),
        )
    }

    @Test
    fun sameFingerprintIsAccepted() {
        val saved = TofuRecord("nas.local", deviceSubject, "aa", 1L)
        val decision = TlsPolicy.decide("nas.local", deviceSubject, "aa", saved)
        assertEquals(TrustDecision.Accept, decision)
    }

    @Test
    fun changedFingerprintAsksForRotation() {
        val saved = TofuRecord("nas.local", deviceSubject, "aa", 1L)
        val decision = TlsPolicy.decide("nas.local", deviceSubject, "bb", saved)
        assertEquals(TrustDecision.AskRotated(deviceSubject, "aa", "bb"), decision)
    }
}
