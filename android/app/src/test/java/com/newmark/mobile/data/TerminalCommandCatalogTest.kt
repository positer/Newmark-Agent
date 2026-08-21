package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalCommandCatalogTest {
    @Test
    fun exposesBroadTmuxScaleBuiltinSurfaceIncludingClockCommands() {
        assertTrue("expected at least 80 command names and aliases", TerminalCommandCatalog.names.size >= 80)
        assertTrue("date" in TerminalCommandCatalog.names)
        assertTrue("time" in TerminalCommandCatalog.names)
        assertTrue("now" in TerminalCommandCatalog.names)
        assertEquals("date", TerminalCommandCatalog.canonical("get-date"))
        assertEquals("read", TerminalCommandCatalog.canonical("cat"))
    }
}
