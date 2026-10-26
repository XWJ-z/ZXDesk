package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionPlannerTest {

    private fun planOf(raw: String, preferHttps: Boolean = true): PlanResult =
        ConnectionPlanner.plan(InputParser.parse(raw), preferHttps)

    private fun ready(raw: String, preferHttps: Boolean = true): ConnectPlan =
        (planOf(raw, preferHttps) as PlanResult.Ready).plan

    @Test
    fun directPortIsAlwaysCleartextAndDirect() {
        val plan = ready("10.1.2.3:8990")
        assertEquals("http://10.1.2.3:8990", plan.baseUrl)
        assertTrue(plan.cleartext)
        assertTrue(plan.direct)
    }

    @Test
    fun httpsOnDirectPortIsDowngradedToHttp() {
        // 8990 是明文救援端口，写 https 也按 http —— 否则必然 TLS 失败
        assertEquals("http://10.1.2.3:8990", ready("https://10.1.2.3:8990").baseUrl)
    }

    @Test
    fun ipWithoutPortDefaultsToHttpsGateway() {
        val plan = ready("10.1.2.3")
        assertEquals("https://10.1.2.3", plan.baseUrl)
        assertTrue(!plan.cleartext && !plan.direct)
    }

    @Test
    fun ipWithoutPortFallsBackToHttp8990WhenHttpsOff() {
        val plan = ready("10.1.2.3", preferHttps = false)
        assertEquals("http://10.1.2.3:8990", plan.baseUrl)
        assertTrue(plan.direct)
    }

    @Test
    fun domainDefaultsToHttps() {
        assertEquals("https://nas.example.com", ready("nas.example.com").baseUrl)
    }

    @Test
    fun domainIsForcedHttpsEvenIfSwitchOff() {
        assertTrue(planOf("nas.example.com", preferHttps = false) is PlanResult.Failure)
    }

    @Test
    fun publicIpWithCleartextIsRejected() {
        assertTrue(planOf("8.8.8.8", preferHttps = false) is PlanResult.Failure)
    }

    @Test
    fun publicIpExplicitHttpIsRejected() {
        assertTrue(planOf("http://8.8.8.8:80") is PlanResult.Failure)
    }

    @Test
    fun privateIpExplicitHttpOnOtherPortKeepsPort() {
        val plan = ready("http://10.1.2.3:8080")
        assertEquals("http://10.1.2.3:8080", plan.baseUrl)
        assertTrue(!plan.direct)
    }

    @Test
    fun gatewayPortIsNotDirect() {
        val plan = ready("nas.example.com:64999")
        assertEquals("https://nas.example.com:64999", plan.baseUrl)
        assertTrue(!plan.direct)
    }

    @Test
    fun customPathBecomesGatewayPath() {
        assertEquals("/app/zxdesk", ready("https://nas.example.com/app/zxdesk").gatewayPath)
    }

    @Test
    fun privateAddressRanges() {
        assertTrue(ConnectionPlanner.isPrivateAddress("10.1.2.3"))
        assertTrue(ConnectionPlanner.isPrivateAddress("172.16.0.1"))
        assertTrue(ConnectionPlanner.isPrivateAddress("172.31.255.254"))
        assertTrue(ConnectionPlanner.isPrivateAddress("10.1.2.3"))
        assertTrue(ConnectionPlanner.isPrivateAddress("127.0.0.1"))
        assertTrue(ConnectionPlanner.isPrivateAddress("fe80::1"))
        assertTrue(!ConnectionPlanner.isPrivateAddress("172.32.0.1"))
        assertTrue(!ConnectionPlanner.isPrivateAddress("8.8.8.8"))
        assertTrue(!ConnectionPlanner.isPrivateAddress("nas.example.com"))
    }

    @Test
    fun invalidInputSurfacesItsReason() {
        val result = planOf("!!!")
        assertTrue(result is PlanResult.Failure)
    }
}
