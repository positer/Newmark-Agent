package com.newmark.mobile.data

/** 一条对话消息 */
data class ChatMessage(
    val role: String, // "user" | "assistant"
    val content: String,
    val timestamp: Long = System.currentTimeMillis(),
)

/** 本地对话（不区分工作区，持久化于本地 JSON） */
data class LocalConversation(
    val id: String,
    val title: String,
    val messages: List<ChatMessage> = emptyList(),
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
)
