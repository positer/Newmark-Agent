package com.newmark.mobile.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.exp

/** A short, frame-rate-independent drag lag; never overshoots a constrained target. */
internal fun dampedLiquidPosition(current: Float, target: Float, seconds: Float): Float =
    target + (current - target) * exp(-seconds.coerceAtLeast(0f) / 0.055f)

@Stable
class LiquidDragFollower internal constructor(
    private val scope: CoroutineScope,
    initialValue: Float,
) {
    var value by mutableFloatStateOf(initialValue)
        private set
    var velocity by mutableFloatStateOf(0f)
        private set
    private var target = initialValue
    private var job: Job? = null
    private var generation = 0

    fun startFrom(displayed: Float) {
        cancel()
        value = displayed
        target = displayed
    }

    fun updateTarget(raw: Float) {
        target = raw
        if (job?.isActive == true) return
        val owner = ++generation
        job = scope.launch {
            var previousFrame = withFrameNanos { it }
            while (isActive && generation == owner) {
                val now = withFrameNanos { it }
                val seconds = ((now - previousFrame) / 1_000_000_000f).coerceIn(0.001f, 0.05f)
                previousFrame = now
                val previous = value
                value = dampedLiquidPosition(previous, target, seconds)
                velocity = (value - previous) / seconds
                if (abs(target - value) < 0.05f && abs(velocity) < 1f) {
                    value = target
                    velocity = 0f
                    break
                }
            }
        }
    }

    /** Transfer the visible position, never the unfiltered target, to landing. */
    suspend fun stopAndRead(): Float {
        val previous = job
        cancel()
        previous?.cancelAndJoin()
        return value
    }

    fun cancel() {
        generation++
        job?.cancel()
        job = null
        velocity = 0f
    }
}

@Composable
fun rememberLiquidDragFollower(initialValue: Float = 0f): LiquidDragFollower {
    val scope = rememberCoroutineScope()
    val follower = remember { LiquidDragFollower(scope, initialValue) }
    DisposableEffect(follower) { onDispose { follower.cancel() } }
    return follower
}
