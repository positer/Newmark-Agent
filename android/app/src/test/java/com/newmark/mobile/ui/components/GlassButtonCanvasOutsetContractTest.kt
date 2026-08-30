package com.newmark.mobile.ui.components

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassButtonCanvasOutsetContractTest {
    @Test
    fun compactGlassControlsUseARealMeasuredCanvasAroundTheNominalHitBox() {
        val liquid = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val sidebar = File("src/main/java/com/newmark/mobile/ui/Sidebar.kt").readText()
        val memoryLab = File("src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt").readText()

        assertTrue(liquid.contains("val GlassButtonCanvasOutset = 8.dp"))
        assertTrue(liquid.contains("modifier\n            .size(visualSize)"))
        assertTrue(liquid.contains(".size(visualSize)\n            .then(clickModifier)"))
        assertTrue(liquid.contains(".requiredSize(visualSize + GlassButtonCanvasOutset * 2)"))
        assertTrue(liquid.contains(".glassButtonSurface(opticalShape, surfaceColor, alpha, restingBorderColor)"))
        assertTrue(liquid.contains("CenteredInsetShape(shape, GlassButtonCanvasOutset)"))
        assertTrue(liquid.contains("visualModifier\n                .size(visualSize)"))
        assertTrue(chat.substringAfter("private fun CircleButton").substringBefore("// ---- 对话内容").contains("GlassButtonCanvas("))
        assertTrue(chat.substringAfter("private fun ModelButton").substringBefore("private fun PlusCombo").contains("GlassButtonCanvas("))
        assertTrue(chat.substringAfter("private fun PlusCombo").substringBefore("private fun SubmitButton").contains("GlassButtonCanvas("))
        val scrollToBottom = chat.substringAfter("// Floating scroll-to-bottom button").substringBefore("internal const val TranscriptBottomReserveLines")
        assertTrue(scrollToBottom.contains("GlassButtonCanvas("))
        assertTrue(scrollToBottom.contains("visualSize = 40.dp"))
        assertTrue(scrollToBottom.contains("restingBorderColor = p.border2"))
        assertTrue(!scrollToBottom.contains("visualModifier = Modifier.border"))
        assertTrue(liquid.contains("restingBorderColor = restingBorderColor"))
        assertTrue(!scrollToBottom.contains(".size(40.dp)\n                    .glassButtonSurface"))
        assertTrue(chat.contains(".width(32.dp)"))
        assertTrue(chat.contains("Box(Modifier.size(InputComposerEdgeControlSize))"))
        assertTrue(!chat.contains("InputComposerEdgeControlSize + GlassButtonCanvasOutset * 2"))
        assertTrue(sidebar.substringAfter("SectionLabel(\"本地对话\")").substringBefore("ConversationList(").contains("GlassButtonCanvas("))
        val memoryBack = memoryLab.substringAfter("// 顶栏").substringBefore("// 视图 tab + Reindex")
        val memoryActions = memoryLab.substringAfter("private fun MemoryLabGlassAction(")
            .substringBefore("internal fun memoryLabOverviewLabelColor")
        assertTrue(memoryBack.contains("GlassButtonCanvas("))
        assertTrue(memoryActions.contains("visualWidth = visualWidth"))
        assertTrue(memoryActions.contains("visualHeight = visualHeight"))
        assertTrue(memoryActions.contains("GlassButtonCanvas("))
        assertTrue(!memoryBack.contains(".glassButtonSurface"))
        assertTrue(!memoryActions.contains(".glassButtonSurface"))
        assertTrue(liquid.contains(".requiredSize(\n                    visualWidth + GlassButtonCanvasOutset * 2,"))
    }

    @Test
    fun everySharedGlassButtonDisablesInternalShapeClipAndUsesDensityAwareHighlightCanvas() {
        val liquid = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val backdrop = File("src/main/java/com/kyant/backdrop/DrawBackdropModifier.kt").readText()
        val highlight = File("src/main/java/com/kyant/backdrop/highlight/HighlightModifier.kt").readText()

        val buttonEdge = liquid.substringAfter("fun Modifier.kyantGlassEdge(")
            .substringBefore("fun LiquidGlassSwitch(")
        assertTrue(buttonEdge.contains("clipToShape = false"))
        assertTrue(backdrop.contains("clipToShape: Boolean = true"))
        assertTrue(backdrop.contains("clip = clipToShape"))
        assertTrue(backdrop.contains("properties[\"clipToShape\"] = clipToShape"))
        assertTrue(highlight.contains("highlight.width.toPx() + highlight.blurRadius.toPx()"))
        assertTrue(highlight.contains("outset * 2"))
        assertTrue(highlight.contains("translate(outset.toFloat(), outset.toFloat())"))
        assertTrue(highlight.contains("translate(-outset.toFloat(), -outset.toFloat())"))
    }
}
