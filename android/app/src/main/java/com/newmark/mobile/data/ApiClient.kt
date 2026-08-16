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

/** OpenAI 兼容 chat/completions 客户端（非流式） */
class ApiClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    suspend fun chat(config: ApiConfig, messages: List<ChatMessage>): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val base = config.baseUrl.trim().trimEnd('/')
                val url = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"

                val body = JSONObject().apply {
                    put("model", config.model)
                    put("stream", false)
                    put("messages", JSONArray().apply {
                        messages.forEach { m ->
                            put(
                                JSONObject().apply {
                                    put("role", m.role)
                                    put("content", m.content)
                                },
                            )
                        }
                    })
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
                    json.getJSONArray("choices")
                        .getJSONObject(0)
                        .getJSONObject("message")
                        .getString("content")
                }
            }
        }
}
