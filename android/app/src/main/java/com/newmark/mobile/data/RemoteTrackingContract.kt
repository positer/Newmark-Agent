package com.newmark.mobile.data

/**
 * Pure identity contract for remote conversation state.
 *
 * Remote UI state may only be committed when both workspace and conversation
 * still match the target that initiated the request. Live work events require
 * the same exact target plus a non-empty run identity; missing identity is not
 * treated as a wildcard because that can leak delayed events across chats.
 */
internal object RemoteTrackingContract {
    private val terminalRunStatuses = setOf(
        "completed",
        "done",
        "error",
        "interrupted",
        "force_interrupted",
        "stopped",
    )

    fun matchesTarget(
        expectedWorkspaceId: String?,
        expectedConversationId: String?,
        actualWorkspaceId: String?,
        actualConversationId: String?,
    ): Boolean {
        val expectedWorkspace = expectedWorkspaceId.orEmpty()
        val expectedConversation = expectedConversationId.orEmpty()
        return expectedWorkspace.isNotBlank() && expectedConversation.isNotBlank() &&
            actualWorkspaceId.orEmpty() == expectedWorkspace &&
            actualConversationId.orEmpty() == expectedConversation
    }

    fun acceptsLiveEvent(
        selectedWorkspaceId: String?,
        selectedConversationId: String?,
        event: RemoteWorkEvent,
    ): Boolean = event.runId.isNotBlank() && matchesTarget(
        selectedWorkspaceId,
        selectedConversationId,
        event.workspaceId,
        event.conversationId,
    )

    fun sameRun(currentRunId: String, eventRunId: String): Boolean =
        currentRunId.isNotBlank() && eventRunId.isNotBlank() && currentRunId == eventRunId

    /**
     * A delayed non-terminal SSE event must never resurrect a run that either
     * the live reducer or durable PC history has already closed. The sole
     * exception is an exact resident runtime declaration from the PC: during
     * recovery its authoritative running identity intentionally overrides a
     * cold interrupted snapshot.
     */
    fun acceptsNonTerminalRunEvent(
        eventRunId: String,
        liveRunStatus: String?,
        durableRunStatus: String?,
        authoritativeRunningRunId: String,
    ): Boolean {
        if (eventRunId.isBlank()) return false
        if (sameRun(authoritativeRunningRunId, eventRunId)) return true
        return liveRunStatus.orEmpty().lowercase() !in terminalRunStatuses &&
            durableRunStatus.orEmpty().lowercase() !in terminalRunStatuses
    }

    /**
     * Durable history is normally authoritative. The only exception is an
     * exact run that the resident PC runtime currently declares running: that
     * live copy must override a cold-reader `interrupted` recovery and merge
     * its newer SSE events until the next resident snapshot arrives.
     */
    fun visibleRuns(
        durable: List<RemoteWorkRun>,
        live: RemoteWorkRun?,
        authoritativeRunningRunId: String = "",
    ): List<RemoteWorkRun> {
        if (live == null || live.runId.isBlank()) return durable
        val matchedIndex = durable.indexOfFirst { sameRun(it.runId, live.runId) }
        if (matchedIndex < 0) return durable + live
        val persisted = durable[matchedIndex]
        if (!sameRun(authoritativeRunningRunId, live.runId)) return durable
        val mergedEvents = (persisted.events + live.events).fold(mutableListOf<RemoteWorkEvent>()) { output, event ->
            val duplicate = output.any { existing ->
                event.id.isNotBlank() && existing.id == event.id ||
                    (event.id.isBlank() && existing.id.isBlank() && existing.sequence == event.sequence &&
                        existing.type == event.type && existing.timestamp == event.timestamp)
            }
            if (!duplicate) output += event
            output
        }
        val merged = persisted.copy(
            status = live.status.ifBlank { persisted.status },
            startedAt = persisted.startedAt.ifBlank { live.startedAt },
            endedAt = live.endedAt.ifBlank { persisted.endedAt },
            expanded = live.expanded || persisted.expanded,
            sequence = maxOf(persisted.sequence, live.sequence),
            events = mergedEvents,
            guides = (persisted.guides + live.guides).distinctBy { it.clientMessageId.ifBlank { it.guideId } },
            primaryPrompt = persisted.primaryPrompt.ifBlank { live.primaryPrompt },
            branchNodeId = persisted.branchNodeId.ifBlank { live.branchNodeId },
            anchorMessageId = persisted.anchorMessageId.ifBlank { live.anchorMessageId },
        )
        return durable.toMutableList().also { it[matchedIndex] = merged }
    }

    /**
     * Mirrors the desktop `renderOrphanRunsBefore` rule.
     *
     * A legacy WorkRun can predate message/run anchoring and therefore have
     * neither an anchorMessageId nor a chat message carrying its runId. Such a
     * run must retain its position in the authoritative WorkRun ledger: when a
     * later owned run is reached, all earlier unowned runs are emitted first.
     * Appending every unowned run at the transcript frontier would turn old
     * history into apparently live work after reconnect/window hydration.
     */
    fun unownedRunsBefore(
        owningRunId: String,
        runs: List<RemoteWorkRun>,
        messageOwnedRunIds: Set<String>,
        visibleMessageIds: Set<String>,
        alreadyRenderedRunIds: Set<String>,
    ): List<RemoteWorkRun> {
        val targetIndex = runs.indexOfFirst { sameRun(it.runId, owningRunId) }
        if (targetIndex <= 0) return emptyList()
        return runs.subList(0, targetIndex).filter { run ->
            run.runId.isNotBlank() &&
                run.runId !in alreadyRenderedRunIds &&
                run.runId !in messageOwnedRunIds &&
                (run.anchorMessageId.isBlank() || run.anchorMessageId !in visibleMessageIds)
        }
    }
}
