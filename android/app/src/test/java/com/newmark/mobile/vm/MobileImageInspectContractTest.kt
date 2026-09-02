package com.newmark.mobile.vm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobileImageInspectContractTest {
    @Test
    fun imageInspectUsesValidatedEphemeralVisionInputWithFrozenDeployment() {
        val tools = File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val catalog = File("src/main/java/com/newmark/mobile/data/LocalToolCatalog.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()

        assertTrue(tools.contains("\"image_inspect\""))
        assertTrue(catalog.contains("\"image_inspect\""))
        assertTrue(executor.contains("private suspend fun imageInspect"))
        assertTrue(executor.contains("10L * 1024L * 1024L"))
        assertTrue(executor.contains("40_000_000L"))
        assertTrue(executor.contains("mime !in setOf(\"image/png\", \"image/jpeg\")"))
        assertTrue(executor.contains("runtimeTool?.invoke(\"__image_visual_read\""))
        assertTrue(viewModel.contains("\"__image_visual_read\" -> readImageWithVision"))
        assertTrue(viewModel.contains("config = turnConfig"))
        assertTrue(viewModel.contains("thinkingTierMap = turnThinkingTierMap"))
        assertTrue(viewModel.contains("imageAttachments = listOf(attachment)"))
        assertFalse(executor.contains("ToolResult.ok(dataUrl"))
    }
}
