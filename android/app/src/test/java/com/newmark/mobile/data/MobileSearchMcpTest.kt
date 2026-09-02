package com.newmark.mobile.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MobileSearchMcpTest {
    @Test
    fun manifestPriorityAndOrderOwnTraversalAndEveryCallStartsFresh() = runBlocking {
        val nodes = listOf(
            node("wuxing", priority = 20, order = 0),
            node("first", priority = 10, order = 2),
            node("disabled", priority = 0, order = 0, enabled = false),
            node("second", priority = 10, order = 3),
        )
        assertEquals(listOf("first", "second", "wuxing"), orderedSearchMcpNodes(nodes).map { it.name })

        val visits = mutableListOf<String>()
        repeat(2) {
            val result = traverseSearchMcpPool(
                nodes = nodes,
                bridgeSearch = { MobileSearchMcpPoolOutcome() },
                directSearch = { current ->
                    visits += current.name
                    if (current.name == "second") {
                        MobileSearchMcpPoolOutcome(
                            MobileSearchMcpResult(current.name, "result-$it"),
                            listOf(MobileSearchMcpAttempt(current.name, true)),
                        )
                    } else {
                        MobileSearchMcpPoolOutcome(attempts = listOf(MobileSearchMcpAttempt(current.name, false, "failed")))
                    }
                },
            )
            assertEquals("result-$it", result.result?.text)
        }
        assertEquals(listOf("first", "second", "wuxing", "first", "second", "wuxing"), visits)
    }

    @Test
    fun timeoutAndFailureDoNotShortCircuitRemainingEnabledNodes() = runBlocking {
        val visits = mutableListOf<String>()
        val result = traverseSearchMcpPool(
            nodes = listOf(
                node("timeout", priority = 1),
                node("winner", priority = 2),
                node("late", priority = 3),
            ),
            bridgeSearch = { MobileSearchMcpPoolOutcome() },
            directSearch = { current ->
                visits += current.name
                when (current.name) {
                    "timeout" -> MobileSearchMcpPoolOutcome(
                        attempts = listOf(MobileSearchMcpAttempt(current.name, false, "timed out")),
                    )
                    "winner" -> MobileSearchMcpPoolOutcome(
                        result = MobileSearchMcpResult(current.name, "first success"),
                        attempts = listOf(MobileSearchMcpAttempt(current.name, true)),
                    )
                    else -> MobileSearchMcpPoolOutcome(
                        result = MobileSearchMcpResult(current.name, "later success"),
                        attempts = listOf(MobileSearchMcpAttempt(current.name, true)),
                    )
                }
            },
        )

        assertEquals(listOf("timeout", "winner", "late"), visits)
        assertEquals("first success", result.result?.text)
        assertEquals(3, result.attempts.size)
    }

    @Test
    fun desktopBridgeGroupUsesOneInvocationAndDirectNodesStillRun() = runBlocking {
        val bridgeCalls = AtomicInteger()
        val directCalls = AtomicInteger()
        val nodes = listOf(
            node("Wuxing", transport = MobileSearchMcpTransport.DESKTOP_BRIDGE, priority = 1),
            node("DDG MCP", transport = MobileSearchMcpTransport.DESKTOP_BRIDGE, priority = 2),
            node("direct", transport = MobileSearchMcpTransport.STREAMABLE_HTTP, priority = 3),
        )

        val result = traverseSearchMcpPool(
            nodes,
            bridgeSearch = {
                bridgeCalls.incrementAndGet()
                assertEquals(listOf("Wuxing", "DDG MCP"), it.map(MobileSearchMcpNode::name))
                MobileSearchMcpPoolOutcome(attempts = listOf(MobileSearchMcpAttempt("desktop", false, "offline")))
            },
            directSearch = {
                directCalls.incrementAndGet()
                MobileSearchMcpPoolOutcome(MobileSearchMcpResult(it.name, "direct result"))
            },
        )

        assertEquals(1, bridgeCalls.get())
        assertEquals(1, directCalls.get())
        assertEquals("direct result", result.result?.text)
    }

    @Test
    fun desktopBridgeUsesBearerAuthenticatedMcpOnlyEndpointBeforeAndroidHttpFallbacks() {
        val api = java.io.File("src/main/java/com/newmark/mobile/data/MobileApiClient.kt").readText()
        val pool = java.io.File("src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt").readText()
        val executor = java.io.File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        val bridgeMethod = api.substringAfter("suspend fun webSearchMcp(")
            .substringBefore("suspend fun selectModel")
        assertTrue(bridgeMethod.contains("privatePost(pair, \"/api/mobile/web-search-mcp\""))
        assertFalse(bridgeMethod.contains("/api/mobile/web-search\""))
        assertTrue(pool.contains("mobileApi.webSearchMcp(pair, query)"))
        assertFalse(pool.contains("mobileApi.webSearch(pair, query)"))

        val outerFallback = executor.substringAfter("private suspend fun webSearch(query: String)")
            .substringBefore("private fun writeFileArgs")
        val mcpIndex = outerFallback.indexOf("searchMcpPool.search(query)")
        val bingIndex = outerFallback.indexOf("https://www.bing.com/search")
        val duckIndex = outerFallback.indexOf("https://html.duckduckgo.com/html")
        assertTrue(mcpIndex >= 0)
        assertTrue(bingIndex > mcpIndex)
        assertTrue(duckIndex > bingIndex)
    }

    @Test
    fun publicCatalogNamesAreDocumentedButAndroidHasOneDesktopBridgeOwner() {
        assertEquals(
            listOf(
                "Wuxing Search MCP",
                "web-search-api",
                "miyami-websearch-mcp",
                "searxng-mcp",
                "MCP Server FreeSearch",
                "@ignidor/web-search-mcp",
                "free-search-mcp",
                "DuckDuckGo MCP",
                "Free MCP Web Search Server",
            ),
            BUILT_IN_SEARCH_MCP_NAMES,
        )
        val source = java.io.File("src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt").readText()
        assertTrue(source.contains("Desktop configured search MCP pool"))
        assertFalse(source.contains("builtInSearchMcpNodes(): List<MobileSearchMcpNode> =\n    BUILT_IN_SEARCH_MCP_NAMES.mapIndexed"))
    }

    @Test
    fun onlyWebSearchToolsWithAStringQuerySchemaAreAllowed() {
        val allowed = tool(
            name = "web_search",
            description = "Search the public internet",
            properties = JSONObject().put("query", JSONObject().put("type", "string")),
        )
        assertEquals("query", allowedSearchMcpQueryArgument(allowed))

        val filesystem = tool(
            name = "search_files",
            description = "Search files on disk",
            properties = JSONObject().put("query", JSONObject().put("type", "string")),
        )
        assertNull(allowedSearchMcpQueryArgument(filesystem))

        val arbitrary = tool(
            name = "run_command",
            description = "Run any command on the internet host",
            properties = JSONObject().put("query", JSONObject().put("type", "string")),
        )
        assertNull(allowedSearchMcpQueryArgument(arbitrary))

        val objectQuery = tool(
            name = "internet_search",
            description = "Search the web",
            properties = JSONObject().put("query", JSONObject().put("type", "object")),
        )
        assertNull(allowedSearchMcpQueryArgument(objectQuery))

        val dangerous = tool(
            name = "web_search",
            description = "Search the public web",
            properties = JSONObject()
                .put("query", JSONObject().put("type", "string"))
                .put("command", JSONObject().put("type", "string")),
        )
        assertNull(allowedSearchMcpQueryArgument(dangerous))

        val implicitString = tool(
            name = "web_search",
            description = "Search the public web",
            properties = JSONObject().put("query", JSONObject()),
        )
        assertNull(allowedSearchMcpQueryArgument(implicitString))

        listOf("filePath", "commandLine", "scriptText", "format").forEach { propertyName ->
            val openSchema = tool(
                name = "web_search",
                description = "Search the public web",
                properties = JSONObject()
                    .put("query", JSONObject().put("type", "string"))
                    .put(propertyName, JSONObject().put("type", "string")),
            )
            assertNull("unknown property must close the search-only schema: $propertyName", allowedSearchMcpQueryArgument(openSchema))
        }

        val configuredQuery = tool(
            name = "internet_search",
            description = "Search the public internet",
            properties = JSONObject().put("q", JSONObject().put("type", "string")),
        )
        assertEquals("q", allowedSearchMcpQueryArgument(configuredQuery, "q"))
        assertNull(allowedSearchMcpQueryArgument(configuredQuery, "query"))
        assertNull(allowedSearchMcpQueryArgument(configuredQuery, "payload"))
    }

    @Test
    fun streamableHttpHandshakeListsThenCallsOnlyTheValidatedSearchTool() {
        val server = MockWebServer()
        server.enqueue(jsonRpcResult("newmark-search-1", JSONObject()
            .put("protocolVersion", "2025-06-18")
            .put("capabilities", JSONObject())
            .put("serverInfo", JSONObject().put("name", "fixture"))))
        server.enqueue(MockResponse().setResponseCode(202))
        server.enqueue(jsonRpcResult("newmark-search-2", JSONObject().put("tools", JSONArray()
            .put(tool("read_file", "Read a file", JSONObject().put("path", JSONObject().put("type", "string"))))
            .put(tool("web_search", "Search the public web", JSONObject()
                .put("query", JSONObject().put("type", "string"))
                .put("count", JSONObject().put("type", "integer")))))))
        server.enqueue(jsonRpcResult("newmark-search-3", JSONObject().put("content", JSONArray()
            .put(JSONObject().put("type", "text").put("text", "Example\nhttps://example.com\nSnippet")))))
        server.start()
        try {
            val node = node(
                name = "fixture",
                transport = MobileSearchMcpTransport.STREAMABLE_HTTP,
                url = server.url("/mcp").toString(),
                toolName = "web_search",
            )
            val result = SearchOnlyHttpMcpClient(OkHttpClient()).search(node, "newmark").getOrThrow()

            assertEquals("fixture", result.provider)
            assertTrue(result.text.contains("https://example.com"))
            val initRequest = server.takeRequest()
            val initializedRequest = server.takeRequest()
            val listRequest = server.takeRequest()
            val callRequest = server.takeRequest()
            listOf(initRequest, initializedRequest, listRequest, callRequest).forEach {
                assertEquals("POST", it.method)
                assertEquals("/mcp", it.path)
            }
            val init = JSONObject(initRequest.body.readUtf8())
            val initialized = JSONObject(initializedRequest.body.readUtf8())
            val list = JSONObject(listRequest.body.readUtf8())
            val call = JSONObject(callRequest.body.readUtf8())
            assertEquals("initialize", init.getString("method"))
            assertEquals("notifications/initialized", initialized.getString("method"))
            assertEquals("tools/list", list.getString("method"))
            assertEquals("tools/call", call.getString("method"))
            assertEquals("web_search", call.getJSONObject("params").getString("name"))
            assertEquals("newmark", call.getJSONObject("params").getJSONObject("arguments").getString("query"))
            assertFalse(call.toString().contains("read_file"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun streamableHttpRejectsAResponseForAnotherJsonRpcRequest() {
        val server = MockWebServer()
        server.enqueue(jsonRpcResult("unrelated-request", JSONObject()
            .put("protocolVersion", "2025-06-18")
            .put("capabilities", JSONObject())))
        server.start()
        try {
            val result = SearchOnlyHttpMcpClient(OkHttpClient()).search(
                node(
                    name = "mismatched-id",
                    transport = MobileSearchMcpTransport.STREAMABLE_HTTP,
                    url = server.url("/mcp").toString(),
                ),
                "newmark",
            )

            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("matching id newmark-search-1"))
            assertEquals("initialize", JSONObject(server.takeRequest().body.readUtf8()).getString("method"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun eventStreamRpcResponsesCompleteTheSameSearchOnlyHandshake() {
        val server = MockWebServer()
        val initResult = JSONObject()
            .put("protocolVersion", "2025-06-18")
            .put("capabilities", JSONObject())
        val listResult = JSONObject().put("tools", JSONArray().put(
            tool("internet_search", "Search the internet for public web pages", JSONObject()
                .put("q", JSONObject().put("type", "string"))),
        ))
        val callResult = JSONObject().put("structuredContent", JSONObject().put("results", JSONArray().put(
            JSONObject().put("title", "SSE result").put("url", "https://example.org"),
        )))
        val eventStream = buildString {
            append("event: endpoint\ndata: /messages\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-1", initResult)}\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-2", listResult)}\n\n")
            append("event: message\ndata: ${rpcObject("newmark-search-3", callResult)}\n\n")
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
            val result = SearchOnlyHttpMcpClient(OkHttpClient()).search(
                node(
                    name = "sse-fixture",
                    transport = MobileSearchMcpTransport.SSE,
                    url = server.url("/sse").toString(),
                    toolName = "internet_search",
                ),
                "stream search",
            ).getOrThrow()

            assertTrue(result.text.contains("SSE result"))
            val stream = server.takeRequest()
            assertEquals("GET", stream.method)
            assertEquals("text/event-stream", stream.getHeader("Accept"))
            val posted = List(4) { JSONObject(server.takeRequest().body.readUtf8()) }
            assertEquals(
                listOf("initialize", "notifications/initialized", "tools/list", "tools/call"),
                posted.map { it.getString("method") },
            )
            val call = posted.last()
            assertEquals("stream search", call.getJSONObject("params").getJSONObject("arguments").getString("q"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun legacySseRejectsCrossOriginMessageEndpointWithoutForwardingCredentials() {
        val origin = MockWebServer()
        val attacker = MockWebServer()
        attacker.start()
        origin.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody("event: endpoint\ndata: ${attacker.url("/messages")}\n\n"),
        )
        origin.start()
        try {
            val result = SearchOnlyHttpMcpClient(OkHttpClient()).search(
                node(
                    name = "credentialed-sse",
                    transport = MobileSearchMcpTransport.SSE,
                    url = origin.url("/sse").toString(),
                ).copy(
                    headers = mapOf("Authorization" to "Bearer fixture-secret"),
                    timeoutMs = 1_000L,
                ),
                "private query",
            )

            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("configured origin"))
            val sourceRequest = origin.takeRequest(1, TimeUnit.SECONDS)
            assertNotNull(sourceRequest)
            assertEquals("Bearer fixture-secret", sourceRequest?.getHeader("Authorization"))
            assertNull("cross-origin endpoint must receive neither request nor Authorization", attacker.takeRequest(300, TimeUnit.MILLISECONDS))
        } finally {
            origin.shutdown()
            attacker.shutdown()
        }
    }

    @Test
    fun sseAndStructuredContentAreNormalizedWithoutExecutingInstructions() {
        val body = "event: message\n" +
            "data: {\"jsonrpc\":\"2.0\",\"id\":\"one\",\"result\":{\"ok\":true}}\n\n"
        val messages = parseJsonRpcMessages(body)
        assertEquals(1, messages.size)
        assertTrue(messages.single().getJSONObject("result").getBoolean("ok"))

        val normalized = normalizeSearchMcpCallResult(JSONObject()
            .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "plain")))
            .put("structuredContent", JSONObject().put("results", JSONArray().put(
                JSONObject().put("title", "Result").put("url", "https://example.com"),
            )))).getOrThrow()
        assertTrue(normalized.contains("plain"))
        assertTrue(normalized.contains("https://example.com"))
        assertTrue(normalizeSearchMcpCallResult(JSONObject().put("isError", true)).isFailure)
        assertTrue(normalizeSearchMcpCallResult(JSONObject()
            .put("structuredContent", JSONObject().put("success", false).put("error", "backend unavailable"))).isFailure)
        assertTrue(normalizeSearchMcpCallResult(JSONObject()
            .put("structuredContent", JSONObject().put("ok", false))).isFailure)
        assertTrue(normalizeSearchMcpCallResult(JSONObject()
            .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "{\"success\":false,\"message\":\"offline\"}")))).isFailure)
        assertTrue(normalizeSearchMcpCallResult(JSONObject()
            .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "No results found.")))).isFailure)
    }

    @Test
    fun desktopBridgeAttemptsAcceptPcNameStatusAndAndroidProviderOkShapes() {
        val attempts = parseDesktopSearchMcpAttempts(
            JSONArray()
                .put(JSONObject().put("name", "Wuxing").put("status", "success"))
                .put(JSONObject().put("name", "SearXNG").put("status", "error").put("error", "offline"))
                .put(JSONObject().put("provider", "custom").put("ok", false).put("reason", "empty")),
            "desktop",
        )
        assertEquals(listOf("Wuxing", "SearXNG", "custom"), attempts.map(MobileSearchMcpAttempt::provider))
        assertEquals(listOf(true, false, false), attempts.map(MobileSearchMcpAttempt::ok))
        assertEquals("offline", attempts[1].reason)
        assertEquals("empty", attempts[2].reason)
    }

    @Test
    fun desktopBridgeDoesNotDuplicatePcAttemptSummaries() {
        val source = java.io.File("src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt").readText()
        val bridge = source.substringAfter("private suspend fun searchDesktopBridge")
        assertTrue(bridge.contains("val responseAttempts = parseDesktopSearchMcpAttempts"))
        assertTrue(bridge.contains("if (responseAttempts.isEmpty()) attempts += MobileSearchMcpAttempt(provider, true)"))
        assertTrue(bridge.contains("if (responseAttempts.isEmpty()) {"))
    }

    @Test
    fun clientTimeoutFailsOneDirectNodeWithoutBlockingThePool() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setBodyDelay(400, java.util.concurrent.TimeUnit.MILLISECONDS)
                .setBody(jsonRpcResultBody("newmark-search-1", JSONObject()
                    .put("protocolVersion", "2025-06-18")
                    .put("capabilities", JSONObject()))),
        )
        server.start()
        try {
            val timeoutNode = node(
                name = "slow",
                transport = MobileSearchMcpTransport.STREAMABLE_HTTP,
                url = server.url("/mcp").toString(),
            ).copy(timeoutMs = 120)
            val outcome = traverseSearchMcpPool(
                nodes = listOf(timeoutNode, node("next", priority = 1)),
                bridgeSearch = { MobileSearchMcpPoolOutcome() },
                directSearch = { current ->
                    if (current.name == "slow") {
                        SearchOnlyHttpMcpClient(OkHttpClient()).search(current, "timeout").fold(
                            onSuccess = { MobileSearchMcpPoolOutcome(result = it) },
                            onFailure = { MobileSearchMcpPoolOutcome(attempts = listOf(MobileSearchMcpAttempt(current.name, false, it.message.orEmpty()))) },
                        )
                    } else {
                        MobileSearchMcpPoolOutcome(
                            result = MobileSearchMcpResult(current.name, "recovered"),
                            attempts = listOf(MobileSearchMcpAttempt(current.name, true)),
                        )
                    }
                },
            )
            assertEquals("recovered", outcome.result?.text)
            assertTrue(outcome.attempts.any { it.provider == "slow" && !it.ok })
            assertTrue(outcome.attempts.any { it.provider == "next" && it.ok })
        } finally {
            server.shutdown()
        }
    }

    private fun node(
        name: String,
        enabled: Boolean = true,
        priority: Int = 0,
        order: Int = 0,
        transport: MobileSearchMcpTransport = MobileSearchMcpTransport.STREAMABLE_HTTP,
        url: String = "https://example.com/mcp",
        toolName: String = "",
    ) = MobileSearchMcpNode(
        id = name,
        name = name,
        enabled = enabled,
        priority = priority,
        order = order,
        transport = transport,
        url = url,
        toolName = toolName,
    )

    private fun tool(name: String, description: String, properties: JSONObject): JSONObject =
        JSONObject()
            .put("name", name)
            .put("description", description)
            .put("inputSchema", JSONObject()
                .put("type", "object")
                .put("properties", properties)
                .put("required", JSONArray().put(properties.keys().asSequence().firstOrNull() ?: "query")))

    private fun jsonRpcResult(id: String, result: JSONObject): MockResponse = MockResponse()
        .addHeader("Content-Type", "application/json")
        .setBody(jsonRpcResultBody(id, result))

    private fun jsonRpcResultBody(id: String, result: JSONObject): String =
        JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result).toString()

    private fun rpcObject(id: String, result: JSONObject): JSONObject =
        JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result)
}
