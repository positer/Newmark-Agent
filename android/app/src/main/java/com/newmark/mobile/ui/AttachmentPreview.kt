package com.newmark.mobile.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Previews never decode the full camera image on the composition thread. */
internal fun decodeAttachmentPreview(dataUrl: String, maxEdge: Int = 840): Bitmap? {
    require(maxEdge > 0)
    if (dataUrl.length > 18 * 1024 * 1024) return null
    return runCatching {
        val bytes = Base64.decode(dataUrl.substringAfter(',', ""), Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxEdge) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
            inSampleSize = sample
        })
    }.getOrNull()
}

@Composable
internal fun rememberAttachmentPreview(dataUrl: String): State<Bitmap?> =
    produceState<Bitmap?>(null, dataUrl) {
        value = null
        value = withContext(Dispatchers.Default) { decodeAttachmentPreview(dataUrl) }
    }
