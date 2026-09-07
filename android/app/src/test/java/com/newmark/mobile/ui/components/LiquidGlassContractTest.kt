package com.newmark.mobile.ui.components

import java.io.File
import com.newmark.mobile.ui.theme.DefaultGlassAlpha
import com.newmark.mobile.ui.theme.scaledGlassAlpha
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Kyant backdrop (AndroidLiquidGlass) 液态玻璃契约测试。
 *
 * 覆盖 vendor 库在 Kotlin 2.0/Compose 1.7 适配后仍保持的语义：
 *  - 效果参数与 PC --glass-blur-3 / saturate(140%) 对齐
 *  - 库常量（默认高光/阴影/内阴影）保持稳定
 *  - 玻璃透明度按产品默认档位缩放
 */
class LiquidGlassContractTest {

    @Test
    fun switchTapTogglesWhileConfirmedDragUsesReleasePosition() {
        assertTrue(liquidSwitchReleaseValue(checked = false, dragging = false, releaseFraction = 0f))
        assertFalse(liquidSwitchReleaseValue(checked = true, dragging = false, releaseFraction = 1f))
        assertFalse(liquidSwitchReleaseValue(checked = true, dragging = true, releaseFraction = 0.49f))
        assertTrue(liquidSwitchReleaseValue(checked = false, dragging = true, releaseFraction = 0.5f))
    }

    @Test
    fun pcGlassCurveMatchesLiquidDefaults() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        assertTrue(source.contains("blurRadius: Dp = 3.dp"))
        assertTrue(source.contains("saturation: Float = 1.4f"))
        assertTrue(source.contains("val MobileInteractionGlassEdge = 7.dp"))
        assertTrue(source.contains("val MobileConversationGlassHorizontalEdge = 14.dp"))
        assertTrue(source.contains("(speedDpPerSecond - 8f) / 650f"))
        assertTrue(source.contains("amount * 0.09f"))
        assertTrue(source.contains("amount * 0.042f"))
        assertTrue(source.contains("refractionHeight: Dp = MobileInteractionGlassEdge"))
        assertTrue(source.contains("refractionAmount: Dp = 8.dp"))
    }

    @Test
    fun liquidModifierCachesTheKyantNodeWithoutReducingEffects() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt").readText()
        val modifier = source.substringAfter("fun Modifier.liquidGlassModifier(")
            .substringBefore("fun Modifier.glassButtonSurface(")
        assertTrue(modifier.contains("val glassModifier = remember("))
        assertTrue(modifier.contains("return this.then(isolatedOptics).then(pointerModifier)"))
        assertTrue(modifier.contains("Modifier.transformGlassOptics(glassModifier, layerBlock)"))
        assertTrue(modifier.contains("} else glassModifier"))
        assertTrue(modifier.contains("colorControls(saturation = saturation)"))
        assertTrue(modifier.contains("blur(blurRadius.toPx())"))
        assertTrue(modifier.contains("chromaticAberration = true"))
        assertTrue(modifier.contains("thickGlassHighlight(ambientHighlight)"))
        assertTrue(modifier.contains("thickGlassHighlight(ambientHighlight)"))
        assertTrue(modifier.contains("edgeHighlight: Boolean = true"))
        assertTrue(modifier.contains("if (edgeHighlight) thickGlassHighlight(ambientHighlight) else null"))
        assertTrue(modifier.contains("Shadow.Default"))
        assertTrue(modifier.contains("InnerShadow(radius = 2.dp"))
    }

    @Test
    fun portraitDrawerDisablesFullHeightCarrierEdgeHighlight() {
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        val drawer = app.substringAfter("            UnclippedSidebarDrawer(").substringBefore("    ) {")
        assertTrue(drawer.contains("edgeHighlight = false"))
        assertTrue(drawer.contains("The portrait drawer is a full-height rectangular"))
    }

    @Test
    fun vendoredBackdropDefersLensUntilDrawSizeIsKnown() {
        val source = File("src/main/java/com/kyant/backdrop/DrawBackdropModifier.kt").readText()
        val guard = source.indexOf("if (effectScope.size == Size.Unspecified)")
        val apply = source.indexOf("effectScope.apply(effects)", startIndex = guard.coerceAtLeast(0))
        assertTrue(guard >= 0)
        assertTrue(apply > guard)
    }

    @Test
    fun backdropRecordersNeverWrapTheirGlassConsumers() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val app = File(sourceRoot, "NewmarkApp.kt").readText()
        val memoryLab = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val sidebar = File(sourceRoot, "RightSidebar.kt").readText()
        val settings = File(sourceRoot, "SettingsScreen.kt").readText()

        // A LayerBackdrop records a GraphicsLayer. Wrapping a drawBackdrop
        // consumer in that recorder creates a self-referential RenderNode tree
        // and crashes RenderThread with a native stack overflow.
        assertFalse(app.contains("Box(Modifier.fillMaxSize().layerBackdrop(liquidBackdrop))"))
        assertTrue(app.contains("ConversationSurfaceContent(") && app.contains(".layerBackdrop(liquidBackdrop)"))
        assertTrue(app.contains("Row(Modifier.layerBackdrop(liquidBackdrop).fillMaxSize())"))
        listOf(memoryLab, sidebar, settings).forEach { source ->
            assertTrue(source.contains("Box(Modifier.fillMaxSize().layerBackdrop(backdrop))"))
            assertFalse(source.contains("layerBackdrop(backdrop).background("))
        }
    }

    @Test
    fun transientOverlaysKeepBackdropRecordersOutsideTheirGlassConsumers() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val anchorMenu = File(sourceRoot, "components/AnchorMenu.kt").readText()
        val chat = File(sourceRoot, "ChatScreen.kt").readText()
        val liquid = File(sourceRoot, "components/LiquidGlass.kt").readText()
        assertTrue(anchorMenu.contains("liquidPopupShell("))
        assertFalse(anchorMenu.contains(".shadow("))
        assertFalse(anchorMenu.contains("val entrance = remember { Animatable"))
        assertFalse(anchorMenu.contains(".border(0.5.dp, Color.White.copy(alpha = 0.28f), shape)"))
        assertFalse(anchorMenu.contains("kyantGlassEdge("))
        val menuRow = anchorMenu.substringAfter("fun MenuRow(")
        assertFalse(menuRow.contains("directOptionInteraction("))
        assertTrue(menuRow.contains(".clickable("))
        assertFalse(menuRow.contains("translationY = -2.dp.toPx() * movement"))
        assertFalse(menuRow.contains("scaleX = 1f +"))
        assertFalse(menuRow.contains("scaleY = 1f +"))
        val compositeMenu = chat.substringAfter("private fun InputCompositeMenuOverlay(")
            .substringBefore("/** 模型选择按钮")
        assertTrue(chat.contains("if (inputMenu != null) Modifier.layerBackdrop(inputMenuBackdrop)"))
        assertTrue(chat.contains("backdrop = inputMenuBackdrop"))
        assertEquals(1, compositeMenu.split(".liquidPopupShell(").size - 1)
        assertEquals(0, compositeMenu.split(".liquidSelectionMorph(").size - 1)
        assertTrue(compositeMenu.contains("if (moving && flightScheduler.activeIndex >= 0)"))
        assertTrue(compositeMenu.contains("if (entry.selected && !moving) p.accentSoft"))
        assertFalse(compositeMenu.contains("val glassProgress by animateFloatAsState("))
        assertFalse(compositeMenu.contains("targetValue = if (landing || lifting) 0f else if (moving) 1f else 0f"))
        assertTrue(compositeMenu.contains("val menuShape = MobilePopupShape"))
        assertTrue(compositeMenu.contains("RoundedCornerShape(22.dp)"))
        assertTrue(compositeMenu.contains("val activeOffsetPx = remember { Animatable(0f) }"))
        assertTrue(compositeMenu.contains("selectedIndex = entries.indexOfFirst { it.selected }"))
        assertTrue(compositeMenu.contains("var popupDragOffset"))
        assertTrue(compositeMenu.contains("var popupPressed"))
        assertTrue(compositeMenu.contains("onShellDrag(position - holdStartPoint)"))
        assertTrue(compositeMenu.contains("onShellPress = { popupPressed = it }"))
        assertTrue(compositeMenu.contains("externalDragOffset = popupDragOffset"))
        assertTrue(compositeMenu.contains("externalPressed = popupPressed"))
        assertTrue(compositeMenu.contains("scaleX = popupScale.value"))
        assertTrue(liquid.contains("label = \"liquidPopupPressScale\""))
        assertTrue(
            liquid.indexOf("liquidPopupInteraction(shape).liquidGlassModifier(") <
                liquid.indexOf("private fun Modifier.liquidPopupInteraction(shape: Shape)"),
        )
        assertTrue(liquid.contains("layerBlock: (GraphicsLayerScope.() -> Unit)? = null"))
        assertTrue(liquid.contains("Modifier.transformGlassOptics(glassModifier, layerBlock)"))
        assertFalse(liquid.contains("layerBlock = layerBlock"))
        assertTrue(liquid.contains("externalDragOffset: Offset? = null"))
        assertTrue(liquid.contains("externalPressed: Boolean? = null"))
        assertTrue(liquid.contains("val effectiveDragOffset = externalDragOffset ?: dragOffset"))
        assertTrue(liquid.contains("surfaceOverlay: (DrawScope.() -> Unit)? = null"))
        assertTrue(liquid.contains("surfaceOverlay?.invoke(this)"))
        assertTrue(liquid.contains("surfaceOverlay = {"))
        assertTrue(liquid.contains("pointerGlow = false"))
        assertFalse(compositeMenu.contains("directOptionInteraction("))
        assertTrue(compositeMenu.contains(".liquidHoldDragGesture("))
        assertTrue(compositeMenu.contains("holdMillis = 300L"))
        assertTrue(compositeMenu.contains("val sourceIndex = selectedIndex.takeIf { it >= 0 } ?: index"))
        assertTrue(compositeMenu.contains("fun flySelectionTo(index: Int)"))
        assertTrue(compositeMenu.contains("val redirecting = moving"))
        assertTrue(compositeMenu.contains("flightScheduler.cancel()"))
        assertTrue(compositeMenu.contains("activeOffsetPx.animateTo("))
        assertTrue(compositeMenu.contains("tween(durationMillis = 240, easing = PcQueueEase)"))
        assertTrue(compositeMenu.contains("onTap = { position ->"))
        assertTrue(compositeMenu.contains("onHoldStart = { position ->"))
        assertTrue(compositeMenu.contains("onDrag = { position, _ ->"))
        assertTrue(compositeMenu.contains("landSelection(releasedIndex)"))
        assertFalse(compositeMenu.contains("liquidMenuSelectionMaterial"))
        assertTrue(compositeMenu.contains("moving = false"))
        assertFalse(compositeMenu.contains("liquidMenuSelectionLiftScaleX"))
        assertFalse(compositeMenu.contains("liquidMenuSelectionLiftScaleY"))
        assertFalse(compositeMenu.contains(".liquidSelectionMorph("))
        assertFalse(compositeMenu.contains("fillColor = p.accentSoft"))
        assertFalse(compositeMenu.contains("glassProgress = glassProgress"))
        assertTrue(compositeMenu.contains("activeOffsetPx.animateTo("))
        assertTrue(compositeMenu.contains("translationY = activeOffsetPx.value"))
        assertTrue(compositeMenu.contains("velocityY = { activeOffsetPx.velocity }"))
        assertTrue(compositeMenu.contains(".liquidMotionDeformationDeferred("))
        assertFalse(compositeMenu.contains(".offset(y = activeOffset)"))
        assertTrue(compositeMenu.contains("if (index >= 0)"))
        assertFalse(compositeMenu.substringAfter("entries.forEachIndexed").contains(".clickable("))
        assertFalse(compositeMenu.contains(".shadow(12.dp"))
        assertFalse(compositeMenu.contains(".border(1.5.dp"))
        assertFalse(compositeMenu.contains("Color.White.copy(alpha = 0.30f)"))
        assertFalse(compositeMenu.contains("land = { delay(240L) }"))
        val liquidGlass = File(sourceRoot, "components/LiquidGlass.kt").readText()
        val switchStart = liquidGlass.indexOf("fun LiquidGlassSwitch(")
        assertTrue(switchStart >= 0)
        assertTrue(liquidGlass.indexOf("draggedFraction", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("pointerInput(enabled, density)", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("liquidGlassModifier(", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("targetValue = if (pressed) 1.22f else 1f", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("targetValue = if (pressed) 30.dp else 24.dp", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("Brush.horizontalGradient", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("fraction to p.accent", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("fraction to p.bgQuaternary", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("translationX = thumbOffset.toPx()", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("viewConfiguration.touchSlop", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("var dragging = false", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("if (released) settle(if (verticalScroll)", switchStart) > switchStart)
        assertTrue(liquidGlass.indexOf("liquidSwitchReleaseValue(currentChecked, dragging, releaseFraction)", switchStart) > switchStart)
        assertFalse(liquidGlass.substring(switchStart).contains(".offset(x = thumbOffset"))
        assertTrue(compositeMenu.contains("LocalSidebarGestureLock.current"))
    }

    @Test
    fun everyMobileLiquidPopupShrinksBeforeRemovalInsteadOfFlashingOut() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val liquid = File(sourceRoot, "components/LiquidGlass.kt").readText()
        val anchorMenu = File(sourceRoot, "components/AnchorMenu.kt").readText()
        val memory = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val right = File(sourceRoot, "RightSidebar.kt").readText()
        val settings = File(sourceRoot, "SettingsScreen.kt").readText()

        assertTrue(liquid.contains("class LiquidPopupExitController"))
        assertTrue(liquid.contains("scale.animateTo(0.62f"))
        assertTrue(liquid.contains("fun Modifier.liquidPopupExit("))
        assertTrue(anchorMenu.contains("targetScale = 0.62f"))
        assertTrue(memory.split("rememberLiquidPopupExit(").size - 1 >= 2)
        assertTrue(right.contains("rememberLiquidPopupExit("))
        assertTrue(settings.split("rememberLiquidPopupExit").size - 1 >= 2)
        assertTrue(memory.contains(".liquidPopupExit(exit)"))
        assertTrue(right.contains(".liquidPopupExit(exit)"))
        assertTrue(settings.contains(".liquidPopupExit(confirmExit)"))
        assertTrue(settings.contains(".liquidPopupExit(deviceExit)"))
    }

    @Test
    fun compactConversationRecordsOnlyWhileGlassSidebarIsPresented() {
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(app.contains("if (blurProgress > 0.001f)"))
        assertTrue(app.contains("Modifier.layerBackdrop(liquidBackdrop)"))
        assertFalse(app.contains("modifier = Modifier\n                    .layerBackdrop(liquidBackdrop)"))
    }

    @Test
    fun settingsUsesGlassSwitchesOnly() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        assertFalse(settings.contains("import androidx.compose.material3.Switch"))
        assertFalse(settings.contains("SwitchDefaults"))
        assertFalse(Regex("\\bSwitch\\s*\\(").containsMatchIn(settings))
        assertTrue(settings.split("LiquidGlassSwitch(").size - 1 >= 7)
    }

    @Test
    fun namedMobileButtonsUseSharedNonSamplingGlassSurface() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val liquid = File(sourceRoot, "components/LiquidGlass.kt").readText()
        val chat = File(sourceRoot, "ChatScreen.kt").readText()
        val sidebar = File(sourceRoot, "Sidebar.kt").readText()
        val right = File(sourceRoot, "RightSidebar.kt").readText()
        val settings = File(sourceRoot, "SettingsScreen.kt").readText()
        val memoryLab = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val terminal = File(sourceRoot, "TerminalScreen.kt").readText()
        assertTrue(liquid.contains("fun Modifier.glassButtonSurface("))
        val buttonSurface = liquid.substringAfter("fun Modifier.glassButtonSurface(").substringBefore("fun LiquidGlassSwitch(")
        assertTrue(buttonSurface.contains(".kyantGlassEdge("))
        assertTrue(buttonSurface.contains("Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED)"))
        assertTrue(buttonSurface.contains("pressProgress.animateTo(1f, tween(durationMillis = 105))"))
        assertTrue(buttonSurface.contains("release.await()"))
        assertTrue(buttonSurface.contains("pressProgress.animateTo(0f, tween(durationMillis = 165))"))
        assertTrue(buttonSurface.contains("clip = false"))
        assertTrue(buttonSurface.contains("translationY = pressLift.toPx()"))
        val edgeGlow = liquid.substringAfter("fun Modifier.kyantGlassEdge(").substringBefore("fun LiquidGlassSwitch(")
        assertTrue(edgeGlow.contains("return drawBackdrop("))
        assertTrue(edgeGlow.contains("if (!enabled)"))
        assertTrue(edgeGlow.contains("backdrop = EmptyBackdrop"))
        assertTrue(edgeGlow.contains("effects = {}"))
        assertTrue(edgeGlow.contains("style = HighlightStyle.Plain("))
        assertTrue(edgeGlow.contains("Shadow("))
        assertTrue(edgeGlow.contains("InnerShadow("))
        assertTrue(edgeGlow.contains("width = 1.5.dp + 0.15.dp * emphasis"))
        assertTrue(edgeGlow.contains("blurRadius = 0.5.dp + 0.15.dp * emphasis"))
        assertTrue(edgeGlow.contains("onDrawSurface = surfaceOverlay"))
        listOf(chat, sidebar, right, settings, memoryLab, terminal).forEach { source ->
            assertTrue(source.contains("glassButtonSurface(") || source.contains("GlassButtonCanvas("))
        }
        assertTrue(chat.substringAfter("private fun SubmitButton(").contains("GlassButtonCanvas("))
        val inputBody = chat
            .substringAfter("// 单行：+（模式/文件） | 输入 | 模型小按钮 | 发送。")
            .substringBefore("verticalAlignment = Alignment.Bottom")
        assertFalse(inputBody.contains("glassButtonSurface("))
        assertFalse(inputBody.contains("kyantGlassEdge("))
        assertFalse(inputBody.contains("drawBackdrop("))
        assertTrue(terminal.substringAfter("BasicTextField(").contains("glassButtonSurface(CircleShape, p.accent"))
        val memoryActions = memoryLab.substringAfter("// 视图 tab + Reindex")
        assertTrue(memoryActions.contains("GlassButtonCanvas("))
        assertFalse(memoryLab.substringAfter("private fun MemoryLabGlassAction(").contains("glassButtonSurface("))
        assertTrue(settings.substringAfter("private fun PairingPage(").contains("glassButtonSurface("))
    }

    @Test
    fun everyExistingLiquidFloatUsesSharedBlockedDirectionResistance() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val liquid = File(sourceRoot, "components/LiquidGlass.kt").readText()
        val sidebar = File(sourceRoot, "Sidebar.kt").readText()
        val right = File(sourceRoot, "RightSidebar.kt").readText()
        val memory = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val chat = File(sourceRoot, "ChatScreen.kt").readText()

        assertTrue(liquid.contains("\"shared_glass_buttons\""))
        assertTrue(liquid.contains("internal fun resistedLiquidBoundaryPosition("))
        assertTrue(liquid.contains("sqrt(abs(blocked)) * response"))
        assertTrue(liquid.contains("maxDisplacement"))
        assertTrue(right.contains("resistedLiquidBoundaryPosition("))
        assertTrue(memory.contains("resistedLiquidBoundaryPosition("))
        assertTrue(sidebar.split("resistedLiquidBoundaryPosition(").size - 1 >= 2)
        assertTrue(chat.contains("heldBoundaryOffsetPx"))
        assertTrue(chat.contains("resistedLiquidBoundaryPosition("))
        assertFalse(chat.contains("directOptionInteraction("))
        assertTrue(chat.contains("activeOffsetPx.value + heldBoundaryOffsetPx"))
        assertTrue(liquid.contains("horizontalShare * 0.032f - verticalShare * 0.015f"))
        assertTrue(liquid.contains("verticalShare * 0.032f - horizontalShare * 0.015f"))
    }

    @Test
    fun marqueeIsContinuousBlackWhiteBlackWhiteBorder() {
        val marquee = File("src/main/java/com/newmark/mobile/ui/components/Marquee.kt").readText()
        assertTrue(marquee.contains("0f to Color.Black"))
        assertTrue(marquee.contains("0.25f to Color.White"))
        assertTrue(marquee.contains("0.5f to Color.Black"))
        assertTrue(marquee.contains("0.75f to Color.White"))
        assertTrue(marquee.contains("1f to Color.Black"))
        assertTrue(marquee.contains("style = Stroke(width = stroke)"))
        assertTrue(marquee.contains("enabled: Boolean = true"))
        assertTrue(marquee.contains("modifier.then(if (enabled) Modifier.drawBehind"))
    }

    @Test
    fun kyantDispersionKeepsOriginalLensFlowWithOnlyRgbSamples() {
        val shader = File("src/main/java/com/kyant/backdrop/Shaders.kt").readText()
        val dispersion = shader.substringAfter("internal val RoundedRectRefractionWithDispersionShaderString")
            .substringBefore("internal const val DefaultHighlightShaderString")
        assertTrue(dispersion.contains("half4 red = content.eval(refractedCoord + dispersedCoord)"))
        assertTrue(dispersion.contains("half4 green = content.eval(refractedCoord)"))
        assertTrue(dispersion.contains("half4 blue = content.eval(refractedCoord - dispersedCoord)"))
        assertTrue(dispersion.contains("return half4(red.r, green.g, blue.b"))
        assertFalse(dispersion.contains("half4 orange ="))
        assertFalse(dispersion.contains("half4 yellow ="))
        assertFalse(dispersion.contains("half4 cyan ="))
        assertFalse(dispersion.contains("half4 purple ="))
    }

    @Test
    fun backdropLibraryExposesStableDefaults() {
        // 库提供稳定的默认高光/阴影/内阴影
        assertTrue(com.kyant.backdrop.highlight.Highlight.Default.width.value > 0f)
        assertTrue(com.kyant.backdrop.shadow.Shadow.Default.radius.value > 0f)
        assertTrue(com.kyant.backdrop.shadow.InnerShadow.Default.radius.value > 0f)
    }

    @Test
    fun glassAlphaScalesWithProductDefault() {
        val scaled = scaledGlassAlpha(0.72f, DefaultGlassAlpha)
        assertEquals(0.72f, scaled, 0.001f)
        assertFalse(scaled > DefaultGlassAlpha)
    }

    @Test
    fun dialogGlassUsesKyantDepthAndSurfaceAlpha() {
        // Dialog 弹窗玻璃：0.78f 表面透明度 + kyant 高光/阴影/内阴影默认值
        assertTrue(com.kyant.backdrop.highlight.Highlight.Plain.width.value > 0f)
        assertTrue(com.kyant.backdrop.shadow.Shadow.Default.alpha == 1f)
        assertTrue(com.kyant.backdrop.shadow.InnerShadow.Default.alpha == 1f)
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val memoryLab = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val sidebar = File(sourceRoot, "RightSidebar.kt").readText()
        val settings = File(sourceRoot, "SettingsScreen.kt").readText()
        assertTrue(memoryLab.contains("shape = MobilePopupShape") && memoryLab.contains("DialogBackdropBlur(42.dp)"))
        assertTrue(sidebar.contains("shape = MobilePopupShape") && sidebar.contains("DialogBackdropBlur(42.dp)"))
        assertTrue(settings.contains("shape = MobilePopupShape") && settings.contains("DialogBackdropBlur(42.dp)"))
        listOf(memoryLab, sidebar, settings).forEach { source ->
            assertFalse(source.contains("layerBackdrop(backdrop).background(p.bgPrimary)"))
            assertFalse(source.contains("layerBackdrop(backdrop).background("))
            assertTrue(source.contains("liquidPopupShell("))
            assertTrue(source.contains("alpha = 0.18f") && source.contains("blurRadius = 12.dp"))
            assertTrue(source.contains("refractionHeight = MobileInteractionGlassEdge"))
            assertTrue(source.contains("surfaceColor = p.bgSecondary"))
        }
    }

    @Test
    fun mobileSelectorsShareOneEmptyFloatingGlassAndLockSidebarSwipes() {
        val sourceRoot = File("src/main/java/com/newmark/mobile/ui")
        val sidebar = File(sourceRoot, "Sidebar.kt").readText()
        val right = File(sourceRoot, "RightSidebar.kt").readText()
        val memory = File(sourceRoot, "MemoryLabScreen.kt").readText()
        val app = File(sourceRoot, "NewmarkApp.kt").readText()
        val chat = File(sourceRoot, "ChatScreen.kt").readText()

        assertTrue(sidebar.contains("private fun ExpandedUtilityButtons("))
        assertTrue(sidebar.contains("setSidebarGestureLock(\"expanded-utility\", true)"))
        assertTrue(sidebar.contains(".liquidHoldDragGesture("))
        assertFalse(sidebar.contains("if (glassCovered) Color.Transparent else pc.buttonBorder"))
        assertTrue(sidebar.contains(".background(if (!moving && index == selectedIndex) pc.activeSurface else pc.control)"))
        assertTrue(sidebar.contains(".background(if (!moving && index == selectedIndex) pc.activeSurface else pc.control, RoundedCornerShape(50))"))
        assertTrue(sidebar.split("lifted || glassCovered -> Color.Transparent").size - 1 >= 2)
        assertFalse(sidebar.contains("if (selected && !reordering) pc.accent else pc.border"))
        assertFalse(sidebar.contains("if (active && !reordering) palette.accent else palette.border"))
        assertTrue(sidebar.contains("selected = !localConversationGlassVisible && conv.id == localVisualSelectedId"))
        assertTrue(sidebar.contains("active = !flyingConversationGlass && conv.id == visualActiveConversationId"))
        assertTrue(sidebar.split(".liquidSelectionMorph(").size - 1 >= 4)
        assertTrue(sidebar.contains("glassProgress = localConversationGlassLift.value"))
        assertTrue(sidebar.contains("glassProgress = flyingGlassLift.value"))
        assertFalse(sidebar.contains("if (dragging) Modifier.liquidMotionDeformation(0f, dragVelocityY, density.density)"))
        assertTrue(sidebar.contains("selectLocalConversationWithGlass"))
        assertTrue(sidebar.contains("fun beginLocalConversationDrag(targetId: String)"))
        assertTrue(sidebar.contains("fun beginConversationDrag(targetId: String)"))
        assertTrue(sidebar.contains("beginLocalConversationDrag(conv.id)"))
        assertTrue(sidebar.contains("beginConversationDrag(conv.id)"))
        assertTrue(sidebar.split(".requiredWidth(with(").size - 1 >= 2)
        assertTrue(sidebar.split(".requiredHeight(with(").size - 1 >= 2)
        assertTrue(sidebar.split("MobileConversationGlassHorizontalEdge.toPx()").size - 1 >= 2)
        assertFalse(sidebar.contains("scaleX = localConversationGlassScaleX.value"))
        assertFalse(sidebar.contains("scaleY = localConversationGlassScaleY.value"))
        assertFalse(sidebar.contains("scaleX = flyingGlassScaleX.value"))
        assertFalse(sidebar.contains("scaleY = flyingGlassScaleY.value"))
        assertTrue(sidebar.contains("horizontalEdgePx * 2f * localConversationGlassScaleX.value"))
        assertTrue(sidebar.contains("edgePx * 2f * localConversationGlassScaleY.value"))
        assertTrue(sidebar.contains("horizontalEdgePx * 2f * flyingGlassScaleX.value"))
        assertTrue(sidebar.contains("edgePx * 2f * flyingGlassScaleY.value"))
        // Real constrained-panel pixels and both color endpoints are covered
        // by ConversationLiftRenderingTest; the old negative offset doubled
        // Compose's implicit overflow centering and clipped the lens left.
        assertTrue(sidebar.contains("translationX = localConversationGlassX + travelCenterCorrectionPx"))
        assertTrue(sidebar.contains("translationX = flyingGlassX + travelCenterCorrectionPx"))
        assertTrue(sidebar.contains("val releasedTop = localConversationGlassY.value + localDragFollower.stopAndRead()"))
        assertTrue(sidebar.contains("val releasedTop = flyingGlassY.value + dragFollower.stopAndRead()"))
        assertFalse(sidebar.contains("val liftedModifier = if (lifted)"))
        assertTrue(sidebar.contains("onReorderLocal(group)"))
        assertTrue(sidebar.contains("val shape = RoundedCornerShape(50)"))
        assertTrue(sidebar.contains("LeftSidebarUtilityFloatRightOffset"))
        assertTrue(sidebar.contains("translationX = with(density) {"))
        assertTrue(right.contains("setSidebarGestureLock(\"right-tab-selector\", true)"))
        assertTrue(right.contains(".liquidHoldDragGesture("))
        assertTrue(right.contains("tabs.forEachIndexed { index, target ->"))
        assertTrue(right.contains("val active = !moving && index == visualSelectedIndex"))
        assertTrue(right.contains("if (active) p.accentSoft else Color.Transparent"))
        assertTrue(right.contains("modifier = Modifier.onGloballyPositioned"))
        assertTrue(right.contains("tabBounds[index] = coordinates.boundsInParent()"))
        assertTrue(right.contains("if (draggingGlass) dragFollower.value else glassX.value"))
        assertTrue(memory.contains("internal fun MemoryLabViewPager("))
        assertTrue(memory.contains("setSidebarGestureLock(\"memory-lab-view-pager\", true)"))
        assertTrue(memory.contains(".liquidHoldDragGesture("))
        val holdGesture = File(sourceRoot, "components/LiquidHoldGesture.kt").readText()
        assertTrue(holdGesture.contains("holdMillis: Long = 300L"))
        assertTrue(holdGesture.contains("currentCandidateStart()"))
        assertTrue(holdGesture.contains("currentCandidateEnd()"))
        assertTrue(holdGesture.contains("escapedToScroll = true"))
        assertTrue(holdGesture.contains("currentTap(latest)"))
        assertTrue(holdGesture.contains("currentHoldEnd(latest, moved)"))
        assertTrue(memory.contains("contentAlignment = Alignment.Center"))
        assertTrue(memory.contains(".widthIn(max = 960.dp)"))
        assertTrue(memory.contains(".heightIn(max = 720.dp)"))
        assertTrue(memory.contains("decorFitsSystemWindows = false"))
        val liquid = File(sourceRoot, "components/LiquidGlass.kt").readText()
        assertTrue(liquid.contains("LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS"))
        assertTrue(liquid.contains("val MobileInteractionGlassEdge = 7.dp"))
        assertTrue(liquid.contains("val MobileConversationGlassHorizontalEdge = 14.dp"))
        assertTrue(liquid.contains("fun Modifier.liquidMotionDeformation("))
        assertTrue(right.contains("minimum = glassLeft(0)"))
        assertTrue(right.contains("maximum = glassLeft(tabs.lastIndex)"))
        assertFalse(sidebar.contains("scaleX = landingScale"))
        assertFalse(sidebar.contains("scaleY = landingScale"))
        assertFalse(sidebar.contains("scaleX = glassScale"))
        assertFalse(sidebar.contains("scaleY = glassScale"))
        assertTrue(sidebar.contains(".size(collapsedTargetSize + collapsedExpansion)"))
        assertTrue(sidebar.contains(".padding(horizontal = expandedTargetInset, vertical = expandedTargetInset)"))
        assertFalse(right.contains("scaleX = glassScaleX"))
        assertFalse(right.contains("scaleY = glassScaleY"))
        assertTrue(right.contains("val targetBounds = tabBounds[activeIndex]"))
        assertTrue(right.contains(".requiredSize(targetWidth + edgeExpansion, targetHeight + edgeExpansion)"))
        assertTrue(right.contains("targetBounds?.top"))
        assertTrue(right.contains("velocityX = { if (draggingGlass) dragFollower.velocity else glassX.velocity }"))
        assertTrue(memory.contains("velocityX = { if (draggingGlass) dragFollower.velocity else glassX.velocity }"))
        assertFalse(memory.contains("val glassScaleX"))
        assertFalse(memory.contains("val glassScaleY"))
        assertFalse(memory.contains("scaleX = glassScaleX"))
        assertFalse(memory.contains("scaleY = glassScaleY"))
        assertTrue(memory.contains(".width(slotWidth + edgeExpansion)"))
        assertTrue(memory.contains(".height(34.dp + edgeExpansion)"))
        assertTrue(liquid.contains("val MobilePopupShape = RoundedCornerShape(26.dp)"))
        assertTrue(app.contains("alpha = (1f - leftReveal).coerceIn(0f, 1f)"))
        assertTrue(app.contains("if (sidebarGestureLocks.isNotEmpty())"))
        assertTrue(app.contains("gesturesEnabled = true"))
        assertFalse(sidebar.contains("conversation.messages.size} 条消息"))
        assertTrue(right.contains("val redirecting = moving"))
        assertTrue(memory.contains("val redirecting = moving"))
        assertTrue(chat.contains("val popupScale = remember { Animatable(0.82f) }"))
        assertTrue(chat.contains("popupScale.animateTo(1f"))
    }

    @Test
    fun mobileRightSidebarUsesSquareCarrierWithoutHalfDragRefraction() {
        val right = File("src/main/java/com/newmark/mobile/ui/RightSidebar.kt").readText()
        val panelStart = right.indexOf("fun MobileRightSidebar(")
        val panelEnd = right.indexOf("private fun UploadsPanel(", panelStart.coerceAtLeast(0))
        assertTrue("the carrier function must exist", panelStart >= 0)
        assertTrue("the next component must bound the carrier, not the entire file", panelEnd > panelStart)
        val panel = right.substring(panelStart, panelEnd)

        assertTrue(panel.contains("p.bgTertiary.copy(alpha = 0.98f)"))
        assertTrue(panel.contains(".background(panelSurface)"))
        assertTrue(panel.contains("start = Offset(stroke / 2f, 0f)"))
        assertFalse(panel.contains("val panelShape"))
        assertFalse(panel.contains(".clip(panelShape)"))
        assertFalse(panel.contains("Modifier.liquidGlassModifier("))
        assertFalse(panel.contains("cornerRadius = 0.dp"))
    }
}
