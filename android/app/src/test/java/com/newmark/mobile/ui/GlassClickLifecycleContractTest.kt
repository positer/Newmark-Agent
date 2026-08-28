package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassClickLifecycleContractTest {
    @Test
    fun everySharedGlassButtonCompletesLiftBeforeLandingAndIsNotComposerClipped() {
        val liquid = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val sidebar = File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        val memory = File("src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt").readText()

        val surface = liquid.substringAfter("fun Modifier.glassButtonSurface(")
            .substringBefore("fun Modifier.kyantGlassEdge(")
        assertTrue(surface.contains("pressProgress.animateTo(1f"))
        assertTrue(surface.contains("release.await()"))
        assertTrue(surface.indexOf("pressProgress.animateTo(1f") < surface.indexOf("release.await()"))
        assertTrue(surface.indexOf("release.await()") < surface.indexOf("pressProgress.animateTo(0f"))
        assertTrue(surface.contains("Channel.UNLIMITED"))
        assertTrue(surface.contains("clip = false"))
        assertTrue(surface.contains("var boundaryPull by remember { mutableStateOf(Offset.Zero) }"))
        assertTrue(surface.contains("translationX = boundaryPull.x"))
        assertTrue(surface.contains("translationY = pressLift.toPx() + boundaryPull.y"))
        assertTrue(surface.contains("sqrt(distance - viewConfiguration.touchSlop) * 0.25f"))
        assertTrue(surface.contains("boundaryPull = Offset.Zero"))

        assertTrue(chat.contains("private fun CircleButton("))
        assertTrue(chat.contains("private fun PlusCombo("))
        assertTrue(chat.substringAfter("private fun CircleButton(").substringBefore("// ---- 对话内容").contains("GlassButtonCanvas("))
        assertTrue(chat.substringAfter("private fun PlusCombo(").substringBefore("private fun SubmitButton").contains("GlassButtonCanvas("))
        assertFalse(chat.substringAfter("// 单行：+（模式/文件）").substringBefore("verticalAlignment = Alignment.Bottom").contains(".clip(inputShape)"))
        assertTrue(memory.contains("private fun MemoryLabGlassAction("))
        assertTrue(memory.substringAfter("private fun MemoryLabGlassAction(").contains(".glassButtonSurface("))
        assertTrue(sidebar.substringAfter("SectionLabel(\"本地对话\")").substringBefore("ConversationList(").contains("GlassButtonCanvas("))
    }
}
