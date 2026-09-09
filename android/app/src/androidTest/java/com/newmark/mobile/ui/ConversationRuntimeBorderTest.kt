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
import com.newmark.mobile.ui.components.liquidGlassModifier
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
class ConversationRuntimeBorderTest {
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

    private val running = mutableStateOf(true)
    private fun mount(remote: Boolean, dark: Boolean) {
        prefix = if (remote) "remote" else "local"
        compose.mainClock.autoAdvance = false
        compose.setContent {
            hostView = LocalView.current
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(dark, {})) {
                NewmarkTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(Color(0xFF203040)).testTag("lift-canvas")) {
                        UnclippedSidebarDrawer(
                            Modifier.padding(24.dp).size(280.dp, 600.dp).testTag("lift-panel"),
                            surfaceModifier = Modifier.liquidGlassModifier(cornerRadius = 0.dp, edgeHighlight = false),
                        ) {
                            if (remote) WorkspaceConversationsSidebar(
                                conversations = order.value.map { RemoteConversation(it, it.uppercase(), running = running.value && it == "a") },
                                activeConversationId = selected.value,
                                onBack = {},
                                onSelectConversation = { selected.value = it; callbacks.add(it) },
                                onReorderConversations = { assertEquals("remote IDs stay unique", it.size, it.toSet().size); order.value = it },
                            ) else SidebarContent(
                                rail = false, page = SidebarPage.Main, expandedDevice = null,
                                conversations = order.value.map { LocalConversation(it, it.uppercase()) },
                                currentConversationId = selected.value,
                                runningLocalConversationIds = if (running.value) setOf("a") else emptySet(),
                                onToggleDevice = {}, onBack = {}, onOpenSettings = {},
                                onOpenMemoryLab = {}, onOpenTerminal = {}, onNewConversation = {},
                                onSelectConversation = { selected.value = it; callbacks.add(it) },
                                onReorderLocal = { assertEquals("local IDs stay unique", it.size, it.toSet().size); order.value = it },
                            )
                        }
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(320)
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


    private fun check(remote: Boolean, dark: Boolean) {
        mount(remote, dark)
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "runtime-border-tests").apply { mkdirs() }
        fun snapshot(label: String): Bitmap {
            compose.mainClock.advanceTimeBy(32)
            compose.waitForIdle()
            val bitmap = compose.onNodeWithTag("$prefix-conversation-row-a").captureToImage().asAndroidBitmap()
            File(dir, "$prefix-${if(dark) "dark" else "light"}-$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            return bitmap
        }
        val first = snapshot("running-0")
        compose.mainClock.advanceTimeBy(720)
        val next = snapshot("running-750")
        fun difference(a: Bitmap, b: Bitmap): Int {
            var count = 0
            for(y in 0 until minOf(a.height,b.height)) for(x in 0 until minOf(a.width,b.width)) if(a.getPixel(x,y) != b.getPixel(x,y)) count++
            return count
        }
        assertTrue("live border moves", difference(first,next) > 50)
        compose.runOnUiThread { running.value = false }
        val stopped = snapshot("stopped")
        assertTrue("completion removes border", difference(next,stopped) > 50)
        compose.mainClock.advanceTimeBy(750)
        val still = snapshot("stopped-later")
        assertEquals("idle capsule has no animation", 0, difference(stopped,still))
    }
    @Test fun localDark() = check(false, true)
    @Test fun localLight() = check(false, false)
    @Test fun remoteDark() = check(true, true)
    @Test fun remoteLight() = check(true, false)
}
