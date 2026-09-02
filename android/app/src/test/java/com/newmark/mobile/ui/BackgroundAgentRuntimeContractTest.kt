package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundAgentRuntimeContractTest {
    @Test
    fun activeLocalAndRemoteWorkIsNotOwnedByViewModelScope() {
        val local = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val remote = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()

        assertTrue(local.contains("runtime.job = LocalAgentForegroundService.launchRuntime"))
        assertTrue(local.contains("CoroutineScope(currentCoroutineContext())"))
        assertTrue(local.contains("Active runs are owned by LocalAgentForegroundService"))
        assertTrue(!local.contains("runtime.job = viewModelScope.launch"))
        assertTrue(local.substringAfter("fun stop()").substringBefore("fun enqueueLocal").contains("updateLocalAgentService()"))
        assertTrue(remote.contains("reconnectJob = LocalAgentForegroundService.launchRuntime"))
        assertTrue(remote.contains("sseJob = LocalAgentForegroundService.launchRuntime(Dispatchers.IO)"))
        assertTrue(remote.contains("runningRemoteAgentCount() > 0 || System.currentTimeMillis() < deadline"))
        assertTrue(remote.contains("cancelConnectionWork(clearGate = true)"))
        assertTrue(remote.contains("setRemoteTransportOwner(getApplication(), false)"))
        assertTrue(remote.contains("updateRemoteConnectionLease(getApplication(), activeDevice != null)"))
        assertTrue(serviceSource().contains("keepRemoteConnectionActive"))
        assertTrue(serviceSource().contains("remote_connection_active"))
        assertTrue(serviceSource().contains("syncRemoteKeepAlive"))
        assertTrue(serviceSource().contains("/api/mobile/events?token="))
    }

    @Test
    fun networkRecoveryEvictsDeadRoutesAndRetriesOnlyBeforeModelActivity() {
        val local = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val remote = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()

        assertTrue(service.contains("registerNetworkRecoveryListener"))
        assertTrue(service.contains("MutableStateFlow(false)"))
        assertTrue(service.contains("usableNetwork.filter { it }.first()"))
        assertTrue(remote.contains("api.evictConnections()"))
        assertTrue(remote.contains("startReconnect(pair, session, immediate = true)"))
        assertTrue(local.contains("!observedText && !observedThought && isTransientAgentNetworkFailure(error)"))
        assertTrue(local.contains("LocalAgentForegroundService.awaitUsableNetwork"))
        assertTrue(local.contains("apiClient.evictConnections()"))
        assertTrue(local.contains("agentNetworkRetryDelayMs(networkRetryAttempt++)"))
    }

    private fun serviceSource(): String =
        File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
}
