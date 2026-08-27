package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlobalNoRippleContractTest {
    @Test
    fun mobileThemeDisablesComposeAndMaterialRipplesAcrossTheWholeApplication() {
        val theme = java.io.File("src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt").readText()
        val settings = java.io.File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val rightSidebar = java.io.File("src/main/java/com/newmark/mobile/ui/RightSidebar.kt").readText()
        val memoryLab = java.io.File("src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt").readText()

        assertTrue(theme.contains("LocalIndication provides NoVisualIndication"))
        assertTrue(theme.contains("LocalRippleConfiguration provides null"))
        assertTrue(theme.contains("private object NoVisualIndication"))
        assertFalse(settings.contains("RippleConfiguration("))
        assertFalse(settings.contains("LocalRippleConfiguration provides"))
        assertFalse(settings.contains("LocalSettingsIndication"))
        assertFalse(rightSidebar.contains("indication = androidx.compose.foundation.LocalIndication.current"))
        assertTrue(memoryLab.contains("private fun MemoryLabGlassAction"))
        assertTrue(memoryLab.contains("indication = null"))
    }
}
