package com.newmark.mobile.data

import kotlin.math.floor

/** Pure port of the PC context budget/retention invariants. */
internal object LocalContextContract {
    data class Budget(
        val estimatedTokens: Int,
        val maxTokens: Int,
        val buildBlockTriggerTokens: Int,
        val longHistoryTriggerTokens: Int,
        val summaryTokens: Int,
    ) {
        val thresholdReached: Boolean
            get() = estimatedTokens >= buildBlockTriggerTokens
    }

    fun estimateTokens(messages: List<ChatMessage>): Int = messages.sumOf { message ->
        // Match the desktop's conservative character estimator closely enough
        // to trigger before provider rejection; structural/tool overhead is
        // charged explicitly instead of allowing large tool arrays for free.
        val chars = message.content.length + message.toolCalls.sumOf { it.name.length + it.arguments.length } + 24
        ((chars + 3) / 4).coerceAtLeast(1)
    }

    fun budget(messages: List<ChatMessage>, maxTokens: Int): Budget {
        val window = maxTokens.coerceAtLeast(1)
        return Budget(
            estimatedTokens = estimateTokens(messages),
            maxTokens = window,
            buildBlockTriggerTokens = maxOf(128, floor(window * 0.70).toInt()),
            longHistoryTriggerTokens = maxOf(128, floor(window * 0.20).toInt()),
            summaryTokens = maxOf(96, minOf(1600, floor(window * 0.12).toInt())),
        )
    }

    fun recentContextSuffix(messages: List<ChatMessage>, maxMessages: Int, tokenBudget: Int): List<ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val latestUser = messages.indexOfLast { it.role == "user" }
        var start = (messages.size - maxMessages.coerceAtLeast(1)).coerceAtLeast(0)
        while (start > 0 && messages[start].role != "user") start--
        while (start < latestUser && estimateTokens(messages.drop(start)) > tokenBudget) {
            start++
            while (start < latestUser && messages[start].role != "user") start++
        }
        if (latestUser >= 0 && messages[start].role != "user") start = latestUser
        return messages.drop(start)
    }

    fun fallbackSummary(omitted: List<ChatMessage>, summaryTokens: Int): String {
        val transcript = omitted.joinToString("\n") { "${it.role}: ${it.content}" }
        val maxChars = maxOf(384, summaryTokens * 4)
        val compact = if (transcript.length <= maxChars) transcript else {
            val head = (maxChars * 0.65).toInt()
            val tail = (maxChars - head - 42).coerceAtLeast(0)
            "${transcript.take(head).trimEnd()}\n\n[...summary compacted...]\n\n${transcript.takeLast(tail).trimStart()}"
        }
        return "[Context Compression Fallback]\n\nCompressed ${omitted.size} omitted messages from a ${transcript.length}-character context window.\n\n" +
            "## Active Or Unfinished Work\nPreserve only explicit unfinished work and the newest user instruction.\n\n" +
            "## Completed Or Background Work\n$compact\n\n" +
            "## Decisions And Constraints\nThe latest retained user message is authoritative."
    }

    /** Bounded source for a model-generated summary; huge tool output must not
     * recreate the very context overflow that compression is meant to solve. */
    fun summarySource(omitted: List<ChatMessage>, maxChars: Int): String {
        val limit = maxChars.coerceAtLeast(1_024)
        val perMessage = (limit / 8).coerceAtLeast(512)
        val rows = omitted.map { message ->
            val calls = message.toolCalls.joinToString("\n") { "tool_call ${it.name}: ${it.arguments}" }
            val body = buildString {
                append(message.role)
                append(": ")
                append(message.content)
                if (calls.isNotBlank()) {
                    append('\n')
                    append(calls)
                }
            }
            if (body.length <= perMessage) body else {
                val head = (perMessage * 0.6).toInt()
                val tail = (perMessage - head - 28).coerceAtLeast(0)
                "${body.take(head)}\n[...entry bounded...]\n${body.takeLast(tail)}"
            }
        }
        val selected = ArrayDeque<String>()
        var used = 0
        var left = 0
        var right = rows.lastIndex
        var takeNewest = true
        while (left <= right) {
            val row = if (takeNewest) rows[right--] else rows[left++]
            takeNewest = !takeNewest
            if (used + row.length + 1 > limit) continue
            if (takeNewest) selected.addFirst(row) else selected.addLast(row)
            used += row.length + 1
        }
        return selected.joinToString("\n")
    }

    fun continuationAnchor(): ChatMessage = ChatMessage(
        role = "system",
        content = "Continue Same Build After Context Compression. Treat the retained latest user instruction as authoritative.",
    )
}
