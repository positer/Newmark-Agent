package com.newmark.mobile.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** Keep system chrome bound to the app preference, including resume/recreation. */
@Composable
internal fun ThemeSystemBars(dark: Boolean) {
    val view = LocalView.current
    val activity = view.context.activity() ?: return
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val applyAppearance = {
        WindowCompat.getInsetsController(activity.window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
    SideEffect { applyAppearance() }
    DisposableEffect(lifecycle, view, dark) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) applyAppearance()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
}
