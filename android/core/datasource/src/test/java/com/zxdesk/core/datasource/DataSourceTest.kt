package com.zxdesk.core.datasource

import com.zxdesk.core.connection.FnIdAddresses
import com.zxdesk.core.connection.FnIdException
import com.zxdesk.core.connection.FnIdResolver
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeResolver(private val addresses: FnIdAddresses?) : FnIdResolver {
    var lastFnId: String? = null

    override suspend fun resolve(fnId: String): FnIdAddresses {
        lastFnId = fnId
        return addresses ?: throw FnIdException("找不到这个 FNID")
    }
}

class DataSourceTest {
    @Test
    fun nasResolveKeepsSchemeAndGatewayPath() = runTest {
        val entry = NasDataSource().resolve(Profile("http://10.1.2.3:8990"))
        assertEquals("http://10.1.2.3:8990", entry.baseUrl)
        assertEquals("/app/zxdesk", entry.gatewayPath)
        assertEquals(AccountScope.NAS, entry.accountScope)
        assertEquals(EntryFlow.DIRECT, entry.flow)
        assertTrue(entry.cleartext)
    }

    @Test
    fun nasAddsHttpsWhenSchemeMissing() = runTest {
        val entry = NasDataSource().resolve(Profile("nas.example.com"))
        assertEquals("https://nas.example.com", entry.baseUrl)
        assertEquals(EntryFlow.GATEWAY, entry.flow)
        assertFalse(entry.cleartext)
    }

    @Test
    fun lanPortAloneIsDirectNotHttps() = runTest {
        // 0.1.0 的病根：`10.1.2.3:8990` 被补成 https，必然 TLS 失败
        val entry = NasDataSource().resolve(Profile("10.1.2.3:8990"))
        assertEquals("http://10.1.2.3:8990", entry.baseUrl)
        assertEquals(EntryFlow.DIRECT, entry.flow)
    }

    @Test
    fun fnIdResolvesToPortalThenRelayEntry() = runTest {
        val resolver = FakeResolver(FnIdAddresses(relay = listOf("demo-nas.fnos.net")))
        val entry = NasDataSource(resolver).resolve(Profile("DEMO-NAS"))
        assertEquals("demo-nas", resolver.lastFnId)
        assertEquals("https://demo-nas.fnos.net", entry.baseUrl)
        assertEquals("demo-nas.fnos.net", entry.relayHost)
        assertEquals(EntryFlow.GATEWAY, entry.flow)
        // 0.2.1：先进官方门户登录飞牛 —— 中继根是 NAS 桌面 SPA 空壳，不是登录页
        assertEquals("https://fnos.net/demo-nas/", entry.portalUrl)
        assertEquals("https://fnos.net/demo-nas/", entry.startUrl)
        assertEquals("https://demo-nas.fnos.net/app/zxdesk/login.html", entry.zxDeskLoginUrl)
    }

    @Test
    fun fnIdWithoutRelayFails() = runTest {
        val resolver = FakeResolver(FnIdAddresses(lanIpv4 = listOf("10.1.2.3")))
        val error = runCatching { NasDataSource(resolver).resolve(Profile("demo-nas")) }.exceptionOrNull()
        assertTrue(error is FnIdException)
    }

    @Test
    fun withNativeSessionGoesStraightToZxDesk() = runTest {
        // 0.2.2：有 WS 会话就别再加载门户（否则白转一圈回登录页）
        val resolver = FakeResolver(FnIdAddresses(relay = listOf("demo-nas.fnos.net")))
        val entry = NasDataSource(resolver).resolve(Profile("demo-nas"))
            .copy(fnSession = com.zxdesk.core.connection.FnSession(token = "tk", entryToken = "et"))
        assertEquals("https://demo-nas.fnos.net/app/zxdesk/login.html", entry.startUrl)
        assertEquals(2, entry.fnSession?.cookies(entry.relayHost)?.size)
    }

    @Test
    fun invalidInputFailsWithReason() = runTest {
        val error = runCatching { NasDataSource().resolve(Profile("!!!")) }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun directEntryStartsAtLoginPage() = runTest {
        val entry = NasDataSource().resolve(Profile("10.1.2.3:8990"))
        assertEquals("http://10.1.2.3:8990/app/zxdesk/login.html", entry.startUrl)
        assertNull(entry.relayHost)
        assertNull(entry.portalUrl)
    }

    @Test
    fun domainEntryStillStartsAtGatewayRoot() = runTest {
        // 域名没有门户可走，仍是「站点根 = 飞牛登录页」
        val entry = NasDataSource().resolve(Profile("nas.example.com:64999"))
        assertEquals("https://nas.example.com:64999/", entry.startUrl)
        assertNull(entry.portalUrl)
    }

    @Test
    fun onlyNasIsAvailableInPhaseOne() {
        assertTrue(dataSourceFor(DataSourceKind.NAS).available)
        assertFalse(dataSourceFor(DataSourceKind.LOCAL).available)
        assertFalse(dataSourceFor(DataSourceKind.HYBRID).available)
    }
}
