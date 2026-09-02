package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderCatalogMergeTest {
    @Test
    fun newRemoteProviderKeepsExportedApiConfiguration() {
        val result = mergeProviderCatalogEntries(
            existing = emptyList(),
            incoming = listOf(
                ProviderConfig(
                    id = "remote-a",
                    name = "Remote A",
                    baseUrl = "https://remote-a.test/v1",
                    apiKey = "remote-secret",
                    hasApiKey = true,
                    models = listOf(ModelConfig(name = "model-a")),
                ),
            ),
        )

        assertEquals(1, result.addedProviders)
        assertEquals("https://remote-a.test/v1", result.providers.single().baseUrl)
        assertEquals("remote-secret", result.providers.single().apiKey)
        assertTrue(result.providers.single().hasApiKey)
    }

    @Test
    fun credentialExportRepairsEarlierRedactedPullAndPreservesLocalSecret() {
        val redacted = ProviderConfig(
            id = "remote-a",
            name = "Remote A",
            baseUrl = "https://remote-a.test/v1",
            apiKey = "",
            hasApiKey = false,
            models = listOf(ModelConfig(name = "old-model")),
        )
        val exported = redacted.copy(
            apiKey = "remote-secret",
            hasApiKey = true,
            models = redacted.models + ModelConfig(name = "new-model"),
        )
        val repaired = mergeProviderCatalogEntries(listOf(redacted), listOf(exported))
        assertEquals("remote-secret", repaired.providers.single().apiKey)
        assertEquals(listOf("old-model", "new-model"), repaired.providers.single().models.map { it.name })

        val localSecret = redacted.copy(apiKey = "local-secret", hasApiKey = true)
        val preserved = mergeProviderCatalogEntries(listOf(localSecret), listOf(exported))
        assertEquals("local-secret", preserved.providers.single().apiKey)
    }

    @Test
    fun responsesProtocolAliasesNormalizeDuringCatalogMigration() {
        val imported = mergeProviderCatalogEntries(
            existing = emptyList(),
            incoming = listOf(
                ProviderConfig(
                    id = "responses-provider",
                    name = "Responses",
                    baseUrl = "https://responses.test/v1",
                    apiKey = "secret",
                    protocol = "responses",
                    models = listOf(ModelConfig(name = "gpt-response")),
                ),
            ),
        )

        assertEquals("openai_responses", imported.providers.single().protocol)

        val mergedAlias = mergeProviderCatalogEntries(
            existing = listOf(imported.providers.single()),
            incoming = listOf(imported.providers.single().copy(id = "alias-id", protocol = "responses")),
        )
        assertEquals(1, mergedAlias.providers.size)
    }

    @Test
    fun persistedAndFullReplacementProviderListsNormalizeProtocolAliases() {
        val providers = listOf(
            ProviderConfig(id = "responses", name = "Responses", protocol = "responses"),
            ProviderConfig(id = "legacy", name = "Legacy", protocol = "openai-compatible"),
        )

        val normalized = normalizeMobileProviderConfigs(providers)

        assertEquals(listOf("openai_responses", "openai"), normalized.map { it.protocol })
        assertEquals(providers.map { it.id }, normalized.map { it.id })
        assertEquals(providers.map { it.name }, normalized.map { it.name })
    }
}
