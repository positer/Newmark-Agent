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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.newmark.mobile.ui.theme.MarqueeColors

/** 跑马灯渐变刷：与 PC-GUI 完全一致——conic-gradient 绕中心旋转（3s 一圈，4 色循环） */
@Composable
fun rememberMarqueeBrush(periodMs: Int = 3000): Brush {
    val transition = rememberInfiniteTransition(label = "marquee")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(periodMs, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "marqueeAngle",
    )
    // 基础 stops 每帧不变，只按 offset 旋转（避免每帧 sortedBy 排序分配）；末尾 1f 闭合首色对齐 PC conic-gradient
    val baseStops = remember {
        val n = MarqueeColors.size
        MarqueeColors.mapIndexed { i, c -> i.toFloat() / n to c } + (1f to MarqueeColors.first())
    }
    val offset = angle / 360f
    val n = baseStops.size
    val shifted = ArrayList<Pair<Float, Color>>(n)
    for (i in baseStops.indices) {
        val base = baseStops[i]
        val f = if (base.first >= 1f) {
            1f // 闭合 stop 始终留在 360°
        } else {
            val v = base.first + offset
            if (v >= 1f) v - 1f else v
        }
        shifted.add(f to base.second)
    }
    // 升序序列按 offset 旋转：从第一个取模回绕处断开重排（等价于排序，无比较开销）
    var split = 0
    for (i in baseStops.indices) {
        if (baseStops[i].first >= 1f) break
        if (baseStops[i].first + offset >= 1f) { split = i; break }
    }
    val stops = if (split == 0) shifted else shifted.subList(split, n) + shifted.subList(0, split)
    return Brush.sweepGradient(*stops.toTypedArray())
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
    width: Dp = 2.dp,
    modifier: Modifier = Modifier,
    periodMs: Int = 3000,
    content: @Composable () -> Unit,
) {
    val brush = rememberMarqueeBrush(periodMs)
    Box(
        modifier = modifier.drawBehind {
            val stroke = width.toPx()
            val radius = cornerRadius.toPx()
            drawRoundRect(
                brush = brush,
                topLeft = Offset(-stroke / 2f, -stroke / 2f),
                size = Size(size.width + stroke, size.height + stroke),
                cornerRadius = CornerRadius(radius + stroke / 2f, radius + stroke / 2f),
                style = Stroke(width = stroke),
            )
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
