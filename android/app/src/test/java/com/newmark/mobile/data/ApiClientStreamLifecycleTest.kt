package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Protocol completion and user stop cannot depend on a gateway closing HTTP. */
class ApiClientStreamLifecycleTest {
    private class HeldSseResponse(
        private val initialFrames: String,
        private val holdBeforeHeaders: Boolean = false,
    ) : Closeable {
        private val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val started = CountDownLatch(1)
        private val release = CountDownLatch(1)
        @Volatile private var socket: Socket? = null
        @Volatile private var output: OutputStream? = null
        val baseUrl = "http://127.0.0.1:${listener.localPort}/v1"
        private val worker = thread(name = "held-sse-fixture", isDaemon = true) {
            try {
                listener.accept().use { accepted ->
                    socket = accepted
                    val reader = accepted.getInputStream().bufferedReader()
                    var length = 0
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) {
                            length = line.substringAfter(':').trim().toInt()
                        }
                    }
                    repeat(length) { reader.read() }
                    if (!holdBeforeHeaders) {
                        output = accepted.getOutputStream()
                        output!!.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" +
                            "Transfer-Encoding: chunked\r\n\r\n").toByteArray())
                        send(initialFrames)
                        output!!.flush()
                    }
                    started.countDown()
                    // Deliberately omit the zero chunk: the response body is
                    // valid but remains open even after a protocol final event.
                    release.await()
                }
            } catch (_: Exception) {
                // Closing the fixture intentionally interrupts accept/read.
            }
        }

        @Synchronized fun send(frames: String) {
            if (frames.isEmpty()) return
            val stream = checkNotNull(output)
            val bytes = frames.toByteArray()
            stream.write("${bytes.size.toString(16)}\r\n".toByteArray())
            stream.write(bytes)
            stream.write("\r\n".toByteArray())
            stream.flush()
        }

        override fun close() {
            release.countDown()
            socket?.close()
            listener.close()
            worker.join(1_000)
        }
    }

    private fun config(server: HeldSseResponse, responses: Boolean = false) = ApiConfig(
        server.baseUrl, "loopback-fixture", "model",
        if (responses) PROVIDER_PROTOCOL_OPENAI_RESPONSES else PROVIDER_PROTOCOL_OPENAI,
    )

    private fun checkTerminal(frames: String, responses: Boolean = false, error: Boolean = false) = runBlocking {
        val server = HeldSseResponse(frames)
        val request = async(Dispatchers.IO) { ApiClient().chat(config(server, responses), emptyList()) }
        try {
            assertTrue("the local provider must send its frame", server.started.await(5, TimeUnit.SECONDS))
            val result = withTimeoutOrNull(1_500) { request.await() }
            assertNotNull("an explicit provider final event must finish before HTTP EOF", result)
            if (error) assertTrue(result!!.isFailure)
            else assertEquals("healthy", result!!.getOrThrow().content)
        } finally {
            request.cancel()
            server.close()
        }
    }

    @Test fun chatDoneDoesNotWaitForGatewayHttpEof() = checkTerminal(
        "data: {\"choices\":[{\"delta\":{\"content\":\"healthy\"}}]}\n\ndata: [DONE]\n\n",
    )

    @Test fun chatFinishReasonDoesNotWaitForGatewayHttpEof() = checkTerminal(
        "data: {\"choices\":[{\"delta\":{\"content\":\"healthy\"},\"finish_reason\":\"stop\"}]}\n\n",
    )

    @Test fun responsesCompletedDoesNotWaitForGatewayHttpEof() = checkTerminal(
        "event: response.output_text.delta\ndata: {\"delta\":\"healthy\"}\n\n" +
            "event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n",
        responses = true,
    )

    @Test fun responsesFailureDoesNotRemainPendingUntilHttpEof() = checkTerminal(
        "event: response.failed\ndata: {\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"fixture failure\"}}}\n\n",
        responses = true, error = true,
    )

    @Test fun responsesDoneWithoutExplicitCompletedStatusFailsPromptly() = checkTerminal(
        "data: [DONE]\n\n", responses = true, error = true,
    )

    private fun checkCancellation(beforeHeaders: Boolean, partial: Boolean) = runBlocking {
        val firstDelta = CountDownLatch(1)
        val server = HeldSseResponse(
            if (partial) "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n" else "",
            holdBeforeHeaders = beforeHeaders,
        )
        val request = async(Dispatchers.IO) {
            ApiClient().chat(config(server), emptyList(), onTextDelta = { firstDelta.countDown() })
        }
        try {
            assertTrue(server.started.await(5, TimeUnit.SECONDS))
            if (partial) assertTrue("cancel must occur after the actual text callback", firstDelta.await(5, TimeUnit.SECONDS))
            request.cancel()
            assertEquals("user stop must close the blocked header/body read", true,
                withTimeoutOrNull(1_500) { request.join(); true })
            assertTrue(request.isCancelled)
        } finally {
            request.cancel()
            server.close()
        }
    }

    @Test fun userStopClosesARequestWaitingForHeaders() = checkCancellation(beforeHeaders = true, partial = false)
    @Test fun userStopClosesASilentProviderBody() = checkCancellation(beforeHeaders = false, partial = false)
    @Test fun userStopClosesAStreamAfterDeliveredText() = checkCancellation(beforeHeaders = false, partial = true)

    @Test fun aHealthyQuietStreamRemainsPendingUntilItsActualFinalEvent() = runBlocking {
        val server = HeldSseResponse(": heartbeat\n\n")
        val request = async(Dispatchers.IO) { ApiClient().chat(config(server), emptyList()) }
        try {
            assertTrue(server.started.await(5, TimeUnit.SECONDS))
            delay(250)
            assertTrue("silence and heartbeat are not an empty response or disconnect", request.isActive)
            server.send("data: {\"choices\":[{\"delta\":{\"content\":\"healthy\"}}]}\n\ndata: [DONE]\n\n")
            val result = withTimeoutOrNull(1_500) { request.await() }
            assertNotNull(result)
            assertEquals("healthy", result!!.getOrThrow().content)
        } finally {
            request.cancel()
            server.close()
        }
    }

    @Test fun cancellingAnOpenDesktopStyleEventReadClosesItsSocket() = runBlocking {
        val server = HeldSseResponse(": heartbeat\n\n")
        val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        val request = async(Dispatchers.IO) {
            withCancellableHttpExchange { exchange ->
                exchange.execute(client.newCall(okhttp3.Request.Builder().url(server.baseUrl).build())).use { response ->
                    val source = checkNotNull(response.body).source()
                    while (!source.exhausted()) source.readUtf8Line()
                }
            }
        }
        try {
            assertTrue(server.started.await(5, TimeUnit.SECONDS))
            request.cancel()
            assertEquals("switching devices must release an idle SSE reader", true,
                withTimeoutOrNull(1_500) { request.join(); true })
        } finally {
            request.cancel()
            server.close()
        }
    }
}
