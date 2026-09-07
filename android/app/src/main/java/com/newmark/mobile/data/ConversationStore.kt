package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CancellationException

internal const val CONVERSATION_SAVE_FAILURE_MESSAGE = "本地对话保存失败，请检查可用存储空间后重试。"

/** Same-directory rename is atomic on Android; never delete the previous snapshot to retry it. */
internal fun writeConversationSnapshotAtomically(file: File, write: (OutputStream) -> Unit): Result<Unit> {
    var staging: File? = null
    return try {
        val parent = file.absoluteFile.parentFile ?: throw IOException("Missing snapshot directory")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Snapshot directory is unavailable")
        staging = File.createTempFile(".${file.name}-", ".tmp", parent)
        FileOutputStream(staging).use { output ->
            write(output)
            output.flush()
            output.fd.sync()
        }
        if (!staging.renameTo(file)) throw IOException("Snapshot replacement failed")
        Result.success(Unit)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Exception) {
        Result.failure(failure)
    } finally {
        staging?.delete()
    }
}

/** 本地对话持久化：filesDir/newmark/conversations.json（活跃）；归档移入 archived.json 保留数据 */
class ConversationStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "conversations.json")
    private val archivedFile = File(dir, "archived.json")
    private val prefs = context.applicationContext
        .getSharedPreferences("newmark_state", Context.MODE_PRIVATE)

    /** 最近打开的本地对话；进程/Activity 重建后仍可找回当前追踪目标。 */
    fun loadActiveId(): String? =
        prefs.getString("active_local_conversation_id", null)
            ?.takeIf { it.isNotBlank() }

    fun saveActiveId(id: String?) {
        prefs.edit().apply {
            if (id.isNullOrBlank()) remove("active_local_conversation_id")
            else putString("active_local_conversation_id", id)
        }.apply()
    }

    fun load(): List<LocalConversation> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<LocalConversation>>() {}.type
            normalizeConversations(gson.fromJson<List<LocalConversation>>(file.readText(), type) ?: emptyList())
        }.getOrDefault(emptyList())
    }

    @Synchronized
    fun save(conversations: List<LocalConversation>): Result<Unit> = runCatching {
        val json = gson.toJson(conversations).toByteArray(Charsets.UTF_8)
        writeConversationSnapshotAtomically(file) { it.write(json) }.getOrThrow()
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
