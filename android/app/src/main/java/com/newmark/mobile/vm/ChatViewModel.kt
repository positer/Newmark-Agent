package com.newmark.mobile.vm

import android.app.Application
import android.os.PowerManager
import android.graphics.BitmapFactory
import android.util.Base64
import com.newmark.mobile.service.LocalAgentForegroundService
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.newmark.mobile.data.ActiveModel
import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.ChatResponse
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.ConversationStore
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.data.LocalBuildHistoryContract
import com.newmark.mobile.data.LocalContextCompression
import com.newmark.mobile.data.LocalContextContract
import com.newmark.mobile.data.LocalConversationBranchGroup
import com.newmark.mobile.data.LocalConversationBranchNode
import com.newmark.mobile.data.LocalConversationBranchTree
import com.newmark.mobile.data.LocalPlanItem
import com.newmark.mobile.data.LocalQueuedMessage
import com.newmark.mobile.data.LocalQueueContract
import com.newmark.mobile.data.LocalToolExecutor
import com.newmark.mobile.data.LocalTools
import com.newmark.mobile.data.LocalWorkEvent
import com.newmark.mobile.data.LocalWorkRun
import com.newmark.mobile.data.MobileThoughtContinuation
import com.newmark.mobile.data.MobileThoughtRequestContinuation
import com.newmark.mobile.data.LocalImageAttachment
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.newmark.mobile.data.WorkGuide
import com.newmark.mobile.data.INTELLIGENCE_TIERS
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.data.ProviderStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
import java.security.MessageDigest
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import com.newmark.mobile.data.EmptyResponseLimitException
import com.newmark.mobile.data.emptyResponseRetryDelayMs
import com.newmark.mobile.data.MAX_CONSECUTIVE_EMPTY_RESPONSES
import com.newmark.mobile.data.MAX_EMPTY_RESPONSE_RETRIES
import com.newmark.mobile.data.ProviderNoResponseException
import com.newmark.mobile.data.isEmptyResponseFailure
import com.newmark.mobile.data.isUsableChatResponse
import com.newmark.mobile.data.nextEmptyResponseStreak
import com.newmark.mobile.data.modelRequestedContinuation

internal fun localAgentFailureMessage(config: ApiConfig, error: Throwable): String {
    val detail = error.message?.trim().orEmpty().ifBlank { "API 调用失败" }
    return if (!config.isReady) {
        "⚠️ API 配置不完整，请在设置页配置供应商、接口、API Key 和模型"
    } else {
        "⚠️ $detail"
    }
}

private suspend fun TextRecognizer.processAwait(image: InputImage): com.google.mlkit.vision.text.Text {
    return suspendCancellableCoroutine { continuation ->
        process(image)
            .addOnSuccessListener { continuation.resume(it) }
            .addOnFailureListener { continuation.resumeWithException(it) }
            .addOnCanceledListener { continuation.cancel() }
    }
}

private suspend fun localImageOcr(attachment: LocalImageAttachment): String = withContext(Dispatchers.Default) {
    val encoded = attachment.dataUrl.substringAfter("base64,", "")
    val bytes = runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull() ?: return@withContext ""
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@withContext ""
    val image = InputImage.fromBitmap(bitmap, 0)
    val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    try {
        val a = latin.processAwait(image).text.trim()
        val b = chinese.processAwait(image).text.trim()
        if (b.count { it.isLetterOrDigit() } >= a.count { it.isLetterOrDigit() }) b else a
    } finally {
        latin.close()
        chinese.close()
        bitmap.recycle()
    }
}

private const val AGENT_UI_FRAME_INTERVAL_MS = 16L
private const val AGENT_UI_MAX_DELTAS_PER_FRAME = 512

private sealed interface AgentUiDeltaCommand {
    data class Delta(val thought: Boolean, val content: String) : AgentUiDeltaCommand
    data class Flush(val completion: CompletableDeferred<Unit>) : AgentUiDeltaCommand
}

/**
 * Provider parsing stays on IO while public transcript snapshots are committed
 * to Compose at most once per display-sized interval. Every delta remains in
 * order; only redundant main-thread state publications are coalesced.
 */
private class AgentUiDeltaPublisher(
    scope: CoroutineScope,
    private val publishBatch: (List<AgentUiDeltaCommand.Delta>) -> Unit,
) {
    private val commands = Channel<AgentUiDeltaCommand>(Channel.UNLIMITED)
    private val job = scope.launch(Dispatchers.Main.immediate) {
        while (true) {
            when (val first = commands.receiveCatching().getOrNull() ?: break) {
                is AgentUiDeltaCommand.Flush -> first.completion.complete(Unit)
                is AgentUiDeltaCommand.Delta -> {
                    val deltas = ArrayList<AgentUiDeltaCommand.Delta>()
                    val flushes = ArrayList<CompletableDeferred<Unit>>()
                    deltas += first
                    delay(AGENT_UI_FRAME_INTERVAL_MS)
                    var drained = 1
                    while (drained < AGENT_UI_MAX_DELTAS_PER_FRAME) {
                        val next = commands.tryReceive().getOrNull() ?: break
                        when (next) {
                            is AgentUiDeltaCommand.Delta -> deltas += next
                            is AgentUiDeltaCommand.Flush -> flushes += next.completion
                        }
                        drained++
                    }
                    publishBatch(deltas)
                    flushes.forEach { it.complete(Unit) }
                }
            }
        }
    }

    fun offerThought(delta: String) {
        if (delta.isNotBlank()) commands.trySend(AgentUiDeltaCommand.Delta(thought = true, content = delta))
    }

    fun offerText(delta: String) {
        if (delta.isNotBlank()) commands.trySend(AgentUiDeltaCommand.Delta(thought = false, content = delta))
    }

    suspend fun flushAndClose() {
        val completion = CompletableDeferred<Unit>()
        commands.send(AgentUiDeltaCommand.Flush(completion))
        completion.await()
        commands.close()
        job.join()
    }

    fun cancel() {
        commands.close()
        job.cancel()
    }
}

/** 本地对话 + API 调用对话的正式状态管理 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {

    private data class AgentLoopResult(
        val run: LocalWorkRun,
        val modelContext: List<ChatMessage>,
    )

    private data class PreparedModelContext(
        val messages: List<ChatMessage>,
        val compression: LocalContextCompression?,
    )

    private val conversationStore = ConversationStore(app)
    private val providerStore = ProviderStore(app)
    private val apiClient = ApiClient()

    /**
     * Provider responses are not guaranteed to be stable. Retry only turns
     * that produced no thought, usable text, or tool call; auth/quota/HTTP
     * failures stay terminal. Any successful provider activity clears the
     * local streak.
     */
    private suspend fun chatWithEmptyRecovery(
        config: ApiConfig,
        messages: List<ChatMessage>,
        tools: List<JSONObject> = emptyList(),
        intelligence: String = "medium",
        thinkingTierMap: Map<String, String> = emptyMap(),
        maxOutputTokens: Int? = null,
        onThoughtDelta: suspend (String) -> Unit = {},
        onTextDelta: suspend (String) -> Unit = {},
    ): Result<ChatResponse> {
        var emptyStreak = 0
        while (currentCoroutineContext().isActive) {
            // The provider call owns the entire thought/text stream. No retry
            // delay or empty-response count is evaluated while it is active;
            // the decision below runs only after chat() has returned a
            // terminal response or transport failure, matching PC Agent's
            // turn-level boundary.
            var observedText = false
            var observedThought = false
            val result = apiClient.chat(
                config = config,
                messages = messages,
                tools = tools,
                intelligence = intelligence,
                thinkingTierMap = thinkingTierMap,
                maxOutputTokens = maxOutputTokens,
                onThoughtDelta = { delta ->
                    observedThought = observedThought || delta.isNotBlank()
                    onThoughtDelta(delta)
                },
                onTextDelta = { delta ->
                    observedText = observedText || delta.isNotBlank()
                    onTextDelta(delta)
                },
            )
            val response = result.getOrNull()
            if (response != null && isUsableChatResponse(response)) {
                // Reasoning is a successful provider activity. It clears the
                // streak and is returned as a normal result; it must never be
                // retried or converted into an empty-response failure.
                emptyStreak = 0
                return Result.success(response)
            }
            val error = result.exceptionOrNull()
            if (response != null && !response.explicitEmptyResponse) {
                return Result.failure(ProviderNoResponseException())
            }
            if (response == null && error != null && !isEmptyResponseFailure(error)) return result
            // A stream that emitted visible text but then failed is not an
            // empty response; retrying would duplicate already-rendered text.
            // Thought is likewise successful activity and never becomes an
            // empty-response retry, even if the transport closes afterward.
            if ((observedText || observedThought) && error != null) return result
            emptyStreak = if (observedThought) {
                0
            } else {
                nextEmptyResponseStreak(emptyStreak, usable = false)
            }
            if (emptyStreak >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
                return Result.failure(EmptyResponseLimitException())
            }
            // Wait only after an explicit empty-response failure. A silent
            // stream is handled above as ProviderNoResponseException and is
            // never converted into this retry schedule.
            delay(emptyResponseRetryDelayMs(emptyStreak))
        }
        return Result.failure(java.util.concurrent.CancellationException("Agent coroutine cancelled"))
    }

    // Loaded with the rest of the durable state on Dispatchers.IO. Reading and
    // parsing archived.json in the ViewModel constructor used to block the
    // first Compose pass and made cold start scale poorly on 1-2 core devices.
    private val archived = mutableListOf<LocalConversation>()

    /** 启动异步加载完成前不落盘，防止空列表覆盖磁盘数据 */
    private var loaded = false

    var conversations by mutableStateOf<List<LocalConversation>>(emptyList())
        private set
    var currentId by mutableStateOf<String?>(null)
        private set
    private val localLiveRuns = mutableStateMapOf<String, LocalWorkRun>()
    val isSending: Boolean get() = currentId?.let(localRuntimes::containsKey) == true
    val liveRun: LocalWorkRun? get() = currentId?.let(localLiveRuns::get)
    val liveRunConversationId: String? get() = currentId?.takeIf(localLiveRuns::containsKey)
    val hasRunningLocalAgents: Boolean get() = localRuntimes.isNotEmpty()
    var error by mutableStateOf<String?>(null)
        private set
    private data class LocalGuideInput(
        val clientMessageId: String,
        val guideId: String,
        val text: String,
        val createdAt: Long,
    )
    private data class LocalAgentRuntime(
        val runId: String,
        val guideChannel: Channel<LocalGuideInput>,
        var acceptingGuide: Boolean = true,
        var job: Job? = null,
    )
    private val localRuntimes = mutableStateMapOf<String, LocalAgentRuntime>()
    private val localBrowserToolHandlers = mutableMapOf<String, suspend (JSONObject) -> com.newmark.mobile.data.ToolResult>()
    private var localCalendarToolHandler: (suspend (String, JSONObject) -> com.newmark.mobile.data.ToolResult)? = null
    private var localAlarmToolHandler: (suspend (JSONObject) -> com.newmark.mobile.data.ToolResult)? = null

    fun bindLocalBrowserTools(
        conversationId: String,
        handler: suspend (JSONObject) -> com.newmark.mobile.data.ToolResult,
    ) {
        if (conversationId.isNotBlank()) localBrowserToolHandlers[conversationId] = handler
    }

    fun unbindLocalBrowserTools(
        conversationId: String,
        handler: suspend (JSONObject) -> com.newmark.mobile.data.ToolResult,
    ) {
        if (localBrowserToolHandlers[conversationId] === handler) localBrowserToolHandlers.remove(conversationId)
    }

    fun bindLocalCalendarTool(handler: suspend (String, JSONObject) -> com.newmark.mobile.data.ToolResult) {
        localCalendarToolHandler = handler
    }

    fun unbindLocalCalendarTool(handler: suspend (String, JSONObject) -> com.newmark.mobile.data.ToolResult) {
        if (localCalendarToolHandler === handler) localCalendarToolHandler = null
    }

    fun bindLocalAlarmTool(handler: suspend (JSONObject) -> com.newmark.mobile.data.ToolResult) { localAlarmToolHandler = handler }
    fun unbindLocalAlarmTool(handler: suspend (JSONObject) -> com.newmark.mobile.data.ToolResult) {
        if (localAlarmToolHandler === handler) localAlarmToolHandler = null
    }

    suspend fun importLocalFile(name: String, bytes: ByteArray): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            require(bytes.isNotEmpty()) { "文件为空" }
            require(bytes.size <= 20 * 1024 * 1024) { "文件超过 20 MiB" }
            val safe = File(name).name
                .replace(Regex("[<>:\"/\\\\|?*\\p{Cntrl}]"), "_")
                .trimStart('.')
                .take(160)
                .ifBlank { "mobile-upload.bin" }
            val dir = File(getApplication<Application>().filesDir, "newmark/workspace/uploads").apply { mkdirs() }
            val target = File(dir, "${System.currentTimeMillis()}-$safe")
            target.writeBytes(bytes)
            "uploads/${target.name}"
        }
    }

    // 多供应商 + 激活模型 + 智能档位（本地 agent 实际调用所用）
    var providers by mutableStateOf<List<ProviderConfig>>(emptyList())
        private set
    var activeProviderId by mutableStateOf("")
        private set
    var activeModelName by mutableStateOf("")
        private set
    var intelligence by mutableStateOf("medium")
        private set

    init {
        // 冷启动提速：磁盘 IO + Gson 解析移到后台，主线程只做状态赋值
        viewModelScope.launch(Dispatchers.IO) {
            val convs = conversationStore.load()
            val archivedFromDisk = conversationStore.loadArchived()
            val provs = providerStore.load()
            val act = providerStore.loadActive()
            val (live, legacyArchived) = convs.partition { !it.archived }
            val normalizedLive = withContext(Dispatchers.Default) {
                live.map(::normalizeConversationMessages)
            }
            if (legacyArchived.isNotEmpty()) {
                conversationStore.save(live)
                conversationStore.saveArchived(legacyArchived + archivedFromDisk)
            }
            withContext(Dispatchers.Main) {
                loaded = true
                // 旧版归档语义迁移：archived=true 的条目一次性移入 archived.json
                archived.clear()
                archived += legacyArchived
                archived += archivedFromDisk
                // 加载前用户可能已新建对话（内存中），合并而非覆盖
                conversations = (conversations + normalizedLive)
                    .distinctBy { it.id }
                providers = provs
                activeProviderId = act.providerId
                activeModelName = act.modelName
                intelligence = if (act.intelligence in INTELLIGENCE_TIERS) act.intelligence else "medium"
                normalizeActive()
                if (conversations.isNotEmpty() && currentId == null) {
                    currentId = conversations.first().id
                }
            }
        }
    }

    val current: LocalConversation?
        get() = conversations.find { it.id == currentId }

    /** 当前浏览页消息；无分支的旧对话直接读取原 messages。 */
    val currentMessages: List<ChatMessage>
        get() {
            val conversation = current ?: return emptyList()
            val tree = conversation.branchTree ?: return conversation.messages
            return tree.nodes[tree.viewedNodeId]?.messages ?: conversation.messages
        }

    data class LocalBranchPager(
        val groupId: String,
        val sourceMessageIndex: Int,
        val sourceMessageId: String,
        val currentPage: Int,
        val totalPages: Int,
        val canPrevious: Boolean,
        val canNext: Boolean,
    )

    /** 当前浏览路径上所有分叉分页器，按消息位置排列。 */
    val currentBranchPagers: List<LocalBranchPager>
        get() {
            val tree = current?.branchTree ?: return emptyList()
            val ancestry = branchAncestry(tree, tree.viewedNodeId)
            val rank = ancestry.withIndex().associate { it.value to it.index }
            return tree.branchGroups.values.mapNotNull { group ->
                val selected = group.nodeIds
                    .filter { it in rank }
                    .minByOrNull { rank.getValue(it) }
                    ?: return@mapNotNull null
                val index = group.nodeIds.indexOf(selected).takeIf { it >= 0 } ?: return@mapNotNull null
                val node = tree.nodes[selected] ?: return@mapNotNull null
                val anchorId = node.messages.getOrNull(group.sourceMessageIndex)?.messageId.orEmpty()
                if (group.nodeIds.size < 2) return@mapNotNull null
                LocalBranchPager(
                    groupId = group.id,
                    sourceMessageIndex = group.sourceMessageIndex,
                    sourceMessageId = anchorId.ifBlank { group.sourceMessageId },
                    currentPage = index + 1,
                    totalPages = group.nodeIds.size,
                    canPrevious = index > 0,
                    canNext = index < group.nodeIds.lastIndex,
                )
            }.sortedBy { it.sourceMessageIndex }
        }

    /** 当前本地对话的持久化 task/plan。 */
    val currentPlanItems: List<LocalPlanItem>
        get() = current?.planItems ?: emptyList()

    val currentMode: String
        get() = current?.mode?.lowercase()?.takeIf { it in setOf("build", "plan", "chat") } ?: "build"

    val currentQueue: List<LocalQueuedMessage>
        get() = current?.queuedMessages ?: emptyList()

    val currentQueuePaused: Boolean
        get() = current?.queuePaused ?: false

    val currentInputMode: String
        get() = "next"

    fun selectMode(mode: String) {
        val normalized = mode.lowercase()
        if (normalized !in setOf("build", "plan", "chat")) return
        updateConversation(currentId ?: return) { conversation ->
            conversation.copy(mode = normalized, updatedAt = System.currentTimeMillis())
        }
    }

    fun addPlanItem(text: String) {
        val clean = text.trim().take(240)
        val id = UUID.randomUUID().toString()
        if (clean.isBlank()) return
        updateConversation(currentId ?: return) { conversation ->
            conversation.copy(
                planItems = conversation.planItems + LocalPlanItem(id = id, text = clean),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun updatePlanItem(itemId: String, text: String) {
        val clean = text.trim().take(240)
        if (clean.isBlank()) return
        updateConversation(currentId ?: return) { conversation ->
            conversation.copy(
                planItems = conversation.planItems.map { if (it.id == itemId) it.copy(text = clean) else it },
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun removePlanItem(itemId: String) {
        updateConversation(currentId ?: return) { conversation ->
            conversation.copy(
                planItems = conversation.planItems.filterNot { it.id == itemId },
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun cyclePlanItem(itemId: String) {
        updateConversation(currentId ?: return) { conversation ->
            conversation.copy(
                planItems = conversation.planItems.map { item ->
                    if (item.id != itemId) item else item.copy(status = when (item.status) {
                        "pending" -> "in_progress"
                        "in_progress" -> "done"
                        else -> "pending"
                    })
                },
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    /** 当前激活供应商（缺省取第一个启用项） */
    val activeProvider: ProviderConfig?
        get() = providers.find { it.id == activeProviderId } ?: providers.firstOrNull { it.enabled }

    /** 本地 agent 实际调用配置：激活供应商 + 激活模型 */
    val apiConfig: ApiConfig
        get() {
            val p = activeProvider ?: return ApiConfig()
            val m = p.models.find { it.name == activeModelName && it.enabled }
                ?: p.models.firstOrNull { it.enabled }
                ?: p.models.firstOrNull()
                ?: return ApiConfig()
            return p.toApiConfig(m)
        }

    /** Text-only repair used by the final visual fallback; no image parts are sent. */
    suspend fun correctFinalVisualOcr(rawOcr: String, taskContext: String = ""): String {
        if (rawOcr.isBlank()) return ""
        val prompt = """
            视觉输入不可用。请仅依据下面的近似 OCR 证据和任务上下文，保守修复明显的字符、空格和换行错误。
            不得补写证据中不存在的内容；有歧义请保留 [uncertain] 标记。
            任务上下文：${taskContext.take(4000)}
            OCR 证据：${rawOcr.take(50000)}
        """.trimIndent()
        return chatWithEmptyRecovery(
            apiConfig,
            listOf(ChatMessage(role = "user", content = prompt)),
            tools = emptyList(),
            intelligence = "low",
            maxOutputTokens = 3000,
        ).getOrNull()?.content?.trim().orEmpty()
    }

    private suspend fun finalLocalImageFallback(messages: List<ChatMessage>, error: Throwable): ChatResponse? {
        val text = error.message.orEmpty()
        if (!Regex("vision|image|multimodal|image_url|input_image|不支持|拒绝", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null
        val current = activeModelConfig
        if (current != null && activeProvider?.models?.any { it.enabled && it.vision && it.name != current.name } == true) return null
        val images = messages.asSequence().flatMap { it.imageAttachments.orEmpty().asSequence() }.take(4).toList()
        if (images.isEmpty()) return null
        val raw = images.mapNotNull { image -> localImageOcr(image).takeIf(String::isNotBlank) }.joinToString("\n\n")
        if (raw.isBlank()) return ChatResponse(content = "{\"ok\":false,\"fallback\":\"mini_ocr_llm\",\"error\":\"本地 OCR 未识别到文本，未编造视觉内容\"}")
        val corrected = correctFinalVisualOcr(raw, messages.lastOrNull { it.role == "user" }?.content.orEmpty())
        val output = corrected.ifBlank { raw }
        return ChatResponse(
            content = "⚠️ 视觉输入被拒绝，以下为本地 OCR 的近似结果，经文本模型保守校正：\n\n$output",
        )
    }

    private val activeModelConfig: ModelConfig?
        get() = activeProvider?.models?.find { it.name == activeModelName && it.enabled }
            ?: activeProvider?.models?.firstOrNull { it.enabled }
            ?: activeProvider?.models?.firstOrNull()

    /** 所有供应商的启用模型；UI 按供应商分组，模型行只显示 display|name。 */
    fun enabledModelOptions(): List<ModelOption> =
        providers.filter { it.enabled }.flatMap { p ->
            p.models.filter { it.enabled }.map { m ->
                ModelOption(
                    providerId = p.id,
                    modelName = m.name,
                    label = m.label,
                    providerLabel = p.label,
                    displayName = m.label,
                )
            }
        }

    fun newConversation() {
        val c = LocalConversation(
            id = UUID.randomUUID().toString(),
            title = "新对话",
            mode = "chat",
        )
        conversations = listOf(c) + conversations
        currentId = c.id
        error = null
        persist()
    }

    fun selectConversation(id: String) {
        currentId = id
        error = null
    }

    /** 只读切换分支页；不改变 activeNodeId，后续发送时才激活所阅页。 */
    fun inspectBranch(groupId: String, offset: Int) {
        if (isSending || offset == 0) return
        updateConversation(currentId ?: return) { conversation ->
            val tree = conversation.branchTree ?: return@updateConversation conversation
            val group = tree.branchGroups[groupId] ?: return@updateConversation conversation
            val ancestry = branchAncestry(tree, tree.viewedNodeId)
            val ancestryRank = ancestry.withIndex().associate { it.value to it.index }
            val currentNodeId = group.nodeIds
                .filter { it in ancestryRank }
                .minByOrNull { ancestryRank.getValue(it) }
                ?: return@updateConversation conversation
            val currentIndex = group.nodeIds.indexOf(currentNodeId)
            val nextIndex = (currentIndex + offset).coerceIn(0, group.nodeIds.lastIndex)
            if (nextIndex == currentIndex) conversation
            else conversation.copy(branchTree = tree.copy(viewedNodeId = group.nodeIds[nextIndex]))
        }
    }

    /** 编辑历史用户消息：保留原页，创建新分支，并立即按 PC 流程发送编辑后的输入。 */
    fun branchFromUserMessage(messageIndex: Int, editedText: String) {
        val text = editedText.trim()
        val conversation = current ?: return
        if (text.isBlank() || isSending) return
        val normalized = normalizeConversationMessages(conversation)
        val baseTree = normalized.branchTree ?: createRootTree(normalized)
        val parentId = baseTree.viewedNodeId
        val parent = baseTree.nodes[parentId] ?: return
        val target = parent.messages.getOrNull(messageIndex) ?: return
        if (target.role != "user") return

        val existingGroup = baseTree.branchGroups.values.firstOrNull { group ->
            parentId in group.nodeIds && group.sourceMessageIndex == messageIndex
        }
        val branchId = UUID.randomUUID().toString()
        val groupId = existingGroup?.id ?: UUID.randomUUID().toString()
        val branch = LocalConversationBranchNode(
            id = branchId,
            parentId = parentId,
            sourceMessageIndex = messageIndex,
            sourceMessageId = target.messageId,
            sourceText = text,
            messages = parent.messages.take(messageIndex),
        )
        val group = existingGroup?.copy(nodeIds = existingGroup.nodeIds + branchId)
            ?: LocalConversationBranchGroup(
                id = groupId,
                sourceNodeId = parentId,
                sourceMessageIndex = messageIndex,
                sourceMessageId = target.messageId,
                nodeIds = listOf(parentId, branchId),
            )
        val nextTree = baseTree.copy(
            activeNodeId = branchId,
            viewedNodeId = branchId,
            activeGroupId = groupId,
            nodes = baseTree.nodes + (branchId to branch),
            branchGroups = baseTree.branchGroups + (groupId to group),
        )
        updateConversation(conversation.id) {
            normalized.copy(
                messages = branch.messages,
                // A new branch must never inherit a compressed context from
                // the old path. Its first send rebuilds model-only context
                // from this branch's own complete displayed history.
                modelContext = emptyList(),
                contextCompression = null,
                branchTree = nextTree,
                updatedAt = System.currentTimeMillis(),
            )
        }
        send(text)
    }

    // ---- 供应商 / 模型后端 ----

    fun upsertProvider(provider: ProviderConfig) {
        val list = providers.toMutableList()
        val idx = list.indexOfFirst { it.id == provider.id }
        if (idx >= 0) list[idx] = provider else list.add(provider)
        providers = list
        providerStore.save(list)
        if (activeProviderId.isBlank() || providers.none { it.id == activeProviderId }) {
            activeProviderId = provider.id
            normalizeActive()
        }
    }

    /** Merge an explicitly exported remote catalog without replacing existing local secrets. */
    fun mergeProviderCatalog(incoming: List<ProviderConfig>): Pair<Int, Int> {
        val result = com.newmark.mobile.data.mergeProviderCatalogEntries(providers, incoming)
        providers = result.providers
        providerStore.save(result.providers)
        if (activeProviderId.isBlank() && result.providers.isNotEmpty()) {
            activeProviderId = result.providers.first().id
            normalizeActive()
        }
        return result.addedProviders to result.addedModels
    }

    fun removeProvider(id: String) {
        providers = providers.filter { it.id != id }
        providerStore.save(providers)
        if (activeProviderId == id) {
            activeProviderId = providers.firstOrNull { it.enabled }?.id ?: ""
            activeModelName = ""
            normalizeActive()
        }
    }

    fun updateProvider(provider: ProviderConfig) {
        providers = providers.map { if (it.id == provider.id) provider else it }
        providerStore.save(providers)
        if (activeProviderId == provider.id) normalizeActive()
    }

    fun selectProvider(id: String) {
        val p = providers.find { it.id == id } ?: return
        activeProviderId = id
        activeModelName = p.models.firstOrNull { it.enabled }?.name ?: p.models.firstOrNull()?.name ?: ""
        persistActive()
    }

    fun selectModel(providerId: String, modelName: String) {
        activeProviderId = providerId
        activeModelName = modelName
        persistActive()
    }

    fun selectIntelligence(tier: String) {
        if (tier !in INTELLIGENCE_TIERS) return
        intelligence = tier
        persistActive()
    }

    fun addModel(providerId: String, name: String) {
        val n = name.trim()
        if (n.isEmpty()) return
        upsertModel(providerId, ModelConfig(name = n))
    }

    fun upsertModel(providerId: String, model: ModelConfig) {
        val normalized = model.copy(name = model.name.trim())
        if (normalized.name.isEmpty()) return
        updateProviderModels(providerId) { p ->
            val index = p.models.indexOfFirst { it.name.equals(normalized.name, ignoreCase = true) }
            if (index < 0) p.copy(models = p.models + normalized)
            else p.copy(models = p.models.toMutableList().also { it[index] = normalized })
        }
    }

    fun removeModel(providerId: String, name: String) {
        updateProviderModels(providerId) { p ->
            p.copy(models = p.models.filter { it.name != name })
        }
    }

    fun toggleModel(providerId: String, name: String) {
        updateProviderModels(providerId) { p ->
            p.copy(models = p.models.map { if (it.name == name) it.copy(enabled = !it.enabled) else it })
        }
    }

    private fun updateProviderModels(providerId: String, transform: (ProviderConfig) -> ProviderConfig) {
        providers = providers.map { if (it.id == providerId) transform(it) else it }
        providerStore.save(providers)
        if (activeProviderId == providerId) normalizeActive()
    }

    /** 保证激活选择始终指向有效 provider/model；否则回落第一个可用 */
    private fun normalizeActive() {
        val fallback = providers.firstOrNull { it.enabled }
        if (fallback == null) {
            activeProviderId = ""
            activeModelName = ""
            return
        }
        val p = providers.find { it.id == activeProviderId && it.enabled } ?: fallback
        if (activeProviderId != p.id) activeProviderId = p.id
        if (p.models.none { it.name == activeModelName && it.enabled }) {
            activeModelName = p.models.firstOrNull { it.enabled }?.name ?: p.models.firstOrNull()?.name ?: ""
        }
        persistActive()
    }

    private fun persistActive() {
        providerStore.saveActive(ActiveModel(providerId = activeProviderId, modelName = activeModelName, intelligence = intelligence))
    }

    fun renameConversation(id: String, title: String) {
        val t = title.replace(Regex("\\s+"), " ").trim().take(80)
        if (t.isEmpty()) return
        updateConversation(id) { it.copy(title = t, updatedAt = System.currentTimeMillis()) }
    }

    fun archiveConversation(id: String) {
        val target = conversations.find { it.id == id } ?: return
        // 从本地对话区移出（§7-2：本地归档 = 从列表删除），数据移入 archived.json 保留
        conversations = conversations.filter { it.id != id }
        persist()
        archived.add(0, target.copy(archived = true, updatedAt = System.currentTimeMillis()))
        conversationStore.saveArchived(archived)
        if (currentId == id) {
            currentId = conversations.firstOrNull()?.id
        }
    }

    fun togglePin(id: String) {
        // 置顶后浮到列表顶部（与桌面端 listConversationStates 的 pinned 优先排序一致）
        conversations = conversations
            .map { if (it.id == id) it.copy(pinned = !it.pinned, updatedAt = System.currentTimeMillis()) else it }
            .sortedWith(compareByDescending<LocalConversation> { it.pinned }.thenByDescending { it.updatedAt })
        persist()
    }

    /** Reorder one pin group while preserving the other group's positions. */
    fun reorderConversations(orderedIds: List<String>) {
        val normalized = orderedIds.distinct()
        if (normalized.isEmpty()) return
        val byId = conversations.associateBy { it.id }
        val reordered = normalized.mapNotNull(byId::get)
        if (reordered.size != normalized.size) return
        val targetIds = normalized.toSet()
        val iterator = reordered.iterator()
        val next = conversations.map { current ->
            if (current.id in targetIds && iterator.hasNext()) iterator.next() else current
        }
        if (next != conversations) {
            conversations = next
            persist()
        }
    }

    fun stop() {
        val targetConversationId = currentId ?: return
        val runtime = localRuntimes[targetConversationId] ?: return
        val activeRun = localLiveRuns[targetConversationId]
        val interrupted = activeRun?.copy(
            status = "interrupted",
            endedAt = System.currentTimeMillis(),
            events = activeRun.events + LocalWorkEvent(
                type = "interrupted",
                id = "${activeRun.runId}:${activeRun.events.size}:interrupted",
                content = "已停止",
                sequence = activeRun.events.size.toLong(),
            ),
        )
        runtime.job?.cancel()
        runtime.acceptingGuide = false
        runtime.guideChannel.close()
        localRuntimes.remove(targetConversationId)
        localLiveRuns.remove(targetConversationId)
        if (interrupted != null) {
            updateConversation(targetConversationId) { conversation ->
                val assistant = ChatMessage(
                    role = "assistant",
                    content = "",
                    messageId = UUID.randomUUID().toString(),
                    workRun = interrupted,
                )
                val nextMessages = conversation.messages + assistant
                conversation.copy(
                    messages = nextMessages,
                    updatedAt = System.currentTimeMillis(),
                    branchTree = updateBranchNodeMessages(
                        conversation.branchTree,
                        conversation.branchTree?.activeNodeId,
                        nextMessages,
                    ),
                )
            }
        }
        drainLocalQueueIfReady(targetConversationId)
    }

    fun enqueueLocal(text: String) {
        val content = text.trim()
        val conversationId = currentId ?: return
        if (content.isBlank()) return
        updateConversation(conversationId) { conversation ->
            conversation.copy(
                queuedMessages = LocalQueueContract.enqueue(
                    conversation.queuedMessages,
                    LocalQueuedMessage(
                        id = UUID.randomUUID().toString(),
                        text = content,
                        requestedMode = conversation.mode.lowercase()
                            .takeIf { it in setOf("build", "plan", "chat") }
                            ?: "build",
                    ),
                ),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun toggleLocalQueuePause() {
        val conversationId = currentId ?: return
        val wasPaused = current?.queuePaused == true
        updateConversation(conversationId) { conversation ->
            conversation.copy(queuePaused = !conversation.queuePaused, updatedAt = System.currentTimeMillis())
        }
        if (wasPaused) drainLocalQueueIfReady(conversationId)
    }

    fun updateLocalQueueMessage(id: String, text: String) {
        val content = text.trim()
        val conversationId = currentId ?: return
        updateConversation(conversationId) { conversation ->
            conversation.copy(
                queuedMessages = LocalQueueContract.update(conversation.queuedMessages, id, content),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun deleteLocalQueueMessage(id: String) {
        val conversationId = currentId ?: return
        updateConversation(conversationId) { conversation ->
            conversation.copy(
                queuedMessages = LocalQueueContract.delete(conversation.queuedMessages, id),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun reorderLocalQueueMessages(orderedIds: List<String>) {
        val conversationId = currentId ?: return
        updateConversation(conversationId) { conversation ->
            conversation.copy(
                queuedMessages = LocalQueueContract.reorder(conversation.queuedMessages, orderedIds),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    fun guideLocalQueueMessage(id: String) {
        val conversation = current ?: return
        val item = conversation.queuedMessages.firstOrNull { it.id == id } ?: return
        val runtime = localRuntimes[conversation.id]
        val channel = runtime?.guideChannel
        val run = localLiveRuns[conversation.id]
        if (runtime == null || !runtime.acceptingGuide || channel == null || run == null ||
            run.runId != runtime.runId || run.mode != "build"
        ) {
            error = "当前没有可接收 Guide 的本地运行"
            return
        }
        val guide = LocalGuideInput(
            clientMessageId = UUID.randomUUID().toString(),
            guideId = UUID.randomUUID().toString(),
            text = item.text,
            createdAt = System.currentTimeMillis(),
        )
        if (!channel.trySend(guide).isSuccess) {
            error = "当前本地运行已结束，Guide 未发送"
            return
        }
        updateConversation(conversation.id) {
            it.copy(queuedMessages = LocalQueueContract.consumeAcceptedGuide(it.queuedMessages, id, accepted = true))
        }
        val accepted = WorkGuide(
            clientMessageId = guide.clientMessageId,
            guideId = guide.guideId,
            runId = run.runId,
            status = "accepted",
            content = guide.text,
            createdAt = guide.createdAt.toString(),
            updatedAt = guide.createdAt.toString(),
        )
        localLiveRuns[conversation.id] = run.copy(events = run.events + LocalWorkEvent(
            type = "guide_accepted",
            id = "${run.runId}:${guide.clientMessageId}:accepted",
            content = guide.text,
            timestamp = guide.createdAt,
            sequence = (run.events.maxOfOrNull { it.sequence } ?: 0L) + 1L,
            status = "accepted",
            clientMessageId = guide.clientMessageId,
            guideId = guide.guideId,
            guide = accepted,
        ))
    }

    private fun drainLocalQueueIfReady(conversationId: String?) {
        if (conversationId.isNullOrBlank() || localRuntimes.containsKey(conversationId)) return
        val conversation = conversations.firstOrNull { it.id == conversationId } ?: return
        if (conversation.queuePaused) return
        val (next, remaining) = LocalQueueContract.dequeue(
            conversation.queuedMessages,
            paused = conversation.queuePaused,
            running = localRuntimes.containsKey(conversationId),
        )
        if (next == null) return
        updateConversation(conversationId) {
            it.copy(
                queuedMessages = remaining,
                mode = next.requestedMode.lowercase().takeIf { mode -> mode in setOf("build", "plan", "chat") }
                    ?: it.mode,
                updatedAt = System.currentTimeMillis(),
            )
        }
        sendInConversation(conversationId, next.text)
    }

    /** 发送消息：本地持久化 + 调 API + 持久化回复 */
    fun send(text: String) {
        sendInConversation(currentId, text)
    }

    fun sendWithImages(text: String, images: List<com.newmark.mobile.data.LocalImageAttachment>) {
        val bounded = images.filter { image ->
            image.dataUrl.startsWith("data:image/png;base64,") || image.dataUrl.startsWith("data:image/jpeg;base64,")
        }.take(4)
        if (bounded.isEmpty()) return send(text)
        sendInConversation(currentId, text, bounded)
    }

    private fun sendInConversation(requestedConversationId: String?, text: String, images: List<com.newmark.mobile.data.LocalImageAttachment> = emptyList()) {
        val content = text.trim()
        if (content.isEmpty() && images.isEmpty()) return

        if (requestedConversationId == null && current == null) {
            newConversation()
        }
        var conv = conversations.firstOrNull { it.id == (requestedConversationId ?: currentId) } ?: return
        if (localRuntimes.containsKey(conv.id)) return

        // PC 语义：浏览旧分支时先把该页激活为运行分支，再写入新消息。
        conv.branchTree?.let { tree ->
            if (tree.viewedNodeId != tree.activeNodeId) {
                val viewed = tree.nodes[tree.viewedNodeId] ?: return
                conv = conv.copy(
                    messages = viewed.messages,
                    branchTree = tree.copy(activeNodeId = tree.viewedNodeId),
                )
                updateConversation(conv.id) { conv }
            }
        }
        val targetConversationId = conv.id
        val targetBranchId = conv.branchTree?.activeNodeId
        val targetMode = conv.mode.lowercase().takeIf { it in setOf("build", "plan", "chat") } ?: "build"
        val userMessage = ChatMessage(
            role = "user",
            content = content.ifBlank { "请查看随附图片。" },
            messageId = UUID.randomUUID().toString(),
            imageAttachments = images,
        )

        // 1. 落库用户消息
        updateConversation(targetConversationId) {
            val nextMessages = it.messages + userMessage
            it.copy(
                messages = nextMessages,
                modelContext = if (it.modelContext.isEmpty()) emptyList() else it.modelContext + userMessage,
                title = if (it.messages.isEmpty()) deriveTitle(content) else it.title,
                updatedAt = System.currentTimeMillis(),
                branchTree = updateBranchNodeMessages(it.branchTree, targetBranchId, nextMessages),
            )
        }

        error = null
        val runId = UUID.randomUUID().toString()
        val runStartedAt = System.currentTimeMillis()
        val guideChannel = Channel<LocalGuideInput>(Channel.UNLIMITED)
        val runtime = LocalAgentRuntime(runId = runId, guideChannel = guideChannel)
        localRuntimes[targetConversationId] = runtime
        updateLocalAgentService()
        // Do not wait for the provider call, a tool result, or the persisted
        // Build block before exposing local execution.  The running block is
        // part of the synchronous send transition, so a slow first token is
        // still represented immediately in the conversation.
        localLiveRuns[targetConversationId] = LocalWorkRun(
            runId = runId,
            status = "running",
            startedAt = runStartedAt,
            expanded = true,
            events = listOf(
                LocalWorkEvent(
                    type = "start",
                    id = "$runId:0:start",
                    content = "开始",
                    timestamp = runStartedAt,
                    sequence = 0,
                ),
            ),
            mode = targetMode,
            model = activeModelName,
            anchorMessageId = userMessage.messageId,
            branchNodeId = targetBranchId.orEmpty(),
        )
        runtime.job = viewModelScope.launch {
            withLocalAgentWakeLock {
            val targetConversation = conversations.find { it.id == targetConversationId }
                ?: return@withLocalAgentWakeLock
            val snapshot = targetConversation.messages
            val executor = LocalToolExecutor(getApplication()) { name, args ->
                executeConversationTool(targetConversationId, name, args)
            }
            // 智能档位 + 模型原生思考强度映射（thinking_tier_map）随调用透传
            val tierMap = activeModelConfig?.thinkingTierMap ?: emptyMap()
            val prepared = prepareModelContext(
                config = apiConfig,
                conversation = targetConversation,
                displaySnapshot = snapshot,
                maxTokens = activeModelConfig?.maxTokens?.takeIf { it > 0 } ?: 128_000,
            )
            if (prepared.compression != targetConversation.contextCompression ||
                prepared.messages != targetConversation.modelContext
            ) {
                updateConversation(targetConversationId) {
                    it.copy(
                        modelContext = prepared.messages,
                        contextCompression = prepared.compression,
                        compressionHistory = prepared.compression?.let { item ->
                            (it.compressionHistory + item).distinctBy { entry -> entry.id }.takeLast(32)
                        } ?: it.compressionHistory,
                        updatedAt = System.currentTimeMillis(),
                    )
                }
            }
            val loopResult = runAgentLoop(
                apiConfig,
                targetConversationId,
                prepared.messages,
                executor,
                intelligence,
                tierMap,
                targetMode,
                runId,
                runStartedAt,
                guideChannel,
                onGuideAcceptingChanged = { accepting ->
                    localRuntimes[targetConversationId]
                        ?.takeIf { it.runId == runId }
                        ?.acceptingGuide = accepting
                },
                anchorMessageId = userMessage.messageId,
                branchNodeId = targetBranchId.orEmpty(),
            ) { progress ->
                if (localRuntimes[targetConversationId]?.runId == runId) {
                    localLiveRuns[targetConversationId] = progress
                }
            }
            val run = loopResult.run
            updateConversation(targetConversationId) {
                // 与 PC ConversationWorkRun 一致：失败/中断只保留 Build 过程，
                // 不伪造一条最终 Agent 回复；完成态才保留独立最终正文。
                val finalText = if (run.status == "completed") run.text else ""
                val assistant = ChatMessage(
                    role = "assistant",
                    content = finalText,
                    messageId = UUID.randomUUID().toString(),
                    workRun = run.copy(text = finalText),
                )
                val nextMessages = it.messages + assistant
                it.copy(
                    messages = nextMessages,
                    modelContext = loopResult.modelContext,
                    contextCompression = it.contextCompression ?: prepared.compression,
                    updatedAt = System.currentTimeMillis(),
                    branchTree = updateBranchNodeMessages(it.branchTree, targetBranchId, nextMessages),
                )
            }
            // 工具可能经 settings_update 改写了 providers/active 文件 → 重载设置状态（设置页与下次调用即时生效）
            reloadSettingsFromDisk()
            runtime.acceptingGuide = false
            guideChannel.close()
            if (localRuntimes[targetConversationId]?.runId == runId) {
                localRuntimes.remove(targetConversationId)
                localLiveRuns.remove(targetConversationId)
            }
            updateLocalAgentService()
            drainLocalQueueIfReady(targetConversationId)
            }
        }
    }

    /** Keep provider/tool work alive while the screen is backgrounded. */
    private suspend fun <T> withLocalAgentWakeLock(block: suspend () -> T): T {
        val power = getApplication<Application>()
            .getSystemService(PowerManager::class.java)
        val lock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Newmark:LocalAgent")
        lock?.setReferenceCounted(false)
        lock?.acquire()
        return try {
            block()
        } finally {
            if (lock?.isHeld == true) lock.release()
        }
    }

    private fun updateLocalAgentService() {
        val context = getApplication<Application>()
        LocalAgentForegroundService.updateLocalCount(context, localRuntimes.size)
    }

    /** 从磁盘重载设置状态（供 Agent settings_update 工具改动后同步 UI 与后续调用） */
    fun reloadSettingsFromDisk() {
        providers = providerStore.load()
        val active = providerStore.loadActive()
        activeProviderId = active.providerId
        activeModelName = active.modelName
        intelligence = if (active.intelligence in INTELLIGENCE_TIERS) active.intelligence else "medium"
        normalizeActive()
    }

    private suspend fun executeConversationTool(
        conversationId: String,
        name: String,
        args: JSONObject,
    ): com.newmark.mobile.data.ToolResult? = withContext(Dispatchers.Main) {
        when (name) {
            "build_history_query" -> {
                val messages = conversations.firstOrNull { it.id == conversationId }?.messages.orEmpty()
                com.newmark.mobile.data.ToolResult.ok(
                    LocalBuildHistoryContract.query(messages, args),
                )
            }
            "context_compress" -> compressConversationContext(conversationId, args)
            "context_history_manage" -> manageContextCompression(conversationId, args)
            "task_read" -> {
                val items = conversations.firstOrNull { it.id == conversationId }?.planItems.orEmpty()
                com.newmark.mobile.data.ToolResult.ok(
                    if (items.isEmpty()) "当前 task/plan 清单为空。" else items.mapIndexed { index, item ->
                        "${index}. [${item.status}] ${item.text} (id=${item.id})"
                    }.joinToString("\n"),
                )
            }
            "task_create" -> executeTaskCreate(conversationId, args)
            "browser_use" -> localBrowserToolHandlers[conversationId]?.invoke(args)
                ?: com.newmark.mobile.data.ToolResult.err("当前对话的内置浏览器尚未挂载")
            "calendar_create", "calendar_read" -> localCalendarToolHandler?.invoke(name, args)
                ?: com.newmark.mobile.data.ToolResult.err("日历权限请求器尚未挂载")
            "alarm_manage" -> localAlarmToolHandler?.invoke(args)
                ?: com.newmark.mobile.data.ToolResult.err("闹钟权限请求器尚未挂载")
            "__document_visual_read" -> readDocumentPagesWithVision(args)
            else -> null
        }
    }

    private suspend fun readDocumentPagesWithVision(args: JSONObject): com.newmark.mobile.data.ToolResult {
        if (activeModelConfig?.vision != true) return com.newmark.mobile.data.ToolResult.err("当前模型未声明视觉能力")
        val images = args.optJSONArray("images") ?: JSONArray()
        val attachments = (0 until images.length()).mapNotNull { index ->
            images.optJSONObject(index)?.let { item ->
                val dataUrl = item.optString("data_url")
                if (!dataUrl.startsWith("data:image/")) null else LocalImageAttachment(
                    name = item.optString("name", "page-${index + 1}.jpg"),
                    mimeType = item.optString("mime_type", "image/jpeg"),
                    dataUrl = dataUrl,
                )
            }
        }
        if (attachments.isEmpty()) return com.newmark.mobile.data.ToolResult.err("没有可供视觉读取的页面")
        val response = withContext(Dispatchers.IO) {
            chatWithEmptyRecovery(
                config = apiConfig,
                messages = listOf(ChatMessage(role = "user", content = args.optString("prompt"), imageAttachments = attachments)),
                tools = emptyList(),
                intelligence = intelligence,
                maxOutputTokens = 8_000,
            )
        }.getOrElse { return com.newmark.mobile.data.ToolResult.err(it.message ?: "视觉模型读取失败") }
        return if (response.content.isBlank()) com.newmark.mobile.data.ToolResult.err("视觉模型返回空内容")
        else com.newmark.mobile.data.ToolResult.ok(response.content)
    }

    private suspend fun compressConversationContext(
        conversationId: String,
        args: JSONObject,
    ): com.newmark.mobile.data.ToolResult {
        val conversation = conversations.firstOrNull { it.id == conversationId }
            ?: return com.newmark.mobile.data.ToolResult.err("[context_compress] 目标对话不存在")
        val maxTokens = activeModelConfig?.maxTokens?.takeIf { it > 0 } ?: 128_000
        val prepared = prepareModelContext(
            config = apiConfig,
            conversation = conversation,
            displaySnapshot = conversation.messages,
            maxTokens = maxTokens,
            force = args.optBoolean("force", false),
            keepRecent = args.optInt("keep_recent", 48).coerceIn(2, 60),
        )
        val compression = prepared.compression
            ?: return com.newmark.mobile.data.ToolResult.err("[context_compress] Compression skipped: context unchanged.")
        updateConversation(conversationId) {
            it.copy(
                modelContext = prepared.messages,
                contextCompression = compression,
                compressionHistory = (it.compressionHistory + compression).takeLast(32),
                updatedAt = System.currentTimeMillis(),
            )
        }
        return com.newmark.mobile.data.ToolResult.ok(
            JSONObject()
                .put("ok", true)
                .put("compressed", true)
                .put("compression_id", compression.id)
                .put("originalMessages", compression.originalMessages)
                .put("compressedMessages", compression.compressedMessages)
                .put("originalChars", compression.originalChars)
                .put("compressedChars", compression.compressedChars)
                .put("compressedTokens", compression.compressedTokens)
                .put("fallback", compression.fallback)
                .put("displayHistory", JSONObject().put("untouched", true).put("messageCount", conversation.messages.size))
                .toString(),
        )
    }

    private fun manageContextCompression(
        conversationId: String,
        args: JSONObject,
    ): com.newmark.mobile.data.ToolResult {
        val conversation = conversations.firstOrNull { it.id == conversationId }
            ?: return com.newmark.mobile.data.ToolResult.err("[context_history_manage] 目标对话不存在")
        val action = args.optString("action").lowercase()
        val history = conversation.compressionHistory.ifEmpty {
            listOfNotNull(conversation.contextCompression)
        }
        return when (action) {
            "status" -> com.newmark.mobile.data.ToolResult.ok(
                JSONObject()
                    .put("ok", true)
                    .put("compressionCount", history.size)
                    .put("latest", history.lastOrNull()?.let { compressionJson(it) } ?: JSONObject.NULL)
                    .put("displayHistory", JSONObject().put("untouched", true).put("messageCount", conversation.messages.size))
                    .toString(),
            )
            "search" -> {
                val query = args.optString("query").trim().lowercase()
                if (query.isBlank()) return com.newmark.mobile.data.ToolResult.err("[context_history_manage] search requires query")
                val matches = history.filter { it.summary.lowercase().contains(query) }
                    .take(args.optInt("limit", 20).coerceIn(1, 100))
                    .map(::compressionJson)
                com.newmark.mobile.data.ToolResult.ok(JSONObject().put("ok", true).put("matches", JSONArray(matches)).toString())
            }
            "read" -> {
                val id = args.optString("restore_id").trim()
                val item = history.firstOrNull { it.id == id }
                    ?: return com.newmark.mobile.data.ToolResult.err("[context_history_manage] unknown restore_id")
                com.newmark.mobile.data.ToolResult.ok(JSONObject().put("ok", true).put("compression", compressionJson(item)).toString())
            }
            else -> com.newmark.mobile.data.ToolResult.err("[context_history_manage] action must be status|search|read")
        }
    }

    private fun compressionJson(item: LocalContextCompression): JSONObject = JSONObject()
        .put("id", item.id)
        .put("at", item.at)
        .put("originalMessages", item.originalMessages)
        .put("compressedMessages", item.compressedMessages)
        .put("originalChars", item.originalChars)
        .put("compressedChars", item.compressedChars)
        .put("compressedTokens", item.compressedTokens)
        .put("summary", item.summary.take(4_000))
        .put("model", item.model)
        .put("fallback", item.fallback)

    private fun executeTaskCreate(conversationId: String, args: JSONObject): com.newmark.mobile.data.ToolResult {
        val conversation = conversations.firstOrNull { it.id == conversationId }
            ?: return com.newmark.mobile.data.ToolResult.err("没有目标本地对话")
        return when (args.optString("action").lowercase()) {
            "create" -> {
                val text = args.optString("task").ifBlank { args.optString("text") }.trim().take(400)
                if (text.isBlank()) return com.newmark.mobile.data.ToolResult.err("[task_create] task text is required.")
                val item = LocalPlanItem(UUID.randomUUID().toString(), text)
                updateConversation(conversationId) { it.copy(planItems = it.planItems + item, updatedAt = System.currentTimeMillis()) }
                com.newmark.mobile.data.ToolResult.ok("[task_create] created id=${item.id}")
            }
            "update" -> {
                val id = args.optString("id")
                val index = if (args.has("index")) args.optInt("index", -1) else -1
                val target = conversation.planItems.firstOrNull { id.isNotBlank() && it.id == id }
                    ?: conversation.planItems.getOrNull(index)
                    ?: return com.newmark.mobile.data.ToolResult.err("[task_create] no matching task item for update (pass id or valid index).")
                val requestedStatus = args.optString("status")
                val status = when (requestedStatus) {
                    "" -> target.status
                    "pending", "in_progress", "done" -> requestedStatus
                    "blocked" -> "pending"
                    else -> return com.newmark.mobile.data.ToolResult.err("[task_create] status must be pending|in_progress|done|blocked.")
                }
                val text = args.optString("task").ifBlank { args.optString("text") }.trim().take(400).ifBlank { target.text }
                updateConversation(conversationId) { current ->
                    current.copy(
                        planItems = current.planItems.map { if (it.id == target.id) it.copy(text = text, status = status) else it },
                        updatedAt = System.currentTimeMillis(),
                    )
                }
                com.newmark.mobile.data.ToolResult.ok("[task_create] updated id=${target.id} status=$status")
            }
            "clear" -> {
                val count = conversation.planItems.count { it.status == "done" }
                updateConversation(conversationId) { current ->
                    current.copy(planItems = current.planItems.filterNot { it.status == "done" }, updatedAt = System.currentTimeMillis())
                }
                com.newmark.mobile.data.ToolResult.ok("[task_create] cleared $count completed item(s)")
            }
            else -> com.newmark.mobile.data.ToolResult.err("[task_create] action must be create|update|clear.")
        }
    }

    /**
     * Builds the durable model-only context without touching displayed
     * history. Compression follows the PC 70% active-window trigger and keeps
     * a complete recent user turn plus a continuation anchor.
     */
    private suspend fun prepareModelContext(
        config: ApiConfig,
        conversation: LocalConversation,
        displaySnapshot: List<ChatMessage>,
        maxTokens: Int,
        force: Boolean = false,
        keepRecent: Int = 48,
    ): PreparedModelContext {
        val current = if (conversation.modelContext.isNotEmpty()) {
            conversation.modelContext
        } else {
            displaySnapshot
        }
        val budget = withContext(Dispatchers.Default) {
            LocalContextContract.budget(current, maxTokens)
        }
        if (!force && !budget.thresholdReached) {
            return PreparedModelContext(current, conversation.contextCompression)
        }
        val retained = withContext(Dispatchers.Default) {
            LocalContextContract.recentContextSuffix(
                messages = current,
                maxMessages = keepRecent,
                tokenBudget = budget.longHistoryTriggerTokens,
            )
        }
        val omittedCount = (current.size - retained.size).coerceAtLeast(0)
        if (omittedCount == 0) {
            return PreparedModelContext(current, conversation.contextCompression)
        }
        val omitted = current.take(omittedCount)
        val boundedSource = withContext(Dispatchers.Default) {
            LocalContextContract.summarySource(
                omitted = omitted,
                maxChars = (budget.longHistoryTriggerTokens * 4).coerceAtMost(64_000),
            )
        }
        val summaryPrompt = buildString {
            appendLine("Compress the following earlier conversation context for continuation of the same Build.")
            appendLine("Preserve unfinished work, decisions, constraints, tool outcomes, paths, errors, and commitments.")
            appendLine("Do not invent facts. Return only the compact continuation summary.")
            appendLine()
            append(boundedSource)
        }
        val generated = chatWithEmptyRecovery(
            config = config,
            messages = listOf(ChatMessage(role = "user", content = summaryPrompt)),
            tools = emptyList(),
            intelligence = "low",
            maxOutputTokens = budget.summaryTokens,
        ).getOrNull()?.content?.trim().orEmpty()
        val fallback = generated.isBlank()
        val summary = if (fallback) {
            withContext(Dispatchers.Default) {
                LocalContextContract.fallbackSummary(omitted, budget.summaryTokens)
            }
        } else {
            generated
        }
        val compressed = listOf(
            ChatMessage(
                role = "system",
                content = "[Context Compression Summary]\n\n$summary",
            ),
            LocalContextContract.continuationAnchor(),
        ) + retained
        val compression = LocalContextCompression(
            id = "compression-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}",
            at = System.currentTimeMillis(),
            originalMessages = current.size,
            compressedMessages = compressed.size,
            originalChars = current.sumOf { it.content.length },
            compressedChars = compressed.sumOf { it.content.length },
            compressedTokens = LocalContextContract.estimateTokens(compressed),
            summary = summary,
            model = activeModelName,
            fallback = fallback,
        )
        return PreparedModelContext(compressed, compression)
    }

    /** Agent tool-call 循环：生成 build block（对齐 PC ConversationWorkRun 的事件序列 + 处理时长） */
    private suspend fun runAgentLoop(
        config: ApiConfig,
        conversationId: String,
        snapshot: List<ChatMessage>,
        executor: LocalToolExecutor,
        intelligence: String,
        thinkingTierMap: Map<String, String>,
        mode: String,
        runId: String,
        startedAt: Long,
        guideChannel: Channel<LocalGuideInput>,
        onGuideAcceptingChanged: (Boolean) -> Unit,
        anchorMessageId: String,
        branchNodeId: String,
        onProgress: (LocalWorkRun) -> Unit,
    ): AgentLoopResult {
        val events = mutableListOf(
            LocalWorkEvent(
                type = "start",
                id = "$runId:0:start",
                content = "开始",
                timestamp = startedAt,
                sequence = 0,
            ),
        )
        var sequence = 1L
        fun event(
            type: String,
            content: String = "",
            toolCallId: String = "",
            toolName: String = "",
            toolArgs: String = "",
            durationMs: Long = 0,
            displayImage: com.newmark.mobile.data.WorkDisplayImage? = null,
        ): LocalWorkEvent = LocalWorkEvent(
            type = type,
            id = "$runId:$sequence:$type",
            content = content,
            toolCallId = toolCallId,
            toolName = toolName,
            toolArgs = toolArgs,
            timestamp = System.currentTimeMillis(),
            sequence = sequence++,
            durationMs = durationMs,
            displayImage = displayImage,
        )
        val thoughtContinuation = MobileThoughtContinuation(events) { type, content, durationMs ->
            event(type = type, content = content, durationMs = durationMs)
        }
        val thoughtRequestContinuation = MobileThoughtRequestContinuation()
        fun publishCurrent(
            status: String = "running",
            endedAt: Long = 0L,
            text: String = "",
        ) {
            onProgress(
                LocalWorkRun(
                    runId = runId,
                    status = status,
                    startedAt = startedAt,
                    endedAt = endedAt,
                    expanded = true,
                    events = events.toList(),
                    mode = mode,
                    model = activeModelName,
                    text = text,
                    anchorMessageId = anchorMessageId,
                    branchNodeId = branchNodeId,
                ),
            )
        }
        fun publish(
            next: LocalWorkEvent,
            status: String = "running",
            endedAt: Long = 0L,
            text: String = "",
        ) {
            events += next
            publishCurrent(status, endedAt, text)
        }
        fun publishDeltaBatch(deltas: List<AgentUiDeltaCommand.Delta>) {
            deltas.forEach { delta ->
                if (delta.thought) {
                    thoughtContinuation.appendRoundDelta(delta.content)
                } else {
                    val last = events.lastOrNull()
                    if (last?.type == "text") {
                        events[events.lastIndex] = last.copy(content = last.content + delta.content)
                    } else {
                        events += event(type = "text", content = delta.content)
                    }
                }
            }
            publishCurrent()
        }
        val messages = snapshot.toMutableList()
        fun applyPendingGuides(): Int {
            var applied = 0
            while (true) {
                val guide = guideChannel.tryReceive().getOrNull() ?: break
                thoughtContinuation.finish(System.currentTimeMillis())?.let { publish(it) }
                val accepted = WorkGuide(
                    clientMessageId = guide.clientMessageId,
                    guideId = guide.guideId,
                    runId = runId,
                    status = "accepted",
                    content = guide.text,
                    createdAt = guide.createdAt.toString(),
                    updatedAt = System.currentTimeMillis().toString(),
                )
                publish(event(
                    type = "guide_accepted",
                    content = guide.text,
                ).copy(
                    status = "accepted",
                    clientMessageId = guide.clientMessageId,
                    guideId = guide.guideId,
                    guide = accepted,
                ))
                val appliedAt = System.currentTimeMillis()
                publish(event(
                    type = "guide_applied",
                    content = guide.text,
                ).copy(
                    status = "applied",
                    clientMessageId = guide.clientMessageId,
                    guideId = guide.guideId,
                    guide = accepted.copy(
                        status = "applied",
                        updatedAt = appliedAt.toString(),
                        appliedAt = appliedAt.toString(),
                    ),
                ))
                messages += ChatMessage(
                    role = "user",
                    content = guide.text,
                    messageId = guide.clientMessageId,
                    timestamp = guide.createdAt,
                )
                thoughtRequestContinuation.clear()
                applied++
            }
            return applied
        }
        var finalText = ""
        while (currentCoroutineContext().isActive) {
            applyPendingGuides()
            val prepared = prepareActiveLoopContext(conversationId, config, messages)
            messages.replaceWith(prepared.messages)
            val t0 = System.currentTimeMillis()
            // Publish the public activity shell before waiting on the provider.
            // This is deliberately not private chain-of-thought: it only lets
            // the Build block show "思考中" and later "进行了思考" like PC.
            if (thoughtContinuation.beginRound(t0)) publishCurrent()
            val tools = LocalTools.definitionsFor(getApplication(), mode = mode)
            val requestMessages = thoughtRequestContinuation.requestMessages(listOf(
                LocalContextContract.requestScopedTaskFocus(messages, mode, tools.size),
            ) + messages)
            val deltaPublisher = AgentUiDeltaPublisher(viewModelScope, ::publishDeltaBatch)
            val responseResult = try {
                chatWithEmptyRecovery(
                    config,
                    requestMessages,
                    tools,
                    intelligence,
                    thinkingTierMap,
                    onThoughtDelta = deltaPublisher::offerThought,
                    onTextDelta = deltaPublisher::offerText,
                )
            } finally {
                if (currentCoroutineContext().isActive) {
                    deltaPublisher.flushAndClose()
                } else {
                    deltaPublisher.cancel()
                }
            }
            val resp = responseResult.getOrElse { e ->
                finalLocalImageFallback(messages, e)?.let { return@getOrElse it }
                val msg = if (e is EmptyResponseLimitException) {
                    "模型明确返回空响应后已重试 $MAX_EMPTY_RESPONSE_RETRIES 次，仍失败，已停止本次构建。"
                } else {
                    localAgentFailureMessage(config, e)
                }
                val endedAt = System.currentTimeMillis()
                thoughtContinuation.finish(endedAt)?.let { publish(it) }
                publish(
                    event(type = "error", content = msg, durationMs = endedAt - t0),
                    status = "error",
                    endedAt = endedAt,
                    text = msg,
                )
                return AgentLoopResult(
                    run = LocalWorkRun(
                        runId = runId, status = "error",
                        startedAt = startedAt, endedAt = endedAt,
                        events = events, text = msg,
                        anchorMessageId = anchorMessageId,
                        branchNodeId = branchNodeId,
                    ),
                    modelContext = messages,
                )
            }
            val chatMs = System.currentTimeMillis() - t0
            val resolvedRoundReasoning = thoughtContinuation.endRound(resp.reasoningContent).orEmpty()

            // chatWithEmptyRecovery guarantees a usable response or returns
            // EmptyResponseLimitException only after the initial explicit
            // empty completion plus all five retries also fail. Any thought,
            // text, or tool activity resets its internal streak.

            // A thought-only provider turn may continue only when the model
            // explicitly reports output truncation. Stream silence, elapsed
            // time, EOF, and an ordinary stop state never schedule a resend.
            if (resp.content.isBlank() && resp.toolCalls.isEmpty() && resp.reasoningContent.isNotBlank()) {
                if (modelRequestedContinuation(resp.finishReason)) {
                    thoughtRequestContinuation.recordRound(resolvedRoundReasoning)
                    publishCurrent()
                    continue
                }
                val endedAt = System.currentTimeMillis()
                thoughtRequestContinuation.clear()
                thoughtContinuation.finish(endedAt)?.let { publish(it) }
                val state = resp.finishReason.ifBlank { "completed" }
                val msg = "模型返回完成状态（$state），但没有提供最终正文；未进行软件端自动重传。"
                publish(
                    event(type = "error", content = msg, durationMs = endedAt - t0),
                    status = "error",
                    endedAt = endedAt,
                    text = msg,
                )
                return AgentLoopResult(
                    run = LocalWorkRun(
                        runId = runId, status = "error",
                        startedAt = startedAt, endedAt = endedAt,
                        events = events, text = msg,
                        anchorMessageId = anchorMessageId,
                        branchNodeId = branchNodeId,
                    ),
                    modelContext = messages,
                )
            }

            thoughtRequestContinuation.clear()
            thoughtContinuation.finish(System.currentTimeMillis())?.let { publish(it) }

            if (resp.toolCalls.isEmpty()) {
                // Recovery guarantees visible content for a no-tool turn;
                // keep the persisted transcript free of synthetic empty text.
                val responseText = resp.content.trim()
                messages += ChatMessage(role = "assistant", content = responseText)
                val guidesAfterResponse = applyPendingGuides()
                if (guidesAfterResponse > 0) {
                    publish(event(type = "response", content = responseText, durationMs = chatMs))
                    continue
                }
                onGuideAcceptingChanged(false)
                finalText = responseText
                publish(event(
                    // PC 完成态由 final_response 承载，正文只在独立 Agent
                    // 消息中显示，避免 Build 内与最终消息重复一次。
                    type = "final_response", content = finalText,
                    durationMs = chatMs,
                ))
                break
            }

            messages += ChatMessage(role = "assistant", content = resp.content, toolCalls = resp.toolCalls)
            for (call in resp.toolCalls) {
                val tc0 = System.currentTimeMillis()
                publish(event(
                    type = "tool_call",
                    toolCallId = call.id,
                    toolName = call.name,
                    toolArgs = call.arguments,
                ))
                val result = if (mode == "chat" && call.name !in com.newmark.mobile.data.LocalToolCatalog.chatNames) {
                    com.newmark.mobile.data.ToolResult.err(
                        "[permission] Chat 模式仅允许 web_search 与 web_fetch；已阻断：${call.name}",
                    )
                } else if (call.name == "context_compress") {
                    val args = runCatching { JSONObject(call.arguments) }.getOrDefault(JSONObject())
                    compressActiveLoopContext(conversationId, config, messages, args)
                } else {
                    withContext(Dispatchers.IO) {
                        executor.executeTool(call.name, call.arguments, mode)
                    }
                }
                val tcMs = System.currentTimeMillis() - tc0
                publish(event(
                    type = "tool_result",
                    content = result.output,
                    toolCallId = call.id,
                    toolName = call.name,
                    durationMs = tcMs,
                    displayImage = result.displayImage,
                ))
                messages += ChatMessage(role = "tool", content = result.output, toolCallId = call.id)
            }
        }
        thoughtContinuation.finish(System.currentTimeMillis())?.let { publish(it) }
        val terminalStatus = if (finalText.isNotEmpty()) {
            publish(event(type = "done", content = "完成"))
            "completed"
        } else {
            onGuideAcceptingChanged(false)
            finalText = "已停止"
            publish(event(type = "interrupted", content = finalText))
            "interrupted"
        }
        val completed = LocalWorkRun(
            runId = runId, status = terminalStatus,
            startedAt = startedAt, endedAt = System.currentTimeMillis(),
            events = events, mode = mode, text = finalText,
            anchorMessageId = anchorMessageId,
            branchNodeId = branchNodeId,
        )
        onProgress(completed)
        return AgentLoopResult(completed, messages)
    }

    private suspend fun prepareActiveLoopContext(
        conversationId: String,
        config: ApiConfig,
        messages: List<ChatMessage>,
    ): PreparedModelContext {
        val maxTokens = activeModelConfig?.maxTokens?.takeIf { it > 0 } ?: 128_000
        val budget = withContext(Dispatchers.Default) { LocalContextContract.budget(messages, maxTokens) }
        if (!budget.thresholdReached && !budget.hardSafetyReached) return PreparedModelContext(messages, null)
        val prepared = prepareModelContext(
            config = config,
            conversation = LocalConversation(
                id = conversationId,
                title = "active-loop",
                messages = messages,
                modelContext = messages,
            ),
            displaySnapshot = messages,
            maxTokens = maxTokens,
            force = budget.hardSafetyReached,
        )
        prepared.compression?.let { compression ->
            updateConversation(conversationId) {
                it.copy(
                    modelContext = prepared.messages,
                    contextCompression = compression,
                    compressionHistory = (it.compressionHistory + compression).distinctBy { item -> item.id }.takeLast(32),
                    updatedAt = System.currentTimeMillis(),
                )
            }
        }
        return prepared
    }

    private fun MutableList<ChatMessage>.replaceWith(next: List<ChatMessage>) {
        if (this == next) return
        clear()
        addAll(next)
    }

    private suspend fun compressActiveLoopContext(
        conversationId: String,
        config: ApiConfig,
        messages: MutableList<ChatMessage>,
        args: JSONObject,
    ): com.newmark.mobile.data.ToolResult {
        val synthetic = LocalConversation(
            id = "active-loop",
            title = "active-loop",
            messages = messages,
            modelContext = messages,
        )
        val prepared = prepareModelContext(
            config = config,
            conversation = synthetic,
            displaySnapshot = messages,
            maxTokens = activeModelConfig?.maxTokens?.takeIf { it > 0 } ?: 128_000,
            force = args.optBoolean("force", true),
            keepRecent = args.optInt("keep_recent", 48).coerceIn(2, 60),
        )
        val compression = prepared.compression
            ?: return com.newmark.mobile.data.ToolResult.err("[context_compress] Compression skipped: context unchanged.")
        messages.clear()
        messages.addAll(prepared.messages)
        updateConversation(conversationId) {
            it.copy(
                modelContext = prepared.messages,
                contextCompression = compression,
                compressionHistory = (it.compressionHistory + compression)
                    .distinctBy { entry -> entry.id }
                    .takeLast(32),
                updatedAt = System.currentTimeMillis(),
            )
        }
        return com.newmark.mobile.data.ToolResult.ok(
            JSONObject()
                .put("ok", true)
                .put("compressed", true)
                .put("compression_id", compression.id)
                .put("originalMessages", compression.originalMessages)
                .put("compressedMessages", compression.compressedMessages)
                .put("compressedTokens", compression.compressedTokens)
                .put("displayHistory", JSONObject().put("untouched", true))
                .toString(),
        )
    }

    private fun updateConversation(id: String, transform: (LocalConversation) -> LocalConversation) {
        conversations = conversations.map { if (it.id == id) transform(it) else it }
        persist()
    }

    private fun updateBranchNodeMessages(
        tree: LocalConversationBranchTree?,
        nodeId: String?,
        messages: List<ChatMessage>,
    ): LocalConversationBranchTree? {
        if (tree == null || nodeId.isNullOrBlank()) return tree
        val node = tree.nodes[nodeId] ?: return tree
        return tree.copy(nodes = tree.nodes + (nodeId to node.copy(messages = messages)))
    }

    private fun createRootTree(conversation: LocalConversation): LocalConversationBranchTree {
        val rootId = UUID.randomUUID().toString()
        val root = LocalConversationBranchNode(
            id = rootId,
            messages = conversation.messages,
        )
        return LocalConversationBranchTree(
            rootNodeId = rootId,
            activeNodeId = rootId,
            viewedNodeId = rootId,
            nodes = mapOf(rootId to root),
        )
    }

    private fun branchAncestry(tree: LocalConversationBranchTree, nodeId: String): List<String> {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        var current = tree.nodes[nodeId]
        while (current != null && seen.add(current.id)) {
            result += current.id
            current = current.parentId?.let(tree.nodes::get)
        }
        return result
    }

    private fun normalizeConversationMessages(conversation: LocalConversation): LocalConversation {
        // Gson can populate a newly added non-null field as a runtime null
        // when reading an older conversations.json.  Do a full reconstruction
        // rather than calling copy(), whose generated parameter checks would
        // crash before the migration values could be applied.
        @Suppress("UNCHECKED_CAST")
        val legacyMode = conversation.mode as String?
        @Suppress("UNCHECKED_CAST")
        val legacyPlanItems = conversation.planItems as List<LocalPlanItem>?
        @Suppress("UNCHECKED_CAST")
        val legacyQueue = conversation.queuedMessages as List<LocalQueuedMessage>?
        val normalizedMode = legacyMode
            ?.lowercase()
            ?.takeIf { it in setOf("build", "plan", "chat") }
            ?: "build"
        fun normalize(messages: List<ChatMessage>, branchSeed: String): List<ChatMessage> =
            messages.mapIndexed { index, message ->
                // Gson can hydrate legacy JSON null into a Kotlin non-null String field.
                // Treat both null-at-runtime and blank ids as missing during migration.
                if (!message.messageId.isNullOrBlank()) message
                else message.copy(messageId = stableMessageId(branchSeed, index, message))
            }

        val normalizedMessages = normalize(conversation.messages, conversation.id)
        @Suppress("UNCHECKED_CAST")
        val legacyModelContext = conversation.modelContext as List<ChatMessage>?
        @Suppress("UNCHECKED_CAST")
        val legacyCompressionHistory = conversation.compressionHistory as List<LocalContextCompression>?
        val tree = conversation.branchTree?.let { existing ->
            val nodes = existing.nodes.mapValues { (nodeId, node) ->
                node.copy(messages = normalize(node.messages, "${conversation.id}:$nodeId"))
            }
            val viewed = existing.viewedNodeId.takeIf(nodes::containsKey) ?: existing.activeNodeId
            existing.copy(nodes = nodes, viewedNodeId = viewed)
        }
        val activeMessages = tree?.nodes?.get(tree.activeNodeId)?.messages ?: normalizedMessages
        return LocalConversation(
            id = conversation.id,
            title = conversation.title,
            messages = activeMessages,
            createdAt = conversation.createdAt,
            updatedAt = conversation.updatedAt,
            pinned = conversation.pinned,
            archived = conversation.archived,
            mode = normalizedMode,
            planItems = legacyPlanItems ?: emptyList(),
            queuedMessages = legacyQueue.orEmpty().mapNotNull { item ->
                @Suppress("UNCHECKED_CAST")
                val legacyText = item.text as String?
                val text = legacyText?.trim().orEmpty()
                if (text.isBlank()) null else LocalQueuedMessage(
                    id = item.id.ifBlank { UUID.randomUUID().toString() },
                    text = text,
                    createdAt = item.createdAt,
                    requestedMode = (item.requestedMode as String?)
                        ?.lowercase()?.takeIf { it in setOf("build", "plan", "chat", "goal") } ?: "build",
                    goalObjective = (item.goalObjective as String?).orEmpty(),
                )
            },
            queuePaused = conversation.queuePaused,
            inputMode = "next",
            modelContext = legacyModelContext.orEmpty(),
            contextCompression = conversation.contextCompression,
            compressionHistory = legacyCompressionHistory.orEmpty(),
            branchTree = tree,
        )
    }

    private fun stableMessageId(seed: String, index: Int, message: ChatMessage): String {
        val raw = "$seed:$index:${message.role}:${message.timestamp}:${message.content}"
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        return "m-" + digest.take(8).joinToString("") { "%02x".format(it) }
    }

    private fun persist() {
        if (loaded) conversationStore.save(conversations)
    }

    private fun deriveTitle(text: String): String =
        text.replace('\n', ' ').take(24)
}
