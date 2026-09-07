package com.newmark.mobile.ui.components

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import kotlin.math.abs
import org.junit.Assert.*
import org.junit.Test

class LiquidContactAndDampingTest {
    @Test
    fun offAxisContactKeepsItsPhysicalLocationThroughOpticalTransforms() {
        val size = Size(100f, 44f)
        for (physical in listOf(Offset(17f, -30f), Offset(146f, 35f), Offset(2f, 70f))) {
            for (translation in listOf(Offset(0f, 0f), Offset(4f, -2f), Offset(-3f, 5f))) {
                val local = liquidContactBeforeTransform(physical, size, 1.12f, 0.96f, translation)
                val rendered = Offset(
                    (local.x - 50f) * 1.12f + 50f + translation.x,
                    (local.y - 22f) * 0.96f + 22f + translation.y,
                )
                assertEquals(physical.x, rendered.x, 0.001f)
                assertEquals(physical.y, rendered.y, 0.001f)
                assertNotEquals("A blocked contact must not move to the thumb center", Offset(50f, 22f), local)
            }
        }
    }

    @Test
    fun movingGlassReprojectsAStationaryFingerInsteadOfDraggingItsLight() {
        val finger = Offset(210f, 27f)
        val size = Size(90f, 60f)
        val start = liquidContactBeforeTransform(finger, size, 1f, 1f, Offset(35f, 0f))
        val arrived = liquidContactBeforeTransform(finger, size, 1f, 1f, Offset(170f, 0f))
        assertEquals(175f, start.x, 0.001f)
        assertEquals(40f, arrived.x, 0.001f)
        assertEquals(start.y, arrived.y, 0.001f)
    }

    @Test
    fun releaseRetainsContactUntilLandingButCannotClearAnotherPress() {
        val contact = LiquidContactState()
        val first = Offset(120f, 19f)
        contact.update(first, true)
        contact.release()
        assertEquals(first, contact.positionInWindow)
        val next = Offset(40f, 91f)
        contact.update(next, true)
        contact.clearReleased()
        assertEquals(next, contact.positionInWindow)
        assertTrue(contact.pressed)
        contact.release()
        contact.clearReleased()
        assertNull(contact.positionInWindow)
    }

    @Test
    fun dampingIsIndependentOfDisplayRefreshRate() {
        val results = listOf(60, 90, 120).map { rate ->
            var displayed = 0f
            repeat(rate / 10) { displayed = dampedLiquidPosition(displayed, 240f, 1f / rate) }
            displayed
        }
        assertTrue(results.all { abs(it - results.first()) < 0.001f })
        assertTrue("Small drag lag should have recovered most travel after 100ms", results.first() > 190f)
        assertTrue("The first motion should not snap directly onto the finger", results.first() < 230f)
    }

    @Test
    fun dampingCannotOvershootRailTargetsEvenAfterDirectionChanges() {
        var displayed = 0f
        for (target in listOf(320f, 85f, -4f, 324f, 0f)) {
            repeat(40) {
                val before = displayed
                displayed = dampedLiquidPosition(before, target, 1f / 60)
                assertTrue(displayed in minOf(before, target)..maxOf(before, target))
            }
        }
        assertTrue(abs(displayed) < 0.01f)
    }

    @Test
    fun firstDragFrameMovesOnlyPartOfTheDistance() {
        val first = dampedLiquidPosition(15f, 215f, 1f / 60)
        assertTrue(first > 15f && first < 100f)
        assertEquals(15f, dampedLiquidPosition(15f, 215f, 0f), 0f)
    }
}
