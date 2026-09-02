package com.newmark.mobile.ui.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.compose.ui.graphics.luminance
import com.newmark.mobile.ui.theme.NewmarkDarkThemeColors
import com.newmark.mobile.ui.theme.NewmarkLightThemeColors
import java.io.File

class MarkdownFontBundlingContractTest {
    @Test
    fun codeHighlightingKeepsCjkTextAndNeverLeaksPrivateUsePlaceholders() {
        val source = """
            python3 -c "import sys;from scholarly import scholarly;[print(p['bib']['title']) for p in scholarly.search_pubs(sys.argv[1])]" "你的关键词"
        """.trimIndent()
        val rendered = highlightCode(source, "bash", NewmarkDarkThemeColors)
        assertTrue("highlighted code must preserve CJK string content", rendered.text.contains("你的关键词"))
        assertFalse("highlighting must not leak private-use placeholder glyphs", rendered.text.any { it in '\uE100'..'\uE1FF' })
        assertTrue("highlighting must produce colored spans", rendered.spanStyles.isNotEmpty())
        assertTrue("light theme must use a darker readable green than dark theme", NewmarkLightThemeColors.codeString.luminance() < NewmarkDarkThemeColors.codeString.luminance())
    }

    @Test
    fun bundledOfflineFontsCoverCodeAndMathRendering() {
        val fontDir = File("src/main/res/font")
        val math = File(fontDir, "noto_sans_math.ttf")
        val cjkMono = File(fontDir, "noto_sans_mono_cjk_sc.otf")
        val source = File("src/main/java/com/newmark/mobile/ui/components/Markdown.kt").readText()
        val codeBlockSource = source
            .substringAfter("private fun CodeBlockView(")
            .substringBefore("private fun TableView(")

        assertTrue("Noto Sans Math must be bundled", math.isFile && math.length() > 100_000)
        assertTrue("Noto Sans Mono CJK SC must be bundled", cjkMono.isFile && cjkMono.length() > 1_000_000)
        assertTrue(source.contains("R.font.noto_sans_math"))
        assertTrue(source.contains("R.font.noto_sans_mono_cjk_sc"))
        assertTrue(source.contains("MarkdownCodeFontFamily"))
        assertTrue(source.contains("MarkdownMathFontFamily"))
        assertFalse("Markdown renderer must not rely on system monospace for code", source.contains("fontFamily = FontFamily.Monospace"))
        assertTrue("Highlighted code spans must preserve the bundled code font", source.contains("SpanStyle(color = color, fontFamily = MarkdownCodeFontFamily)"))
        assertTrue("Code block must wrap inside available width constraints", codeBlockSource.contains("softWrap = true"))
        assertFalse("Code block must not use horizontal scroll as its default wrap policy", codeBlockSource.contains("horizontalScroll"))
        assertFalse("Inline Markdown must not use the legacy ClickableText font/link pipeline", source.contains("ClickableText"))
        assertTrue(source.contains("TextLayoutResult"))
        assertTrue(source.contains("getOffsetForPosition"))
        assertTrue(source.contains("pointerInput"))
        assertTrue(source.contains("highlightCode(block.code, block.language, p)"))
        assertTrue(source.contains("palette.codeString"))
        assertTrue(source.contains("palette.codeKeyword"))
        assertTrue(source.contains("palette.codeComment"))
        assertTrue(source.contains("palette.codeNumber"))
        assertTrue(source.contains("palette.codeType"))
        assertTrue(source.contains("palette.codeTag"))
    }
}
