package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsBackButtonGlassCanvasContractTest {
    @Test
    fun sharedSettingsBackButtonUsesAnOutsetOpticalCanvasForEverySettingsDestination() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val liquid = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val header = settings.substringAfter(".statusBarsPadding()")
            .substringBefore("AnimatedContent(")
        val backButton = header.substringAfter("GlassButtonCanvas(")
            .substringBefore("Text(")

        assertTrue(header.contains("GlassButtonCanvas("))
        assertTrue(backButton.contains("visualSize = 36.dp"))
        assertTrue(backButton.contains("shape = CircleShape"))
        assertTrue(backButton.contains("surfaceColor = p.bgQuaternary"))
        assertTrue(backButton.contains("contentDescription = \"返回\""))
        assertTrue(backButton.contains("when (page)"))
        assertFalse(backButton.contains(".glassButtonSurface("))

        assertTrue(liquid.contains("val GlassButtonCanvasOutset = 8.dp"))
        assertTrue(liquid.contains(".requiredSize(visualSize + GlassButtonCanvasOutset * 2)"))
        assertTrue(liquid.contains("CenteredInsetShape(shape, GlassButtonCanvasOutset)"))
    }
}
