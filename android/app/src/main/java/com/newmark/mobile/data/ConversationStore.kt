package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File

/** 本地对话持久化：filesDir/newmark/conversations.json（活跃）；归档移入 archived.json 保留数据 */
class ConversationStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "conversations.json")
    private val archivedFile = File(dir, "archived.json")

    fun load(): List<LocalConversation> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<LocalConversation>>() {}.type
            normalizeConversations(gson.fromJson<List<LocalConversation>>(file.readText(), type) ?: emptyList())
        }.getOrDefault(emptyList())
    }

    fun save(conversations: List<LocalConversation>) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(conversations))
        }
    }

    fun loadArchived(): List<LocalConversation> {
        if (!archivedFile.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<LocalConversation>>() {}.type
            normalizeConversations(gson.fromJson<List<LocalConversation>>(archivedFile.readText(), type) ?: emptyList())
        }.getOrDefault(emptyList())
    }

    fun saveArchived(conversations: List<LocalConversation>) {
        runCatching {
            dir.mkdirs()
            archivedFile.writeText(gson.toJson(conversations))
        }
    }

    /**
     * 旧版 conversations.json 由 Gson 反序列化时，缺失的 imageAttachments /
     * toolCalls / messages 等 Kotlin 默认集合字段会被赋成 null（Gson 绕过
     * 构造函数直接反射赋值）。发送图片时 ApiClient 对历史消息调用
     * imageAttachments.isNotEmpty() 会触发
     * "Collection.isEmpty() on a null object reference" NPE。
     * 这里在加载后统一补齐空集合，根治旧数据。
     */
    private fun normalizeConversations(conversations: List<LocalConversation>): List<LocalConversation> {
        return conversations.map { conversation ->
            val normalizedMessages = conversation.messages
                .orEmpty()
                .map { it.copy(reasoningContent = "", imageAttachments = it.imageAttachments.orEmpty()) }
            val normalizedContext = conversation.modelContext
                .orEmpty()
                .map { it.copy(reasoningContent = "", imageAttachments = it.imageAttachments.orEmpty()) }
            val normalizedBranch = conversation.branchTree?.let { tree ->
                tree.copy(
                    nodes = tree.nodes.mapValues { (_, node) ->
                        node.copy(messages = node.messages.orEmpty().map {
                            it.copy(reasoningContent = "", imageAttachments = it.imageAttachments.orEmpty())
                        })
                    },
                )
            }
            val legacyFormalResponseExists = normalizedMessages.any { it.role == "assistant" } ||
                normalizedContext.any { it.role == "assistant" } ||
                normalizedBranch?.nodes?.values?.any { node ->
                    node.messages.any { it.role == "assistant" }
                } == true
            conversation.copy(
                firstAgentResponseStarted = conversation.firstAgentResponseStarted || legacyFormalResponseExists,
                messages = normalizedMessages,
                modelContext = normalizedContext,
                branchTree = normalizedBranch,
            )
        }
    }
}
