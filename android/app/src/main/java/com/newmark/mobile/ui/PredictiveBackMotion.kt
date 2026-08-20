package com.newmark.mobile.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.collect

@Composable
internal fun predictiveBackMotion(
    onBack: () -> Unit,
    fadeOnly: Boolean = false,
    retainProgressOnCommit: Boolean = false,
    settleProgressOnCommit: Boolean = false,
): Pair<Float, Modifier> {
    var progress by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler { events ->
        var committed = false
        try {
            events.collect { event -> progress = event.progress.coerceIn(0f, 1f) }
            onBack()
            committed = true
            // Nested destinations stay inside the same Settings surface. Once
            // their back is committed, let the gesture transform return from
            // the exact release position while AnimatedContent performs the
            // page hand-off. Resetting in finally would expose one untouched
            // frame before that transition starts.
            if (settleProgressOnCommit) {
                animate(
                    initialValue = progress,
                    targetValue = 0f,
                    animationSpec = tween(
                        durationMillis = 220,
                        easing = CubicBezierEasing(.16f, 1f, .3f, 1f),
                    ),
                ) { value, _ -> progress = value }
            }
        } catch (_: CancellationException) {
            // Android cancelled the gesture; return the retained page to rest.
        } finally {
            // A committed top-level page remains composed while its outer
            // AnimatedVisibility exits. Keep the release transform in place so
            // that transition starts from the finger position instead of first
            // flashing the page back to its untouched layout. Nested-page backs
            // finish their explicit release settlement above.
            if (!committed || (!retainProgressOnCommit && !settleProgressOnCommit)) progress = 0f
        }
    }
    return progress to Modifier.graphicsLayer {
        translationX = if (fadeOnly) 0f else size.width * progress * .28f
        alpha = if (fadeOnly) 1f - progress else 1f - progress * .16f
        val scale = if (fadeOnly) 1f else 1f - progress * .012f
        scaleX = scale
        scaleY = scale
    }
}
