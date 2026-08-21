package com.newmark.mobile.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileToolPressureContractTest {
    @Test
    fun everyBuildToolHasSchemaAndExecutorRouteOrRuntimeBridge() {
        val executor = java.io.File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        val viewModel = java.io.File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val definitions = LocalTools.definitions.mapNotNull { it.optJSONObject("function")?.optString("name") }.toSet()
        assertEquals(LocalToolCatalog.buildNames, definitions)
        LocalToolCatalog.buildNames.forEach { name ->
            val routed = executor.contains("\"$name\"") || viewModel.contains("\"$name\"")
            assertTrue("missing runtime route for $name", routed)
        }
    }

    @Test
    fun repeatedContextAndHistoryQueriesRemainBounded() {
        val run = LocalWorkRun(
            runId = "stress",
            startedAt = 1L,
            events = List(10_000) { LocalWorkEvent(type = "tool_result", sequence = it.toLong(), content = "result-".repeat(100)) },
        )
        val messages = listOf(ChatMessage("user", "stress"), ChatMessage("assistant", "", workRun = run))
        repeat(200) {
            val json = JSONObject(
                LocalBuildHistoryContract.query(
                    messages,
                    JSONObject().put("history_index", 1).put("max_events", 20).put("max_chars", 200),
                ),
            )
            assertEquals(20, json.getJSONObject("buildBlock").getJSONArray("publicActivities").length())
            assertTrue(json.toString().length < 20_000)
        }
    }
}
