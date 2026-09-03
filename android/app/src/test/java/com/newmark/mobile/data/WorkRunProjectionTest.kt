package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkRunProjectionTest {
    @Test
    fun projectsDesktopPublicHistoryWithoutDroppingThoughtOrResponses() {
        val items = WorkRunProjection.project(
            listOf(
                event(1, "start", "开始"),
                event(2, "thought"),
                event(3, "thought_result", "先检查现有实现。"),
                event(4, "tool_call", toolCallId = "read-1", toolName = "read", toolArgs = "{\"path\":\"README.md\"}"),
                event(5, "tool_result", toolCallId = "read-1", toolName = "read", content = "private tool output"),
                event(6, "text", "草稿 A"),
                event(7, "text", "草稿 B"),
                event(8, "response", "第一段公开回复"),
                event(9, "tool_call", toolCallId = "edit-1", toolName = "edit"),
                event(10, "tool_result", toolCallId = "edit-1", toolName = "edit"),
                event(11, "response", "第二段公开回复"),
                event(12, "final_response", "最终正文只在独立聊天消息出现"),
                event(13, "done", "完成"),
            ),
            runStatus = "completed",
        )

        val thought = items.filterIsInstance<WorkRunProjection.Item.Thought>().single().event
        assertTrue(thought.completed)
        assertEquals("先检查现有实现。", thought.content)

        val tools = items.filterIsInstance<WorkRunProjection.Item.ToolGroup>()
        assertEquals(2, tools.size)
        assertTrue(tools.all { it.completed })
        assertTrue(tools.all { group -> group.items.all { it.completed } })

        val narratives = items.filterIsInstance<WorkRunProjection.Item.Narrative>()
        assertEquals(listOf("第一段公开回复", "第二段公开回复"), narratives.map { it.content })
        assertFalse(narratives.any { it.content.contains("草稿") || it.content.contains("最终正文") })
        assertTrue(items.filterIsInstance<WorkRunProjection.Item.Event>().any { it.event.type == "done" })
    }

    @Test
    fun completesEmptyThoughtShellAndCarriesProviderDuration() {
        val items = WorkRunProjection.project(
            listOf(
                event(1, "thought"),
                event(2, "thought_result").copy(durationMs = 420L),
            ),
            runStatus = "running",
        )

        val thought = items.filterIsInstance<WorkRunProjection.Item.Thought>().single().event
        assertTrue(thought.completed)
        assertEquals("", thought.content)
        assertEquals(420L, thought.durationMs)
    }

    @Test
    fun streamsThoughtDeltasIntoTheRunningThoughtItem() {
        val items = WorkRunProjection.project(
            listOf(
                event(1, "thought"),
                event(2, "thought_delta", "先检查"),
                event(3, "thought_delta", "供应商身份。"),
            ),
            runStatus = "running",
        )

        val thought = items.filterIsInstance<WorkRunProjection.Item.Thought>().single().event
        assertFalse(thought.completed)
        assertEquals("先检查供应商身份。", thought.content)
    }

    @Test
    fun runningDurationUsesSuppliedClockAndCompletedDurationIsFrozen() {
        val running = LocalWorkRun(runId = "run", startedAt = 1_000L)
        assertEquals(2_500L, running.elapsedAt(3_500L))

        val completed = running.copy(endedAt = 2_200L, status = "completed")
        assertEquals(1_200L, completed.elapsedAt(99_000L))
    }

    @Test
    fun hidesPrivateReasoningButKeepsPublicTools() {
        val items = WorkRunProjection.project(
            listOf(
                event(1, "reasoning", "private"),
                event(2, "thinking_delta", "private"),
                event(3, "status", "<think>private</think>"),
                event(4, "response", "reasoning_content: private"),
                event(5, "tool_call", toolName = "read", toolArgs = "reasoning_content: private"),
                event(6, "tool_result", toolName = "read"),
                event(7, "response", "公开结论"),
            ),
            runStatus = "completed",
        )

        assertEquals(listOf("公开结论"), items.filterIsInstance<WorkRunProjection.Item.Narrative>().map { it.content })
        assertEquals(1, items.filterIsInstance<WorkRunProjection.Item.ToolGroup>().size)
        assertFalse(items.filterIsInstance<WorkRunProjection.Item.Event>().any { it.event.content.contains("private") })
    }

    @Test
    fun preservesInterruptedTextAsExplicitPartialAndUpgradesGuideLifecycle() {
        val items = WorkRunProjection.project(
            listOf(
                event(1, "guide_accepted", "旧状态", clientMessageId = "guide-1", status = "accepted"),
                event(2, "guide_applied", "最新状态", clientMessageId = "guide-1", status = "applied"),
                event(3, "text", "尚未完成的公开正文"),
                event(4, "interrupted", "已停止"),
            ),
            runStatus = "interrupted",
        )

        val guide = items.filterIsInstance<WorkRunProjection.Item.Guide>().single().event
        assertEquals("applied", guide.status)
        assertEquals("最新状态", guide.content)
        val narrative = items.filterIsInstance<WorkRunProjection.Item.Narrative>().single()
        assertTrue(narrative.incomplete)
        assertEquals("尚未完成的公开正文", narrative.content)
    }

    @Test
    fun insertsGuideAtItsWorkSequenceAndKeepsItVisibleWhenCollapsed() {
        val events = listOf(
            event(1, "thought", "先处理第一步"),
            event(2, "guide_accepted", "请优先检查移动端", clientMessageId = "guide-1", status = "accepted"),
            event(3, "tool_call", toolCallId = "read-1", toolName = "read"),
            event(4, "tool_result", toolCallId = "read-1", toolName = "read"),
            event(5, "guide_applied", "请优先检查移动端", clientMessageId = "guide-1", status = "applied"),
            event(6, "response", "已按 Guide 继续"),
        )

        val expanded = WorkRunProjection.project(events, runStatus = "completed")
        val guideIndex = expanded.indexOfFirst { it is WorkRunProjection.Item.Guide }
        val responseIndex = expanded.indexOfFirst { it is WorkRunProjection.Item.Narrative }
        assertTrue(guideIndex >= 0)
        assertTrue(guideIndex < responseIndex)

        val collapsed = WorkRunProjection.collapsedGuides(events, runStatus = "completed")
        assertEquals(1, collapsed.size)
        assertEquals("guide-1", collapsed.single().event.clientMessageId)
        assertEquals("applied", collapsed.single().event.status)
        assertEquals("请优先检查移动端", collapsed.single().event.content)
    }

    @Test
    fun displayedImagesFollowAgentPresentationOrderForFinalReply() {
        val second = WorkDisplayImage(
            id = "second",
            origin = "agent",
            name = "second.png",
            caption = "第二张",
            mimeType = "image/png",
            dataUrl = "data:image/png;base64,Ag==",
        )
        val first = WorkDisplayImage(
            id = "first",
            origin = "agent",
            name = "first.png",
            caption = "第一张",
            mimeType = "image/png",
            dataUrl = "data:image/png;base64,AQ==",
        )
        val events = listOf(
            event(20, "tool_result", toolName = "image_display", displayImage = second),
            event(10, "tool_result", toolName = "image_display", displayImage = first),
            event(30, "final_response", content = "最终回复"),
        )

        assertEquals(
            listOf("first", "second"),
            WorkRunProjection.displayedImages(events).map { it.id },
        )
    }

    private fun event(
        sequence: Long,
        type: String,
        content: String = "",
        toolCallId: String = "",
        toolName: String = "",
        toolArgs: String = "",
        clientMessageId: String = "",
        status: String = "",
        displayImage: WorkDisplayImage? = null,
    ) = LocalWorkEvent(
        id = "$sequence:$type",
        type = type,
        content = content,
        toolCallId = toolCallId,
        toolName = toolName,
        toolArgs = toolArgs,
        timestamp = sequence,
        sequence = sequence,
        clientMessageId = clientMessageId,
        status = status,
        displayImage = displayImage,
    )
}
