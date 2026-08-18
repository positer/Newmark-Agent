package com.newmark.mobile.vm

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.newmark.mobile.data.ActiveModel
import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.ConversationStore
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.data.LocalConversationBranchGroup
import com.newmark.mobile.data.LocalConversationBranchNode
import com.newmark.mobile.data.LocalConversationBranchTree
import com.newmark.mobile.data.LocalToolExecutor
import com.newmark.mobile.data.LocalTools
import com.newmark.mobile.data.LocalWorkEvent
import com.newmark.mobile.data.LocalWorkRun
import com.newmark.mobile.data.INTELLIGENCE_TIERS
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.data.ProviderStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.security.MessageDigest

/** 本地对话 + API 调用对话的正式状态管理 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {

    private val conversationStore = ConversationStore(app)
    private val providerStore = ProviderStore(app)
    private val apiClient = ApiClient()

    private val archived = conversationStore.loadArchived().toMutableList()

    /** 启动异步加载完成前不落盘，防止空列表覆盖磁盘数据 */
    private var loaded = false

    var conversations by mutableStateOf<List<LocalConversation>>(emptyList())
        private set
    var currentId by mutableStateOf<String?>(null)
        private set
    var isSending by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    private var sendJob: Job? = null

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
            val provs = providerStore.load()
            val act = providerStore.loadActive()
            withContext(Dispatchers.Main) {
                loaded = true
                // 旧版归档语义迁移：archived=true 的条目一次性移入 archived.json
                val (live, legacyArchived) = convs.partition { !it.archived }
                if (legacyArchived.isNotEmpty()) {
                    archived.addAll(0, legacyArchived)
                    conversationStore.save(live)
                    conversationStore.saveArchived(archived)
                }
                // 加载前用户可能已新建对话（内存中），合并而非覆盖
                conversations = (conversations + live)
                    .distinctBy { it.id }
                    .map(::normalizeConversationMessages)
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

    /** 所有供应商的启用模型（本地模型选择对话框候选；label 对齐 PC allModelNames：`provider / display|name`） */
    fun enabledModelOptions(): List<ModelOption> =
        providers.filter { it.enabled }.flatMap { p ->
            p.models.filter { it.enabled }.map { m ->
                ModelOption(providerId = p.id, modelName = m.name, label = "${p.label} / ${m.label}")
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
        sendJob?.cancel()
        sendJob = null
        isSending = false
    }

    /** 发送消息：本地持久化 + 调 API + 持久化回复 */
    fun send(text: String) {
        val content = text.trim()
        if (content.isEmpty() || isSending) return

        if (current == null) {
            newConversation()
        }
        var conv = current ?: return

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
                title = if (it.messages.isEmpty()) deriveTitle(content) else it.title,
                updatedAt = System.currentTimeMillis(),
                branchTree = updateBranchNodeMessages(it.branchTree, targetBranchId, nextMessages),
            )
        }

        isSending = true
        error = null
        sendJob = viewModelScope.launch {
            val snapshot = conversations.find { it.id == targetConversationId }?.messages ?: emptyList()
            val executor = LocalToolExecutor(getApplication())
            // 智能档位 + 模型原生思考强度映射（thinking_tier_map）随调用透传
            val tierMap = providers.asSequence()
                .flatMap { it.models.asSequence() }
                .firstOrNull { it.name == activeModelName }
                ?.thinkingTierMap ?: emptyMap()
            val run = runAgentLoop(apiConfig, snapshot, executor, intelligence, tierMap)
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
                    updatedAt = System.currentTimeMillis(),
                    branchTree = updateBranchNodeMessages(it.branchTree, targetBranchId, nextMessages),
                )
            }
            // 工具可能经 settings_update 改写了 providers/active 文件 → 重载设置状态（设置页与下次调用即时生效）
            reloadSettingsFromDisk()
            isSending = false
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

    /** Agent tool-call 循环：生成 build block（对齐 PC ConversationWorkRun 的事件序列 + 处理时长） */
    private suspend fun runAgentLoop(
        config: ApiConfig,
        snapshot: List<ChatMessage>,
        executor: LocalToolExecutor,
        intelligence: String,
        thinkingTierMap: Map<String, String>,
    ): LocalWorkRun {
        val runId = UUID.randomUUID().toString()
        val startedAt = System.currentTimeMillis()
        val events = mutableListOf<LocalWorkEvent>()
        var sequence = 0L
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
        events += event(type = "start", content = "开始")

        val messages = snapshot.toMutableList()
        var loop = 0
        var finalText = ""
        while (loop < 6) {
            val t0 = System.currentTimeMillis()
            val resp = apiClient.chat(config, messages, LocalTools.definitions, intelligence, thinkingTierMap).getOrElse { e ->
                val msg = "⚠️ ${e.message ?: "API 调用失败"}（请先在设置页配置 API）"
                events += event(type = "error", content = msg, durationMs = System.currentTimeMillis() - t0)
                return LocalWorkRun(
                    runId = runId, status = "error",
                    startedAt = startedAt, endedAt = System.currentTimeMillis(),
                    events = events, text = msg,
                )
            }
            val chatMs = System.currentTimeMillis() - t0

            if (resp.toolCalls.isEmpty()) {
                finalText = resp.content.ifBlank { "（无回复内容）" }
                events += event(
                    // PC 完成态由 final_response 承载，正文只在独立 Agent
                    // 消息中显示，避免 Build 内与最终消息重复一次。
                    type = "final_response", content = finalText,
                    durationMs = chatMs,
                )
                break
            }

            // assistant 在工具调用前的思考/叙述
            if (resp.content.isNotBlank()) {
                events += event(type = "thought", content = resp.content, durationMs = chatMs)
                events += event(type = "thought_result", content = resp.content)
            }
            messages += ChatMessage(role = "assistant", content = resp.content, toolCalls = resp.toolCalls)
            for (call in resp.toolCalls) {
                val tc0 = System.currentTimeMillis()
                events += event(
                    type = "tool_call",
                    toolCallId = call.id,
                    toolName = call.name,
                    toolArgs = call.arguments,
                )
                val result = executor.executeTool(call.name, call.arguments)
                val tcMs = System.currentTimeMillis() - tc0
                events += event(
                    type = "tool_result",
                    content = result.output,
                    toolCallId = call.id,
                    toolName = call.name,
                    durationMs = tcMs,
                )
                messages += ChatMessage(role = "tool", content = result.output, toolCallId = call.id)
            }
            loop++
        }
        val terminalStatus = if (finalText.isEmpty()) {
            finalText = "⚠️ 工具调用轮次超限"
            events += event(type = "error", content = finalText)
            "error"
        } else {
            events += event(type = "done", content = "完成")
            "completed"
        }
        return LocalWorkRun(
            runId = runId, status = terminalStatus,
            startedAt = startedAt, endedAt = System.currentTimeMillis(),
            events = events, text = finalText,
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
        fun normalize(messages: List<ChatMessage>, branchSeed: String): List<ChatMessage> =
            messages.mapIndexed { index, message ->
                // Gson can hydrate legacy JSON null into a Kotlin non-null String field.
                // Treat both null-at-runtime and blank ids as missing during migration.
                if (!message.messageId.isNullOrBlank()) message
                else message.copy(messageId = stableMessageId(branchSeed, index, message))
            }

        val normalizedMessages = normalize(conversation.messages, conversation.id)
        val tree = conversation.branchTree?.let { existing ->
            val nodes = existing.nodes.mapValues { (nodeId, node) ->
                node.copy(messages = normalize(node.messages, "${conversation.id}:$nodeId"))
            }
            val viewed = existing.viewedNodeId.takeIf(nodes::containsKey) ?: existing.activeNodeId
            existing.copy(nodes = nodes, viewedNodeId = viewed)
        }
        val activeMessages = tree?.nodes?.get(tree.activeNodeId)?.messages ?: normalizedMessages
        return conversation.copy(messages = activeMessages, branchTree = tree)
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
