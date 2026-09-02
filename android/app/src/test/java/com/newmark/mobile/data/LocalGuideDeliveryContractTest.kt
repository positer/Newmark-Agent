package com.newmark.mobile.data

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalGuideDeliveryContractTest {
    @Test
    fun everyActiveLocalAgentModeCanReceiveGuideWhenRunIdentityMatches() {
        assertTrue(LocalGuideDeliveryContract.acceptsActiveRun("run-1", true, "run-1"))
        assertFalse(LocalGuideDeliveryContract.acceptsActiveRun("run-1", false, "run-1"))
        assertFalse(LocalGuideDeliveryContract.acceptsActiveRun("run-1", true, "run-2"))
        assertFalse(LocalGuideDeliveryContract.acceptsActiveRun(null, true, "run-1"))

        val source = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val delivery = source.substringAfter("private fun submitLocalGuide(")
            .substringBefore("private fun drainLocalQueueIfReady(")
        assertTrue(delivery.contains("LocalGuideDeliveryContract.acceptsActiveRun("))
        assertFalse(delivery.contains("run.mode != \"build\""))
    }

    @Test
    fun acceptedGuideBecomesTheLatestRealUserMessageAtProviderFrontier() {
        val messages = mutableListOf(
            ChatMessage(role = "user", content = "original"),
            ChatMessage(role = "assistant", content = "working"),
        )
        messages += LocalGuideDeliveryContract.promptMessage(
            clientMessageId = "guide-message",
            text = "优先执行这条 Guide",
            createdAt = 1234L,
        )

        val guide = messages.last()
        assertEquals("user", guide.role)
        assertEquals("优先执行这条 Guide", guide.content)
        assertEquals("guide-message", guide.messageId)
        assertEquals(1234L, guide.timestamp)
    }
}
