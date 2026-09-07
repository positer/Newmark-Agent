package com.newmark.mobile.ui

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.platform.graphics.HardwareRendererCompat
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.ThemeMode
import java.io.File
import kotlin.math.abs
import org.junit.Before
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real constrained sidebar layouts, including overflow pixels and both color endpoints. */
class ConversationLiftRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val selected = mutableStateOf("a")
    private val order = mutableStateOf(listOf("a", "b", "c"))
    private val callbacks = mutableListOf<String>()
    private lateinit var prefix: String
    private lateinit var hostView: android.view.View
    private var drawingWasEnabled = false

    @Before fun enableRealDrawing() {
        // Instrumentation disables hardware drawing by default. Keep it on
        // for the full visual test, not only during a screenshot callback.
        drawingWasEnabled = HardwareRendererCompat.isDrawingEnabled()
        HardwareRendererCompat.setDrawingEnabled(true)
    }

    @After fun restoreDrawingMode() {
        HardwareRendererCompat.setDrawingEnabled(drawingWasEnabled)
    }

    private fun mount(remote: Boolean) {
        prefix = if (remote) "remote" else "local"
        compose.setContent {
            hostView = LocalView.current
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(true, {})) {
                NewmarkTheme(darkTheme = true) {
                    Box(Modifier.fillMaxSize().background(Color(0xFF203040)).testTag("lift-canvas")) {
                        Box(Modifier.padding(24.dp).size(280.dp, 600.dp).testTag("lift-panel")) {
                            if (remote) WorkspaceConversationsSidebar(
                                conversations = order.value.map { RemoteConversation(it, it.uppercase()) },
                                activeConversationId = selected.value,
                                onBack = {},
                                onSelectConversation = { selected.value = it; callbacks.add(it) },
                                onReorderConversations = { order.value = it },
                            ) else SidebarContent(
                                rail = false, page = SidebarPage.Main, expandedDevice = null,
                                conversations = order.value.map { LocalConversation(it, it.uppercase()) },
                                currentConversationId = selected.value,
                                onToggleDevice = {}, onBack = {}, onOpenSettings = {},
                                onOpenMemoryLab = {}, onOpenTerminal = {}, onNewConversation = {},
                                onSelectConversation = { selected.value = it; callbacks.add(it) },
                                onReorderLocal = { order.value = it },
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        // The Compose tree can be idle before a newly launched Android
        // window becomes visible/focused. Do not start a frozen-clock gesture
        // during that native activity transition.
        println("CONVERSATION_WINDOW $prefix focused=${hostView.hasWindowFocus()} shown=${hostView.isShown}")
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.runOnIdle { hostView.hasWindowFocus() && hostView.isShown }
        }
        compose.mainClock.autoAdvance = false
    }

    private fun row(id: String) = compose.onNodeWithTag("$prefix-conversation-row-$id").fetchSemanticsNode().boundsInRoot
    private fun floatBounds(): Rect? = compose.onAllNodesWithTag("$prefix-conversation-glass")
        .fetchSemanticsNodes().singleOrNull()?.boundsInRoot
    private fun save(name: String, bitmap: Bitmap) {
        val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "pointer-glow-tests")
        directory.mkdirs()
        File(directory, "$prefix-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun captureSettledCanvas(canvas: SemanticsNodeInteraction): Bitmap {
        // Hardware drawing stays enabled through mount, hold and capture.
        // PixelCopy explicitly waits for the current frame to commit.
        compose.waitForIdle()
        return canvas.captureToImage().asAndroidBitmap()
    }

    private fun checkClickEndpoints(remote: Boolean) {
        mount(remote)
        val source = row("a")
        val target = row("c")
        compose.onNodeWithText("C").performTouchInput { click() }
        val frames = mutableListOf<Rect>()
        repeat(48) {
            compose.mainClock.advanceTimeByFrame()
            floatBounds()?.let { frames.add(it) }
        }
        assertTrue("the flight must render multiple real frames", frames.size >= 10)
        val first = frames.first()
        val last = frames.last()
        println("CONVERSATION_ENDPOINTS $prefix source=$source target=$target first=$first last=$last maxWidth=${frames.maxOf { it.width }}")
        assertEquals("takeoff keeps the original color's left edge", source.left, first.left, 1.5f)
        assertEquals("takeoff keeps the original color's right edge", source.right, first.right, 1.5f)
        assertEquals("takeoff starts at the old selected row", source.center.y, first.center.y, 1.5f)
        assertTrue("the float must grow beyond the original row", frames.maxOf { it.width } > source.width + 40f)
        assertTrue("expanded frames must never acquire a negative centering offset", frames.all { it.left >= source.left - 1.5f })
        assertEquals("landing restores the target color's left edge", target.left, last.left, 1.5f)
        assertEquals("landing restores the target color's right edge", target.right, last.right, 1.5f)
        assertEquals("landing reaches the new row before disappearing", target.center.y, last.center.y, 1.5f)
        assertEquals(listOf("c"), callbacks)
        assertNull(floatBounds())
    }

    private fun checkRaisedAndReordered(remote: Boolean) {
        mount(remote)
        val source = row("b")
        val target = row("c")
        val label = compose.onNodeWithText("B")
        val textBefore = label.fetchSemanticsNode().boundsInRoot
        val canvas = compose.onNodeWithTag("lift-canvas")
        val before = captureSettledCanvas(canvas)
        val panel = compose.onNodeWithTag("lift-panel").fetchSemanticsNode().boundsInRoot
        val density = panel.width / 280f
        label.performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(800)
        val raised = requireNotNull(floatBounds())
        val held = captureSettledCanvas(canvas)
        save("lift-before", before)
        save("lift-held", held)
        println("CONVERSATION_RIGHT_LIFT $prefix source=$source raised=$raised panel=$panel density=$density")
        assertEquals("raised left edge sits 2dp to the right of its source", source.left + 2f * density, raised.left, 1.5f)
        assertEquals("the full 28dp envelope is retained", source.width + 28f * density, raised.width, 2f)
        assertEquals("lifting cannot deform or move the title", textBefore, label.fetchSemanticsNode().boundsInRoot)
        assertTrue("the right rim is outside the narrow panel", raised.right > panel.right + 4f * density)
        assertTrue("the full lens remains inside the visible canvas", raised.left >= 0f && raised.right < held.width)
        // The rightmost center arc must actually paint outside the sidebar;
        // an unclipped semantics rectangle alone does not prove visibility.
        val x = (raised.right - 2f * density).toInt()
        val y = raised.center.y.toInt()
        fun difference(a: Int, b: Int) = abs(AndroidColor.red(a) - AndroidColor.red(b)) +
            abs(AndroidColor.green(a) - AndroidColor.green(b)) + abs(AndroidColor.blue(a) - AndroidColor.blue(b))
        assertEquals("baseline must be the rendered canvas, not an old/blank window",
            AndroidColor.rgb(32, 48, 64), before.getPixel(x, y))
        assertTrue("the expanded right rim must not be clipped by the panel", difference(held.getPixel(x, y), before.getPixel(x, y)) > 24)

        // Many individually sub-slop moves must still count as one real drag
        // when the row follows the finger. Inject in the stationary canvas's
        // coordinates, not in the moving label's changing coordinate frame.
        repeat(12) { step ->
            canvas.performTouchInput {
                moveTo(textBefore.center + Offset(0f, source.height * 1.1f * (step + 1) / 12f))
            }
            compose.mainClock.advanceTimeBy(32)
        }
        compose.mainClock.advanceTimeBy(160)
        canvas.performTouchInput { up() }
        val landing = mutableListOf<Rect>()
        repeat(48) {
            compose.mainClock.advanceTimeByFrame()
            floatBounds()?.let { landing.add(it) }
        }
        assertTrue("release must animate into its landing", landing.size >= 5)
        val last = landing.last()
        println("CONVERSATION_REORDER_LANDING $prefix target=$target last=$last order=${order.value}")
        assertEquals(target.left, last.left, 1.5f)
        assertEquals(target.right, last.right, 1.5f)
        assertEquals(target.center.y, last.center.y, 1.5f)
        assertEquals(listOf("a", "c", "b"), order.value)
        assertTrue("reordering must not change selection", callbacks.isEmpty())
        assertEquals("a", selected.value)
        assertNull(floatBounds())
    }

    @Test fun localClickKeepsBothColorEndpoints() = checkClickEndpoints(false)
    @Test fun remoteClickKeepsBothColorEndpoints() = checkClickEndpoints(true)
    @Test fun localLiftShowsItsRightRimAndReorderLandsExactly() = checkRaisedAndReordered(false)
    @Test fun remoteLiftShowsItsRightRimAndReorderLandsExactly() = checkRaisedAndReordered(true)
}
