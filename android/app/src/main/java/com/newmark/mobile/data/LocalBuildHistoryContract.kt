package com.newmark.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/** Bounded, read-only projection of persisted local Build blocks. */
object LocalBuildHistoryContract {
    data class Record(
        val historyIndex: Int,
        val run: LocalWorkRun,
        val userInput: String,
        val finalSummary: String,
    )

    fun records(messages: List<ChatMessage>, currentRunId: String = "", limit: Int = 200): List<Record> {
        val entries = messages.mapNotNull { message ->
            val run = message.workRun ?: return@mapNotNull null
            if (run.runId.isBlank() || run.runId == currentRunId) return@mapNotNull null
            val user = messages.asSequence()
                .takeWhile { it !== message }
                .filter { it.role == "user" }
                .lastOrNull()?.content.orEmpty()
            val final = run.events.asReversed().firstOrNull { it.type == "final_response" }?.content
                .orEmpty().ifBlank { run.text }
            Triple(run, user, final)
        }.distinctBy { it.first.runId }
            .sortedWith(compareByDescending<Triple<LocalWorkRun, String, String>> { it.first.startedAt }.thenByDescending { it.first.endedAt })
            .take(limit.coerceIn(1, 200))
        return entries.mapIndexed { index, (run, user, final) -> Record(index + 1, run, user, final) }
    }

    fun query(
        messages: List<ChatMessage>,
        args: JSONObject,
        currentRunId: String = "",
    ): String {
        val history = records(messages, currentRunId)
        val runId = args.optString("run_id").trim()
        val requestedIndex = args.optInt("history_index", 0)
        val record = when {
            runId.isNotBlank() -> history.firstOrNull { it.run.runId == runId }
            requestedIndex > 0 -> history.getOrNull(requestedIndex - 1)
            else -> null
        } ?: return JSONObject()
            .put("ok", false)
            .put("error", "Historical Build Block not found. Pass history_index or run_id.")
            .put("historyCount", history.size)
            .toString()

        val maxEvents = args.optInt("max_events", 80).coerceIn(1, 200)
        val maxChars = args.optInt("max_chars", 2_000).coerceIn(100, 4_000)
        val public = record.run.events.filterNot { it.type in setOf("text", "response", "final_response") }
        val events = public.takeLast(maxEvents).map { event ->
            JSONObject().apply {
                put("sequence", event.sequence)
                put("type", event.type)
                put("timestamp", event.timestamp)
                put("toolName", event.toolName)
                put("status", event.status)
                put("content", event.content.take(maxChars))
            }
        }
        val build = JSONObject()
            .put("historyIndex", record.historyIndex)
            .put("runId", record.run.runId)
            .put("userInput", record.userInput.take(50_000))
            .put("finalSummary", record.finalSummary.take(50_000))
            .put("completionStatus", record.run.status)
            .put("startedAt", record.run.startedAt)
            .put("endedAt", record.run.endedAt)
            .put("publicActivities", JSONArray(events))
        return JSONObject()
            .put("ok", true)
            .put("buildBlock", build)
            .put("truncatedActivities", (public.size - events.size).coerceAtLeast(0))
            .toString()
    }
}
