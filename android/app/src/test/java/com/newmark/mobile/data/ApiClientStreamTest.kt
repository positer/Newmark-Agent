package com.newmark.mobile.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.SocketException
import java.util.concurrent.atomic.AtomicInteger

class ApiClientStreamTest {
    @Test
    fun nullReasoningAndContentAreIgnoredInsteadOfBecomingLiteralNull() {
        val delta = parseChatStreamTextDelta(
            "{\"choices\":[{\"delta\":{\"reasoning_content\":null,\"thinking\":null,\"content\":null}}]}",
        )

        assertEquals("", delta.thought)
        assertEquals("", delta.text)
    }

    @Test
    fun legacyReasoningAndResponseWrappersRemainReadable() {
        val chat = parseChatStreamTextDelta(
            "{\"choices\":[{\"delta\":{\"reasoning\":\"先检查\",\"content\":\"结论\"}}]}",
        )
        val response = parseChatStreamTextDelta(
            "{\"response\":{\"thinking\":\"旧思考\",\"content\":\"旧正文\"}}",
        )

        assertEquals("先检查", chat.thought)
        assertEquals("结论", chat.text)
        assertEquals("旧思考", response.thought)
        assertEquals("旧正文", response.text)
    }

    @Test
    fun bufferedMessageSseFrameIsAcceptedAsUsableResponse() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data: {\"choices\":[{\"message\":{\"content\":\"稳定响应\"}}]}\n\n" +
                        "data: [DONE]\n\n",
                ),
        )
        server.start()
        try {
            val response = ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "model"),
                messages = listOf(ChatMessage(role = "user", content = "hello")),
            ).getOrThrow()

            assertEquals("稳定响应", response.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun thoughtFollowedByTextStaysWithinOneProviderTurn() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先检查\"}}]}\n\n" +
                        "data: {\"choices\":[{\"delta\":{\"content\":\"最终答案\"}}]}\n\n" +
                        "data: [DONE]\n\n",
                ),
        )
        server.start()
        try {
            val thought = StringBuilder()
            val text = StringBuilder()
            val response = ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "model"),
                messages = listOf(ChatMessage(role = "user", content = "hello")),
                onThoughtDelta = { thought.append(it) },
                onTextDelta = { text.append(it) },
            ).getOrThrow()

            assertEquals("先检查", thought.toString())
            assertEquals("最终答案", text.toString())
            assertEquals("先检查", response.reasoningContent)
            assertEquals("最终答案", response.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun continuationReasoningIsPassedBackInTheNativeAssistantField() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"完成\"},\"finish_reason\":\"stop\"}]}\n\n" +
                        "data: [DONE]\n\n",
                ),
        )
        server.start()
        try {
            ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "deepseek-reasoner"),
                messages = listOf(
                    ChatMessage(role = "user", content = "continue"),
                    ChatMessage(
                        role = "assistant",
                        content = "",
                        reasoningContent = "checked first branch",
                    ),
                    ChatMessage(
                        role = "assistant",
                        content = "calling read",
                        reasoningContent = "checked tool branch",
                        toolCalls = listOf(ToolCall("call-1", "read_file", "{}")),
                    ),
                ),
            ).getOrThrow()

            val body = JSONObject(server.takeRequest().body.readUtf8())
            val assistant = body.getJSONArray("messages").getJSONObject(1)
            assertEquals("", assistant.getString("content"))
            assertEquals("checked first branch", assistant.getString("reasoning_content"))
            val toolAssistant = body.getJSONArray("messages").getJSONObject(2)
            assertEquals("checked tool branch", toolAssistant.getString("reasoning_content"))
            assertEquals("read_file", toolAssistant.getJSONArray("tool_calls")
                .getJSONObject(0).getJSONObject("function").getString("name"))
            assertFalse(assistant.getString("reasoning_content").contains("Internal Agent"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun providerFinishStateAloneControlsThoughtContinuation() = runBlocking {
        assertTrue(modelRequestedContinuation("length"))
        assertTrue(modelRequestedContinuation("MAX_TOKENS"))
        assertTrue(modelRequestedContinuation("max_output_tokens"))
        assertFalse(modelRequestedContinuation("stop"))
        assertFalse(modelRequestedContinuation("tool_calls"))
        assertFalse(modelRequestedContinuation(""))

        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"partial\"}}]}\n\n"),
        )
        server.start()
        try {
            val result = ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "deepseek-reasoner"),
                messages = listOf(ChatMessage(role = "user", content = "think")),
            )
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("explicit provider completion status"))
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun allIntelligenceTiersReachBothProviderProtocolsExactly() = runBlocking {
        val tiers = listOf("low", "medium", "high", "xhigh", "max", "ultra")
        val expected = listOf("low", "medium", "high", "xhigh", "max", "max")
        val server = MockWebServer()
        repeat(tiers.size) {
            server.enqueue(MockResponse().setResponseCode(400).setBody("use /v1/responses"))
            server.enqueue(
                MockResponse()
                    .addHeader("Content-Type", "text/event-stream")
                    .setBody(
                        "data:{\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n" +
                            "data:{\"type\":\"response.completed\",\"response\":{}}\n\n",
                    ),
            )
        }
        server.start()
        try {
            val client = ApiClient(OkHttpClient())
            tiers.forEachIndexed { index, tier ->
                client.chat(
                    config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "gpt-5.6-luna"),
                    messages = listOf(ChatMessage(role = "user", content = "tier-$tier")),
                    intelligence = tier,
                ).getOrThrow()
                val chatBody = JSONObject(server.takeRequest().body.readUtf8())
                val responsesBody = JSONObject(server.takeRequest().body.readUtf8())
                assertEquals(expected[index], chatBody.getString("reasoning_effort"))
                assertEquals(expected[index], responsesBody.getJSONObject("reasoning").getString("effort"))
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun customNativeTierMappingIsAppliedWithoutCrossProtocolDrift() = runBlocking {
        val tierMap = mapOf("minimal" to "low", "balanced" to "medium", "deep" to "high")
        val tiers = listOf("low", "medium", "high", "xhigh", "max", "ultra")
        val expected = listOf("minimal", "balanced", "deep", "deep", "deep", "deep")
        val server = MockWebServer()
        repeat(tiers.size) {
            server.enqueue(MockResponse().setResponseCode(400).setBody("use /v1/responses"))
            server.enqueue(
                MockResponse()
                    .addHeader("Content-Type", "text/event-stream")
                    .setBody(
                        "data:{\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n" +
                            "data:{\"type\":\"response.completed\",\"response\":{}}\n\n",
                    ),
            )
        }
        server.start()
        try {
            val client = ApiClient(OkHttpClient())
            tiers.forEachIndexed { index, tier ->
                client.chat(
                    config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "custom-reasoner"),
                    messages = listOf(ChatMessage(role = "user", content = "tier-$tier")),
                    intelligence = tier,
                    thinkingTierMap = tierMap,
                ).getOrThrow()
                val chatBody = JSONObject(server.takeRequest().body.readUtf8())
                val responsesBody = JSONObject(server.takeRequest().body.readUtf8())
                assertEquals(expected[index], chatBody.getString("reasoning_effort"))
                assertEquals(expected[index], responsesBody.getJSONObject("reasoning").getString("effort"))
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun officialOpenAiMaxUsesItsNativeXhighCeiling() {
        val client = ApiClient(OkHttpClient())

        assertEquals(
            "xhigh",
            client.reasoningEffort("gpt-5.6-sol", "https://api.openai.com/v1", "max", emptyMap()),
        )
        assertEquals(
            "xhigh",
            client.reasoningEffort("gpt-5.6-sol", "https://api.openai.com/v1", "ultra", emptyMap()),
        )
        assertEquals(
            "max",
            client.reasoningEffort("gpt-5.6-sol", "https://compatible.example/v1", "max", emptyMap()),
        )
    }

    @Test
    fun acceptsStructuredTextAndBothDeltaAndCumulativeStreams() {
        val structured = parseChatStreamTextDelta(
            "{\"choices\":[{\"delta\":{\"reasoning_content\":[{\"text\":\"检查\"}],\"content\":[{\"text\":\"完成\"}]}}]}",
        )
        assertEquals("检查", structured.thought)
        assertEquals("完成", structured.text)

        val target = StringBuilder()
        assertEquals("先", appendCompatibleStreamValue(target, "先"))
        assertEquals("检查", appendCompatibleStreamValue(target, "先检查"))
        assertEquals("完成", appendCompatibleStreamValue(target, "完成"))
        assertEquals("先检查完成", target.toString())
        assertEquals("", appendCompatibleStreamValue(target, "先检查完成"))
        assertEquals("", appendCompatibleStreamValue(target, "null"))

        assertEquals(
            "{\"json\":\"value\"}",
            assembleCompatibleToolArguments(listOf("{\"json\":\"", "value", "\"}")),
        )
        assertEquals(
            "{\"json\":\"abc\"}",
            assembleCompatibleToolArguments(listOf("{\"json\":\"a", "{\"json\":\"abc\"}")),
        )
        assertEquals(
            "{\"json\":\"abc\"}",
            assembleCompatibleToolArguments(listOf("{\"json\":\"abc\"}", "{\"json\":\"abc\"}")),
        )
    }

    @Test
    fun cumulativeToolSnapshotsProduceOneValidCorrectedArgumentObject() = runBlocking {
        val server = MockWebServer()
        fun toolFrame(arguments: String, includeIdentity: Boolean, finishReason: String = ""): String {
            val tool = JSONObject()
                .put("index", 0)
                .put("function", JSONObject().put("arguments", arguments))
            if (includeIdentity) {
                tool.put("id", "call-settings")
                tool.getJSONObject("function").put("name", "settings_update")
            }
            val choice = JSONObject()
                .put("delta", JSONObject().put("tool_calls", org.json.JSONArray().put(tool)))
            if (finishReason.isNotBlank()) choice.put("finish_reason", finishReason)
            return JSONObject().put("choices", org.json.JSONArray().put(choice)).toString()
        }
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data:${toolFrame("{\"json\":\"a\"}", includeIdentity = true)}\n\n" +
                        "data:${toolFrame("{\"json\":\"abc\"}", includeIdentity = false, finishReason = "tool_calls")}\n\n" +
                        "data:[DONE]\n\n",
                ),
        )
        server.start()
        try {
            val response = ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "model"),
                messages = listOf(ChatMessage(role = "user", content = "update settings")),
            ).getOrThrow()

            assertEquals(1, response.toolCalls.size)
            assertEquals("settings_update", response.toolCalls.single().name)
            assertEquals("abc", JSONObject(response.toolCalls.single().arguments).getString("json"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun toolFollowUpAppendsAtFrontierWithoutChangingCachedPrefix() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody("data:{\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata:[DONE]\n\n"),
        )
        server.start()
        try {
            val prefix = listOf(
                ChatMessage(role = "system", content = "stable-focus"),
                ChatMessage(role = "user", content = "update settings"),
            )
            ApiClient(OkHttpClient()).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "model"),
                messages = prefix + listOf(
                    ChatMessage(
                        role = "assistant",
                        content = "",
                        toolCalls = listOf(ToolCall("call-settings", "settings_update", "{\"json\":\"abc\"}")),
                    ),
                    ChatMessage(role = "tool", content = "{\"ok\":false}", toolCallId = "call-settings"),
                ),
            ).getOrThrow()

            val sent = JSONObject(server.takeRequest().body.readUtf8()).getJSONArray("messages")
            assertEquals("stable-focus", sent.getJSONObject(0).getString("content"))
            assertEquals("update settings", sent.getJSONObject(1).getString("content"))
            assertEquals("assistant", sent.getJSONObject(2).getString("role"))
            assertEquals("tool", sent.getJSONObject(3).getString("role"))
            assertEquals("call-settings", sent.getJSONObject(3).getString("tool_call_id"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun providerRequestConsumesThoughtAndTextDeltasBeforeCompletion() {
        val source = File("src/main/java/com/newmark/mobile/data/ApiClient.kt").readText()

        assertTrue(source.contains("put(\"stream\", true)"))
        assertTrue(source.contains("firstText(\"reasoning_content\", \"reasoning\", \"thinking\", \"analysis\")"))
        assertTrue(source.contains("onThoughtDelta(thoughtDelta)"))
        assertTrue(source.contains("onTextDelta(textDelta)"))
        assertTrue(source.contains("messageOrDelta?.optJSONArray(\"tool_calls\")"))
        assertTrue(source.contains("SSE_IDLE_TIMEOUT_MS"))
        assertTrue(source.contains("readTimeout(0, TimeUnit.MILLISECONDS)"))
        assertTrue(source.contains("Provider reads have no response deadline"))
        assertTrue(source.contains("transport/provider errors are the only terminal conditions"))
    }

    @Test
    fun retriesResponsesForTheToolAndReasoningCompatibilityError() {
        val error = "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. " +
            "To use function tools, use /v1/responses or set reasoning_effort to none."

        assertTrue(shouldRetryWithResponses(400, error))
        assertTrue(shouldRetryWithResponses(422, "unsupported_api_for_model: use Responses API"))
        assertTrue(!shouldRetryWithResponses(500, error))
        assertTrue(!shouldRetryWithResponses(400, "invalid api key"))
    }

    @Test
    fun retriesWithoutTemperatureOnlyForExplicitUnsupportedParameterErrors() {
        val structured = "{\"error\":{\"message\":\"Unsupported parameter: 'temperature' is not supported with this model.\"," +
            "\"type\":\"invalid_request_error\",\"param\":\"temperature\"}}"

        assertTrue(shouldRetryWithoutTemperature(400, structured))
        assertTrue(shouldRetryWithoutTemperature(400, "temperature is not supported for this model"))
        assertTrue(!shouldRetryWithoutTemperature(422, structured))
        assertTrue(!shouldRetryWithoutTemperature(400, "invalid api key"))
    }

    @Test
    fun retriesOneFreshConnectionAfterSoftwareConnectionAbort() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody("data:{\"choices\":[{\"delta\":{\"content\":\"恢复\"}}]}\n\ndata:[DONE]\n\n"),
        )
        server.start()
        try {
            val attempts = AtomicInteger()
            val transport = OkHttpClient.Builder()
                .addInterceptor { chain ->
                    if (attempts.getAndIncrement() == 0) {
                        throw SocketException("Software caused connection abort")
                    }
                    chain.proceed(chain.request())
                }
                .build()
            val response = ApiClient(transport).chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "key", "model"),
                messages = listOf(ChatMessage(role = "user", content = "hello")),
            ).getOrThrow()

            assertEquals(2, attempts.get())
            assertEquals(1, server.requestCount)
            assertEquals("恢复", response.content)
            assertTrue(isFreshConnectionRetryable(SocketException("Software caused connection abort")))
            assertTrue(!isFreshConnectionRetryable(SocketException("Broken pipe")))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun responsesStreamNormalizesThoughtTextCompletionAndTools() {
        assertEquals(
            "检查上下文",
            parseResponsesStreamDelta(
                "{\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"检查上下文\"}",
            ).thought,
        )
        assertEquals(
            "完成",
            parseResponsesStreamDelta(
                "{\"delta\":\"完成\"}",
                "response.output_text.delta",
            ).text,
        )
        assertTrue(
            parseResponsesStreamDelta("{\"type\":\"response.completed\",\"response\":{}}")
                .completed,
        )

        val added = parseResponsesStreamDelta(
            "{\"type\":\"response.output_item.added\",\"item\":{" +
                "\"id\":\"item_1\",\"call_id\":\"call_1\",\"type\":\"function_call\",\"name\":\"terminal_exec\"}}",
        )
        val arguments = parseResponsesStreamDelta(
            "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\",\"delta\":\"{\\\"command\\\":\\\"pwd\\\"}\"}",
        )
        assertEquals("item_1", added.toolKey)
        assertEquals("call_1", added.toolId)
        assertEquals("terminal_exec", added.toolName)
        assertEquals("item_1", arguments.toolKey)
        assertEquals("{\"command\":\"pwd\"}", arguments.toolArgumentsDelta)
    }

    @Test
    fun responsesFallbackUsesPcCompatibleEndpointAndRequestShapes() {
        val source = File("src/main/java/com/newmark/mobile/data/ApiClient.kt").readText()

        assertTrue(source.contains("shouldRetryWithResponses(resp.code, text)"))
        assertTrue(source.contains("val url = \"\$endpointBase/responses\""))
        assertTrue(source.contains("put(\"reasoning\", JSONObject().put(\"effort\", effort).put(\"summary\", \"auto\"))"))
        assertTrue(source.contains("put(\"type\", \"function_call_output\")"))
        assertTrue(source.contains("put(\"parallel_tool_calls\", true)"))
    }

    @Test
    fun chatCompatibilityFailureRetriesResponsesEndToEnd() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(400).setBody(
                "{\"error\":{\"message\":\"Function tools with reasoning_effort are not supported. " +
                    "To use function tools, use /v1/responses or set reasoning_effort to none.\"}}",
            ),
        )
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data:{\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"检查\"}\n\n" +
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"完成\"}\n\n" +
                        "data:{\"type\":\"response.output_item.added\",\"item\":{" +
                        "\"id\":\"item_1\",\"call_id\":\"call_1\",\"type\":\"function_call\",\"name\":\"terminal_exec\"}}\n\n" +
                        "data:{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\"," +
                        "\"delta\":\"{\\\"command\\\":\\\"pwd\\\"}\"}\n\n" +
                        "data:{\"type\":\"response.output_item.done\",\"item\":{" +
                        "\"id\":\"item_1\",\"call_id\":\"call_1\",\"type\":\"function_call\"," +
                        "\"name\":\"terminal_exec\",\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}}\n\n" +
                        "data:{\"type\":\"response.completed\",\"response\":{}}\n\n",
                ),
        )
        server.start()
        try {
            val thoughts = StringBuilder()
            val texts = StringBuilder()
            val tool = JSONObject()
                .put("type", "function")
                .put("function", JSONObject().apply {
                    put("name", "terminal_exec")
                    put("description", "run")
                    put("parameters", JSONObject().put("type", "object"))
                })
            val response = ApiClient(OkHttpClient()).chat(
                config = ApiConfig(
                    baseUrl = server.url("/v1").toString().trimEnd('/'),
                    apiKey = "test-key",
                    model = "gpt-5.6-luna",
                ),
                messages = listOf(ChatMessage(role = "user", content = "hello")),
                tools = listOf(tool),
                intelligence = "high",
                onThoughtDelta = { thoughts.append(it) },
                onTextDelta = { texts.append(it) },
            ).getOrThrow()

            val chatRequest = server.takeRequest()
            val responsesRequest = server.takeRequest()
            assertEquals("/v1/chat/completions", chatRequest.path)
            assertTrue(chatRequest.body.readUtf8().contains("\"reasoning_effort\":\"high\""))
            assertEquals("/v1/responses", responsesRequest.path)
            val responsesBody = JSONObject(responsesRequest.body.readUtf8())
            assertEquals("high", responsesBody.getJSONObject("reasoning").getString("effort"))
            assertEquals("auto", responsesBody.getJSONObject("reasoning").getString("summary"))
            assertEquals("function", responsesBody.getJSONArray("tools").getJSONObject(0).getString("type"))
            assertEquals("terminal_exec", responsesBody.getJSONArray("tools").getJSONObject(0).getString("name"))
            assertEquals("检查", thoughts.toString())
            assertEquals("完成", texts.toString())
            assertEquals("检查", response.reasoningContent)
            assertEquals("完成", response.content)
            assertEquals(listOf(ToolCall("call_1", "terminal_exec", "{\"command\":\"pwd\"}")), response.toolCalls)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun chatThenResponsesThenNoTemperatureRetryCompletesEndToEnd() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(400).setBody(
                "{\"error\":{\"message\":\"Function tools with reasoning_effort are not supported. " +
                    "Use /v1/responses.\"}}",
            ),
        )
        server.enqueue(
            MockResponse().setResponseCode(400).setBody(
                "{\"error\":{\"message\":\"Unsupported parameter: 'temperature' is not supported with this model.\"," +
                    "\"type\":\"invalid_request_error\",\"param\":\"temperature\"}}",
            ),
        )
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data:{\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"检查\"}\n\n" +
                        "data:{\"type\":\"response.output_text.delta\",\"delta\":\"完成\"}\n\n" +
                        "data:{\"type\":\"response.completed\",\"response\":{}}\n\n",
                ),
        )
        server.start()
        try {
            val client = ApiClient(OkHttpClient())
            val result = client.chat(
                config = ApiConfig(
                    baseUrl = server.url("/v1").toString().trimEnd('/'),
                    apiKey = "test-key",
                    model = "gpt-5.6-luna",
                ),
                messages = listOf(ChatMessage(role = "user", content = "hello")),
                tools = listOf(
                    JSONObject().put("type", "function").put(
                        "function",
                        JSONObject().put("name", "terminal_exec").put("parameters", JSONObject()),
                    ),
                ),
                intelligence = "high",
            ).getOrThrow()

            val chatBody = JSONObject(server.takeRequest().body.readUtf8())
            val firstResponsesBody = JSONObject(server.takeRequest().body.readUtf8())
            val retriedResponsesBody = JSONObject(server.takeRequest().body.readUtf8())
            assertTrue(chatBody.has("temperature"))
            assertTrue(firstResponsesBody.has("temperature"))
            assertTrue(!retriedResponsesBody.has("temperature"))
            assertEquals("检查", result.reasoningContent)
            assertEquals("完成", result.content)

            server.enqueue(MockResponse().setResponseCode(400).setBody("use /v1/responses"))
            server.enqueue(
                MockResponse()
                    .addHeader("Content-Type", "text/event-stream")
                    .setBody(
                        "data:{\"type\":\"response.output_text.delta\",\"delta\":\"再次完成\"}\n\n" +
                            "data:{\"type\":\"response.completed\",\"response\":{}}\n\n",
                    ),
            )
            val cached = client.chat(
                config = ApiConfig(server.url("/v1").toString().trimEnd('/'), "test-key", "gpt-5.6-luna"),
                messages = listOf(ChatMessage(role = "user", content = "again")),
                tools = listOf(
                    JSONObject().put("type", "function").put(
                        "function",
                        JSONObject().put("name", "terminal_exec").put("parameters", JSONObject()),
                    ),
                ),
                intelligence = "high",
            ).getOrThrow()
            server.takeRequest()
            val cachedBody = JSONObject(server.takeRequest().body.readUtf8())
            assertTrue(!cachedBody.has("temperature"))
            assertEquals("再次完成", cached.content)
        } finally {
            server.shutdown()
        }
    }
}
