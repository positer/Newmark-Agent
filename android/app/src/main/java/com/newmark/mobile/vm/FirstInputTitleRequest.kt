package com.newmark.mobile.vm

import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.CONVERSATION_SAVE_FAILURE_MESSAGE
import com.newmark.mobile.data.LocalConversation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** A title is a provider request owned by the current run, including its user-stop signal. */
internal suspend fun requestAndApplyFirstInputTitle(
    apiClient: ApiClient,
    firstInput: String,
    config: ApiConfig,
    turnIntelligence: String,
    turnThinkingTierMap: Map<String, String>,
    imageAttachmentCount: Int = 0,
    onFailure: (String) -> Unit = {},
    applyTitle: suspend (String) -> Result<Boolean>,
): Boolean {
    val prompt = "Summarize the user's intent and output only a short concrete noun-phrase conversation title. " +
        "Do not quote, repeat, or truncate the input. No Markdown or explanation.\n\n" +
        "First user input:\n${firstInput.take(4000)}"
    // Keep the provider's normal connection/read policy. A slow healthy title
    // must not be discarded by an unrelated total deadline before its first token.
    var responseResult = apiClient.chat(
        config = config,
        messages = listOf(ChatMessage(role = "user", content = prompt)),
        tools = emptyList(),
        intelligence = turnIntelligence,
        thinkingTierMap = turnThinkingTierMap,
        // Reasoning shares the output budget; use the same tier budget as the formal turn.
    )
    currentCoroutineContext().ensureActive()
    (responseResult.exceptionOrNull() as? CancellationException)?.let { throw it }
    var title = responseResult.getOrNull()?.content?.let { normalizeGeneratedConversationTitle(it, firstInput) }.orEmpty()
    if (imageAttachmentCount > 0 && title.isBlank()) {
        // This auxiliary request must not need pixels or consume the main
        // turn's image attachments. Name the task from text metadata only.
        responseResult = apiClient.chat(
            config = config,
            messages = listOf(ChatMessage(role = "user", content =
                "Create a short conversation title using ONLY the text metadata below. " +
                    "There are $imageAttachmentCount image attachments, but their pixels are not available for this naming task. " +
                    "Summarize the written intent; do not infer image contents or ask to see the images. " +
                    "If the text does not specify a topic, output 图片内容分析. Output only the title.\n\n" +
                    "User text:\n${firstInput.take(4000)}")),
            tools = emptyList(),
            intelligence = "low",
            thinkingTierMap = emptyMap(),
            // Even the metadata retry needs the normal low-tier reasoning budget.
        )
        currentCoroutineContext().ensureActive()
        (responseResult.exceptionOrNull() as? CancellationException)?.let { throw it }
        title = responseResult.getOrNull()?.content?.let { normalizeGeneratedConversationTitle(it, firstInput) }.orEmpty()
        // Metadata failure is not failure of the image turn. Still use the
        // normal persistence/stale-conversation barrier below before starting.
        if (title.isBlank()) title = "图片内容分析"
    }
    if (title.isBlank()) {
        responseResult.exceptionOrNull()?.let { error ->
            onFailure(titleProviderFailureReason(error, config.apiKey))
            return false
        }
    }
    currentCoroutineContext().ensureActive()
    if (title.isBlank()) {
        onFailure("模型返回了空标题或重复了原始输入。")
        return false
    }
    // Returning success is the persistence barrier for the first formal turn.
    val application = try {
        applyTitle(title)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Exception) {
        Result.failure(failure)
    }
    currentCoroutineContext().ensureActive()
    application.exceptionOrNull()?.let { failure ->
        if (failure is CancellationException) throw failure
        onFailure(CONVERSATION_SAVE_FAILURE_MESSAGE)
        return false
    }
    val applied = application.getOrThrow()
    if (!applied) onFailure("对话状态已变化，标题未能应用。")
    return applied
}

/** Publish the title only after the complete current conversation snapshot reached storage. */
internal fun commitFirstInputConversationTitle(
    conversations: List<LocalConversation>,
    conversationId: String,
    messageId: String,
    title: String,
    persist: (List<LocalConversation>) -> Result<Unit>,
    publish: (List<LocalConversation>) -> Unit,
): Result<Boolean> {
    var eligible = false
    val updated = conversations.map { current ->
        if (current.id != conversationId) return@map current
        val firstUser = current.messages.firstOrNull { it.role == "user" }
        if (current.titleRequestMessageId != messageId || firstUser?.messageId != messageId || current.firstAgentResponseStarted) current
        else {
            eligible = true
            current.copy(title = if (current.title == "新对话") title else current.title, updatedAt = System.currentTimeMillis())
        }
    }
    if (!eligible) return Result.success(false)
    return persist(updated).map {
        publish(updated)
        true
    }
}

/** Only public HTTP status and allowlisted codes can enter the fixed UI diagnosis. */
internal fun titleProviderFailureReason(error: Throwable, apiKey: String): String {
    val raw = error.message.orEmpty()
    val status = Regex("""^HTTP ([1-5]\d{2}):""").find(raw)?.groupValues?.get(1)
    if (status != null) {
        val rawCode = runCatching {
            JSONObject(raw.substringAfter(':').trim()).optJSONObject("error")?.optString("code").orEmpty()
        }.getOrDefault("")
        val code = rawCode.takeIf {
            it != apiKey && it in setOf("get_channel_failed", "invalid_api_key", "authentication_error",
                "insufficient_quota", "insufficient_balance", "billing_hard_limit_reached",
                "rate_limit_exceeded", "model_not_found", "permission_denied")
        }.orEmpty()
        val reason = when {
            code == "get_channel_failed" -> "供应商暂无可用通道。"
            code in setOf("invalid_api_key", "authentication_error") || status == "401" -> "供应商认证失败，请检查 API Key。"
            code in setOf("insufficient_quota", "insufficient_balance", "billing_hard_limit_reached") || status == "402" -> "供应商余额、配额或支付存在问题。"
            code == "rate_limit_exceeded" || status == "429" -> "供应商请求受限，请稍后重试。"
            code == "model_not_found" || status == "404" -> "供应商接口或模型不存在，请检查配置。"
            code == "permission_denied" || status == "403" -> "供应商拒绝访问，请检查模型权限。"
            status in setOf("408", "504") -> "供应商请求超时，请稍后重试。"
            status.toInt() >= 500 -> "供应商服务暂时不可用。"
            else -> "供应商未接受标题请求，请检查接口与模型配置。"
        }
        return "HTTP $status" + code.takeIf(String::isNotBlank)?.let { " / $it" }.orEmpty() + "：$reason"
    }
    return when (error) {
        is SocketTimeoutException -> "供应商连接超时，请稍后重试。"
        is UnknownHostException -> "无法解析供应商地址，请检查接口配置和网络。"
        is ConnectException, is NoRouteToHostException -> "无法连接供应商，请检查网络或稍后重试。"
        is JSONException -> "供应商响应格式无效，请检查接口配置。"
        is IOException -> "供应商连接中断，请稍后重试。"
        else -> "标题请求未完成，请稍后重试。"
    }
}

private fun normalizeGeneratedConversationTitle(raw: String, source: String): String {
    val title = raw.lineSequence().map(String::trim).firstOrNull(String::isNotBlank).orEmpty()
        .replace(Regex("^#{1,6}\\s*|^[-*+>]\\s*"), "")
        .trim('"', '\'', '“', '”', '‘', '’')
        .replace(Regex("\\s+"), " ").trim().take(80)
    val normalizedSource = source.replace(Regex("\\s+"), " ").trim()
    if (title.length < 2 || title == normalizedSource) return ""
    return title
}
