package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class OverlappedLiquidFlightContractTest {
    @Test
    fun everyExistingMobileFloatUsesTheSharedOverlappedFlightStateMachine() {
        val components = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val sources = listOf("Sidebar.kt", "RightSidebar.kt", "MemoryLabScreen.kt", "ChatScreen.kt")
            .associateWith { File("src/main/java/com/newmark/mobile/ui/$it").readText() }

        assertTrue(components.contains("suspend fun runOverlappedLiquidFlight"))
        assertTrue(components.contains("launch { move() }"))
        assertTrue(components.contains("onLandingStarted()"))
        assertTrue(components.contains("holdKeepsLifted"))
        assertTrue(components.contains("moveJob.join()"))
        assertTrue(components.indexOf("moveJob.join()") < components.indexOf("onLandingStarted()"))
        assertTrue(components.indexOf("onLandingStarted()") < components.indexOf("land()"))
        assertFalse(components.contains("delay(16)"))
        assertTrue(sources.getValue("Sidebar.kt").split("runOverlappedLiquidFlight(").size - 1 >= 6)
        assertTrue(sources.getValue("RightSidebar.kt").contains("runOverlappedLiquidFlight("))
        assertTrue(sources.getValue("MemoryLabScreen.kt").contains("runOverlappedLiquidFlight("))
        assertTrue(sources.getValue("ChatScreen.kt").contains("runOverlappedLiquidFlight("))
    }

    @Test
    fun ordinaryNonFloatSurfacesAreNotMigratedToLiquidGlass() {
        val inventory = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        assertTrue(inventory.contains("ExistingLiquidFloatInventory"))
        assertTrue(inventory.contains("conversation_capsules"))
        assertTrue(inventory.contains("sidebar_utility_selectors"))
        assertTrue(inventory.contains("right_sidebar_tabs"))
        assertTrue(inventory.contains("memory_lab_pager"))
        assertTrue(inventory.contains("composer_selection_menus"))
        assertFalse(inventory.contains("ordinary_surface_as_float"))
    }
}
