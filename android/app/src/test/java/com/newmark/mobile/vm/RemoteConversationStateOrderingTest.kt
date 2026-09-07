package com.newmark.mobile.vm

import androidx.compose.runtime.MutableState
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.newmark.mobile.data.*
import com.newmark.mobile.ui.dispatchRemoteImageGuide
import com.newmark.mobile.ui.remoteInputHasContent
import com.newmark.mobile.ui.ConversationComposerDraft
import com.newmark.mobile.ui.QueueMessageUi
import com.newmark.mobile.ui.queueOrderAfterDrag
import androidx.compose.ui.text.input.TextFieldValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.Dispatcher as HttpDispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Actual VM/coroutine/API/reducer methods; isolate only Android construction and observable slots. */
@OptIn(ExperimentalCoroutinesApi::class)
class RemoteConversationStateOrderingTest {
    @Before fun mainDispatcher() { Dispatchers.setMain(Dispatchers.Unconfined) }
    @After fun restoreDispatcher() { Dispatchers.resetMain() }

    private class Slot(initial: Any?, private val changed: (Any?) -> Unit = {}) : MutableState<Any?> {
        @Volatile private var stored = initial
        override var value: Any?
            get() = stored
            set(value) { stored = value; changed(value) }
        override fun component1(): Any? = value
        override fun component2(): (Any?) -> Unit = { value = it }
    }

    private fun field(receiver: Any, name: String, value: Any?) {
        receiver.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(receiver, value)
    }

    private fun read(receiver: Any, name: String): Any? =
        receiver.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(receiver)

    private fun ui(text: String, flow: Boolean = true) = RemoteConversationUiState(
        flow = if (flow) RemoteFlowTakeover(running = true, name = "Flow-A") else null,
        runtime = RemoteRuntimeState(running = flow, runId = if (flow) "run-A" else ""),
        queueItems = if (text.isBlank()) emptyList() else listOf(RemoteQueueItem(id = "row", text = text)),
        chatMessages = emptyList(), workRuns = emptyList(),
    )

    private inner class Fixture(server: MockWebServer) : AutoCloseable {
        val history = Collections.synchronizedList(mutableListOf<String>())
        val vm: DesktopLinkViewModel
        init {
            val unsafeClass = Class.forName("sun.misc.Unsafe")
            val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            vm = unsafeClass.getMethod("allocateInstance", Class::class.java)
                .invoke(unsafe, DesktopLinkViewModel::class.java) as DesktopLinkViewModel
            // Keep lifecycle's real owned scope/cleanup while omitting service registration and prefs.
            val base = object : ViewModel() {}
            val impl = ViewModel::class.java.getDeclaredField("impl").apply { isAccessible = true }
            impl.set(vm, impl.get(base))
            vm.javaClass.declaredFields.filter { it.name.endsWith("\$delegate") }.forEach {
                it.isAccessible = true
                it.set(vm, Slot(null))
            }
            field(vm, "api", MobileApiClient())
            field(vm, "gson", Gson())
            field(vm, "sessionGate", MobileSessionGate())
            vm.javaClass.declaredFields.firstOrNull { it.name == "workspaceConversationRefreshGenerations" }?.let {
                it.isAccessible = true; it.set(vm, mutableMapOf<String, Long>())
            }
            field(vm, "conversationUiRefreshTarget", "")
            if (vm.javaClass.declaredFields.any { it.name == "remotePeerGeneration\$delegate" }) state("remotePeerGeneration", 0L)
            state("activeDevice", PairInfo("127.0.0.1", server.port, "isolated-fixture-token", "fixture"))
            state("selectedConversationWorkspaceId", "ws")
            state("selectedConversationId", "A")
            state("openedWorkspaceId", "ws")
            listOf("remoteConversations", "workspaceConversations", "remoteMessages", "remoteWorkRuns", "lastTokens", "remoteBranchGroups").forEach { state(it, emptyList<Any>()) }
            state("fallbackModel", "")
            state("isSending", false)
            state("remoteWindowStart", 0)
            listOf("remoteViewedBranchId", "remoteRuntimeBranchId", "remoteBranchGroupId").forEach { state(it, "") }
            listOf("remoteViewedBranchNodePath", "remoteRuntimeBranchNodePath").forEach { state(it, emptyList<Any>()) }
            field(vm, "conversationUiTargetLoaded", true)
            field(vm, "conversationUiState\$delegate", Slot(ui("A-old")) { value ->
                (value as? RemoteConversationUiState)?.let { history += it.queueItems.joinToString { row -> row.text } }
            })
        }
        fun state(name: String, value: Any?) { field(vm, "$name\$delegate", Slot(value)) }
        fun setUi(value: RemoteConversationUiState) { (read(vm, "conversationUiState\$delegate") as Slot).value = value }
        fun queueText() = vm.conversationUiState.queueItems.singleOrNull()?.text.orEmpty()
        fun newerSse(text: String) {
            val event = RemoteWorkEvent(id = "new-sse", type = "queue_update", workspaceId = "ws",
                conversationId = "A", runId = "run-A", queueItems = listOf(RemoteQueueItem("row", text)))
            vm.javaClass.getDeclaredMethod("applySseEvent", RemoteWorkEvent::class.java, List::class.java)
                .apply { isAccessible = true }.invoke(vm, event, mutableListOf<Any>())
        }
        fun stateEvent(fields: String, workspace: String = "ws", conversation: String = "A", run: String = "") {
            val event = RemotePayloadNormalizer.workEvent(Gson().fromJson(
                """{"type":"queue_update","stateScope":"conversation","workspaceId":"$workspace","conversationId":"$conversation","runId":"$run",$fields}""",
                RemoteWorkEvent::class.java))
            vm.javaClass.getDeclaredMethod("applySseEvent", RemoteWorkEvent::class.java, List::class.java)
                .apply { isAccessible = true }.invoke(vm, event, mutableListOf<Any>())
        }
        fun directoryEvent(workspace: String = "ws", scope: String = "workspace", conversation: String = "") {
            val event = RemoteWorkEvent(type = "conversation_list", stateScope = scope,
                workspaceId = workspace, conversationId = conversation)
            vm.javaClass.getDeclaredMethod("applySseEvent", RemoteWorkEvent::class.java, List::class.java)
                .apply { isAccessible = true }.invoke(vm, event, mutableListOf<Any>())
        }
        fun awaitIdle() = awaitCondition { vm.viewModelScope.coroutineContext[Job]?.children?.none() != false }
        override fun close() { vm.viewModelScope.cancel() }
    }

    private fun json(value: Any) = MockResponse().addHeader("Content-Type", "application/json").setBody(Gson().toJson(value))
    private fun snapshot() = json(mapOf("messages" to emptyList<Any>(), "workRuns" to emptyList<Any>()))
    private fun awaitCondition(predicate: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!predicate() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue("real asynchronous operation did not complete", predicate())
    }
    private fun CountDownLatch.reached() { assertTrue("loopback request did not arrive", await(10, TimeUnit.SECONDS)) }

    /** Exercise the old synchronous receipt and the corrected asynchronous receipt against the same HTTP hold. */
    private fun editQueueReceipt(vm: DesktopLinkViewModel, guide: Boolean, id: String, text: String,
        targetKey: String? = null, accepted: (Boolean) -> Unit) {
        val name = if (guide) "guideEditedRemoteQueueMessage" else "updateRemoteQueueMessage"
        val method = vm.javaClass.methods.first { it.name == name }
        if (method.parameterCount == 2) {
            val result = method.invoke(vm, id, text)
            accepted(result as? Boolean ?: true)
        } else method.invoke(vm, id, text, accepted, targetKey)
    }

    private fun exerciseDeviceSwitch(kind: String) {
        val server = MockWebServer()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requestedTarget = AtomicReference<Pair<String?, String?>?>()
        val postedTarget = AtomicReference<Pair<String, String>?>()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                return when (url.encodedPath) {
                    "/api/mobile/hello" -> json(mapOf("hostname" to "fixture"))
                    "/api/mobile/state" -> json(mapOf(
                        "mode" to "plan", "status" to "idle", "activeConversationId" to "B",
                        "providers" to listOf(mapOf("id" to "fixture-provider")),
                        "conversations" to listOf(RemoteConversation("B", "B conversation", active = true)),
                        "chatMessages" to listOf(RemoteMessage(id = "B-message", content = "B fixture message")),
                        "workRuns" to emptyList<Any>(),
                        "workspaces" to mapOf("internal" to listOf(mapOf("id" to "ws-B", "name" to "B workspace")),
                            "external" to emptyList<Any>(), "current" to mapOf("id" to "ws-B")),
                    ))
                    "/api/mobile/conversation" -> {
                        requestedTarget.set(url.queryParameter("workspaceId") to url.queryParameter("conversationId"))
                        arrived.countDown(); release.await(15, TimeUnit.SECONDS)
                        MockResponse().setResponseCode(404).setBody("No target from the previous device")
                    }
                    "/api/mobile/send" -> {
                        val body = JSONObject(request.body.readUtf8())
                        postedTarget.set(body.optString("workspaceId") to body.optString("conversationId"))
                        MockResponse().setResponseCode(404).setBody("Unknown old target")
                    }
                    else -> MockResponse().setResponseCode(404).setBody("No fixture route")
                }
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val newPair = PairInfo("127.0.0.1", server.port, "new-fixture-token", "fixture")
                val oldPair = when(kind) {
                    "different-device" -> newPair.copy(host = "localhost", port = 1, token = "old-fixture-token")
                    "new-token" -> newPair.copy(token = "old-fixture-token")
                    else -> newPair
                }
                fixture.state("activeDevice", oldPair)
                (read(fixture.vm, "sessionGate") as MobileSessionGate).begin(oldPair)
                fixture.state("selectedConversationWorkspaceId", "ws-A")
                fixture.state("selectedConversationId", "A")
                fixture.state("openedWorkspaceId", "ws-A")
                fixture.state("selectedConversationTitle", "A conversation")
                fixture.state("remoteMessages", listOf(RemoteMessage(id = "A-message", content = "A fixture message")))
                fixture.setUi(ui("A queue"))
                fixture.state("liveRun", RemoteWorkRun(runId = "A-run", status = "running"))
                fixture.state("fallbackModel", "old-provider:model")
                // Exact entry-point handoff: pair/select changes activeDevice, then invokes refresh().
                // Disk pairing and Android service registration are outside this JVM fixture.
                val oldComposerKey = fixture.vm.remoteComposerTargetKey
                fixture.state("activeDevice", newPair)
                fixture.vm.refresh()
                arrived.reached()
                val stateAfterNewHelloAndState = mapOf(
                    "selectedWorkspace" to fixture.vm.selectedConversationWorkspaceId,
                    "selectedConversation" to fixture.vm.selectedConversationId,
                    "openedWorkspace" to fixture.vm.openedWorkspaceId,
                    "desktopWorkspace" to fixture.vm.desktopState?.currentWorkspaceId,
                    "desktopActiveConversation" to fixture.vm.desktopState?.activeConversationId,
                    "messageIds" to fixture.vm.remoteMessages.map { it.id },
                    "queueTexts" to fixture.vm.conversationUiState.queueItems.map { it.text },
                    "flowRunning" to fixture.vm.conversationUiState.flow?.running,
                    "requestedWorkspace" to requestedTarget.get()?.first,
                    "requestedConversation" to requestedTarget.get()?.second,
                )
                fixture.vm.sendToDesktop("Fresh fixture message after pairing")
                awaitCondition { postedTarget.get() != null }
                val report = mapOf("kind" to kind, "observed" to stateAfterNewHelloAndState,
                    "sentWorkspace" to postedTarget.get()?.first, "sentConversation" to postedTarget.get()?.second,
                    "boundary" to "Actual refresh/beginConnectionSession/connect/sendToDesktop and real loopback HTTP; only initial Android construction and entry-point activeDevice assignment are isolated.")
                System.getProperty("probe.evidence")?.let { java.io.File(it, "$kind.json").writeText(Gson().toJson(report)) }
                if(kind == "same-peer-refresh") {
                    assertEquals("Same peer reconnect must keep independent mobile selection", "ws-A" to "A", requestedTarget.get())
                    assertEquals("ws-A" to "A", postedTarget.get())
                    assertEquals(oldComposerKey, fixture.vm.remoteComposerTargetKey)
                    assertTrue(fixture.vm.remoteMessages.any { it.id == "A-message" })
                    assertEquals("A queue", fixture.queueText())
                    assertEquals(true, fixture.vm.conversationUiState.flow?.running)
                    assertEquals("A-run", fixture.vm.liveRun?.runId)
                } else {
                    assertEquals("New peer must not request the previous peer's target", "ws-B" to "B", requestedTarget.get())
                    assertEquals("ws-B" to "B", postedTarget.get())
                    assertFalse(fixture.vm.remoteMessages.any { it.id == "A-message" })
                    assertTrue(fixture.vm.conversationUiState.queueItems.isEmpty())
                    assertNull(fixture.vm.conversationUiState.flow)
                    assertNull(fixture.vm.liveRun)
                    assertEquals("", fixture.vm.fallbackModel)
                    assertFalse(fixture.vm.conversationUiState.runtime?.running == true)
                    assertNull(fixture.vm.openedWorkspaceId)
                    assertNull(fixture.vm.selectedConversationTitle)
                    assertNotEquals(oldComposerKey, fixture.vm.remoteComposerTargetKey)
                }
            } finally {
                fixture.close(); release.countDown(); server.shutdown()
            }
        }
    }

    @Test fun switchingPeerMustRetirePreviousPeerTarget() = exerciseDeviceSwitch("different-device")
    @Test fun pairingNewTokenMustRetirePreviousPeerTarget() = exerciseDeviceSwitch("new-token")
    @Test fun reconnectingSamePeerPreservesMobileSelection() = exerciseDeviceSwitch("same-peer-refresh")

    private fun exerciseLateSendAcrossPeer(sameHostNewToken: Boolean) {
        val server = MockWebServer()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = Collections.synchronizedList(mutableListOf<RecordedRequest>())
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                return json(mapOf("ok" to true, "chatMessages" to listOf(RemoteMessage(id = "old-reply", content = "old peer"))))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val oldPair = fixture.vm.activeDevice!!
                val gate = read(fixture.vm, "sessionGate") as MobileSessionGate
                gate.begin(oldPair)
                val oldKey = fixture.vm.remoteComposerTargetKey
                val drafts = mutableMapOf<String, ConversationComposerDraft>()
                val oldDraft = drafts.getOrPut(oldKey) { ConversationComposerDraft() }
                oldDraft.inputValue = TextFieldValue("old peer send")
                val receipt = oldDraft.acceptance()
                val accepted = AtomicReference<Boolean?>(null)
                fixture.vm.sendToDesktop(oldDraft.inputValue.text, onAccepted = { accepted.set(it); receipt(it) }, expectedTargetKey = oldKey)
                arrived.reached()
                val nextPair = if (sameHostNewToken) oldPair.copy(token = "replacement-fixture-token") else oldPair.copy(host = "localhost")
                fixture.state("activeDevice", nextPair)
                fixture.vm.javaClass.getDeclaredMethod("beginConnectionSession", PairInfo::class.java)
                    .apply { isAccessible = true }.invoke(fixture.vm, nextPair)
                // Valid peers can independently use identical workspace/conversation identifiers.
                fixture.state("selectedConversationWorkspaceId", "ws")
                fixture.state("selectedConversationId", "A")
                fixture.setUi(ui("new peer queue"))
                fixture.state("remoteMessages", listOf(RemoteMessage(id = "new-peer", content = "new peer history")))
                val newKey = fixture.vm.remoteComposerTargetKey
                assertNotEquals("Authentication/peer changes must retire same-id drafts", oldKey, newKey)
                assertFalse("The observable draft key must not contain credentials", newKey.contains(nextPair.token))
                val newDraft = drafts.getOrPut(newKey) { ConversationComposerDraft() }
                assertTrue(newDraft.inputValue.text.isEmpty())
                assertNull(newDraft.queueEdit)
                newDraft.inputValue = TextFieldValue("new peer draft")
                newDraft.queueEdit = QueueMessageUi("row", "new peer queue", true)
                for (guide in listOf(false, true)) {
                    editQueueReceipt(fixture.vm, guide, "row", "stale edit", oldKey) { assertFalse(it) }
                }
                fixture.vm.sendToDesktop("stale send", onAccepted = { assertFalse(it) }, expectedTargetKey = oldKey)
                fixture.vm.reorderRemoteQueueMessages(listOf("row"), { assertFalse(it) }, oldKey)
                release.countDown(); fixture.awaitIdle()
                assertEquals(true, accepted.get())
                assertEquals("", oldDraft.inputValue.text)
                assertEquals("new peer draft", newDraft.inputValue.text)
                assertEquals("row", newDraft.queueEdit?.id)
                assertEquals("new peer queue", fixture.queueText())
                assertEquals(listOf("new-peer"), fixture.vm.remoteMessages.map { it.id })
                assertFalse(fixture.vm.isSending)
                assertEquals("Only the already submitted old-peer request may reach HTTP", 1, requests.size)
                assertEquals(oldPair.token, requests.single().requestUrl!!.queryParameter("token"))
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun lateAcceptedSendCannotClearSameIdDraftAfterTokenReplacement() = exerciseLateSendAcrossPeer(true)
    @Test fun lateAcceptedSendCannotClearSameIdDraftAfterDeviceSwitch() = exerciseLateSendAcrossPeer(false)

    @Test fun unpairRetiresSelectedTargetAndItsRunningStateBeforeAnotherPair() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                (read(fixture.vm, "sessionGate") as MobileSessionGate).begin(fixture.vm.activeDevice!!)
                fixture.state("selectedConversationTitle", "old title")
                fixture.state("remoteWorkRuns", listOf(RemoteWorkRun(runId = "old-run", status = "running")))
                fixture.state("liveRun", RemoteWorkRun(runId = "old-run", status = "running"))
                fixture.state("rightSidebarEditorPath", "old/file.txt")
                fixture.state("rightSidebarEditorContent", "old peer editor draft")
                val oldKey = fixture.vm.remoteComposerTargetKey
                fixture.vm.javaClass.getDeclaredMethod("clearSession").apply { isAccessible = true }.invoke(fixture.vm)
                assertNull(fixture.vm.selectedConversationWorkspaceId)
                assertNull(fixture.vm.selectedConversationId)
                assertNull(fixture.vm.selectedConversationTitle)
                assertNull(fixture.vm.liveRun)
                assertTrue(fixture.vm.remoteWorkRuns.isEmpty())
                assertTrue(fixture.vm.conversationUiState.queueItems.isEmpty())
                assertNull(fixture.vm.conversationUiState.flow)
                assertEquals("", fixture.vm.rightSidebarEditorPath)
                assertEquals("", fixture.vm.rightSidebarEditorContent)
                assertNotEquals(oldKey, fixture.vm.remoteComposerTargetKey)
            } finally { server.shutdown() }
        }
    }

    private fun delayedPeerManagementCannotRewriteCurrentUi(reject: Boolean) {
        val failures = mutableListOf<String>()
        for (action in listOf("create", "rename", "pin", "reorder", "archive", "plan", "sidebar", "directory", "file", "save")) {
            val server = MockWebServer()
            val arrived = CountDownLatch(1)
            val release = CountDownLatch(1)
            val requests = java.util.concurrent.atomic.AtomicInteger()
            val receipts = java.util.concurrent.atomic.AtomicInteger()
            server.dispatcher = object : HttpDispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.incrementAndGet(); arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                    return if (reject) MockResponse().setResponseCode(503).setBody("old peer rejected")
                    else json(mapOf("conversations" to listOf(RemoteConversation("A", "old returned title", active = true)),
                        "conversation" to mapOf("id" to "A"), "conversationPlan" to RemoteConversationPlan(listOf(RemotePlanItem("old", "old returned plan"))),
                        "path" to "old/returned.txt", "content" to "old returned editor", "entries" to emptyList<Any>()))
                }
            }
            server.start()
            Fixture(server).use { fixture ->
                try {
                    val oldPair = fixture.vm.activeDevice!!
                    (read(fixture.vm, "sessionGate") as MobileSessionGate).begin(oldPair)
                    val oldRow = RemoteConversation("A", "old title")
                    fixture.state("workspaceConversations", listOf(oldRow, RemoteConversation("B", "other")))
                    fixture.state("workspaceReorderPending", false)
                    fixture.state("workspaceArchivePendingKeys", emptySet<String>())
                    fixture.state("rightSidebarPath", "")
                    fixture.state("rightSidebarPlan", RemoteConversationPlan())
                    fixture.state("rightSidebarEditorPath", "old/file.txt")
                    fixture.state("rightSidebarEditorContent", "old content")
                    val done: (Boolean, String) -> Unit = { _, _ -> receipts.incrementAndGet() }
                    when (action) {
                        "create" -> fixture.vm.createWorkspaceConversation(done)
                        "rename" -> fixture.vm.renameWorkspaceConversation(oldRow, "old rename", done)
                        "pin" -> fixture.vm.toggleWorkspaceConversationPin(oldRow, done)
                        "reorder" -> fixture.vm.reorderWorkspaceConversations(listOf("B", "A"), done)
                        "archive" -> fixture.vm.archiveRemote(oldRow, done)
                        "plan" -> fixture.vm.addRightSidebarPlanItem("old plan mutation")
                        "sidebar" -> fixture.vm.refreshRightSidebar()
                        "directory" -> fixture.vm.loadRightSidebarDirectory("old")
                        "file" -> fixture.vm.openRightSidebarFile("old/file.txt")
                        "save" -> fixture.vm.saveRightSidebarFile()
                    }
                    arrived.reached()
                    fixture.state("activeDevice", oldPair.copy(token = "new-peer-fixture-token"))
                    fixture.vm.javaClass.getDeclaredMethod("beginConnectionSession", PairInfo::class.java)
                        .apply { isAccessible = true }.invoke(fixture.vm, fixture.vm.activeDevice!!)
                    fixture.state("openedWorkspaceId", "ws")
                    fixture.state("selectedConversationWorkspaceId", "ws")
                    fixture.state("selectedConversationId", "A")
                    fixture.state("selectedConversationTitle", "new title")
                    val freshRows = listOf(RemoteConversation("A", "new title"), RemoteConversation("B", "new B"))
                    fixture.state("workspaceConversations", freshRows)
                    fixture.state("remoteConversations", freshRows)
                    fixture.state("desktopState", DesktopState(currentWorkspaceId = "ws"))
                    val freshPlan = RemoteConversationPlan(listOf(RemotePlanItem("new", "new plan")))
                    fixture.state("rightSidebarPlan", freshPlan)
                    fixture.state("rightSidebarEditorPath", "new/file.txt")
                    fixture.state("rightSidebarEditorContent", "new draft")
                    fixture.state("rightSidebarPath", "new")
                    fixture.state("rightSidebarLoading", true)
                    fixture.state("rightSidebarSaving", true)
                    fixture.state("workspaceReorderPending", true)
                    fixture.state("workspaceArchivePendingKeys", setOf("ws::A"))
                    release.countDown(); fixture.awaitIdle()
                    assertEquals("new title", fixture.vm.selectedConversationTitle)
                    assertEquals(freshRows, fixture.vm.workspaceConversations)
                    assertEquals(freshRows, fixture.vm.remoteConversations)
                    assertEquals(freshPlan, fixture.vm.rightSidebarPlan)
                    assertEquals("new/file.txt", fixture.vm.rightSidebarEditorPath)
                    assertEquals("new draft", fixture.vm.rightSidebarEditorContent)
                    assertEquals("new", fixture.vm.rightSidebarPath)
                    assertTrue(fixture.vm.rightSidebarLoading)
                    assertTrue(fixture.vm.rightSidebarSaving)
                    assertTrue(fixture.vm.workspaceReorderPending)
                    assertEquals(setOf("A"), fixture.vm.workspaceArchivePendingIds)
                    assertNull(fixture.vm.lastError)
                    assertEquals("An old peer must not finish a new peer's UI operation", 0, receipts.get())
                    assertEquals("No follow-up call may read from the replacement peer", 1, requests.get())
                } catch (failure: AssertionError) {
                    failures += "$action/reject=$reject: ${failure.message}"
                } finally { release.countDown(); server.shutdown() }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test fun delayedPeerManagementSuccessCannotRewriteNewPeerUi() = delayedPeerManagementCannotRewriteCurrentUi(false)
    @Test fun delayedPeerManagementFailureCannotRewriteNewPeerUi() = delayedPeerManagementCannotRewriteCurrentUi(true)

    @Test fun ordinarySamePeerReconnectKeepsDraftAndAcceptsPendingRename() {
        val server = MockWebServer()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                return json(mapOf("conversations" to listOf(RemoteConversation("A", "renamed"))))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val pair = fixture.vm.activeDevice!!
                (read(fixture.vm, "sessionGate") as MobileSessionGate).begin(pair)
                val key = fixture.vm.remoteComposerTargetKey
                val drafts = mutableMapOf(key to ConversationComposerDraft())
                val draft = drafts.getValue(key)
                draft.inputValue = TextFieldValue("keep my draft")
                val accepted = AtomicReference<Boolean?>(null)
                fixture.vm.renameWorkspaceConversation(RemoteConversation("A", "old"), "renamed") { ok, _ -> accepted.set(ok) }
                arrived.reached()
                fixture.vm.javaClass.getDeclaredMethod("beginConnectionSession", PairInfo::class.java)
                    .apply { isAccessible = true }.invoke(fixture.vm, pair)
                assertEquals(key, fixture.vm.remoteComposerTargetKey)
                assertSame(draft, drafts.getValue(fixture.vm.remoteComposerTargetKey))
                release.countDown(); fixture.awaitIdle()
                assertEquals(true, accepted.get())
                assertEquals("renamed", fixture.vm.selectedConversationTitle)
                assertEquals("renamed", fixture.vm.workspaceConversations.single().title)
                assertEquals("keep my draft", draft.inputValue.text)
                assertEquals("ws", fixture.vm.selectedConversationWorkspaceId)
                assertEquals("A", fixture.vm.selectedConversationId)
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun workspaceDirectoryEventsRefreshAddedRenamedReorderedAndRemovedRowsWithoutSelectingPcActive() {
        val server = MockWebServer()
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.state("desktopState", DesktopState(currentWorkspaceId = "ws", activeConversationId = "B"))
                fixture.state("selectedConversationTitle", "A title")
                val selectedUi = fixture.vm.conversationUiState
                val stages = listOf(
                    listOf(RemoteConversation("A", "A title"), RemoteConversation("B", "B created", active = true)),
                    listOf(RemoteConversation("B", "B renamed", pinned = true, active = true), RemoteConversation("A", "A title")),
                    listOf(RemoteConversation("A", "A title", active = true)),
                )
                for (rows in stages) {
                    server.enqueue(json(mapOf("conversations" to rows)))
                    fixture.directoryEvent()
                    val request = server.takeRequest(2, TimeUnit.SECONDS)
                    assertNotNull("workspace event with empty conversation/run must refresh the directory", request)
                    assertEquals("/api/mobile/workspace-conversations", request!!.requestUrl!!.encodedPath)
                    assertEquals("ws", request.requestUrl!!.queryParameter("workspaceId"))
                    fixture.awaitIdle()
                    assertEquals(rows, fixture.vm.workspaceConversations)
                    assertEquals(rows, fixture.vm.remoteConversations)
                    assertEquals("A", fixture.vm.selectedConversationId)
                    assertEquals("ws", fixture.vm.selectedConversationWorkspaceId)
                    assertEquals("A title", fixture.vm.selectedConversationTitle)
                    assertSame(selectedUi, fixture.vm.conversationUiState)
                }
            } finally { server.shutdown() }
        }
    }

    @Test fun directoryEventRetiresOlderOpenWorkspaceResponse() {
        val server = MockWebServer()
        val first = CountDownLatch(1)
        val release = CountDownLatch(1)
        val count = java.util.concurrent.atomic.AtomicInteger()
        val old = listOf(RemoteConversation("A", "stale"))
        val fresh = listOf(RemoteConversation("B", "created after request"), RemoteConversation("A", "renamed"))
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (count.incrementAndGet() == 1) {
                    first.countDown(); release.await(10, TimeUnit.SECONDS)
                    return json(mapOf("conversations" to old))
                }
                return json(mapOf("conversations" to fresh))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.vm.openWorkspace(WorkspaceInfo("ws", "workspace"))
                first.reached()
                fixture.directoryEvent()
                awaitCondition { fixture.vm.workspaceConversations == fresh }
                release.countDown(); fixture.awaitIdle()
                assertEquals("late initial load must not restore a removed/renamed directory row", fresh, fixture.vm.workspaceConversations)
                assertEquals("A", fixture.vm.selectedConversationId)
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun directoryRefreshesForTwoVisibleWorkspacesDoNotCancelEachOther() {
        val server = MockWebServer()
        val first = CountDownLatch(1)
        val release = CountDownLatch(1)
        val mainRows = listOf(RemoteConversation("main-new", "main list"))
        val otherRows = listOf(RemoteConversation("other-new", "opened list"))
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.queryParameter("workspaceId") == "ws") {
                    first.countDown(); release.await(10, TimeUnit.SECONDS)
                    return json(mapOf("conversations" to mainRows))
                }
                return json(mapOf("conversations" to otherRows))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.state("desktopState", DesktopState(currentWorkspaceId = "ws"))
                fixture.state("openedWorkspaceId", "other")
                fixture.directoryEvent("ws"); first.reached()
                fixture.directoryEvent("other")
                awaitCondition { fixture.vm.workspaceConversations == otherRows }
                release.countDown(); fixture.awaitIdle()
                assertEquals(mainRows, fixture.vm.remoteConversations)
                assertEquals(otherRows, fixture.vm.workspaceConversations)
                assertEquals("A", fixture.vm.selectedConversationId)
                assertEquals("ws", fixture.vm.selectedConversationWorkspaceId)
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun staleDirectoryResponseCannotCrossDeviceOrConnectionGeneration() {
        for (newConnectionSameDevice in listOf(false, true)) {
            val server = MockWebServer()
            val first = CountDownLatch(1)
            val release = CountDownLatch(1)
            server.dispatcher = object : HttpDispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    first.countDown(); release.await(10, TimeUnit.SECONDS)
                    return json(mapOf("conversations" to listOf(RemoteConversation("stale", "stale peer"))))
                }
            }
            server.start()
            Fixture(server).use { fixture ->
                try {
                    val pair = fixture.vm.activeDevice!!
                    val gate = read(fixture.vm, "sessionGate") as MobileSessionGate
                    gate.begin(pair)
                    fixture.directoryEvent(); first.reached()
                    val currentRows = listOf(RemoteConversation("current", "new connection"))
                    if (newConnectionSameDevice) gate.begin(pair)
                    else fixture.state("activeDevice", pair.copy(token = "another-pair-token"))
                    fixture.state("workspaceConversations", currentRows)
                    release.countDown(); fixture.awaitIdle()
                    assertEquals(currentRows, fixture.vm.workspaceConversations)
                } finally { release.countDown(); server.shutdown() }
            }
        }
    }

    @Test fun directoryNotificationsRejectWrongScopeTurnIdentityAndInvisibleWorkspace() {
        val server = MockWebServer()
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.directoryEvent(scope = "conversation")
                fixture.directoryEvent(conversation = "A")
                fixture.directoryEvent(workspace = "unopened")
                fixture.directoryEvent(workspace = "")
                fixture.awaitIdle()
                assertNull(server.takeRequest(150, TimeUnit.MILLISECONDS))
                assertEquals("A", fixture.vm.selectedConversationId)
                assertEquals("A-old", fixture.queueText())
            } finally { server.shutdown() }
        }
    }

    @Test fun queueEditAndGuideWaitForActualAcceptanceAndPreserveRejectedDraft() {
        for (guide in listOf(false, true)) for (reject in listOf(false, true)) {
            val received = CountDownLatch(1)
            val release = CountDownLatch(1)
            val callback = AtomicReference<Boolean?>(null)
            var draft = "edited draft"
            val server = MockWebServer()
            server.dispatcher = object : HttpDispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method == "POST") {
                        received.countDown(); release.await(10, TimeUnit.SECONDS)
                        return if (reject) json(mapOf("ok" to false, "receipt" to mapOf("status" to "rejected", "reason" to "held rejection")))
                        else json(mapOf("ok" to true))
                    }
                    return json(ui("original"))
                }
            }
            server.start()
            Fixture(server).use { fixture ->
                try {
                    fixture.setUi(ui("original"))
                    editQueueReceipt(fixture.vm, guide, "row", draft) { accepted ->
                        callback.set(accepted); if (accepted) draft = ""
                    }
                    received.reached()
                    assertNull("launching an HTTP mutation is not acceptance", callback.get())
                    assertEquals("edited draft", draft)
                    release.countDown(); fixture.awaitIdle()
                    assertEquals(!reject, callback.get())
                    assertEquals(if (reject) "edited draft" else "", draft)
                } finally { release.countDown(); server.shutdown() }
            }
        }
    }

    @Test fun staleQueueEditorCannotSendItsIdToANewTarget() {
        val posts = Collections.synchronizedList(mutableListOf<JSONObject>())
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") posts += JSONObject(request.body.readUtf8())
                return json(mapOf("ok" to true))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val targetA = fixture.vm.remoteComposerTargetKey
                fixture.state("selectedConversationId", "B")
                fixture.setUi(ui("B same id"))
                for (guide in listOf(false, true)) {
                    val accepted = AtomicReference<Boolean?>(null)
                    editQueueReceipt(fixture.vm, guide, "row", "A draft", targetA) { accepted.set(it) }
                    assertEquals(false, accepted.get())
                }
                fixture.vm.reorderRemoteQueueMessages(listOf("row"), { assertFalse(it) }, targetA)
                fixture.awaitIdle()
                assertTrue("a stale UI target must not produce a POST", posts.isEmpty())
                assertEquals("B same id", fixture.queueText())
            } finally { server.shutdown() }
        }
    }

    @Test fun targetDraftAcceptancePreservesRejectedNewerAndOtherConversationInput() {
        val drafts = mutableMapOf<String, ConversationComposerDraft>()
        val a = drafts.getOrPut("A") { ConversationComposerDraft() }
        a.inputValue = TextFieldValue("edited A")
        a.queueEdit = QueueMessageUi("same-id", "old A", true, "goal", "A objective")
        a.pendingImage = pickedImage()
        a.acceptance()(false)
        assertEquals("edited A", a.inputValue.text)
        assertEquals("same-id", a.queueEdit?.id)
        assertNotNull(a.pendingImage)
        val oldAcknowledgement = a.acceptance()
        a.inputValue = TextFieldValue("newer A")
        oldAcknowledgement(true)
        assertEquals("newer A", a.inputValue.text)
        val b = drafts.getOrPut("B") { ConversationComposerDraft() }
        b.inputValue = TextFieldValue("B draft")
        b.queueEdit = QueueMessageUi("same-id", "old B", true)
        a.acceptance()(true)
        assertEquals("B draft", b.inputValue.text)
        assertEquals("same-id", b.queueEdit?.id)
        assertSame(a, drafts.getValue("A"))
        assertTrue(a.inputValue.text.isEmpty())
        assertNull(a.queueEdit)
        assertNull(a.pendingImage)
    }

    @Test fun queueDragRetainsEditingAndNewIdsAndRejectsRemovedAnchors() {
        val edit = QueueMessageUi("editing", "edited row", true, "goal", "retain objective")
        val b = QueueMessageUi("B", "same", true, "plan")
        val c = QueueMessageUi("C", "same", true, "chat")
        val added = QueueMessageUi("new", "PC added", true)
        val shown = listOf(edit, b, c)
        val moved = queueOrderAfterDrag(shown, shown, "C", 0)
        assertEquals(listOf("C", "editing", "B"), moved.map { it.id })
        assertSame(edit, moved[1])
        val current = listOf(edit, c, added)
        assertEquals(listOf("C", "editing", "new"), queueOrderAfterDrag(current, shown, "C", 0).map { it.id })
        assertEquals(current, queueOrderAfterDrag(current, shown, "C", 1))
        assertEquals(current, queueOrderAfterDrag(current, shown, "B", 0))
    }

    @Test fun queueBusinessAndTransportFailuresNeverAcknowledgeAnEdit() {
        for (response in listOf(json(mapOf("error" to "queue unavailable")), MockResponse().setResponseCode(503).setBody("unavailable"))) {
            val server = MockWebServer()
            server.dispatcher = object : HttpDispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = if (request.method == "POST") response else json(ui("original"))
            }
            server.start()
            Fixture(server).use { fixture ->
                try {
                    val accepted = AtomicReference<Boolean?>(null)
                    fixture.vm.updateRemoteQueueMessage("row", "retain edit", { accepted.set(it) })
                    fixture.awaitIdle()
                    assertEquals(false, accepted.get())
                    assertNotNull(fixture.vm.lastError)
                } finally { server.shutdown() }
            }
        }
    }

    private fun pickedImage() = LocalImageAttachment(name = "picked.png", mimeType = "image/png",
        dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=")

    private fun sendPickedImages(vm: DesktopLinkViewModel, text: String, images: List<LocalImageAttachment>,
        forceGuide: Boolean = false, queuedItem: LocalQueuedMessage? = null) {
        vm.sendToDesktop(text, forceGuide = forceGuide, queuedItem = queuedItem, images = images)
    }

    @Test fun pickedImagesReachActualHttpAcrossEveryModeAndDeliveryMode() {
        val captured = Collections.synchronizedList(mutableListOf<JSONObject>())
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    captured += JSONObject(request.body.readUtf8())
                    return json(mapOf("tokens" to emptyList<String>()))
                }
                return if (request.requestUrl!!.encodedPath == "/api/mobile/conversation") snapshot() else json(ui(""))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                for (mode in listOf("build", "chat", "plan", "goal", "flow")) for (guide in listOf(false, true)) {
                    fixture.setUi(ui("").copy(mode = mode, inputMode = "next", goal = RemoteGoal(objective = "frozen image goal")))
                    sendPickedImages(fixture.vm, " image caption ", listOf(pickedImage()), forceGuide = guide)
                    fixture.awaitIdle()
                    val body = captured.last()
                    val message = body.optJSONObject("message")
                    assertNotNull("HTTP message must retain the picked image, not flatten it to a string", message)
                    assertEquals("image caption", message!!.getString("text"))
                    val image = message.getJSONArray("images").getJSONObject(0)
                    assertEquals("picked.png", image.getString("name"))
                    assertEquals("image/png", image.getString("type"))
                    assertEquals(pickedImage().dataUrl, image.getString("dataUrl"))
                    assertEquals("ws", body.getString("workspaceId")); assertEquals("A", body.getString("conversationId"))
                    assertEquals(mode, body.getString("requestedMode"))
                    assertEquals(if (guide) "guide" else "next", body.getString("inputMode"))
                    assertEquals(if (mode == "goal") "frozen image goal" else "", body.optString("goalObjective"))
                }
                assertEquals(10, captured.size)
                assertEquals(10, captured.map { it.getString("clientMessageId") }.toSet().size)
            } finally { server.shutdown() }
        }
    }

    @Test fun imageListAndQueuedGoalAreFrozenBeforeBranchActivationSuspends() {
        val arrived = CountDownLatch(1); val release = CountDownLatch(1)
        val captured = AtomicReference<JSONObject>()
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath == "/api/mobile/conversation-branch-activate") {
                    arrived.countDown(); release.await(10, TimeUnit.SECONDS); return snapshot()
                }
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    captured.set(JSONObject(request.body.readUtf8())); return json(mapOf("tokens" to emptyList<String>()))
                }
                return if (request.requestUrl!!.encodedPath == "/api/mobile/conversation") snapshot() else json(ui(""))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.state("remoteViewedBranchId", "viewed"); fixture.state("remoteRuntimeBranchId", "runtime")
                fixture.setUi(ui("").copy(mode = "plan", inputMode = "next"))
                val images = mutableListOf(pickedImage())
                sendPickedImages(fixture.vm, "caption", images, forceGuide = true,
                    queuedItem = LocalQueuedMessage("same-item", "caption", requestedMode = "goal", goalObjective = "original item goal"))
                arrived.reached()
                images.clear(); images += pickedImage().copy(name = "different.png")
                fixture.setUi(ui("").copy(mode = "chat", inputMode = "next"))
                release.countDown(); fixture.awaitIdle()
                val body = captured.get()
                assertNotNull(body)
                assertEquals("original item goal", body.getString("goalObjective"))
                assertEquals("goal", body.getString("requestedMode")); assertEquals("guide", body.getString("inputMode"))
                assertEquals("ws", body.getString("workspaceId")); assertEquals("A", body.getString("conversationId"))
                assertEquals("picked.png", body.getJSONObject("message").getJSONArray("images").getJSONObject(0).getString("name"))
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun imageOnlyInputIsSubmittedWhileEmptyTextWithoutImagesIsIgnored() {
        val captured = Collections.synchronizedList(mutableListOf<JSONObject>())
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    captured += JSONObject(request.body.readUtf8()); return json(mapOf("tokens" to emptyList<String>()))
                }
                return if (request.requestUrl!!.encodedPath == "/api/mobile/conversation") snapshot() else json(ui(""))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                sendPickedImages(fixture.vm, "  ", listOf(pickedImage())); fixture.awaitIdle()
                assertEquals("an image is content even with no caption", 1, captured.size)
                assertEquals("", captured.single().getJSONObject("message").getString("text"))
                assertEquals(1, captured.single().getJSONObject("message").getJSONArray("images").length())
                fixture.vm.sendToDesktop("  "); fixture.awaitIdle()
                assertEquals(1, captured.size)
            } finally { server.shutdown() }
        }
    }

    @Test fun http200SendRejectionsShowTheirReasonWithoutRefreshingOrClearingExistingContent() {
        val reply = AtomicReference<Any>()
        val reads = Collections.synchronizedList(mutableListOf<String>())
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    return json(reply.get())
                }
                reads += request.requestUrl!!.encodedPath
                return if (request.requestUrl!!.encodedPath == "/api/mobile/conversation") snapshot() else json(ui(""))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val rejected = listOf(
                    mapOf("error" to "Target conversation unavailable") to "Target conversation unavailable",
                    mapOf("ok" to false, "receipt" to mapOf("status" to "rejected", "reason" to "Flow Guide cannot take over this run")) to "Flow Guide cannot take over this run",
                    mapOf("ok" to false) to "远程端未接受此消息",
                )
                val messages = listOf(RemoteMessage(id = "kept-message", role = "assistant", content = "existing transcript"))
                val tokens = listOf(WorkEvent(type = "text", content = "previous result"))
                for ((response, reason) in rejected) {
                    reply.set(response)
                    fixture.state("remoteMessages", messages); fixture.state("lastTokens", tokens)
                    fixture.vm.sendToDesktop("new input"); fixture.awaitIdle()
                    assertEquals("发送失败：$reason", fixture.vm.lastError)
                    assertEquals(messages, fixture.vm.remoteMessages)
                    assertEquals(tokens, fixture.vm.lastTokens)
                    assertTrue("a rejected command must not enter success history/state refresh", reads.isEmpty())
                    assertFalse(fixture.vm.isSending)
                }
            } finally { server.shutdown() }
        }
    }

    @Test fun actualImageGuideCallbackClearsOnlyAfterItsHttpAcknowledgementAccepts() {
        for (accepted in listOf(true, false)) {
            val arrived = CountDownLatch(1); val release = CountDownLatch(1)
            val captured = AtomicReference<JSONObject>()
            val server = MockWebServer()
            server.dispatcher = object : HttpDispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method == "POST") {
                        assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                        captured.set(JSONObject(request.body.readUtf8()))
                        arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                        return json(mapOf("ok" to accepted, "receipt" to mapOf(
                            "status" to if (accepted) "accepted" else "rejected", "reason" to "Guide not accepted")))
                    }
                    return if (request.requestUrl!!.encodedPath == "/api/mobile/conversation") snapshot() else json(ui(""))
                }
            }
            server.start()
            Fixture(server).use { fixture ->
                try {
                    var pending = true
                    val handled = dispatchRemoteImageGuide(true, "", pickedImage(),
                        send = { text, images, callback -> fixture.vm.sendToDesktop(text,
                            forceGuide = true, images = images, onAccepted = callback) },
                        onAccepted = { pending = false })
                    assertTrue(handled); arrived.reached()
                    assertTrue("starting a coroutine is not a backend Guide acceptance", pending)
                    assertEquals("guide", captured.get().getString("inputMode"))
                    assertEquals(1, captured.get().getJSONObject("message").getJSONArray("images").length())
                    release.countDown(); fixture.awaitIdle()
                    assertEquals("only the accepted Guide clears its pending image", !accepted, pending)
                    if (!accepted) assertEquals("发送失败：Guide not accepted", fixture.vm.lastError)
                } finally { release.countDown(); server.shutdown() }
            }
        }
    }

    @Test fun remoteImageContentRoutingPreservesLocalAndTextOnlyCallbacks() {
        assertTrue(remoteInputHasContent(true, "", pickedImage()))
        assertFalse(remoteInputHasContent(false, "", pickedImage()))
        assertTrue(remoteInputHasContent(false, "text", null))
        assertTrue(remoteInputHasContent(true, "text", null))
        assertFalse(remoteInputHasContent(true, " ", null))
        val neverSend: (String, List<LocalImageAttachment>, (Boolean) -> Unit) -> Unit = { _, _, _ -> fail("existing callback must own this input") }
        assertFalse(dispatchRemoteImageGuide(false, "text", pickedImage(), neverSend) { fail("local image must be untouched") })
        assertFalse(dispatchRemoteImageGuide(true, "text", null, neverSend) { fail("text path must be untouched") })
        assertFalse(dispatchRemoteImageGuide(true, "text", pickedImage(), null) { fail("missing remote adapter must be untouched") })
    }

    @Test fun changingTargetClearsOldFlowQueueAndTranscriptBeforeTheNewHttpResponse() {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path!!.startsWith("/api/mobile/conversation?")) {
                    arrived.countDown(); release.await(10, TimeUnit.SECONDS); return snapshot()
                }
                return json(ui("", flow = false))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.state("remoteMessages", listOf(RemoteMessage(id = "A-message", content = "A transcript")))
                fixture.state("lastError", "A error")
                fixture.state("fallbackModel", "A fallback")
                fixture.vm.selectConversation("B", "ws")
                arrived.reached()
                assertEquals("B", fixture.vm.selectedConversationId)
                assertNull("B cannot expose A's actionable takeover", fixture.vm.conversationUiState.flow)
                assertTrue(fixture.vm.editableRemoteQueue.isEmpty())
                assertTrue(fixture.vm.remoteMessages.isEmpty())
                assertTrue(fixture.vm.remoteWorkRuns.isEmpty())
                assertNull(fixture.vm.lastError)
                assertEquals("switching targets clears the old model fallback before HTTP completes", "", fixture.vm.fallbackModel)
                release.countDown(); fixture.awaitIdle()
                assertNull(fixture.vm.conversationUiState.flow)
                assertTrue(fixture.vm.editableRemoteQueue.isEmpty())
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun aDelayedQueueReplyCannotOverwriteANewerSseCommit() {
        val actionArrived = CountDownLatch(1)
        val releaseAction = CountDownLatch(1)
        val freshRead = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    actionArrived.countDown(); releaseAction.await(10, TimeUnit.SECONDS)
                    return json(mapOf("ok" to true, "queueItems" to listOf(RemoteQueueItem("row", "old-http-reply"))))
                }
                freshRead.countDown(); return json(ui("newer-sse-value"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.vm.updateRemoteQueueMessage("row", "old-http-reply")
                actionArrived.reached()
                fixture.newerSse("newer-sse-value")
                assertEquals("newer-sse-value", fixture.queueText())
                releaseAction.countDown(); freshRead.reached(); fixture.awaitIdle()
                assertEquals("newer-sse-value", fixture.queueText())
                assertFalse("even a transient rollback is forbidden", fixture.history.contains("old-http-reply"))
            } finally { releaseAction.countDown(); server.shutdown() }
        }
    }

    @Test fun aSnapshotStartedBeforeAnSseCommitCannotRollTheQueueBack() {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                arrived.countDown(); release.await(10, TimeUnit.SECONDS); return json(ui("old-poll"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.vm.refreshConversationUiState(); arrived.reached()
                fixture.newerSse("newer-sse-value")
                release.countDown(); fixture.awaitIdle()
                assertEquals("newer-sse-value", fixture.queueText())
                assertFalse(fixture.history.contains("old-poll"))
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun returningToTheSameTargetDoesNotAcceptAnEarlierVisitActionError() {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                    return json(mapOf("ok" to false, "receipt" to mapOf("reason" to "obsolete-action-error")))
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(ui("current-visit"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.vm.updateRemoteQueueMessage("row", "first-visit"); arrived.reached()
                fixture.vm.selectConversation("B", "ws")
                fixture.vm.selectConversation("A", "ws")
                awaitCondition { fixture.queueText() == "current-visit" }
                release.countDown(); fixture.awaitIdle()
                assertEquals("A", fixture.vm.selectedConversationId)
                assertNull(fixture.vm.lastError)
                assertEquals("current-visit", fixture.queueText())
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun everyModeUsesTheCanonicalSendPathEvenWhileFlowAndRuntimeAreRunning() {
        val requests = Collections.synchronizedList(mutableListOf<JSONObject>())
        val current = AtomicReference(ui("A-old"))
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    requests += JSONObject(request.body.readUtf8())
                    return json(mapOf("chatMessages" to emptyList<Any>(), "tokens" to emptyList<String>()))
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(current.get())
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                val modes = listOf("build", "plan", "chat", "goal", "flow")
                modes.forEach { mode ->
                    val state = ui("A-old").copy(mode = mode, inputMode = "next", goal = RemoteGoal(objective = "retain objective"))
                    current.set(state); fixture.setUi(state)
                    fixture.vm.sendToDesktop("same user text")
                    fixture.awaitIdle()
                }
                assertEquals(modes, requests.map { it.getString("requestedMode") })
                requests.forEachIndexed { index, body ->
                    assertEquals("ws", body.getString("workspaceId"))
                    assertEquals("A", body.getString("conversationId"))
                    assertEquals("next", body.getString("inputMode"))
                    assertEquals("same user text", body.getString("message"))
                    assertEquals(if (modes[index] == "goal") "retain objective" else "", body.optString("goalObjective"))
                    java.util.UUID.fromString(body.getString("clientMessageId"))
                }
                assertEquals("identical text is still five distinct user submissions", 5, requests.map { it.getString("clientMessageId") }.toSet().size)
                assertFalse(fixture.vm.isSending)
                assertNull(fixture.vm.lastError)
            } finally { server.shutdown() }
        }
    }

    @Test fun overlappingSubmissionsFreezeTheirOwnMetadataWithoutDroppingOrLocallyEnqueueing() {
        val requests = Collections.synchronizedList(mutableListOf<JSONObject>())
        val firstArrived = CountDownLatch(1)
        val bothArrived = CountDownLatch(2)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    requests += JSONObject(request.body.readUtf8())
                    firstArrived.countDown(); bothArrived.countDown(); release.await(10, TimeUnit.SECONDS)
                    return json(mapOf("chatMessages" to emptyList<Any>(), "tokens" to emptyList<String>()))
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(ui("A-old"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("A-old").copy(mode = "plan", inputMode = "guide"))
                fixture.vm.sendToDesktop("first")
                firstArrived.reached()
                assertTrue(fixture.vm.isSending)
                fixture.setUi(ui("A-old").copy(mode = "goal", inputMode = "next", goal = RemoteGoal(objective = "second goal")))
                fixture.vm.sendToDesktop("second")
                bothArrived.reached()
                assertTrue(fixture.vm.isSending)
                assertEquals(listOf("plan", "goal"), requests.map { it.getString("requestedMode") })
                assertEquals(listOf("guide", "next"), requests.map { it.getString("inputMode") })
                assertEquals(listOf("", "second goal"), requests.map { it.optString("goalObjective") })
                assertEquals(2, requests.map { it.getString("clientMessageId") }.toSet().size)
                release.countDown(); fixture.awaitIdle()
                assertFalse(fixture.vm.isSending)
                assertEquals(2, requests.size)
                assertNull(fixture.vm.lastError)
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun forceGuideAndAnExistingItemRetainExplicitMetadata() {
        val captured = AtomicReference<JSONObject>()
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/send", request.requestUrl!!.encodedPath)
                    captured.set(JSONObject(request.body.readUtf8()))
                    return json(mapOf("tokens" to emptyList<String>()))
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(ui("A-old"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("A-old").copy(mode = "plan", inputMode = "next"))
                fixture.vm.sendToDesktop("guide text", forceGuide = true,
                    queuedItem = LocalQueuedMessage("existing", "guide text", requestedMode = "goal", goalObjective = "original goal"))
                fixture.awaitIdle()
                assertEquals("guide", captured.get().getString("inputMode"))
                assertEquals("goal", captured.get().getString("requestedMode"))
                assertEquals("original goal", captured.get().getString("goalObjective"))
                java.util.UUID.fromString(captured.get().getString("clientMessageId"))
            } finally { server.shutdown() }
        }
    }

    @Test fun modeSelectionUsesTheTargetScopedCommandAndAuthoritativeReadbackForAllModes() {
        val current = AtomicReference(ui("A-old"))
        val modes = Collections.synchronizedList(mutableListOf<String>())
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/conversation-ui-action", request.requestUrl!!.encodedPath)
                    val body = JSONObject(request.body.readUtf8())
                    assertEquals("mode", body.getString("action"))
                    assertEquals("ws", body.getString("workspaceId")); assertEquals("A", body.getString("conversationId"))
                    modes += body.getString("value")
                    current.set(current.get().copy(mode = body.getString("value")))
                    return json(mapOf("ok" to true))
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(current.get())
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                listOf("Build", "Plan", "Chat", "Goal", "Flow").forEach { mode ->
                    fixture.vm.selectRemoteMode(mode); fixture.awaitIdle()
                    assertEquals(mode.lowercase(), fixture.vm.conversationUiState.mode)
                }
                fixture.vm.selectRemoteMode("invalid")
                assertEquals(listOf("build", "plan", "chat", "goal", "flow"), modes)
            } finally { server.shutdown() }
        }
    }

    @Test fun queueEditingPreservesTheOriginalModeAndControlsNeverInjectBuild() {
        val requests = Collections.synchronizedList(mutableListOf<JSONObject>())
        val state = ui("original").copy(mode = "chat", queueItems = listOf(RemoteQueueItem(
            id = "row", text = "original", requestedMode = "goal", goalObjective = "keep original goal", createdAt = "stable time")))
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    requests += JSONObject(request.body.readUtf8()); return json(mapOf("ok" to true))
                }
                return json(state)
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(state)
                fixture.vm.updateRemoteQueueMessage("row", "edited"); fixture.awaitIdle()
                fixture.vm.toggleRemoteQueuePause(); fixture.awaitIdle()
                fixture.vm.reorderRemoteQueueMessages(listOf("row")); fixture.awaitIdle()
                fixture.vm.deleteRemoteQueueMessage("row"); fixture.awaitIdle()
                fixture.vm.enqueueRemoteNext("new queue text"); fixture.awaitIdle()
                assertEquals(listOf("queue_update", "queue_toggle_pause", "queue_reorder", "queue_delete", "queue_enqueue"), requests.map { it.getString("action") })
                assertEquals("row", requests[0].getString("id"))
                assertEquals("edited", requests[0].getString("text"))
                assertEquals("goal", requests[0].getString("requestedMode"))
                assertEquals("keep original goal", requests[0].getString("goalObjective"))
                assertFalse("the original creation identity stays PC-owned", requests[0].has("createdAt"))
                requests.subList(1, 4).forEach { assertFalse(it.has("requestedMode")); assertFalse(it.has("goalObjective")) }
                assertEquals("chat", requests[4].getString("requestedMode"))
                java.util.UUID.fromString(requests[4].getString("id"))
                assertEquals("chat", fixture.vm.conversationUiState.mode)
            } finally { server.shutdown() }
        }
    }

    @Test fun anUnloadedTargetUsesServerCanonicalDefaultsInsteadOfThePreviousUiMode() {
        val captured = AtomicReference<JSONObject>()
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") { captured.set(JSONObject(request.body.readUtf8())); return json(mapOf("tokens" to emptyList<String>())) }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(ui("", false))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("previous").copy(mode = "goal", inputMode = "next", goal = RemoteGoal(objective = "old")))
                field(fixture.vm, "conversationUiTargetLoaded", false)
                fixture.vm.sendToDesktop("new target message"); fixture.awaitIdle()
                assertFalse(captured.get().has("requestedMode"))
                assertFalse(captured.get().has("goalObjective"))
                assertFalse(captured.get().has("inputMode"))
                assertFalse(fixture.vm.isSending)
            } finally { server.shutdown() }
        }
    }

    @Test fun editingThenGuidingUsesTheOriginalQueueIdAtomicallyInsteadOfSendingADuplicate() {
        val requests = Collections.synchronizedList(mutableListOf<JSONObject>())
        val state = ui("original").copy(mode = "chat", queueItems = listOf(RemoteQueueItem(
            id = "original-id", text = "original", requestedMode = "goal", goalObjective = "original objective")))
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    assertEquals("/api/mobile/conversation-ui-action", request.requestUrl!!.encodedPath)
                    requests += JSONObject(request.body.readUtf8()); return json(mapOf("ok" to true))
                }
                return json(state)
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(state)
                val accepted = AtomicReference<Boolean?>(null)
                fixture.vm.guideEditedRemoteQueueMessage("original-id", "edited text", { accepted.set(it) })
                fixture.awaitIdle()
                assertEquals(true, accepted.get())
                val body = requests.single()
                assertEquals("queue_guide", body.getString("action"))
                assertEquals("original-id", body.getString("id"))
                assertEquals("edited text", body.getString("text"))
                assertEquals("goal", body.getString("requestedMode"))
                assertEquals("original objective", body.getString("goalObjective"))
                fixture.vm.guideEditedRemoteQueueMessage("missing", "must not create a new message", { assertFalse(it) })
                fixture.vm.guideEditedRemoteQueueMessage("original-id", " ", { assertFalse(it) })
                assertEquals(1, requests.size)
            } finally { server.shutdown() }
        }
    }

    @Test fun reloadingTheSameTargetRetiresOldSendingCountersAndLateErrors() {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    arrived.countDown(); release.await(10, TimeUnit.SECONDS)
                    return MockResponse().setResponseCode(409).setBody("obsolete send error")
                }
                return if (request.path!!.startsWith("/api/mobile/conversation?")) snapshot() else json(ui("current"))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.vm.sendToDesktop("first visit"); arrived.reached()
                assertTrue(fixture.vm.isSending)
                fixture.vm.selectConversation("A", "ws")
                awaitCondition { fixture.queueText() == "current" }
                assertFalse(fixture.vm.isSending)
                release.countDown(); fixture.awaitIdle()
                assertFalse(fixture.vm.isSending)
                assertNull(fixture.vm.lastError)
                assertEquals(0, read(fixture.vm, "remotePendingSends"))
            } finally { release.countDown(); server.shutdown() }
        }
    }

    @Test fun idleConversationStateEventsApplyModeInputAndQueueWithoutARunIdOrFakeBusyRun() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("old", false))
                fixture.stateEvent(""""mode":"plan","inputMode":"next","queueItems":[{"id":"idle-queue","text":"queued at idle"}],"queuePaused":true,"flowRunning":null,"flowSuspension":null""")
                assertEquals("plan", fixture.vm.conversationUiState.mode)
                assertEquals("next", fixture.vm.conversationUiState.inputMode)
                assertEquals("queued at idle", fixture.queueText())
                assertTrue(fixture.vm.conversationUiState.queuePaused)
                assertNull(fixture.vm.liveRun)
                assertFalse(fixture.vm.conversationUiState.runtime!!.running)
                assertFalse(fixture.vm.isSending)
            } finally { server.shutdown() }
        }
    }

    @Test fun conversationFlowEventsProjectRunningPausedQuestionResumeAndExplicitExit() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("", false))
                fixture.stateEvent(""""mode":"flow","inputMode":"next","queuePaused":true,"flowRunning":{"name":"workflow","promptText":"original input"},"flowSuspension":null""")
                assertEquals("workflow", fixture.vm.conversationUiState.flow?.name)
                assertEquals("original input", fixture.vm.conversationUiState.flow?.promptText)
                assertTrue(fixture.vm.conversationUiState.flow?.running == true)
                assertFalse(fixture.vm.conversationUiState.flow!!.paused)
                fixture.stateEvent(""""flowRunning":null,"flowSuspension":{"workflowName":"workflow","input":"original input","reason":"interrupted","message":"paused by user"}""")
                assertTrue(fixture.vm.conversationUiState.flow!!.paused)
                assertEquals("paused by user", fixture.vm.conversationUiState.flow!!.message)
                fixture.stateEvent(""""flowRunning":null,"flowSuspension":{"workflowName":"workflow","input":"original input","reason":"question","message":"choose"}""")
                assertFalse("a question awaits an answer, not the interrupted resume action", fixture.vm.conversationUiState.flow!!.paused)
                assertEquals("question", fixture.vm.conversationUiState.flow!!.reason)
                fixture.stateEvent(""""flowRunning":{"name":"workflow"},"flowSuspension":null,"queuePaused":true""")
                assertTrue(fixture.vm.conversationUiState.flow!!.running)
                assertFalse(fixture.vm.conversationUiState.flow!!.paused)
                fixture.stateEvent(""""mode":"build","queuePaused":false,"flowRunning":null,"flowSuspension":null""")
                assertNull(fixture.vm.conversationUiState.flow)
                assertFalse(fixture.vm.conversationUiState.queuePaused)
                assertEquals("build", fixture.vm.conversationUiState.mode)
                assertNull("target projection never manufactures a WorkRun", fixture.vm.liveRun)
            } finally { server.shutdown() }
        }
    }

    @Test fun conversationProjectionWithARetiredRunIdCannotManufactureARunningWorkRun() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("old", false))
                fixture.stateEvent(""""mode":"chat","queueItems":[],"queuePaused":false,"status":"idle","flowRunning":null,"flowSuspension":null""", run = "retired-run")
                assertEquals("chat", fixture.vm.conversationUiState.mode)
                assertTrue(fixture.vm.editableRemoteQueue.isEmpty())
                assertNull(fixture.vm.liveRun)
                assertFalse(fixture.vm.conversationUiState.runtime!!.running)
            } finally { server.shutdown() }
        }
    }

    @Test fun conversationProjectionRequiresBothExactWorkspaceAndConversation() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("keep", false))
                val payload = """"mode":"goal","inputMode":"next","queueItems":[],"queuePaused":true,"flowRunning":{"name":"foreign"},"flowSuspension":null"""
                fixture.stateEvent(payload, workspace = "other-workspace")
                fixture.stateEvent(payload, conversation = "other-conversation")
                fixture.stateEvent(payload, workspace = "")
                assertEquals("keep", fixture.queueText())
                assertEquals("build", fixture.vm.conversationUiState.mode)
                assertFalse(fixture.vm.conversationUiState.queuePaused)
                assertNull(fixture.vm.conversationUiState.flow)
                assertNull(fixture.vm.liveRun)
            } finally { server.shutdown() }
        }
    }

    @Test fun aLegacyQueueEventCannotResurrectAnIdleRun() {
        val server = MockWebServer(); server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("old", false).copy(runtime = RemoteRuntimeState(running = false, runId = "run-A")))
                fixture.newerSse("updated legacy queue")
                assertEquals("updated legacy queue", fixture.queueText())
                assertNull("queue mutation is not evidence that the retired turn restarted", fixture.vm.liveRun)
                assertFalse(fixture.vm.conversationUiState.runtime!!.running)
            } finally { server.shutdown() }
        }
    }

    @Test fun idleConversationEventPreventsAnOlderHttpPollFromRollingBackPcModeAndQueue() {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : HttpDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                arrived.countDown(); release.await(10, TimeUnit.SECONDS); return json(ui("old-http", false))
            }
        }
        server.start()
        Fixture(server).use { fixture ->
            try {
                fixture.setUi(ui("before", false))
                fixture.vm.refreshConversationUiState(); arrived.reached()
                fixture.stateEvent(""""mode":"goal","inputMode":"next","queueItems":[{"id":"now","text":"new-pc-state"}],"queuePaused":true,"flowRunning":null,"flowSuspension":null""")
                release.countDown(); fixture.awaitIdle()
                assertEquals("goal", fixture.vm.conversationUiState.mode)
                assertEquals("new-pc-state", fixture.queueText())
                assertFalse(fixture.history.contains("old-http"))
                assertNull(fixture.vm.liveRun)
            } finally { release.countDown(); server.shutdown() }
        }
    }
}
