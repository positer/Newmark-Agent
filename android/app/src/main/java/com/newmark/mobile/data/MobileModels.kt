package com.newmark.mobile.data

/** 与桌面端的配对信息（Tailscale 内网，绑定一次保存） */
data class PairInfo(
    val host: String,
    val port: Int = 47890,
    val token: String,
) {
    val baseUrl: String get() = "http://$host:$port"
    fun isValid(): Boolean = host.isNotBlank() && token.isNotBlank()
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
)

/** 桌面端对话消息（chatMessages 元素，与 GUI 渲染契约一致） */
data class RemoteMessage(
    val role: String = "assistant", // user | assistant | system | workflow
    val content: String = "",
    val mode: String = "",
    val model: String = "",
    val timestamp: String = "",
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

/** /api/mobile/state 返回的桌面端状态 */
data class DesktopState(
    val mode: String = "",
    val model: String = "",
    val status: String = "",
    val activeConversationId: String = "",
    val conversations: List<RemoteConversation> = emptyList(),
    val chatMessages: List<RemoteMessage> = emptyList(),
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
