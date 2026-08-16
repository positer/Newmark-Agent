package com.newmark.mobile.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.newmark.mobile.ui.theme.MarqueeColors
import com.newmark.mobile.ui.theme.NewmarkBgSecondary

/** 流动的跑马灯渐变刷（运行中状态指示） */
@Composable
fun rememberMarqueeBrush(periodMs: Int = 2000): Brush {
    val transition = rememberInfiniteTransition(label = "marquee")
    val offset by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(periodMs, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "marqueeOffset",
    )
    val colors = MarqueeColors + MarqueeColors
    return Brush.linearGradient(
        colors = colors,
        start = Offset(offset * 600f, 0f),
        end = Offset(offset * 600f + 600f, 0f),
        tileMode = TileMode.Repeated,
    )
}

/** 整圈跑马灯描边容器（1.5dp 流动渐变边框，内部实心背景） */
@Composable
fun MarqueeBorder(
    shape: Shape,
    innerColor: Color = NewmarkBgSecondary,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val brush = rememberMarqueeBrush()
    Box(modifier = modifier.background(brush, shape)) {
        Box(
            modifier = Modifier
                .padding(1.5.dp)
                .background(innerColor, shape),
            content = { content() },
        )
    }
}

/** 顶部细渐变条（输入区/工作区运行中指示，对齐 .rb::before） */
@Composable
fun MarqueeTopBar(
    modifier: Modifier = Modifier,
    height: Dp = 1.5.dp,
) {
    val brush = rememberMarqueeBrush()
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .background(brush),
    )
}

/** 统一圆角尺寸（对齐 --rs/--rm/--rl/--rx） */
val NewmarkShapeSmall = RoundedCornerShape(5.dp)
val NewmarkShapeMedium = RoundedCornerShape(9.dp)
val NewmarkShapeLarge = RoundedCornerShape(13.dp)
val NewmarkShapeExtra = RoundedCornerShape(18.dp)
