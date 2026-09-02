package com.newmark.mobile.data

import android.os.Bundle
import androidx.test.InstrumentationRegistry
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Device-level admission for Android's search-only MCP compatibility layer.
 *
 * The deterministic loopback cases always run on the Android network stack.
 * The live case is opt-in because it requires host-side MCP fixtures exposed
 * through `adb reverse`; it deliberately constructs nodes in memory and never
 * writes the user's search-mcp.json before admission succeeds.
 */
class SearchOnlyHttpMcpDeviceTest {
    @Test
    fun streamableHttpCompletesInitializeListCallAndReturnsPublicUrl() {
        val server = MockWebServer()
        server.enqueue(jsonRpcResult("newmark-search-1", initializeResult("device-streamable")))
        server.enqueue(MockResponse().setResponseCode(202))
        server.enqueue(jsonRpcResult("newmark-search-2", toolsResult(includeSearch = true)))
        server.enqueue(jsonRpcResult("newmark-search-3", publicSearchResult("https://www.rfc-editor.org/rfc/rfc9110")))
        server.start()
        try {
            val result = client().search(
                node(
                    name = "device-streamable",
                    transport = MobileSearchMcpTransport.STREAMABLE_HTTP,
                    url = server.url("/mcp").toString(),
                ),
                DEVICE_QUERY,
            ).getOrThrow()

            assertPublicSearchResult(result, expectedHost = "www.rfc-editor.org")
            val requests = List(4) { server.takeRequest(2, TimeUnit.SECONDS) }
            requests.forEach { assertNotNull(it) }
            assertEquals(
                listOf("initialize", "notifications/initialized", "tools/list", "tools/call"),
                requests.map { requestMethod(it!!) },
            )
            val call = JSONObject(requests.last()!!.body.clone().readUtf8())
            assertEquals("web_search", call.getJSONObject("params").getString("name"))
            assertEquals(DEVICE_QUERY, call.getJSONObject("params").getJSONObject("arguments").getString("query"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun legacySseCompletesInitializeListCallAndReturnsPublicUrl() {
        val server = MockWebServer()
        val eventStream = buildString {
            append("event: endpoint\ndata: /messages\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-1", initializeResult("device-sse"))}\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-2", toolsResult(includeSearch = true))}\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-3", publicSearchResult("https://modelcontextprotocol.io"))}\n\n")
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.method == "GET" && request.path == "/sse" -> MockResponse()
                    .addHeader("Content-Type", "text/event-stream")
                    .setBody(eventStream)
                request.method == "POST" && request.path == "/messages" -> MockResponse().setResponseCode(202)
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        try {
            val result = client().search(
                node(
                    name = "device-sse",
                    transport = MobileSearchMcpTransport.SSE,
                    url = server.url("/sse").toString(),
                ),
                DEVICE_QUERY,
            ).getOrThrow()

            assertPublicSearchResult(result, expectedHost = "modelcontextprotocol.io")
            val stream = server.takeRequest(2, TimeUnit.SECONDS)
            assertNotNull(stream)
            assertEquals("GET", stream?.method)
            val posted = List(4) { server.takeRequest(2, TimeUnit.SECONDS) }
            posted.forEach { assertNotNull(it) }
            assertEquals(
                listOf("initialize", "notifications/initialized", "tools/list", "tools/call"),
                posted.map { requestMethod(it!!) },
            )
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun serverWithOnlyNonSearchToolsIsRejectedBeforeToolsCall() {
        val server = MockWebServer()
        server.enqueue(jsonRpcResult("newmark-search-1", initializeResult("device-forbidden")))
        server.enqueue(MockResponse().setResponseCode(202))
        server.enqueue(jsonRpcResult("newmark-search-2", toolsResult(includeSearch = false)))
        server.start()
        try {
            val result = client().search(
                node(
                    name = "device-forbidden",
                    transport = MobileSearchMcpTransport.STREAMABLE_HTTP,
                    url = server.url("/mcp").toString(),
                ),
                DEVICE_QUERY,
            )

            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("no allowed web-search tool"))
            val methods = List(3) { server.takeRequest(2, TimeUnit.SECONDS) }
                .map { requestMethod(it!!) }
            assertEquals(listOf("initialize", "notifications/initialized", "tools/list"), methods)
            assertNull("a rejected non-search catalog must never receive tools/call", server.takeRequest(300, TimeUnit.MILLISECONDS))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun liveStreamableAndLegacySseFixturesReturnRealPublicSearchResults() {
        val arguments = instrumentationArguments()
        assumeTrue(
            "Set searchMcpLiveAdmission=true and pass both fixture URLs to execute live admission",
            arguments.getString("searchMcpLiveAdmission").equals("true", ignoreCase = true),
        )
        val streamableUrl = requireArgument("searchMcpStreamableUrl")
        val sseUrl = requireArgument("searchMcpSseUrl")
        val requestedQuery = arguments.getString("searchMcpQuery")?.trim().orEmpty()
        val queries = buildList {
            if (requestedQuery.isNotBlank()) add(requestedQuery)
            addAll(LIVE_QUERIES)
        }.distinct()
        val expectedHost = arguments.getString("searchMcpExpectedHost")?.trim().orEmpty()
        val toolName = arguments.getString("searchMcpTool")?.trim().orEmpty()

        val cases = listOf(
            Triple("live-streamable", MobileSearchMcpTransport.STREAMABLE_HTTP, streamableUrl),
            Triple("live-sse", MobileSearchMcpTransport.SSE, sseUrl),
        )
        cases.forEach { (name, transport, url) ->
            assertLoopbackFixtureUrl(url)
            var lastFailure: Throwable? = null
            for (query in queries) {
                repeat(LIVE_ATTEMPTS_PER_QUERY) { attempt ->
                    val result = client().search(
                        node(name = name, transport = transport, url = url, toolName = toolName),
                        query,
                    )
                    if (result.isSuccess) {
                        assertPublicSearchResult(result.getOrThrow(), expectedHost)
                        return@forEach
                    }
                    lastFailure = result.exceptionOrNull()
                    if (attempt + 1 < LIVE_ATTEMPTS_PER_QUERY) Thread.sleep(500L * (attempt + 1))
                }
            }
            throw AssertionError("$name did not return a real public search result for any live admission query", lastFailure)
        }
    }

    private fun requireArgument(name: String): String {
        val value = instrumentationArguments().getString(name)?.trim().orEmpty()
        assertTrue("missing instrumentation argument: $name", value.isNotBlank())
        return value
    }

    @Suppress("DEPRECATION")
    private fun instrumentationArguments(): Bundle = InstrumentationRegistry.getArguments()

    private fun assertLoopbackFixtureUrl(value: String) {
        val uri = runCatching { URI(value) }.getOrNull()
        assertNotNull("invalid live MCP fixture URL", uri)
        assertEquals("live Android admission uses adb-reversed loopback HTTP fixtures only", "http", uri?.scheme?.lowercase())
        assertTrue(
            "live Android admission uses adb-reversed loopback fixtures only",
            uri?.host?.lowercase() in setOf("127.0.0.1", "localhost", "::1", "[::1]"),
        )
    }

    private fun assertPublicSearchResult(result: MobileSearchMcpResult, expectedHost: String = "") {
        assertTrue("search result text must be non-empty", result.text.isNotBlank())
        val searchableText = normalizedSearchResultText(result.text)
        val publicUrls = URL_PATTERN.findAll(searchableText)
            .mapNotNull { match -> runCatching { URI(stripUrlPunctuation(match.value)) }.getOrNull() }
            .filter(::isPublicHttpUrl)
            .toList()
        assertTrue("search result must contain at least one public HTTP(S) URL: ${result.text.take(500)}", publicUrls.isNotEmpty())
        if (expectedHost.isNotBlank()) {
            val normalized = expectedHost.lowercase().trim('.')
            assertTrue(
                "search result did not contain expected public host $normalized: ${result.text.take(500)}",
                publicUrls.any { uri ->
                    val host = uri.host.orEmpty().lowercase().trim('.')
                    host == normalized || host.endsWith(".$normalized")
                },
            )
        }
    }

    private fun normalizedSearchResultText(value: String): String = buildString {
        append(value)
        runCatching { JSONObject(value.trim()) }.getOrNull()?.let { parsed ->
            listOf("text", "answer", "url").forEach { key ->
                parsed.optString(key).takeIf(String::isNotBlank)?.let { append('\n').append(it) }
            }
            parsed.optJSONArray("results")?.let { results ->
                for (index in 0 until results.length()) {
                    when (val item = results.opt(index)) {
                        is JSONObject -> listOf("url", "link", "href").forEach { key ->
                            item.optString(key).takeIf(String::isNotBlank)?.let { append('\n').append(it) }
                        }
                        is String -> append('\n').append(item)
                    }
                }
            }
        }
    }

    private fun isPublicHttpUrl(uri: URI): Boolean {
        if (uri.scheme?.lowercase() !in setOf("http", "https")) return false
        val host = uri.host?.lowercase()?.trim('[', ']', '.') ?: return false
        if (host.isBlank() || host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false
        if (host == "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false
        val parts = host.split('.')
        val octets = parts.mapNotNull { it.toIntOrNull() }
        if (parts.size == 4 && octets.size == 4 && octets.all { it in 0..255 }) {
            val first = octets[0]
            val second = octets[1]
            if (first == 0 || first == 10 || first == 127 || first >= 224) return false
            if (first == 169 && second == 254) return false
            if (first == 172 && second in 16..31) return false
            if (first == 192 && second == 168) return false
            if (first == 100 && second in 64..127) return false
        }
        return true
    }

    private fun stripUrlPunctuation(value: String): String =
        value.trimEnd('.', ',', ';', ':', '!', '?', ')', ']', '}')

    private fun client(): SearchOnlyHttpMcpClient = SearchOnlyHttpMcpClient(OkHttpClient())

    private fun node(
        name: String,
        transport: MobileSearchMcpTransport,
        url: String,
        toolName: String = "",
    ) = MobileSearchMcpNode(
        id = name,
        name = name,
        transport = transport,
        url = url,
        toolName = toolName,
        timeoutMs = 25_000L,
    )

    private fun initializeResult(name: String): JSONObject = JSONObject()
        .put("protocolVersion", "2025-06-18")
        .put("capabilities", JSONObject())
        .put("serverInfo", JSONObject().put("name", name).put("version", "1"))

    private fun toolsResult(includeSearch: Boolean): JSONObject {
        val tools = JSONArray().put(
            tool(
                name = "read_file",
                description = "Read a file from the fixture host",
                properties = JSONObject().put("path", JSONObject().put("type", "string")),
                required = "path",
            ),
        )
        if (includeSearch) {
            tools.put(
                tool(
                    name = "web_search",
                    description = "Search the public web for current pages",
                    properties = JSONObject()
                        .put("query", JSONObject().put("type", "string"))
                        .put("limit", JSONObject().put("type", "integer")),
                    required = "query",
                ),
            )
        }
        return JSONObject().put("tools", tools)
    }

    private fun tool(
        name: String,
        description: String,
        properties: JSONObject,
        required: String,
    ): JSONObject = JSONObject()
        .put("name", name)
        .put("description", description)
        .put(
            "inputSchema",
            JSONObject()
                .put("type", "object")
                .put("properties", properties)
                .put("required", JSONArray().put(required))
                .put("additionalProperties", false),
        )

    private fun publicSearchResult(url: String): JSONObject = JSONObject()
        .put(
            "content",
            JSONArray().put(
                JSONObject()
                    .put("type", "text")
                    .put("text", "Verified public result\n$url\nAndroid MCP compatibility fixture"),
            ),
        )

    private fun jsonRpcResult(id: String, result: JSONObject): MockResponse = MockResponse()
        .addHeader("Content-Type", "application/json")
        .setBody(rpcObject(id, result).toString())

    private fun rpcObject(id: String, result: JSONObject): JSONObject = JSONObject()
        .put("jsonrpc", "2.0")
        .put("id", id)
        .put("result", result)

    private fun requestMethod(request: RecordedRequest): String =
        JSONObject(request.body.clone().readUtf8()).getString("method")

    private companion object {
        const val DEVICE_QUERY = "Android MCP stream compatibility"
        val LIVE_QUERIES = listOf("GitHub", "Android", "Model Context Protocol")
        const val LIVE_ATTEMPTS_PER_QUERY = 2
        val URL_PATTERN = Regex("""https?://[^\s\"'<>\\]+""", RegexOption.IGNORE_CASE)
    }
}
