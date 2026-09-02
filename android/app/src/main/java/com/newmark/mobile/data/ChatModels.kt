package com.newmark.mobile.data

/** 一条对话消息 */
data class ChatMessage(
    val role: String, // "user" | "assistant" | "system" | "tool"
    val content: String = "",
    /**
     * Provider-native thinking state used only while continuing one live
     * request. It must be sent back as `reasoning_content`, never persisted
     * as conversation text or converted into a user-visible instruction.
     */
    @field:Transient
    val reasoningContent: String = "",
    val timestamp: Long = System.currentTimeMillis(),
    /** 与 PC messageId 同义；旧 conversations.json 缺失时由 ViewModel 稳定补齐。 */
    val messageId: String = "",
    val toolCallId: String = "", // role == "tool" 时回传的 call id
    val toolCalls: List<ToolCall> = emptyList(), // role == "assistant" 时的工具调用
    val workRun: LocalWorkRun? = null, // assistant 消息附带的 build block（对齐 PC ConversationWorkRun）
    val imageAttachments: List<LocalImageAttachment> = emptyList(),
)

/** Local user image attachment. Only bounded PNG/JPEG data URLs are accepted. */
data class LocalImageAttachment(
    val id: String = "",
    val name: String = "image",
    val mimeType: String = "image/png",
    val dataUrl: String = "",
    val width: Int = 0,
    val height: Int = 0,
)

/** 本地分支节点：保存该页完整可见消息快照；父节点构成与 PC ConversationTreeNode 相同的树路径。 */
data class LocalConversationBranchNode(
    val id: String,
    val parentId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val sourceMessageIndex: Int = 0,
    val sourceMessageId: String = "",
    val sourceText: String = "",
    val messages: List<ChatMessage> = emptyList(),
)

/** 同一历史用户消息产生的分页组，对齐 PC ConversationBranchGroupState。 */
data class LocalConversationBranchGroup(
    val id: String,
    val sourceNodeId: String,
    val sourceMessageIndex: Int,
    val sourceMessageId: String = "",
    val createdAt: Long = System.currentTimeMillis(),
    val nodeIds: List<String> = emptyList(),
)

/**
 * 本地分支树。activeNodeId 是后续发送所写入的运行页，viewedNodeId 是当前只读浏览页；
 * 两者分离复刻 PC “先预览分支，发送前再激活”的语义。
 */
data class LocalConversationBranchTree(
    val version: Int = 2,
    val rootNodeId: String,
    val activeNodeId: String,
    val viewedNodeId: String = activeNodeId,
    val activeGroupId: String = "",
    val nodes: Map<String, LocalConversationBranchNode> = emptyMap(),
    val branchGroups: Map<String, LocalConversationBranchGroup> = emptyMap(),
)

/** 一个工具调用（OpenAI function calling） */
data class ToolCall(
    val id: String,
    val name: String,
    val arguments: String,
)

/** 本地/远程统一后的 Guide 公开回执，等同桌面 GuideReceipt 的可显示字段。 */
data class WorkGuide(
    val clientMessageId: String = "",
    val guideId: String = "",
    val runId: String = "",
    val status: String = "accepted",
    val content: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val appliedAt: String = "",
    val reason: String = "",
    val attachments: List<WorkConversationImage> = emptyList(),
)

/** 引导消息及普通历史消息所附的用户图片。 */
data class WorkConversationImage(
    val id: String = "",
    val origin: String = "",
    val name: String = "",
    val mimeType: String = "",
    val dataUrl: String = "",
    val width: Int = 0,
    val height: Int = 0,
)

/** 本地/远程统一后的 Agent 展示图片；仅在投影层校验后渲染。 */
data class WorkDisplayImage(
    val id: String = "",
    val origin: String = "",
    val name: String = "",
    val caption: String = "",
    val mimeType: String = "",
    val dataUrl: String = "",
    val width: Int = 0,
    val height: Int = 0,
)

/**
 * 本地 agent 的一次工作事件（对齐 PC AgentWorkEvent）。
 * type: start / text / response / final_response / tool_call / tool_result /
 * thought / thought_result / status / done / error / interrupted /
 * force_interrupted / queue_update / guide。
 *
 * 字段刻意与桌面端 AgentWorkEvent 对齐：同一个 WorkRunProjection 同时
 * 消费本地与远程历史，避免两条渲染路径随时间分叉。旧 conversations.json
 * 没有这些字段时由默认值兼容。
 */
data class LocalWorkEvent(
    val type: String,
    val id: String = "",
    val content: String = "",
    val mode: String = "",
    val model: String = "",
    val toolCallId: String = "",
    val toolName: String = "",
    val toolArgs: String = "",
    val timestamp: Long = System.currentTimeMillis(),
    /** 原始 ISO 时间；远程事件排序须与 PC sequence → timestamp → id 规则一致。 */
    val timestampText: String = "",
    val sequence: Long = 0,
    val status: String = "",
    val clientMessageId: String = "",
    val guideId: String = "",
    val guide: WorkGuide? = null,
    val displayImage: WorkDisplayImage? = null,
    /** tool_result / thought_result 回填后的完成态，仅供公开历史投影使用。 */
    val completed: Boolean = false,
    val durationMs: Long = 0,
)

/**
 * 本地 agent 的一次运行 = 一个 build block（对齐 PC ConversationWorkRun）。
 * 内含事件序列：start → [thought → tool_call → tool_result]* → response → done。
 */
data class LocalWorkRun(
    val runId: String,
    val status: String = "running", // running / completed / error / interrupted
    val startedAt: Long = System.currentTimeMillis(),
    val endedAt: Long = 0,
    /** 与 PC ConversationWorkRun.expanded 同义；本地旧记录默认折叠。 */
    val expanded: Boolean = false,
    val events: List<LocalWorkEvent> = emptyList(),
    val mode: String = "",
    val model: String = "",
    val text: String = "", // 最终回复文本（response）
    /** 与 PC ConversationWorkRun 相同的历史定位身份；实时与持久块按这两个字段归并。 */
    val anchorMessageId: String = "",
    val branchNodeId: String = "",
) {
    val durationMs: Long get() = elapsedAt(System.currentTimeMillis())

    fun elapsedAt(nowMs: Long): Long =
        ((if (endedAt > 0) endedAt else nowMs) - startedAt).coerceAtLeast(0L)
}

/** 本地对话任务清单；字段与桌面 ConversationPlanState.items 保持同构并随对话持久化。 */
data class LocalPlanItem(
    val id: String,
    val text: String,
    val status: String = "pending",
)

data class LocalQueuedMessage(
    val id: String,
    val text: String,
    val createdAt: Long = System.currentTimeMillis(),
    val requestedMode: String = "build",
    val goalObjective: String = "",
)

/** PC contextCompression 的本地持久化投影；显示历史永远不被它改写。 */
data class LocalContextCompression(
    val id: String = "",
    val at: Long = 0L,
    val originalMessages: Int = 0,
    val compressedMessages: Int = 0,
    val originalChars: Int = 0,
    val compressedChars: Int = 0,
    val compressedTokens: Int = 0,
    val summary: String = "",
    val model: String = "",
    val fallback: Boolean = false,
)

/** 本地对话（不区分工作区，持久化于本地 JSON） */
data class LocalConversation(
    val id: String,
    val title: String,
    /** First user message whose title probe must succeed before the first formal Agent response. */
    val titleRequestMessageId: String = "",
    /** True only after a formal Agent response has been allowed to start for this conversation. */
    val firstAgentResponseStarted: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val pinned: Boolean = false,
    val archived: Boolean = false,
    /** 本地输入模式；新建对话默认 Chat，按对话持久化。 */
    val mode: String = "chat",
    /** 本地模式的 task/plan 不是临时 UI 状态，必须随对应对话保存和恢复。 */
    val planItems: List<LocalPlanItem> = emptyList(),
    /** PC Next panel 的本地对应物；队列及暂停状态严格按对话持久化。 */
    val queuedMessages: List<LocalQueuedMessage> = emptyList(),
    val queuePaused: Boolean = false,
    val inputMode: String = "next",
    /** 仅发送给模型的耐久上下文；空列表表示从完整显示历史首次建立。 */
    val modelContext: List<ChatMessage> = emptyList(),
    val contextCompression: LocalContextCompression? = null,
    /** 压缩历史只保存摘要元数据；原始显示历史永远保留在 messages。 */
    val compressionHistory: List<LocalContextCompression> = emptyList(),
    /** null 表示尚未产生分支；旧数据天然兼容并按单根页读取。 */
    val branchTree: LocalConversationBranchTree? = null,
)
