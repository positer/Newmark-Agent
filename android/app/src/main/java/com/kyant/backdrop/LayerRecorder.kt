package com.kyant.backdrop

// Modified by Newmark AI in 2026 for Kotlin 2.0 / Compose 1.7 compatibility.

import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.draw
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.requireDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.toIntSize

// Kotlin 2.0-compatible rewrite of the upstream `context(node: DelegatableNode)` receiver.
// The upstream form requires Kotlin 2.1+; this project builds with Kotlin 2.0.21.
internal fun DrawScope.recordLayer(
    node: DelegatableNode,
    layer: GraphicsLayer,
    size: IntSize = this.size.toIntSize(),
    block: DrawScope.() -> Unit
) {
    layer.record(
        density = node.requireDensity(),
        layoutDirection = layoutDirection,
        size = size
    ) {
        this@recordLayer.draw(
            density = drawContext.density,
            layoutDirection = drawContext.layoutDirection,
            canvas = drawContext.canvas,
            size = drawContext.size,
            graphicsLayer = drawContext.graphicsLayer,
            block = block
        )
    }
}
