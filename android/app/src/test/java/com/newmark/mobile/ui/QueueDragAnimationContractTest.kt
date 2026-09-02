package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import java.io.File
import org.junit.Test

class QueueDragAnimationContractTest {
    @Test
    fun targetChangesOnlyAfterCrossingHalfOfTheNextRow() {
        assertEquals(1, queueDragTargetIndex(1, 19f, 40f, 4))
        assertEquals(2, queueDragTargetIndex(1, 21f, 40f, 4))
        assertEquals(0, queueDragTargetIndex(1, -21f, 40f, 4))
    }

    @Test
    fun targetIsClampedToTheVisibleQueue() {
        assertEquals(3, queueDragTargetIndex(1, 400f, 40f, 4))
        assertEquals(0, queueDragTargetIndex(2, -400f, 40f, 4))
    }

    @Test
    fun neighboringRowsMoveIntoTheSourceGapWithoutReorderingMidGesture() {
        assertEquals(0f, queueRowDisplacementPx(0, 0, 2, 40f))
        assertEquals(-40f, queueRowDisplacementPx(1, 0, 2, 40f))
        assertEquals(-40f, queueRowDisplacementPx(2, 0, 2, 40f))
        assertEquals(0f, queueRowDisplacementPx(3, 0, 2, 40f))

        assertEquals(40f, queueRowDisplacementPx(0, 2, 0, 40f))
        assertEquals(40f, queueRowDisplacementPx(1, 2, 0, 40f))
        assertEquals(0f, queueRowDisplacementPx(2, 2, 0, 40f))
    }

    @Test
    fun rowActionsOwnShortTapsWhileOnlyTheHandleOwnsLongPressDrag() {
        val source = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val queueRow = source.substringAfter("private fun QueueRow(").substringBefore("private fun QueueIconButton(")
        val beforeHandle = queueRow.substringBefore("Modifier\n                .size(width = 16.dp, height = 24.dp)")
        val handle = queueRow.substringAfter("Modifier\n                .size(width = 16.dp, height = 24.dp)")
            .substringBefore("Spacer(Modifier.width(5.dp))")

        assertFalse(beforeHandle.contains("detectDragGesturesAfterLongPress("))
        assertTrue(handle.contains("detectDragGesturesAfterLongPress("))
        assertTrue(queueRow.contains("QueueIconButton(LucideIcons.ArrowRight, \"立即 Guide\""))
    }
}
