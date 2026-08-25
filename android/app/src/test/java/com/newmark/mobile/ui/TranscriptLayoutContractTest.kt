package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun scrollToBottomTargetsTheReserveRowPastAnyBuildBlockTail() {
        // 3 chat rows + no sending -> reserve row is index 3 (past the last block).
        assertEquals(3, transcriptEndIndex(3, false))
        // 3 chat rows + ThinkingDots -> reserve row is index 4.
        assertEquals(4, transcriptEndIndex(3, true))
        // Empty transcript (welcome row only) still resolves to a valid index.
        assertEquals(0, transcriptEndIndex(0, false))
    }

    @Test
    fun chatContentScrollsToEndIndexAndDetectsBottomAtLastRowOnly() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        // The button and auto-follow both target the reserve row, not the last
        // ChatItem, so a tall Build block cannot leave its tail below the fold.
        assertTrue(source.contains("listState.scrollToItem(transcriptEndIndex)"))
        // "At bottom" requires the very last row visible, not the second-to-last.
        assertTrue(source.contains("lastVisible.index >= info.totalItemsCount - 1"))
        assertFalse(source.contains("lastVisible.index >= info.totalItemsCount - 2"))
    }
}