package com.newmark.mobile

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.content.res.Configuration
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.IntentCompat
import com.newmark.mobile.data.IncomingShare
import com.newmark.mobile.ui.NewmarkApp
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.concurrent.atomic.AtomicLong

class MainActivity : ComponentActivity() {
    private val shareSequence = AtomicLong()
    private val pendingShares = MutableStateFlow<List<IncomingShare>>(emptyList())
    private val pendingPairUrl = MutableStateFlow<String?>(null)

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
        enqueueShare(intent, coldStart = true)
        pendingPairUrl.value = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString
        val runtimeStressScenario = intent?.getStringExtra("newmark_runtime_stress")
            ?.takeIf { packageName.endsWith(".stress") }
        val startedAt = SystemClock.elapsedRealtime()
        var interactiveReported = false
        setContent {
            val shares by pendingShares.collectAsState()
            val pairUrl by pendingPairUrl.collectAsState()
            NewmarkApp(
                initialPairUrl = pairUrl,
                runtimeStressScenario = runtimeStressScenario,
                incomingShare = shares.firstOrNull(),
                onIncomingShareConsumed = { id -> pendingShares.value = pendingShares.value.filterNot { it.id == id } },
            ) {
                if (!interactiveReported) {
                    interactiveReported = true
                    val elapsed = SystemClock.elapsedRealtime() - startedAt
                    Log.i("NewmarkStartup", "INTERACTIVE_READY_MS=$elapsed")
                    reportFullyDrawn()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == Intent.ACTION_VIEW) pendingPairUrl.value = intent.dataString
        enqueueShare(intent, coldStart = false)
    }

    private fun enqueueShare(intent: Intent?, coldStart: Boolean) {
        intent ?: return
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val uris = linkedSetOf<Uri>()
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::addAll)
        intent.clipData?.let { clip ->
            repeat(clip.itemCount) { index -> clip.getItemAt(index).uri?.let(uris::add) }
        }
        val safeUris = uris.filter { it.scheme.equals("content", ignoreCase = true) }.map(Uri::toString)
        if (text.isBlank() && safeUris.isEmpty()) return
        pendingShares.value = pendingShares.value + IncomingShare(
            id = shareSequence.incrementAndGet(),
            coldStart = coldStart,
            text = text.take(48_000),
            contentUris = safeUris,
            mimeType = intent.type.orEmpty().ifBlank { "application/octet-stream" },
        )
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        requestHighRefreshRate()
    }
}
