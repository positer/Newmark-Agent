package com.newmark.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class EditorMarkdownPreviewContractTest {
    @Test
    fun editorUsesPcStyleMarkdownToggleAndSharedRenderer() {
        val sidebar = File("src/main/java/com/newmark/mobile/ui/RightSidebar.kt").readText()
        val icons = File("src/main/java/com/newmark/mobile/ui/components/LucideIcons.kt").readText()
        assertTrue(sidebar.contains("setOf(\"md\", \"markdown\")"))
        assertTrue(sidebar.contains("LucideIcons.BookOpen"))
        assertTrue(sidebar.contains("MarkdownBody("))
        assertTrue(sidebar.contains("targetState = markdownPreview && markdownFile"))
        assertTrue(sidebar.contains("text = vm.rightSidebarEditorContent"))
        assertTrue(icons.contains("\"book-open\""))
    }
}
