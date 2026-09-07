package com.newmark.mobile.ui

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.ThemeMode
import com.newmark.mobile.data.LocalConversation
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Hardware-rendered regression: the shipped APK threw on the first lens frame.
 * These tests exercise real frames, coordinates, and pixels, not source strings. */
class UtilityGlassRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val committed = AtomicInteger(-1)
    private val callbacks = mutableListOf<Int>()
    private fun recordCallback(index: Int) { committed.set(index); callbacks.add(index) }
    private val emptyBackdrop = object : Backdrop {
        override val isCoordinatesDependent = false
        override fun DrawScope.drawBackdrop(density: Density, coordinates: LayoutCoordinates?, layerBlock: (GraphicsLayerScope.() -> Unit)?) = Unit
    }

    private fun mount(rail: Boolean) {
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.size(if (rail) 48.dp else 320.dp, 600.dp)) {
                    SidebarContent(
                        rail = rail, page = SidebarPage.Main, expandedDevice = null,
                        conversations = emptyList(), currentConversationId = null,
                        onToggleDevice = {}, onBack = {}, onOpenSettings = { recordCallback(2) },
                        onOpenMemoryLab = { recordCallback(1) }, onOpenTerminal = { recordCallback(0) },
                        onNewConversation = {}, onSelectConversation = {},
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
    }

    private fun checkClick(rail: Boolean) {
        mount(rail)
        val prefix = if (rail) "collapsed" else "expanded"
        val track = compose.onNodeWithTag("$prefix-utility-rail")
        val bounds = track.fetchSemanticsNode().boundsInRoot
        val textBefore = compose.onNodeWithContentDescription("设置", useUnmergedTree = true)
            .fetchSemanticsNode().boundsInRoot
        track.performTouchInput { click(Offset(center.x, height * 5f / 6f)) }
        compose.mainClock.advanceTimeBy(48)
        val first = compose.onNodeWithTag("$prefix-utility-float").fetchSemanticsNode().boundsInRoot
        assertTrue("first frame must leave the source", first.center.y > bounds.top)
        assertTrue("must travel before arriving", first.center.y < bounds.top + bounds.height * 5f / 6f)
        assertEquals(-1, committed.get())
        compose.mainClock.advanceTimeBy(200)
        val next = compose.onNodeWithTag("$prefix-utility-float").fetchSemanticsNode().boundsInRoot
        assertTrue("selection must move continuously", next.center.y > first.center.y)
        assertEquals("label geometry must stay fixed", textBefore,
            compose.onNodeWithContentDescription("设置", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot)
        assertEquals("navigation cannot unmount the glass during flight", -1, committed.get())
        compose.mainClock.advanceTimeBy(700)
        compose.onNodeWithTag("$prefix-utility-float").assertDoesNotExist()
        assertEquals(2, committed.get())
        // Repeat from last selected option; this used to retain stale jobs.
        track.performTouchInput { click(Offset(center.x, height / 6f)) }
        compose.mainClock.advanceTimeBy(900)
        assertEquals(0, committed.get())
    }

    @Test fun expandedRailTravelsWithoutCrashingOrMovingText() = checkClick(false)
    @Test fun collapsedRailTravelsWithoutCrashingOrMovingText() = checkClick(true)

    @Test fun earlyHoldReleaseFinishesTravelBeforeContraction() {
        mount(false)
        val track = compose.onNodeWithTag("expanded-utility-rail")
        val bounds = track.fetchSemanticsNode().boundsInRoot
        track.performTouchInput { down(Offset(center.x, height * 5f / 6f)) }
        compose.mainClock.advanceTimeBy(336)
        track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(48)
        val travelling = compose.onNodeWithTag("expanded-utility-float").fetchSemanticsNode().boundsInRoot
        assertTrue(travelling.center.y < bounds.top + bounds.height * 5f / 6f)
        assertEquals(-1, committed.get())
        compose.mainClock.advanceTimeBy(128)
        val arrived = compose.onNodeWithTag("expanded-utility-float").fetchSemanticsNode().boundsInRoot
        assertEquals(bounds.top + bounds.height * 5f / 6f, arrived.center.y, 1f)
        assertEquals("arrival is followed by complete contraction", -1, committed.get())
        compose.mainClock.advanceTimeBy(600)
        assertEquals(2, committed.get())
        compose.onNodeWithTag("expanded-utility-float").assertDoesNotExist()
    }

    @Test fun retargetingCancelsOldClickWithoutStaleNavigation() {
        mount(false)
        val track = compose.onNodeWithTag("expanded-utility-rail")
        track.performTouchInput { click(Offset(center.x, height * 5f / 6f)) }
        compose.mainClock.advanceTimeBy(96)
        track.performTouchInput { click(Offset(center.x, height / 2f)) }
        compose.mainClock.advanceTimeBy(900)
        assertEquals("only latest click can navigate", 1, committed.get())
        compose.onNodeWithTag("expanded-utility-float").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(800)
        assertEquals("canceled job cannot fire later", 1, committed.get())
        assertEquals("there must be no earlier stale callback either", listOf(1), callbacks)
    }

    @Test fun opticalSurfacePixelsStayInsideGlassOutline() {
        compose.setContent {
            Box(Modifier.size(100.dp).background(Color.Black).testTag("pixels")) {
                Box(Modifier.size(100.dp).drawBackdrop(
                    backdrop = emptyBackdrop, shape = { CircleShape }, effects = {},
                    highlight = null, shadow = null, innerShadow = null,
                    onDrawSurface = { drawRect(Color.Red) },
                ))
            }
        }
        val bitmap = compose.onNodeWithTag("pixels").captureToImage().asAndroidBitmap()
        assertEquals("surface must be visible", AndroidColor.RED, bitmap.getPixel(bitmap.width / 2, bitmap.height / 2))
        assertEquals("surface/glow must not leak into canvas corners", AndroidColor.BLACK, bitmap.getPixel(2, 2))
        assertEquals(AndroidColor.BLACK, bitmap.getPixel(bitmap.width - 3, bitmap.height - 3))
    }

    @Test fun rightTabsKeepDragOnTrackAndLandAtTheSameEndpoint() {
        val tabs = listOf(RightSidebarTab.Files, RightSidebarTab.Editor, RightSidebarTab.Plan)
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.size(320.dp, 100.dp)) {
                    RightTabs(tabs.first(), tabs, true, { committed.set(tabs.indexOf(it)) }, {})
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val track = compose.onNodeWithTag("right-tab-rail")
        track.performTouchInput { down(Offset(width * 5f / 6f, center.y)) }
        compose.mainClock.advanceTimeBy(760)
        val endpoint = compose.onNodeWithTag("right-tab-float").fetchSemanticsNode().boundsInRoot
        track.performTouchInput { moveTo(Offset(width * 2f, center.y)) }
        compose.mainClock.advanceTimeBy(48)
        val dragged = compose.onNodeWithTag("right-tab-float").fetchSemanticsNode().boundsInRoot
        assertEquals("endpoint uses the actual tab width, not a stale 44dp float", endpoint.center.x, dragged.center.x, 1f)
        assertEquals(endpoint.center.y, dragged.center.y, 1f)
        track.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(800)
        compose.onNodeWithTag("right-tab-float").assertDoesNotExist()
        assertEquals(2, committed.get())
    }

    @Test fun conversationGlassTravelsGlowsInsideAndOverlapsTheAdjacentRowUntilLanding() = checkConversationContact(dark = true)
    @Test fun lightConversationGlassTracksOffCenterContactAndLands() = checkConversationContact(dark = false)

    private fun checkConversationContact(dark: Boolean) {
        val selected = mutableStateOf("a")
        val selectionCallbacks = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(dark, {})) {
            NewmarkTheme(darkTheme = dark) {
                Box(Modifier.padding(24.dp).size(320.dp, 600.dp).background(Color.Black).testTag("conversation-pixels")) {
                    SidebarContent(
                        rail = false, page = SidebarPage.Main, expandedDevice = null,
                        conversations = listOf(LocalConversation("a", "A"), LocalConversation("b", "B"), LocalConversation("c", "C")),
                        currentConversationId = selected.value,
                        onToggleDevice = {}, onBack = {}, onOpenSettings = {},
                        onOpenMemoryLab = {}, onOpenTerminal = {}, onNewConversation = {},
                        onSelectConversation = { selected.value = it; selectionCallbacks.add(it) },
                    )
                }
            }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        val source = compose.onNodeWithTag("local-conversation-row-a").fetchSemanticsNode().boundsInRoot
        val target = compose.onNodeWithTag("local-conversation-row-c").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithText("C").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(48)
        val first = compose.onNodeWithTag("local-conversation-glass").fetchSemanticsNode().boundsInRoot
        assertTrue("conversation click must visibly travel from its old selection", first.center.y > source.center.y && first.center.y < target.center.y)
        compose.mainClock.advanceTimeBy(96)
        val next = compose.onNodeWithTag("local-conversation-glass").fetchSemanticsNode().boundsInRoot
        assertTrue(next.center.y > first.center.y)
        assertTrue("selection callback waits for complete landing", selectionCallbacks.isEmpty())
        compose.mainClock.advanceTimeBy(700)
        assertEquals(listOf("c"), selectionCallbacks)
        compose.onNodeWithTag("local-conversation-glass").assertDoesNotExist()

        val surface = compose.onNodeWithTag("conversation-pixels")
        val surfaceBounds = surface.fetchSemanticsNode().boundsInRoot
        val baseline = surface.captureToImage().asAndroidBitmap()
        val dpScale = baseline.width / 320f
        val rowB = compose.onNodeWithTag("local-conversation-row-b").fetchSemanticsNode().boundsInRoot
        val rowC = compose.onNodeWithTag("local-conversation-row-c").fetchSemanticsNode().boundsInRoot
        val labelB = compose.onNodeWithText("B")
        val labelBounds = labelB.fetchSemanticsNode().boundsInRoot
        val physicalContact = labelBounds.topLeft + Offset(labelBounds.width * .2f, labelBounds.height / 2f)
        labelB.performTouchInput { down(Offset(labelBounds.width * .2f, center.y)) }
        compose.mainClock.advanceTimeBy(800)
        val glass = compose.onNodeWithTag("local-conversation-glass").fetchSemanticsNode().boundsInRoot
        val held = surface.captureToImage().asAndroidBitmap()
        fun luminance(bitmap: android.graphics.Bitmap, x: Float, y: Float): Int {
            val color = bitmap.getPixel((x - surfaceBounds.left).toInt(), (y - surfaceBounds.top).toInt())
            return (AndroidColor.red(color) + AndroidColor.green(color) + AndroidColor.blue(color)) / 3
        }
        // The finger is on the left-hand label, far from the wide float's
        // center. Sample bare material beside it, avoiding the glyph itself.
        val nearContact = luminance(held, physicalContact.x + 20f * dpScale, physicalContact.y)
        val farInterior = luminance(held, physicalContact.x + 92f * dpScale, physicalContact.y)
        val evidence = java.io.File(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "pointer-glow-tests")
        evidence.mkdirs()
        java.io.File(evidence, "conversation-${if (dark) "dark" else "light"}-held.png").outputStream().use { held.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        java.io.File(evidence, "conversation-${if (dark) "dark" else "light"}-before.png").outputStream().use { baseline.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        println("CONVERSATION_GLOW dark=$dark finger=$physicalContact glass=$glass label=${labelB.fetchSemanticsNode().boundsInRoot} surface=$surfaceBounds near=$nearContact far=$farInterior scale=$dpScale")
        // Screen-blended light has less absolute headroom over a bright theme.
        // At 20dp from a 66dp/24% contact source, require at least 10% of the
        // remaining luminance range, rather than a dark-theme-only byte delta.
        assertTrue("conversation glass must light the actual off-center finger", nearContact - farInterior > (255 - farInterior) * .10f)
        for (offset in listOf(-20f, 0f, 20f)) {
            val x = glass.center.x + offset * dpScale
            val y = glass.top - 10f * dpScale
            assertTrue("the halo must not brighten pixels outside the glass (ordinary dark shadow is allowed)",
                luminance(held, x, y) <= luminance(baseline, x, y) + 4)
        }

        // Move enough to overlap C, while remaining in B's reorder slot so C
        // stays underneath the float and cannot escape the layer-order check.
        labelB.performTouchInput { moveTo(center + Offset(0f, rowB.height * .4f)) }
        compose.mainClock.advanceTimeBy(96)
        val overlap = compose.onNodeWithTag("local-conversation-glass").fetchSemanticsNode().boundsInRoot
        val dragged = surface.captureToImage().asAndroidBitmap()
        java.io.File(evidence, "conversation-${if (dark) "dark" else "light"}-dragged.png").outputStream().use { dragged.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        // The original raised edge already overlaps C by 7dp. Compare a
        // point beyond that old edge, which only the dragged glass now covers.
        val seamY = maxOf(rowC.top + 11f * dpScale, glass.bottom + 4f * dpScale)
        assertTrue("comparison must be outside the old glass", seamY > glass.bottom)
        assertTrue("glass must overlap the next row's painted body", overlap.bottom > seamY)
        // A uniform white row can legitimately remain almost unchanged when
        // seen through transparent frost. Its newly overlapping front rim,
        // however, must remain visibly painted over the neighboring row.
        var compared = 0
        var visiblyChanged = 0
        val stripTop = overlap.bottom - 2f * dpScale
        val stripBottom = overlap.bottom - 1f
        assertTrue("the front rim must be beyond the old glass", stripTop > glass.bottom)
        for (y in stripTop.toInt() until stripBottom.toInt()) {
            for (x in (overlap.center.x - 20f * dpScale).toInt()..(overlap.center.x + 20f * dpScale).toInt()) {
                compared++
                if (kotlin.math.abs(luminance(dragged, x.toFloat(), y.toFloat()) - luminance(held, x.toFloat(), y.toFloat())) > 8) visiblyChanged++
            }
        }
        println("CONVERSATION_OVERLAP dark=$dark before=$glass after=$overlap changed=$visiblyChanged compared=$compared")
        assertTrue("new overlap must expose enough real pixels to compare", compared > 100)
        assertTrue("the neighboring row must not conceal the active glass", visiblyChanged > compared / 5)
        labelB.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(80)
        compose.onNodeWithTag("local-conversation-glass").assertExists()
        compose.mainClock.advanceTimeBy(800)
        compose.onNodeWithTag("local-conversation-glass").assertDoesNotExist()
        assertEquals("a reorder gesture must not trigger a new conversation selection", listOf("c"), selectionCallbacks)
    }
}
