package com.newmark.mobile.ui.components

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.window.DialogWindowProvider
import com.kyant.backdrop.Backdrop
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

/**
 * Transparent layout space reserved around every compact glass control.
 *
 * This is deliberately a real measured canvas, not an instruction to draw
 * outside a button-sized RenderNode.  It contains the 7dp optical edge plus
 * highlight blur, shadow and the 1.065 press expansion.  The inner control
 * keeps its nominal size, semantics and hit target.
 */
val GlassButtonCanvasOutset = 8.dp

private class CenteredInsetShape(
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
    alpha: Float = 0.12f,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    visualModifier: Modifier = Modifier,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    val opticalShape = remember(shape) { CenteredInsetShape(shape, GlassButtonCanvasOutset) }
    val clickModifier = if (interactionSource == null) {
        Modifier.clickable(onClick = onClick)
    } else {
        Modifier.clickable(
            interactionSource = interactionSource,
            indication = null,
            onClick = onClick,
        )
    }
    Box(
        modifier = modifier
            .size(visualSize)
            .then(clickModifier),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .requiredSize(visualSize + GlassButtonCanvasOutset * 2)
                .glassButtonSurface(opticalShape, surfaceColor, alpha),
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

/** Audited existing float classes. This is an allow-list, not a conversion list. */
internal val ExistingLiquidFloatInventory = setOf(
    "conversation_capsules",
    "sidebar_utility_selectors",
    "right_sidebar_tabs",
    "memory_lab_pager",
    "composer_selection_menus",
)

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
): Modifier {
    val resolvedBackdrop = if (sampleBackdrop) backdrop ?: LocalLiquidBackdrop.current else null
    val resolvedShape = shape ?: RoundedCornerShape(cornerRadius)
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
                highlight = { thickGlassHighlight(ambientHighlight) },
                shadow = { Shadow.Default },
                innerShadow = { InnerShadow(radius = 2.dp, offset = DpOffset(0.dp, 1.dp)) },
                onDrawSurface = {
                    drawRect(surfaceColor.copy(alpha = alpha))
                },
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
                highlight = { thickGlassHighlight(ambientHighlight) },
                shadow = { Shadow.Default },
                innerShadow = { InnerShadow(radius = 2.dp, offset = DpOffset(0.dp, 1.dp)) },
                onDrawSurface = {
                    drawRect(surfaceColor.copy(alpha = alpha))
                },
            )
        }
    }
    return this.then(glassModifier)
}

/** Every mobile glass float adds 1dp to its visible highlight envelope. */
private fun thickGlassHighlight(ambient: Boolean): Highlight = Highlight(
    width = 1.5.dp,
    blurRadius = if (ambient) 0.75.dp else 0.5.dp,
    alpha = 1f,
    style = if (ambient) HighlightStyle.Default else HighlightStyle.Plain,
)

/**
 * A reversible selection material transition. At [glassProgress] == 0 the
 * single animated layer is the exact selected fill; at 1 it is transparent
 * refractive glass. Keeping both appearances on the same layer makes the
 * fill -> glass -> fill hand-off continuous without ever drawing two blocks.
 */
@Composable
fun Modifier.liquidSelectionMorph(
    backdrop: Backdrop? = null,
    shape: Shape,
    fillColor: Color,
    glassProgress: Float,
    glassAlpha: Float = 0.08f,
    blurRadius: Dp = 2.dp,
    refractionHeight: Dp = MobileInteractionGlassEdge,
    refractionAmount: Dp = 20.dp,
    saturation: Float = 1.2f,
): Modifier {
    val progress = glassProgress.coerceIn(0f, 1f)
    val fill = this.background(fillColor.copy(alpha = fillColor.alpha * (1f - progress)), shape)
    if (progress <= 0.001f) return fill
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
    val stretch = 1f + amount * 0.075f
    val squash = 1f - amount * 0.035f
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
): Modifier {
    val materialAlpha = alpha
    val p = LocalNewmarkColors.current
    val edgeColor = lerp(surfaceColor ?: p.textPrimary, p.accent, 0.16f)
    val pressProgress = remember { androidx.compose.animation.core.Animatable(0f) }
    val pressCycles = remember { Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED) }
    androidx.compose.runtime.LaunchedEffect(pressCycles) {
        for (release in pressCycles) {
            // Every tap owns a complete cycle. Travel or the click action may
            // proceed concurrently, but the glass must reach full lift before
            // it is allowed to contract back into the control.
            pressProgress.animateTo(1f, tween(durationMillis = 105))
            release.await()
            pressProgress.animateTo(0f, tween(durationMillis = 165))
        }
    }
    val pressScale = 1f + 0.065f * pressProgress.value
    val pressLift = (-1.25).dp * pressProgress.value
    val edgeEmphasis = 0.82f * pressProgress.value
    return this
        .graphicsLayer {
            clip = false
            translationY = pressLift.toPx()
            this.alpha = 0.985f + edgeEmphasis * 0.015f
        }
        .kyantGlassEdge(
            shape = shape,
            edgeColor = edgeColor,
            emphasis = (edgeEmphasis + materialAlpha * 0.22f).coerceAtMost(1f),
            scale = pressScale,
            enabled = pressProgress.value > 0.001f,
        )
        .pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false)
                val release = CompletableDeferred<Unit>()
                pressCycles.trySend(release)
                waitForUpOrCancellation()
                release.complete(Unit)
            }
        }
}

/** Kyant-standard edge-only glass for controls that cannot safely sample a recorder. */
@Composable
fun Modifier.kyantGlassEdge(
    shape: Shape,
    edgeColor: Color,
    emphasis: Float = 0f,
    scale: Float = 1f,
    enabled: Boolean = true,
): Modifier {
    if (!enabled) {
        return this
            .border(2.dp, Color.Black.copy(alpha = 0.12f), shape)
            .border(1.5.dp, Color.White.copy(alpha = 0.28f), shape)
    }
    val refractedShade = lerp(Color.Black, edgeColor, 0.18f)
    return drawBackdrop(
        backdrop = EmptyBackdrop,
        shape = { shape },
        effects = {},
        clipToShape = false,
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
        layerBlock = {
            scaleX = scale
            scaleY = scale
        },
        onDrawSurface = null,
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
    var pressed by remember { mutableStateOf(false) }
    var draggedFraction by remember { mutableStateOf<Float?>(null) }
    val settledFraction by animateFloatAsState(
        targetValue = if (checked) 1f else 0f,
        animationSpec = tween(durationMillis = 180),
        label = "liquid-switch-settle",
    )
    val fraction = draggedFraction ?: settledFraction
    val thumbWidth by animateDpAsState(
        targetValue = if (pressed) 30.dp else 24.dp,
        animationSpec = tween(durationMillis = 120),
        label = "liquid-switch-capsule-width",
    )
    val thumbOffset = 14.dp + 20.dp * fraction - thumbWidth / 2
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
                            releaseFraction = fractionAt(change.position.x)
                            draggedFraction = releaseFraction
                            change.consume()
                        }
                        if (!change.pressed) break
                    }
                    pressed = false
                    draggedFraction = null
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
                    scaleX = thumbScale
                    scaleY = thumbScale
                    translationX = thumbOffset.toPx()
                    translationY = if (pressed) 0f else 2.dp.toPx()
                }
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
val MobilePopupShape = RoundedCornerShape(22.dp)
