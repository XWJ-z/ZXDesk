package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InputParserTest {
    @Test
    fun fnIdIsRecognized() {
        assertEquals(Target.FnId("abcde"), InputParser.parse("abcde"))
    }

    @Test
    fun fnIdIsCaseInsensitive() {
        assertEquals(Target.FnId("demo-nas"), InputParser.parse("DEMO-NAS"))
    }

    @Test
    fun fnIdTooShortIsInvalid() {
        assertTrue(InputParser.parse("abcd") is Target.Invalid)
    }

    @Test
    fun fnIdEndingWithDashIsInvalid() {
        assertTrue(InputParser.parse("abcde-") is Target.Invalid)
    }

    @Test
    fun lanIpIsRecognized() {
        assertEquals(
            Target.Host("10.1.2.3", null, null, null, TargetKind.IP),
            InputParser.parse("10.1.2.3"),
        )
    }

    @Test
    fun ipWithPortIsRecognized() {
        assertEquals(
            Target.Host("10.1.2.3", 8990, null, null, TargetKind.IP),
            InputParser.parse("10.1.2.3:8990"),
        )
    }

    @Test
    fun bracketedIpv6WithPortIsRecognized() {
        assertEquals(
            Target.Host("fe80::1", 8990, null, null, TargetKind.IP),
            InputParser.parse("[fe80::1]:8990"),
        )
    }

    @Test
    fun bareIpv6IsRecognized() {
        assertEquals(
            Target.Host("fe80::1", null, null, null, TargetKind.IP),
            InputParser.parse("fe80::1"),
        )
    }

    @Test
    fun fullUrlIsRecognized() {
        assertEquals(
            Target.Host("nas.example.com", null, "https", "/app/zxdesk", TargetKind.DOMAIN),
            InputParser.parse("https://nas.example.com/app/zxdesk"),
        )
    }

    @Test
    fun domainIsRecognized() {
        assertEquals(
            Target.Host("nas.example.com", null, null, null, TargetKind.DOMAIN),
            InputParser.parse("nas.example.com"),
        )
    }

    @Test
    fun domainWithPortIsRecognized() {
        assertEquals(
            Target.Host("nas.example.com", 64999, null, null, TargetKind.DOMAIN),
            InputParser.parse("nas.example.com:64999"),
        )
    }

    @Test
    fun trailingSlashAndSpacesAreTrimmed() {
        assertEquals(Target.FnId("abcde"), InputParser.parse("  abcde/  "))
    }

    @Test
    fun blankIsInvalid() {
        assertTrue(InputParser.parse("   ") is Target.Invalid)
    }

    @Test
    fun garbageIsInvalid() {
        assertTrue(InputParser.parse("!!!") is Target.Invalid)
    }

    @Test
    fun ipv4OutOfRangeIsNotIp() {
        // 300 超范围 → 当成域名（含点），由选路阶段再拒
        assertEquals(TargetKind.DOMAIN, (InputParser.parse("1.2.3.300") as Target.Host).kind)
    }
}
