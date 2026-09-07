package com.newmark.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.ui.components.ProviderCapsuleRow
import com.newmark.mobile.ui.components.ProviderProtocolRail
import com.newmark.mobile.ui.components.ProviderVerticalCapsuleRail
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.liquidPopupShell
import com.newmark.mobile.ui.theme.NewmarkTheme
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Device-rendered geometry and gesture checks for both provider rail axes. */
class ProviderGlassRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val committed = AtomicInteger(-1)

    private fun mount(horizontal: Boolean, barrier: Boolean = false) {
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.padding(24.dp).size(320.dp, 360.dp)) {
                    if (horizontal) {
                        ProviderProtocolRail(
                            options = (0..3).map { "$it" to "Option $it" },
                            value = "0",
                            onValueChange = { committed.set(it.toInt()) },
                        )
                    } else {
                        ProviderVerticalCapsuleRail(
                            itemCount = if (barrier) 5 else 3,
                            selectedIndex = 0,
                            horizontalBarrierIndices = if (barrier) setOf(2) else emptySet(),
                            onSelected = { committed.set(it) },
                        ) { index ->
                            if (barrier && index == 2) {
                                ProviderProtocolRail(
                                    options = listOf("a" to "A", "b" to "B"),
                                    value = "a", onValueChange = {},
                                )
                            } else ProviderCapsuleRow("Option $index", active = index == 0)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
    }

    private fun assertUniformEnvelope(expectedNominal: Rect, actual: Rect, dpScale: Float) {
        val edge = 12f * dpScale
        assertEquals("left expands by 12dp", edge, expectedNominal.left - actual.left, 1.5f)
        assertEquals("right expands by 12dp", edge, actual.right - expectedNominal.right, 1.5f)
        assertEquals("top expands by 12dp", edge, expectedNominal.top - actual.top, 1.5f)
        assertEquals("bottom expands by 12dp", edge, actual.bottom - expectedNominal.bottom, 1.5f)
    }

    private fun checkHeldEnvelope(horizontal: Boolean) {
        mount(horizontal)
        val prefix = if (horizontal) "provider-protocol" else "provider-vertical"
        val track = compose.onNodeWithTag("$prefix-rail")
        val nominal = track.fetchSemanticsNode().boundsInRoot
        val textBefore = compose.onNodeWithText("Option 0").fetchSemanticsNode().boundsInRoot
        // Hold the original option to isolate optical expansion from travel.
        track.performTouchInput { down(if (horizontal) Offset(width / 8f, center.y) else Offset(center.x, height * 22f / 144f)) }
        compose.mainClock.advanceTimeBy(800)
        val glass = compose.onNodeWithTag("$prefix-glass").fetchSemanticsNode().boundsInRoot
        val dpScale = if (horizontal) nominal.height / 44f else nominal.height / 144f
        val block = Rect(nominal.left, nominal.top, nominal.left + if (horizontal) nominal.width / 4f else nominal.width, nominal.top + 44f * dpScale)
        assertUniformEnvelope(block, glass, dpScale)
        assertEquals("text layout stays fixed", textBefore, compose.onNodeWithText("Option 0").fetchSemanticsNode().boundsInRoot)
        assertEquals("a held option cannot commit", -1, committed.get())
        track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(80)
        assertEquals("release must finish movement then contraction", -1, committed.get())
        compose.mainClock.advanceTimeBy(800)
        compose.onNodeWithTag("$prefix-glass").assertDoesNotExist()
        assertEquals(0, committed.get())
    }

    @Test fun verticalGlassHasEqualOutwardEdgesAndFixedText() = checkHeldEnvelope(false)
    @Test fun horizontalGlassHasEqualOutwardEdgesAndFixedText() = checkHeldEnvelope(true)

    @Test fun horizontalQuickHoldReleaseTravelsToPressedOptionThenContracts() {
        mount(horizontal = true)
        val track = compose.onNodeWithTag("provider-protocol-rail")
        track.performTouchInput { down(Offset(width * 7f / 8f, center.y)) }
        compose.mainClock.advanceTimeBy(336)
        track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(64)
        assertEquals("early release must not commit or discard the flight", -1, committed.get())
        compose.onNodeWithTag("provider-protocol-glass").assertExists()
        compose.mainClock.advanceTimeBy(700)
        assertEquals("quick hold must commit its pressed option", 3, committed.get())
        compose.onNodeWithTag("provider-protocol-glass").assertDoesNotExist()
    }

    @Test fun verticalTapAcrossHorizontalBarrierFinishesBothSegmentsBeforeCommit() {
        mount(horizontal = false, barrier = true)
        val track = compose.onNodeWithTag("provider-vertical-rail")
        track.performTouchInput { click(Offset(center.x, height * 222f / 244f)) }
        compose.mainClock.advanceTimeBy(800)
        assertEquals("crossing requires two complete travel-and-land segments", -1, committed.get())
        compose.onNodeWithTag("provider-vertical-glass").assertExists()
        compose.mainClock.advanceTimeBy(900)
        assertEquals(4, committed.get())
        compose.onNodeWithTag("provider-vertical-glass").assertDoesNotExist()
    }

    private fun checkContentPixelsStayFixed(popup: Boolean) {
        val externallyPressed = mutableStateOf(false)
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.padding(24.dp).size(120.dp).background(Color.Black).testTag("direct-pixels")) {
                    val material = if (popup) Modifier.liquidPopupShell(
                        shape = RoundedCornerShape(26.dp),
                        externalPressed = externallyPressed.value,
                        externalDragOffset = if (externallyPressed.value) Offset(40f, 40f) else Offset.Zero,
                    ) else Modifier.glassButtonSurface(CircleShape)
                    Box(Modifier.size(120.dp).then(material).testTag("direct-button"), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.Text("Fixed", color = Color.Cyan, fontSize = 20.sp, modifier = Modifier.testTag("fixed-content"))
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val content = compose.onNodeWithTag("fixed-content").fetchSemanticsNode().boundsInRoot
        val before = compose.onNodeWithTag("direct-pixels").captureToImage().asAndroidBitmap()
        val button = compose.onNodeWithTag("direct-button")
        val shellBefore = button.fetchSemanticsNode().boundsInRoot
        button.performTouchInput { down(center) }
        compose.runOnIdle { externallyPressed.value = true }
        compose.mainClock.advanceTimeBy(160)
        button.performTouchInput { moveTo(center + Offset(40f, 40f)) }
        compose.mainClock.advanceTimeBy(32)
        val movedContent = compose.onNodeWithTag("fixed-content").fetchSemanticsNode().boundsInRoot
        val shellAfter = button.fetchSemanticsNode().boundsInRoot
        if (popup) {
            val sx = shellAfter.width / shellBefore.width
            val sy = shellAfter.height / shellBefore.height
            assertTrue("popup must apply real visible expansion", sx > 1.01f && sy > 1.01f)
            assertTrue("popup content must follow the shell translation", (movedContent.center - content.center).getDistance() > 2f)
            assertEquals(shellAfter.left + (content.left - shellBefore.left) * sx, movedContent.left, 1f)
            assertEquals(shellAfter.top + (content.top - shellBefore.top) * sy, movedContent.top, 1f)
            assertEquals(content.width * sx, movedContent.width, 1f)
            assertEquals(content.height * sy, movedContent.height, 1f)
        } else assertEquals("ordinary glass buttons keep fixed content semantics", content, movedContent)
        val after = compose.onNodeWithTag("direct-pixels").captureToImage().asAndroidBitmap()
        var contentPixels = 0
        var opticalPixelsChanged = 0
        var oldX = 0.0; var oldY = 0.0; var newX = 0.0; var newY = 0.0; var newCount = 0
        for (y in 0 until before.height) for (x in 0 until before.width) {
            if (before.getPixel(x, y) == android.graphics.Color.CYAN) {
                contentPixels++
                oldX += x; oldY += y
                if (!popup) assertEquals("ordinary button pixels remain fixed", android.graphics.Color.CYAN, after.getPixel(x, y))
            } else if (before.getPixel(x, y) != after.getPixel(x, y)) opticalPixelsChanged++
            if (after.getPixel(x, y) == android.graphics.Color.CYAN) { newX += x; newY += y; newCount++ }
        }
        assertTrue("the fixed content must really be rendered", contentPixels > 20)
        assertTrue("the test must exercise visible glass motion", opticalPixelsChanged > 20)
        if (popup) {
            assertTrue("transformed content must still be painted", newCount > 20)
            val pixelDelta = Offset((newX / newCount - oldX / contentPixels).toFloat(), (newY / newCount - oldY / contentPixels).toFloat())
            val expectedDelta = movedContent.center - content.center
            assertEquals("painted text follows the shell on X", expectedDelta.x, pixelDelta.x, 2f)
            assertEquals("painted text follows the shell on Y", expectedDelta.y, pixelDelta.y, 2f)
            println("POPUP_CONTENT_TRANSFORM shell=$shellAfter content=$movedContent pixelDelta=$pixelDelta")
        }
        button.performTouchInput { up() }
        compose.runOnIdle { externallyPressed.value = false }
        compose.mainClock.advanceTimeBy(300)
        assertEquals("content returns with the released popup", content, compose.onNodeWithTag("fixed-content").fetchSemanticsNode().boundsInRoot)
    }

    @Test fun directGlassButtonsDeformOnlyOpticsAndKeepContentPixelsFixed() = checkContentPixelsStayFixed(popup = false)
    @Test fun popupExternalDragMovesContentAndGlassWithTheSameTransform() = checkContentPixelsStayFixed(popup = true)

    @Test fun graphPopupContentPressesTogetherWithoutFollowingPan() {
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.padding(24.dp).size(220.dp).testTag("graph-popup-input")) {
                    Box(Modifier.size(220.dp).liquidPopupShell(shape = RoundedCornerShape(24.dp), dragEnabled = false), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.Text("Graph content", modifier = Modifier.testTag("graph-popup-content"))
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val input = compose.onNodeWithTag("graph-popup-input")
        val content = compose.onNodeWithTag("graph-popup-content")
        val before = content.fetchSemanticsNode().boundsInRoot
        input.performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(160)
        val pressed = content.fetchSemanticsNode().boundsInRoot
        assertTrue("graph popup content must participate in press elasticity", pressed.width > before.width * 1.01f)
        input.performTouchInput { moveTo(center + Offset(50f, 40f)) }
        compose.mainClock.advanceTimeBy(160)
        assertEquals("graph pan must not pull the popup around", pressed, content.fetchSemanticsNode().boundsInRoot)
        input.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(200)
        assertEquals(before, content.fetchSemanticsNode().boundsInRoot)
    }

    @Test fun memoryPagerQuickHoldReleaseFinishesOneFlightBeforeCommitting() {
        val commits = AtomicInteger(0)
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.padding(24.dp)) {
                    MemoryLabViewPager(view = "overview") {
                        committed.set(if (it == "detail") 1 else 0)
                        commits.incrementAndGet()
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val track = compose.onNodeWithTag("memory-view-rail")
        val labelBefore = compose.onNodeWithText("详细").fetchSemanticsNode().boundsInRoot
        track.performTouchInput { down(Offset(width * .75f, center.y)) }
        compose.mainClock.advanceTimeBy(336)
        track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithTag("memory-view-glass").assertExists()
        assertEquals("early release must not prematurely commit", 0, commits.get())
        assertEquals(labelBefore, compose.onNodeWithText("详细").fetchSemanticsNode().boundsInRoot)
        compose.mainClock.advanceTimeBy(800)
        assertEquals(1, committed.get())
        assertEquals("the cancelled held job must not commit a second time", 1, commits.get())
        compose.onNodeWithTag("memory-view-glass").assertDoesNotExist()
        // A canceled hold must not finish later after hiding its glass.
        track.performTouchInput { down(Offset(width * .75f, center.y)) }
        compose.mainClock.advanceTimeBy(336)
        track.performTouchInput { cancel() }
        compose.mainClock.advanceTimeBy(800)
        assertEquals(1, commits.get())
        compose.onNodeWithTag("memory-view-glass").assertDoesNotExist()
    }
}
