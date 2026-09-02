package com.newmark.mobile.data

import android.content.Context
import java.io.IOException
import java.io.File
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject

internal enum class MobileSearchMcpTransport {
    STREAMABLE_HTTP,
    SSE,
    DESKTOP_BRIDGE,
}

/**
 * Search-only MCP entry. Android never starts stdio child processes; stdio
 * entries are represented as [DESKTOP_BRIDGE] and executed by a paired PC.
 */
internal data class MobileSearchMcpNode(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
    val priority: Int = 0,
    val order: Int = 0,
    val transport: MobileSearchMcpTransport,
    val url: String = "",
    val headers: Map<String, String> = emptyMap(),
    val toolName: String = "",
    val queryArgument: String = "",
    val staticArgumentsJson: String = "{}",
    val timeoutMs: Long = 8_000L,
)

internal data class MobileSearchMcpResult(
    val provider: String,
    val text: String,
)

internal data class MobileSearchMcpAttempt(
    val provider: String,
    val ok: Boolean,
    val reason: String = "",
)

internal data class MobileSearchMcpPoolOutcome(
    val result: MobileSearchMcpResult? = null,
    val attempts: List<MobileSearchMcpAttempt> = emptyList(),
)

internal val BUILT_IN_SEARCH_MCP_NAMES: List<String> = listOf(
    "Wuxing Search MCP",
    "web-search-api",
    "miyami-websearch-mcp",
    "searxng-mcp",
    "MCP Server FreeSearch",
    "@ignidor/web-search-mcp",
    "free-search-mcp",
    "DuckDuckGo MCP",
    "Free MCP Web Search Server",
)

private fun builtInSearchMcpNodes(): List<MobileSearchMcpNode> = listOf(
    MobileSearchMcpNode(
        id = "desktop-configured-search-mcp-pool",
        name = "Desktop configured search MCP pool",
        enabled = true,
        priority = 0,
        order = 0,
        transport = MobileSearchMcpTransport.DESKTOP_BRIDGE,
    ),
)

internal fun orderedSearchMcpNodes(nodes: List<MobileSearchMcpNode>): List<MobileSearchMcpNode> =
    nodes.filter(MobileSearchMcpNode::enabled)
        .sortedWith(compareBy<MobileSearchMcpNode> { it.priority }.thenBy { it.order }.thenBy { it.name.lowercase() })

/**
 * Traverse a fresh enabled-node snapshot for every web_search invocation.
 * All desktop_bridge entries are sent to the paired PC once because that
 * endpoint already owns its complete configured MCP pool.
 */
internal suspend fun traverseSearchMcpPool(
    nodes: List<MobileSearchMcpNode>,
    bridgeSearch: suspend (List<MobileSearchMcpNode>) -> MobileSearchMcpPoolOutcome,
    directSearch: suspend (MobileSearchMcpNode) -> MobileSearchMcpPoolOutcome,
): MobileSearchMcpPoolOutcome {
    val ordered = orderedSearchMcpNodes(nodes)
    val attempts = mutableListOf<MobileSearchMcpAttempt>()
    var bridgeAttempted = false
    var firstResult: MobileSearchMcpResult? = null
    for (node in ordered) {
        val outcome = if (node.transport == MobileSearchMcpTransport.DESKTOP_BRIDGE) {
            if (bridgeAttempted) continue
            bridgeAttempted = true
            bridgeSearch(ordered.filter { it.transport == MobileSearchMcpTransport.DESKTOP_BRIDGE })
        } else {
            directSearch(node)
        }
        attempts += outcome.attempts
        if (firstResult == null) {
            firstResult = outcome.result?.takeIf { it.text.isNotBlank() }
        }
    }
    return MobileSearchMcpPoolOutcome(result = firstResult, attempts = attempts)
}

private fun validHttpMcpUrl(raw: String): String? {
    val value = raw.trim()
    if (value.length !in 1..4_000) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
    if (uri.userInfo != null) return null
    return uri.toASCIIString()
}

private fun effectiveHttpPort(uri: URI): Int = when {
    uri.port >= 0 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    else -> 80
}

private fun sameHttpOrigin(leftRaw: String, rightRaw: String): Boolean = runCatching {
    val left = URI(leftRaw)
    val right = URI(rightRaw)
    left.scheme.equals(right.scheme, ignoreCase = true) &&
        left.host.equals(right.host, ignoreCase = true) &&
        effectiveHttpPort(left) == effectiveHttpPort(right)
}.getOrDefault(false)

private fun searchMcpTransport(raw: String): MobileSearchMcpTransport? = when (raw.trim().lowercase()) {
    "streamable_http", "streamable-http", "http" -> MobileSearchMcpTransport.STREAMABLE_HTTP
    "sse" -> MobileSearchMcpTransport.SSE
    "desktop_bridge", "desktop-bridge", "stdio" -> MobileSearchMcpTransport.DESKTOP_BRIDGE
    else -> null
}

/** Read-only manifest loader. Unknown endpoints are never invented or probed. */
internal class MobileSearchMcpStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, "newmark/search-mcp.json")
    private val pluginStore = MobilePluginStore(context.applicationContext)

    fun load(): List<MobileSearchMcpNode> {
        val merged = linkedMapOf<String, MobileSearchMcpNode>()
        builtInSearchMcpNodes().forEach { merged[it.id] = it }
        if (file.isFile && file.length() in 1..1_000_000) {
            runCatching {
                val root = JSONObject(file.readText())
                val entries = root.optJSONArray("endpoints")
                    ?: root.optJSONArray("servers")
                    ?: root.optJSONArray("nodes")
                    ?: JSONArray()
                for (index in 0 until minOf(entries.length(), 128)) {
                    parseNode(entries.optJSONObject(index), index)?.let { merged[it.id] = it }
                }
            }
        }
        val switches = pluginStore.load().mcp.entries.associate { it.key.lowercase() to it.value }
        return merged.values.map { node ->
            node.copy(enabled = node.enabled && (switches[node.name.lowercase()] ?: true))
        }
    }

    private fun parseNode(item: JSONObject?, index: Int): MobileSearchMcpNode? {
        item ?: return null
        val name = item.optString("name").trim().take(120)
        val id = item.optString("id").trim().take(200).ifBlank {
            "user-search-${name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')}"
        }
        val transport = searchMcpTransport(item.optString("transport")) ?: return null
        if (id.isBlank() || name.isBlank()) return null
        val url = if (transport == MobileSearchMcpTransport.DESKTOP_BRIDGE) "" else {
            validHttpMcpUrl(item.optString("url")) ?: return null
        }
        val headers = linkedMapOf<String, String>()
        item.optJSONObject("headers")?.let { values ->
            values.keys().asSequence().take(32).forEach { key ->
                val cleanKey = key.trim().take(120)
                val value = values.optString(key).take(4_000)
                if (cleanKey.matches(Regex("[A-Za-z0-9!#$%&'*+.^_`|~-]+")) &&
                    cleanKey.lowercase() !in setOf("host", "content-length", "connection") &&
                    !value.contains('\r') && !value.contains('\n')
                ) headers[cleanKey] = value
            }
        }
        val staticArguments = item.optJSONObject("arguments") ?: JSONObject()
        return MobileSearchMcpNode(
            id = id,
            name = name,
            enabled = item.optBoolean("enabled", true),
            priority = item.optInt("priority", 100),
            order = item.optInt("order", index),
            transport = transport,
            url = url,
            headers = headers,
            toolName = item.optString("tool").trim().take(200),
            queryArgument = item.optString("argument")
                .ifBlank { item.optString("query_argument") }
                .trim()
                .take(120),
            staticArgumentsJson = staticArguments.toString(),
            timeoutMs = item.optLong("timeoutMs", item.optLong("timeout_ms", 8_000L))
                .coerceIn(1_000L, 30_000L),
        )
    }
}

private data class SearchMcpTool(
    val name: String,
    val description: String,
    val inputSchema: JSONObject,
)

private val SEARCH_QUERY_KEYS = listOf("query", "q", "search_query", "searchQuery", "text", "keyword", "keywords")
private val SAFE_SEARCH_ARGUMENT_KEYS = (SEARCH_QUERY_KEYS + listOf(
    "count", "limit", "max_results", "maxResults", "page", "offset",
    "language", "locale", "region", "country", "freshness", "time_range",
    "safe_search", "safesearch", "categories",
)).toSet()
private val DANGEROUS_SEARCH_ARGUMENT_KEY = Regex(
    "(?i)(?:^|_)(?:command|cmd|shell|path|file|write|delete|execute|script|code|cwd|env|headers|body|method|tool|action)(?:$|_)",
)

internal fun allowedSearchMcpQueryArgument(tool: JSONObject, configured: String = ""): String? {
    val name = tool.optString("name").trim()
    val description = tool.optString("description").trim()
    val normalizedName = name.lowercase()
    val normalizedDescription = description.lowercase()
    if (!normalizedName.contains("search") && !normalizedName.contains("query")) return null
    val webEvidence = listOf(
        "web", "internet", "online", "网页", "网络", "互联网",
        "duckduckgo", "searx", "bing", "google", "brave",
    ).any { normalizedName.contains(it) || normalizedDescription.contains(it) }
    val searchEvidence = normalizedDescription.contains("search") || normalizedDescription.contains("搜索") ||
        normalizedName.contains("search")
    if (!webEvidence || !searchEvidence) return null
    val schema = tool.optJSONObject("inputSchema") ?: tool.optJSONObject("input_schema") ?: return null
    if (schema.optString("type").ifBlank { "object" } != "object") return null
    val properties = schema.optJSONObject("properties") ?: return null
    val propertyNames = properties.keys().asSequence().toList()
    if (propertyNames.any { it !in SAFE_SEARCH_ARGUMENT_KEYS || DANGEROUS_SEARCH_ARGUMENT_KEY.containsMatchIn(it) }) return null
    val configuredKey = configured.trim()
    val queryKey = if (configuredKey.isNotBlank()) {
        if (configuredKey !in SEARCH_QUERY_KEYS) return null
        val property = properties.optJSONObject(configuredKey) ?: return null
        if (property.optString("type") != "string") return null
        configuredKey
    } else {
        SEARCH_QUERY_KEYS.firstOrNull { key ->
            properties.optJSONObject(key)?.optString("type") == "string"
        } ?: return null
    }
    val required = schema.optJSONArray("required") ?: JSONArray()
    for (index in 0 until required.length()) {
        if (required.optString(index) !in SAFE_SEARCH_ARGUMENT_KEYS) return null
    }
    return queryKey
}

private val EMPTY_OR_FAILED_SEARCH_TEXT = Regex(
    """(?is)^\s*(?:\[(?:web[_-]?search|search)]\s*)?(?:no\s+(?:search\s+)?results?(?:\s+found)?|found\s+0\s+results?|0\s+results?|未找到(?:相关)?(?:搜索)?结果|没有找到(?:相关)?(?:搜索)?结果|无(?:相关)?(?:搜索)?结果|(?:error|search\s+failed|搜索失败)\s*:)(?:\s|[.!。:]|$)""",
)

private fun meaningfulSearchError(value: Any?): Boolean = when (value) {
    null, JSONObject.NULL -> false
    is Boolean -> value
    is String -> value.isNotBlank()
    is JSONObject -> value.length() > 0
    is JSONArray -> value.length() > 0
    is Number -> value.toDouble() != 0.0
    else -> true
}

private fun structuredSearchFailure(value: Any?): String? {
    val objectValue = value as? JSONObject ?: return if (value is JSONArray && value.length() == 0) {
        "MCP search returned no structured results"
    } else null
    if (objectValue.has("success") && !objectValue.optBoolean("success", true)) {
        return "MCP search returned success=false"
    }
    if (objectValue.has("ok") && !objectValue.optBoolean("ok", true)) {
        return "MCP search returned ok=false"
    }
    if (objectValue.has("error") && meaningfulSearchError(objectValue.opt("error"))) {
        return "MCP search returned a structured error"
    }
    val results = objectValue.optJSONArray("results")
    if (results != null && results.length() == 0 &&
        objectValue.optString("answer").isBlank() && objectValue.optString("text").isBlank()
    ) {
        return "MCP search returned no structured results"
    }
    return null
}

private fun textSearchFailure(text: String): String? {
    val clean = text.trim()
    if (EMPTY_OR_FAILED_SEARCH_TEXT.containsMatchIn(clean)) return "MCP search returned an empty or failed result"
    val structured = runCatching {
        when {
            clean.startsWith("{") -> JSONObject(clean)
            clean.startsWith("[") -> JSONArray(clean)
            else -> null
        }
    }.getOrNull()
    return structuredSearchFailure(structured)
}

internal fun normalizeSearchMcpCallResult(result: JSONObject): Result<String> = runCatching {
    if (result.optBoolean("isError")) error("MCP search tool reported an error")
    structuredSearchFailure(result)?.let(::error)
    val chunks = mutableListOf<String>()
    when (val content = result.opt("content")) {
        is String -> content.trim().takeIf(String::isNotBlank)?.let(chunks::add)
        is JSONArray -> for (index in 0 until content.length()) {
            val item = content.optJSONObject(index) ?: continue
            if (item.optString("type") == "text") {
                item.optString("text").trim().takeIf(String::isNotBlank)?.let(chunks::add)
            }
        }
    }
    result.opt("structuredContent")?.takeUnless { it == JSONObject.NULL }?.let { structured ->
        structuredSearchFailure(structured)?.let(::error)
        val text = when (structured) {
            is JSONObject -> structured.toString(2)
            is JSONArray -> structured.toString(2)
            else -> structured.toString()
        }.trim()
        if (text.isNotBlank() && text !in chunks) chunks += text
    }
    chunks.forEach { textSearchFailure(it)?.let(::error) }
    chunks.joinToString("\n\n").trim().take(60_000).ifBlank { error("MCP search returned no text or structured content") }
}

internal fun parseDesktopSearchMcpAttempts(values: JSONArray?, defaultProvider: String): List<MobileSearchMcpAttempt> {
    if (values == null) return emptyList()
    return buildList {
        for (index in 0 until values.length()) {
            val item = values.optJSONObject(index) ?: continue
            val status = item.optString("status")
            val provider = item.optString("provider")
                .ifBlank { item.optString("name") }
                .ifBlank { defaultProvider }
            val ok = if (item.has("ok")) item.optBoolean("ok") else status == "success"
            val reason = item.optString("reason")
                .ifBlank { item.optString("error") }
                .ifBlank { status.takeUnless { it == "success" }.orEmpty() }
            add(MobileSearchMcpAttempt(provider, ok, reason.take(240)))
        }
    }
}

/** Minimal MCP client whose only executable surface is a validated web-search tool. */
internal class SearchOnlyHttpMcpClient(baseClient: OkHttpClient) {
    private val client = baseClient.newBuilder()
        .connectTimeout(7, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .build()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun search(node: MobileSearchMcpNode, query: String): Result<MobileSearchMcpResult> = runCatching {
        require(node.transport != MobileSearchMcpTransport.DESKTOP_BRIDGE) { "desktop bridge is not a direct HTTP MCP" }
        require(query.isNotBlank()) { "empty search query" }
        val session = RpcSession(node)
        try {
            val initialize = session.rpc(
                method = "initialize",
                params = JSONObject()
                    .put("protocolVersion", "2025-06-18")
                    .put("capabilities", JSONObject())
                    .put("clientInfo", JSONObject().put("name", "Newmark Mobile Search").put("version", "0.5.13")),
            )
            val protocolVersion = initialize.optString("protocolVersion").ifBlank { "2025-06-18" }
            session.protocolVersion = protocolVersion
            session.notify("notifications/initialized", JSONObject())
            val tools = session.listTools()
            fun allowed(tool: SearchMcpTool): Boolean = allowedSearchMcpQueryArgument(
                JSONObject().put("name", tool.name).put("description", tool.description).put("inputSchema", tool.inputSchema),
                node.queryArgument,
            ) != null
            val chosen = if (node.toolName.isNotBlank()) {
                tools.firstOrNull { it.name == node.toolName }?.takeIf(::allowed)
            } else {
                tools.firstOrNull(::allowed)
            } ?: error("MCP server exposes no allowed web-search tool")
            val queryArgument = allowedSearchMcpQueryArgument(
                JSONObject().put("name", chosen.name).put("description", chosen.description).put("inputSchema", chosen.inputSchema),
                node.queryArgument,
            ) ?: error("MCP tool failed the search-only schema boundary")
            val arguments = JSONObject(node.staticArgumentsJson)
            val properties = chosen.inputSchema.optJSONObject("properties") ?: JSONObject()
            arguments.keys().asSequence().toList().forEach { key ->
                require(key in SAFE_SEARCH_ARGUMENT_KEYS) { "static MCP argument is outside the search-only boundary: $key" }
                require(properties.has(key)) { "static MCP argument is not declared by the search schema: $key" }
            }
            arguments.put(queryArgument, query)
            val required = chosen.inputSchema.optJSONArray("required") ?: JSONArray()
            for (index in 0 until required.length()) {
                val key = required.optString(index)
                require(arguments.has(key)) { "required MCP search argument is unavailable: $key" }
            }
            val call = session.rpc(
                method = "tools/call",
                params = JSONObject().put("name", chosen.name).put("arguments", arguments),
            )
            MobileSearchMcpResult(node.name, normalizeSearchMcpCallResult(call).getOrThrow())
        } finally {
            session.close()
        }
    }

    private inner class RpcSession(private val node: MobileSearchMcpNode) {
        private var sessionId = ""
        private var requestSequence = 0
        private val legacySse = if (node.transport == MobileSearchMcpTransport.SSE) LegacySseChannel(node) else null
        var protocolVersion = ""

        fun close() {
            legacySse?.close()
        }

        fun listTools(): List<SearchMcpTool> {
            val tools = mutableListOf<SearchMcpTool>()
            var cursor = ""
            repeat(4) {
                val params = JSONObject().apply { cursor.takeIf(String::isNotBlank)?.let { put("cursor", it) } }
                val result = rpc("tools/list", params)
                val entries = result.optJSONArray("tools") ?: JSONArray()
                for (index in 0 until minOf(entries.length(), 256 - tools.size)) {
                    val item = entries.optJSONObject(index) ?: continue
                    val name = item.optString("name").trim()
                    val schema = item.optJSONObject("inputSchema") ?: item.optJSONObject("input_schema") ?: continue
                    if (name.isNotBlank()) tools += SearchMcpTool(name, item.optString("description"), schema)
                }
                cursor = result.optString("nextCursor")
                if (cursor.isBlank() || tools.size >= 256) return tools
            }
            return tools
        }

        fun notify(method: String, params: JSONObject) {
            post(JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params), expectResponse = false)
        }

        fun rpc(method: String, params: JSONObject): JSONObject {
            val id = "newmark-search-${++requestSequence}"
            val message = JSONObject()
                .put("jsonrpc", "2.0")
                .put("id", id)
                .put("method", method)
                .put("params", params)
            val responses = post(message, expectResponse = true)
            val response = responses.firstOrNull { it.optString("id") == id }
                ?: error("MCP $method returned no JSON-RPC response matching id $id")
            response.optJSONObject("error")?.let { error ->
                error("MCP $method failed: ${error.optString("message").ifBlank { "unknown error" }}")
            }
            return response.optJSONObject("result") ?: error("MCP $method returned no result")
        }

        private fun post(payload: JSONObject, expectResponse: Boolean): List<JSONObject> {
            legacySse?.let { channel ->
                return if (expectResponse) listOf(channel.rpc(payload)) else {
                    channel.notify(payload)
                    emptyList()
                }
            }
            val builder = Request.Builder()
                .url(node.url)
                .header("Accept", "application/json, text/event-stream")
                .header("Content-Type", "application/json; charset=utf-8")
            node.headers.forEach(builder::header)
            sessionId.takeIf(String::isNotBlank)?.let { builder.header("Mcp-Session-Id", it) }
            protocolVersion.takeIf(String::isNotBlank)?.let { builder.header("MCP-Protocol-Version", it) }
            val call = client.newCall(builder.post(payload.toString().toRequestBody(jsonMedia)).build())
            call.timeout().timeout(node.timeoutMs, TimeUnit.MILLISECONDS)
            val response = call.execute()
            response.use {
                if (!it.isSuccessful) error("MCP HTTP ${it.code}")
                it.header("Mcp-Session-Id")?.trim()?.takeIf(String::isNotBlank)?.let { value -> sessionId = value }
                val body = it.body?.string().orEmpty()
                if (!expectResponse && body.isBlank()) return emptyList()
                return parseJsonRpcMessages(body).ifEmpty {
                    if (expectResponse) error("MCP returned an empty response") else emptyList()
                }
            }
        }
    }

    /** Legacy MCP SSE: GET event stream -> endpoint event -> POST messages. */
    private inner class LegacySseChannel(private val node: MobileSearchMcpNode) {
        private val endpointReady = CountDownLatch(1)
        private val endpoint = AtomicReference<String>()
        private val failure = AtomicReference<Throwable>()
        private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
        private val backlog = ConcurrentHashMap<String, JSONObject>()
        private val streamCall: Call

        init {
            val request = Request.Builder()
                .url(node.url)
                .header("Accept", "text/event-stream")
                .get()
                .apply { node.headers.forEach(::header) }
                .build()
            streamCall = client.newCall(request)
            streamCall.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    fail(error)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!it.isSuccessful) {
                            fail(IOException("MCP SSE HTTP ${it.code}"))
                            return
                        }
                        val source = it.body?.source() ?: run {
                            fail(IOException("MCP SSE response has no body"))
                            return
                        }
                        var event = ""
                        val data = StringBuilder()
                        fun dispatch() {
                            val value = data.toString().trim()
                            data.clear()
                            if (event == "endpoint" && value.isNotBlank()) {
                                val resolved = runCatching { URI(node.url).resolve(value).toString() }.getOrNull()
                                val validated = resolved?.let(::validHttpMcpUrl)
                                if (validated == null) fail(IOException("MCP SSE returned an invalid endpoint"))
                                else if (!sameHttpOrigin(node.url, validated)) {
                                    fail(IOException("MCP SSE endpoint must remain on the configured origin"))
                                }
                                else {
                                    endpoint.compareAndSet(null, validated)
                                    endpointReady.countDown()
                                }
                            } else if ((event.isBlank() || event == "message") && value.isNotBlank()) {
                                runCatching { JSONObject(value) }.getOrNull()?.let { message ->
                                    val id = message.optString("id")
                                    if (id.isNotBlank()) {
                                        val future = pending.remove(id)
                                        if (future != null) future.complete(message) else backlog[id] = message
                                    }
                                }
                            }
                            event = ""
                        }
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.isBlank() -> dispatch()
                                line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                                line.startsWith("data:") -> {
                                    if (data.isNotEmpty()) data.append('\n')
                                    data.append(line.removePrefix("data:").trimStart())
                                }
                            }
                        }
                        dispatch()
                    }
                }
            })
        }

        fun rpc(payload: JSONObject): JSONObject {
            val id = payload.optString("id").ifBlank { error("legacy SSE RPC requires an id") }
            val future = CompletableFuture<JSONObject>()
            backlog.remove(id)?.let(future::complete)
            if (!future.isDone) {
                pending[id] = future
                backlog.remove(id)?.let { response ->
                    pending.remove(id)
                    future.complete(response)
                }
            }
            postMessage(payload)
            failure.get()?.let { if (!future.isDone) future.completeExceptionally(it) }
            return future.get(node.timeoutMs, TimeUnit.MILLISECONDS)
        }

        fun notify(payload: JSONObject) {
            postMessage(payload)
        }

        private fun postMessage(payload: JSONObject) {
            if (!endpointReady.await(node.timeoutMs, TimeUnit.MILLISECONDS)) {
                failure.get()?.let { throw it }
                error("MCP SSE endpoint event timed out")
            }
            failure.get()?.let { throw it }
            val target = endpoint.get() ?: error("MCP SSE endpoint is unavailable")
            val builder = Request.Builder()
                .url(target)
                .header("Accept", "application/json, text/event-stream")
                .header("Content-Type", "application/json; charset=utf-8")
                .apply { node.headers.forEach(::header) }
                .post(payload.toString().toRequestBody(jsonMedia))
            val call = client.newCall(builder.build())
            call.timeout().timeout(node.timeoutMs, TimeUnit.MILLISECONDS)
            call.execute().use { response ->
                if (!response.isSuccessful) error("MCP SSE message HTTP ${response.code}")
            }
        }

        private fun fail(error: Throwable) {
            failure.compareAndSet(null, error)
            endpointReady.countDown()
            pending.values.forEach { it.completeExceptionally(error) }
            pending.clear()
        }

        fun close() {
            streamCall.cancel()
        }
    }
}

internal fun parseJsonRpcMessages(body: String): List<JSONObject> {
    val trimmed = body.trim()
    if (trimmed.isBlank()) return emptyList()
    if (trimmed.startsWith("{")) return runCatching { listOf(JSONObject(trimmed)) }.getOrDefault(emptyList())
    val messages = mutableListOf<JSONObject>()
    val data = StringBuilder()
    fun flush() {
        val value = data.toString().trim()
        data.clear()
        if (value.isBlank() || value == "[DONE]") return
        runCatching { JSONObject(value) }.getOrNull()?.let(messages::add)
    }
    body.lineSequence().forEach { raw ->
        val line = raw.trimEnd('\r')
        when {
            line.isBlank() -> flush()
            line.startsWith("data:") -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.removePrefix("data:").trimStart())
            }
        }
    }
    flush()
    return messages
}

internal class MobileSearchMcpPool(
    context: Context,
    client: OkHttpClient,
) {
    private val appContext = context.applicationContext
    private val store = MobileSearchMcpStore(appContext)
    private val directClient = SearchOnlyHttpMcpClient(client)
    private val pairStore = PairStore(appContext)
    private val mobileApi = MobileApiClient()

    suspend fun search(query: String): MobileSearchMcpPoolOutcome = traverseSearchMcpPool(
        nodes = store.load(),
        bridgeSearch = { searchDesktopBridge(query) },
        directSearch = { node ->
            directClient.search(node, query).fold(
                onSuccess = { MobileSearchMcpPoolOutcome(it, listOf(MobileSearchMcpAttempt(node.name, true))) },
                onFailure = { MobileSearchMcpPoolOutcome(attempts = listOf(MobileSearchMcpAttempt(node.name, false, it.message.orEmpty().take(240)))) },
            )
        },
    )

    private suspend fun searchDesktopBridge(query: String): MobileSearchMcpPoolOutcome {
        val attempts = mutableListOf<MobileSearchMcpAttempt>()
        val pairs = pairStore.loadAll().filter(PairInfo::isValid)
        if (pairs.isEmpty()) {
            return MobileSearchMcpPoolOutcome(attempts = listOf(MobileSearchMcpAttempt("desktop-search-pool", false, "no paired desktop bridge")))
        }
        var firstResult: MobileSearchMcpResult? = null
        for (pair in pairs) {
            val responseResult = mobileApi.webSearchMcp(pair, query)
            val response = responseResult.getOrNull()
            if (response == null) {
                attempts += MobileSearchMcpAttempt(
                    pair.displayName,
                    false,
                    responseResult.exceptionOrNull()?.message.orEmpty().take(240),
                )
                continue
            }
            val provider = response.optString("provider").ifBlank { pair.displayName }
            val text = response.optString("text").trim()
            val responseAttempts = parseDesktopSearchMcpAttempts(response.optJSONArray("attempts"), provider)
            attempts += responseAttempts
            if (response.optBoolean("ok") && text.isNotBlank()) {
                if (responseAttempts.isEmpty()) attempts += MobileSearchMcpAttempt(provider, true)
                if (firstResult == null) firstResult = MobileSearchMcpResult(provider, text)
                continue
            }
            if (responseAttempts.isEmpty()) {
                attempts += MobileSearchMcpAttempt(provider, false, response.optString("error").take(240))
            }
        }
        return MobileSearchMcpPoolOutcome(result = firstResult, attempts = attempts)
    }
}
