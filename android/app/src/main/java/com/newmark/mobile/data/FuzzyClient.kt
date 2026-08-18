package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** 模糊注入解析结果（对齐 PC parseFuzzyInput） */
data class ParsedFuzzy(
    val name: String,
    val url: String,
    val key: String,
)

/** 本地模糊注入：解析三合一文本 + 联网发现供应商 /models（对齐 PC fuzzy.ts） */
class FuzzyClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    companion object {
        private val MODEL_SUFFIXES = listOf(
            "/models", "/v1/models", "/api/v1/models",
            "/openai/v1/models", "/api/openai/v1/models", "/compatible-mode/v1/models",
        )
        private val BASE_PATH_SUFFIXES = listOf(
            "", "/v1", "/api/v1", "/openai/v1", "/api/openai/v1", "/compatible-mode/v1",
        )

        fun parseFuzzyInput(text: String): ParsedFuzzy {
            val keyMatch = Regex("(sk-[A-Za-z0-9_\\-.]{16,}|[A-Za-z0-9_\\-]{32,})").find(text)
            val urlMatch = Regex("https?://[^\\s,;]+").find(text)
            val providerMatch =
                Regex("provider\\s*[:=]\\s*([^\\s,;]+)", RegexOption.IGNORE_CASE).find(text)
                    ?: Regex("name\\s*[:=]\\s*([^\\s,;]+)", RegexOption.IGNORE_CASE).find(text)
            val lower = text.lowercase()
            var inferred = providerMatch?.groupValues?.get(1)?.trim() ?: ""
            if (inferred.isEmpty() && lower.contains("deepseek")) inferred = "DeepSeek"
            if (inferred.isEmpty() && lower.contains("openai")) inferred = "OpenAI"
            if (inferred.isEmpty() && (lower.contains("moonshot") || lower.contains("kimi"))) inferred = "Moonshot"
            if (inferred.isEmpty() && (lower.contains("qwen") || lower.contains("dashscope"))) inferred = "DashScope"
            return ParsedFuzzy(
                name = inferred.ifBlank { "Custom" },
                url = urlMatch?.value ?: "",
                key = keyMatch?.groupValues?.get(1) ?: "",
            )
        }

        fun providerNameFromUrl(baseUrl: String): String {
            return runCatching {
                val host = java.net.URI(baseUrl).host?.lowercase() ?: return "Provider"
                if (host == "localhost") return "Localhost"
                if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) return "LocalProvider"
                val parts = host.split('.').filter { it.isNotBlank() }
                val filtered = parts.filter { it !in listOf("api", "gateway", "openai", "compatible", "www") }
                val core = if (filtered.size >= 2) filtered[filtered.size - 2] else (filtered.firstOrNull() ?: "provider")
                core.split(Regex("[-_]+")).filter { it.isNotBlank() }
                    .joinToString("") { it.replaceFirstChar { c -> c.uppercase() } }
                    .ifBlank { "Provider" }
            }.getOrDefault("Provider")
        }

        private fun normalizeBaseUrl(raw: String): String {
            val value = raw.trim().trimEnd(')', ',', ';', '"', '\'')
            if (value.isEmpty()) return ""
            return runCatching {
                val u = java.net.URI(value)
                val scheme = if (u.scheme.isNullOrBlank()) "https" else u.scheme
                val host = u.host ?: return value.trimEnd('/')
                val port = if (u.port > 0) ":${u.port}" else ""
                var path = u.path?.trimEnd('/') ?: ""
                for (suffix in listOf("/chat/completions", "/completions", "/responses", "/messages", "/models")) {
                    if (path.lowercase().endsWith(suffix)) {
                        path = path.dropLast(suffix.length).trimEnd('/')
                        break
                    }
                }
                "$scheme://$host$port$path".trimEnd('/')
            }.getOrDefault(value.trimEnd('/'))
        }

        private fun candidateBaseUrls(baseUrl: String): List<String> {
            val normalized = normalizeBaseUrl(baseUrl)
            if (normalized.isEmpty()) return emptyList()
            val root = runCatching {
                val u = java.net.URI(normalized)
                val scheme = u.scheme ?: "https"
                val host = u.host ?: return emptyList()
                val port = if (u.port > 0) ":${u.port}" else ""
                "$scheme://$host$port"
            }.getOrDefault("")
            if (root.isEmpty()) return listOf(normalized)
            return BASE_PATH_SUFFIXES.map { (root + it).trimEnd('/') }.distinct()
        }
    }

    /** 联网发现供应商 /models 列表（对齐 PC probeModelList） */
    suspend fun discoverModels(
        baseUrl: String,
        apiKey: String,
        protocol: String,
        preferredModels: List<String> = emptyList(),
    ): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val bases = candidateBaseUrls(baseUrl)
            for (base in bases) {
                for (suffix in MODEL_SUFFIXES) {
                    val url = base.trimEnd('/') + suffix
                    val req = Request.Builder().url(url).get().apply {
                        if (protocol == "anthropic") {
                            addHeader("x-api-key", apiKey)
                            addHeader("anthropic-version", "2023-06-01")
                        } else {
                            addHeader("Authorization", "Bearer $apiKey")
                        }
                    }.build()
                    try {
                        client.newCall(req).execute().use { resp ->
                            val body = resp.body?.string() ?: ""
                            if (!resp.isSuccessful) return@use
                            val models = extractModels(body)
                            if (models.isNotEmpty()) return@runCatching models.take(12)
                        }
                    } catch (_: Exception) {
                        // 尝试下一个 endpoint
                    }
                }
            }
            heuristicModels(baseUrl, preferredModels)
        }
    }

    private fun extractModels(body: String): List<String> {
        return runCatching {
            val json = JSONObject(body)
            val arr = if (json.has("data")) json.getJSONArray("data")
            else if (json.has("models")) json.getJSONArray("models")
            else return emptyList()
            (0 until arr.length()).mapNotNull { i ->
                val item = arr.opt(i)
                when (item) {
                    is String -> item
                    is JSONObject -> item.optString("id").ifBlank { item.optString("name") }
                    else -> null
                }?.trim()?.takeIf { it.isNotEmpty() }
            }.distinct()
        }.getOrDefault(emptyList())
    }

    /** 未命中 /models 时的启发式候选（对齐 PC fuzzyCandidateModels） */
    private fun heuristicModels(baseUrl: String, preferred: List<String>): List<String> {
        val marker = (baseUrl).lowercase()
        val inferred = mutableListOf<String>()
        if (marker.contains("deepseek")) inferred += listOf("deepseek-chat", "deepseek-reasoner")
        if (marker.contains("openai")) inferred += listOf("gpt-4o-mini", "gpt-4.1-mini", "gpt-4o")
        if (marker.contains("moonshot") || marker.contains("kimi")) inferred += listOf("kimi-k2-0711-preview", "moonshot-v1-8k")
        if (marker.contains("dashscope") || marker.contains("qwen") || marker.contains("aliyun")) inferred += listOf("qwen-plus", "qwen-turbo")
        if (marker.contains("openrouter")) inferred += listOf("openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet")
        if (marker.contains("anthropic") || marker.contains("claude")) inferred += listOf("claude-3-5-sonnet-latest", "claude-3-5-haiku-latest")
        return (preferred + inferred + listOf("default", "chat", "model")).distinct().take(12)
    }
}
