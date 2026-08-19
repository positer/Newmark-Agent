package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LocalQueueContractTest {
    @Test
    fun thousandItemPausedQueueEditsGuidesAndDrainsExactlyOnceInFifoOrder() {
        var queue = emptyList<LocalQueuedMessage>()
        repeat(1_000) { index ->
            queue = LocalQueueContract.enqueue(queue, LocalQueuedMessage("id-$index", "next-$index", createdAt = index.toLong()))
        }
        queue = LocalQueueContract.update(queue, "id-500", "edited-500")
        queue = LocalQueueContract.delete(queue, "id-700")

        val (pausedItem, pausedQueue) = LocalQueueContract.dequeue(queue, paused = true, running = false)
        assertNull(pausedItem)
        assertEquals(queue, pausedQueue)

        val rejectedGuide = LocalQueueContract.consumeAcceptedGuide(queue, "id-250", accepted = false)
        assertEquals(queue, rejectedGuide)
        queue = LocalQueueContract.consumeAcceptedGuide(queue, "id-250", accepted = true)
        queue = LocalQueueContract.consumeAcceptedGuide(queue, "id-250", accepted = true)

        val drained = mutableListOf<String>()
        while (queue.isNotEmpty()) {
            val (item, remaining) = LocalQueueContract.dequeue(queue, paused = false, running = false)
            drained += requireNotNull(item).id
            queue = remaining
        }

        assertEquals(998, drained.size)
        assertEquals("id-0", drained.first())
        assertEquals("id-999", drained.last())
        assertEquals("edited-500", LocalQueueContract.update(listOf(LocalQueuedMessage("id-500", "old")), "id-500", "edited-500").single().text)
        assertEquals(1, drained.count { it == "id-500" })
        assertEquals(0, drained.count { it == "id-250" || it == "id-700" })
    }

    @Test
    fun runningQueueDoesNotDrainUntilRuntimeIsIdle() {
        val queue = listOf(LocalQueuedMessage("next", "wait"))
        val (duringRun, retained) = LocalQueueContract.dequeue(queue, paused = false, running = true)
        assertNull(duringRun)
        assertEquals(queue, retained)
        val (afterRun, empty) = LocalQueueContract.dequeue(queue, paused = false, running = false)
        assertEquals("next", afterRun?.id)
        assertEquals(emptyList<LocalQueuedMessage>(), empty)
    }

    @Test
    fun reorderUsesStableIdsAndRejectsPartialDuplicateOrForeignOrders() {
        val queue = listOf(
            LocalQueuedMessage("a", "first"),
            LocalQueuedMessage("b", "second"),
            LocalQueuedMessage("c", "third"),
        )

        assertEquals(
            listOf("c", "a", "b"),
            LocalQueueContract.reorder(queue, listOf("c", "a", "b")).map { it.id },
        )
        assertEquals(queue, LocalQueueContract.reorder(queue, listOf("a", "b")))
        assertEquals(queue, LocalQueueContract.reorder(queue, listOf("a", "a", "c")))
        assertEquals(queue, LocalQueueContract.reorder(queue, listOf("a", "b", "foreign")))
    }
}
