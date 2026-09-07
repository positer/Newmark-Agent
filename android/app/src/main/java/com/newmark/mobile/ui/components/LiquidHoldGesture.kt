package com.newmark.mobile.ui.components

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.CancellationException

/**
 * Shared liquid selector gesture contract.
 *
 * A tap is delivered without delay. A drag owns the pointer only after a
 * 300 ms stationary hold; motion beyond touch slop before that is left
 * unconsumed so the containing LazyColumn/sidebar can scroll normally.
 */
fun Modifier.liquidHoldDragGesture(
    vararg keys: Any?,
    holdMillis: Long = 300L,
    contact: LiquidContactState? = null,
    canStartAt: (Offset) -> Boolean = { true },
    onCandidateStart: () -> Unit = {},
    onCandidateEnd: () -> Unit = {},
    onTap: (Offset) -> Unit,
    onHoldStart: (Offset) -> Unit,
    onDrag: (position: Offset, delta: Offset) -> Unit,
    onHoldEnd: (position: Offset, moved: Boolean) -> Unit,
    onCancel: () -> Unit = {},
): Modifier = trackLiquidContact(contact).pointerInput(*keys) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Main)
        if (!canStartAt(down.position)) return@awaitEachGesture
        onCandidateStart()
        var holdOwned = false
        var holdFinished = false
        try {
        val start = down.position
        var latest = start
        var released = false
        var escapedToScroll = false

        val completedBeforeHold = withTimeoutOrNull(holdMillis) {
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Main)
                val change = event.changes.firstOrNull { it.id == down.id }
                    ?: return@withTimeoutOrNull true
                // Android CANCEL is delivered as a consumed release. It must
                // not become an ordinary tap or a committed held selection.
                if (change.isConsumed) return@withTimeoutOrNull true
                latest = change.position
                if (!change.pressed) {
                    released = true
                    return@withTimeoutOrNull true
                }
                if ((latest - start).getDistance() > viewConfiguration.touchSlop) {
                    escapedToScroll = true
                    return@withTimeoutOrNull true
                }
            }
        } != null

        if (completedBeforeHold) {
            if (released && !escapedToScroll) onTap(latest)
            return@awaitEachGesture
        }

        down.consume()
        holdOwned = true
        onHoldStart(latest)
        var moved = false
        var heldDisplacement = latest - start
        var canceled = false
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Main)
            val change = event.changes.firstOrNull { it.id == down.id }
            if (change == null || change.isConsumed) {
                canceled = true
                break
            }
            // Compose maps both positions into this event's current local
            // frame. A stored local point belongs to the previous frame: if
            // a conversation row moved, subtracting it fabricates a reverse
            // drag on the next move/up and sends the landing back to its start.
            val delta = change.position - change.previousPosition
            latest = change.position
            heldDisplacement += delta
            if (heldDisplacement.getDistance() > viewConfiguration.touchSlop) moved = true
            change.consume()
            if (delta != Offset.Zero) onDrag(latest, delta)
            if (!change.pressed) break
        }
        if (canceled) onCancel() else onHoldEnd(latest, moved)
        holdFinished = true
        } catch (cancelled: CancellationException) {
            if (holdOwned && !holdFinished) onCancel()
            throw cancelled
        } finally {
            onCandidateEnd()
        }
    }
}
