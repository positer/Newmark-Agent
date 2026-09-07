package com.newmark.mobile.ui

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asExecutor

/** A cancelled tab waiter must not cancel the process-wide startup other tabs share. */
internal class BrowserStartupGate {
    private var completion: CompletableDeferred<Unit>? = null

    suspend fun await(start: ((Result<Unit>) -> Unit) -> Unit) {
        val ready = synchronized(this) {
            completion ?: CompletableDeferred<Unit>().also { created ->
                completion = created
                try {
                    start { result ->
                        result.fold({ created.complete(Unit) }, created::completeExceptionally)
                    }
                } catch (error: Exception) {
                    created.completeExceptionally(error)
                }
            }
        }
        ready.await()
    }
}

internal object BrowserStartup {
    private val gate = BrowserStartupGate()

    suspend fun await(context: Context) = gate.await { complete ->
        // No WebView/WebSettings instance is touched until the callback. The
        // supported AndroidX path moves native library loading off the UI thread.
        WebViewCompat.startUpWebView(
            context.applicationContext,
            WebViewStartUpConfig.Builder(Dispatchers.IO.asExecutor()).build(),
            object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
                override fun onResult(result: WebViewStartUpResult) = complete(Result.success(Unit))
                override fun onError(error: WebViewStartupException) = complete(Result.failure(error))
            },
        )
    }
}
