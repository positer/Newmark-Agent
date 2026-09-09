package com.newmark.mobile.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.ThemeSystemBars
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ThemeIconRenderingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun defaultIconsAndSystemBarsFollowAppThemeBothDirections() {
        val dark = mutableStateOf(true)
        var inherited = Color.Unspecified
        var expected = Color.Unspecified
        compose.setContent {
            ThemeSystemBars(dark.value)
            NewmarkTheme(darkTheme = dark.value) {
                val content = LocalContentColor.current
                val foreground = MaterialTheme.colorScheme.onSurface
                SideEffect { inherited = content; expected = foreground }
                Column(Modifier.background(MaterialTheme.colorScheme.background)) {
                    Icon(LucideIcons.Square, null, Modifier.size(48.dp).testTag("bare"))
                    IconButton(onClick = {}, modifier = Modifier.testTag("button")) {
                        Icon(LucideIcons.Square, null)
                    }
                }
            }
        }
        for (isDark in listOf(true, false, true, false)) {
            compose.runOnIdle { dark.value = isDark }
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(expected, inherited)
                val controller = WindowCompat.getInsetsController(compose.activity.window, compose.activity.window.decorView)
                assertEquals(!isDark, controller.isAppearanceLightStatusBars)
                assertEquals(!isDark, controller.isAppearanceLightNavigationBars)
            }
            for (tag in listOf("bare", "button")) {
                val rendered = compose.onNodeWithTag(tag).captureToImage()
                val output = java.io.File(compose.activity.getExternalFilesDir(null), "theme-$isDark-$tag.png")
                output.outputStream().use {
                    rendered.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
                val pixels = rendered.toPixelMap()
                var contrastingPixels = 0
                for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                    val pixel = pixels[x, y]
                    val brightness = (pixel.red + pixel.green + pixel.blue) / 3f
                    if (if (isDark) brightness > .7f else brightness < .3f) contrastingPixels++
                }
                assertTrue("$tag must render visible strokes in dark=$isDark", contrastingPixels > 20)
            }
        }
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.activityRule.scenario.onActivity { activity ->
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            }
        }
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.runOnIdle {
            val controller = WindowCompat.getInsetsController(compose.activity.window, compose.activity.window.decorView)
            assertTrue(controller.isAppearanceLightStatusBars)
            assertTrue(controller.isAppearanceLightNavigationBars)
        }
    }
}
