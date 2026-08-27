package com.newmark.mobile.data

val EMPTY_RESPONSE_RETRY_DELAYS_MS = longArrayOf(200L, 800L, 2_000L, 10_000L, 60_000L)
const val MAX_EMPTY_RESPONSE_RETRIES = 5
const val MAX_CONSECUTIVE_EMPTY_RESPONSES = MAX_EMPTY_RESPONSE_RETRIES + 1

fun emptyResponseRetryDelayMs(consecutiveEmptyResponses: Int): Long =
    EMPTY_RESPONSE_RETRY_DELAYS_MS.getOrElse(consecutiveEmptyResponses - 1) { 0L }

/** Any provider activity is a successful turn for empty-response accounting. */
fun isUsableChatResponse(response: ChatResponse): Boolean =
    response.content.isNotBlank() ||
        response.reasoningContent.isNotBlank() ||
        response.toolCalls.isNotEmpty()

/** Any usable model turn clears the consecutive-empty-response streak. */
fun nextEmptyResponseStreak(previous: Int, usable: Boolean): Int =
    if (usable) 0 else (previous + 1).coerceAtMost(MAX_CONSECUTIVE_EMPTY_RESPONSES)

/**
 * Only an explicit provider empty-response failure is retryable. A silent
 * connection, EOF, timeout, or stream close is not an empty response and must
 * surface immediately without entering this retry schedule.
 */
fun isEmptyResponseFailure(error: Throwable): Boolean =
    generateSequence(error) { it.cause }.any { cause ->
        val message = cause.message?.trim()?.lowercase().orEmpty()
        message.contains("provider returned an empty response")
    }

class EmptyResponseLimitException : IllegalStateException(
    "Provider returned empty responses after $MAX_EMPTY_RESPONSE_RETRIES retries",
)

class ProviderNoResponseException : IllegalStateException(
    "Provider returned no response; no empty-response retry was scheduled",
)
