package com.newmark.mobile.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test

/** Render actual sidebar/settings surfaces in both themes at phone width. */
class CrossPlatformUiRenderingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun sidebarAndProviderDetailsKeepReadableThemeHierarchy() {
        val dark = mutableStateOf(true)
        val providerPage = mutableStateOf(false)
        val provider = ProviderConfig(
            id = "ui-fixture", name = "OpenAI Compatible", baseUrl = "https://example.com/v1",
            models = listOf(ModelConfig(name = "reasoning-model"), ModelConfig(name = "vision-model")),
        )
        compose.setContent {
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(dark.value, {})) {
                NewmarkTheme(darkTheme = dark.value) {
                    Box(Modifier.fillMaxSize().background(LocalNewmarkColors.current.bgPrimary).testTag("surface")) {
                        if (providerPage.value) {
                            ProviderDetailPanel(provider, onSaveEndpoint = {}, onProtocolChange = {},
                                onCreateModel = {}, onDeleteProvider = {}, onToggleModel = {}, onDeleteModel = {})
                        } else {
                            SidebarContent(
                                rail = false, page = SidebarPage.Main, expandedDevice = null,
                                conversations = emptyList(), currentConversationId = null,
                                onToggleDevice = {}, onBack = {}, onOpenSettings = {},
                                onOpenMemoryLab = {}, onOpenTerminal = {}, onNewConversation = {}, onSelectConversation = {},
                            )
                        }
                    }
                }
            }
        }
        for (isDark in listOf(true, false)) for (isProvider in listOf(false, true)) {
            compose.runOnIdle { dark.value = isDark; providerPage.value = isProvider }
            compose.waitForIdle()
            if (isProvider) compose.onNodeWithText("OpenAI Compatible").assertIsDisplayed()
            else compose.onNodeWithText("设置").assertIsDisplayed()
            val rendered = compose.onNodeWithTag("surface").captureToImage()
            val name = "consistency-${if (isDark) "dark" else "light"}-${if (isProvider) "provider" else "sidebar"}.png"
            java.io.File(compose.activity.getExternalFilesDir(null), name).outputStream().use {
                rendered.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }
}
