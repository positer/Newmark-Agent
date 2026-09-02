package com.newmark.mobile.data

/** Mechanism-level contract for steering any active local Agent run. */
internal object LocalGuideDeliveryContract {
    fun acceptsActiveRun(
        runtimeRunId: String?,
        acceptingGuide: Boolean,
        liveRunId: String?,
    ): Boolean = !runtimeRunId.isNullOrBlank() && acceptingGuide && runtimeRunId == liveRunId

    fun promptMessage(
        clientMessageId: String,
        text: String,
        createdAt: Long,
    ): ChatMessage = ChatMessage(
        role = "user",
        content = text,
        messageId = clientMessageId,
        timestamp = createdAt,
    )
}
