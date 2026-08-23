package com.newmark.mobile.ui

import com.google.gson.Gson
import com.newmark.mobile.data.RemotePayloadNormalizer
import com.newmark.mobile.data.RemoteWorkEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 桌面端结构化模型回退（AgentWorkEvent.fallback）在移动端的投影契约：
 * SSE 事件解析保留 fallback 字段，DesktopLinkViewModel 把回退模型同步到
 * 输入框下方选择区，且手动选模型/切换对话时清除。
 */
class MobileFallbackSyncContractTest {
    @Test
    fun sseEventParsesAndNormalizerKeepsFallbackPayload() {
        val raw = """
            {
              "id": "model-fallback-1",
              "conversationId": "conv-1",
              "type": "status",
              "content": "[Model fallback] primary unavailable; switched to backup.",
              "mode": "Build",
              "model": "backup",
              "timestamp": "2026-08-23T00:00:00.000Z",
              "workspaceId": "ws-1",
              "runId": "run-1",
              "fallback": { "from": "primary", "to": "backup", "providerId": "p1" }
            }
        """.trimIndent()
        val parsed = Gson().fromJson(raw, RemoteWorkEvent::class.java)
        assertEquals("primary", parsed.fallback?.from)
        assertEquals("backup", parsed.fallback?.to)
        assertEquals("p1", parsed.fallback?.providerId)
        val normalized = RemotePayloadNormalizer.workEvent(parsed)
        assertEquals("backup", normalized.fallback?.to)
        assertEquals("p1", normalized.fallback?.providerId)
    }

    @Test
    fun desktopLinkViewModelSyncsFallbackModelAndClearsOnSelection() {
        val viewModel = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()
        assertTrue(viewModel.contains("var fallbackModel by mutableStateOf(\"\")"))
        assertTrue(viewModel.contains("event.fallback?.to?.takeIf(String::isNotBlank)"))
        assertTrue(viewModel.contains("fallbackModel = if (providerId.isNotBlank())"))
        assertTrue(viewModel.contains("deployment:\${java.net.URLEncoder.encode(providerId, Charsets.UTF_8.name())}:"))
        // 手动选模型与切换对话时清除回退显示，恢复桌面权威选择
        val selectRemoteModel = viewModel.substringAfter("fun selectRemoteModel(option: ModelOption) {")
            .substringBefore("\n    }")
        assertTrue(selectRemoteModel.contains("fallbackModel = \"\""))
        val selectConversation = viewModel.substringAfter("fun selectConversation(id: String, workspaceId: String? = openedWorkspaceId) {")
            .substringBefore("        val loadGeneration")
        assertTrue(selectConversation.contains("fallbackModel = \"\""))
    }

    @Test
    fun newmarkAppPrefersFallbackModelInInputSurface() {
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(app.contains("linkVm.fallbackModel.ifBlank { linkVm.desktopState?.model ?: \"\" }"))
        assertTrue(app.contains("val fallback = linkVm.fallbackModel"))
        assertTrue(app.contains("modelOptions.firstOrNull { it.modelName == fallback }"))
    }

    @Test
    fun mobileModelsDeclareRemoteModelFallback() {
        val models = File("src/main/java/com/newmark/mobile/data/MobileModels.kt").readText()
        assertTrue(models.contains("val fallback: RemoteModelFallback? = null,"))
        assertTrue(models.contains("data class RemoteModelFallback("))
        assertTrue(models.contains("val from: String = \"\""))
        assertTrue(models.contains("val to: String = \"\""))
        assertTrue(models.contains("val providerId: String = \"\""))
    }
}
