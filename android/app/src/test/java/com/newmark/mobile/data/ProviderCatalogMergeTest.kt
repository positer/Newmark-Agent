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
}
