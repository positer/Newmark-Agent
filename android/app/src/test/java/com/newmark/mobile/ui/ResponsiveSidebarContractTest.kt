package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponsiveSidebarContractTest {
    @Test
    fun conversationGlassReusesItsVisualLandingAndRedirectsOneFlight() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        assertTrue(source.contains("val sourceId = localGlassArrivedId ?: currentConversationId"))
        assertTrue(source.contains("val sourceId = glassArrivedConversationId ?: activeConversationId"))
        assertTrue(source.split("localConversationFlightJob?.cancel()").size - 1 >= 3)
        assertTrue(source.split("conversationFlightJob?.cancel()").size - 1 >= 3)
        assertTrue(source.contains("val redirecting = localConversationGlassVisible"))
        assertTrue(source.contains("val redirecting = flyingConversationGlass"))
        assertTrue(source.contains("if (!redirecting) {\n                localConversationGlassY.snapTo(source.top)"))
        assertTrue(source.contains("if (!redirecting) {\n                flyingGlassY.snapTo(source.top)"))
        assertTrue(source.contains("move = { localConversationGlassY.animateTo(target.top, tween(240, easing = PcEaseOutExpo)) }"))
        assertTrue(source.contains("move = { flyingGlassY.animateTo(target.top, tween(240, easing = PcEaseOutExpo)) }"))
        assertTrue(source.split("runOverlappedLiquidFlight(").size - 1 >= 6)
        assertFalse(source.contains("if (kotlin.math.abs(localConversationGlassY.value - target.top) < 0.5f) delay(100)"))
        assertFalse(source.contains("if (kotlin.math.abs(flyingGlassY.value - target.top) < 0.5f) delay(100)"))
        assertTrue(source.contains("MobileInteractionGlassEdge.toPx()"))
        assertTrue(source.contains("MobileConversationGlassHorizontalEdge.toPx()"))
        assertTrue(source.split("localBoundingBoxOf(coordinates, clipBounds = false)").size - 1 == 2)
        assertTrue(source.contains("2.dp.toPx() } * localConversationGlassLift.value"))
        assertTrue(source.contains("2.dp.toPx() } * flyingGlassLift.value"))
        assertTrue(source.split("travelCenterCorrectionPx").size - 1 >= 4)
        assertFalse(source.contains("0.12f * localConversationGlassLift.value"))
        assertFalse(source.contains("0.12f * flyingGlassLift.value"))
    }

    @Test
    fun conversationDropPreviewOpensTheReleaseSlotInBothDirections() {
        assertTrue(conversationDropIndex(1, 4, insertAfter = true, itemCount = 6) == 4)
        assertTrue(conversationPreviewShift(2, 1, 4, 40f) == -40f)
        assertTrue(conversationPreviewShift(4, 1, 4, 40f) == -40f)
        assertTrue(conversationDropIndex(4, 1, insertAfter = false, itemCount = 6) == 1)
        assertTrue(conversationPreviewShift(1, 4, 1, 40f) == 40f)
        assertTrue(conversationPreviewShift(3, 4, 1, 40f) == 40f)
        assertTrue(conversationPreviewShift(4, 4, 1, 40f) == 0f)
    }

    @Test
    fun conversationDragPreviewAndCommitShareOneStableDestinationSlot() {
        assertTrue(conversationDragDestinationIndex(1, 0f, 40f, 6) == 1)
        assertTrue(conversationDragDestinationIndex(1, 81f, 40f, 6) == 3)
        assertTrue(conversationDragDestinationIndex(4, -121f, 40f, 6) == 1)
        assertTrue(conversationDragDestinationIndex(1, 999f, 40f, 6) == 5)
        assertTrue(conversationDragDestinationIndex(4, -999f, 40f, 6) == 0)
        assertTrue(clampConversationDragDelta(1, -999f, 40f, 6) in -83.5f..-80f)
        assertTrue(clampConversationDragDelta(1, 999f, 40f, 6) in 200f..203.5f)
        assertTrue(clampConversationDragDelta(4, -999f, 40f, 6) in -203.5f..-200f)
        assertTrue(clampConversationDragDelta(4, 999f, 40f, 6) in 80f..83.5f)
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        assertFalse(source.contains("dragTargetConversationId"))
        assertFalse(source.contains("localDropTargetId"))
        assertTrue(source.contains("glassArrivedConversationId = targetId"))
        assertTrue(source.contains("localGlassArrivedId = targetId"))
        assertTrue(source.contains("beginConversationDrag(conv.id)"))
        assertTrue(source.contains("beginLocalConversationDrag(conv.id)"))
        assertTrue(source.contains("val destinationGroupIndex = localDragDestinationGroupIndex"))
        assertTrue(source.contains("val destinationGroupIndex = dragDestinationGroupIndex"))
        assertTrue(source.contains("localDragItemHeight = localConversationBounds[conv.id]?.height ?: 0f"))
        assertTrue(source.contains("dragItemHeight = conversationBounds[conv.id]?.height ?: 0f"))
        assertTrue(source.contains("pointerDeltaY = nextPointerY - localDragOriginY"))
        assertTrue(source.contains("pointerDeltaY = nextPointerY - dragOriginY"))
        assertTrue(source.split("val nextPointerY = clampConversationDragDelta(").size - 1 == 2)
        assertTrue(source.split("val previousPointerY =").size - 1 == 2)
        assertFalse(source.contains("if (dragging) Modifier.liquidMotionDeformation(0f, dragVelocityY, density.density)"))
    }

    @Test
    fun conversationAndSidebarSelectorsUseOnlyFillForSelection() {
        val sidebar = java.io.File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        assertTrue(sidebar.contains("glassCovered = localConversationGlassVisible &&"))
        assertTrue(sidebar.contains("glassCovered = flyingConversationGlass &&"))
        assertTrue(sidebar.split("lifted || glassCovered -> Color.Transparent").size - 1 >= 2)
        assertFalse(sidebar.contains("if (selected && !reordering) pc.accent else pc.border"))
        assertFalse(sidebar.contains("if (active && !reordering) palette.accent else palette.border"))
        assertFalse(sidebar.contains("enabled = !lifted && !glassCovered"))
        assertTrue(sidebar.contains("landing = false\n                        moving = false\n                        selectedIndex = target"))
        assertTrue(sidebar.contains("selected = !localConversationGlassVisible && conv.id == localVisualSelectedId"))
    }

    @Test
    fun reorderedActiveConversationImmediatelyUsesItsNewGlassOrigin() {
        val bounds = mutableMapOf(
            "a" to androidx.compose.ui.geometry.Rect(0f, 0f, 100f, 40f),
            "b" to androidx.compose.ui.geometry.Rect(0f, 40f, 100f, 80f),
            "c" to androidx.compose.ui.geometry.Rect(0f, 80f, 100f, 120f),
        )
        rebaseConversationBounds(bounds, listOf("a", "b", "c"), listOf("b", "c", "a"))
        assertTrue(bounds.getValue("a").top == 80f)
        assertTrue(bounds.getValue("b").top == 0f)
        assertTrue(bounds.getValue("c").top == 40f)
    }

    @Test
    fun conversationReorderUsesAvoidanceWithoutASecondSelectedOrDropCapsule() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        assertTrue(source.contains("reordering = draggingLocalId != null"))
        assertTrue(source.contains("reordering = draggingConversationId != null"))
        assertTrue(source.contains("selected && !reordering -> pc.activeSurface"))
        assertTrue(source.contains("active && !reordering -> palette.activeSurface"))
        assertFalse(source.contains("dropTarget -> pc.accent.copy"))
        assertFalse(source.contains("dropTarget -> palette.accent.copy"))
    }

    @Test
    fun localConversationCapsuleKeepsTitleVerticallyCenteredAndLeftAligned() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        val row = source.substringAfter("private fun LocalConversationRow(").substringBefore("private fun ConversationRow(")
        assertTrue(row.contains("contentAlignment = Alignment.CenterStart"))
        assertTrue(row.contains("textAlign = androidx.compose.ui.text.style.TextAlign.Start"))
        assertFalse(row.contains("TextAlign.Center"))
    }

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
        org.junit.Assert.assertTrue(source.contains("alpha = (1f - leftReveal).coerceIn(0f, 1f)"))
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
