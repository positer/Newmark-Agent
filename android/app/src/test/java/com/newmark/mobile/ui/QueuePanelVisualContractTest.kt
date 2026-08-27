package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QueuePanelVisualContractTest {
    @Test
    fun queuedConversationButtonsAreBorderlessAndUseNewmarkFeedback() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val queueSection = source.substring(
            source.indexOf("private fun QueuePanel("),
            source.indexOf("private fun StackIconButton("),
        )

        assertTrue(queueSection.contains("private fun QueueIconButton("))
        assertTrue(queueSection.contains("indication = null"))
        assertTrue(queueSection.contains("background(tint.copy(alpha = if (pressed) 0.15f else 0f))"))
        assertFalse(queueSection.contains("Text(\"排队对话\""))
        assertTrue(queueSection.contains("\"\${items.size} 条待处理\""))
        assertFalse(queueSection.contains("glassButtonSurface("))
        assertFalse(queueSection.contains(".border("))
        assertFalse(queueSection.contains("StackIconButton("))
    }
}
