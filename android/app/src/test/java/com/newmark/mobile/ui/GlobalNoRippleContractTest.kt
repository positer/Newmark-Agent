package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlobalNoRippleContractTest {
    @Test
    fun mobileThemeDisablesComposeAndMaterialClickIndicationsGlobally() {
        val theme = java.io.File("src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt").readText()

        assertTrue(theme.contains("LocalIndication provides NoVisualIndication"))
        assertTrue(theme.contains("private object NoVisualIndication"))
        assertFalse(theme.contains("rememberRipple("))
        assertFalse(theme.contains("ripple("))
    }
}
