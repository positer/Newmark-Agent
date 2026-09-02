package com.newmark.mobile.vm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FirstInputTitleAndNetworkRecoveryContractTest {
    @Test
    fun firstInputUsesOneIndependentTitleRequestWithoutDirectCopy() {
        val source = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val models = File("src/main/java/com/newmark/mobile/data/ChatModels.kt").readText()
        val store = File("src/main/java/com/newmark/mobile/data/ConversationStore.kt").readText()
        val titleRequestSource = source
            .substringAfter("private fun requestFirstInputConversationTitle(")
            .substringBefore("\n    fun archiveConversation")
        val compactSource = source.replace(Regex("\\s+"), " ")
        assertTrue(models.contains("titleRequestMessageId"))
        assertTrue(source.contains("requestFirstInputConversationTitle"))
        assertTrue(titleRequestSource.contains("tools = emptyList()"))
        assertTrue(titleRequestSource.contains("turnIntelligence: String"))
        assertTrue(titleRequestSource.contains("turnThinkingTierMap: Map<String, String>"))
        assertTrue(titleRequestSource.contains("intelligence = turnIntelligence"))
        assertTrue(titleRequestSource.contains("thinkingTierMap = turnThinkingTierMap"))
        assertFalse(titleRequestSource.contains("intelligence = \"low\""))
        assertTrue(source.contains("current.titleRequestMessageId != messageId"))
        assertTrue(models.contains("firstAgentResponseStarted"))
        assertTrue(source.contains("val shouldRequestFirstTitle = !conv.firstAgentResponseStarted"))
        assertTrue(source.contains("titleReady = requestFirstInputConversationTitle"))
        assertTrue(source.contains("current.copy(firstAgentResponseStarted = true"))
        assertTrue(source.contains("val titleAttemptLimit = 5"))
        assertTrue(source.contains("val titleRetryDelaysMs = listOf(0L, 1000L, 2000L, 4000L, 8000L)"))
        assertTrue(source.contains("0s → 1s → 2s → 4s → 8s"))
        assertTrue(source.contains("标题总结在自动重试后仍失败"))
        assertFalse(source.contains("请在当前对话再次发送以重试"))
        assertFalse(source.contains("请新建对话后重试"))
        assertFalse(source.contains("titleReady = conversations.firstOrNull { it.id == targetConversationId }?.title != \"新对话\""))
        assertTrue(source.contains("val turnModelConfig = activeModelConfig"))
        assertTrue(source.contains("val turnIntelligence = intelligence"))
        assertTrue(source.contains("val turnThinkingTierMap = turnModelConfig?.thinkingTierMap?.toMap() ?: emptyMap()"))
        assertTrue(source.contains("config = titleConfig"))
        assertTrue(compactSource.contains("requestFirstInputConversationTitle( targetConversationId, firstTitleMessageId, titleInput, titleConfig, turnIntelligence, turnThinkingTierMap, ).await()"))
        assertTrue(compactSource.contains("runAgentLoop( titleConfig, targetConversationId, prepared.messages, executor, turnIntelligence, turnThinkingTierMap,"))
        assertFalse(source.contains("if (run.status == \"completed\") {\n                val currentTitle"))
        assertTrue(source.contains("conversation.firstAgentResponseStarted || legacyFormalResponseExists"))
        assertTrue(store.contains("conversation.firstAgentResponseStarted || legacyFormalResponseExists"))
        assertFalse(source.contains("private fun deriveTitle"))
    }

    @Test
    fun backgroundRecoveryRequiresValidatedNetworkAndContinuesPartialText() {
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        val vm = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        assertTrue(service.contains("NetworkCapabilities.NET_CAPABILITY_VALIDATED"))
        assertTrue(vm.contains("networkRetryAttempt < 3"))
        assertTrue(vm.contains("[Network continuation]"))
        assertTrue(vm.contains("Do not repeat any text already shown"))
        assertTrue(vm.contains("recoveredText"))
    }
}
