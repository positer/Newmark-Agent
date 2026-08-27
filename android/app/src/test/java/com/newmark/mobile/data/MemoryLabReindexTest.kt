package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun reindexMergesEnglishAndChineseSynonymsUsingEnglishPreference() {
        val normalized = normalizeMemoryIndex(synonymIndex("en"))

        assertTrue(normalized.tags.containsKey("#Physics"))
        assertFalse(normalized.tags.containsKey("#物理"))
        assertEquals(listOf("#物理"), normalized.tags.getValue("#Physics").aliases)
        assertEquals(listOf("#Physics"), normalized.components.getValue("wave-note").tags)
        assertEquals(listOf(listOf("#Physics")), normalized.components.getValue("wave-note").tagPaths)
    }

    @Test
    fun reindexMergesEnglishAndChineseSynonymsUsingChinesePreference() {
        val normalized = normalizeMemoryIndex(synonymIndex("zh"))

        assertTrue(normalized.tags.containsKey("#物理"))
        assertFalse(normalized.tags.containsKey("#Physics"))
        assertEquals(listOf("#Physics"), normalized.tags.getValue("#物理").aliases)
        assertEquals(listOf("#物理"), normalized.components.getValue("wave-note").tags)
        assertEquals(listOf(listOf("#物理")), normalized.components.getValue("wave-note").tagPaths)
    }

    @Test
    fun repeatedReindexKeepsTheSameCanonicalGraph() {
        val first = normalizeMemoryIndex(synonymIndex("en"))
        val second = normalizeMemoryIndex(first)

        assertEquals(first.preferredLanguage, second.preferredLanguage)
        assertEquals(first.tags, second.tags)
        assertEquals(first.components, second.components)
    }

    private fun synonymIndex(preferredLanguage: String) = MemoryLabIndex(
        preferredLanguage = preferredLanguage,
        tags = mapOf(
            "#Physics" to MemoryTagNode(aliases = listOf("#物理")),
            "#物理" to MemoryTagNode(aliases = listOf("#Physics")),
        ),
        components = mapOf(
            "wave-note" to MemoryComponent(
                name = "Wave note",
                tags = listOf("#Physics", "#物理"),
                tagPaths = listOf(listOf("#Physics"), listOf("#物理")),
            ),
        ),
    )
}
