package com.newmark.mobile.vm

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.newmark.mobile.data.ActiveModel
import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.ConversationStore
import com.newmark.mobile.data.LocalConversation
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
import com.newmark.mobile.data.WorkGuide
import com.newmark.mobile.data.INTELLIGENCE_TIERS
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.data.ProviderStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID
import java.security.MessageDigest
import java.io.File

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
        get() = current?.mode?.lowercase()?.takeIf { it in setOf("build", "plan") } ?: "build"

    val currentQueue: List<LocalQueuedMessage>
        get() = current?.queuedMessages ?: emptyList()

    val currentQueuePaused: Boolean
        get() = current?.queuePaused ?: false

    val currentInputMode: String
        get() = "next"

    fun selectMode(mode: String) {
        val normalized = mode.lowercase()
        if (normalized !in setOf("build", "plan")) return
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
        updateProviderModels(providerId) { p ->
            if (p.models.any { it.name == n }) p
            else p.copy(models = p.models + ModelConfig(name = n))
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
                    LocalQueuedMessage(UUID.randomUUID().toString(), content),
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
            it.copy(queuedMessages = remaining, updatedAt = System.currentTimeMillis())
        }
        sendInConversation(conversationId, next.text)
    }

    /** 发送消息：本地持久化 + 调 API + 持久化回复 */
    fun send(text: String) {
        sendInConversation(currentId, text)
    }

    private fun sendInConversation(requestedConversationId: String?, text: String) {
        val content = text.trim()
        if (content.isEmpty()) return

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
        val targetMode = conv.mode.lowercase().takeIf { it in setOf("build", "plan") } ?: "build"
        val userMessage = ChatMessage(
            role = "user",
            content = content,
            messageId = UUID.randomUUID().toString(),
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
            val targetConversation = conversations.find { it.id == targetConversationId } ?: return@launch
            val snapshot = targetConversation.messages
            val executor = LocalToolExecutor(getApplication()) { name, args ->
                executeConversationTool(targetConversationId, name, args)
            }
            // 智能档位 + 模型原生思考强度映射（thinking_tier_map）随调用透传
            val tierMap = providers.asSequence()
                .flatMap { it.models.asSequence() }
                .firstOrNull { it.name == activeModelName }
                ?.thinkingTierMap ?: emptyMap()
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
                        updatedAt = System.currentTimeMillis(),
                    )
                }
            }
            val loopResult = runAgentLoop(
                apiConfig,
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
                    contextCompression = prepared.compression,
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
            drainLocalQueueIfReady(targetConversationId)
        }
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
            else -> null
        }
    }

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
    ): PreparedModelContext {
        val current = if (conversation.modelContext.isNotEmpty()) {
            conversation.modelContext
        } else {
            displaySnapshot
        }
        val budget = withContext(Dispatchers.Default) {
            LocalContextContract.budget(current, maxTokens)
        }
        if (!budget.thresholdReached) {
            return PreparedModelContext(current, conversation.contextCompression)
        }
        val retained = withContext(Dispatchers.Default) {
            LocalContextContract.recentContextSuffix(
                messages = current,
                maxMessages = 48,
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
        val generated = apiClient.chat(
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
        )
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
        fun publishThoughtDelta(delta: String) {
            val index = events.indexOfLast { it.type == "thought" && !it.completed }
            if (index >= 0) events[index] = events[index].copy(content = events[index].content + delta)
            publishCurrent()
        }
        fun publishTextDelta(delta: String) {
            val last = events.lastOrNull()
            if (last?.type == "text") {
                events[events.lastIndex] = last.copy(content = last.content + delta)
            } else {
                events += event(type = "text", content = delta)
            }
            publishCurrent()
        }
        val messages = snapshot.toMutableList()
        fun applyPendingGuides(): Int {
            var applied = 0
            while (true) {
                val guide = guideChannel.tryReceive().getOrNull() ?: break
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
                applied++
            }
            return applied
        }
        var loop = 0
        var finalText = ""
        while (loop < 6) {
            applyPendingGuides()
            val t0 = System.currentTimeMillis()
            // Publish the public activity shell before waiting on the provider.
            // This is deliberately not private chain-of-thought: it only lets
            // the Build block show "思考中" and later "进行了思考" like PC.
            publish(event(type = "thought"))
            val tools = if (mode == "plan") LocalTools.planDefinitions else LocalTools.definitions
            val resp = apiClient.chat(
                config,
                messages,
                tools,
                intelligence,
                thinkingTierMap,
                onThoughtDelta = { delta ->
                    withContext(Dispatchers.Main.immediate) { publishThoughtDelta(delta) }
                },
                onTextDelta = { delta ->
                    withContext(Dispatchers.Main.immediate) { publishTextDelta(delta) }
                },
            ).getOrElse { e ->
                val msg = "⚠️ ${e.message ?: "API 调用失败"}（请先在设置页配置 API）"
                val endedAt = System.currentTimeMillis()
                publish(event(type = "thought_result", durationMs = endedAt - t0))
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
            publish(event(type = "thought_result", content = resp.reasoningContent, durationMs = chatMs))

            if (resp.toolCalls.isEmpty()) {
                val responseText = resp.content.ifBlank { "（无回复内容）" }
                messages += ChatMessage(role = "assistant", content = responseText)
                val guidesAfterResponse = applyPendingGuides()
                if (guidesAfterResponse > 0) {
                    publish(event(type = "response", content = responseText, durationMs = chatMs))
                    loop++
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
                val result = withContext(Dispatchers.IO) {
                    executor.executeTool(call.name, call.arguments)
                }
                val tcMs = System.currentTimeMillis() - tc0
                publish(event(
                    type = "tool_result",
                    content = result.output,
                    toolCallId = call.id,
                    toolName = call.name,
                    durationMs = tcMs,
                ))
                messages += ChatMessage(role = "tool", content = result.output, toolCallId = call.id)
            }
            loop++
        }
        val terminalStatus = if (finalText.isEmpty()) {
            finalText = "⚠️ 工具调用轮次超限"
            publish(event(type = "error", content = finalText))
            "error"
        } else {
            publish(event(type = "done", content = "完成"))
            "completed"
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
            ?.takeIf { it in setOf("build", "plan") }
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
                        ?.lowercase()?.takeIf { it in setOf("build", "goal") } ?: "build",
                    goalObjective = (item.goalObjective as String?).orEmpty(),
                )
            },
            queuePaused = conversation.queuePaused,
            inputMode = "next",
            modelContext = legacyModelContext.orEmpty(),
            contextCompression = conversation.contextCompression,
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
