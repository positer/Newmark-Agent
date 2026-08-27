package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryLabToolGuidanceContractTest {
    @Test
    fun guidanceDeclaresCompactMutationAndOutputRules() {
        assertTrue(MemoryLabStore::class.java.name.isNotBlank())
        val source = java.io.File("src/main/java/com/newmark/mobile/data/LocalContextContract.kt").readText()
        assertTrue(source.contains("Memory Lab protocol"))
        assertTrue(source.contains("do not print schemas"))
        val store = java.io.File("src/main/java/com/newmark/mobile/data/MemoryLabStore.kt").readText()
        assertTrue(store.contains("Never print tool schemas"))
        assertTrue(store.contains("tag_paths is JSON array"))
    }
}
