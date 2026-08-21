package com.newmark.mobile.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalBuildHistoryContractTest {
    @Test
    fun readsNewestBuildActivityWithBoundedEvents() {
        val old = LocalWorkRun(
            runId = "old",
            startedAt = 1L,
            endedAt = 2L,
            status = "completed",
            text = "old final",
            events = listOf(
                LocalWorkEvent(type = "tool_call", sequence = 1, toolName = "read_file", content = "x"),
                LocalWorkEvent(type = "final_response", sequence = 2, content = "old final"),
            ),
        )
        val newest = LocalWorkRun(
            runId = "new",
            startedAt = 3L,
            endedAt = 4L,
            status = "error",
            events = List(20) { LocalWorkEvent(type = "tool_result", sequence = it.toLong(), content = "x".repeat(100)) },
        )
        val messages = listOf(
            ChatMessage("user", "old request"),
            ChatMessage("assistant", "old final", workRun = old),
            ChatMessage("user", "new request"),
            ChatMessage("assistant", "", workRun = newest),
        )
        val result = JSONObject(
            LocalBuildHistoryContract.query(
                messages,
                JSONObject().put("history_index", 1).put("max_events", 3).put("max_chars", 12),
            ),
        )
        assertTrue(result.getBoolean("ok"))
        assertEquals("new", result.getJSONObject("buildBlock").getString("runId"))
        assertEquals(3, result.getJSONObject("buildBlock").getJSONArray("publicActivities").length())
        assertTrue(result.getJSONObject("buildBlock").getJSONArray("publicActivities").getJSONObject(0).getString("content").length <= 100)
    }

    @Test
    fun unknownHistoryDoesNotLeakOrThrow() {
        val result = JSONObject(
            LocalBuildHistoryContract.query(
                listOf(ChatMessage("user", "only")),
                JSONObject().put("history_index", 1),
            ),
        )
        assertEquals(false, result.getBoolean("ok"))
        assertEquals(0, result.getInt("historyCount"))
    }
}
