package com.newmark.mobile

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.newmark.mobile.ui.NewmarkApp

class MainActivity : ComponentActivity() {
    private fun requestHighRefreshRate() {
        // Use the maximum mode exposed by the current display. This applies
        // equally to portrait, landscape, fold and tablet configurations.
        val display = window.decorView.display
        val maxRefreshRate = display?.supportedModes?.maxOfOrNull { it.refreshRate }
            ?: display?.refreshRate
            ?: 60f
        window.attributes = window.attributes.apply { preferredRefreshRate = maxRefreshRate }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestHighRefreshRate()
        enableEdgeToEdge()
        val pairUrl = intent?.dataString
        val runtimeStressScenario = intent?.getStringExtra("newmark_runtime_stress")
            ?.takeIf { packageName.endsWith(".stress") }
        val startedAt = SystemClock.elapsedRealtime()
        var interactiveReported = false
        setContent {
            NewmarkApp(initialPairUrl = pairUrl, runtimeStressScenario = runtimeStressScenario) {
                if (!interactiveReported) {
                    interactiveReported = true
                    val elapsed = SystemClock.elapsedRealtime() - startedAt
                    Log.i("NewmarkStartup", "INTERACTIVE_READY_MS=$elapsed")
                    reportFullyDrawn()
                }
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        requestHighRefreshRate()
    }
}
