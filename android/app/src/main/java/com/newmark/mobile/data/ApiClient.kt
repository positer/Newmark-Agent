package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** 一次 chat 响应：文本内容 + 可选工具调用 */
data class ChatResponse(
    val content: String = "",
    val reasoningContent: String = "",
    val toolCalls: List<ToolCall> = emptyList(),
)

internal data class ChatStreamTextDelta(val thought: String = "", val text: String = "")

internal fun parseChatStreamTextDelta(payload: String): ChatStreamTextDelta {
    val delta = JSONObject(payload)
        .optJSONArray("choices")
        ?.optJSONObject(0)
        ?.optJSONObject("delta")
        ?: return ChatStreamTextDelta()
    val thought = sequenceOf("reasoning_content", "reasoning", "thinking")
        .map(delta::optString)
        .firstOrNull(String::isNotBlank)
        .orEmpty()
    return ChatStreamTextDelta(thought = thought, text = delta.optString("content"))
}

/** OpenAI 兼容 chat/completions 客户端（流式文本/思考 + function calling） */
class ApiClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

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
                                    else -> put("content", m.content)
                                }
                            },
                        )
                    }
                })
                if (tools.isNotEmpty()) {
                    put("tools", JSONArray().apply { tools.forEach { put(it) } })
                }
            }

            val request = Request.Builder()
                .url(url)
                .addHeader("Authorization", "Bearer ${config.apiKey}")
                .addHeader("Content-Type", "application/json")
                .post(body.toString().toRequestBody(jsonMedia))
                .build()

            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    val text = resp.body?.string() ?: ""
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
                    if (streamed.thought.isNotBlank()) {
                        reasoning.append(streamed.thought)
                        onThoughtDelta(streamed.thought)
                    }
                    if (streamed.text.isNotBlank()) {
                        content.append(streamed.text)
                        onTextDelta(streamed.text)
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
                    val text = message.optString("content")
                    val thought = sequenceOf("reasoning_content", "reasoning", "thinking")
                        .map(message::optString)
                        .firstOrNull(String::isNotBlank)
                        .orEmpty()
                    content.append(text)
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
