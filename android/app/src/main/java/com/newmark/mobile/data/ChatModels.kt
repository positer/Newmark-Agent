package com.newmark.mobile.data

/** 一条对话消息 */
data class ChatMessage(
    val role: String, // "user" | "assistant" | "system" | "tool"
    val content: String = "",
    val timestamp: Long = System.currentTimeMillis(),
    /** 与 PC messageId 同义；旧 conversations.json 缺失时由 ViewModel 稳定补齐。 */
    val messageId: String = "",
    val toolCallId: String = "", // role == "tool" 时回传的 call id
    val toolCalls: List<ToolCall> = emptyList(), // role == "assistant" 时的工具调用
    val workRun: LocalWorkRun? = null, // assistant 消息附带的 build block（对齐 PC ConversationWorkRun）
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
) {
    val durationMs: Long get() = (if (endedAt > 0) endedAt else System.currentTimeMillis()) - startedAt
}

/** 本地对话任务清单；字段与桌面 ConversationPlanState.items 保持同构并随对话持久化。 */
data class LocalPlanItem(
    val id: String,
    val text: String,
    val status: String = "pending",
)

/** 本地对话（不区分工作区，持久化于本地 JSON） */
data class LocalConversation(
    val id: String,
    val title: String,
    val messages: List<ChatMessage> = emptyList(),
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val pinned: Boolean = false,
    val archived: Boolean = false,
    /** 本地模式的 task/plan 不是临时 UI 状态，必须随对应对话保存和恢复。 */
    val planItems: List<LocalPlanItem> = emptyList(),
    /** null 表示尚未产生分支；旧数据天然兼容并按单根页读取。 */
    val branchTree: LocalConversationBranchTree? = null,
)
