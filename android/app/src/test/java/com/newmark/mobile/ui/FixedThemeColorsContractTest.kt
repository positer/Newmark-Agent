package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FixedThemeColorsContractTest {
    @Test
    fun mobileUsesOnlyBuiltInLightAndDarkThemeColors() {
        val theme = java.io.File("src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt").readText()
        val settings = java.io.File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val providerConfig = java.io.File("src/main/java/com/newmark/mobile/data/ProviderConfig.kt").readText()

        assertTrue(theme.contains("data class NewmarkThemeColors("))
        assertTrue(theme.contains("val NewmarkDarkThemeColors = NewmarkThemeColors("))
        assertTrue(theme.contains("val NewmarkLightThemeColors = NewmarkThemeColors("))
        assertTrue(theme.contains("val LocalNewmarkColors = staticCompositionLocalOf"))

        val forbidden = listOf(
            "NewmarkPalette",
            "LocalNewmarkPalette",
            "CustomPalette",
            "ColorPicker",
            "customColor",
            "accentColor",
            "paletteJson",
        )
        forbidden.forEach { token ->
            assertFalse("mobile custom-color token must stay absent: $token", theme.contains(token))
            assertFalse("settings custom-color token must stay absent: $token", settings.contains(token))
            assertFalse("provider config custom-color token must stay absent: $token", providerConfig.contains(token))
        }
    }
}
