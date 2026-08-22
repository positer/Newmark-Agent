package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonElement
import java.io.IOException
import java.net.SocketException
import java.util.concurrent.TimeUnit

/** 一次 chat 响应：文本内容 + 可选工具调用 */
data class ChatResponse(
    val content: String = "",
    val reasoningContent: String = "",
    val toolCalls: List<ToolCall> = emptyList(),
)

internal data class ChatStreamTextDelta(val thought: String = "", val text: String = "")

/** JSONObject.optString returns the literal "null" for JSONObject.NULL. */
private fun JSONObject.optionalText(key: String): String {
    val value = opt(key)
    return when (value) {
        null, JSONObject.NULL -> ""
        is String -> value
        is JSONArray -> (0 until value.length()).joinToString("") { index ->
            value.opt(index)?.takeUnless { it == JSONObject.NULL }?.toString().orEmpty()
        }
        else -> value.toString()
    }
}

private fun JSONObject.firstText(vararg keys: String): String =
    keys.asSequence().map(::optionalText).firstOrNull(String::isNotBlank).orEmpty()

private fun JsonElement.readText(): String = when {
    isJsonNull -> ""
    isJsonPrimitive -> asString
    isJsonArray -> asJsonArray.joinToString("") { it.readText() }
    isJsonObject -> asJsonObject.run {
        sequenceOf("text", "content", "value")
            .mapNotNull { key -> get(key) }
            .map(JsonElement::readText)
            .firstOrNull(String::isNotBlank)
            .orEmpty()
    }
    else -> ""
}

private fun JsonObject.optionalText(key: String): String = get(key)?.readText().orEmpty()

private fun JsonObject.firstText(vararg keys: String): String =
    keys.asSequence().map(::optionalText).firstOrNull(String::isNotBlank).orEmpty()

internal fun parseChatStreamTextDelta(payload: String): ChatStreamTextDelta {
    val root = runCatching { JsonParser.parseString(payload).asJsonObject }.getOrNull()
        ?: return ChatStreamTextDelta()
    val choice = root.getAsJsonArray("choices")?.firstOrNull()?.asJsonObject
    val delta = choice?.getAsJsonObject("delta") ?: choice?.getAsJsonObject("message")
    if (delta != null) {
        return ChatStreamTextDelta(
            thought = delta.firstText("reasoning_content", "reasoning", "thinking", "analysis"),
            text = delta.optionalText("content"),
        )
    }
    // A few older compatible gateways wrap the same fields directly in response.
    val response = root.getAsJsonObject("response") ?: root
    return ChatStreamTextDelta(
        thought = response.firstText("reasoning_content", "reasoning", "thinking", "analysis"),
        text = response.optionalText("content"),
    )
}

internal fun appendCompatibleStreamValue(target: StringBuilder, incoming: String): String {
    if (incoming.isBlank() || incoming == "null") return ""
    val current = target.toString()
    val delta = when {
        current.isEmpty() -> incoming
        incoming == current -> ""
        incoming.startsWith(current) -> incoming.removePrefix(current)
        current.startsWith(incoming) -> ""
        else -> incoming
    }
    target.append(delta)
    return delta
}

internal fun shouldRetryWithResponses(status: Int, errorText: String): Boolean =
    status in 400..499 && Regex(
        "unsupported_api_for_model|responses api|use\\s*(?:/v1/)?responses|not supported.*chat|chat.*not.*support",
        RegexOption.IGNORE_CASE,
    ).containsMatchIn(errorText)

internal fun shouldRetryWithoutTemperature(status: Int, errorText: String): Boolean {
    if (status != 400) return false
    val error = runCatching {
        JsonParser.parseString(errorText).asJsonObject.getAsJsonObject("error")
    }.getOrNull()
    if (error?.optionalText("param")?.equals("temperature", ignoreCase = true) == true) return true
    val message = error?.optionalText("message").orEmpty().ifBlank { errorText }
    return Regex(
        "unsupported parameter[^\\n]*temperature|temperature[^\\n]*not supported",
        RegexOption.IGNORE_CASE,
    ).containsMatchIn(message)
}

internal fun isFreshConnectionRetryable(error: Throwable): Boolean =
    generateSequence(error) { it.cause }
        .filterIsInstance<SocketException>()
        .mapNotNull { it.message?.lowercase() }
        .any { message ->
            message.contains("software caused connection abort") ||
                message.contains("connection aborted")
        }

internal data class ResponsesStreamDelta(
    val thought: String = "",
    val text: String = "",
    val completed: Boolean = false,
    val toolId: String = "",
    val toolName: String = "",
    val toolArguments: String = "",
    val toolArgumentsDelta: String = "",
    val toolKey: String = "",
)

internal fun parseResponsesStreamDelta(payload: String, sseEvent: String = ""): ResponsesStreamDelta {
    val json = runCatching { JsonParser.parseString(payload).asJsonObject }.getOrNull()
        ?: return ResponsesStreamDelta()
    val type = sseEvent.ifBlank { json.optionalText("type") }
    return when (type) {
        "response.reasoning_summary_text.delta" -> ResponsesStreamDelta(thought = json.optionalText("delta"))
        "response.reasoning_summary_text.done" -> ResponsesStreamDelta(thought = json.optionalText("text"))
        "response.output_text.delta" -> ResponsesStreamDelta(text = json.optionalText("delta"))
        "response.output_item.added", "response.output_item.done" -> {
            val item = json.getAsJsonObject("item")?.takeIf { it.optionalText("type") == "function_call" }
            ResponsesStreamDelta(
                toolId = item?.optionalText("call_id").orEmpty().ifBlank { item?.optionalText("id").orEmpty() },
                toolName = item?.optionalText("name").orEmpty(),
                toolArguments = item?.optionalText("arguments").orEmpty(),
                toolKey = item?.optionalText("id").orEmpty()
                    .ifBlank { item?.optionalText("call_id").orEmpty() }
                    .ifBlank { json.optionalText("output_index") },
            )
        }
        "response.function_call_arguments.delta" -> ResponsesStreamDelta(
            toolArgumentsDelta = json.optionalText("delta"),
            toolKey = json.optionalText("item_id")
                .ifBlank { json.optionalText("call_id") }
                .ifBlank { json.optionalText("output_index") },
        )
        "response.completed" -> ResponsesStreamDelta(completed = true)
        else -> ResponsesStreamDelta()
    }
}

/** OpenAI 兼容 chat/completions 客户端（流式文本/思考 + function calling） */
class ApiClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        // A stream may run for a long time, but no provider response may be
        // silent longer than this. OkHttp resets this timeout for every read,
        // which gives the required "since last response" semantics.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build(),
) {

    companion object {
        internal const val SSE_IDLE_TIMEOUT_MS = 0L
    }

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val temperatureUnsupported = mutableSetOf<String>()

    suspend fun chat(
        config: ApiConfig,
        messages: List<ChatMessage>,
        tools: List<JSONObject> = emptyList(),
        intelligence: String = "medium",
        thinkingTierMap: Map<String, String> = emptyMap(),
        maxOutputTokens: Int? = null,
        onThoughtDelta: suspend (String) -> Unit = {},
        onTextDelta: suspend (String) -> Unit = {},
    ): Result<ChatResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val base = config.baseUrl.trim().trimEnd('/')
            val url = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"

            val body = JSONObject().apply {
                put("model", config.model)
                put("stream", true)
                // 智能档位真正生效（对齐 PC intelligenceConfig / applyChatReasoningEffort）
                val (temp, maxTokens, _) = intelligenceConfig(intelligence)
                put("temperature", temp)
                put("max_tokens", maxOutputTokens?.coerceAtLeast(1) ?: maxTokens)
                reasoningEffort(config.model, base, intelligence, thinkingTierMap)?.let { put("reasoning_effort", it) }
                put("messages", JSONArray().apply {
                    messages.forEach { m ->
                        put(
                            JSONObject().apply {
                                put("role", m.role)
                                when {
                                    m.role == "tool" -> {
                                        put("content", m.content)
                                        put("tool_call_id", m.toolCallId)
                                    }
                                    m.role == "assistant" && m.toolCalls.isNotEmpty() -> {
                                        if (m.content.isNotBlank()) put("content", m.content)
                                        put("tool_calls", JSONArray().apply {
                                            m.toolCalls.forEach { tc ->
                                                put(JSONObject().apply {
                                                    put("id", tc.id)
                                                    put("type", "function")
                                                    put("function", JSONObject().apply {
                                                        put("name", tc.name)
                                                        put("arguments", tc.arguments)
                                                    })
                                                })
                                            }
                                        })
                                    }
                                    else -> if (m.role == "user" && m.imageAttachments.isNotEmpty()) {
                                        put("content", JSONArray().apply {
                                            put(JSONObject().put("type", "text").put("text", m.content))
                                            m.imageAttachments.forEach { image ->
                                                if (image.dataUrl.startsWith("data:image/png;base64,") || image.dataUrl.startsWith("data:image/jpeg;base64,")) {
                                                    put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", image.dataUrl)))
                                                }
                                            }
                                        })
                                    } else put("content", m.content)
                                }
                            },
                        )
                    }
                })
                if (tools.isNotEmpty()) {
                    put("tools", JSONArray().apply { tools.forEach { put(it) } })
                }
            }

            executeProviderRequest(url, config.apiKey, body).use { resp ->
                if (!resp.isSuccessful) {
                    val text = resp.body?.string() ?: ""
                    if (shouldRetryWithResponses(resp.code, text)) {
                        return@runCatching executeResponses(
                            config = config,
                            base = base,
                            messages = messages,
                            tools = tools,
                            intelligence = intelligence,
                            thinkingTierMap = thinkingTierMap,
                            maxOutputTokens = maxOutputTokens,
                            onThoughtDelta = onThoughtDelta,
                            onTextDelta = onTextDelta,
                        )
                    }
                    error("HTTP ${resp.code}: ${text.take(200)}")
                }
                val source = resp.body?.source() ?: error("Empty response body")
                val content = StringBuilder()
                val reasoning = StringBuilder()
                val callIds = mutableMapOf<Int, StringBuilder>()
                val callNames = mutableMapOf<Int, StringBuilder>()
                val callArguments = mutableMapOf<Int, StringBuilder>()
                val fallbackJson = StringBuilder()
                while (!source.exhausted()) {
                    val line = source.readUtf8Line() ?: break
                    // Count any valid SSE line, including legacy heartbeat or
                    // event lines, as provider activity. The socket timeout
                    // above then measures silence after the latest activity.
                    if (!line.startsWith("data:")) {
                        if (line.isNotBlank()) fallbackJson.append(line)
                        continue
                    }
                    val payload = line.removePrefix("data:").trim()
                    if (payload.isBlank() || payload == "[DONE]") continue
                    val delta = JSONObject(payload)
                        .optJSONArray("choices")
                        ?.optJSONObject(0)
                        ?.optJSONObject("delta")
                        ?: continue
                    val streamed = parseChatStreamTextDelta(payload)
                    val thoughtDelta = appendCompatibleStreamValue(reasoning, streamed.thought)
                    if (thoughtDelta.isNotBlank()) {
                        onThoughtDelta(thoughtDelta)
                    }
                    val textDelta = appendCompatibleStreamValue(content, streamed.text)
                    if (textDelta.isNotBlank()) {
                        onTextDelta(textDelta)
                    }
                    delta.optJSONArray("tool_calls")?.let { toolCalls ->
                        for (i in 0 until toolCalls.length()) {
                            val tool = toolCalls.optJSONObject(i) ?: continue
                            val index = tool.optInt("index", i)
                            val function = tool.optJSONObject("function")
                            callIds.getOrPut(index) { StringBuilder() }.append(tool.optString("id"))
                            callNames.getOrPut(index) { StringBuilder() }.append(function?.optString("name").orEmpty())
                            callArguments.getOrPut(index) { StringBuilder() }.append(function?.optString("arguments").orEmpty())
                        }
                    }
                }
                if (fallbackJson.isNotBlank() && content.isEmpty() && reasoning.isEmpty()) {
                    val message = JSONObject(fallbackJson.toString())
                        .getJSONArray("choices").getJSONObject(0).getJSONObject("message")
                    val text = message.optionalText("content")
                    val thought = message.firstText("reasoning_content", "reasoning", "thinking", "analysis")
                    content.append(text.takeUnless { it == "null" }.orEmpty())
                    reasoning.append(thought)
                    if (thought.isNotBlank()) onThoughtDelta(thought)
                    if (text.isNotBlank()) onTextDelta(text)
                    message.optJSONArray("tool_calls")?.let { toolCalls ->
                        for (i in 0 until toolCalls.length()) {
                            val tool = toolCalls.optJSONObject(i) ?: continue
                            val function = tool.optJSONObject("function")
                            callIds.getOrPut(i) { StringBuilder() }.append(tool.optString("id"))
                            callNames.getOrPut(i) { StringBuilder() }.append(function?.optString("name").orEmpty())
                            callArguments.getOrPut(i) { StringBuilder() }.append(function?.optString("arguments").orEmpty())
                        }
                    }
                }
                val calls = (callIds.keys + callNames.keys + callArguments.keys).sorted().map { index ->
                    ToolCall(
                        id = callIds[index]?.toString().orEmpty(),
                        name = callNames[index]?.toString().orEmpty(),
                        arguments = callArguments[index]?.toString().orEmpty(),
                    )
                }
                ChatResponse(content.toString(), reasoning.toString(), calls)
            }
        }
    }

    private suspend fun executeResponses(
        config: ApiConfig,
        base: String,
        messages: List<ChatMessage>,
        tools: List<JSONObject>,
        intelligence: String,
        thinkingTierMap: Map<String, String>,
        maxOutputTokens: Int?,
        onThoughtDelta: suspend (String) -> Unit,
        onTextDelta: suspend (String) -> Unit,
    ): ChatResponse {
        val endpointBase = base
            .removeSuffix("/chat/completions")
            .removeSuffix("/responses")
            .trimEnd('/')
        val url = "$endpointBase/responses"
        val (temperature, defaultMaxTokens, _) = intelligenceConfig(intelligence)
        val body = JSONObject().apply {
            put("model", config.model)
            put("stream", true)
            put("temperature", temperature)
            put("max_output_tokens", maxOutputTokens?.coerceAtLeast(1) ?: defaultMaxTokens)
            reasoningEffort(config.model, endpointBase, intelligence, thinkingTierMap)?.let { effort ->
                put("reasoning", JSONObject().put("effort", effort).put("summary", "auto"))
            }
            put("input", responsesInput(messages))
            if (tools.isNotEmpty()) {
                put("tools", JSONArray().apply {
                    tools.forEach { tool ->
                        val function = tool.optJSONObject("function") ?: return@forEach
                        put(JSONObject().apply {
                            put("type", "function")
                            put("name", function.optString("name"))
                            put("description", function.optString("description"))
                            put("parameters", function.optJSONObject("parameters") ?: JSONObject())
                        })
                    }
                })
                put("tool_choice", "auto")
                put("parallel_tool_calls", true)
            }
        }
        executeProviderRequest(url, config.apiKey, body, acceptEventStream = true).use { resp ->
            if (!resp.isSuccessful) {
                val text = resp.body?.string().orEmpty()
                error("HTTP ${resp.code}: ${text.take(200)}")
            }
            val source = resp.body?.source() ?: error("Empty response body")
            val content = StringBuilder()
            val reasoning = StringBuilder()
            val calls = linkedMapOf<String, ToolCallAccumulator>()
            val fallbackJson = StringBuilder()
            var pendingEvent = ""
            var completed = false
            var streamError = ""
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                // Provider reads have no response deadline. Cancellation and
                // transport/provider errors are the only terminal conditions.
                when {
                    line.startsWith("event:") -> pendingEvent = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> {
                        val payload = line.removePrefix("data:").trim()
                        if (payload.isBlank() || payload == "[DONE]") continue
                        val parsed = parseResponsesStreamDelta(payload, pendingEvent)
                        pendingEvent = ""
                        val thoughtDelta = appendCompatibleStreamValue(reasoning, parsed.thought)
                        if (thoughtDelta.isNotBlank()) onThoughtDelta(thoughtDelta)
                        val textDelta = appendCompatibleStreamValue(content, parsed.text)
                        if (textDelta.isNotBlank()) onTextDelta(textDelta)
                        if (parsed.toolName.isNotBlank()) {
                            mergeResponsesTool(
                                calls,
                                parsed.toolKey,
                                parsed.toolId,
                                parsed.toolName,
                                parsed.toolArguments,
                            )
                        }
                        if (parsed.toolArgumentsDelta.isNotEmpty()) {
                            calls.getOrPut(parsed.toolKey) { ToolCallAccumulator(id = parsed.toolKey) }
                                .arguments.append(parsed.toolArgumentsDelta)
                        }
                        completed = completed || parsed.completed
                        val eventJson = runCatching { JSONObject(payload) }.getOrNull()
                        val eventType = eventJson?.optString("type").orEmpty()
                        if (eventType == "response.failed" || eventType == "response.incomplete" || eventType == "error") {
                            streamError = eventJson?.optJSONObject("error")?.optionalText("message")
                                .orEmpty().ifBlank { eventJson?.optionalText("message").orEmpty() }
                                .ifBlank { eventType }
                        }
                    }
                    line.isNotBlank() -> fallbackJson.append(line)
                }
            }
            if (streamError.isNotBlank()) error(streamError)
            if (fallbackJson.isNotBlank() && content.isEmpty() && calls.isEmpty()) {
                mergeNonStreamingResponses(fallbackJson.toString(), content, reasoning, calls)
                if (reasoning.isNotEmpty()) onThoughtDelta(reasoning.toString())
                if (content.isNotEmpty()) onTextDelta(content.toString())
                completed = true
            }
            if (!completed && content.isEmpty() && calls.isEmpty()) error("Responses stream ended before response.completed")
            return ChatResponse(
                content = content.toString(),
                reasoningContent = reasoning.toString(),
                toolCalls = calls.values.map { it.toToolCall() }.filter { it.name.isNotBlank() },
            )
        }
    }

    private fun executeProviderRequest(
        url: String,
        apiKey: String,
        originalBody: JSONObject,
        acceptEventStream: Boolean = false,
    ): Response {
        val capabilityKey = "$url|${originalBody.optString("model")}"
        val prepared = JSONObject(originalBody.toString())
        if (synchronized(temperatureUnsupported) { capabilityKey in temperatureUnsupported }) {
            prepared.remove("temperature")
        }

        fun execute(body: JSONObject): Response {
            val builder = Request.Builder()
                .url(url)
                .addHeader("Authorization", "Bearer $apiKey")
                .addHeader("Content-Type", "application/json")
            if (acceptEventStream) builder.addHeader("Accept", "text/event-stream")
            val request = builder.post(body.toString().toRequestBody(jsonMedia)).build()
            return try {
                client.newCall(request).execute()
            } catch (error: IOException) {
                if (!isFreshConnectionRetryable(error)) throw error
                // A package/desktop update can leave the first provider call
                // bound to an aborted keep-alive route. No HTTP response was
                // obtained, so evict that route and retry exactly once.
                client.connectionPool.evictAll()
                client.newCall(request).execute()
            }
        }

        var response = execute(prepared)
        if (prepared.has("temperature") && response.code == 400) {
            val errorText = response.peekBody(256L * 1024L).string()
            if (shouldRetryWithoutTemperature(response.code, errorText)) {
                synchronized(temperatureUnsupported) { temperatureUnsupported += capabilityKey }
                response.close()
                prepared.remove("temperature")
                response = execute(prepared)
            }
        }
        return response
    }

    private data class ToolCallAccumulator(
        var id: String = "",
        var name: String = "",
        val arguments: StringBuilder = StringBuilder(),
    ) {
        fun toToolCall() = ToolCall(id = id, name = name, arguments = arguments.toString().ifBlank { "{}" })
    }

    private fun responsesInput(messages: List<ChatMessage>): JSONArray = JSONArray().apply {
        messages.forEachIndexed { index, message ->
            when (message.role) {
                "tool" -> put(JSONObject().apply {
                    put("type", "function_call_output")
                    put("call_id", message.toolCallId.ifBlank { "call_newmark_recovered_$index" })
                    put("output", message.content)
                })
                "assistant" -> {
                    if (message.content.isNotBlank()) put(JSONObject().put("role", "assistant").put("content", message.content))
                    message.toolCalls.forEach { call ->
                        put(JSONObject().apply {
                            put("type", "function_call")
                            put("call_id", call.id)
                            put("name", call.name)
                            put("arguments", call.arguments.ifBlank { "{}" })
                        })
                    }
                }
                else -> {
                    val role = if (message.role == "system") "system" else "user"
                    if (role == "user" && message.imageAttachments.isNotEmpty()) {
                        put(JSONObject().put("role", role).put("content", JSONArray().apply {
                            put(JSONObject().put("type", "input_text").put("text", message.content))
                            message.imageAttachments.forEach { image ->
                                if (image.dataUrl.startsWith("data:image/png;base64,") || image.dataUrl.startsWith("data:image/jpeg;base64,")) {
                                    put(JSONObject().put("type", "input_image").put("image_url", image.dataUrl))
                                }
                            }
                        }))
                    } else put(JSONObject().put("role", role).put("content", message.content))
                }
            }
        }
    }

    private fun mergeResponsesToolItem(
        calls: MutableMap<String, ToolCallAccumulator>,
        rawKey: String,
        item: JSONObject,
    ) {
        mergeResponsesTool(
            calls = calls,
            rawKey = rawKey.ifBlank { item.optString("id") }.ifBlank { item.optString("call_id") },
            id = item.optString("call_id").ifBlank { item.optString("id") },
            name = item.optString("name"),
            arguments = item.optionalText("arguments"),
        )
    }

    private fun mergeResponsesTool(
        calls: MutableMap<String, ToolCallAccumulator>,
        rawKey: String,
        id: String,
        name: String,
        arguments: String,
    ) {
        val key = rawKey.ifBlank { id }
        val call = calls.getOrPut(key) { ToolCallAccumulator() }
        call.id = id.ifBlank { call.id }.ifBlank { key }
        call.name = name.ifBlank { call.name }
        if (arguments.isNotBlank() && arguments != call.arguments.toString()) {
            call.arguments.clear()
            call.arguments.append(arguments)
        }
    }

    private fun mergeNonStreamingResponses(
        payload: String,
        content: StringBuilder,
        reasoning: StringBuilder,
        calls: MutableMap<String, ToolCallAccumulator>,
    ) {
        val root = JSONObject(payload)
        root.optionalText("output_text").takeIf(String::isNotBlank)?.let(content::append)
        root.optJSONArray("output")?.let { output ->
            for (index in 0 until output.length()) {
                val item = output.optJSONObject(index) ?: continue
                when (item.optString("type")) {
                    "reasoning" -> item.optJSONArray("summary")?.let { summaries ->
                        for (summaryIndex in 0 until summaries.length()) {
                            reasoning.append(summaries.optJSONObject(summaryIndex)?.optionalText("text").orEmpty())
                        }
                    }
                    "message" -> item.optJSONArray("content")?.let { blocks ->
                        for (blockIndex in 0 until blocks.length()) {
                            content.append(blocks.optJSONObject(blockIndex)?.firstText("text", "refusal", "content").orEmpty())
                        }
                    }
                    "function_call" -> mergeResponsesToolItem(calls, item.optString("id"), item)
                }
            }
        }
    }

    // ---- 智能档位映射（对齐 PC provider.ts intelligenceConfig / reasoningEffort / mappedNativeEffort） ----

    /** 档位 → (temperature, max_tokens, reasoning_effort) */
    private fun intelligenceConfig(tier: String): Triple<Double, Int, String> = when (tier) {
        "low" -> Triple(0.3, 2048, "low")
        "high" -> Triple(0.8, 16384, "high")
        "xhigh" -> Triple(0.8, 32768, "xhigh")
        "max" -> Triple(0.8, 65536, "max")
        "ultra" -> Triple(0.8, 131072, "max")
        else -> Triple(0.7, 8192, "medium")
    }

    /** 模型原生思考强度档位映射（thinking_tier_map：原生档位名 → Newmark 档位，反查 + 就近降级） */
    private fun mappedNativeEffort(model: String, tier: String, map: Map<String, String>): String? {
        if (map.isEmpty()) return null
        val order = listOf("low", "medium", "high", "xhigh", "max")
        val entries = map.entries
            .filter { (_, v) -> v in order }
            .sortedBy { (_, v) -> order.indexOf(v) }
        if (entries.isEmpty()) return null
        val normalized = when {
            tier == "ultra" -> "max"
            tier in order -> tier
            else -> "medium"
        }
        entries.firstOrNull { (_, v) -> v == normalized }?.let { return it.key }
        val targetIndex = order.indexOf(normalized)
        for (i in targetIndex downTo 0) {
            entries.firstOrNull { (_, v) -> v == order[i] }?.let { return it.key }
        }
        return entries.firstOrNull()?.key
    }

    /** reasoning_effort 白名单 + ultra→max + OpenAI 官方域 max→xhigh（对齐 PC reasoningEffort） */
    private fun reasoningEffort(model: String, baseUrl: String, tier: String, thinkingTierMap: Map<String, String>): String? {
        val mapped = mappedNativeEffort(model, tier, thinkingTierMap)
        if (mapped != null) return mapped
        val whitelist = Regex(
            "^(?:gpt-5|o[134](?:-|\$)|codex)|(?:reasoner|reasoning|deepseek-r1|deepseek-reasoner|\\br1\\b)",
            RegexOption.IGNORE_CASE,
        )
        if (!whitelist.containsMatchIn(model)) return null
        val effort = when (tier) {
            "low", "high", "xhigh", "max" -> tier
            "ultra" -> "max"
            else -> "medium"
        }
        val isOfficialOpenAi = Regex("^https://(?:api\\.)?openai\\.com(?:/|\$)", RegexOption.IGNORE_CASE)
            .containsMatchIn(baseUrl)
        return if (effort == "max" && isOfficialOpenAi) "xhigh" else effort
    }
}
