package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FnIdResponseTest {

    /**
     * 结构样本：字段名照抄真实响应，**所有地址与 FNID 均已脱敏**
     * （公网段用 RFC 5737 / RFC 3849 文档保留段，局域网用通用私网）。
     */
    private val realPayload = """
        {"msg":"","code":0,"data":{"ddns":null,"ipv4":["10.1.2.4","10.1.2.3"],
        "ipv6":[],"publicIpv4":["203.0.113.7"],
        "publicIpv6":["2001:db8:1234:5678:90ab:cdef:1234:5678"],
        "fn":["demo-nas.fnos.net:443"],"port":{"httpsPort":64999,"httpPort":64888},
        "checkSum":"8812","ver":"3.0.0","forbbidPublicIpv6":false}}
    """.trimIndent()

    @Test
    fun realPayloadIsParsed() {
        val result = FnIdResponse.parse(realPayload)
        assertTrue(result is FnIdResponse.Ok)
        val addresses = (result as FnIdResponse.Ok).addresses
        assertEquals("demo-nas.fnos.net", addresses.relayHost)
        assertEquals(64999, addresses.httpsPort)
        assertEquals(64888, addresses.httpPort)
        assertEquals(listOf("10.1.2.3", "10.1.2.4").sorted(), addresses.lanIpv4.sorted())
        assertEquals(1, addresses.publicIpv4.size)
    }

    @Test
    fun relayPortIsStripped() {
        // data.fn 是 `host:443`，拼 URL 时不能带端口（443 是默认端口，带上也无害但要统一）
        assertEquals("demo-nas.fnos.net", FnIdResponse.parse(realPayload).let {
            (it as FnIdResponse.Ok).addresses.relay.first()
        })
    }

    @Test
    fun nonZeroCodeIsNotFound() {
        val result = FnIdResponse.parse("""{"msg":"fn not exist","code":1024}""")
        assertTrue(result is FnIdResponse.NotFound)
        assertEquals(1024L, (result as FnIdResponse.NotFound).code)
        assertEquals("fn not exist", result.message)
    }

    @Test
    fun missingDataIsBad() {
        assertTrue(FnIdResponse.parse("""{"msg":"","code":0}""") is FnIdResponse.Bad)
    }

    @Test
    fun emptyAddressesIsBad() {
        val result = FnIdResponse.parse("""{"msg":"","code":0,"data":{"ipv4":[],"fn":[]}}""")
        assertTrue(result is FnIdResponse.Bad)
    }

    @Test
    fun notJsonIsBad() {
        assertTrue(FnIdResponse.parse("<html>502 Bad Gateway</html>") is FnIdResponse.Bad)
    }

    @Test
    fun missingPortFallsBackToMeasuredDefaults() {
        val result = FnIdResponse.parse("""{"msg":"","code":0,"data":{"fn":["abc.fnos.net:443"]}}""")
        val addresses = (result as FnIdResponse.Ok).addresses
        assertEquals(DEFAULT_HTTPS_PORT, addresses.httpsPort)
        assertEquals(DEFAULT_HTTP_PORT, addresses.httpPort)
    }
}
