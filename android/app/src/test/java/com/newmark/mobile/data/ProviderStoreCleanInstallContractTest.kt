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
}
