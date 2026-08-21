package com.newmark.mobile.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.newmark.mobile.ui.theme.MarqueeColors

/** 跑马灯渐变刷：与 PC-GUI 完全一致——conic-gradient 绕中心旋转（3s 一圈，4 色循环） */
private data class MarqueeAnimation(val brush: Brush, val angle: Float)

@Composable
private fun rememberMarqueeAnimation(): MarqueeAnimation {
    val transition = rememberInfiniteTransition(label = "marquee")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(3000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "marqueeAngle",
    )
    // 基础 stops 每帧不变，只按 offset 旋转（避免每帧 sortedBy 排序分配）；末尾 1f 闭合首色对齐 PC conic-gradient
    val baseStops = remember {
        val n = MarqueeColors.size
        MarqueeColors.mapIndexed { i, c -> i.toFloat() / n to c } + (1f to MarqueeColors.first())
    }
    // Keep the conic stops immutable. Reordering stops at the 0/360 boundary
    // creates a visible jump; rotating the draw scope preserves continuity.
    return MarqueeAnimation(Brush.sweepGradient(*baseStops.toTypedArray()), angle)
}

/**
 * 完全对齐 PC-GUI `.marquee-border::before`：
 *
 *   inset: calc(-1 * var(--marquee-width));
 *   padding: var(--marquee-width);
 *   background: conic-gradient(from --marquee-angle, g1..g4, g1);
 *   mask: content-box, border-box;
 *   mask-composite: exclude;   // ← 用遮罩把除边框外的地方全部镂空
 *
 * 即在元素外缘向外 `width` 画一圈旋转渐变边框（Stroke 只描边，中间自然镂空），
 * 内容自带背景。路径中心位于 `-width / 2`，因此描边恰好覆盖 `-width..0`；
 * cornerRadius 传元素自身圆角（会话行传 10dp），路径圆角同步增加半个描边宽度。
 */
@Composable
fun MarqueeBorder(
    cornerRadius: Dp,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val animation = rememberMarqueeAnimation()
    Box(
        modifier = modifier.drawBehind {
            val stroke = 2.dp.toPx()
            val radius = cornerRadius.toPx()
            rotate(animation.angle, pivot = center) {
                drawRoundRect(
                    brush = animation.brush,
                    topLeft = Offset(-stroke / 2f, -stroke / 2f),
                    size = Size(size.width + stroke, size.height + stroke),
                    cornerRadius = CornerRadius(radius + stroke / 2f, radius + stroke / 2f),
                    style = Stroke(width = stroke),
                )
            }
        },
    ) {
        content()
    }
}

/** 统一圆角尺寸（对齐 --rs/--rm/--rl/--rx） */
val NewmarkShapeSmall = RoundedCornerShape(5.dp)
val NewmarkShapeMedium = RoundedCornerShape(9.dp)
val NewmarkShapeLarge = RoundedCornerShape(13.dp)
val NewmarkShapeExtra = RoundedCornerShape(18.dp)
