package com.newmark.mobile.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import io.ratex.RaTeXEngine
import io.ratex.RaTeXFontLoader
import io.ratex.RaTeXRenderer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Native offline display math: parsing/font IO never runs during composition. */
@Composable
internal fun rememberMathRenderer(tex: String, fontSize: Float, color: Color, displayMode: Boolean = true): androidx.compose.runtime.State<RaTeXRenderer?> {
    val context = LocalContext.current.applicationContext
    val density = LocalDensity.current
    val pixels = with(density) { fontSize.sp.toPx() }
    return produceState<RaTeXRenderer?>(null, tex, pixels, color, displayMode) {
        value = null
        value = withContext(Dispatchers.Default) {
            try {
                if (tex.length > 16384) return@withContext null
                RaTeXFontLoader.ensureLoaded(context)
                check(RaTeXFontLoader.getTypeface("Main-Regular") != null)
                val layout = RaTeXEngine.parse(tex, displayMode = displayMode, color = color.toArgb())
                RaTeXRenderer(layout, pixels, RaTeXFontLoader::getTypeface).takeIf {
                    it.widthPx.isFinite() && it.totalHeightPx.isFinite() &&
                        it.widthPx in 1f..8192f && it.totalHeightPx in 1f..8192f && layout.items.size <= 20000
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) { null }
              catch (_: LinkageError) { null }
        }
    }
}

@Composable
internal fun NativeMath(tex: String, fontSize: Float, color: Color, fallback: @Composable () -> Unit) {
    val density = LocalDensity.current
    val ready = rememberMathRenderer(tex, fontSize, color).value
    if (ready == null) fallback()
    else Row(Modifier.horizontalScroll(rememberScrollState()).testTag("native-math")) {
        Canvas(Modifier.size(with(density) { ready.widthPx.toDp() }, with(density) { ready.totalHeightPx.toDp() })
            .semantics { contentDescription = renderReadableLatex(tex) }) {
            drawIntoCanvas { ready.draw(it.nativeCanvas) }
        }
    }
}
