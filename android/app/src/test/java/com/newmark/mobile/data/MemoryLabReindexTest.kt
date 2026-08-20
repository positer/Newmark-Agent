package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class MemoryLabReindexTest {
    @Test
    fun rebuildsTagGraphFromComponentMetadata() {
        val tags = rebuildMemoryTags(
            existing = mapOf("physics" to MemoryTagNode(aliases = listOf("物理"))),
            components = mapOf(
                "wave-note" to MemoryComponent(
                    tags = listOf("reference"),
                    tagPaths = listOf(listOf("physics", "waves")),
                ),
            ),
        )

        assertEquals(listOf("waves"), tags.getValue("physics").children)
        assertEquals(listOf("physics"), tags.getValue("waves").parents)
        assertEquals(listOf("wave-note"), tags.getValue("reference").components)
        assertEquals(listOf("wave-note"), tags.getValue("waves").components)
        assertEquals(listOf("物理"), tags.getValue("physics").aliases)
    }
}
