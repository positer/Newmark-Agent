package com.newmark.mobile.vm

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.AppConfigStore
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.ConversationStore
import com.newmark.mobile.data.LocalConversation
import kotlinx.coroutines.launch
import java.util.UUID

/** 本地对话 + API 调用对话的正式状态管理 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {

    private val conversationStore = ConversationStore(app)
    private val configStore = AppConfigStore(app)
    private val apiClient = ApiClient()

    var conversations by mutableStateOf(conversationStore.load())
        private set
    var currentId by mutableStateOf<String?>(null)
        private set
    var isSending by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var apiConfig by mutableStateOf(configStore.load())
        private set

    init {
        if (conversations.isNotEmpty()) {
            currentId = conversations.first().id
        }
    }

    val current: LocalConversation?
        get() = conversations.find { it.id == currentId }

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

    fun saveApiConfig(config: ApiConfig) {
        apiConfig = config
        configStore.save(config)
    }

    /** 发送消息：本地持久化 + 调 API + 持久化回复 */
    fun send(text: String) {
        val content = text.trim()
        if (content.isEmpty() || isSending) return

        if (current == null) {
            newConversation()
        }
        val conv = current ?: return

        // 1. 落库用户消息
        updateConversation(conv.id) {
            it.copy(
                messages = it.messages + ChatMessage(role = "user", content = content),
                title = if (it.messages.isEmpty()) deriveTitle(content) else it.title,
                updatedAt = System.currentTimeMillis(),
            )
        }

        isSending = true
        error = null
        viewModelScope.launch {
            val snapshot = current?.messages ?: emptyList()
            val result = apiClient.chat(apiConfig, snapshot)
            val reply = result.getOrElse { e ->
                "⚠️ ${e.message ?: "API 调用失败"}（请先在设置页配置 API）"
            }
            updateConversation(conv.id) {
                it.copy(
                    messages = it.messages + ChatMessage(role = "assistant", content = reply),
                    updatedAt = System.currentTimeMillis(),
                )
            }
            if (result.isFailure) {
                error = result.exceptionOrNull()?.message ?: "API 调用失败"
            }
            isSending = false
        }
    }

    private fun updateConversation(id: String, transform: (LocalConversation) -> LocalConversation) {
        conversations = conversations.map { if (it.id == id) transform(it) else it }
        persist()
    }

    private fun persist() {
        conversationStore.save(conversations)
    }

    private fun deriveTitle(text: String): String =
        text.replace('\n', ' ').take(24)
}
