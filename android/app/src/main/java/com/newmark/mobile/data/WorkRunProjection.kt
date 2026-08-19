package com.newmark.mobile.data

/**
 * 移动端的 PC `renderWorkRunEvents` 等价投影。
 *
 * 这里不负责 Compose 样式，只把桌面端完整的公开事件历史化为稳定、可渲染的
 * 顺序：过滤私有推理，合并 text 流，回填 thought/tool 完成态，并将连续工具
 * 调用折叠。远程 API 快照与本地 Agent 均先转换为 [LocalWorkEvent]，因此必须
 * 只维护这一份语义。
 */
object WorkRunProjection {
    sealed interface Item {
        data class Narrative(val content: String, val incomplete: Boolean) : Item
        data class Thought(val event: LocalWorkEvent) : Item
        data class ToolGroup(val items: List<LocalWorkEvent>, val completed: Boolean) : Item
        data class Event(val event: LocalWorkEvent) : Item
        data class Guide(val event: LocalWorkEvent) : Item
    }

    private val publicTypes = setOf(
        "start", "text", "response", "final_response", "status", "tool_call", "tool_result",
        "thought", "thought_result", "guide", "guide_accepted", "guide_applied", "guide_deferred",
        "guide_rejected", "done", "error", "interrupted", "force_interrupted",
    )
    private val hiddenTypes = setOf("reasoning", "reasoning_content", "thinking", "thinking_delta")
    private val privateContent = Regex("</?think\\b|(?:reasoning_content|thinking_delta)\\s*[:：]", RegexOption.IGNORE_CASE)

    fun project(events: List<LocalWorkEvent>, runStatus: String): List<Item> {
        val terminalInterrupted = runStatus.lowercase() in setOf("interrupted", "force_interrupted")
        val rawEvents = dedupeGuideEvents(events
            .filter(::isPublic))
            .sortedWith(compareBy<LocalWorkEvent> { it.sequence }.thenBy { timestampSortKey(it) }.thenBy { it.id })
        val projected = mutableListOf<LocalWorkEvent>()
        var publicText = StringBuilder()

        fun flushPublicText() {
            val content = publicText.toString().trim().take(50_000)
            publicText = StringBuilder()
            if (content.isNotBlank()) {
                projected += LocalWorkEvent(
                    type = if (terminalInterrupted) "partial_text" else "public_text",
                    content = content,
                )
            }
        }

        rawEvents.forEach { source ->
            var event = source
            when (event.type.lowercase()) {
                "text" -> {
                    publicText.append(event.content)
                    return@forEach
                }

                "response" -> {
                    publicText = StringBuilder()
                    while (projected.lastOrNull()?.type?.lowercase() in setOf("public_text", "partial_text")) {
                        projected.removeLast()
                    }
                    projected += event
                    return@forEach
                }

                "final_response" -> {
                    // 终态正文在独立 Agent 消息中渲染；Build 内不能重复。
                    publicText = StringBuilder()
                    while (projected.lastOrNull()?.type?.lowercase() in setOf("public_text", "partial_text")) {
                        projected.removeLast()
                    }
                    return@forEach
                }
            }
            flushPublicText()
            when (event.type.lowercase()) {
                "tool_result" -> {
                    val index = projected.indexOfLast { prior ->
                        prior.type.equals("tool_call", ignoreCase = true) && !prior.completed &&
                            publicToolName(prior.toolName) == publicToolName(event.toolName) &&
                            (event.toolCallId.isBlank() || prior.toolCallId.isBlank() || event.toolCallId == prior.toolCallId)
                    }
                    if (index >= 0) {
                        val prior = projected[index]
                        projected[index] = prior.copy(
                            completed = true,
                            displayImage = event.displayImage ?: prior.displayImage,
                        )
                        return@forEach
                    }
                }

                "thought_result" -> {
                    val index = projected.indexOfLast { prior ->
                        prior.type.equals("thought", ignoreCase = true) && !prior.completed
                    }
                    if (index >= 0) {
                        val prior = projected[index]
                        projected[index] = prior.copy(completed = true, content = event.content.ifBlank { prior.content })
                        return@forEach
                    }
                }
            }
            projected += event
        }
        flushPublicText()

        val output = mutableListOf<Item>()
        var index = 0
        while (index < projected.size) {
            val event = projected[index]
            when {
                event.type.equals("tool_call", ignoreCase = true) -> {
                    val tools = mutableListOf(event)
                    index++
                    while (index < projected.size && projected[index].type.equals("tool_call", ignoreCase = true)) {
                        tools += projected[index]
                        index++
                    }
                    output += Item.ToolGroup(tools, tools.all { it.completed })
                }

                event.type.equals("thought", ignoreCase = true) -> {
                    output += Item.Thought(event)
                    index++
                }

                event.type.equals("guide", ignoreCase = true) || event.type.startsWith("guide_", ignoreCase = true) || event.guide != null -> {
                    output += Item.Guide(event)
                    index++
                }

                event.type.lowercase() in setOf("public_text", "partial_text", "response") -> {
                    output += Item.Narrative(event.content, event.type.equals("partial_text", ignoreCase = true))
                    index++
                }

                else -> {
                    output += Item.Event(event)
                    index++
                }
            }
        }
        return output
    }

    /** PC collapsed WorkRun keeps only intervening Guide user messages visible. */
    fun collapsedGuides(events: List<LocalWorkEvent>, runStatus: String): List<Item.Guide> =
        project(events, runStatus).filterIsInstance<Item.Guide>()

    fun isPublic(event: LocalWorkEvent): Boolean {
        val type = event.type.lowercase()
        if (type in hiddenTypes) return false
        if (type == "tool_call" || type == "tool_result") return true
        if (privateContent.containsMatchIn(event.content) || privateContent.containsMatchIn(event.toolArgs)) return false
        return type in publicTypes
    }

    fun publicToolName(value: String): String =
        value.lineSequence().firstOrNull()
            ?.replace(Regex("</?think\\b[^>]*>", RegexOption.IGNORE_CASE), "")
            ?.trim()
            ?.take(120)
            ?.ifBlank { "tool" }
            ?: "tool"

    private fun dedupeGuideEvents(events: List<LocalWorkEvent>): List<LocalWorkEvent> {
        val output = mutableListOf<LocalWorkEvent>()
        val indexes = mutableMapOf<String, Int>()
        events.forEach { event ->
            val key = event.guide?.clientMessageId
                ?.ifBlank { event.clientMessageId }
                ?.ifBlank { event.guide?.guideId ?: event.guideId }
                ?: event.clientMessageId.ifBlank { event.guideId }
            if (key.isBlank() || !(event.type.equals("guide", true) || event.type.startsWith("guide_", true) || event.guide != null)) {
                output += event
                return@forEach
            }
            val previousIndex = indexes[key]
            if (previousIndex == null) {
                indexes[key] = output.size
                output += event
                return@forEach
            }
            val previous = output[previousIndex]
            if (guideRank(event) >= guideRank(previous)) output[previousIndex] = event
        }
        return output
    }

    private fun guideRank(event: LocalWorkEvent): Int = when (
        event.guide?.status?.ifBlank { event.status }
            ?.ifBlank { event.type.removePrefix("guide_") }
            ?.lowercase()
    ) {
        "accepted" -> 1
        "deferred" -> 2
        "rejected" -> 3
        "applied" -> 4
        else -> 0
    }

    private fun timestampSortKey(event: LocalWorkEvent): String =
        event.timestampText.ifBlank { event.timestamp.toString().padStart(20, '0') }
}
