package com.newmark.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ConversationMenuArchiveAnimationContractTest {
    @Test
    fun anchorMenuStaysComposedForOriginAwareEnterAndExitMotion() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/AnchorMenu.kt").readText()

        assertTrue(source.contains("MutableTransitionState(false)"))
        assertTrue(source.contains("menuVisibility.targetState = expanded"))
        assertTrue(source.contains("scaleIn("))
        assertTrue(source.contains("scaleOut("))
        assertTrue(source.contains("transformOrigin = transformOrigin"))
        assertTrue(source.contains("fadeIn("))
        assertTrue(source.contains("fadeOut("))
    }

    @Test
    fun conversationMenusUseTriggerOriginAndArchiveOnlyAfterCapsuleExit() {
        val source = File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()

        assertTrue(source.contains("ConversationMenuTrigger.MoreButton"))
        assertTrue(source.contains("ConversationMenuTrigger.LongPress"))
        assertTrue(source.contains("TransformOrigin(1f, 0f)"))
        assertTrue(source.contains("TransformOrigin.Center"))
        assertTrue(source.contains("archiveConversationAfterExit"))
        assertTrue(source.contains("archiveProgress.animateTo(0f"))
        assertTrue(source.contains("onArchive()"))
    }
}
