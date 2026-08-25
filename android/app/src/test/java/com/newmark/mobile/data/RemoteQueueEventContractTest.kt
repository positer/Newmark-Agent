package com.newmark.mobile.data

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * dev-0.5.6 queue export regression contract.
 *
 * The PC kernel broadcasts `queue_update` work events with structured
 * `queueItems` (stable kernel ids) + `queuePaused`. The mobile client parses
 * those fields from SSE and mirrors the remote queue without a manual refresh.
 */
class RemoteQueueEventContractTest {

    @Test
    fun queueUpdateEventCarriesStructuredQueueRows() {
        val event = Gson().fromJson(
            """{
              "id":"evt-1",
              "conversationId":"conv-1",
              "type":"queue_update",
              "workspaceId":"ws-1",
              "runId":"run-live",
              "queue":{"steering":[],"followUp":["[Next queued while current turn is running]\nhello"]},
              "queueItems":[{"id":"mobile-uuid-123","text":"hello","queueMode":"followUp","requestedMode":"build"}],
              "queuePaused":false
            }""".trimIndent(),
            RemoteWorkEvent::class.java,
        )

        assertEquals("queue_update", event.type)
        assertTrue(event.queue?.followUp?.single()?.contains("hello") == true)
        assertEquals("mobile-uuid-123", event.queueItems?.single()?.id)
        assertEquals("hello", event.queueItems?.single()?.text)
        assertEquals(false, event.queuePaused)
    }

    @Test
    fun queueUpdateEventNormalizesOmittedFields() {
        val event = Gson().fromJson(
            """{"id":"evt-2","type":"queue_update","queueItems":[{"id":"a","text":"x"}]}""".trimIndent(),
            RemoteWorkEvent::class.java,
        )
        val normalized = RemotePayloadNormalizer.workEvent(event)

        assertEquals("a", normalized.queueItems?.single()?.id)
        assertEquals("x", normalized.queueItems?.single()?.text)
        assertEquals("followUp", normalized.queueItems?.single()?.queueMode)
        // Omitted queue/queuePaused stay null so the SSE reducer can fall back.
        assertEquals(null, normalized.queue)
        assertEquals(null, normalized.queuePaused)
        assertFalse(normalized.queueItems.orEmpty().isEmpty())
    }

    @Test
    fun queueItemsListNormalizerPreservesEveryRow() {
        val rows = listOf(
            RemoteQueueItem(id = "a", text = "one"),
            RemoteQueueItem(id = "b", text = "two", queueMode = "followUp"),
        )
        val normalized = RemotePayloadNormalizer.queueItems(rows)
        assertEquals(2, normalized.size)
        assertEquals("one", normalized[0].text)
        assertEquals("two", normalized[1].text)
    }

    @Test
    fun explicitEmptyQueueItemsClearsStaleRows() {
        val current = RemoteConversationUiState(
            queueItems = listOf(RemoteQueueItem(id = "stale", text = "already drained")),
            queued = RemoteConversationQueue(followUp = listOf("already drained")),
            queuePaused = true,
            runtime = RemoteRuntimeState(running = true, runId = "run-live"),
        )
        val event = RemoteWorkEvent(
            type = "queue_update",
            runId = "run-live",
            queue = RemoteConversationQueue(),
            queueItems = emptyList(),
            queuePaused = false,
        )

        val updated = RemotePayloadNormalizer.queueUpdateState(current, event)
        assertTrue(updated != null)
        assertTrue(updated!!.queueItems.isEmpty())
        assertTrue(updated.queued.followUp.isEmpty())
        assertFalse(updated.queuePaused)
    }

    @Test
    fun omittedStructuredRowsRemainOmittedAndStaleRunsAreRejected() {
        val omitted = RemotePayloadNormalizer.workEvent(
            RemoteWorkEvent(type = "queue_update", runId = "run-live", queue = RemoteConversationQueue()),
        )
        assertEquals(null, omitted.queueItems)

        val current = RemoteConversationUiState(
            queueItems = listOf(RemoteQueueItem(id = "current", text = "keep")),
            runtime = RemoteRuntimeState(running = true, runId = "run-current"),
        )
        val stale = RemoteWorkEvent(
            type = "queue_update",
            runId = "run-old",
            queueItems = emptyList(),
        )
        assertEquals(null, RemotePayloadNormalizer.queueUpdateState(current, stale))
        assertEquals("current", current.queueItems.single().id)
    }
}
