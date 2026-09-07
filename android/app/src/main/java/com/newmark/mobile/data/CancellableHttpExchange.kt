package com.newmark.mobile.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Response
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Cancellation remains connected until the entire response body is consumed. */
internal class CancellableHttpExchange {
    private val cancelled = AtomicBoolean(false)
    private val activeCall = AtomicReference<Call?>(null)

    fun execute(call: Call): Response {
        activeCall.set(call)
        if (cancelled.get()) {
            call.cancel()
            throw CancellationException("HTTP exchange cancelled")
        }
        return call.execute()
    }

    fun cancel() {
        cancelled.set(true)
        activeCall.get()?.cancel()
    }
}

/**
 * OkHttp execute/body reads block an IO thread. A Job completion callback is
 * too late to unblock that same job; this suspension observes cancellation
 * immediately and closes the active socket before waiting for the reader.
 * One worker owns a whole exchange, including any explicit request retry.
 */
internal suspend fun <T> withCancellableHttpExchange(
    consume: suspend (CancellableHttpExchange) -> T,
): T = coroutineScope {
    suspendCancellableCoroutine { continuation ->
        val exchange = CancellableHttpExchange()
        val reader = launch(Dispatchers.IO) {
            try {
                continuation.resume(consume(exchange))
            } catch (error: Throwable) {
                continuation.resumeWithException(error)
            }
        }
        continuation.invokeOnCancellation {
            exchange.cancel()
            reader.cancel()
        }
    }
}
