package com.newmark.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MemoryLabAndSubagentAnimationContractTest {
    @Test
    fun compactSubagentPageKeepsUnderlyingSurfaceAndAnimatesBothDirections() {
        val source = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(source.contains("compactSubagentVisibility.targetState = isCompact && compactSubagent != null"))
        assertTrue(source.contains("slideInHorizontally"))
        assertTrue(source.contains("slideOutHorizontally"))
        assertTrue(source.contains("animationSpec = tween(320, easing = PcEaseOutExpo)"))
        assertTrue(source.contains("private val IndependentPageExitEase = CubicBezierEasing(0.4f, 0f, 1f, 1f)"))
        assertTrue(source.contains("animationSpec = tween(260, easing = IndependentPageExitEase)"))
        assertTrue(source.contains("val independentPageTransitionRunning = !compactSubagentVisibility.isIdle"))
        assertTrue(source.contains("rightSidebarMotion.isRunning || leftSidebarMotion.isRunning || independentPageTransitionRunning"))
    }

    @Test
    fun memoryOverviewRendersTypedNodeGroupAndKeepsDetailSelectionCoherent() {
        val source = File("src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt").readText()
        assertTrue(source.contains("MemoryCloudGraph.from(index)"))
        assertTrue(source.contains("calculatePan"))
        assertTrue(source.contains("calculateZoom"))
        assertTrue(source.contains("awaitEachGesture"))
        assertTrue(source.contains("48f / cameraScale"))
        assertTrue(source.contains("viewConfiguration.touchSlop"))
        assertTrue(source.contains("PointerEventPass.Initial"))
        assertTrue(source.contains("coerceIn(.0001f, 10_000f)"))
        assertTrue(source.contains("val nodeLabelFontPx = 11f * cameraScale"))
        assertTrue(source.contains("val minimumPageFontPx = 9f"))
        assertTrue(source.contains("val dotMode = nodeLabelFontPx < minimumPageFontPx"))
        assertTrue(source.contains("PC .zoom-dots uses a fixed 10x10 screen pixel"))
        assertTrue(source.contains("drawCircle(tone.copy(alpha = if (hot) 1f else .18f), 5f, center)"))
        assertTrue(source.contains("Parents(\"父链\")"))
        assertTrue(source.contains("Children(\"子树\")"))
        assertTrue(source.contains("while (isActive)"))
        assertTrue(source.contains("isInteracting"))
        assertTrue(source.contains("if (isInteracting) continue"))
        assertTrue(source.contains("cameraPan = centroid"))
        assertTrue(source.contains("drawLine("))
        assertTrue(source.contains("\"root\", \"anchor\" ->"))
        assertTrue(source.contains("\"leaf\" ->"))
        assertTrue(source.contains("\"component\" ->"))
        assertTrue(source.contains("pillRadius = height / 2f"))
        assertTrue(source.contains("MemoryCloudNode(\"anchor\", \"Memory Lab\""))
        assertTrue(source.contains("related.parents"))
        assertTrue(source.contains("related.children"))
        assertTrue(source.contains("flowPhase"))
        assertTrue(source.contains("meta?.tagPaths?.firstOrNull()?.lastOrNull()"))
        assertTrue(source.contains("selectedComponent.takeIf { it in selectedComponents }"))
    }
}
