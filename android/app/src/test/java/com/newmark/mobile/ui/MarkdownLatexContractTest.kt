package com.newmark.mobile.ui

import com.newmark.mobile.ui.components.renderReadableLatex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MarkdownLatexContractTest {
    @Test
    fun preservesPcMathSyntaxAndReadableFormulaStructure() {
        assertEquals("(α + β / √(x_2))", renderReadableLatex("\\frac{\\alpha + \\beta}{\\sqrt{x_2}}"))
        assertEquals("∑_i^n i", renderReadableLatex("\\sum_{i}^{n} i"))
        assertEquals("E = mc^2", renderReadableLatex("E = mc^2"))
        assertEquals("x ∈ [0, 1]", renderReadableLatex("x \\in [0, 1]"))

        val source = File("src/main/java/com/newmark/mobile/ui/components/Markdown.kt").readText()
        assertTrue(source.contains("trimmed == \"$$\" || trimmed == \"\\\\[\""))
        assertTrue(source.contains("private val INLINE_MATH"))
        assertTrue(source.contains("val tex = m.groupValues[1].ifBlank { m.groupValues[2] }"))
        assertTrue(source.contains("~{3,}"))
        assertTrue(source.contains("HorizontalRule"))
        assertTrue(source.contains("MarkdownBody("))
    }
}
