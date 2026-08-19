package com.newmark.mobile

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.newmark.mobile.ui.NewmarkApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
}
