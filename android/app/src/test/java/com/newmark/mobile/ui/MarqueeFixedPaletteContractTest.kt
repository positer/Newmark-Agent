package com.newmark.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MarqueeFixedPaletteContractTest {
    @Test
    fun mobileAndDesktopUseFixedBlackWhitePaletteWithoutEditorEntry() {
        val theme = File("src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt").readText()
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val marquee = File("src/main/java/com/newmark/mobile/ui/components/Marquee.kt").readText()
        val desktop = File("../../DESKTOP/src/ui/index.html").readText()
        val desktopConfig = File("../../DESKTOP/src/core/config.ts").readText()
        assertTrue(theme.contains("Color.Black"))
        assertTrue(theme.contains("Color.White"))
        assertTrue(!settings.contains("MarqueeColorsSection"))
        assertTrue(marquee.contains("val stroke = 2.dp.toPx()"))
        assertTrue(marquee.contains("animation = tween(3000"))
        assertTrue(!marquee.contains("width: Dp"))
        assertTrue(!marquee.contains("periodMs:"))
        assertTrue(desktop.contains("--g1: #000000;"))
        assertTrue(desktop.contains("--g2: #ffffff;"))
        assertTrue(desktop.contains("--g3: #000000;"))
        assertTrue(desktop.contains("--g4: #ffffff;"))
        assertTrue(desktop.contains("--marquee-speed: 3s;"))
        assertTrue(desktop.contains("--marquee-width: 2px;"))
        assertTrue(!desktop.contains("window.setGradientColor"))
        assertTrue(!desktop.contains("window.setGradientSpeed"))
        assertTrue(!desktop.contains("window.setGradientWidth"))
        assertTrue(!desktopConfig.contains("gradient_colors: {"))
        assertTrue(!desktopConfig.contains("gradient_speed: {"))
        assertTrue(!desktopConfig.contains("gradient_width: {"))
    }
}
