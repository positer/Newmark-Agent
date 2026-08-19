package com.newmark.mobile.ui

import com.newmark.mobile.data.RemoteWorkEvent
import com.newmark.mobile.data.RemoteWorkGuide
import com.newmark.mobile.data.RemoteWorkRun
import com.newmark.mobile.data.WorkRunProjection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteGuideTimelineContractTest {
    @Test
    fun remoteGuideReceiptReachesTheSharedUserTimelineProjection() {
        val run = remoteRunToLocal(
            RemoteWorkRun(
                runId = "remote-run",
                status = "running",
                startedAt = "2026-08-19T09:00:00Z",
                events = listOf(
                    RemoteWorkEvent(
                        id = "remote-guide-accepted",
                        type = "guide_accepted",
                        runId = "remote-run",
                        sequence = 2,
                        timestamp = "2026-08-19T09:00:02Z",
                        clientMessageId = "remote-guide",
                        guideId = "guide-node",
                        guide = RemoteWorkGuide(
                            clientMessageId = "remote-guide",
                            guideId = "guide-node",
                            runId = "remote-run",
                            status = "accepted",
                            content = "远端 Guide 内容",
                            createdAt = "2026-08-19T09:00:02Z",
                        ),
                    ),
                ),
                guides = listOf(
                    RemoteWorkGuide(
                        clientMessageId = "remote-guide",
                        guideId = "guide-node",
                        runId = "remote-run",
                        status = "applied",
                        content = "远端 Guide 内容",
                        createdAt = "2026-08-19T09:00:02Z",
                        updatedAt = "2026-08-19T09:00:03Z",
                        appliedAt = "2026-08-19T09:00:03Z",
                    ),
                ),
            ),
        )

        val expanded = WorkRunProjection.project(run.events, run.status)
        val guide = expanded.filterIsInstance<WorkRunProjection.Item.Guide>().single()
        assertEquals("remote-guide", guide.event.clientMessageId)
        assertEquals("applied", guide.event.guide?.status)
        assertEquals("远端 Guide 内容", guide.event.content)

        val collapsed = WorkRunProjection.collapsedGuides(run.events, run.status)
        assertEquals(1, collapsed.size)
        assertTrue(collapsed.single().event.guide?.appliedAt?.isNotBlank() == true)
    }
}
