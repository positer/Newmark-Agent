package com.newmark.mobile.ui.components

import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.SweepGradient
import androidx.compose.animation.core.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.dp

/** PC's 3-second monochrome conic border. Only the shader rotates, never the capsule. */
@Composable
internal fun Modifier.conversationRuntimeBorder(enabled: Boolean): Modifier {
    if (!enabled) return this
    val transition = rememberInfiniteTransition(label = "conversationRuntime")
    val angle = transition.animateFloat(0f, 360f,
        infiniteRepeatable(tween(3000, easing = LinearEasing)), label = "runtimeBorderAngle")
    return drawWithCache {
        val width = 2.dp.toPx()
        val inset = width / 2f
        val shader = SweepGradient(size.width / 2f, size.height / 2f,
            intArrayOf(android.graphics.Color.BLACK, android.graphics.Color.WHITE,
                android.graphics.Color.BLACK, android.graphics.Color.WHITE, android.graphics.Color.BLACK),
            floatArrayOf(0f, .25f, .5f, .75f, 1f))
        val matrix = Matrix()
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = width
            this.shader = shader
        }
        onDrawWithContent {
            drawContent()
            // Reading phase only during drawing avoids recomposing/layout of the list each frame.
            matrix.setRotate(angle.value - 90f, size.width / 2f, size.height / 2f)
            shader.setLocalMatrix(matrix)
            // Native Canvas retains Paint's shader handle; publish the transformed shader each frame.
            paint.shader = shader
            val radius = (size.height / 2f - inset).coerceAtLeast(0f)
            drawContext.canvas.nativeCanvas.drawRoundRect(inset, inset,
                size.width - inset, size.height - inset, radius, radius, paint)
        }
    }
}
