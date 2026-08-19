package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalContextContractTest {
    @Test
    fun pcBudgetUsesSeventyPercentBuildAndTwentyPercentLongHistoryThresholds() {
        val budget = LocalContextContract.budget(listOf(ChatMessage("user", "x".repeat(4000))), 10_000)
        assertEquals(7_000, budget.buildBlockTriggerTokens)
        assertEquals(2_000, budget.longHistoryTriggerTokens)
        assertEquals(1_200, budget.summaryTokens)
    }

    @Test
    fun retentionStartsAtACompleteUserTurnAndAlwaysKeepsTheLatestInstruction() {
        val messages = listOf(
            ChatMessage("user", "old"), ChatMessage("assistant", "old answer"),
            ChatMessage("tool", "large".repeat(200)), ChatMessage("user", "latest"),
            ChatMessage("assistant", "working"),
        )
        val retained = LocalContextContract.recentContextSuffix(messages, 3, 128)
        assertEquals("user", retained.first().role)
        assertTrue(retained.any { it.content == "latest" })
    }

    @Test
    fun fallbackSummaryIsBoundedAndCarriesPcCompressionMarker() {
        val omitted = List(2_000) { ChatMessage(if (it % 2 == 0) "user" else "assistant", "payload-$it".repeat(20)) }
        val summary = LocalContextContract.fallbackSummary(omitted, 256)
        assertTrue(summary.startsWith("[Context Compression Fallback]"))
        assertTrue(summary.length <= 1_700)
    }

    @Test
    fun tenThousandMessageHistoryRetainsLatestCompleteTurnWithinBudget() {
        val messages = List(10_000) { index ->
            ChatMessage(
                role = if (index % 2 == 0) "user" else "assistant",
                content = "message-$index-${"x".repeat(80)}",
            )
        }
        val retained = LocalContextContract.recentContextSuffix(
            messages = messages,
            maxMessages = 48,
            tokenBudget = 4_096,
        )
        assertTrue(retained.size <= 48)
        assertEquals("user", retained.first().role)
        assertTrue(retained.any { it.content.startsWith("message-9998-") })
        assertTrue(LocalContextContract.estimateTokens(retained) <= 4_096)
    }

    @Test
    fun enormousToolResultProducesBoundedFallbackAndCompressedWindowDropsBelowTrigger() {
        val omitted = listOf(
            ChatMessage("user", "inspect the build"),
            ChatMessage("assistant", "calling tool"),
            ChatMessage("tool", "tool-result-".repeat(200_000)),
        )
        val retained = listOf(
            ChatMessage("user", "latest instruction"),
            ChatMessage("assistant", "continuing"),
        )
        val summary = LocalContextContract.fallbackSummary(omitted, 512)
        val source = LocalContextContract.summarySource(omitted, 32_000)
        val compressed = listOf(
            ChatMessage("system", summary),
            LocalContextContract.continuationAnchor(),
        ) + retained
        assertTrue(summary.length <= 3_000)
        assertTrue(source.length <= 32_000)
        assertTrue(source.contains("latest instruction").not())
        assertTrue(!LocalContextContract.budget(compressed, 16_384).thresholdReached)
        assertEquals("latest instruction", compressed[2].content)
    }
}
