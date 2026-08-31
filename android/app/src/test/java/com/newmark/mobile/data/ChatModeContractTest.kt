package com.newmark.mobile.data

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatModeContractTest {
    @Test
    fun chatExposesOnlyWebEvidenceToolsAndRejectsStaleWritesAtExecution() {
        assertEquals(setOf("web_search", "web_fetch", "terminal_exec"), LocalToolCatalog.chatNames)

        val tools = File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        val context = File("src/main/java/com/newmark/mobile/data/LocalContextContract.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val ui = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()

        assertTrue(tools.contains("\"chat\" -> definitions.filter"))
        assertTrue(executor.contains("mode.equals(\"chat\", ignoreCase = true) && name !in LocalToolCatalog.chatNames"))
        assertTrue(executor.contains("Chat 模式仅允许 web_search、web_fetch 与受限 terminal_exec"))
        assertTrue(executor.contains("command !in setOf(\"date\", \"time\", \"now\")"))
        assertTrue(executor.contains("terminal_exec 仅允许 date、time 或 now 获取当前时间"))
        assertTrue(context.contains("first use web_search for online evidence"))
        assertTrue(context.contains("summarize the evidence into a concise answer"))
        assertTrue(viewModel.contains("definitionsFor(getApplication(), mode = mode)"))
        assertTrue(viewModel.contains("executeTool(call.name, call.arguments, mode)"))
        assertTrue(ui.contains("listOf(\"Build\", \"Plan\", \"Chat\")"))
        assertFalse(LocalToolCatalog.chatNames.contains("write_file"))
    }
}
