package com.newmark.mobile.data

import com.google.gson.Gson
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteTrackingContractTest {
    @Test
    fun hostedUiSnapshotKeepsGoalFlowQueueRuntimeMessagesAndRunsTogether() {
        val parsed = Gson().fromJson(
            """{
              "goal":{"objective":"ship it","paused":false},
              "flow":{"running":true,"paused":false,"name":"release","promptText":"keep going"},
              "queueItems":[{"id":"next-1","text":"after this"}],
              "runtime":{"running":true,"runId":"run-live"},
              "chatMessages":[{"messageId":"message-live","role":"user","content":"start","runId":"run-live"}],
              "workRuns":[{"runId":"run-live","status":"running","anchorMessageId":"message-live"}]
            }""".trimIndent(),
            RemoteConversationUiState::class.java,
        )

        assertTrue(parsed.goal?.objective == "ship it")
        assertTrue(parsed.flow?.running == true)
        assertTrue(parsed.queueItems.single().id == "next-1")
        assertTrue(parsed.runtime?.runId == "run-live")
        assertTrue(parsed.chatMessages?.single()?.id == "message-live")
        assertTrue(parsed.workRuns?.single()?.status == "running")
    }

    @Test
    fun legacyHostedSnapshotNormalizesEveryOmittedRemoteStringBeforeStrictUiUse() {
        val raw = Gson().fromJson(
            """{
              "goal":{},
              "flowSelection":{},
              "flow":{"running":true},
              "queued":{"followUp":["legacy next"]},
              "queueItems":[{"id":"next-1","text":"after this"}],
              "runtime":{"running":true},
              "chatMessages":[{"messageId":"message-live"}],
              "workRuns":[{"runId":"run-live","events":[{"type":"tool_call"}],"guides":[{}]}]
            }""".trimIndent(),
            RemoteConversationUiState::class.java,
        )

        val parsed = RemotePayloadNormalizer.conversationUiState(raw)

        assertTrue(parsed.goal?.objective.orEmpty().isEmpty())
        assertTrue(parsed.flowSelection?.name.orEmpty().isEmpty())
        assertTrue(parsed.flow?.promptText.orEmpty().isEmpty())
        assertTrue(parsed.queued.followUp.single() == "legacy next")
        assertTrue(parsed.queueItems.single().requestedMode == "build")
        assertTrue(parsed.queueItems.single().goalObjective.isEmpty())
        assertTrue(parsed.runtime?.runId.orEmpty().isEmpty())
        assertTrue(parsed.chatMessages?.single()?.role == "assistant")
        assertTrue(parsed.workRuns?.single()?.events?.single()?.toolCallId.orEmpty().isEmpty())
        assertTrue(parsed.workRuns?.single()?.guides?.single()?.status == "accepted")

        // These strict constructors reproduce the Release/R8 crash sites if a
        // runtime null escaped the authenticated remote boundary.
        val queue = parsed.queueItems.single()
        LocalQueuedMessage(queue.id, queue.text, requestedMode = queue.requestedMode, goalObjective = queue.goalObjective)
        val event = parsed.workRuns!!.single().events.single()
        LocalWorkEvent(event.type, mode = event.mode, toolCallId = event.toolCallId, toolName = event.toolName)
    }

    @Test
    fun legacyConversationWithoutRuntimeStatusRemainsSafeForReleaseNormalization() {
        val parsed = Gson().fromJson(
            """{"id":"chat-a","title":"legacy","active":true}""",
            RemoteConversation::class.java,
        )

        assertTrue(parsed.runtimeStatus.orEmpty().isEmpty())
        assertTrue(parsed.copy(running = false).runtimeStatus.orEmpty().isEmpty())
    }

    @Test
    fun targetMatchRequiresExactWorkspaceAndConversation() {
        assertTrue(RemoteTrackingContract.matchesTarget("ws-a", "chat-a", "ws-a", "chat-a"))
        assertFalse(RemoteTrackingContract.matchesTarget("ws-a", "chat-a", "ws-b", "chat-a"))
        assertFalse(RemoteTrackingContract.matchesTarget("ws-a", "chat-a", "ws-a", "chat-b"))
        assertFalse(RemoteTrackingContract.matchesTarget("ws-a", "chat-a", "", "chat-a"))
        assertFalse(RemoteTrackingContract.matchesTarget(null, "chat-a", "ws-a", "chat-a"))
    }

    @Test
    fun liveEventRequiresExactTargetAndRunIdentity() {
        val exact = RemoteWorkEvent(
            id = "event-1",
            workspaceId = "ws-a",
            conversationId = "chat-a",
            runId = "run-a",
            type = "text",
        )
        assertTrue(RemoteTrackingContract.acceptsLiveEvent("ws-a", "chat-a", exact))
        assertFalse(RemoteTrackingContract.acceptsLiveEvent("ws-a", "chat-b", exact))
        assertFalse(RemoteTrackingContract.acceptsLiveEvent("ws-b", "chat-a", exact))
        assertFalse(RemoteTrackingContract.acceptsLiveEvent("ws-a", "chat-a", exact.copy(runId = "")))
    }

    @Test
    fun blankRunNeverAliasesAnExistingRun() {
        assertTrue(RemoteTrackingContract.sameRun("run-a", "run-a"))
        assertFalse(RemoteTrackingContract.sameRun("run-a", "run-b"))
        assertFalse(RemoteTrackingContract.sameRun("run-a", ""))
        assertFalse(RemoteTrackingContract.sameRun("", ""))
    }

    @Test
    fun completedRunRejectsDelayedRunningEventUnlessResidentRuntimeExplicitlyReopensIt() {
        assertFalse(
            RemoteTrackingContract.acceptsNonTerminalRunEvent(
                eventRunId = "run-complete",
                liveRunStatus = null,
                durableRunStatus = "completed",
                authoritativeRunningRunId = "",
            ),
        )
        assertFalse(
            RemoteTrackingContract.acceptsNonTerminalRunEvent(
                eventRunId = "run-complete",
                liveRunStatus = "completed",
                durableRunStatus = null,
                authoritativeRunningRunId = "",
            ),
        )
        assertTrue(
            RemoteTrackingContract.acceptsNonTerminalRunEvent(
                eventRunId = "run-complete",
                liveRunStatus = null,
                durableRunStatus = "interrupted",
                authoritativeRunningRunId = "run-complete",
            ),
        )
    }

    @Test
    fun unseenOrStillRunningRunAcceptsLiveEvents() {
        assertTrue(RemoteTrackingContract.acceptsNonTerminalRunEvent("run-new", null, null, ""))
        assertTrue(RemoteTrackingContract.acceptsNonTerminalRunEvent("run-live", "running", "running", ""))
    }

    @Test
    fun durableRunReplacesProvisionalRunWithoutCreatingAForegroundDuplicate() {
        val durable = RemoteWorkRun(runId = "run-a", anchorMessageId = "message-old", status = "completed")
        val provisional = RemoteWorkRun(runId = "run-a", anchorMessageId = "message-old", status = "running")
        val reconciled = RemoteTrackingContract.visibleRuns(listOf(durable), provisional)
        assertTrue(reconciled.size == 1)
        assertTrue(reconciled.single().runId == durable.runId)
        val newLive = RemoteWorkRun(runId = "run-b", anchorMessageId = "message-current", status = "running")
        val visible = RemoteTrackingContract.visibleRuns(listOf(durable), newLive)
        assertTrue(visible.map { it.runId } == listOf("run-a", "run-b"))
        assertTrue(visible.last().anchorMessageId == "message-current")
    }

    @Test
    fun residentRunningRunOverridesAColdInterruptedCopyAndKeepsBothEventStreams() {
        val cold = RemoteWorkRun(
            runId = "run-live",
            status = "interrupted",
            anchorMessageId = "message-live",
            events = listOf(RemoteWorkEvent(id = "persisted-start", runId = "run-live", type = "start")),
        )
        val resident = RemoteWorkRun(
            runId = "run-live",
            status = "running",
            events = listOf(RemoteWorkEvent(id = "live-text", runId = "run-live", type = "text", content = "delta")),
        )

        val visible = RemoteTrackingContract.visibleRuns(listOf(cold), resident, "run-live")

        assertTrue(visible.size == 1)
        assertTrue(visible.single().status == "running")
        assertTrue(visible.single().anchorMessageId == "message-live")
        assertTrue(visible.single().events.map { it.id } == listOf("persisted-start", "live-text"))
    }

    @Test
    fun legacyHistoricalRunIsEmittedBeforeTheNextOwnedRunInsteadOfAtTheFrontier() {
        val historical = RemoteWorkRun(runId = "run-old", startedAt = "2026-08-18T01:00:00Z")
        val current = RemoteWorkRun(runId = "run-current", startedAt = "2026-08-18T02:00:00Z")

        val beforeCurrent = RemoteTrackingContract.unownedRunsBefore(
            owningRunId = "run-current",
            runs = listOf(historical, current),
            messageOwnedRunIds = setOf("run-current"),
            visibleMessageIds = setOf("message-current"),
            alreadyRenderedRunIds = emptySet(),
        )

        assertTrue(beforeCurrent.map { it.runId } == listOf("run-old"))
    }

    @Test
    fun explicitlyAnchoredRunWaitsForItsMessageAndIsNotTreatedAsLegacyOrphan() {
        val anchored = RemoteWorkRun(runId = "run-old", anchorMessageId = "message-old")
        val current = RemoteWorkRun(runId = "run-current")

        val beforeCurrent = RemoteTrackingContract.unownedRunsBefore(
            owningRunId = "run-current",
            runs = listOf(anchored, current),
            messageOwnedRunIds = setOf("run-current"),
            visibleMessageIds = setOf("message-old", "message-current"),
            alreadyRenderedRunIds = emptySet(),
        )

        assertTrue(beforeCurrent.isEmpty())
    }
}
