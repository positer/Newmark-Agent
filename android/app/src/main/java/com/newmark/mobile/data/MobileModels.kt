package com.newmark.mobile.data

import com.google.gson.annotations.SerializedName
import kotlin.jvm.Transient

/** 与桌面端的配对信息（Tailscale 内网，绑定一次保存） */
data class PairInfo(
    val host: String,
    val port: Int = 47890,
    val token: String,
    val name: String = "", // 设备名（桌面端 hostname）
) {
    val baseUrl: String get() = "http://$host:$port"
    fun isValid(): Boolean = host.isNotBlank() && token.isNotBlank()

    /** 侧边栏/列表显示：优先设备名，缺省用 IP（name 兼容旧数据可能为 null） */
    val displayName: String get() = name.orEmpty().ifBlank { host }

    /** 去重键：IP（同一设备重复绑定整合为一条；名称由 hello hostname 回填更新） */
    val dedupeKey: String get() = host
}

/** 扫码/粘贴得到的配对邀请（含窗口期 pairingId，需确认后换长期 token 保存） */
data class PairInvite(
    val host: String,
    val port: Int,
    val token: String,
    val pairingId: String,
) {
    companion object {
        /**
         * 解析桌面端二维码：newmark-pair://host:port?token=…&pairingId=…&host=…&expiresAt=…
         * 兼容 http://host:port/?token=… 手动粘贴形式。
         */
        fun fromUrl(url: String): PairInvite? {
            return runCatching {
                val u = if (url.contains("://")) url else "http://$url"
                val parsed = java.net.URI(u)
                val host = parsed.host ?: return null
                val port = if (parsed.port > 0) parsed.port else 47890
                val q = parsed.query ?: return null

                fun param(name: String): String {
                    q.split('&').forEach { kv ->
                        val parts = kv.split('=', limit = 2)
                        if (parts.size == 2 && parts[0] == name) return parts[1]
                    }
                    return ""
                }

                val token = param("token")
                val pairingId = param("pairingId")
                if (token.isBlank()) return null
                PairInvite(host = host, port = port, token = token, pairingId = pairingId)
            }.getOrNull()
        }
    }
}

/** 桌面端对话列表项（listConversationStates） */
data class RemoteConversation(
    val id: String = "",
    val title: String = "",
    val messageCount: Int = 0,
    val historyCount: Int = 0,
    val updatedAt: String = "",
    val pinned: Boolean = false,
    val branchCommunication: Boolean = false,
    val active: Boolean = false,
    // Optional on older desktop/mobile state responses. Gson may allocate a
    // Kotlin data class without invoking its default constructor, so an absent
    // non-null String becomes a runtime null under optimized Release builds.
    val runtimeStatus: String? = null,
    val running: Boolean = false, // 工作状态（移动端按 activeConversationId + agent.status 维护）
)

/** 桌面端工作区（workspaces.internal/external 元素） */
data class WorkspaceInfo(
    val id: String = "",
    val name: String = "",
    val path: String = "",
    val isInternal: Boolean = false,
)

/** 桌面端对话消息（chatMessages 元素，与 GUI 渲染契约一致；PC 消息 id 字段名为 messageId） */
data class RemoteMessage(
    @SerializedName(value = "messageId", alternate = ["id"]) val id: String = "",
    val role: String = "assistant", // user | assistant | system | workflow
    val content: String = "",
    val mode: String = "",
    val model: String = "",
    val timestamp: String = "",
    val guideId: String = "",
    val clientMessageId: String = "",
    val runId: String = "",
    val branchNodeId: String = "",
    val attachments: List<RemoteConversationImage> = emptyList(),
)

/** PC ChatMessage.attachments 的移动端公开投影（历史用户图片）。 */
data class RemoteConversationImage(
    val id: String = "",
    val origin: String = "",
    val name: String = "",
    val mimeType: String = "",
    val dataUrl: String = "",
    val width: Int = 0,
    val height: Int = 0,
)

/** PC 规范化分支页元数据；移动端只消费，不自行解析树。 */
data class RemoteBranch(
    val id: String = "",
    val createdAt: String = "",
    val sourceMessageIndex: Int = -1,
    val sourceMessageId: String = "",
    val sourceGuideId: String = "",
    val sourceText: String = "",
)

/** 当前浏览路径上的一个分页组，对齐 ConversationBranchGroupSnapshot。 */
data class RemoteBranchGroup(
    val id: String = "",
    val sourceMessageIndex: Int = -1,
    val sourceMessageId: String = "",
    val sourceGuideId: String = "",
    val activeBranchId: String = "",
    val branches: List<RemoteBranch> = emptyList(),
)

/** 工作事件（tokens / SSE work event），渲染工具调用、思考等块 */
data class WorkEvent(
    val type: String = "",
    val text: String = "",
    val content: String = "",
    val toolName: String = "",
    val toolArgs: String = "",
) {
    val displayText: String get() = content.ifBlank { text }
}

/** 桌面端 work run 事件（AgentWorkEvent，SSE 与快照同构） */
data class RemoteWorkEvent(
    val id: String = "",
    val conversationId: String = "",
    val type: String = "",
    val content: String = "",
    val mode: String = "",
    val model: String = "",
    val toolCallId: String = "",
    val toolName: String = "",
    val toolArgs: String = "",
    val timestamp: String = "",
    val workspaceId: String = "",
    val workspaceKey: String = "",
    val runtimeKey: String = "",
    val runId: String = "",
    val branchNodeId: String = "",
    val anchorMessageId: String = "",
    val actorId: String = "",
    val generation: Long = 0,
    val sequence: Long = 0,
    val status: String = "",
    val clientMessageId: String = "",
    val guideId: String = "",
    val guide: RemoteWorkGuide? = null,
    val displayImage: RemoteWorkDisplayImage? = null,
    /** 桌面端结构化模型回退信号：from=回退前模型名，to=实际生效模型名。 */
    val fallback: RemoteModelFallback? = null,
)

/** 桌面端 AgentWorkEvent.fallback 的移动端投影。 */
data class RemoteModelFallback(
    val from: String = "",
    val to: String = "",
    val providerId: String = "",
)

/** Guide 生命周期的公开载荷；字段与桌面 GuideReceipt 同构。 */
data class RemoteWorkGuide(
    val clientMessageId: String = "",
    val guideId: String = "",
    val runId: String = "",
    val status: String = "accepted",
    val content: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val appliedAt: String = "",
    val reason: String = "",
    val attachments: List<RemoteConversationImage> = emptyList(),
)

/** Build 内由 Agent 明确展示的图片（仅允许 agent/png/jpeg/dataUrl）。 */
data class RemoteWorkDisplayImage(
    val id: String = "",
    val origin: String = "",
    val name: String = "",
    val caption: String = "",
    val mimeType: String = "",
    val dataUrl: String = "",
    val width: Int = 0,
    val height: Int = 0,
)

/** 桌面端 work run（ConversationWorkRun；含 interrupted/force_interrupted 被中断状态） */
data class RemoteWorkRun(
    val runId: String = "",
    val status: String = "",
    val startedAt: String = "",
    val endedAt: String = "",
    val expanded: Boolean = false,
    val sequence: Long = 0,
    val events: List<RemoteWorkEvent> = emptyList(),
    val guides: List<RemoteWorkGuide> = emptyList(),
    val primaryPrompt: String = "",
    val branchNodeId: String = "",
    val anchorMessageId: String = "",
)

/** 桌面端 Goal 状态（GoalState 序列化：objective/paused/verified/goalRounds） */
data class RemoteGoal(
    val objective: String = "",
    val paused: Boolean = false,
    val verified: Boolean = false,
    val goalRounds: Int = 0,
)

/** 桌面端 Flow 选择（ConversationFlowSelection 简化） */
data class RemoteFlowSelection(
    val name: String = "",
    val componentId: Int = 0,
    val componentType: String = "",
)

data class RemoteConversationQueue(
    val steering: List<String> = emptyList(),
    val followUp: List<String> = emptyList(),
)

data class RemoteQueueItem(
    val id: String = "",
    val text: String = "",
    val queueMode: String = "followUp",
    val requestedMode: String = "build",
    val goalObjective: String = "",
    val runId: String = "",
    val createdAt: String = "",
)

data class RemoteFlowTakeover(
    val running: Boolean = false,
    val paused: Boolean = false,
    val name: String = "",
    val promptText: String = "",
    val message: String = "",
    val reason: String = "",
)

data class RemoteRuntimeState(
    val running: Boolean = false,
    val stopRequested: Boolean = false,
    val status: String = "",
    val runId: String = "",
)

data class RemoteConversationUiState(
    val goal: RemoteGoal? = null,
    val flowSelection: RemoteFlowSelection? = null,
    val flow: RemoteFlowTakeover? = null,
    val queued: RemoteConversationQueue = RemoteConversationQueue(),
    val queueItems: List<RemoteQueueItem> = emptyList(),
    val queuePaused: Boolean = false,
    val runtime: RemoteRuntimeState? = null,
    val mode: String = "build",
    val status: String = "idle",
    val inputMode: String = "guide",
    /**
     * GUI-hosted `/conversation-ui-state` spreads the resident PC kernel
     * snapshot into this response. Nullable distinguishes that authoritative
     * live payload from the legacy non-hosted fallback, which omits both keys.
     */
    val chatMessages: List<RemoteMessage>? = null,
    val workRuns: List<RemoteWorkRun>? = null,
)

/**
 * Gson may allocate Kotlin DTOs without invoking their default-value
 * constructors. Older desktop payloads that omit a field can therefore place
 * runtime nulls in source-level non-null properties. Keep all such compatibility
 * handling at the authenticated remote boundary so Compose and local persisted
 * models remain strict and cannot crash one missing field at a time under R8.
 */
object RemotePayloadNormalizer {
    fun conversationUiState(value: RemoteConversationUiState): RemoteConversationUiState = value.copy(
        goal = value.goal?.let(::goal),
        flowSelection = value.flowSelection?.let(::flowSelection),
        flow = value.flow?.let(::flow),
        queued = queue(value.queued ?: RemoteConversationQueue()),
        queueItems = value.queueItems.orEmpty().map(::queueItem),
        runtime = value.runtime?.let(::runtime),
        mode = value.mode.orEmpty().ifBlank { "build" },
        status = value.status.orEmpty().ifBlank { "idle" },
        inputMode = value.inputMode.orEmpty().ifBlank { "guide" },
        chatMessages = value.chatMessages?.orEmpty()?.map(::message),
        workRuns = value.workRuns?.orEmpty()?.map(::workRun),
    )

    fun message(value: RemoteMessage): RemoteMessage = value.copy(
        id = value.id.orEmpty(),
        role = value.role.orEmpty().ifBlank { "assistant" },
        content = value.content.orEmpty(),
        mode = value.mode.orEmpty(),
        model = value.model.orEmpty(),
        timestamp = value.timestamp.orEmpty(),
        guideId = value.guideId.orEmpty(),
        clientMessageId = value.clientMessageId.orEmpty(),
        runId = value.runId.orEmpty(),
        branchNodeId = value.branchNodeId.orEmpty(),
        attachments = value.attachments.orEmpty().map(::conversationImage),
    )

    fun workRun(value: RemoteWorkRun): RemoteWorkRun = value.copy(
        runId = value.runId.orEmpty(),
        status = value.status.orEmpty(),
        startedAt = value.startedAt.orEmpty(),
        endedAt = value.endedAt.orEmpty(),
        events = value.events.orEmpty().map(::workEvent),
        guides = value.guides.orEmpty().map(::workGuide),
        primaryPrompt = value.primaryPrompt.orEmpty(),
        branchNodeId = value.branchNodeId.orEmpty(),
        anchorMessageId = value.anchorMessageId.orEmpty(),
    )

    fun workEvent(value: RemoteWorkEvent): RemoteWorkEvent = value.copy(
        id = value.id.orEmpty(),
        conversationId = value.conversationId.orEmpty(),
        type = value.type.orEmpty(),
        content = value.content.orEmpty(),
        mode = value.mode.orEmpty(),
        model = value.model.orEmpty(),
        toolCallId = value.toolCallId.orEmpty(),
        toolName = value.toolName.orEmpty(),
        toolArgs = value.toolArgs.orEmpty(),
        timestamp = value.timestamp.orEmpty(),
        workspaceId = value.workspaceId.orEmpty(),
        workspaceKey = value.workspaceKey.orEmpty(),
        runtimeKey = value.runtimeKey.orEmpty(),
        runId = value.runId.orEmpty(),
        branchNodeId = value.branchNodeId.orEmpty(),
        anchorMessageId = value.anchorMessageId.orEmpty(),
        actorId = value.actorId.orEmpty(),
        status = value.status.orEmpty(),
        clientMessageId = value.clientMessageId.orEmpty(),
        guideId = value.guideId.orEmpty(),
        guide = value.guide?.let(::workGuide),
        displayImage = value.displayImage?.let(::displayImage),
    )

    private fun goal(value: RemoteGoal) = value.copy(objective = value.objective.orEmpty())

    private fun flowSelection(value: RemoteFlowSelection) = value.copy(
        name = value.name.orEmpty(),
        componentType = value.componentType.orEmpty(),
    )

    private fun queue(value: RemoteConversationQueue) = value.copy(
        steering = value.steering.orEmpty().map(String?::orEmpty),
        followUp = value.followUp.orEmpty().map(String?::orEmpty),
    )

    private fun queueItem(value: RemoteQueueItem) = value.copy(
        id = value.id.orEmpty(),
        text = value.text.orEmpty(),
        queueMode = value.queueMode.orEmpty().ifBlank { "followUp" },
        requestedMode = value.requestedMode.orEmpty().ifBlank { "build" },
        goalObjective = value.goalObjective.orEmpty(),
        runId = value.runId.orEmpty(),
        createdAt = value.createdAt.orEmpty(),
    )

    private fun flow(value: RemoteFlowTakeover) = value.copy(
        name = value.name.orEmpty(),
        promptText = value.promptText.orEmpty(),
        message = value.message.orEmpty(),
        reason = value.reason.orEmpty(),
    )

    private fun runtime(value: RemoteRuntimeState) = value.copy(
        status = value.status.orEmpty(),
        runId = value.runId.orEmpty(),
    )

    private fun workGuide(value: RemoteWorkGuide) = value.copy(
        clientMessageId = value.clientMessageId.orEmpty(),
        guideId = value.guideId.orEmpty(),
        runId = value.runId.orEmpty(),
        status = value.status.orEmpty().ifBlank { "accepted" },
        content = value.content.orEmpty(),
        createdAt = value.createdAt.orEmpty(),
        updatedAt = value.updatedAt.orEmpty(),
        appliedAt = value.appliedAt.orEmpty(),
        reason = value.reason.orEmpty(),
        attachments = value.attachments.orEmpty().map(::conversationImage),
    )

    private fun conversationImage(value: RemoteConversationImage) = value.copy(
        id = value.id.orEmpty(),
        origin = value.origin.orEmpty(),
        name = value.name.orEmpty(),
        mimeType = value.mimeType.orEmpty(),
        dataUrl = value.dataUrl.orEmpty(),
    )

    private fun displayImage(value: RemoteWorkDisplayImage) = value.copy(
        id = value.id.orEmpty(),
        origin = value.origin.orEmpty(),
        name = value.name.orEmpty(),
        caption = value.caption.orEmpty(),
        mimeType = value.mimeType.orEmpty(),
        dataUrl = value.dataUrl.orEmpty(),
    )
}

data class RemoteWorkspaceFile(
    val name: String = "",
    val path: String = "",
    val directory: Boolean = false,
)

data class RemotePlanItem(
    val id: String = "",
    val text: String = "",
    val status: String = "pending",
)

data class RemoteConversationPlan(
    val items: List<RemotePlanItem> = emptyList(),
)

data class RemoteLinkedPlan(
    val markdown: String = "",
    val revision: Int = 0,
)

data class RemoteSubagentMessage(
    val role: String = "",
    val content: String = "",
    val name: String = "",
)

data class RemoteSubagent(
    val id: String = "",
    val name: String = "",
    val displayName: String = "",
    val status: String = "idle",
    val model: String = "",
    val mode: String = "build",
    val inputMode: String = "",
    val result: String? = null,
    val error: String = "",
    val messageCount: Int = 0,
    val messages: List<RemoteSubagentMessage> = emptyList(),
)

/** /api/mobile/state 返回的桌面端状态 */
data class DesktopState(
    val mode: String = "",
    val model: String = "",
    val modelLabel: String = "",
    val models: List<String> = emptyList(),
    val providers: List<ProviderConfig> = emptyList(),
    val intelligence: String = "medium",
    val status: String = "",
    val activeConversationId: String = "",
    val conversations: List<RemoteConversation> = emptyList(),
    val chatMessages: List<RemoteMessage> = emptyList(),
    // PC 返回的 workspaces 是 {internal,external,current} 对象而非数组 → @Transient 跳过 Gson，由 parseState 手动组装
    @Transient val workspaces: List<WorkspaceInfo> = emptyList(),
    @Transient val currentWorkspaceId: String = "",
    val workRuns: List<RemoteWorkRun> = emptyList(),
    val goal: RemoteGoal? = null,
    val flowSelection: RemoteFlowSelection? = null,
)

/** /api/mobile/send 返回 */
data class SendResponse(
    val ok: Boolean = false,
    val conversationId: String = "",
    val response: String = "",
    val tokens: List<WorkEvent> = emptyList(),
    val chatMessages: List<RemoteMessage> = emptyList(),
    val status: String = "",
)
