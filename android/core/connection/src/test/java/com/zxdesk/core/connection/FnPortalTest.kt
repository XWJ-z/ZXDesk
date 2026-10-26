package com.zxdesk.core.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FnPortalTest {
    @Test
    fun portalUrlUsesFnId() {
        assertEquals("https://fnos.net/demo-nas/", FnPortal.urlFor("demo-nas"))
    }

    @Test
    fun portalUrlIsLowercased() {
        assertEquals("https://fnos.net/demo-nas/", FnPortal.urlFor("DEMO-NAS"))
    }

    @Test
    fun portalHostsAreRecognized() {
        assertTrue(FnPortal.isPortalHost("fnos.net"))
        assertTrue(FnPortal.isPortalHost("www.fnos.net"))
        assertTrue(FnPortal.isPortalHost("5ddd.com"))
        assertTrue(FnPortal.isPortalHost("www.5ddd.com"))
    }

    @Test
    fun unrelatedHostIsNotPortal() {
        // 注意：中继主机（demo-nas.fnos.net）也满足 *.fnos.net，调用方必须自己先排除
        assertFalse(FnPortal.isPortalHost("nas.example.com"))
        assertFalse(FnPortal.isPortalHost("fnnas.com"))
        assertFalse(FnPortal.isPortalHost(""))
    }
}
