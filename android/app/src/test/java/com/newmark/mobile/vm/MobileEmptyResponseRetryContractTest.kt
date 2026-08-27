package com.newmark.mobile.vm

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobileEmptyResponseRetryContractTest {
    @Test
    fun agentLoopRetriesFiveTimesOnlyAfterExplicitEmptyResponses() {
        val source = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        assertTrue(source.contains("chatWithEmptyRecovery"))
        assertTrue(source.contains("MAX_CONSECUTIVE_EMPTY_RESPONSES"))
        assertTrue(source.contains("EmptyResponseLimitException"))
        assertTrue(source.contains("模型明确返回空响应后已重试 \$MAX_EMPTY_RESPONSE_RETRIES 次"))
        assertTrue(source.contains("A stream that emitted visible text but then failed"))
        assertTrue(source.contains("val responseResult = try"))
        assertTrue(source.contains("chatWithEmptyRecovery("))
        assertTrue(source.contains("deltaPublisher.flushAndClose()"))
        assertTrue(Regex("apiClient\\.chat\\(").findAll(source).count() == 1)
        val recovery = File("src/main/java/com/newmark/mobile/data/MobileResponseRecovery.kt").readText()
        assertTrue(recovery.contains("const val MAX_EMPTY_RESPONSE_RETRIES = 5"))
        assertTrue(recovery.contains("200L, 800L, 2_000L, 10_000L, 60_000L"))
        assertTrue(recovery.contains("message.contains(\"provider returned an empty response\")"))
        assertTrue(recovery.contains("if (usable) 0"))
        assertTrue(source.contains("delay(emptyResponseRetryDelayMs(emptyStreak))"))
        assertTrue(!source.contains("150L * emptyStreak"))
        assertTrue(recovery.contains("response.reasoningContent.isNotBlank()"))
        assertTrue(source.contains("var observedThought = false"))
        assertTrue(source.contains("if (observedThought)"))
        assertTrue(source.contains("return Result.success(response)"))
        assertTrue(source.contains("resp.content.isBlank() && resp.toolCalls.isEmpty() && resp.reasoningContent.isNotBlank()"))
        assertTrue(source.contains("ProviderNoResponseException"))
    }
}
