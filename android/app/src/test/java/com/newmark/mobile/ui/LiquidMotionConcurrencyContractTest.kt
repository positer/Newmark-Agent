package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiquidMotionConcurrencyContractTest {
    @Test
    fun allMobileFloatingSelectorsMoveDuringLiftAndNeverPadAStationaryFlight() {
        val root = File("src/main/java/com/newmark/mobile/ui")
        val sidebar = File(root, "Sidebar.kt").readText()
        val right = File(root, "RightSidebar.kt").readText()
        val memory = File(root, "MemoryLabScreen.kt").readText()
        val chat = File(root, "ChatScreen.kt").readText()

        listOf(sidebar, right, memory, chat).forEach { source ->
            assertFalse(source.contains("delay(220"))
        }
        assertTrue(sidebar.contains("launch { localConversationGlassY.animateTo(target.top"))
        assertTrue(sidebar.contains("launch { flyingGlassY.animateTo(target.top"))
        assertTrue(right.contains("kotlinx.coroutines.yield()\n            lifting = false"))
        assertTrue(memory.contains("kotlinx.coroutines.yield()\n            lifting = false"))
        assertTrue(chat.contains("activeOffsetPx.animateTo(targetOffset, tween(durationMillis = 240"))
        assertTrue(right.contains("fun holdAt(index: Int)"))
        assertTrue(memory.contains("fun holdAt(index: Int)"))
        assertTrue(chat.contains("fun beginHeldSelection(index: Int)"))
    }
}
