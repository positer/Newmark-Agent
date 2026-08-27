package com.newmark.mobile.data

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileThoughtContinuationTest {
    @Test
    fun oneThousandThoughtOnlyRoundsStayInOnePublicNode() {
        val events = mutableListOf<LocalWorkEvent>()
        var sequence = 0L
        val lifecycle = MobileThoughtContinuation(events) { type, content, durationMs ->
            LocalWorkEvent(
                type = type,
                id = "${sequence++}:$type",
                content = content,
                sequence = sequence,
                durationMs = durationMs,
            )
        }

        repeat(1_000) { index ->
            val created = lifecycle.beginRound(index.toLong())
            assertEquals(index == 0, created)
            lifecycle.endRound("reasoning-$index")
        }

        assertEquals(1, events.size)
        assertEquals(1, events.count { it.type == "thought" })
        assertTrue(events.single().content.startsWith("reasoning-0\n\nreasoning-1"))
        assertTrue(events.single().content.endsWith("reasoning-999"))

        events += requireNotNull(lifecycle.finish(1_500L))
        val projected = WorkRunProjection.project(events, runStatus = "running")
        val thought = projected.filterIsInstance<WorkRunProjection.Item.Thought>().single().event
        assertTrue(thought.completed)
        assertEquals(events.first().content, thought.content)
        assertEquals(1_500L, thought.durationMs)
    }

    @Test
    fun streamedAndFinalReasoningAreNotDuplicated() {
        val events = mutableListOf<LocalWorkEvent>()
        var sequence = 0L
        val lifecycle = MobileThoughtContinuation(events) { type, content, durationMs ->
            LocalWorkEvent(type = type, id = "${sequence++}:$type", content = content, durationMs = durationMs)
        }

        lifecycle.beginRound(100L)
        lifecycle.appendRoundDelta("first thought")
        lifecycle.endRound("first thought")
        lifecycle.beginRound(200L)
        lifecycle.appendRoundDelta("second")
        lifecycle.endRound("second thought completed")

        assertEquals("first thought\n\nsecond thought completed", events.single().content)
        assertFalse(events.single().completed)

        events += requireNotNull(lifecycle.finish(350L))
        val thought = WorkRunProjection.project(events, "completed")
            .filterIsInstance<WorkRunProjection.Item.Thought>()
            .single()
            .event
        assertEquals("first thought\n\nsecond thought completed", thought.content)
        assertEquals(250L, thought.durationMs)
    }

    @Test
    fun shorterOrIncompatibleFinalReasoningNeverRewindsStreamedProgress() {
        val events = mutableListOf<LocalWorkEvent>()
        var sequence = 0L
        val lifecycle = MobileThoughtContinuation(events) { type, content, durationMs ->
            LocalWorkEvent(type = type, id = "${sequence++}:$type", content = content, durationMs = durationMs)
        }

        lifecycle.beginRound(100L)
        lifecycle.appendRoundDelta("a long streamed reasoning path")
        lifecycle.endRound("short summary")

        assertEquals("a long streamed reasoning path", events.single().content)

        lifecycle.beginRound(200L)
        lifecycle.appendRoundDelta(" followed by more progress")
        lifecycle.endRound("followed")

        assertEquals(
            "a long streamed reasoning path followed by more progress",
            events.single().content,
        )
    }

    @Test
    fun aRealBoundaryAllowsTheNextRoundToCreateANewThought() {
        val events = mutableListOf<LocalWorkEvent>()
        var sequence = 0L
        val lifecycle = MobileThoughtContinuation(events) { type, content, durationMs ->
            LocalWorkEvent(type = type, id = "${sequence++}:$type", content = content, durationMs = durationMs)
        }

        lifecycle.beginRound(10L)
        lifecycle.endRound("before tool")
        events += requireNotNull(lifecycle.finish(20L))
        events += LocalWorkEvent(type = "tool_call", id = "tool", toolName = "read")
        assertTrue(lifecycle.beginRound(30L))
        lifecycle.endRound("after tool")
        events += requireNotNull(lifecycle.finish(50L))

        val thoughts = WorkRunProjection.project(events, "completed")
            .filterIsInstance<WorkRunProjection.Item.Thought>()
        assertEquals(2, thoughts.size)
        assertEquals(listOf("before tool", "after tool"), thoughts.map { it.event.content })
        assertTrue(thoughts.all { it.event.completed })
    }

    @Test
    fun thoughtOnlyProgressChangesTheNextRequestWithoutEnteringDurableMessages() {
        val durable = mutableListOf(ChatMessage(role = "user", content = "original task", messageId = "user-1"))
        val continuation = MobileThoughtRequestContinuation(maxCheckpointChars = 256)

        assertTrue(continuation.requestMessages(durable) === durable)
        continuation.recordRound("checked the first branch")
        val nextRequest = continuation.requestMessages(durable)

        assertEquals(1, durable.size)
        assertEquals("user-1", durable.single().messageId)
        assertEquals(2, nextRequest.size)
        assertEquals("assistant", nextRequest.last().role)
        assertEquals(MobileThoughtRequestContinuation.INTERNAL_MESSAGE_ID, nextRequest.last().messageId)
        assertEquals("", nextRequest.last().content)
        assertEquals("checked the first branch", nextRequest.last().reasoningContent)

        continuation.clear()
        assertTrue(continuation.requestMessages(durable) === durable)
    }

    @Test
    fun oneThousandContinuationRoundsStayBoundedAndRetainTheLatestProgress() {
        val continuation = MobileThoughtRequestContinuation(maxCheckpointChars = 512)
        repeat(1_000) { index -> continuation.recordRound("unique-progress-$index") }

        val checkpoint = continuation.checkpointForTest()
        val request = continuation.requestMessages(listOf(ChatMessage("user", "task")))
        assertTrue(checkpoint.length <= 512)
        assertTrue(checkpoint.contains("unique-progress-999"))
        assertEquals(2, request.size)
        assertEquals("", request.last().content)
        assertEquals(checkpoint, request.last().reasoningContent)
        assertTrue(request.last().reasoningContent.length <= 512)
    }

    @Test
    fun requestReasoningStateIsNeverPersistedAsConversationHistory() {
        val message = ChatMessage(
            role = "assistant",
            content = "",
            reasoningContent = "provider-private-checkpoint",
        )

        val json = Gson().toJson(message)
        assertFalse(json.contains("reasoningContent"))
        assertFalse(json.contains("provider-private-checkpoint"))
    }
}
