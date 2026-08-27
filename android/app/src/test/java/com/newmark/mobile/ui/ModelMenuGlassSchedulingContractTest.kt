package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelMenuGlassSchedulingContractTest {
    @Test
    fun modelMenuDragKeepsHighFrequencyMotionOutOfComposition() {
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val glass = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()

        assertTrue(chat.contains("private class LiquidMenuFlightScheduler(initialIndex: Int)"))
        assertTrue(chat.contains("var activeIndex: Int = initialIndex"))
        assertFalse(chat.contains("mutableStateOf<kotlinx.coroutines.Job?>"))
        assertFalse(chat.contains("mutableIntStateOf(selectedIndex)"))
        assertTrue(chat.contains("it >= 0 && it != flightScheduler.activeIndex"))
        assertTrue(chat.contains("liquidMotionDeformationDeferred("))
        assertTrue(chat.contains("velocityY = { activeOffsetPx.velocity }"))
        assertTrue(glass.contains("val scale = liquidMotionScale(velocityX(), velocityY(), density)"))
    }

    @Test
    fun modelMenuStructureAndAgentDeltasAreCoalescedOutsideTheFramePath() {
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()

        assertTrue(chat.contains("val groupedModelOptions = remember(options)"))
        assertTrue(chat.contains("val entrySet = remember("))
        assertTrue(chat.contains("LiquidMenuGeometry("))
        assertTrue(viewModel.contains("private const val AGENT_UI_FRAME_INTERVAL_MS = 16L"))
        assertTrue(viewModel.contains("class AgentUiDeltaPublisher("))
        assertTrue(viewModel.contains("publishBatch(deltas)"))
        assertTrue(viewModel.contains("onThoughtDelta = deltaPublisher::offerThought"))
        assertTrue(viewModel.contains("onTextDelta = deltaPublisher::offerText"))
        assertTrue(viewModel.contains("if (currentCoroutineContext().isActive)"))
        assertTrue(viewModel.contains("deltaPublisher.cancel()"))
        assertFalse(viewModel.contains("withContext(Dispatchers.Main.immediate) { publishThoughtDelta(delta) }"))
        assertFalse(viewModel.contains("withContext(Dispatchers.Main.immediate) { publishTextDelta(delta) }"))
    }
}
