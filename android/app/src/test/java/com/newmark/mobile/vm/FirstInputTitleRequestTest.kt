package com.newmark.mobile.vm

import com.newmark.mobile.data.ApiClient
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.CONVERSATION_SAVE_FAILURE_MESSAGE
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.data.writeConversationSnapshotAtomically
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Real title requests prove the first-turn gate and its cancellation ownership. */
class FirstInputTitleRequestTest {
    @Test fun reasoningModelCanFinishTitleWithTheFormalTurnBudget() = runBlocking {
        val server = MockWebServer()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8())
                return if (body.getInt("max_tokens") < 4096) response("") else response("推理模型标题预算")
            }
        }
        server.start()
        try {
            var title = ""
            assertTrue(requestAndApplyFirstInputTitle(ApiClient(), "分析当前标题总结失败的原因",
                ApiConfig(server.url("/v1").toString(), "fixture", "deepseek-v4-flash-vision"),
                "high", emptyMap(), applyTitle = { title = it; Result.success(true) }))
            assertEquals("推理模型标题预算", title)
            assertEquals(1, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun stopDuringImageTextFallbackDoesNotApplyNeutralTitle() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response(""))
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))
        server.start()
        val applied = AtomicBoolean(false)
        val pending = async(Dispatchers.IO) {
            requestAndApplyFirstInputTitle(ApiClient(), "查看图片", ApiConfig(server.url("/v1").toString(), "fixture", "gpt-5"),
                "high", emptyMap(), imageAttachmentCount = 1,
                applyTitle = { applied.set(true); Result.success(true) })
        }
        try {
            repeat(2) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            pending.cancel()
            pending.join()
            assertTrue(pending.isCancelled)
            assertFalse(applied.get())
        } finally { pending.cancel(); server.shutdown() }
    }

    @Test fun imageTitleRetriesFromTextMetadataWithoutSendingPixels() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response(""))
        server.enqueue(response("潮汐图片解读"))
        server.start()
        try {
            var applied = ""
            assertTrue(requestAndApplyFirstInputTitle(ApiClient(), "解释潮汐图", ApiConfig(server.url("/v1").toString(), "fixture", "gpt-5"),
                "high", mapOf("high" to "high"), imageAttachmentCount = 2,
                applyTitle = { applied = it; Result.success(true) }))
            assertEquals("潮汐图片解读", applied)
            val first = JSONObject(server.takeRequest().body.readUtf8())
            val fallback = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals(16384, first.getInt("max_tokens"))
            assertEquals(2048, fallback.getInt("max_tokens"))
            assertEquals("low", fallback.getString("reasoning_effort"))
            val content = fallback.getJSONArray("messages").getJSONObject(0).getString("content")
            assertTrue(content.contains("2 image attachments"))
            assertTrue(content.contains("解释潮汐图"))
            assertFalse(fallback.toString().contains("image_url"))
            assertFalse(fallback.toString().contains("data:image"))
        } finally { server.shutdown() }
    }

    @Test fun unavailableImageTitleUsesNeutralNameButStillRequiresPersistence() = runBlocking {
        for (saveSucceeds in listOf(true, false)) {
            val server = MockWebServer()
            repeat(2) { server.enqueue(MockResponse().setResponseCode(503).setBody("unavailable")) }
            server.start()
            try {
                var applied = ""
                val ready = requestAndApplyFirstInputTitle(ApiClient(), "用户提交了 1 个图片附件",
                    ApiConfig(server.url("/v1").toString(), "fixture", "gpt-5"), "high", emptyMap(), imageAttachmentCount = 1,
                    applyTitle = { applied = it; if (saveSucceeds) Result.success(true) else Result.failure(java.io.IOException("disk")) })
                assertEquals(saveSucceeds, ready)
                assertEquals("图片内容分析", applied)
                assertEquals(2, server.requestCount)
            } finally { server.shutdown() }
        }
    }

    private val firstInput = "Explain how lunar tides change over a month"

    private fun response(title: String): MockResponse = MockResponse()
        .addHeader("Content-Type", "text/event-stream")
        .setBody("data: {\"choices\":[{\"delta\":{\"content\":${JSONObject.quote(title)}},\"finish_reason\":\"stop\"}]}\n\n")

    private suspend fun request(server: MockWebServer, apply: (String) -> Boolean): Boolean =
        requestAndApplyFirstInputTitle(
            ApiClient(), firstInput,
            ApiConfig(server.url("/v1").toString().trimEnd('/'), "loopback-fixture", "gpt-5"),
            "high", mapOf("high" to "high"), applyTitle = { Result.success(apply(it)) },
        )

    @Test fun healthyTitleAfterSixteenSecondsPersistsBeforeFirstTurnCanStart() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("Lunar tidal cycles").setBodyDelay(16, TimeUnit.SECONDS))
        server.start()
        val storedTitle = File.createTempFile("title-gate", ".txt")
        val startedAt = System.nanoTime()
        val firstTurnStarted = AtomicBoolean(false)
        val parent = Job()
        val flow = CoroutineScope(parent + Dispatchers.IO).async {
            val ready = request(server) { title ->
                assertFalse(firstTurnStarted.get())
                storedTitle.writeText(title)
                true
            }
            if (ready) {
                assertEquals("Lunar tidal cycles", storedTitle.readText())
                firstTurnStarted.set(true)
            }
            ready
        }
        try {
            assertNotNull("a real title request reached loopback", server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("a healthy title cannot fail at the former 15 second cutoff", true,
                withTimeoutOrNull(22_000) { flow.await() })
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt) >= 15_000)
            assertTrue(firstTurnStarted.get())
            assertEquals(1, server.requestCount)
        } finally {
            parent.cancel()
            server.shutdown()
            storedTitle.delete()
        }
    }

    private fun checkParentStop(beforeHeaders: Boolean) = runBlocking {
        val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        var socket: Socket? = null
        val server = thread(name = "silent-title-provider", isDaemon = true) {
            try {
                listener.accept().use { accepted ->
                    socket = accepted
                    val input = accepted.getInputStream().bufferedReader()
                    var length = 0
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) {
                            length = line.substringAfter(':').trim().toInt()
                        }
                    }
                    repeat(length) { input.read() }
                    if (!beforeHeaders) {
                        accepted.getOutputStream().apply {
                            write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" +
                                "Transfer-Encoding: chunked\r\n\r\n").toByteArray())
                            flush()
                        }
                    }
                    started.countDown()
                    release.await()
                }
            } catch (_: Exception) {
                // Fixture cleanup interrupts accept/read; the request uses real sockets.
            }
        }
        val parent = Job()
        val applied = AtomicBoolean(false)
        val failureReported = AtomicBoolean(false)
        val flow = CoroutineScope(parent + Dispatchers.IO).async {
            requestAndApplyFirstInputTitle(
                ApiClient(), firstInput,
                ApiConfig("http://127.0.0.1:${listener.localPort}/v1", "loopback-fixture", "gpt-5"),
                "high", emptyMap(),
                onFailure = { failureReported.set(true) },
            ) { applied.set(true); Result.success(true) }
        }
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS))
            parent.cancel()
            assertEquals("stopping the owning run must release the title's blocked socket", true,
                withTimeoutOrNull(1_500) { parent.join(); true })
            assertTrue(flow.isCancelled)
            assertFalse("a stopped title must never reach persistence or open the first turn", applied.get())
            assertFalse("user stop is not a provider failure", failureReported.get())
        } finally {
            parent.cancel()
            release.countDown()
            socket?.close()
            listener.close()
            server.join(1_000)
        }
    }

    @Test fun stoppingTheRunCancelsTitleBeforeHeaders() = checkParentStop(beforeHeaders = true)
    @Test fun stoppingTheRunCancelsTitleDuringSilentBody() = checkParentStop(beforeHeaders = false)

    private fun checkRejectedTitle(title: String) = runBlocking {
        val server = MockWebServer()
        server.enqueue(response(title))
        server.start()
        var applied = false
        try {
            assertFalse(request(server) { applied = true; true })
            assertFalse("invalid titles must not be persisted or permit the first formal turn", applied)
        } finally { server.shutdown() }
    }

    @Test fun anEmptyTitleKeepsTheFirstTurnGateClosed() = checkRejectedTitle("")
    @Test fun anEchoOfTheUserMessageKeepsTheFirstTurnGateClosed() = checkRejectedTitle(firstInput)

    @Test fun aRejectedPersistenceTargetDoesNotOpenTheFirstTurnGate() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("Lunar tidal cycles"))
        server.start()
        var commitAttempts = 0
        try {
            assertFalse(request(server) { commitAttempts++; false })
            assertEquals(1, commitAttempts)
        } finally { server.shutdown() }
    }

    @Test fun titleUsesTheFrozenDeploymentAndNoToolsWithItsOriginalNormalization() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("# \"Lunar tidal cycles\"\nExtra explanation"))
        server.start()
        try {
            assertTrue(request(server) { assertEquals("Lunar tidal cycles", it); true })
            val recorded = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            val body = JSONObject(recorded.body.readUtf8())
            assertEquals("/v1/chat/completions", recorded.path)
            assertEquals("gpt-5", body.getString("model"))
            assertEquals("high", body.getString("reasoning_effort"))
            assertEquals(16384, body.getInt("max_tokens"))
            assertFalse(body.has("tools"))
            val messages = body.getJSONArray("messages")
            assertEquals(1, messages.length())
            assertTrue(messages.getJSONObject(0).getString("content").endsWith(firstInput))
        } finally { server.shutdown() }
    }

    @Test fun anActual503PreservesItsProviderReasonWithoutLeakingCredentials() = runBlocking {
        val apiKey = "title-fixture-secret"
        val otherToken = "echoed-fixture-token"
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(503).setBody(
            """{"error":{"code":"get_channel_failed","message":"upstream unavailable; api_key=$apiKey; Authorization: Bearer $otherToken"}}""",
        ))
        server.enqueue(MockResponse().setResponseCode(503).setBody(
            """{"error":{"code":"$apiKey","message":"echo $apiKey $otherToken"}}""",
        ))
        server.start()
        var diagnostic = ""
        var applied = false
        try {
            val ready = requestAndApplyFirstInputTitle(
                ApiClient(), firstInput,
                ApiConfig(server.url("/v1").toString().trimEnd('/'), apiKey, "gpt-5"),
                "high", emptyMap(), onFailure = { diagnostic = it },
            ) { applied = true; Result.success(true) }
            assertFalse(ready)
            assertFalse("503 cannot persist a title or open the formal first-turn gate", applied)
            assertTrue(diagnostic.contains("HTTP 503"))
            assertTrue(diagnostic.contains("get_channel_failed"))
            assertTrue(diagnostic.contains("供应商暂无可用通道"))
            assertFalse("raw provider messages are never shown", diagnostic.contains("upstream unavailable"))
            assertFalse(diagnostic.contains(apiKey))
            assertFalse(diagnostic.contains(otherToken))
            assertEquals(1, server.requestCount)
            assertFalse(requestAndApplyFirstInputTitle(
                ApiClient(), firstInput,
                ApiConfig(server.url("/v1").toString().trimEnd('/'), apiKey, "gpt-5"),
                "high", emptyMap(), onFailure = { diagnostic = it },
            ) { applied = true; Result.success(true) })
            assertEquals("HTTP 503：供应商服务暂时不可用。", diagnostic)
            assertFalse("even an error.code echo cannot expose the configured key", diagnostic.contains(apiKey))
            assertFalse(diagnostic.contains(otherToken))
            assertFalse(applied)
            assertEquals(2, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun providerDiagnosticsUseFixedReasonsWithoutEchoingResponseOrNetworkDetails() {
        val diagnostic = titleProviderFailureReason(IllegalStateException(
            "HTTP 503: " + """{"error":{"code":"get_channel_failed","message":"fixture-structured-secret"}}""",
        ), "configured-fixture-key")
        assertEquals("HTTP 503 / get_channel_failed：供应商暂无可用通道。", diagnostic)
        assertFalse(diagnostic.contains("fixture-structured-secret"))
        assertFalse(diagnostic.contains('\n'))
        assertTrue(diagnostic.length <= 320)
        val network = titleProviderFailureReason(java.net.UnknownHostException(
            "https://fixture-user:fixture-url-secret@example.test/path?token=fixture-token",
        ), "configured-fixture-key")
        assertEquals("无法解析供应商地址，请检查接口配置和网络。", network)
        assertFalse(network.contains("example.test"))
        assertFalse(network.contains("fixture"))
        assertTrue(titleProviderFailureReason(IllegalStateException("HTTP 401: {}"), "key").contains("认证失败"))
        assertTrue(titleProviderFailureReason(IllegalStateException("HTTP 402: {}"), "key").contains("支付"))
    }

    private fun pendingConversation(title: String = "新对话") = LocalConversation(
        id = "title-store-fixture", title = title, titleRequestMessageId = "first-message",
        messages = listOf(ChatMessage(role = "user", content = firstInput, messageId = "first-message")),
    )

    @Test fun aValidProviderTitleCannotOpenTheFirstTurnWhenRealFileReplacementFails() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("Lunar tidal cycles"))
        server.start()
        val root = File.createTempFile("title-storage-failure", ".dir").apply { delete(); mkdir() }
        val blocked = File(root, "conversations.json").apply { mkdir() }
        val retained = File(blocked, "old-data").apply { writeText("retained fixture") }
        var published = listOf(pendingConversation())
        var formalStarted = false
        var diagnostic = ""
        try {
            val ready = requestAndApplyFirstInputTitle(
                ApiClient(), firstInput,
                ApiConfig(server.url("/v1").toString().trimEnd('/'), "loopback-fixture", "gpt-5"),
                "high", emptyMap(), onFailure = { diagnostic = it },
            ) { title ->
                commitFirstInputConversationTitle(published, "title-store-fixture", "first-message", title,
                    persist = { next -> writeConversationSnapshotAtomically(blocked) { it.write(Gson().toJson(next).toByteArray()) } },
                    publish = { published = it },
                )
            }
            if (ready) formalStarted = true
            assertFalse(ready)
            assertFalse(formalStarted)
            assertEquals("新对话", published.single().title)
            assertEquals(CONVERSATION_SAVE_FAILURE_MESSAGE, diagnostic)
            assertFalse("a local save failure must not blame the provider", diagnostic.contains("供应商"))
            assertEquals("retained fixture", retained.readText())
            assertEquals(listOf("conversations.json"), root.list()!!.toList())
            assertEquals(1, server.requestCount)
        } finally { server.shutdown(); retained.delete(); blocked.delete(); root.delete() }
    }

    @Test fun aRealSnapshotPrecedesTitlePublicationAndFormalContinuation() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("Lunar tidal cycles"))
        server.start()
        val root = File.createTempFile("title-storage-success", ".dir").apply { delete(); mkdir() }
        val snapshot = File(root, "conversations.json")
        val order = mutableListOf<String>()
        var published = listOf(pendingConversation("My manual title"))
        try {
            val ready = requestAndApplyFirstInputTitle(
                ApiClient(), firstInput,
                ApiConfig(server.url("/v1").toString().trimEnd('/'), "loopback-fixture", "gpt-5"),
                "high", emptyMap(),
            ) { title ->
                commitFirstInputConversationTitle(published, "title-store-fixture", "first-message", title,
                    persist = { next ->
                        writeConversationSnapshotAtomically(snapshot) { it.write(Gson().toJson(next).toByteArray()) }
                            .onSuccess { order += "saved" }
                    },
                    publish = { next ->
                        assertEquals(Gson().toJson(next), snapshot.readText())
                        published = next
                        order += "published"
                    },
                )
            }
            assertTrue(ready)
            order += "formal"
            assertEquals(listOf("saved", "published", "formal"), order)
            assertEquals("My manual title", published.single().title)
            assertTrue(snapshot.readText().contains("first-message"))
        } finally { server.shutdown(); snapshot.delete(); root.delete() }
    }

    @Test fun aChangedFirstMessageOrStartedTurnNeverPersistsOrPublishesTheTitle() {
        val original = pendingConversation()
        listOf(
            original.copy(titleRequestMessageId = "other-message"),
            original.copy(firstAgentResponseStarted = true),
            original.copy(messages = listOf(ChatMessage(role = "user", content = "other", messageId = "other-message"))),
        ).forEach { changed ->
            val result = commitFirstInputConversationTitle(listOf(changed), original.id, "first-message", "Lunar tidal cycles",
                persist = { fail("stale title must not write"); Result.success(Unit) },
                publish = { fail("stale title must not publish") },
            )
            assertEquals(false, result.getOrThrow())
        }
    }

    @Test fun persistenceCancellationIsRethrownWithoutALocalOrProviderError() = runBlocking {
        val server = MockWebServer()
        server.enqueue(response("Lunar tidal cycles"))
        server.start()
        var diagnosed = false
        try {
            val result = runCatching {
                requestAndApplyFirstInputTitle(
                    ApiClient(), firstInput,
                    ApiConfig(server.url("/v1").toString().trimEnd('/'), "loopback-fixture", "gpt-5"),
                    "high", emptyMap(), onFailure = { diagnosed = true },
                ) { Result.failure(kotlinx.coroutines.CancellationException("fixture stop")) }
            }
            assertTrue(result.exceptionOrNull() is kotlinx.coroutines.CancellationException)
            assertFalse(diagnosed)
        } finally { server.shutdown() }
    }
}
