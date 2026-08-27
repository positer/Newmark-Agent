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
        assertTrue(sidebar.contains("move = { localConversationGlassY.animateTo(target.top"))
        assertTrue(sidebar.contains("move = { flyingGlassY.animateTo(target.top"))
        assertTrue(right.contains("holdKeepsLifted = true"))
        assertTrue(memory.contains("holdKeepsLifted = true"))
        assertTrue(chat.contains("runOverlappedLiquidFlight("))
        assertTrue(right.contains("fun holdAt(index: Int)"))
        assertTrue(memory.contains("fun holdAt(index: Int)"))
        assertTrue(chat.contains("fun beginHeldSelection(index: Int)"))
    }
}
