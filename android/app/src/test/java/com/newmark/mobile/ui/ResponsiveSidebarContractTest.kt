package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponsiveSidebarContractTest {
    @Test
    fun releaseFrameKeepsTheFingerPositionUntilAnimatableIsSynchronized() {
        assertTrue(sidebarPresentedProgress(true, 0.63f, null, 0f) == 0.63f)
        assertTrue(sidebarPresentedProgress(false, 0.63f, 0.63f, 0f) == 0.63f)
        assertTrue(sidebarPresentedProgress(false, 0.63f, null, 0.63f) == 0.63f)
    }

    @Test
    fun portraitDrawerNeverInheritsTheExpandedLayoutRailState() {
        assertFalse(sidebarRailForLayout(isCompact = true, expandedLayoutRail = true))
        assertFalse(sidebarRailForLayout(isCompact = true, expandedLayoutRail = false))
        assertTrue(sidebarRailForLayout(isCompact = false, expandedLayoutRail = true))
        assertFalse(sidebarRailForLayout(isCompact = false, expandedLayoutRail = false))
    }

    @Test
    fun sidebarsUseFingerProgressWhileRightPanelRemainsResidentOffscreen() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        org.junit.Assert.assertTrue(source.contains("modifier = gestureModifier"))
        org.junit.Assert.assertTrue(source.contains("Box(Modifier.fillMaxSize().then(gestureModifier))"))
        org.junit.Assert.assertFalse(source.contains("if (rightProgress > 0.001f) {"))
        org.junit.Assert.assertTrue(source.contains(".width(leftBoundaryWidth)"))
        org.junit.Assert.assertTrue(source.contains("val expandedSidebarWidth = if (screenWidthDp >= 840) 280.dp else 240.dp"))
        org.junit.Assert.assertTrue(source.contains("val leftBoundaryWidth = maxOf(48.dp, expandedSidebarWidth * leftReveal)"))
        org.junit.Assert.assertTrue(source.contains(".width(expandedSidebarWidth)"))
        org.junit.Assert.assertTrue(source.contains("Box(Modifier.width(panelWidth * rightProgress).fillMaxHeight())"))
        org.junit.Assert.assertTrue(source.contains("translationX = size.width * (1f - rightProgress)"))
        org.junit.Assert.assertFalse(source.contains("translationX = -panelWidthPx * (1f - rightProgress)"))
        org.junit.Assert.assertTrue(source.contains("translationX = -expandedSidebarWidthPx * (1f - leftReveal)"))
        org.junit.Assert.assertFalse(source.contains("visible = leftDragging || !primaryRail"))
        org.junit.Assert.assertTrue(source.contains("val leftReveal = leftProgress"))
        org.junit.Assert.assertTrue(source.contains("val rightSidebarMotion = remember { Animatable(0f) }"))
        org.junit.Assert.assertTrue(source.contains("rightSidebarSettleStart = rightSidebarDragProgress"))
        org.junit.Assert.assertTrue(source.contains("leftSidebarSettleStart = leftSidebarDragProgress"))
        org.junit.Assert.assertTrue(source.contains("rightSidebarMotion.snapTo(settleStart)"))
        org.junit.Assert.assertTrue(source.contains("leftSidebarMotion.snapTo(settleStart)"))
        org.junit.Assert.assertTrue(source.indexOf("rightSidebarMotion.snapTo(settleStart)") < source.indexOf("rightSidebarSettleStart = null"))
        org.junit.Assert.assertTrue(source.indexOf("leftSidebarMotion.snapTo(settleStart)") < source.indexOf("leftSidebarSettleStart = null"))
        org.junit.Assert.assertTrue(source.contains("rightSidebarMotion.animateTo("))
        org.junit.Assert.assertTrue(source.contains("leftSidebarMotion.animateTo("))
        org.junit.Assert.assertTrue(source.contains("private val SidebarEaseInOut = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)"))
        org.junit.Assert.assertTrue(source.contains("tween(durationMillis = 250, easing = SidebarEaseInOut)"))
        org.junit.Assert.assertTrue(source.contains("tween(durationMillis = 320, easing = SidebarEaseInOut)"))
        org.junit.Assert.assertTrue(source.contains("private fun SidebarFrameProgressHost("))
        org.junit.Assert.assertTrue(source.contains("View.REQUESTED_FRAME_RATE_CATEGORY_HIGH"))
        org.junit.Assert.assertTrue(source.contains("View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT"))
        org.junit.Assert.assertTrue(source.contains("rightSidebarMotion.isRunning || leftSidebarMotion.isRunning || independentPageTransitionRunning"))
        val host = source.substring(
            source.indexOf("private fun SidebarFrameProgressHost("),
            source.indexOf("private fun formatLocalTime"),
        )
        org.junit.Assert.assertTrue(host.contains("animatedProgress = rightMotion.value"))
        org.junit.Assert.assertTrue(host.contains("animatedProgress = leftMotion.value"))
        org.junit.Assert.assertFalse(source.contains("settledRightSidebarProgress by animateFloatAsState"))
        org.junit.Assert.assertFalse(source.contains("settledLeftReveal by animateFloatAsState"))
        org.junit.Assert.assertTrue(source.contains("val opening = rail && horizontalDrag > 0f"))
        org.junit.Assert.assertTrue(source.contains("val closing = !rail && horizontalDrag < 0f"))
    }
}
