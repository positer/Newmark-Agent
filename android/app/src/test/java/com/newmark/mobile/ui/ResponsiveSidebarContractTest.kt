package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponsiveSidebarContractTest {
    @Test
    fun portraitDrawerNeverInheritsTheExpandedLayoutRailState() {
        assertFalse(sidebarRailForLayout(isCompact = true, expandedLayoutRail = true))
        assertFalse(sidebarRailForLayout(isCompact = true, expandedLayoutRail = false))
        assertTrue(sidebarRailForLayout(isCompact = false, expandedLayoutRail = true))
        assertFalse(sidebarRailForLayout(isCompact = false, expandedLayoutRail = false))
    }
}
