package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniJsonTest {
    @Test
    fun largeIntegerStaysExact() {
        // si 是 18 位整数：走 Double 会变成 2.1617353103219382E17，精度就没了
        val text = """{"si":216173531032193860}"""
        val map = MiniJson.parse(text) as Map<*, *>
        assertEquals(216173531032193860L, map["si"])
        assertEquals("216173531032193860", map["si"].toString())
    }

    @Test
    fun decimalStaysDouble() {
        val map = MiniJson.parse("""{"v":1.5}""") as Map<*, *>
        assertEquals(1.5, map["v"])
    }

    @Test
    fun anyToLongHandlesBoth() {
        assertEquals(8192L, MiniJson.anyToLong(8192L))
        assertEquals(8192L, MiniJson.anyToLong(8192.0))
        assertEquals(8192L, MiniJson.anyToLong("8192"))
        assertEquals(null, MiniJson.anyToLong(null))
    }

    @Test
    fun quoteEscapesSpecials() {
        assertEquals("\"a\\\"b\"", MiniJson.quote("a\"b"))
        assertEquals("\"a\\\\b\"", MiniJson.quote("a\\b"))
        assertEquals("\"a\\nb\"", MiniJson.quote("a\nb"))
        assertEquals("\"测试用户\"", MiniJson.quote("测试用户"))
    }

    @Test
    fun quoteRoundTripsThroughParse() {
        val tricky = "p@ss\"\\\n\t中文"
        val parsed = MiniJson.parse("""{"p":${MiniJson.quote(tricky)}}""") as Map<*, *>
        assertEquals(tricky, parsed["p"])
    }

    @Test
    fun nestedEnvelopeParses() {
        val text = """{"result":"succ","data":{"token":"abc"},"errno":0}"""
        val map = MiniJson.parse(text) as Map<*, *>
        val data = map["data"] as Map<*, *>
        assertEquals("abc", data["token"])
        assertTrue(map.containsKey("errno"))
    }
}
