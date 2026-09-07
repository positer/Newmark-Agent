package com.newmark.mobile.ui.components

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassEdgeThicknessContractTest {
    @Test
    fun everyMobileGlassPathAddsOneDpAndKeepsDispersionWithRefraction() {
        val root = File("src/main/java/com/newmark/mobile/ui")
        val liquid = File(root, "components/LiquidGlass.kt").readText()
        val explicitConsumers = listOf(
            File(root, "SettingsScreen.kt"),
            File(root, "RightSidebar.kt"),
            File(root, "NewmarkApp.kt"),
            File(root, "MemoryLabScreen.kt"),
        ).map(File::readText)

        assertTrue(liquid.contains("val MobileInteractionGlassEdge = 7.dp"))
        assertTrue(liquid.contains("val MobileConversationGlassHorizontalEdge = 14.dp"))
        assertTrue(liquid.contains("width = 1.5.dp"))
        assertTrue(liquid.contains("refractionHeight = 9.dp"))
        assertTrue(liquid.contains("chromaticAberration = true"))
        val providerRail = File(root, "components/ProviderSettingsCapsules.kt").readText()
        assertTrue(providerRail.contains("ProviderRailInteractionGlassEdge"))
        assertTrue(providerRail.contains("ProviderRailInteractionGlassEdge = MobileInteractionGlassEdge + 2.dp"))
        assertTrue(providerRail.split("refractionHeight = ProviderRailInteractionGlassEdge").size - 1 == 2)
        explicitConsumers.forEach { source ->
            assertTrue(
                source.contains("refractionHeight = MobileInteractionGlassEdge") ||
                    source.contains("refractionHeight = 5.dp"),
            )
            assertFalse(source.contains("refractionHeight = 4.dp"))
        }
    }
}
