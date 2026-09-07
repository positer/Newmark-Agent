package com.newmark.mobile.ui.components

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.zIndex
import androidx.compose.ui.window.DialogWindowProvider
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.InverseLayerScope
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.colorControls
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.highlight.Highlight
import com.kyant.backdrop.highlight.HighlightStyle
import com.kyant.backdrop.shadow.InnerShadow
import com.kyant.backdrop.shadow.Shadow
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.sign
import kotlin.math.sqrt

/**
 * Transparent layout space reserved around every compact glass control.
 *
 * This is deliberately a real measured canvas, not an instruction to draw
 * outside a button-sized RenderNode.  It contains the 7dp optical edge plus
 * highlight blur, shadow and the 1.065 press expansion.  The inner control
 * keeps its nominal size, semantics and hit target.
 */
// Optical envelope: a visibly thick, even 12dp overlap around the nominal
// color block. The parent layout/hit target remains unchanged.
val GlassButtonCanvasOutset = 12.dp

/** Render-only envelope; the nominal control center and hit box never move. */
internal fun expandedLiquidBounds(size: Size, outset: Float, progress: Float): Rect {
    val edge = outset.coerceAtLeast(0f) * progress.coerceIn(0f, 1f)
    return Rect(-edge, -edge, size.width + edge, size.height + edge)
}

/** For the non-sampling button edge canvas only. Lens shaders require an
 * actual CornerBasedShape and must expand their visible geometry directly. */
internal class CenteredInsetShape(
    private val shape: Shape,
    private val inset: Dp,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val insetPx = with(density) { inset.toPx() }
        val visualSize = Size(
            width = (size.width - insetPx * 2).coerceAtLeast(0f),
            height = (size.height - insetPx * 2).coerceAtLeast(0f),
        )
        val visualOutline = shape.createOutline(visualSize, layoutDirection, density)
        return Outline.Generic(
            Path().apply {
                addOutline(visualOutline)
                translate(Offset(insetPx, insetPx))
            },
        )
    }
}

/**
 * Compact glass button whose parent-facing layout and visual geometry remain
 * exactly [visualSize]. The larger optical RenderNode is an overflowing child:
 * it can render the glass envelope without changing any row height, spacing,
 * alignment, anchor, or hit target chosen by the caller.
 */
@Composable
fun GlassButtonCanvas(
    visualSize: Dp,
    shape: Shape,
    surfaceColor: Color? = null,
    restingBorderColor: Color? = null,
    alpha: Float = 0.12f,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    visualModifier: Modifier = Modifier,
    interactionSource: MutableInteractionSource? = null,
    onLiftedChange: (Boolean) -> Unit = {},
    content: @Composable () -> Unit,
) {
    val opticalShape = remember(shape) { CenteredInsetShape(shape, GlassButtonCanvasOutset) }
    val resolvedInteraction = interactionSource ?: remember { MutableInteractionSource() }
    val pressed by resolvedInteraction.collectIsPressedAsState()
    var animationActive by remember { mutableStateOf(false) }
    val clickModifier = Modifier.clickable(
        interactionSource = resolvedInteraction,
        indication = null,
        onClick = onClick,
    )
    Box(
        modifier = modifier
            .size(visualSize)
            .then(clickModifier)
            .zIndex(if (pressed || animationActive) 8f else 0f),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .requiredSize(visualSize + GlassButtonCanvasOutset * 2)
                .glassButtonSurface(opticalShape, surfaceColor, alpha, restingBorderColor) { active ->
                    animationActive = active
                    onLiftedChange(active)
                },
        )
        Box(
            modifier = visualModifier
                .size(visualSize),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}

/**
 * Rectangular counterpart for compact glass actions whose label determines a
 * stable nominal width. The optical layer gets the same transparent outset as
 * circular controls while layout, semantics and pointer input stay on the
 * requested [visualWidth] x [visualHeight] hit box.
 */
@Composable
fun GlassButtonCanvas(
    visualWidth: Dp,
    visualHeight: Dp,
    shape: Shape,
    surfaceColor: Color? = null,
    restingBorderColor: Color? = null,
    alpha: Float = 0.12f,
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    visualModifier: Modifier = Modifier,
    interactionSource: MutableInteractionSource? = null,
    onLiftedChange: (Boolean) -> Unit = {},
    content: @Composable () -> Unit,
) {
    val opticalShape = remember(shape) { CenteredInsetShape(shape, GlassButtonCanvasOutset) }
    val resolvedInteraction = interactionSource ?: remember { MutableInteractionSource() }
    val pressed by resolvedInteraction.collectIsPressedAsState()
    var animationActive by remember { mutableStateOf(false) }
    Box(
        modifier = modifier
            .size(visualWidth, visualHeight)
            .clickable(
                enabled = enabled,
                interactionSource = resolvedInteraction,
                indication = null,
                onClick = onClick,
            )
            // A pressed capsule rises above adjacent siblings so its glass
            // and constrained glow are never painted underneath neighboring items.
            .zIndex(if (pressed || animationActive) 8f else 0f),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .requiredSize(
                    visualWidth + GlassButtonCanvasOutset * 2,
                    visualHeight + GlassButtonCanvasOutset * 2,
                )
                .glassButtonSurface(opticalShape, surfaceColor, alpha, restingBorderColor) { active ->
                    animationActive = active
                    onLiftedChange(active)
                },
        )
        Box(
            modifier = visualModifier.size(visualWidth, visualHeight),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}

/** Audited existing float classes. This is an allow-list, not a conversion list. */
internal val ExistingLiquidFloatInventory = setOf(
    "shared_glass_buttons",
    "conversation_capsules",
    "sidebar_utility_selectors",
    "right_sidebar_tabs",
    "memory_lab_pager",
    "provider_settings_capsule_rails",
)

/**
 * Visual-only resistance for a liquid float whose logical position is clamped.
 * The anchor stays inside [minimum, maximum], while increasingly distant input
 * produces a small square-root pull capped to one safe optical envelope.
 */
internal fun resistedLiquidBoundaryPosition(
    raw: Float,
    minimum: Float,
    maximum: Float,
    maxDisplacement: Float,
    response: Float = 0.25f,
): Float {
    if (minimum > maximum) return raw
    val clamped = raw.coerceIn(minimum, maximum)
    val blocked = raw - clamped
    if (blocked == 0f || maxDisplacement <= 0f) return clamped
    val resisted = sign(blocked) * sqrt(abs(blocked)) * response
    return clamped + resisted.coerceIn(-maxDisplacement, maxDisplacement)
}

/**
 * PC-parity material/position coordinator.
 *
 * The caller must snap geometry and material to the source color block before
 * entering this function. Lift and movement start together, but a normal tap
 * never starts landing until both the full lift and travel have completed.
 * Movement may therefore finish early or continue while the float is fully
 * lifted; the landing phase is always a complete, separate contraction.
 * A held/dragged float keeps its material fully lifted and never starts landing
 * until release.
 */
internal suspend fun runOverlappedLiquidFlight(
    holdKeepsLifted: Boolean = false,
    lift: suspend () -> Unit,
    move: suspend () -> Unit,
    onLandingStarted: () -> Unit,
    land: suspend () -> Unit,
) = coroutineScope {
    val liftJob = launch { lift() }
    val moveJob = launch { move() }
    liftJob.join()
    if (holdKeepsLifted) {
        moveJob.join()
        return@coroutineScope
    }
    moveJob.join()
    onLandingStarted()
    land()
}

/**
 * 共享的液态玻璃 backdrop：捕获整个应用背景，供多个玻璃表面复用。
 *
 * 通过 [LocalLiquidBackdrop] 传播给应用窗口内的浮层（Popup/overlay），
 * 它们与根布局处于同一 window，可正确折射主窗口内容。
 * Dialog 是独立 window，无法复用根 backdrop，应在 Dialog 内容根自行
 * 创建并挂载 [rememberLiquidBackdrop]。
 */
@Composable
fun rememberLiquidBackdrop(): LayerBackdrop {
    return rememberLayerBackdrop()
}

/** 应用窗口内共享的液态玻璃 backdrop（根布局提供，Popup/overlay 消费）。 */
val LocalLiquidBackdrop = staticCompositionLocalOf<LayerBackdrop?> { null }

/** Prevents the app-wide sidebar swipe detector from racing a popup/rail drag. */
val LocalSidebarGestureLock = staticCompositionLocalOf<(String, Boolean) -> Unit> { { _, _ -> } }

/**
 * Kyant AndroidLiquidGlass (backdrop) 液态玻璃效果封装。
 *
 * 与 PC-GUI 的 --glass-bg-2/--glass-blur-3 语义对齐：
 *  - 折射镜头（lens）：默认 7dp 折射/色散边带、折射量 8dp，模拟加厚玻璃包边
 *  - 背景模糊（blur）：3px 等效（PC --glass-blur-3），移动端按密度换算
 *  - 色彩增强（vibrancy）：饱和度 1.4，对齐 PC saturate(140%)
 *  - 高光：原有包边统一增厚 1dp，折射与 RGB 色散使用同一边带宽度
 *  - 内阴影（InnerShadow）：底部深色内阴影，对齐 PC 凹陷表面
 *  - 外阴影（Shadow）：浮起阴影
 *
 * [backdrop] 为 null 时回退到 [LocalLiquidBackdrop]；两者都不可用时
 * 仅输出半透明表面 + 高光/内阴影/外阴影（drawBackdrop 内部按版本与
 * 坐标可用性跳过折射/模糊）。
 */
@Composable
fun Modifier.liquidGlassModifier(
    backdrop: Backdrop? = null,
    sampleBackdrop: Boolean = true,
    cornerRadius: Dp = 9.dp,
    alpha: Float = 0.85f,
    refractionHeight: Dp = MobileInteractionGlassEdge,
    refractionAmount: Dp = 8.dp,
    blurRadius: Dp = 3.dp,
    saturation: Float = 1.4f,
    surfaceColor: Color = NewmarkBgSecondary,
    shape: Shape? = null,
    ambientHighlight: Boolean = false,
    edgeHighlight: Boolean = true,
    layerBlock: (GraphicsLayerScope.() -> Unit)? = null,
    onDrawFront: (DrawScope.() -> Unit)? = null,
    surfaceOverlay: (DrawScope.() -> Unit)? = null,
    pointerGlow: Boolean = true,
    transformContent: Boolean = false,
): Modifier {
    val resolvedBackdrop = if (sampleBackdrop) backdrop ?: LocalLiquidBackdrop.current else null
    val resolvedShape = shape ?: RoundedCornerShape(cornerRadius)
    var glowPoint by remember { mutableStateOf<Offset?>(null) }
    var glowPressed by remember { mutableStateOf(false) }
    val drawSurfaceOverlay: (DrawScope.() -> Unit)? = if (surfaceOverlay != null || pointerGlow) {
        {
            surfaceOverlay?.invoke(this)
            if (pointerGlow) {
                glowPoint?.let { point ->
                    // Keep the light source larger than a fingertip so the
                    // press remains visible around the contact point.
                    // Increase the contact halo by 50% so it remains visible
                    // around a fingertip while staying clipped to the glass.
                    val radius = 66.dp.toPx()
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color.White.copy(alpha = if (glowPressed) 0.24f else 0.11f),
                                Color.Transparent,
                            ),
                            center = point,
                            radius = radius,
                        ),
                        radius = radius,
                        center = point,
                        blendMode = BlendMode.Screen,
                    )
                }
            }
        }
    } else null
    val glassModifier = remember(
        resolvedBackdrop,
        resolvedShape,
        alpha,
        refractionHeight,
        refractionAmount,
        blurRadius,
        saturation,
        surfaceColor,
        ambientHighlight,
        edgeHighlight,
        layerBlock,
        onDrawFront,
        surfaceOverlay,
        pointerGlow,
        glowPoint,
        glowPressed,
    ) {
        val shapeBlock: () -> Shape = { resolvedShape }
        if (resolvedBackdrop == null) {
            // No backdrop available (e.g. standalone Dialog without a captured
            // background): keep the translucent surface plus kyant-style depth
            // so the popup still reads as liquid glass on older/isolated paths.
            Modifier.drawBackdrop(
                backdrop = EmptyBackdrop,
                shape = shapeBlock,
                effects = {
                    colorControls(saturation = saturation)
                },
                highlight = { if (edgeHighlight) thickGlassHighlight(ambientHighlight) else null },
                shadow = { Shadow.Default },
                innerShadow = { InnerShadow(radius = 2.dp, offset = DpOffset(0.dp, 1.dp)) },
                onDrawSurface = {
                    drawRect(surfaceColor.copy(alpha = alpha))
                    drawSurfaceOverlay?.invoke(this)
                },
                onDrawFront = onDrawFront,
            )
        } else {
            Modifier.drawBackdrop(
                backdrop = resolvedBackdrop,
                shape = shapeBlock,
                effects = {
                    colorControls(saturation = saturation)
                    blur(blurRadius.toPx())
                    lens(
                        refractionHeight.toPx(),
                        refractionAmount.toPx(),
                        depthEffect = true,
                        chromaticAberration = true,
                    )
                },
                highlight = { if (edgeHighlight) thickGlassHighlight(ambientHighlight) else null },
                shadow = { Shadow.Default },
                innerShadow = { InnerShadow(radius = 2.dp, offset = DpOffset(0.dp, 1.dp)) },
                onDrawSurface = {
                    drawRect(surfaceColor.copy(alpha = alpha))
                    drawSurfaceOverlay?.invoke(this)
                },
                onDrawFront = onDrawFront,
            )
        }
    }
    val pointerModifier = if (pointerGlow) {
        Modifier.pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                glowPressed = true
                glowPoint = down.position
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    glowPoint = change.position
                    if (!change.pressed) break
                }
                glowPressed = false
                glowPoint = null
            }
        }
    } else Modifier
    val isolatedOptics = if (layerBlock != null && transformContent) {
        // Popup content, optics, hit coordinates and nested contact mapping
        // must share the same real Compose layer transform.
        Modifier.graphicsLayer(layerBlock).then(glassModifier)
    } else if (layerBlock != null) {
        Modifier.transformGlassOptics(glassModifier, layerBlock)
    } else glassModifier
    return this.then(isolatedOptics).then(pointerModifier)
}

/** Every mobile glass float adds 1dp to its visible highlight envelope. */
private fun thickGlassHighlight(ambient: Boolean): Highlight = Highlight(
    width = 1.5.dp,
    blurRadius = if (ambient) 0.75.dp else 0.5.dp,
    alpha = 1f,
    style = if (ambient) HighlightStyle.Default else HighlightStyle.Plain,
)

/**
 * Popup shell material: the same Kyant liquid glass plus a transparent
 * pointer-held light source and a restrained drag squeeze. The shell keeps
 * its exact measured bounds; only the render layer deforms during input.
 */
@Composable
fun Modifier.liquidPopupShell(
    backdrop: Backdrop? = null,
    shape: Shape,
    alpha: Float = 0.78f,
    blurRadius: Dp = 12.dp,
    refractionHeight: Dp = MobileInteractionGlassEdge,
    refractionAmount: Dp = 18.dp,
    surfaceColor: Color = NewmarkBgSecondary,
    // Non-null values make the popup's carrier glass consume the caller's
    // constrained gesture state. This is intentionally nullable so generic
    // popup shells can still use their local pointer interaction path.
    externalDragOffset: Offset? = null,
    externalPressed: Boolean? = null,
    dragEnabled: Boolean = true,
): Modifier {
    var pressed by remember { mutableStateOf(false) }
    var lightPoint by remember { mutableStateOf<Offset?>(null) }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current
    val effectivePressed = externalPressed ?: pressed
    val effectiveDragOffset = externalDragOffset ?: dragOffset
    val pressScale by animateFloatAsState(
        targetValue = if (effectivePressed) 1.018f else 1f,
        animationSpec = tween(durationMillis = 90),
        label = "liquidPopupPressScale",
    )

    LaunchedEffect(effectivePressed) {
        if (!effectivePressed) {
            delay(160)
            if (!effectivePressed) lightPoint = null
        }
    }

    val pull = (effectiveDragOffset.getDistance() / with(density) { 120.dp.toPx() })
        .coerceIn(0f, 1f)
    val horizontal = abs(effectiveDragOffset.x) >= abs(effectiveDragOffset.y)
    val popupScaleX = pressScale * (1f + pull * if (horizontal) 0.0176f else -0.008f)
    val popupScaleY = pressScale * (1f + pull * if (horizontal) -0.008f else 0.0176f)
    val popupTranslation = effectiveDragOffset * 0.096f
    // One actual layer carries the popup and every child. The pointer observer
    // sits outside it, so its own feedback never changes the drag input frame.
    val glassLayerBlock: GraphicsLayerScope.() -> Unit = remember(popupScaleX, popupScaleY, popupTranslation) {
        val block: GraphicsLayerScope.() -> Unit = {
            scaleX = popupScaleX
            scaleY = popupScaleY
            translationX = popupTranslation.x
            translationY = popupTranslation.y
        }
        block
    }

    val popupPointerModifier = Modifier.pointerInput(shape, dragEnabled) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            pressed = true
            lightPoint = down.position
            dragOffset = Offset.Zero
            try {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    lightPoint = change.position
                    // A graph popup can keep pan/zoom ownership while still
                    // sharing the shell's press feedback with all its content.
                    dragOffset = if (dragEnabled) change.position - down.position else Offset.Zero
                    if (!change.pressed) break
                }
            } finally {
                pressed = false
                dragOffset = Offset.Zero
            }
        }
    }

    return this
        .then(popupPointerModifier)
        .liquidGlassModifier(
            backdrop = backdrop,
            shape = shape,
            alpha = alpha,
            blurRadius = blurRadius,
            refractionHeight = refractionHeight,
            refractionAmount = refractionAmount,
            surfaceColor = surfaceColor,
            ambientHighlight = true,
            layerBlock = glassLayerBlock,
            surfaceOverlay = {
                lightPoint?.let { point ->
                    val localPoint = liquidContactBeforeTransform(
                        point, size, popupScaleX, popupScaleY, popupTranslation,
                    )
                    drawLiquidContactGlow(localPoint, if (effectivePressed) 0.22f else 0.10f)
                }
            },
            pointerGlow = false,
            transformContent = true,
        )
}

/**
 * Shared liquid popup exit: keep the Dialog/popup mounted while its glass
 * surface shrinks toward the trigger origin, then notify the owner to remove
 * it. This prevents the flash-out path that used to clear the popup in one
 * frame.
 */
class LiquidPopupExitController internal constructor(
    internal val scale: Animatable<Float, AnimationVector1D>,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val onDismiss: () -> Unit,
) {
    private var closing = false

    fun requestClose() {
        if (closing) return
        closing = true
        scope.launch {
            scale.animateTo(0.62f, tween(durationMillis = 210))
            onDismiss()
        }
    }
}

@Composable
fun rememberLiquidPopupExit(onDismiss: () -> Unit): LiquidPopupExitController {
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    val scale = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    return remember(scale, scope) {
        LiquidPopupExitController(scale, scope) { currentOnDismiss() }
    }
}

fun Modifier.liquidPopupExit(
    controller: LiquidPopupExitController,
    transformOrigin: TransformOrigin = TransformOrigin.Center,
): Modifier = graphicsLayer {
    scaleX = controller.scale.value
    scaleY = controller.scale.value
    this.transformOrigin = transformOrigin
}

@Composable
private fun Modifier.liquidPopupInteraction(shape: Shape): Modifier {
    var pressed by remember { mutableStateOf(false) }
    var lightPoint by remember { mutableStateOf<Offset?>(null) }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current
    val pressScale by animateFloatAsState(
        targetValue = if (pressed) 1.018f else 1f,
        animationSpec = tween(durationMillis = 90),
        label = "liquidPopupPressScale",
    )

    androidx.compose.runtime.LaunchedEffect(pressed) {
        if (!pressed) {
            delay(160)
            if (!pressed) lightPoint = null
        }
    }

    return this
        .liquidGlassModifier(
            backdrop = LocalLiquidBackdrop.current,
            sampleBackdrop = true,
            shape = shape,
            alpha = 0f,
            surfaceColor = Color.Transparent,
            layerBlock = {
                // The optical pass owns deformation; option content is drawn
                // afterwards in its original coordinates.
                val pull = (dragOffset.getDistance() / with(density) { 120.dp.toPx() }).coerceIn(0f, 1f)
                val horizontal = kotlin.math.abs(dragOffset.x) >= kotlin.math.abs(dragOffset.y)
                scaleX = pressScale * (1f + pull * if (horizontal) 0.0176f else -0.008f)
                scaleY = pressScale * (1f + pull * if (horizontal) -0.008f else 0.0176f)
                translationX = dragOffset.x * 0.096f
                translationY = dragOffset.y * 0.096f
            },
            surfaceOverlay = {
                lightPoint?.let { point ->
                    val radius = minOf(size.width, size.height).coerceAtLeast(1f) * 0.58f
                    drawRect(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color.White.copy(alpha = if (pressed) 0.22f else 0.10f),
                                Color.Transparent,
                            ),
                            center = point,
                            radius = radius,
                        ),
                        blendMode = BlendMode.Screen,
                    )
                }
            },
            pointerGlow = false,
        )
        .pointerInput(shape) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                pressed = true
                lightPoint = down.position
                dragOffset = Offset.Zero
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    lightPoint = change.position
                    dragOffset = change.position - down.position
                    if (!change.pressed) break
                }
                pressed = false
                dragOffset = Offset.Zero
            }
        }
}

/**
 * Direct color-block option interaction: the option itself moves with the
 * pointer inside the popup and never spawns a separate glass float. A small
 * press/drag deforms the block while its measured size stays unchanged.
 */
@Composable
fun Modifier.directOptionInteraction(
    shape: Shape,
    enabled: Boolean = true,
    allowHoldDrag: Boolean = false,
    onClick: () -> Unit,
): Modifier {
    var rowSize by remember { mutableStateOf(Size.Zero) }
    var pressed by remember { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    var pressPoint by remember { mutableStateOf(Offset(0.5f, 0.5f)) }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    var pullOffset by remember { mutableStateOf(Offset.Zero) }
    val currentOnClick by rememberUpdatedState(onClick)
    val density = LocalDensity.current
    val gestureScope = rememberCoroutineScope()
    val pressScale by animateFloatAsState(
        targetValue = if (pressed) 1.035f else 1f,
        animationSpec = tween(durationMillis = 110),
        label = "directOptionClickElastic",
    )
    return this
        .onSizeChanged { rowSize = Size(it.width.toFloat(), it.height.toFloat()) }
        .semantics {
            role = Role.Button
            if (enabled) {
                onClick { currentOnClick(); true }
            }
        }
        .graphicsLayer {
            val pull = (pullOffset.getDistance() / with(density) { 72.dp.toPx() })
                .coerceIn(0f, 1f)
            val horizontal = kotlin.math.abs(pullOffset.x) >= kotlin.math.abs(pullOffset.y)
            transformOrigin = TransformOrigin(
                pressPoint.x.coerceIn(0f, 1f),
                pressPoint.y.coerceIn(0f, 1f),
            )
            scaleX = pressScale * (1f + pull * if (horizontal) 0.0208f else -0.0096f)
            scaleY = pressScale * (1f + pull * if (horizontal) -0.0096f else 0.0208f)
            translationX = if (dragging) dragOffset.x else pullOffset.x
            translationY = if (dragging) dragOffset.y else pullOffset.y
        }
        .pointerInput(shape, enabled, allowHoldDrag, currentOnClick) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                if (!enabled) return@awaitEachGesture
                pressed = true
                pressPoint = if (rowSize.width > 0f && rowSize.height > 0f) {
                    Offset(
                        down.position.x / rowSize.width,
                        down.position.y / rowSize.height,
                    )
                } else {
                    Offset(0.5f, 0.5f)
                }
                dragOffset = Offset.Zero
                pullOffset = Offset.Zero
                var moved = false
                var draggingLocal = false
                val hold = gestureScope.launch {
                    delay(300)
                    if (!moved && allowHoldDrag) {
                        draggingLocal = true
                        dragging = true
                        pullOffset = Offset.Zero
                    }
                }
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    val delta = change.position - down.position
                    if (delta.getDistance() > viewConfiguration.touchSlop) {
                        moved = true
                        if (draggingLocal) {
                            dragOffset = delta
                        } else {
                            val distance = delta.getDistance()
                            val resisted = (
                                kotlin.math.sqrt(distance - viewConfiguration.touchSlop) * 0.25f
                                ).coerceAtMost(with(density) { 5.dp.toPx() })
                            pullOffset = delta / distance * resisted
                        }
                    }
                    if (!change.pressed) break
                }
                hold.cancel()
                val apply = !moved || draggingLocal
                pressed = false
                dragging = false
                dragOffset = Offset.Zero
                pullOffset = Offset.Zero
                if (apply) currentOnClick()
            }
        }
}

/**
 * A reversible selection material transition. At [glassProgress] == 0 the
 * single animated layer is the exact selected fill; at 1 it is transparent
 * refractive glass. Keeping both appearances on the same layer makes the
 * fill -> glass -> fill hand-off continuous without ever drawing two blocks.
 */
@Composable
fun Modifier.liquidSelectionMorph(
    backdrop: Backdrop? = null,
    shape: CornerBasedShape,
    fillColor: Color,
    glassProgress: Float,
    glassAlpha: Float = 0.08f,
    blurRadius: Dp = 2.dp,
    refractionHeight: Dp = MobileInteractionGlassEdge,
    refractionAmount: Dp = 20.dp,
    saturation: Float = 1.2f,
    contact: LiquidContactState? = null,
    contactGeometry: () -> Unit = {},
): Modifier {
    val progress = glassProgress.coerceIn(0f, 1f)
    var contactCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    // Keep the semantic color block visible throughout the flight.  Previously
    // its alpha reached zero as soon as the glass progress hit 1, leaving only
    // the very subtle transparent glass surface; on some devices that made
    // click/hold movement appear to lose the selection entirely.  The raised
    // envelope now carries the original block as a stable tinted base while
    // the glass/refraction layer is composited above it.
    val fillAlpha = fillColor.alpha * (1f - progress * 0.22f)
    val fill = this.onGloballyPositioned { contactCoordinates = it }
        .background(fillColor.copy(alpha = fillAlpha), shape)
    if (progress <= 0.001f) return fill
    DisposableEffect(contact) {
        onDispose { contact?.clearReleased() }
    }
    return fill.liquidGlassModifier(
            backdrop = backdrop,
            shape = shape,
            alpha = glassAlpha * progress,
            blurRadius = blurRadius * progress,
            refractionHeight = refractionHeight * progress,
            refractionAmount = refractionAmount * progress,
            saturation = 1f + (saturation - 1f) * progress,
            surfaceColor = Color.Transparent,
            ambientHighlight = true,
            // The original gesture owner records window coordinates before
            // this float exists. Read its actual animated geometry in the draw
            // phase, including layer-only motion while the finger is still.
            surfaceOverlay = {
                contactGeometry()
                contact?.localPosition(contactCoordinates)?.let { point ->
                    drawLiquidContactGlow(point, 0.24f * progress)
                }
            },
            pointerGlow = false,
        )
}

/** Called only from drawBackdrop's shape-clipped surface drawing layer. */
private fun DrawScope.drawLiquidContactGlow(point: Offset, alpha: Float) {
    val radius = 66.dp.toPx()
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(Color.White.copy(alpha = alpha), Color.Transparent),
            center = point,
            radius = radius,
        ),
        radius = radius,
        center = point,
        blendMode = BlendMode.Screen,
    )
}

internal data class LiquidMotionScale(val x: Float, val y: Float)

internal fun liquidMotionScale(
    velocityX: Float,
    velocityY: Float,
    density: Float,
): LiquidMotionScale {
    val speedDpPerSecond = kotlin.math.hypot(velocityX, velocityY) / density.coerceAtLeast(0.1f)
    val amount = ((speedDpPerSecond - 8f) / 650f).coerceIn(0f, 1f)
    if (amount <= 0f) return LiquidMotionScale(1f, 1f)
    // Keep the same velocity curve and axis ownership, but let motion read a
    // little more clearly on a touch screen without increasing travel.
    val stretch = 1f + amount * 0.09f
    val squash = 1f - amount * 0.042f
    return if (kotlin.math.abs(velocityX) >= kotlin.math.abs(velocityY)) {
        LiquidMotionScale(stretch, squash)
    } else {
        LiquidMotionScale(squash, stretch)
    }
}

fun Modifier.liquidMotionDeformation(
    velocityX: Float,
    velocityY: Float,
    density: Float,
): Modifier {
    val scale = liquidMotionScale(velocityX, velocityY, density)
    return graphicsLayer {
        scaleX = scale.x
        scaleY = scale.y
    }
}

/**
 * Layer-phase variant used by high-frequency drag surfaces. The velocity
 * suppliers are read by the RenderNode layer update instead of composition,
 * preserving the same deformation math without recomposing the owning list
 * for every animation frame.
 */
fun Modifier.liquidMotionDeformationDeferred(
    velocityX: () -> Float,
    velocityY: () -> Float,
    density: Float,
): Modifier = graphicsLayer {
    val scale = liquidMotionScale(velocityX(), velocityY(), density)
    scaleX = scale.x
    scaleY = scale.y
}

/** Shared lightweight glass surface for interactive controls.
 *
 * Buttons often live below the window's LayerBackdrop recorder. Giving every
 * button its own drawBackdrop shader both risks a self-referential RenderNode
 * and causes a cold-start OpenGL program compilation storm on emulators. Keep
 * Kyant's translucent surface, highlight/shadow and outward press deformation,
 * while reserving the expensive backdrop shader for larger glass surfaces.
 */
@Composable
fun Modifier.glassButtonSurface(
    shape: Shape,
    surfaceColor: Color? = null,
    alpha: Float = 0.12f,
    restingBorderColor: Color? = null,
    onAnimationActiveChanged: (Boolean) -> Unit = {},
): Modifier {
    val materialAlpha = alpha
    val p = LocalNewmarkColors.current
    val edgeColor = lerp(surfaceColor ?: p.textPrimary, p.accent, 0.16f)
    val pressProgress = remember { androidx.compose.animation.core.Animatable(0f) }
    val pressCycles = remember { Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED) }
    var boundaryPull by remember { mutableStateOf(Offset.Zero) }
    var lightPoint by remember { mutableStateOf<Offset?>(null) }
    var lightPressed by remember { mutableStateOf(false) }
    val reportAnimationActive by rememberUpdatedState(onAnimationActiveChanged)
    androidx.compose.runtime.LaunchedEffect(pressCycles) {
        for (release in pressCycles) {
            // Every tap owns a complete cycle. Travel or the click action may
            // proceed concurrently, but the glass must reach full lift before
            // it is allowed to contract back into the control.
            reportAnimationActive(true)
            try {
                pressProgress.animateTo(1f, tween(durationMillis = 105))
                release.await()
                pressProgress.animateTo(0f, tween(durationMillis = 165))
            } finally {
                if (!lightPressed) lightPoint = null
                reportAnimationActive(false)
            }
        }
    }
    val pressScale = 1f + 0.065f * pressProgress.value
    val pressLift = (-1.25).dp * pressProgress.value
    val edgeEmphasis = 0.82f * pressProgress.value
    val boundaryDistance = boundaryPull.getDistance()
    val boundaryAmount = (boundaryDistance / with(LocalDensity.current) { 4.dp.toPx() }).coerceIn(0f, 1f)
    val horizontalShare = if (boundaryDistance > 0.001f) abs(boundaryPull.x) / boundaryDistance else 0f
    val verticalShare = if (boundaryDistance > 0.001f) abs(boundaryPull.y) / boundaryDistance else 0f
    val buttonScaleX = pressScale * (1f + boundaryAmount * (horizontalShare * 0.032f - verticalShare * 0.015f))
    val buttonScaleY = pressScale * (1f + boundaryAmount * (verticalShare * 0.032f - horizontalShare * 0.015f))
    val optics = Modifier.kyantGlassEdge(
        shape = shape,
        edgeColor = edgeColor,
        restingBorderColor = restingBorderColor,
        emphasis = (edgeEmphasis + materialAlpha * 0.22f).coerceAtMost(1f),
        enabled = pressProgress.value > 0.001f,
        surfaceOverlay = {
            lightPoint?.let { point ->
                // The physical light radius remains visible around a finger.
                val localPoint = liquidContactBeforeTransform(
                    point, size, buttonScaleX, buttonScaleY,
                    Offset(boundaryPull.x, pressLift.toPx() + boundaryPull.y),
                )
                drawLiquidContactGlow(localPoint, 0.24f * pressProgress.value)
            }
        },
    )
    return this
        .transformGlassOptics(optics) {
            clip = false
            translationX = boundaryPull.x
            translationY = pressLift.toPx() + boundaryPull.y
            scaleX = buttonScaleX
            scaleY = buttonScaleY
            this.alpha = 0.985f + edgeEmphasis * 0.015f
        }
        .pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val release = CompletableDeferred<Unit>()
                pressCycles.trySend(release)
                lightPressed = true
                lightPoint = down.position
                var current = down.position
                try {
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        current = change.position
                        lightPoint = current
                        val raw = current - down.position
                        val maxPull = 4.dp.toPx()
                        val distance = raw.getDistance()
                        boundaryPull = if (distance <= viewConfiguration.touchSlop) {
                            Offset.Zero
                        } else {
                            val resisted = (sqrt(distance - viewConfiguration.touchSlop) * 0.25f)
                                .coerceAtMost(maxPull)
                            raw / distance * resisted
                        }
                        if (!change.pressed) break
                    }
                } finally {
                    boundaryPull = Offset.Zero
                    lightPressed = false
                    release.complete(Unit)
                }
            }
        }
}

/** Two sibling render layers isolate optical deformation from real content.
 * Unlike Modifier.graphicsLayer this leaves layout and semantic bounds intact. */
@Composable
private fun Modifier.transformGlassOptics(
    optics: Modifier,
    transform: GraphicsLayerScope.() -> Unit,
): Modifier {
    val opticsLayer = rememberGraphicsLayer()
    val contentLayer = rememberGraphicsLayer()
    // Reuse the library's resettable GraphicsLayerScope rather than creating
    // another partial implementation of Compose's evolving scope interface.
    val transformScope = remember { InverseLayerScope() }
    return this.drawWithContent {
        opticsLayer.record { this@drawWithContent.drawContent() }
        transformScope.reset()
        transformScope.size = size
        transformScope.density = density
        transformScope.fontScale = fontScale
        transformScope.transform()
        opticsLayer.apply {
            clip = transformScope.clip
            scaleX = transformScope.scaleX
            scaleY = transformScope.scaleY
            translationX = transformScope.translationX
            translationY = transformScope.translationY
            alpha = transformScope.alpha
            rotationX = transformScope.rotationX
            rotationY = transformScope.rotationY
            rotationZ = transformScope.rotationZ
            pivotOffset = Offset(
                size.width * transformScope.transformOrigin.pivotFractionX,
                size.height * transformScope.transformOrigin.pivotFractionY,
            )
        }
        drawLayer(opticsLayer)
        drawLayer(contentLayer)
    }.then(optics).drawWithContent {
        contentLayer.record { this@drawWithContent.drawContent() }
    }
}

/** Kyant-standard edge-only glass for controls that cannot safely sample a recorder. */
@Composable
fun Modifier.kyantGlassEdge(
    shape: Shape,
    edgeColor: Color,
    restingBorderColor: Color? = null,
    emphasis: Float = 0f,
    enabled: Boolean = true,
    surfaceOverlay: (DrawScope.() -> Unit)? = null,
): Modifier {
    if (!enabled) {
        val restingSurface = drawBackdrop(
            backdrop = EmptyBackdrop,
            shape = { shape },
            effects = {},
            // Surface overlays (including pointer glow) must stay inside the
            // actual glass silhouette. The render canvas may still be larger,
            // but its optical content is clipped to this shape.
            clipToShape = true,
            highlight = { null },
            shadow = { null },
            innerShadow = { null },
            onDrawSurface = surfaceOverlay,
        )
        return if (restingBorderColor != null) {
            this.then(restingSurface).border(1.dp, restingBorderColor, shape)
        } else {
            this.then(restingSurface)
                .border(2.dp, Color.Black.copy(alpha = 0.12f), shape)
                .border(2.5.dp, Color.White.copy(alpha = 0.34f), shape)
        }
    }
    val refractedShade = lerp(Color.Black, edgeColor, 0.18f)
    return drawBackdrop(
        backdrop = EmptyBackdrop,
        shape = { shape },
        effects = {},
        clipToShape = true,
        highlight = {
            Highlight(
                width = 1.5.dp + 0.15.dp * emphasis,
                blurRadius = 0.5.dp + 0.15.dp * emphasis,
                alpha = 0.72f + 0.18f * emphasis,
                style = HighlightStyle.Plain(
                    color = Color.White.copy(alpha = 0.38f),
                ),
            )
        },
        shadow = {
            Shadow(
                radius = 3.dp + 1.dp * emphasis,
                offset = DpOffset(0.dp, 1.dp),
                color = Color.Black.copy(alpha = 0.14f),
                alpha = 0.72f + 0.18f * emphasis,
            )
        },
        innerShadow = {
            InnerShadow(
                radius = 2.dp,
                offset = DpOffset(0.dp, 1.dp),
                color = refractedShade.copy(alpha = 0.16f),
                alpha = 0.72f + 0.18f * emphasis,
            )
        },
        onDrawSurface = surfaceOverlay,
    )
}

/** Blur behind a standalone Dialog without inserting an opaque recorder board. */
@Composable
fun DialogBackdropBlur(radius: Dp = 36.dp) {
    val view = LocalView.current
    val density = LocalDensity.current
    DisposableEffect(view, radius, density) {
        val window = (view.parent as? DialogWindowProvider)?.window
        val previousCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window?.attributes?.layoutInDisplayCutoutMode
        } else null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && window != null) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && window != null) {
            val blurPx = with(density) { radius.roundToPx() }
            window.setBackgroundBlurRadius(blurPx)
            window.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
            window.attributes = window.attributes.apply { blurBehindRadius = blurPx }
        }
        onDispose {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && window != null && previousCutoutMode != null) {
                window.attributes = window.attributes.apply {
                    layoutInDisplayCutoutMode = previousCutoutMode
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && window != null) {
                window.setBackgroundBlurRadius(0)
                window.clearFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
            }
        }
    }
}

/** Glass-styled binary control used throughout Settings. */
@Composable
fun LiquidGlassSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val p = LocalNewmarkColors.current
    val contact = rememberLiquidContactState()
    var thumbCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var pressed by remember { mutableStateOf(false) }
    var draggedFraction by remember { mutableStateOf<Float?>(null) }
    // Boundary overscroll is visual only: the switch's committed value never
    // leaves [0, 1], while a held glass thumb can still lean into a blocked
    // direction with increasing, damped displacement.
    var boundaryOverscroll by remember { mutableStateOf(0f) }
    val settledFraction by animateFloatAsState(
        targetValue = if (checked) 1f else 0f,
        animationSpec = tween(durationMillis = 180),
        label = "liquid-switch-settle",
    )
    val fraction = draggedFraction ?: settledFraction
    val visualFraction = (fraction + boundaryOverscroll).coerceIn(-0.34f, 1.34f)
    val thumbWidth by animateDpAsState(
        targetValue = if (pressed) 30.dp else 24.dp,
        animationSpec = tween(durationMillis = 120),
        label = "liquid-switch-capsule-width",
    )
    val thumbOffset = 14.dp + 20.dp * visualFraction - thumbWidth / 2
    val thumbScale by animateFloatAsState(
        targetValue = if (pressed) 1.22f else 1f,
        animationSpec = tween(durationMillis = 100),
        label = "liquid-switch-lift",
    )
    val density = LocalDensity.current
    val trackShape = RoundedCornerShape(14.dp)
    Box(
        modifier = modifier
            .size(width = 48.dp, height = 28.dp)
            .background(
                Brush.horizontalGradient(
                    colorStops = arrayOf(
                        0f to p.accent,
                        fraction to p.accent,
                        fraction to p.bgQuaternary,
                        1f to p.bgQuaternary,
                    ),
                ),
                trackShape,
            )
            .border(1.dp, p.border, trackShape)
            .semantics {
                role = Role.Switch
                stateDescription = if (checked) "On" else "Off"
                onClick {
                    if (enabled) onCheckedChange(!checked)
                    enabled
                }
            }
            .trackLiquidContact(if (enabled) contact else null)
            .pointerInput(enabled, checked, density) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    val startPx = with(density) { 14.dp.toPx() }
                    val travelPx = with(density) { 20.dp.toPx() }
                    fun fractionAt(x: Float) = ((x - startPx) / travelPx).coerceIn(0f, 1f)
                    val initialFraction = if (checked) 1f else 0f
                    var releaseFraction = initialFraction
                    var lastRawFraction = initialFraction
                    var dragging = false
                    var verticalScroll = false
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        val distance = change.position - down.position
                        if (!dragging && !verticalScroll && distance.getDistance() > viewConfiguration.touchSlop) {
                            if (kotlin.math.abs(distance.x) >= kotlin.math.abs(distance.y)) {
                                dragging = true
                            } else {
                                verticalScroll = true
                                pressed = false
                            }
                        }
                        if (dragging) {
                            lastRawFraction = (change.position.x - startPx) / travelPx
                            releaseFraction = lastRawFraction.coerceIn(0f, 1f)
                            draggedFraction = releaseFraction
                            val blockedPull = when {
                                initialFraction <= 0f && lastRawFraction < 0f -> lastRawFraction
                                initialFraction >= 1f && lastRawFraction > 1f -> lastRawFraction - 1f
                                releaseFraction <= 0f && lastRawFraction < 0f -> lastRawFraction
                                releaseFraction >= 1f && lastRawFraction > 1f -> lastRawFraction - 1f
                                else -> 0f
                            }
                            // Resistance keeps the anchor fixed while making a
                            // long pull visibly travel farther (square-root
                            // response, capped to a safe optical envelope).
                            val resistedPull = kotlin.math.sign(blockedPull) *
                                kotlin.math.sqrt(kotlin.math.abs(blockedPull)) * 0.075f
                            boundaryOverscroll = resistedPull.coerceIn(-0.085f, 0.085f)
                            change.consume()
                        }
                        if (!change.pressed) break
                    }
                    pressed = false
                    draggedFraction = null
                    boundaryOverscroll = 0f
                    if (!verticalScroll) {
                        onCheckedChange(liquidSwitchReleaseValue(checked, dragging, releaseFraction))
                    }
                }
            },
    ) {
        val thumbModifier = if (pressed) {
            Modifier.liquidGlassModifier(
                shape = RoundedCornerShape(50),
                alpha = 0.10f,
                blurRadius = 2.dp,
                refractionHeight = 9.dp,
                refractionAmount = 16.dp,
                surfaceColor = p.bgQuaternary,
                ambientHighlight = true,
                surfaceOverlay = {
                    // Observe geometry as well as input: the thumb may still
                    // be catching up while the physical contact stays still.
                    thumbOffset.value; thumbScale; boundaryOverscroll
                    contact.localPosition(thumbCoordinates)?.let { drawLiquidContactGlow(it, 0.24f) }
                },
                pointerGlow = false,
            )
        } else {
            Modifier
                .shadow(2.dp, CircleShape)
                .background(if (checked) Color.White else p.textSecondary, CircleShape)
        }
        Box(
            Modifier
                .size(width = thumbWidth, height = 24.dp)
                .graphicsLayer {
                    val pull = kotlin.math.abs(boundaryOverscroll)
                    scaleX = thumbScale * (1f + pull * 0.22f)
                    scaleY = thumbScale * (1f - pull * 0.10f)
                    translationX = thumbOffset.toPx()
                    translationY = if (pressed) 0f else 2.dp.toPx()
                }
                .onGloballyPositioned { thumbCoordinates = it }
                .then(thumbModifier),
        )
    }
}

/** Tap toggles; only a confirmed drag settles from the released track position. */
internal fun liquidSwitchReleaseValue(
    checked: Boolean,
    dragging: Boolean,
    releaseFraction: Float,
): Boolean = if (dragging) releaseFraction >= 0.5f else !checked

/** 无背景内容时的空 backdrop：仅提供高光/阴影/内阴影/半透明表面。 */
private val EmptyBackdrop: Backdrop = object : Backdrop {
    override val isCoordinatesDependent: Boolean = false

    override fun androidx.compose.ui.graphics.drawscope.DrawScope.drawBackdrop(
        density: androidx.compose.ui.unit.Density,
        coordinates: androidx.compose.ui.layout.LayoutCoordinates?,
        layerBlock: (androidx.compose.ui.graphics.GraphicsLayerScope.() -> Unit)?,
    ) {
        // Empty: nothing to refract; the surface color is drawn by onDrawSurface.
    }
}
/** Shared float edge band: previous 6dp envelope plus the requested 1dp thickness. */
val MobileInteractionGlassEdge = 7.dp

/** Fixed capture outset for the semicircular ends of conversation pills. */
val MobileConversationGlassHorizontalEdge = 14.dp
val MobilePopupShape = RoundedCornerShape(26.dp)
