package com.newmark.mobile.ui

import com.newmark.mobile.ui.theme.DefaultGlassAlpha
import com.newmark.mobile.ui.theme.GlassMode
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FixedGlassSettingsContractTest {
    @Test
    fun settingsExposeNoGlassControlAndThemeUsesOnlyTheDefaultLevel() {
        assertEquals(DefaultGlassAlpha, GlassMode().alpha, 0f)

        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertFalse(settings.contains("玻璃强度"))
        assertFalse(settings.contains("glassMode.previewAlpha"))
        assertFalse(settings.contains("glassMode.commitAlpha"))
        assertFalse(app.contains("GlassStore"))
        assertTrue(app.contains("LocalGlassMode.current"))
    }
}
