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
    val toolCalls: List<ToolCall> = emptyList(),
)

/** OpenAI 兼容 chat/completions 客户端（非流式，支持 function calling） */
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
    ): Result<ChatResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val base = config.baseUrl.trim().trimEnd('/')
            val url = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"

            val body = JSONObject().apply {
                put("model", config.model)
                put("stream", false)
                // 智能档位真正生效（对齐 PC intelligenceConfig / applyChatReasoningEffort）
                val (temp, maxTokens, _) = intelligenceConfig(intelligence)
                put("temperature", temp)
                put("max_tokens", maxTokens)
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
                val text = resp.body?.string() ?: ""
                if (!resp.isSuccessful) {
                    error("HTTP ${resp.code}: ${text.take(200)}")
                }
                val json = JSONObject(text)
                val message = json.getJSONArray("choices").getJSONObject(0).getJSONObject("message")
                val content = if (message.isNull("content")) "" else message.optString("content", "")
                val calls = mutableListOf<ToolCall>()
                val tcArr = message.optJSONArray("tool_calls")
                if (tcArr != null) {
                    for (i in 0 until tcArr.length()) {
                        val tc = tcArr.getJSONObject(i)
                        val fn = tc.optJSONObject("function")
                        if (fn != null) {
                            calls.add(
                                ToolCall(
                                    id = tc.optString("id", ""),
                                    name = fn.optString("name", ""),
                                    arguments = fn.optString("arguments", ""),
                                ),
                            )
                        }
                    }
                }
                ChatResponse(content = content, toolCalls = calls)
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
