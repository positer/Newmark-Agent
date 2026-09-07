package com.newmark.mobile.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.SystemClock
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
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.platform.graphics.HardwareRendererCompat
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.NewmarkThemeColors
import com.newmark.mobile.ui.theme.ThemeMode
import com.newmark.mobile.vm.DesktopLinkViewModel
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** Actual carrier and tab pixels: transparency, glyph contrast and lift/landing. */
class RightSidebarRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val viewModels = ViewModelStore()
    private val selected = mutableStateOf(RightSidebarTab.Uploads)
    private val commits = mutableListOf<RightSidebarTab>()
    private lateinit var palette: NewmarkThemeColors
    private lateinit var hostView: android.view.View
    private var darkTheme = true
    private var drawingWasEnabled = false

    @Before fun enableRealDrawing() {
        drawingWasEnabled = HardwareRendererCompat.isDrawingEnabled()
        HardwareRendererCompat.setDrawingEnabled(true)
    }

    @After fun releaseResources() {
        compose.runOnIdle { viewModels.clear() }
        HardwareRendererCompat.setDrawingEnabled(drawingWasEnabled)
    }

    private fun mount(dark: Boolean) {
        darkTheme = dark
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val vm = compose.runOnIdle { DesktopLinkViewModel(app).also { viewModels.put("right-rendering", it) } }
        val browserSession = BrowserSessionState()
        compose.setContent {
            hostView = LocalView.current
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(dark, {})) {
                NewmarkTheme(darkTheme = dark) {
                    palette = LocalNewmarkColors.current
                    // Match the wide layout's themed root underneath its
                    // reserved sidebar slot; the production carrier remains
                    // translucent, including behind its header and empty state.
                    Box(Modifier.fillMaxSize().background(palette.bgPrimary).testTag("right-render-canvas")) {
                        Box(Modifier.padding(24.dp).size(300.dp, 360.dp)) {
                            MobileRightSidebar(
                                vm = vm, remoteMode = false, browserSession = browserSession,
                                selectedTab = selected.value, expanded = true,
                                onSelectTab = { selected.value = it; commits.add(it) },
                                modifier = Modifier.testTag("right-render-panel"),
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.waitUntil(5_000) { compose.runOnIdle { hostView.hasWindowFocus() && hostView.isShown } }
        compose.mainClock.autoAdvance = false
    }

    private fun capture(name: String): Bitmap {
        compose.waitForIdle()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // A shown/focused view can still have a cold material frame queued
            // in the emulator's renderer. Wait for that actual submission;
            // Compose's frozen animation clock and pixel assertions stay intact.
            val frameCommitted = CountDownLatch(1)
            val callback = Runnable { frameCommitted.countDown() }
            val root = compose.runOnIdle { hostView.rootView }
            val started = SystemClock.elapsedRealtime()
            compose.runOnIdle {
                root.viewTreeObserver.registerFrameCommitCallback(callback)
                root.invalidate()
            }
            val ready = frameCommitted.await(10, TimeUnit.SECONDS)
            val elapsed = SystemClock.elapsedRealtime() - started
            println("RIGHT_RENDER_FRAME_COMMIT name=$name ready=$ready elapsedMs=$elapsed")
            if (!ready) {
                compose.runOnIdle { root.viewTreeObserver.unregisterFrameCommitCallback(callback) }
            }
            assertTrue("$name must submit the current hardware frame within 10 seconds (waited ${elapsed}ms)", ready)
        }
        val bitmap = compose.onNodeWithTag("right-render-canvas").captureToImage().asAndroidBitmap()
        val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "right-sidebar-render-tests")
        directory.mkdirs()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    private fun difference(actual: Int, expected: Int): Int =
        abs(AndroidColor.red(actual) - AndroidColor.red(expected)) +
            abs(AndroidColor.green(actual) - AndroidColor.green(expected)) +
            abs(AndroidColor.blue(actual) - AndroidColor.blue(expected))

    private fun assertPixel(bitmap: Bitmap, point: Offset, color: Color, reason: String) {
        val actual = bitmap.getPixel(point.x.toInt(), point.y.toInt())
        assertTrue("$reason: actual=${Integer.toHexString(actual)} expected=${Integer.toHexString(color.toArgb())}",
            difference(actual, color.toArgb()) <= 9)
    }

    private fun iconBounds(label: String): Rect = compose.onNodeWithContentDescription(label, useUnmergedTree = true)
        .fetchSemanticsNode().boundsInRoot

    private fun assertGlyph(bitmap: Bitmap, label: String, tint: Color) {
        val bounds = iconBounds(label)
        // Light-theme labels are translucent black. Compare the displayed
        // color after source-over compositing, not the unpainted black RGB.
        val carrier = palette.bgTertiary.copy(alpha = if (darkTheme) .74f else .98f)
            .compositeOver(palette.bgPrimary)
        val renderedTint = tint.compositeOver(carrier)
        var matching = 0
        var total = 0
        for (y in bounds.top.toInt() until bounds.bottom.toInt()) {
            for (x in bounds.left.toInt() until bounds.right.toInt()) {
                total++
                if (difference(bitmap.getPixel(x, y), renderedTint.toArgb()) <= 24) matching++
            }
        }
        val fraction = matching.toFloat() / total.coerceAtLeast(1)
        // Blue-on-blue formerly filled this entire rectangle; a covered or
        // blurred glyph instead has too few pixels of the actual icon tint.
        assertTrue("$label must have a visible, distinct glyph, fraction=$fraction", fraction in 0.06f..0.65f)
    }

    private fun checkTabMaterials(dark: Boolean) {
        mount(dark)
        val prefix = if (dark) "dark" else "light"
        val panel = compose.onNodeWithTag("right-render-panel").fetchSemanticsNode().boundsInRoot
        val rail = compose.onNodeWithTag("right-tab-rail")
        val railBounds = rail.fetchSemanticsNode().boundsInRoot
        val density = railBounds.width / 102f
        val carrier = palette.bgTertiary.copy(alpha = if (dark) .74f else .98f).compositeOver(palette.bgPrimary)
        val idle = capture("$prefix-idle-uploads")
        assertPixel(idle, Offset(4f, 4f), palette.bgPrimary, "capture must contain the current rendered root")
        assertPixel(idle, Offset(panel.right - 20f * density, panel.bottom - 20f * density), carrier,
            "the empty sidebar body must retain its themed carrier")
        if (dark) {
            val pixel = idle.getPixel((panel.right - 20f * density).toInt(), (panel.bottom - 20f * density).toInt())
            assertTrue("dark carrier must not composite into a pale panel", AndroidColor.red(pixel) < 48 &&
                AndroidColor.green(pixel) < 48 && AndroidColor.blue(pixel) < 48)
        }
        compose.onNodeWithTag("right-tab-float").assertDoesNotExist()
        for (index in 0..2) {
            // This point is outside each glyph and inside the rounded button.
            // It detects opaque Transparent, baked glass rims and lost alpha.
            val point = Offset(railBounds.left + (index * 34f + 3f) * density, railBounds.center.y)
            val expected = if (index == 2) palette.accentSoft.compositeOver(carrier) else carrier
            assertPixel(idle, point, expected, "idle tabs must contain only their flat semantic fill")
        }
        assertGlyph(idle, "上传", palette.accent)
        assertGlyph(idle, "计划", palette.textSecondary)

        rail.performTouchInput { down(Offset(5f * density, center.y)) }
        compose.mainClock.advanceTimeBy(800)
        val floatBounds = compose.onNodeWithTag("right-tab-float").fetchSemanticsNode().boundsInRoot
        assertTrue("interaction must raise the existing larger glass envelope", floatBounds.width > 32f * density + 4f)
        val held = capture("$prefix-held-plan")
        assertGlyph(held, "计划", palette.textSecondary)
        val rim = Offset(railBounds.left - 3f * density, railBounds.center.y)
        assertTrue("the raised glass must paint beyond its flat button", difference(
            held.getPixel(rim.x.toInt(), rim.y.toInt()), idle.getPixel(rim.x.toInt(), rim.y.toInt())) > 12)

        rail.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(900)
        assertEquals(RightSidebarTab.Plan, selected.value)
        compose.onNodeWithTag("right-tab-float").assertDoesNotExist()
        val landed = capture("$prefix-landed-plan")
        assertPixel(landed, rim, carrier, "landing must remove the glass envelope completely")
        assertPixel(landed, Offset(railBounds.left + 3f * density, railBounds.center.y),
            palette.accentSoft.compositeOver(carrier), "landing must restore the original translucent color block")
        assertGlyph(landed, "计划", palette.accent)
        assertGlyph(landed, "上传", palette.textSecondary)
    }

    @Test fun darkSidebarKeepsFlatIdleTabsVisibleGlyphsAndInteractionGlass() = checkTabMaterials(true)
    @Test fun lightSidebarKeepsFlatIdleTabsVisibleGlyphsAndInteractionGlass() = checkTabMaterials(false)

    @Test fun physicalIconCenterTapTravelsThenCommitsAndRestoresTheColorBlock() {
        selected.value = RightSidebarTab.Plan
        mount(true)
        // This is a real pointer gesture at the glyph center, not a semantic
        // performClick or a tap in an empty part of the parent rail.
        compose.onNodeWithContentDescription("上传", useUnmergedTree = true)
            .performTouchInput { click(center) }
        compose.mainClock.advanceTimeBy(48)
        compose.onNodeWithTag("right-tab-float").assertExists()
        assertEquals("the source tab stays selected while the lens travels", RightSidebarTab.Plan, selected.value)
        assertTrue("selection cannot commit during the first moving frame", commits.isEmpty())
        compose.mainClock.advanceTimeBy(900)
        assertEquals(listOf(RightSidebarTab.Uploads), commits)
        assertEquals(RightSidebarTab.Uploads, selected.value)
        compose.onNodeWithTag("right-tab-float").assertDoesNotExist()
        val landed = capture("dark-icon-center-click-landed-uploads")
        val rail = compose.onNodeWithTag("right-tab-rail").fetchSemanticsNode().boundsInRoot
        val density = rail.width / 102f
        val carrier = palette.bgTertiary.copy(alpha = .74f).compositeOver(palette.bgPrimary)
        assertPixel(landed, Offset(rail.left + 71f * density, rail.center.y),
            palette.accentSoft.compositeOver(carrier), "a physical icon tap must land as the normal color block")
        assertGlyph(landed, "上传", palette.accent)
    }
}
