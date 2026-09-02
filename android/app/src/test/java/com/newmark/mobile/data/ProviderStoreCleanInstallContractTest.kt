package com.newmark.mobile.data

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderStoreCleanInstallContractTest {
    @Test
    fun cleanInstallStartsWithAnExplicitEmptyProviderListWithoutBundledPresets() {
        val store = File("src/main/java/com/newmark/mobile/data/ProviderStore.kt").readText()
        val presets = File("src/main/java/com/newmark/mobile/data/NewmarkPresets.kt")

        assertTrue(store.contains("if (!file.exists())"))
        assertTrue(store.contains("save(emptyList())"))
        assertTrue(store.contains("return emptyList()"))
        assertFalse(store.contains("NewmarkPresets"))
        assertFalse(presets.exists())
    }

    @Test
    fun providerPersistenceNormalizesLegacyProtocolAliasesWithoutDroppingFields() {
        val store = File("src/main/java/com/newmark/mobile/data/ProviderStore.kt").readText()
        val legacyStore = File("src/main/java/com/newmark/mobile/data/AppConfigStore.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        assertTrue(store.contains("val normalized = normalizeMobileProviderConfigs(parsed)"))
        assertTrue(store.contains("if (normalized != parsed) save(normalized)"))
        assertTrue(store.contains("gson.toJson(normalizeMobileProviderConfigs(list))"))
        assertTrue(legacyStore.contains("parsed.copy(protocol = normalizeMobileProviderProtocol(parsed.protocol))"))
        assertTrue(legacyStore.contains("config.copy(protocol = normalizeMobileProviderProtocol(config.protocol))"))
        assertTrue(executor.contains("val cleaned = normalizeMobileProviderConfigs("))
    }
}
