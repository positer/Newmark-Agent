package com.newmark.mobile.data

data class IncomingShare(
    val id: Long,
    val coldStart: Boolean,
    val text: String = "",
    val contentUris: List<String> = emptyList(),
    val mimeType: String = "application/octet-stream",
)

enum class IncomingShareTarget { NewLocalConversation, ActiveLocalConversation, ActiveRemoteConversation }

object IncomingShareRouter {
    fun target(coldStart: Boolean, activeRemote: Boolean): IncomingShareTarget = when {
        coldStart -> IncomingShareTarget.NewLocalConversation
        activeRemote -> IncomingShareTarget.ActiveRemoteConversation
        else -> IncomingShareTarget.ActiveLocalConversation
    }
}
