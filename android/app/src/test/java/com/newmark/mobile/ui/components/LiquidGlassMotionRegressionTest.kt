package com.newmark.mobile.ui.components

import androidx.compose.ui.geometry.Size
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiquidGlassMotionRegressionTest {
    @Test
    fun bothRailOrientationsExpandEquallyOnEverySideWithoutMovingTheirCenters() {
        listOf(Size(320f, 44f), Size(82f, 44f)).forEach { nominal ->
            listOf(0f, .25f, .5f, 1f).forEach { lift ->
                val bounds = expandedLiquidBounds(nominal, 12f, lift)
                val expectedEdge = 12f * lift
                assertEquals(expectedEdge, -bounds.left, .001f)
                assertEquals(expectedEdge, -bounds.top, .001f)
                assertEquals(expectedEdge, bounds.right - nominal.width, .001f)
                assertEquals(expectedEdge, bounds.bottom - nominal.height, .001f)
                assertEquals(nominal.width / 2f, bounds.center.x, .001f)
                assertEquals(nominal.height / 2f, bounds.center.y, .001f)
            }
        }
    }

    @Test
    fun landingWaitsForBothFullLiftAndArrivalRegardlessOfTheirCompletionOrder() = runBlocking {
        for (moveFirst in listOf(false, true)) {
            val lifted = CompletableDeferred<Unit>()
            val arrived = CompletableDeferred<Unit>()
            val landing = CompletableDeferred<Unit>()
            val landed = CompletableDeferred<Unit>()
            val flight = launch(start = CoroutineStart.UNDISPATCHED) {
                runOverlappedLiquidFlight(
                    lift = { lifted.await() },
                    move = { arrived.await() },
                    onLandingStarted = { landing.complete(Unit) },
                    land = { landed.await() },
                )
            }
            if (moveFirst) arrived.complete(Unit) else lifted.complete(Unit)
            yield()
            assertFalse("One completed stage must not start contraction", landing.isCompleted)
            if (moveFirst) lifted.complete(Unit) else arrived.complete(Unit)
            landing.await()
            assertFalse("The command must still wait for contraction", flight.isCompleted)
            landed.complete(Unit)
            flight.join()
        }
    }

    @Test
    fun aHeldFloatRemainsLiftedAfterReachingThePressedOption() = runBlocking {
        var landed = false
        runOverlappedLiquidFlight(
            holdKeepsLifted = true,
            lift = {},
            move = {},
            onLandingStarted = { landed = true },
            land = { landed = true },
        )
        assertFalse(landed)
    }

    @Test
    fun lensRailsUseSupportedExpandedShapesAndCaptureOnlySiblingContent() {
        val rail = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()
        assertFalse(rail.contains("centeredGlassShape"))
        assertEquals(2, rail.split("expandedLiquidBounds(").size - 1)
        assertEquals(2, rail.split("shape = ProviderCapsuleShape, fillColor").size - 1)
        assertTrue(rail.contains("Column(Modifier.fillMaxWidth().layerBackdrop(utilityBackdrop))"))
        assertTrue(rail.contains("Row(Modifier.fillMaxWidth().height(ProviderCapsuleHeight).layerBackdrop(utilityBackdrop))"))
        assertTrue(rail.contains("translationY = (if (dragging) dragFollower.value else glassTopPx.value) + envelope.top"))
        assertTrue(rail.contains("translationY = envelope.top"))
    }

    @Test
    fun interactionGlowAndElevationLastUntilContractionCompletes() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val morph = source.substringAfter("fun Modifier.liquidSelectionMorph(").substringBefore("internal data class LiquidMotionScale")
        assertTrue("unsupported lens outlines must be rejected by the API", morph.contains("shape: CornerBasedShape"))
        assertTrue(morph.contains("if (progress <= 0.001f) return fill"))
        assertTrue(morph.contains("surfaceOverlay = {"))
        assertFalse(morph.contains("drawLiquidContactGlow(center,"))
        assertTrue(morph.contains("contactGeometry()"))
        assertTrue(morph.contains("contact?.localPosition(contactCoordinates)"))
        assertTrue(morph.contains("drawLiquidContactGlow(point, 0.24f * progress)"))
        assertTrue(morph.contains("val radius = 66.dp.toPx()"))
        assertEquals(2, source.split(".zIndex(if (pressed || animationActive) 8f else 0f)").size - 1)
        val button = source.substringAfter("fun Modifier.glassButtonSurface(").substringBefore("fun Modifier.kyantGlassEdge(")
        val land = button.indexOf("pressProgress.animateTo(0f")
        assertTrue(land >= 0)
        assertTrue(button.indexOf("reportAnimationActive(false)") > land)
        assertTrue(button.indexOf("if (!lightPressed) lightPoint = null") > land)
        assertTrue(button.contains("release.complete(Unit)"))
        assertTrue(button.contains("drawLayer(opticsLayer)"))
        assertTrue(button.contains("drawLayer(contentLayer)"))
        assertFalse(button.contains(".graphicsLayer {"))
    }
}
