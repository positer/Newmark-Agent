package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class BrowserSessionRegistryTest {
    @Test
    fun visibleBrowserToolAndSidebarResolveTheSameConversationSession() {
        val registry = BrowserSessionRegistry()
        val visibleToolSession = registry.visibleSession("local:conversation-a")
        assertEquals(false, visibleToolSession.hasActivity)

        visibleToolSession.navigate("https://example.com/a")

        val sidebarSession = registry.session("local:conversation-a")
        assertSame(visibleToolSession, sidebarSession)
        assertEquals(true, sidebarSession.hasActivity)
        assertEquals("https://example.com/a", sidebarSession.address)
    }

    @Test
    fun invisibleBrowserToolNeverAliasesTheRightSidebarSession() {
        val registry = BrowserSessionRegistry()
        val sidebarSession = registry.visibleSession("local:conversation-a")
        val backgroundSession = registry.backgroundSession("local:conversation-a")

        backgroundSession.navigate("https://example.com/background")

        assertNotSame(sidebarSession, backgroundSession)
        assertSame(backgroundSession, registry.backgroundSession("local:conversation-a"))
        assertEquals(BrowserUrlPolicy.DefaultUrl, sidebarSession.address)
        assertEquals(false, sidebarSession.hasActivity)
        assertEquals("https://example.com/background", backgroundSession.address)
    }

    @Test
    fun releasingAnInvisibleSessionDoesNotAffectTheSidebarSession() {
        val registry = BrowserSessionRegistry()
        val visible = registry.visibleSession("local:conversation-a")
        val background = registry.backgroundSession("local:conversation-a")

        registry.releaseBackgroundSession("local:conversation-a")

        assertSame(visible, registry.visibleSession("local:conversation-a"))
        assertNotSame(background, registry.backgroundSession("local:conversation-a"))
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

    @Test
    fun reloadKeepsPopupNavigationInTheSameSession() {
        val session = BrowserSessionState()
        session.navigate("https://example.com/popup")
        val before = session.command.id
        session.reload()
        assertEquals(BrowserCommandKind.Reload, session.command.kind)
        assertEquals("https://example.com/popup", session.address)
        assertEquals(before + 1, session.command.id)
    }
}
