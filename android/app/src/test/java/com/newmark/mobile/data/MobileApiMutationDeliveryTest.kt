package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A lost acknowledgment must not become a second user mutation on a warm socket. */
class MobileApiMutationDeliveryTest {
    private suspend fun acceptedThenDisconnected(warm: Boolean, queueAction: Boolean = false) {
        val posts = AtomicInteger()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "GET") return MockResponse().setBody("{}")
                // Dispatch runs after MockWebServer has consumed the complete body:
                // model a committed mutation whose acknowledgment never reaches Android.
                return if (posts.incrementAndGet() == 1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                else MockResponse().setBody("{}")
            }
        }
        server.start()
        val api = MobileApiClient()
        val pair = PairInfo("127.0.0.1", server.port, "isolated-fixture-token", "fixture")
        try {
            if (warm) assertTrue(api.hello(pair).isSuccess)
            val result = withTimeout(10_000) {
                if (queueAction) api.conversationQueueAction(pair, "ws", "A", "queue_enqueue", id = "stable-queue-id", text = "one item")
                else api.send(pair, "one message", "A", "ws", clientMessageId = "stable-message-id")
            }
            assertTrue("lost acknowledgment must surface failure, not success after replay", result.isFailure)
            assertEquals("one invocation may be accepted only once; warm=$warm queue=$queueAction", 1, posts.get())
        } finally { api.evictConnections(); server.shutdown() }
    }

    @Test fun acceptedSendOnWarmConnectionIsNotAutomaticallyReplayed() = runBlocking { acceptedThenDisconnected(warm = true) }
    @Test fun acceptedSendOnColdConnectionIsNotAutomaticallyReplayed() = runBlocking { acceptedThenDisconnected(warm = false) }
    @Test fun acceptedQueueMutationOnWarmConnectionIsNotAutomaticallyReplayed() = runBlocking { acceptedThenDisconnected(warm = true, queueAction = true) }

    @Test fun cancellingAnAcceptedMutationClosesPromptlyWithoutReplay() = runBlocking {
        val posts = AtomicInteger()
        val arrived = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                posts.incrementAndGet(); arrived.countDown()
                return MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
            }
        }
        server.start()
        val api = MobileApiClient()
        val pair = PairInfo("127.0.0.1", server.port, "isolated-fixture-token", "fixture")
        try {
            val send = launch { api.send(pair, "accepted before stop", "A", "ws", clientMessageId = "cancelled-id") }
            withContext(Dispatchers.IO) { assertTrue(arrived.await(10, TimeUnit.SECONDS)) }
            withTimeout(2_000) { send.cancelAndJoin() }
            assertTrue(send.isCancelled)
            assertEquals(1, posts.get())
        } finally { api.evictConnections(); server.shutdown() }
    }

    @Test fun idempotentReadsStillRecoverAClosedPooledConnection() = runBlocking {
        val gets = AtomicInteger()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (gets.incrementAndGet() == 2) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                else MockResponse().setBody("{}")
            }
        }
        server.start()
        val api = MobileApiClient()
        val pair = PairInfo("127.0.0.1", server.port, "isolated-fixture-token", "fixture")
        try {
            assertTrue(api.hello(pair).isSuccess)
            assertTrue(withTimeout(10_000) { api.hello(pair) }.isSuccess)
            assertEquals("GET retains OkHttp's recovery policy", 3, gets.get())
        } finally { api.evictConnections(); server.shutdown() }
    }
}
