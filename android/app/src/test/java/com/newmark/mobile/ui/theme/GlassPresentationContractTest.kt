package com.newmark.mobile.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

class GlassPresentationContractTest {
    @Test
    fun pcDefaultGlassCurveAndMobileBackdropRemainStable() {
        val presentation = glassPresentationForAlpha(DefaultGlassAlpha)
        assertEquals(85f, presentation.opacityPercent, 0.001f)
        assertEquals(15f, presentation.transparencyPercent, 0.001f)
        assertEquals(1.2f, presentation.blur1, 0.001f)
        assertEquals(2.4f, presentation.blur2, 0.001f)
        assertEquals(3f, presentation.blur3, 0.001f)
        assertEquals(0.7225f, presentation.alpha3, 0.001f)
        assertEquals(32f, mobileBackdropBlurDp(DefaultGlassAlpha), 0.001f)
    }

    @Test
    fun glassInputsAreClampedAndScaledFromDefault() {
        assertEquals(1f, glassPresentationForAlpha(2f).alpha, 0f)
        assertEquals(0f, glassPresentationForAlpha(-1f).alpha, 0f)
        assertEquals(0.72f, scaledGlassAlpha(0.72f, DefaultGlassAlpha), 0.001f)
    }
}
