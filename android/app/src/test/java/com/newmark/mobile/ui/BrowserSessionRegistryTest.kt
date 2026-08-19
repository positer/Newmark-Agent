package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class BrowserSessionRegistryTest {
    @Test
    fun browserToolAndSidebarResolveTheSameConversationSession() {
        val registry = BrowserSessionRegistry()
        val backgroundToolSession = registry.session("local:conversation-a")
        assertEquals(false, backgroundToolSession.hasActivity)

        backgroundToolSession.navigate("https://example.com/a")

        val sidebarSession = registry.session("local:conversation-a")
        assertSame(backgroundToolSession, sidebarSession)
        assertEquals(true, sidebarSession.hasActivity)
        assertEquals("https://example.com/a", sidebarSession.address)
    }

    @Test
    fun browserSessionsRemainIsolatedAndSurviveConversationSwitches() {
        val registry = BrowserSessionRegistry()
        val conversationA = registry.session("local:conversation-a")
        conversationA.navigate("https://example.com/a")

        val conversationB = registry.session("local:conversation-b")
        conversationB.navigate("https://example.com/b")

        assertNotSame(conversationA, conversationB)
        assertEquals("https://example.com/b", conversationB.address)
        assertSame(conversationA, registry.session("local:conversation-a"))
        assertEquals("https://example.com/a", registry.session("local:conversation-a").address)
    }
}
