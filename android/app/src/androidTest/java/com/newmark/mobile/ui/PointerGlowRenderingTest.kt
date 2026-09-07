package com.newmark.mobile.ui

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.newmark.mobile.ui.components.ProviderCapsuleRow
import com.newmark.mobile.ui.components.ProviderProtocolRail
import com.newmark.mobile.ui.components.ProviderVerticalCapsuleRail
import com.newmark.mobile.ui.theme.NewmarkTheme
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real contact-light pixels, deliberately independent of internal contact state. */
class PointerGlowRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val selected = mutableStateOf(0)
    private val commits = mutableListOf<Int>()

    private data class Rail(
        val horizontal: Boolean,
        val track: SemanticsNodeInteraction,
        val bounds: Rect,
        val glassTag: String,
        val density: Float,
    ) {
        fun axis(point: Offset) = if (horizontal) point.x else point.y
        fun atAxis(point: Offset, value: Float) = if (horizontal) Offset(value, point.y) else Offset(point.x, value)
    }

    private fun mount(horizontal: Boolean): Rail {
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.size(320.dp, 220.dp).background(Color.Black).testTag("pointer-pixels").padding(24.dp)) {
                    if (horizontal) ProviderProtocolRail(
                        options = (0..3).map { "$it" to "" }, value = selected.value.toString(),
                        onValueChange = { selected.value = it.toInt(); commits.add(it.toInt()) },
                    ) else ProviderVerticalCapsuleRail(
                        itemCount = 3, selectedIndex = selected.value,
                        onSelected = { selected.value = it; commits.add(it) },
                    ) { index -> ProviderCapsuleRow("", active = index == selected.value) }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val prefix = if (horizontal) "provider-protocol" else "provider-vertical"
        val track = compose.onNodeWithTag("$prefix-rail")
        val bounds = track.fetchSemanticsNode().boundsInRoot
        return Rail(horizontal, track, bounds, "$prefix-glass", bounds.height / if (horizontal) 44f else 144f)
    }

    private fun glass(rail: Rail) = compose.onNodeWithTag(rail.glassTag).fetchSemanticsNode().boundsInRoot

    private fun frame(name: String): Bitmap {
        val bitmap = compose.onNodeWithTag("pointer-pixels").captureToImage().asAndroidBitmap()
        val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "pointer-glow-tests")
        directory.mkdirs()
        val file = File(directory, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("POINTER_GLOW_FRAME=${file.absolutePath}")
        return bitmap
    }

    private fun luminance(bitmap: Bitmap, point: Offset): Float {
        val bounds = compose.onNodeWithTag("pointer-pixels").fetchSemanticsNode().boundsInRoot
        val x = ((point.x - bounds.left) * bitmap.width / bounds.width).toInt().coerceIn(1, bitmap.width - 2)
        val y = ((point.y - bounds.top) * bitmap.height / bounds.height).toInt().coerceIn(1, bitmap.height - 2)
        var total = 0f
        for (dy in -1..1) for (dx in -1..1) {
            val color = bitmap.getPixel(x + dx, y + dy)
            total += (AndroidColor.red(color) + AndroidColor.green(color) + AndroidColor.blue(color)) / 3f
        }
        return total / 9f
    }

    private fun lightPeak(rail: Rail, bitmap: Bitmap, outline: Rect, pointer: Offset): Float {
        val inset = 8f * rail.density
        val from = (if (rail.horizontal) outline.left else outline.top) + inset
        val to = (if (rail.horizontal) outline.right else outline.bottom) - inset
        val samples = (from.toInt()..to.toInt()).map { it.toFloat() to luminance(bitmap, rail.atAxis(pointer, it.toFloat())) }
        val maximum = samples.maxOf { it.second }
        return samples.filter { it.second >= maximum - .35f }.map { it.first }.average().toFloat()
    }

    private fun offAxisContact(horizontal: Boolean) {
        val rail = mount(horizontal)
        val prefix = if (horizontal) "horizontal" else "vertical"
        val original = if (horizontal) Offset(rail.bounds.width / 8f, rail.bounds.height / 2f)
            else Offset(rail.bounds.width / 2f, 22f * rail.density)
        val offAxis = if (horizontal) Offset(0f, 12f * rail.density) else Offset(12f * rail.density, 0f)
        rail.track.performTouchInput { down(original - offAxis) }
        compose.mainClock.advanceTimeBy(800)
        val outline = glass(rail)
        val first = frame("$prefix-off-axis-negative")
        val negative = rail.bounds.topLeft + original - offAxis
        val positive = rail.bounds.topLeft + original + offAxis
        val firstContrast = luminance(first, negative) - luminance(first, positive)
        rail.track.performTouchInput { moveTo(original + offAxis) }
        compose.mainClock.advanceTimeBy(96)
        val secondOutline = glass(rail)
        val second = frame("$prefix-off-axis-positive")
        val secondContrast = luminance(second, positive) - luminance(second, negative)
        println("POINTER_GLOW_OFF_AXIS axis=$prefix negativeContrast=$firstContrast positiveContrast=$secondContrast")
        assertEquals("off-axis contact must not move the carrier off its rail", rail.axis(outline.center), rail.axis(secondOutline.center), 1.5f)
        if (horizontal) assertEquals(outline.center.y, secondOutline.center.y, 1.5f)
        else assertEquals(outline.center.x, secondOutline.center.x, 1.5f)
        assertTrue("negative off-axis finger must illuminate its own side: $firstContrast", firstContrast > 4f)
        assertTrue("positive off-axis finger must illuminate its own side: $secondContrast", secondContrast > 4f)
        rail.track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(900)
        assertEquals(listOf(0), commits)
    }

    @Test fun horizontalGlowUsesFingerYInsteadOfRailCenter() = offAxisContact(true)
    @Test fun verticalGlowUsesFingerXInsteadOfRailCenter() = offAxisContact(false)

    private fun stationaryFingerDuringPickup(horizontal: Boolean) {
        val rail = mount(horizontal)
        val prefix = if (horizontal) "horizontal" else "vertical"
        val localPointer = if (horizontal) Offset(rail.bounds.width * 7f / 8f, rail.bounds.height / 2f - 8f * rail.density)
            else Offset(rail.bounds.width / 2f - 8f * rail.density, 122f * rail.density)
        val pointer = rail.bounds.topLeft + localPointer
        rail.track.performTouchInput { down(localPointer) }
        compose.mainClock.advanceTimeBy(320)
        var sampled: Rect? = null
        for (step in 0 until 35) {
            compose.mainClock.advanceTimeByFrame()
            val outline = glass(rail)
            val gap = rail.axis(pointer) - rail.axis(outline.center)
            if (gap in 12f * rail.density..20f * rail.density) { sampled = outline; break }
        }
        assertNotNull("pickup must expose a real in-flight frame near the unchanged finger", sampled)
        val firstOutline = sampled!!
        val first = frame("$prefix-stationary-finger-flight-a")
        val firstPeak = lightPeak(rail, first, firstOutline, pointer)
        compose.mainClock.advanceTimeByFrame()
        val secondOutline = glass(rail)
        val second = frame("$prefix-stationary-finger-flight-b")
        val secondPeak = lightPeak(rail, second, secondOutline, pointer)
        println("POINTER_GLOW_STATIONARY axis=$prefix pointer=${rail.axis(pointer)} firstPeak=$firstPeak secondPeak=$secondPeak firstCarrier=${rail.axis(firstOutline.center)} secondCarrier=${rail.axis(secondOutline.center)}")
        assertTrue("the carrier must really advance while no MOVE event is sent", rail.axis(secondOutline.center) > rail.axis(firstOutline.center) + 1f)
        assertEquals("first flight frame must light the stationary screen-space finger", rail.axis(pointer), firstPeak, 5f * rail.density)
        assertEquals("next flight frame must remap the unchanged finger after carrier movement", rail.axis(pointer), secondPeak, 5f * rail.density)
        assertTrue("holding cannot commit navigation", commits.isEmpty())
        rail.track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(900)
        assertEquals(listOf(if (horizontal) 3 else 2), commits)
    }

    @Test fun horizontalPickupRemapsStationaryFingerOnEveryRenderedFrame() = stationaryFingerDuringPickup(true)
    @Test fun verticalPickupRemapsStationaryFingerOnEveryRenderedFrame() = stationaryFingerDuringPickup(false)

    @Test fun horizontalDragHasLightDampingWhileGlowStillFollowsRawFinger() {
        val rail = mount(true)
        val start = Offset(rail.bounds.width / 8f, rail.bounds.height / 2f - 8f * rail.density)
        rail.track.performTouchInput { down(start) }
        compose.mainClock.advanceTimeBy(800)
        val original = glass(rail)
        val end = start + Offset(40f * rail.density, 0f)
        val pointer = rail.bounds.topLeft + end
        rail.track.performTouchInput { moveTo(end) }
        compose.mainClock.advanceTimeBy(32)
        val following = glass(rail)
        val first = frame("horizontal-damped-drag-a")
        val peak = lightPeak(rail, first, following, pointer)
        val movement = following.center.x - original.center.x
        println("POINTER_GLOW_DAMPING rawDelta=${end.x-start.x} visibleDelta=$movement pointer=${pointer.x} lightPeak=$peak")
        assertTrue("drag response must advance within two frames", movement > 1f)
        assertTrue("the visible carrier must have a small real following lag", movement < end.x - start.x - 2f)
        assertEquals("glow follows the raw finger while the carrier lags", pointer.x, peak, 5f * rail.density)
        compose.mainClock.advanceTimeBy(64)
        val caughtUp = glass(rail)
        val second = frame("horizontal-damped-drag-b")
        assertTrue(caughtUp.center.x > following.center.x)
        assertEquals("stationary finger remains absolute as damping catches up", pointer.x, lightPeak(rail, second, caughtUp, pointer), 5f * rail.density)
        rail.track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(64)
        assertTrue("release may not commit before travel and landing", commits.isEmpty())
        compose.onNodeWithTag(rail.glassTag).assertExists()
        compose.mainClock.advanceTimeBy(900)
        assertEquals(listOf(1), commits)
        compose.onNodeWithTag(rail.glassTag).assertDoesNotExist()
    }
}
