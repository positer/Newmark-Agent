package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileResponseRecoveryTest {
    @Test
    fun onlyFiveConsecutiveEmptyResponsesReachTerminalLimit() {
        var streak = 0
        repeat(MAX_EMPTY_RESPONSE_RETRIES) {
            streak = nextEmptyResponseStreak(streak, usable = false)
            assertTrue(streak <= MAX_EMPTY_RESPONSE_RETRIES)
        }
        streak = nextEmptyResponseStreak(streak, usable = false)
        assertEquals(MAX_CONSECUTIVE_EMPTY_RESPONSES, streak)
        assertEquals(200L, emptyResponseRetryDelayMs(1))
        assertEquals(800L, emptyResponseRetryDelayMs(2))
        assertEquals(2_000L, emptyResponseRetryDelayMs(3))
        assertEquals(10_000L, emptyResponseRetryDelayMs(4))
        assertEquals(60_000L, emptyResponseRetryDelayMs(5))
    }

    @Test
    fun anyThoughtTextOrToolCallClearsTheStreak() {
        assertEquals(0, nextEmptyResponseStreak(4, usable = true))
        val text = ChatResponse(content = "正文")
        val thought = ChatResponse(reasoningContent = "思考中")
        val tool = ChatResponse(toolCalls = listOf(ToolCall("id", "tool", "{}")))
        assertTrue(isUsableChatResponse(text))
        assertTrue(isUsableChatResponse(thought))
        assertTrue(isUsableChatResponse(tool))
        assertEquals(0, nextEmptyResponseStreak(4, isUsableChatResponse(thought)))
        assertFalse(isUsableChatResponse(ChatResponse()))
    }

    @Test
    fun emptyTransportFailuresAreRetryableButOrdinaryFailuresAreNot() {
        assertTrue(isEmptyResponseFailure(IllegalStateException("Provider returned an empty response")))
        assertFalse(isEmptyResponseFailure(IllegalStateException("Empty response body")))
        assertFalse(isEmptyResponseFailure(IllegalStateException("Responses stream ended before response.completed")))
        assertFalse(isEmptyResponseFailure(java.io.EOFException("unexpected end of stream")))
        assertFalse(isEmptyResponseFailure(IllegalStateException("HTTP 401: invalid api key")))
    }

    @Test
    fun providerClientMustNotSwallowCoroutineCancellation() {
        val source = java.io.File("src/main/java/com/newmark/mobile/data/ApiClient.kt").readText()
        assertTrue(source.contains("if (error is CancellationException) throw error"))
    }
}
