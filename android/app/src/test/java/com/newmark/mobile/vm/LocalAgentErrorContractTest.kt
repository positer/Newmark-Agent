package com.newmark.mobile.vm

import com.newmark.mobile.data.ApiConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketException

class LocalAgentErrorContractTest {
    @Test
    fun configuredProviderErrorsNeverReceiveTheApiConfigurationSuffix() {
        val message = localAgentFailureMessage(
            ApiConfig("https://provider.example/v1", "key", "model"),
            SocketException("Software caused connection abort"),
        )

        assertEquals("⚠️ Software caused connection abort", message)
        assertTrue(!message.contains("请在设置页配置"))
    }

    @Test
    fun configurationGuidanceIsReservedForActuallyIncompleteConfiguration() {
        val message = localAgentFailureMessage(ApiConfig(), IllegalStateException("network unavailable"))

        assertTrue(message.contains("API 配置不完整"))
        assertTrue(message.contains("请在设置页配置"))
        assertTrue(!message.contains("network unavailable"))
    }
}
