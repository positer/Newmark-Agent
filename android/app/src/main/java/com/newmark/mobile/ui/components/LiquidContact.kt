package com.newmark.mobile.ui.components

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned

/** The physical contact is independent of the rail's constrained, animated thumb. */
@Stable
class LiquidContactState internal constructor() {
    var positionInWindow: Offset? by mutableStateOf(null)
        private set
    var pressed: Boolean by mutableStateOf(false)
        private set

    internal fun update(position: Offset, isPressed: Boolean) {
        positionInWindow = position.takeIf { it.x.isFinite() && it.y.isFinite() }
        pressed = isPressed
    }

    internal fun release() { pressed = false }

    internal fun clearReleased() {
        if (!pressed) positionInWindow = null
    }

    internal fun localPosition(coordinates: LayoutCoordinates?): Offset? {
        val point = positionInWindow ?: return null
        if (coordinates == null || !coordinates.isAttached) return null
        // Keep off-axis and out-of-bounds contacts intact. The glass outline,
        // rather than a clamped light source, clips the visible part of the halo.
        return coordinates.windowToLocal(point).takeIf { it.x.isFinite() && it.y.isFinite() }
    }
}

@Composable
fun rememberLiquidContactState(): LiquidContactState = remember { LiquidContactState() }

/** Non-consuming observer on the original gesture owner, present before pickup. */
fun Modifier.trackLiquidContact(contact: LiquidContactState?): Modifier {
    if (contact == null) return this
    return composed {
        var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
        this.onGloballyPositioned { coordinates = it }.pointerInput(contact) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                fun record(point: Offset, isPressed: Boolean) {
                    val owner = coordinates
                    if (owner != null && owner.isAttached) contact.update(owner.localToWindow(point), isPressed)
                }
                record(down.position, true)
                try {
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        record(change.position, change.pressed)
                        if (!change.pressed) break
                    }
                } finally {
                    // Retain the last physical point through travel and landing.
                    // The disappearing/flat morph clears it after its animation.
                    contact.release()
                }
            }
        }
    }
}

/** Invert a centered optical-only transform without changing the physical contact. */
internal fun liquidContactBeforeTransform(
    point: Offset,
    size: Size,
    scaleX: Float,
    scaleY: Float,
    translation: Offset,
): Offset = Offset(
    (point.x - size.width / 2f - translation.x) / scaleX + size.width / 2f,
    (point.y - size.height / 2f - translation.y) / scaleY + size.height / 2f,
)
