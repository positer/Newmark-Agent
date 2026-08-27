package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryLabPcParityContractTest {
    @Test
    fun mobileMemoryLabExposesTheCompletePcMutationToolchain() {
        val tools = java.io.File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = java.io.File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        val store = java.io.File("src/main/java/com/newmark/mobile/data/MemoryLabStore.kt").readText()

        assertTrue(tools.contains("\"memory_lab_delete\""))
        assertTrue(tools.contains("expected_updated_at"))
        assertTrue(tools.contains("tag_paths"))
        assertTrue(executor.contains("\"memory_lab_delete\" ->"))
        assertTrue(store.contains("fun update(input: MemoryLabUpdateInput)"))
        assertTrue(store.contains("fun delete(componentSelector: String"))
        assertTrue(store.contains("policy.jsonl"))
        assertTrue(store.contains("archiveComponentRevision"))
        assertTrue(store.contains("rebuildReceipt"))
    }

    @Test
    fun mobilePresentationKeepsTouchDraggingWhileAddingPcDetailAndEditing() {
        val screen = java.io.File("src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt").readText()

        assertTrue(screen.contains("MemoryLabEditorDialog("))
        assertTrue(screen.contains("组件元数据"))
        assertTrue(screen.contains("标签路径"))
        assertTrue(screen.contains("别名"))
        assertTrue(screen.contains("48f / cameraScale"))
        assertTrue(screen.contains("pointerInput(graph)"))
    }
}
