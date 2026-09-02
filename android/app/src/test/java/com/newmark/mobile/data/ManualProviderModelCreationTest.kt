package com.newmark.mobile.data

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ManualProviderModelCreationTest {
    @Test
    fun manualProviderUsesTheExistingPcCompatibleProviderShape() {
        val provider = createManualProviderConfig(
            id = "manual-test",
            name = "  Example  ",
            baseUrl = "https://api.example.test/v1/",
            apiKey = " secret ",
            protocol = "openai",
        )

        assertEquals("manual-test", provider.id)
        assertEquals("Example", provider.name)
        assertEquals("https://api.example.test/v1", provider.baseUrl)
        assertEquals("secret", provider.apiKey)
        assertEquals("openai", provider.protocol)
        assertTrue(provider.enabled)
        assertTrue(provider.hasApiKey)
        assertTrue(provider.models.isEmpty())
    }

    @Test
    fun githubModelsGetsItsPcDefaultEndpointAndApiKeyCanBeDeferred() {
        val provider = createManualProviderConfig("github", "GitHub", "", "", "github_models")
        assertEquals("https://models.github.ai", provider.baseUrl)
        assertFalse(provider.hasApiKey)
    }

    @Test
    fun responsesProtocolPersistsAndReachesTheRuntimeApiConfig() {
        val provider = createManualProviderConfig(
            id = "responses",
            name = "Responses Provider",
            baseUrl = "https://api.example.test/v1/responses",
            apiKey = "secret",
            protocol = "responses",
        ).copy(models = listOf(ModelConfig(name = "gpt-response")))

        assertEquals("openai_responses", provider.protocol)
        assertEquals("openai_responses", provider.toApiConfig(provider.models.single()).protocol)
    }

    @Test
    fun protocolAliasesCoverPcCompatibleAndExplicitTransportNames() {
        assertEquals("openai", requireMobileProviderProtocol("openai-compatible"))
        assertEquals("openai", requireMobileProviderProtocol("chat_completions"))
        assertEquals("openai_responses", requireMobileProviderProtocol("responses"))
        assertEquals("anthropic", requireMobileProviderProtocol("claude"))
    }

    @Test
    fun manualModelPreservesCoreCapabilityFields() {
        val model = createManualModelConfig(
            name = " model-a ",
            display = "Model A",
            description = "General model",
            maxTokens = 128_000,
            vision = true,
            thinking = true,
        )
        assertEquals("model-a", model.name)
        assertEquals("Model A", model.display)
        assertEquals(128_000, model.maxTokens)
        assertTrue(model.vision)
        assertTrue(model.thinking)
        assertTrue(model.enabled)
    }

    @Test
    fun settingsExposeManualCreationBeforeFuzzyAndRemoteImport() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val vm = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val providersPage = settings.substringAfter("private fun ProvidersPage(").substringBefore("// ---- 基础新建供应商")
        val detailPage = settings.substringAfter("private fun ProviderDetailPage(").substringBefore("// ---- 设备管理")

        assertTrue(settings.contains("data object NewProvider : SettingsPage"))
        assertTrue(settings.contains("data class NewModel(val providerId: String) : SettingsPage"))
        assertTrue(providersPage.contains("＋ 新建供应商"))
        assertTrue(settings.contains("private fun ManualProviderPage("))
        assertTrue(settings.contains("private fun ManualModelPage("))
        assertTrue(detailPage.contains("＋ 新建模型"))
        assertTrue(detailPage.contains("ProviderProtocolRail("))
        assertTrue(detailPage.contains("openai_responses"))
        assertTrue(detailPage.contains("vm.updateProviderProtocol(provider.id, protocol)"))
        assertTrue(settings.contains("vm.upsertProvider(provider)"))
        assertTrue(settings.contains("vm.upsertModel(target.providerId, model)"))
        assertTrue(vm.contains("fun upsertModel(providerId: String, model: ModelConfig)"))
    }
}
