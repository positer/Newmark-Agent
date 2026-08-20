package com.newmark.mobile.data

import android.content.Context
import com.newmark.mobile.ui.theme.DefaultGlassAlpha

/** PC-compatible glass alpha persisted independently from transient slider preview. */
class GlassStore(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("newmark_visual", Context.MODE_PRIVATE)

    fun loadAlpha(): Float =
        prefs.getFloat("glass_alpha", DefaultGlassAlpha).coerceIn(0f, 1f)

    fun saveAlpha(alpha: Float) {
        prefs.edit().putFloat("glass_alpha", alpha.coerceIn(0f, 1f)).apply()
    }
}
