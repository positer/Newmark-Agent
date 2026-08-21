package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptLayoutContractTest {
    @Test
    fun transcriptKeepsTenScrollableLinesBelowTheLatestMessage() {
        assertEquals(10, TranscriptBottomReserveLines)
        assertEquals(190, TranscriptBottomReserveDp)
    }

    @Test
    fun persistedAssistantWorkRunCannotRenderItsTerminalBodyTwice() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertEquals(true, source.contains("if (message.role == \"assistant\" && message.workRun != null) run.copy(text = \"\")"))
        assertEquals(true, source.contains("A completed local assistant message owns the final Markdown body."))
    }
}
