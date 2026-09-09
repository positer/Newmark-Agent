package com.newmark.mobile.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.newmark.mobile.ui.theme.NewmarkTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class MarkdownCodeRenderingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun check(role: String) {
        val first = "val raw = \"<tag>& value\"\n" + "x".repeat(90)
        val second = "echo second"
        val dark = mutableStateOf(true)
        compose.setContent {
            NewmarkTheme(darkTheme = dark.value) {
                Box(Modifier.fillMaxSize().testTag("code-chat")) {
                    ChatScreen(title = "Code review", items = listOf(ChatItem.Bubble(role,
                        "```kotlin\n$first\n```\n\n```\n$second\n```")),
                        isSending = false, showMenuButton = true, onMenuClick = {}, onNewChat = {}, onSend = {})
                }
            }
        }
        for (isDark in listOf(true, false)) {
            compose.runOnIdle { dark.value = isDark }
            compose.waitForIdle()
            val blocks = compose.onAllNodesWithTag("markdown-code-block").fetchSemanticsNodes()
            assertEquals(2, blocks.size)
            val root = compose.onNodeWithTag("code-chat").fetchSemanticsNode().boundsInRoot
            val density = compose.activity.resources.displayMetrics.density
            blocks.forEach { block ->
                assertTrue("Code avoids left timeline", block.boundsInRoot.left > root.left + 42.dpPixels(density))
                assertTrue("Code avoids right timeline", block.boundsInRoot.right < root.right - 42.dpPixels(density))
            }
            val clipboard = compose.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            listOf(first, second).forEachIndexed { index, expected ->
                compose.onAllNodesWithTag("markdown-copy-code")[index].performClick()
                compose.runOnIdle { assertEquals(expected, clipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
            }
            val bitmap = compose.onNodeWithTag("code-chat").captureToImage()
            val native = bitmap.asAndroidBitmap()
            File(compose.activity.getExternalFilesDir(null), "code-$role-${if(isDark) "dark" else "light"}.png")
                .outputStream().use { native.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    private fun Int.dpPixels(density: Float) = this * density
    @Test fun assistantCodeCopiesIndependentlyAndAvoidsBothRails() = check("assistant")
    @Test fun userCodeCopiesIndependentlyAndAvoidsBothRails() = check("user")
}
