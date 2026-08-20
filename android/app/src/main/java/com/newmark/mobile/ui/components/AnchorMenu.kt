package com.newmark.mobile.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.LocalGlassMode
import com.newmark.mobile.ui.theme.scaledGlassAlpha

enum class MenuPlacement { UpStart, EndTop, DownStart, DownEnd }

/** 自定义定位：锚点上方 + 左对齐（向右展开）、锚点右侧 + 上对齐、或锚点下方 + 左对齐（向右展开） */
private fun placementProvider(
    placement: MenuPlacement,
    gapPx: Int,
    verticalOffsetPx: Int,
    viewportMarginPx: Int,
    usePcPopoverBehavior: Boolean,
    safeLeftPx: Int,
    safeTopPx: Int,
    safeRightPx: Int,
    safeBottomPx: Int,
): PopupPositionProvider {
    return object : PopupPositionProvider {
        override fun calculatePosition(
            anchorBounds: IntRect,
            windowSize: IntSize,
            layoutDirection: LayoutDirection,
            popupContentSize: IntSize,
        ): IntOffset {
            val viewportLeft = safeLeftPx + viewportMarginPx
            val viewportTop = safeTopPx + viewportMarginPx
            val viewportRight = (windowSize.width - safeRightPx - viewportMarginPx)
                .coerceAtLeast(viewportLeft)
            val viewportBottom = (windowSize.height - safeBottomPx - viewportMarginPx)
                .coerceAtLeast(viewportTop)
            val x: Int
            val y: Int
            when (placement) {
                MenuPlacement.UpStart -> {
                    x = anchorBounds.left
                    y = anchorBounds.top - popupContentSize.height - gapPx + verticalOffsetPx
                }
                MenuPlacement.EndTop -> {
                    x = anchorBounds.right + gapPx
                    y = anchorBounds.top
                }
                MenuPlacement.DownStart -> {
                    x = anchorBounds.left
                    val availableBelow = (viewportBottom - anchorBounds.bottom)
                        .coerceAtLeast(0)
                    val availableAbove = (anchorBounds.top - viewportTop).coerceAtLeast(0)
                    val openAbove = usePcPopoverBehavior &&
                        availableBelow < popupContentSize.height &&
                        availableAbove > availableBelow
                    y = if (openAbove) {
                        anchorBounds.top - popupContentSize.height - gapPx + verticalOffsetPx
                    } else if (usePcPopoverBehavior) {
                        anchorBounds.bottom + gapPx
                    } else {
                        val below = anchorBounds.bottom + gapPx
                        if (below + popupContentSize.height <= viewportBottom) {
                            below
                        } else {
                            anchorBounds.top - popupContentSize.height - gapPx
                        }
                    }
                }
                MenuPlacement.DownEnd -> {
                    x = anchorBounds.right - popupContentSize.width
                    val availableBelow = (viewportBottom - anchorBounds.bottom)
                        .coerceAtLeast(0)
                    val availableAbove = (anchorBounds.top - viewportTop).coerceAtLeast(0)
                    val openAbove = usePcPopoverBehavior &&
                        availableBelow < popupContentSize.height &&
                        availableAbove > availableBelow
                    y = if (openAbove) {
                        anchorBounds.top - popupContentSize.height - gapPx + verticalOffsetPx
                    } else if (usePcPopoverBehavior) {
                        anchorBounds.bottom + gapPx
                    } else {
                        val below = anchorBounds.bottom + gapPx
                        if (below + popupContentSize.height <= viewportBottom) {
                            below
                        } else {
                            anchorBounds.top - popupContentSize.height - gapPx
                        }
                    }
                }
            }
            val maxX = (viewportRight - popupContentSize.width).coerceAtLeast(viewportLeft)
            val maxY = (viewportBottom - popupContentSize.height).coerceAtLeast(viewportTop)
            // UpStart is anchored above the input control. Do not apply the
            // generic bottom clamp here: on Android the popup window's safe
            // bottom can be below the actual input row, which previously
            // pinned every offset to the same y=1893 boundary.
            val resolvedY = if (placement == MenuPlacement.UpStart) {
                y.coerceAtLeast(viewportTop)
            } else {
                y.coerceIn(viewportTop, maxY)
            }
            return IntOffset(
                x.coerceIn(viewportLeft, maxX),
                resolvedY,
            )
        }
    }
}

/** Newmark 圆角弹窗：与 PC 复合 popover 相同的表面、折射边界和避让定位。 */
@Composable
fun AnchorMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    placement: MenuPlacement = MenuPlacement.UpStart,
    gap: Dp? = null,
    viewportMargin: Dp = 0.dp,
    /** Positive values move the whole first/second-level popover toward its input anchor. */
    verticalOffset: Dp = 0.dp,
    shape: Shape = NewmarkShapeMedium,
    backgroundColor: Color? = null,
    borderColor: Color? = null,
    contentPadding: Dp = 4.dp,
    showScrollbar: Boolean = false,
    usePcPopoverBehavior: Boolean = viewportMargin > 0.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalNewmarkPalette.current
    if (!expanded) return
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val safeDrawingInsets = WindowInsets.safeDrawing
    val safeLeftPx = safeDrawingInsets.getLeft(density, layoutDirection)
    val safeTopPx = safeDrawingInsets.getTop(density)
    val safeRightPx = safeDrawingInsets.getRight(density, layoutDirection)
    val safeBottomPx = safeDrawingInsets.getBottom(density)
    // 输入区的一级/二级复合菜单应紧贴输入框上方，但保留足够空气感，不能顶到按钮。
    val gapPx = with(density) { gap?.roundToPx() ?: 6 }
    val viewportMarginPx = with(density) { viewportMargin.roundToPx() }
    val verticalOffsetPx = with(density) { verticalOffset.roundToPx() }
    val provider = remember(
        placement,
        gapPx,
        verticalOffsetPx,
        viewportMarginPx,
        usePcPopoverBehavior,
        safeLeftPx,
        safeTopPx,
        safeRightPx,
        safeBottomPx,
    ) {
        placementProvider(
            placement = placement,
            gapPx = gapPx,
            verticalOffsetPx = verticalOffsetPx,
            viewportMarginPx = viewportMarginPx,
            usePcPopoverBehavior = usePcPopoverBehavior,
            safeLeftPx = safeLeftPx,
            safeTopPx = safeTopPx,
            safeRightPx = safeRightPx,
            safeBottomPx = safeBottomPx,
        )
    }
    val configuration = LocalConfiguration.current
    val safeVerticalDp = with(density) { (safeTopPx + safeBottomPx).toDp() }
    val safeViewportHeight = (configuration.screenHeightDp.dp - safeVerticalDp).coerceAtLeast(0.dp)
    val maxMenuHeight = minOf(320.dp, safeViewportHeight * 0.56f)
    val entrance = remember { Animatable(if (usePcPopoverBehavior) 0f else 1f) }
    LaunchedEffect(usePcPopoverBehavior) {
        if (usePcPopoverBehavior) {
            entrance.snapTo(0f)
            entrance.animateTo(
                targetValue = 1f,
                animationSpec = tween(
                    durationMillis = 190,
                    easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f),
                ),
            )
        } else {
            entrance.snapTo(1f)
        }
    }
    Popup(
        popupPositionProvider = provider,
        onDismissRequest = onDismissRequest,
        properties = PopupProperties(focusable = true),
    ) {
        val scrollState = rememberScrollState()
        val scrollModifier = if (usePcPopoverBehavior || showScrollbar) {
            Modifier
                .heightIn(max = maxMenuHeight)
        } else Modifier
        val contentScrollModifier = if (usePcPopoverBehavior || showScrollbar) {
            Modifier.verticalScroll(scrollState)
        } else Modifier
        val menu = @Composable {
            val glass = LocalGlassMode.current
            val menuBackground = (backgroundColor ?: p.bgTertiary).copy(
                alpha = scaledGlassAlpha(0.76f, glass.alpha),
            )
            val refractionBorder = borderColor ?: p.border2
            Box(
                modifier = modifier
                    .then(scrollModifier)
                    .shadow(
                        elevation = 14.dp,
                        shape = shape,
                        clip = false,
                        ambientColor = p.accent.copy(alpha = 0.18f),
                        spotColor = Color.Black.copy(alpha = 0.35f),
                    )
                    .clip(shape)
                    .background(menuBackground)
                    // 外圈为 PC 玻璃折射的亮边，内圈仍由表面颜色承接；亮色不再“无边框”。
                    .border(1.5.dp, refractionBorder, shape)
                    .border(0.5.dp, Color.White.copy(alpha = 0.36f), shape),
            ) {
                Column(
                    modifier = Modifier
                        .then(contentScrollModifier)
                        .padding(contentPadding),
                    content = content,
                )
                if (showScrollbar) {
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .width(3.dp)
                            .align(Alignment.CenterEnd)
                            .padding(vertical = 5.dp)
                            .drawWithContent {
                                drawContent()
                                val viewport = size.height
                                val total = scrollState.maxValue.toFloat() + viewport
                                if (total > viewport && viewport > 0f) {
                                    val thumbHeight = (viewport * viewport / total).coerceAtLeast(18.dp.toPx())
                                    val travel = (viewport - thumbHeight).coerceAtLeast(0f)
                                    val offset = if (scrollState.maxValue == 0) 0f else {
                                        travel * (scrollState.value.toFloat() / scrollState.maxValue.toFloat())
                                    }
                                    drawRoundRect(
                                        color = p.textTertiary.copy(alpha = 0.72f),
                                        topLeft = androidx.compose.ui.geometry.Offset(0f, offset),
                                        size = androidx.compose.ui.geometry.Size(size.width, thumbHeight),
                                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.width, size.width),
                                    )
                                }
                            },
                    )
                }
            }
        }
        if (usePcPopoverBehavior) {
            androidx.compose.foundation.layout.Box(
                modifier = Modifier.graphicsLayer {
                    // The whole first-level composite popup follows its
                    // already-resolved IME-safe anchor, then opens upward with
                    // the same restrained PC popover easing. Keep the glass
                    // surface fully opaque at the layer level: animating alpha
                    // forces an offscreen pass for its shadow/borders on every
                    // frame and caused severe issue-draw stalls on Android.
                    // Page changes inside the popup do not replay this entrance.
                    translationY = with(density) { 8.dp.toPx() } * (1f - entrance.value)
                },
            ) {
                menu()
            }
        } else {
            menu()
        }
    }
}

/** Newmark 圆角菜单项 */
@Composable
fun MenuRow(
    text: String,
    trailing: String = "",
    selected: Boolean = false,
    onClick: () -> Unit,
) {
    val p = LocalNewmarkPalette.current
    Row(
        modifier = Modifier
            .widthIn(min = 140.dp)
            .clip(NewmarkShapeSmall)
            .background(if (selected) p.bgQuaternary else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            color = p.textPrimary,
            maxLines = 1,
        )
        if (trailing.isNotBlank()) {
            Spacer(Modifier.width(10.dp))
            Text(
                text = trailing,
                fontSize = 10.5.sp,
                color = p.textTertiary,
                maxLines = 1,
            )
        }
    }
}
