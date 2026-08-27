package com.newmark.mobile.data

/**
 * Keeps provider sub-rounds inside one public thought node until a real work
 * boundary is reached. A thought-only response ends a provider round, not the
 * public thought itself.
 */
internal class MobileThoughtContinuation(
    private val events: MutableList<LocalWorkEvent>,
    private val createEvent: (type: String, content: String, durationMs: Long) -> LocalWorkEvent,
) {
    private var activeIndex = -1
    private var startedAt = 0L
    private var roundPrefix = ""
    private var roundOpen = false

    /** Returns true when this round created a new public thought shell. */
    fun beginRound(nowMs: Long): Boolean {
        check(!roundOpen) { "The previous thought provider round is still open" }
        val created = activeIndex !in events.indices
        if (created) {
            events += createEvent("thought", "", 0L)
            activeIndex = events.lastIndex
            startedAt = nowMs
        }
        roundPrefix = events[activeIndex].content
        roundOpen = true
        return created
    }

    /** Appends a streamed reasoning delta to the currently active round. */
    fun appendRoundDelta(delta: String): Boolean {
        if (!roundOpen || delta.isBlank() || activeIndex !in events.indices) return false
        val current = events[activeIndex]
        val firstDelta = current.content == roundPrefix
        val separator = if (firstDelta) separatorBetween(roundPrefix, delta) else ""
        events[activeIndex] = current.copy(content = current.content + separator + delta)
        return true
    }

    /**
     * Reconciles streamed deltas with the provider's final reasoning field.
     * Adapters commonly return both, so the final field replaces the current
     * round rather than being appended a second time.
     */
    fun endRound(finalReasoning: String): String? {
        if (!roundOpen || activeIndex !in events.indices) return null
        val current = events[activeIndex]
        val streamed = current.content
            .removePrefix(roundPrefix)
            .removePrefix("\n\n")
        val resolved = resolveRoundContent(streamed, finalReasoning)
        val merged = roundPrefix + separatorBetween(roundPrefix, resolved) + resolved
        roundOpen = false
        if (merged != current.content) events[activeIndex] = current.copy(content = merged)
        return resolved
    }

    /**
     * Closes the active public thought at a tool/text/guide/error/build
     * boundary. The returned result event is published by the caller.
     */
    fun finish(nowMs: Long): LocalWorkEvent? {
        if (activeIndex !in events.indices) return null
        if (roundOpen) endRound("")
        val content = events[activeIndex].content
        val durationMs = (nowMs - startedAt).coerceAtLeast(0L)
        activeIndex = -1
        startedAt = 0L
        roundPrefix = ""
        return createEvent("thought_result", content, durationMs)
    }

    private fun resolveRoundContent(streamed: String, finalReasoning: String): String {
        if (finalReasoning.isBlank()) return streamed
        if (streamed.isBlank()) return finalReasoning
        return when {
            finalReasoning == streamed -> streamed
            finalReasoning.contains(streamed) -> finalReasoning
            streamed.contains(finalReasoning) -> streamed
            // The stream has already been rendered. An incompatible final
            // summary must never rewind or replace that visible progress.
            else -> streamed
        }
    }

    private fun separatorBetween(prefix: String, suffix: String): String = when {
        prefix.isBlank() || suffix.isBlank() -> ""
        prefix.last().isWhitespace() || suffix.first().isWhitespace() -> ""
        else -> "\n\n"
    }
}

/**
 * Carries reasoning-only provider progress into the next provider sub-round.
 * The checkpoint is request-scoped: callers never add it to durable messages.
 */
internal class MobileThoughtRequestContinuation(
    private val maxCheckpointChars: Int = DEFAULT_MAX_CHECKPOINT_CHARS,
) {
    private var checkpoint = ""

    init {
        require(maxCheckpointChars >= MIN_CHECKPOINT_CHARS)
    }

    fun recordRound(reasoning: String) {
        if (reasoning.isBlank()) return
        checkpoint = boundCheckpoint(mergeProgress(checkpoint, reasoning))
    }

    fun requestMessages(base: List<ChatMessage>): List<ChatMessage> {
        if (checkpoint.isBlank()) return base
        return base + ChatMessage(
            role = "assistant",
            content = "",
            reasoningContent = checkpoint,
            timestamp = 0L,
            messageId = INTERNAL_MESSAGE_ID,
        )
    }

    fun clear() {
        checkpoint = ""
    }

    internal fun checkpointForTest(): String = checkpoint

    private fun mergeProgress(previous: String, incoming: String): String {
        if (previous.isBlank()) return incoming
        return when {
            incoming == previous -> previous
            incoming.startsWith(previous) -> incoming
            previous.startsWith(incoming) -> previous
            else -> {
                val overlap = longestSuffixPrefixOverlap(previous, incoming)
                if (overlap > 0) previous + incoming.drop(overlap)
                else previous + separatorBetween(previous, incoming) + incoming
            }
        }
    }

    private fun boundCheckpoint(value: String): String {
        if (value.length <= maxCheckpointChars) return value
        val marker = "[Earlier reasoning progress omitted; continue from the retained tail.]\n"
        return marker + value.takeLast((maxCheckpointChars - marker.length).coerceAtLeast(0))
    }

    private fun longestSuffixPrefixOverlap(left: String, right: String): Int {
        val limit = minOf(left.length, right.length)
        if (limit < MIN_MEANINGFUL_OVERLAP_CHARS) return 0
        for (length in limit downTo MIN_MEANINGFUL_OVERLAP_CHARS) {
            if (left.regionMatches(left.length - length, right, 0, length)) return length
        }
        return 0
    }

    private fun separatorBetween(prefix: String, suffix: String): String = when {
        prefix.isBlank() || suffix.isBlank() -> ""
        prefix.last().isWhitespace() || suffix.first().isWhitespace() -> ""
        else -> "\n\n"
    }

    companion object {
        private const val MIN_CHECKPOINT_CHARS = 256
        private const val MIN_MEANINGFUL_OVERLAP_CHARS = 16
        internal const val DEFAULT_MAX_CHECKPOINT_CHARS = 12_000
        internal const val INTERNAL_MESSAGE_ID = "__newmark_mobile_thought_continuation__"
    }
}
